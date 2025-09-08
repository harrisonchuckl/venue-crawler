// Fast, parallel Playwright crawler with sharding for TagVenue + HireSpace
// Sends rows to Apps Script Webhook.
// Usage (locally): APPS_SCRIPT_WEBHOOK=... JOB_TOKEN=... node crawler.js
// Actions: provided via secrets/environment.

const { chromium } = require('playwright');
const { default: pLimit } = require('p-limit'); // works with ESM-only p-limit
const axios = require('axios');

const WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK || '';
const JOB_TOKEN = process.env.JOB_TOKEN || '';
const BRAND = process.env.BRAND || 'TagVenue'; // TagVenue | HireSpace | Both
const START_PAGE = parseInt(process.env.START_PAGE || '1', 10);
const END_PAGE = parseInt(process.env.END_PAGE || '3', 10); // increase for full run
const DETAIL_CONCURRENCY = parseInt(process.env.DETAIL_CONCURRENCY || '6', 10);
const LIST_CONCURRENCY = parseInt(process.env.LIST_CONCURRENCY || '2', 10);
const PAGE_TIMEOUT_MS = 35000;

const SEEDS = {
  TagVenue: (page) =>
    `https://www.tagvenue.com/uk/search/event-venue?iso_country_code=GB&items_per_page=36&page=${page}`,
  HireSpace: (page) =>
    `https://hirespace.com/Search?area=United+Kingdom&perPage=36&sort=relevance&page=${page}`,
};

const LISTING = {
  TagVenue: {
    venueLinkSelector:
      'a[data-qa="space-card-link"], a[data-qa="venue-card-link"], a[href*="/space/"], a[href*="/venues/"]',
    nextPageSelector:
      'a[rel="next"], a[aria-label="Next"], a[aria-label*="Next"], a[href*="page="]',
  },
  HireSpace: {
    venueLinkSelector:
      'a[href*="/Spaces/"], a[href*="/Space/"], a[href*="/Venues/"]',
    nextPageSelector:
      'a[rel="next"], a[aria-label="Next"], a[aria-label*="Next"], a[href*="page="]',
  },
};

const DETAILS = {
  nameSelector:
    'h1, .venue-title, [data-qa="venue-name"], [itemprop="name"]',
  citySelector:
    '.city, [itemprop="addressLocality"], .venue-location',
};

function uniq(a) { return [...new Set(a)]; }

async function extractVenueData(browser, url) {
  const p = await browser.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await p.waitForTimeout(400);
    const name = (await p.locator(DETAILS.nameSelector).first().textContent().catch(()=>''))?.trim() || '';
    const city = (await p.locator(DETAILS.citySelector).first().textContent().catch(()=>''))?.trim() || '';
    return { name, city, dirUrl: url };
  } finally {
    await p.close();
  }
}

async function collectListingLinks(browser, brand, pageUrl) {
  const cfg = LISTING[brand];
  const p = await browser.newPage();
  try {
    await p.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await p.waitForTimeout(500);
    const links = await p.$$eval(cfg.venueLinkSelector, as => [...new Set(as.map(a => a.href))]).catch(()=>[]);
    let nextHref = null;
    const next = await p.$(cfg.nextPageSelector);
    if (next) {
      nextHref = await next.getAttribute('href');
      if (nextHref && !/^https?:\/\//i.test(nextHref)) {
        nextHref = new URL(nextHref, pageUrl).toString();
      }
    }
    return { links: uniq(links), nextHref };
  } catch {
    return { links: [], nextHref: null };
  } finally {
    await p.close();
  }
}

async function crawlBrandRange(brand, fromPage, toPage) {
  const browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const listLimiter = pLimit(LIST_CONCURRENCY);
    const detailLimiter = pLimit(DETAIL_CONCURRENCY);

    // Step 1: collect all detail URLs from listing pages
    const listTasks = [];
    for (let page = fromPage; page <= toPage; page++) {
      listTasks.push(listLimiter(async () => {
        const url = SEEDS[brand](page);
        const { links } = await collectListingLinks(browser, brand, url);
        return links;
      }));
    }
    const listResults = await Promise.all(listTasks);
    const allDetailUrls = uniq(listResults.flat());

    // Step 2: visit detail pages in parallel and extract name + city
    const rows = [];
    const detailTasks = allDetailUrls.map(href => detailLimiter(async () => {
      const v = await extractVenueData(browser, href);
      if (v.name) rows.push([v.name, v.city, brand, href, new Date().toISOString()]);
    }));
    await Promise.all(detailTasks);

    return rows;
  } finally {
    await browser.close();
  }
}

(async () => {
  const brands = (process.env.BRAND || 'Both') === 'Both' ? ['TagVenue','HireSpace'] : [process.env.BRAND];
  const perBrandRows = [];

  for (const b of brands) {
    const rows = await crawlBrandRange(b, START_PAGE, END_PAGE);
    console.log(`[${b}] rows:`, rows.length);
    perBrandRows.push(...rows);
  }

  // POST to Apps Script
  if (WEBHOOK && JOB_TOKEN) {
    await axios.post(WEBHOOK, { rows: perBrandRows }, {
      headers: { 'x-job-token': JOB_TOKEN, 'content-type': 'application/json' }
    });
    console.log('Posted to Apps Script:', perBrandRows.length);
  } else {
    console.log('No WEBHOOK/JOB_TOKEN set. Rows:', perBrandRows.length);
  }
})();
