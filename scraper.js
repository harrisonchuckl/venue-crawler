// scraper.js (ESM)
// Run: node scraper.js All | HireSpace | TagVenue
// Env needed:
//   APPS_SCRIPT_WEBHOOK = https://script.google.com/.../exec
//   JOB_TOKEN           = your-shared-token
// Optional:
//   SCRAPERAPI_KEY      = your ScraperAPI key (enables proxy)
//   COUNTRY_CODE        = gb (default)
//   START_PAGE          = 1 (default)
//   MAX_PAGES           = 250 (default)
//   PER_PAGE_HI         = 36 (default)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

// ---- Configs ---------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APPS_SCRIPT_WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK || "";
const JOB_TOKEN = process.env.JOB_TOKEN || "";

const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || "";
const COUNTRY_CODE = (process.env.COUNTRY_CODE || "gb").toLowerCase();

const START_PAGE = Number(process.env.START_PAGE || "1");
const MAX_PAGES = Number(process.env.MAX_PAGES || "250");
const PER_PAGE_HI = Number(process.env.PER_PAGE_HI || "36");

const BRAND_INPUT = (process.argv[2] || "All").trim();

if (!APPS_SCRIPT_WEBHOOK || !JOB_TOKEN) {
  console.error("❌ Missing APPS_SCRIPT_WEBHOOK or JOB_TOKEN env vars.");
  process.exit(1);
}

// ---- Proxy helper (ScraperAPI) --------------------------------------------

// We use Playwright's browser-level proxy. ScraperAPI supports HTTP proxy auth.
// The most robust pattern is credentials in the URL:
//
//   http://scraperapi:<API_KEY>@proxy-server.scraperapi.com:8001
//
// Country routing is set via query params on the server URL (Playwright accepts them).
//
// NOTE: If SCRAPERAPI_KEY is not set, we run direct (no proxy).

function buildPlaywrightProxy() {
  if (!SCRAPERAPI_KEY) return null;
  const base = `http://scraperapi:${encodeURIComponent(
    SCRAPERAPI_KEY
  )}@proxy-server.scraperapi.com:8001/?country_code=${encodeURIComponent(
    COUNTRY_CODE
  )}`;
  return { server: base };
}

// ---- Utilities -------------------------------------------------------------

async function saveDebug(page, prefix = "page") {
  try {
    const png = `${prefix}.png`;
    const html = `${prefix}.html`;
    await page.screenshot({ path: path.join(__dirname, png), fullPage: true, timeout: 30000 });
    const content = await page.content();
    fs.writeFileSync(path.join(__dirname, html), content, "utf8");
    console.log(`[debug] saved ${png} / ${html}`);
  } catch (e) {
    console.log("[debug] failed to save debug artifacts:", e.message);
  }
}

async function autoConsent(page) {
  // Try common consent patterns
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button#acceptAllButton',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I Accept")',
    'button:has-text("Accept")'
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      try {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        break;
      } catch {}
    }
  }
}

async function scrollToBottom(page, opts = {}) {
  const {
    step = 800,
    maxScrolls = 20,
    pauseMs = 400,
  } = opts;

  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate((_step) => window.scrollBy(0, _step), step);
    await page.waitForTimeout(pauseMs);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight <= lastHeight) break;
    lastHeight = newHeight;
  }
}

// Normalize to absolute URL
function abs(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function postRows(rows) {
  if (!rows.length) return { ok: true, posted: 0 };
  const payload = {
    token: JOB_TOKEN,
    rows, // [{ name, city, source, dirUrl, fetchedAt }]
  };
  const res = await fetch(APPS_SCRIPT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Webhook POST failed: ${res.status} ${txt}`);
  }
  return { ok: true, posted: rows.length };
}

// Extract helper – read innerText safely
async function innerTextSafe(el, sel) {
  try {
    const node = await el.$(sel);
    if (!node) return "";
    const txt = await node.innerText();
    return (txt || "").trim();
  } catch {
    return "";
  }
}

// ---- Brand: HireSpace ------------------------------------------------------

function hirespaceSearchUrl(pageNum) {
  // perPage controls 36 cards per page
  return `https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&page=${pageNum}&perPage=${PER_PAGE_HI}&sort=relevance`;
}

async function scrapeHireSpacePage(page, pageNum) {
  const url = hirespaceSearchUrl(pageNum);
  console.log(`[HireSpace] Visiting ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});

  await autoConsent(page);
  await page.waitForTimeout(1200);
  await scrollToBottom(page, { maxScrolls: 25, pauseMs: 300 });

  // Cards: look for anchors that lead to venue pages.
  const handles = await page.$$(`a[href*="/Space/"], a[href*="/Spaces/"]`);
  const rows = [];

  for (const a of handles) {
    const href = await a.getAttribute("href").catch(() => null);
    if (!href) continue;
    const dirUrl = abs(url, href);
    if (!dirUrl) continue;

    // Try to get name from anchor or its card
    const name =
      (await a.innerText().catch(() => "")).trim() ||
      (await innerTextSafe(a, "h3")) ||
      "";

    // Try to get location from the nearest card container
    let city = "";
    try {
      const card = await a.evaluateHandle((node) => node.closest('[class*="card"], [class*="Card"], article, li'));
      if (card) {
        const wrap = card.asElement();
        if (wrap) {
          city =
            (await innerTextSafe(wrap, '[class*="location"], [class*="Location"]')) ||
            (await innerTextSafe(wrap, 'div:has-text(" • ")')) ||
            "";
        }
      }
    } catch {}

    rows.push({
      name: name || "",
      city: city || "",
      source: "HireSpace",
      dirUrl,
      fetchedAt: nowIso(),
    });
  }

  console.log(`[HireSpace] page ${pageNum} => items: ${rows.length}`);
  await saveDebug(page, `hirespace-p${pageNum}`);

  return rows;
}

