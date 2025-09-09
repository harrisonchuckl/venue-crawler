// ESM version (no require) with proxy support and early-stop logic.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { SELECTORS } from "./selectors.config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- env ----------
const APPS_SCRIPT_WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK || "";
const JOB_TOKEN = process.env.JOB_TOKEN || "";
const PROXY_URL = process.env.PROXY_URL || ""; // e.g. http://scraperapi:KEY@proxy-server.scraperapi.com:8001
const BRAND = process.env.BRAND || "HireSpace"; // or TagVenue
const SHARD = Number(process.env.SHARD || 1); // not used here but passed from workflow

// ---------- crawl tuning ----------
const MAX_PAGES_HARD = 300;               // absolute hard cap
const LOW_ITEMS_STREAK_STOP = 3;          // stop after N pages in a row with 0 items
const MIN_ITEMS_PER_PAGE = 1;             // treat as "0" if < this number
const PAGE_TIMEOUT_MS = 90_000;           // per page
const VIEWPORT = { width: 1280, height: 900 };
const UA = devices["Desktop Chrome"].userAgent;

// Utility
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensure = (dir) => (fs.existsSync(dir) ? undefined : fs.mkdirSync(dir, { recursive: true }));

function withPageParam(url, paramName, pageNum) {
  const u = new URL(url);
  u.searchParams.set(paramName, String(pageNum));
  return u.toString();
}

async function saveDebug(page, prefix, p) {
  const png = `${prefix}-p${p}.png`;
  const html = `${prefix}-p${p}.html`;
  await page.screenshot({ path: png, fullPage: true });
  const content = await page.content();
  fs.writeFileSync(html, content, "utf-8");
  console.log(`[${prefix}] saved ${png} / ${html}`);
}

async function postToSheet(rows) {
  if (!APPS_SCRIPT_WEBHOOK) {
    console.log("[post] APPS_SCRIPT_WEBHOOK not set, skipping.");
    return;
  }
  const body = JSON.stringify({ token: JOB_TOKEN, rows });
  const res = await fetch(APPS_SCRIPT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  const ok = res.ok;
  const txt = await res.text();
  console.log(`[post] response ${res.status}: ${txt.slice(0, 200)}${txt.length > 200 ? "…" : ""}`);
  if (!ok) throw new Error(`Webhook POST failed: ${res.status}`);
}

async function runBrand(browser, brandKey) {
  const { baseUrl, pageParam, itemLinks } = SELECTORS[brandKey];
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
    javaScriptEnabled: true
  });
  const page = await ctx.newPage();

  const prefix = brandKey.toLowerCase();
  ensure(__dirname);

  let total = 0;
  let zeroStreak = 0;

  for (let p = 1; p <= MAX_PAGES_HARD; p++) {
    const url = withPageParam(baseUrl, pageParam, p);
    console.log(`[${brandKey}] Visiting ${url}`);

    try {
      await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    } catch (e) {
      console.log(`[${brandKey}] page ${p} navigation error: ${e.message}`);
      await saveDebug(page, prefix, p);
      break;
    }

    // wait a moment to let grids hydrate (many sites are client-rendered)
    await sleep(1500);

    // Some sites show bot walls → if no results container is found, quit early.
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

    // Save debug assets for the first few pages or when empty.
    if (p <= 3 || items === 0) {
      await saveDebug(page, prefix, p);
    }

    // Early-stop rules
    if (items < MIN_ITEMS_PER_PAGE) {
      zeroStreak += 1;
    } else {
      zeroStreak = 0;
    }
    if (zeroStreak >= LOW_ITEMS_STREAK_STOP) {
      console.log(`[${brandKey}] ${LOW_ITEMS_STREAK_STOP} low/zero pages in a row → stopping.`);
      break;
    }

    // Prepare rows for the sheet
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

    // If the site shows a fixed result count per page and we got very few,
    // it's likely the last page already.
    if (items < 5) {
      console.log(`[${brandKey}] very few items on page ${p} → likely last page, stopping.`);
      break;
    }
  }

  await ctx.close();
  console.log(`[${brandKey}] Total links sent: ${total}`);
}

async function main() {
  console.log(`BRAND=${BRAND}  SHARD=${SHARD}`);
  if (PROXY_URL) {
    console.log(`Using proxy: ${maskProxy(PROXY_URL)}`);
  }

  const launchOpts = {
    headless: true
  };

  if (PROXY_URL) {
    launchOpts.proxy = { server: PROXY_URL };
  }

  const browser = await chromium.launch(launchOpts);

  try {
    if (!SELECTORS[BRAND]) {
      console.log(`Unknown BRAND "${BRAND}", defaulting to HireSpace`);
      await runBrand(browser, "HireSpace");
    } else {
      await runBrand(browser, BRAND);
    }
  } finally {
    await browser.close();
  }
}

// mask proxy key in logs
function maskProxy(u) {
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return "***";
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
