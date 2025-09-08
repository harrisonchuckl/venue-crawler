// crawler.js (CommonJS)
// Crawl listing pages for TagVenue & HireSpace with Playwright,
// extract venue links, and POST them to your Apps Script webhook.

// ----- Config taken from environment (set by GitHub Actions) -----
const BRAND = process.env.BRAND || 'TagVenue';        // TagVenue | HireSpace
const SHARD_INDEX = Number(process.env.SHARD_INDEX || 0); // 0-based shard index
const SHARD_TOTAL = Number(process.env.SHARD_TOTAL || 1); // total shards
const MAX_PAGES_PER_RUN = Number(process.env.MAX_PAGES || 9999); // optional cap
const APPS_SCRIPT_WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK;      // required

if (!APPS_SCRIPT_WEBHOOK) {
  console.error('Missing APPS_SCRIPT_WEBHOOK env var.');
  process.exit(1);
}

// ----- Imports -----
const { chromium } = require('playwright');
const selectors = require('./selectors.config.js');

// Node 18+ has global fetch; for older Node you could use node-fetch.
// GitHub Actions uses Node 20 by default, so global fetch is fine.

// ----- Helpers -----
function nextPageUrl(baseUrl, pageParam, pageNum) {
  const u = new URL(baseUrl);
  u.searchParams.set(pageParam, String(pageNum));
  return u.toString();
}

async function gotoAndWait(page, url, cardSelector) {
  // Do NOT use "networkidle" on these sites (maps & trackers poll forever).
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForSelector(cardSelector, { timeout: 90_000 });
}

function *pagedIterator(firstPage, hardMax, shardIndex, shardTotal) {
  // Interleaved sharding: shard 0 = 1,1+T,1+2T... ; shard 1 = 2,2+T,...
  let p = firstPage + shardIndex;
  while (p <= hardMax) {
    yield p;
    p += shardTotal;
  }
}

// ----- Main run -----
(async () => {
  const cfg = selectors[BRAND];
  if (!cfg) {
    console.error(`Unknown BRAND "${BRAND}". Use TagVenue or HireSpace.`);
    process.exit(1);
  }

  const { startUrl, listItemSelector, pageParam, brand, hardMaxPages } = cfg;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  const seen = new Set();         // dedupe across pages in this run
  const rows = [];                // rows to POST to Apps Script
  let pagesVisited = 0;
  let emptyPagesInARow = 0;

  for (const pageNum of pagedIterator(1, Math.min(hardMaxPages, MAX_PAGES_PER_RUN), SHARD_INDEX, SHARD_TOTAL)) {
    const url = nextPageUrl(startUrl, pageParam, pageNum);

    try {
      await gotoAndWait(page, url, listItemSelector);
    } catch (e) {
      console.log(`[${brand}] page ${pageNum} navigation error: ${e.message}`);
      // If we can’t reach this page, skip to next shard page
      continue;
    }

    const links = await page.$$eval(listItemSelector, as =>
      Array.from(new Set(as.map(a => a.href).filter(Boolean)))
    ).catch(() => []);

    pagesVisited++;
    console.log(`[${brand}] page ${pageNum} => items: ${links.length}`);

    // Save a quick snapshot for debugging (first two pages per shard)
    if (pagesVisited <= 2) {
      await page.screenshot({ path: `${brand.toLowerCase()}-p${pageNum}.png`, fullPage: true }).catch(()=>{});
      await require('fs').promises.writeFile(
        `${brand.toLowerCase()}-p${pageNum}.html`,
        await page.content()
      ).catch(()=>{});
      console.log(`[${brand}] saved ${brand.toLowerCase()}-p${pageNum}.png/.html`);
    }

    if (!links.length) {
      emptyPagesInARow++;
      if (emptyPagesInARow >= 2) {
        // Two empty pages for this shard — assume we’re past the end.
        break;
      }
      continue;
    } else {
      emptyPagesInARow = 0;
    }

    // Push into rows (dedup by href)
    for (const href of links) {
      if (seen.has(href)) continue;
      seen.add(href);
      rows.push({
        source: brand,
        dirUrl: href,
        fetchedAt: new Date().toISOString()
      });
    }
  }

  await browser.close();

  console.log(`[${brand}] total unique links collected: ${rows.length}`);

  // ----- POST to Apps Script -----
  try {
    const resp = await fetch(APPS_SCRIPT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The Apps Script you deployed should accept { rows: [...] }
      body: JSON.stringify({ rows })
    });

    const txt = await resp.text();
    console.log(`Posted to Apps Script: status ${resp.status}, body: ${txt.slice(0, 500)}`);
  } catch (e) {
    console.error(`Failed POST to Apps Script: ${e.message}`);
  }
})();