async function runHireSpace(browser, startPage, maxPages) {
  const page = await browser.newPage();
  let all = [];
  let emptyInRow = 0;

  for (let p = startPage; p < startPage + maxPages; p++) {
    try {
      const rows = await scrapeHireSpacePage(page, p);
      if (rows.length === 0) {
        emptyInRow++;
      } else {
        emptyInRow = 0;
        // Post in batches of 50 for safety
        const chunk = rows.slice(0, 50);
        const posted = await postRows(chunk);
        console.log(`[HireSpace] Posted ${posted.posted} rows.`);
        all = all.concat(rows);
      }

      // Stop rules:
      // 1) Two consecutive empty/near-empty pages
      // 2) Very few (< 6) items on the first page → likely a wall/result exhausted
      if ((p === startPage && all.length < 6) || emptyInRow >= 2) {
        console.log("[HireSpace] stop condition reached.");
        break;
      }
    } catch (err) {
      console.log(`[HireSpace] page ${p} error: ${err.message}`);
      // Try to keep going, but if two consecutive errors, stop
      emptyInRow++;
      if (emptyInRow >= 2) break;
    }
  }

  await page.close();
  console.log(`[HireSpace] Total links sent (attempted): ${all.length}`);
}

// ---- Brand: TagVenue -------------------------------------------------------

function tagvenueSearchUrl(pageNum) {
  return `https://www.tagvenue.com/uk/search/event-venue?page=${pageNum}`;
}

async function scrapeTagVenuePage(page, pageNum) {
  const url = tagvenueSearchUrl(pageNum);
  console.log(`[TagVenue] Visiting ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});

  await autoConsent(page);
  await page.waitForTimeout(1200);
  await scrollToBottom(page, { maxScrolls: 25, pauseMs: 300 });

  // Cards often link to /uk/london/venue-name or /venues/...
  const handles = await page.$$(`a[href*="/uk/"], a[href*="/venues/"], a[href*="/venue/"]`);
  const rows = [];

  for (const a of handles) {
    const href = await a.getAttribute("href").catch(() => null);
    if (!href) continue;
    const dirUrl = abs(url, href);
    if (!dirUrl) continue;

    // Heuristic: skip non-listing links
    if (!/tagvenue\.com\/.+\/.+/i.test(dirUrl)) continue;

    const name =
      (await a.innerText().catch(() => "")).trim() ||
      (await innerTextSafe(a, "h3")) ||
      "";

    // TagVenue city can usually be inferred from URL (/uk/london/...), fallback to empty
    let city = "";
    const m = dirUrl.match(/tagvenue\.com\/uk\/([^/]+)/i);
    if (m && m[1]) city = decodeURIComponent(m[1].replace(/-/g, " "));

    rows.push({
      name,
      city,
      source: "TagVenue",
      dirUrl,
      fetchedAt: nowIso(),
    });
  }

  console.log(`[TagVenue] page ${pageNum} => items: ${rows.length}`);
  await saveDebug(page, `tagvenue-p${pageNum}`);

  return rows;
}

async function runTagVenue(browser, startPage, maxPages) {
  const page = await browser.newPage();
  let all = [];
  let emptyInRow = 0;

  for (let p = startPage; p < startPage + maxPages; p++) {
    try {
      const rows = await scrapeTagVenuePage(page, p);

      if (rows.length === 0) {
        emptyInRow++;
      } else {
        emptyInRow = 0;
        const chunk = rows.slice(0, 50);
        const posted = await postRows(chunk);
        console.log(`[TagVenue] Posted ${posted.posted} rows.`);
        all = all.concat(rows);
      }

      // Stop rules similar to HireSpace
      if ((p === startPage && all.length < 6) || emptyInRow >= 2) {
        console.log("[TagVenue] stop condition reached.");
        break;
      }
    } catch (err) {
      console.log(`[TagVenue] page ${p} error: ${err.message}`);
      emptyInRow++;
      if (emptyInRow >= 2) break;
    }
  }

  await page.close();
  console.log(`[TagVenue] Total links sent (attempted): ${all.length}`);
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const brand = BRAND_INPUT.toLowerCase();
  console.log(`BRAND=${BRAND_INPUT}`);

  // Build browser args
  const proxy = buildPlaywrightProxy();
  if (proxy) {
    console.log(`Using ScraperAPI proxy (country=${COUNTRY_CODE})`);
  } else {
    console.log("No proxy configured (SCRAPERAPI_KEY not set).");
  }

  const browser = await chromium.launch({
    headless: true,
    proxy: proxy || undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1440,1200",
    ],
  });

  try {
    if (brand === "hirespace") {
      await runHireSpace(browser, START_PAGE, MAX_PAGES);
    } else if (brand === "tagvenue") {
      await runTagVenue(browser, START_PAGE, MAX_PAGES);
    } else {
      await runHireSpace(browser, START_PAGE, MAX_PAGES);
      await runTagVenue(browser, START_PAGE, MAX_PAGES);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
