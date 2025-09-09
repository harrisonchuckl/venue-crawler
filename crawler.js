import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { SELECTORS } from "./selectors.config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───── Env ──────────────────────────────────────────────────────────
const APPS_SCRIPT_WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK || "";
const JOB_TOKEN = process.env.JOB_TOKEN || "";

// Preferred: set SCRAPERAPI_KEY in GitHub Secrets.
// Optional: SCRAPER_COUNTRY (e.g. "gb"). If absent, global pool is used.
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || "";
const SCRAPER_COUNTRY = (process.env.SCRAPER_COUNTRY || "").toLowerCase();

// Fallback legacy: PROXY_URL like http://username:password@host:port (no query!)
const LEGACY_PROXY_URL = process.env.PROXY_URL || "";

// Which brand to run (workflow sets this twice in parallel)
const BRAND = process.env.BRAND || "HireSpace";

// ───── Tuning ───────────────────────────────────────────────────────
const MAX_PAGES_HARD = 300;      // absolute ceiling
const LOW_ITEMS_STREAK_STOP = 3; // stop after N pages in a row with 0/low results
const MIN_ITEMS_PER_PAGE = 1;    // treat below this as "zero"
const PAGE_TIMEOUT_MS = 120_000; // be generous when using a proxy
const VIEWPORT = { width: 1280, height: 900 };
const UA = devices["Desktop Chrome"].userAgent;

// ───── Utils ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (d) => (fs.existsSync(d) ? undefined : fs.mkdirSync(d, { recursive: true }));

function withPageParam(url, paramName, pageNum) {
  const u = new URL(url);
  u.searchParams.set(paramName, String(pageNum));
  return u.toString();
}

async function safeScreenshot(page, fname) {
  try {
    await page.screenshot({ path: fname, fullPage: true, timeout: 5000 });
  } catch {
    // ignore (fonts/paint may hang after a nav failure)
  }
}

async function saveDebug(page, prefix, p) {
  const png = `${prefix}-p${p}.png`;
  const html = `${prefix}-p${p}.html`;
  await safeScreenshot(page, png);
  let content = "";
  try {
    content = await page.content();
  } catch {}
  fs.writeFileSync(html, content, "utf-8");
  console.log(`[${prefix}] saved ${png} / ${html}`);
}

async function postToSheet(rows) {
  if (!APPS_SCRIPT_WEBHOOK) {
    console.log("[post] APPS_SCRIPT_WEBHOOK not set, skipping.");
    return;
  }
  const res = await fetch(APPS_SCRIPT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: JOB_TOKEN, rows })
  });
  const txt = await res.text();
  console.log(`[post] ${res.status} ${res.ok ? "OK" : "ERROR"}: ${txt.slice(0, 200)}`);
  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status}`);
}

function buildProxyLaunchOpts() {
  // Use native proxy fields for Playwright.
  // ScraperAPI format for Playwright:
  //   server: "http://proxy-server.scraperapi.com:8001"
  //   username: "<API_KEY>"
  //   password: ""   (empty)
  if (SCRAPERAPI_KEY) {
    const server = "http://proxy-server.scraperapi.com:8001";
    const username =
      SCRAPER_COUNTRY ? `${SCRAPERAPI_KEY}:country_code-${SCRAPER_COUNTRY}` : SCRAPERAPI_KEY;
    return { server, username, password: "" };
  }

  if (LEGACY_PROXY_URL) {
    // Accepts http://user:pass@host:port   (NO query string!)
    try {
      const u = new URL(LEGACY_PROXY_URL);
      return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: decodeURIComponent(u.username || ""),
        password: decodeURIComponent(u.password || "")
      };
    } catch {
      console.log("Invalid PROXY_URL; ignoring.");
    }
  }
  return null;
}

function mask(val) {
  if (!val) return "";
  if (SCRAPERAPI_KEY && val.includes("scraperapi.com")) return "***scraperapi***";
  return "***";
}

// ───── Core ─────────────────────────────────────────────────────────
async function runBrand(browser, brandKey) {
  const { baseUrl, pageParam, itemLinks } = SELECTORS[brandKey];
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    bypassCSP: true
  });
  const page = await ctx.newPage();

  const prefix = brandKey.toLowerCase();
  ensureDir(__dirname);

  let total = 0;
  let zeroStreak = 0;

  for (let p = 1; p <= MAX_PAGES_HARD; p++) {
    const url = withPageParam(baseUrl, pageParam, p);
    console.log(`[${brandKey}] Visiting ${url}`);

    try {
      await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "load" });
    } catch (e) {
      console.log(`[${brandKey}] page ${p} navigation error: ${e.message}`);
      await saveDebug(page, prefix, p);
      // One quick retry after a short pause (helps with proxy hiccups)
      try {
        await sleep(2000);
        await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      } catch (e2) {
        console.log(`[${brandKey}] page ${p} retry failed: ${e2.message} → stopping.`);
        break;
      }
    }

    await sleep(1200);

    const links = await page.locator(itemLinks).evaluateAll((as) =>
      as
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const text = (a.textContent || "").trim();
          try {
            const u = new URL(href, location.origin);
            return { href: u.href, text };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    );

    const items = links.length;
    console.log(`[${brandKey}] page ${p} => items: ${items}`);

    if (p <= 3 || items === 0) await saveDebug(page, prefix, p);

    // Early stop rules
    zeroStreak = items < MIN_ITEMS_PER_PAGE ? zeroStreak + 1 : 0;
    if (zeroStreak >= LOW_ITEMS_STREAK_STOP) {
      console.log(`[${brandKey}] ${LOW_ITEMS_STREAK_STOP} low/zero pages in a row → stopping.`);
      break;
    }

    const ts = new Date().toISOString();
    const rows = links.map((l) => ({
      name: l.text || "",
      city: "",
      source: brandKey,
      dirUrl: l.href,
      fetchedAt: ts
    }));

    if (rows.length) {
      await postToSheet(rows);
      total += rows.length;
    }

    if (items < 5) {
      console.log(`[${brandKey}] very few items on page ${p} → likely last page, stopping.`);
      break;
    }
  }

  await ctx.close();
  console.log(`[${brandKey}] Total links sent: ${total}`);
}

async function main() {
  const px = buildProxyLaunchOpts();
  const launchOpts = {
    headless: true,
    proxy: px || undefined
  };

  if (px) {
    console.log(`Using proxy: ${mask(`${px.server}`)}`);
  } else {
    console.log("No proxy configured.");
  }

  const browser = await chromium.launch(launchOpts);

  try {
    await runBrand(browser, SELECTORS[BRAND] ? BRAND : "HireSpace");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
