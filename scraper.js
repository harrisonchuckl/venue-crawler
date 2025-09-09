// scraper.js (ESM)
// Crawls HireSpace + TagVenue via ScraperAPI's render=true (server-side JS).
// Sends results to your Google Apps Script Webhook in small batches.

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const BRAND = process.argv[2] || "All";
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY;
const WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK;
const JOB_TOKEN = process.env.JOB_TOKEN || "";

if (!SCRAPERAPI_KEY) {
  console.error("Missing SCRAPERAPI_KEY env var.");
  process.exit(1);
}
if (!WEBHOOK) {
  console.error("Missing APPS_SCRIPT_WEBHOOK env var.");
  process.exit(1);
}

const COUNTRY = "gb"; // Geolocate to UK
const RENDER = true;  // Ask ScraperAPI to render JavaScript
const CONCURRENCY = 4;
const MAX_PAGES = 999;       // safety cap
const DETAIL_LIMIT_PER_PAGE = 40; // just a guardrail

// --- helpers -------------------------------------------------------

function sUrl(target) {
  const base = "https://api.scraperapi.com/";
  const u = new URL(base);
  u.searchParams.set("api_key", SCRAPERAPI_KEY);
  if (RENDER) u.searchParams.set("render", "true");
  u.searchParams.set("country_code", COUNTRY);
  u.searchParams.set("keep_headers", "true");
  u.searchParams.set("url", target);
  return u.toString();
}

async function getHtml(url) {
  const resp = await fetch(sUrl(url), {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    timeout: 120_000
  });
  if (!resp.ok) {
    throw new Error(`Fetch failed ${resp.status} ${resp.statusText} for ${url}`);
  }
  return await resp.text();
}

async function postRows(rows) {
  if (!rows.length) return { posted: 0 };
  const payload = {
    token: JOB_TOKEN,
    rows
  };
  const r = await fetch(WEBHOOK, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Webhook POST failed ${r.status}: ${t}`);
  }
  return { posted: rows.length };
}

function normalize(str) {
  return (str || "").trim().replace(/\s+/g, " ");
}

function unique(arr) {
  return [...new Set(arr)];
}

// --- brand scrapers ------------------------------------------------

// HIRESPACE
async function crawlHireSpace() {
  const results = [];
  const limit = pLimit(CONCURRENCY);
  let consecutiveEmpty = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const listUrl = `https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&page=${page}&perPage=36&sort=relevance`;
    console.log(`[HireSpace] Visiting ${listUrl}`);
    let html;
    try {
      html = await getHtml(listUrl);
    } catch (e) {
      console.log(`[HireSpace] page ${page} fetch error: ${e.message}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      continue;
    }

    const $ = cheerio.load(html);
    // Find listing anchors
    const links = unique(
      $('a[href*="/Spaces/"], a[href*="/Space/"]')
        .map((_, a) => new URL($(a).attr("href"), "https://hirespace.com").toString())
        .get()
        .slice(0, DETAIL_LIMIT_PER_PAGE)
    );

    console.log(`[HireSpace] page ${page} => items: ${links.length}`);
    if (links.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        console.log("[HireSpace] No items for two consecutive pages. Stopping.");
        break;
      }
      continue;
    }
    consecutiveEmpty = 0;

    const detailTasks = links.map((url) =>
      limit(async () => {
        try {
          const dhtml = await getHtml(url);
          const $$ = cheerio.load(dhtml);

          // Try to extract name/city from visible headers and breadcrumbs/meta
          let name =
            normalize($$('h1,h2,[data-testid*="title"]').first().text()) ||
            normalize($$('meta[property="og:title"]').attr("content")) ||
            "";

          // City: best effort — look for breadcrumb or address-like elements
          let city =
            normalize(
              $$('a[href*="city"], [data-testid*="location"], .breadcrumbs, nav[aria-label*="breadcrumb"]')
                .first()
                .text()
            ) || "";

          const row = {
            name,
            city,
            source: "HireSpace",
            dirUrl: url,
            fetchedAt: new Date().toISOString(),
          };
          return row;
        } catch (e) {
          console.log(`[HireSpace] detail error for ${url}: ${e.message}`);
          return null;
        }
      })
    );

    const rows = (await Promise.all(detailTasks)).filter(Boolean);
    if (rows.length) {
      results.push(...rows);
      // Post incrementally to keep progress flowing
      try {
        const { posted } = await postRows(rows);
        console.log(`[HireSpace] Posted ${posted} rows.`);
      } catch (err) {
        console.log(`[HireSpace] POST error: ${err.message}`);
      }
    }
  }

  console.log(`[HireSpace] Total rows gathered: ${results.length}`);
  return results;
}

// TAGVENUE
async function crawlTagVenue() {
  const results = [];
  const limit = pLimit(CONCURRENCY);
  let consecutiveEmpty = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const listUrl = `https://www.tagvenue.com/uk/search/event-venue?page=${page}`;
    console.log(`[TagVenue] Visiting ${listUrl}`);
    let html;
    try {
      html = await getHtml(listUrl);
    } catch (e) {
      console.log(`[TagVenue] page ${page} fetch error: ${e.message}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      continue;
    }

    const $ = cheerio.load(html);

    // Common listing anchors on TagVenue (wide net)
    const links = unique(
      $('a[href*="/l/"], a[href*="/venues/"], a[href*="/spaces/"]')
        .map((_, a) => new URL($(a).attr("href"), "https://www.tagvenue.com").toString())
        .get()
        .filter((u) => !u.includes("/search/"))
        .slice(0, DETAIL_LIMIT_PER_PAGE)
    );

    console.log(`[TagVenue] page ${page} => items: ${links.length}`);
    if (links.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        console.log("[TagVenue] No items for two consecutive pages. Stopping.");
        break;
      }
      continue;
    }
    consecutiveEmpty = 0;

    const detailTasks = links.map((url) =>
      limit(async () => {
        try {
          const dhtml = await getHtml(url);
          const $$ = cheerio.load(dhtml);

          let name =
            normalize($$('h1,h2,[data-testid*="title"]').first().text()) ||
            normalize($$('meta[property="og:title"]').attr("content")) ||
            "";

          let city =
            normalize(
              $$('[class*="breadcrumbs"], nav[aria-label*="breadcrumb"], [data-testid*="location"]')
                .first()
                .text()
            ) || "";

          const row = {
            name,
            city,
            source: "TagVenue",
            dirUrl: url,
            fetchedAt: new Date().toISOString(),
          };
          return row;
        } catch (e) {
          console.log(`[TagVenue] detail error for ${url}: ${e.message}`);
          return null;
        }
      })
    );

    const rows = (await Promise.all(detailTasks)).filter(Boolean);
    if (rows.length) {
      results.push(...rows);
      try {
        const { posted } = await postRows(rows);
        console.log(`[TagVenue] Posted ${posted} rows.`);
      } catch (err) {
        console.log(`[TagVenue] POST error: ${err.message}`);
      }
    }
  }

  console.log(`[TagVenue] Total rows gathered: ${results.length}`);
  return results;
}

// --- main ----------------------------------------------------------

async function main() {
  console.log(`BRAND=${BRAND}`);
  const wantHire = BRAND === "HireSpace" || BRAND === "All";
  const wantTag = BRAND === "TagVenue" || BRAND === "All";

  if (wantHire) await crawlHireSpace();
  if (wantTag) await crawlTagVenue();

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
