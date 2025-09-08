// crawler.js (diagnostic + extraction)
// CommonJS style so it runs on Node 20 in Actions.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// --- CONFIG -----------------------------------------------------------------
const BRANDS = {
  TagVenue: {
    seed: 'https://www.tagvenue.com/uk/search/event-venue?latitude_from=47.5554486&latitude_to=61.5471111&longitude_from=-18.5319589&longitude_to=9.5844157&form_timestamp=1757239921&getAllRoomsPositions=true&hideRoomsData=false&items_per_page=36&map_zoom=&people=&date=&time_from=&time_to=&room_layout=0&min_price=&max_price=&price_range=&price_method=&neighbourhood=London%2C%20United%20Kingdom&page=1&room_tag=event-venue&supervenues_only=false&flexible_cancellation_only=false&no_age_restriction=false&iso_country_code=GB&view=results&trigger=initMap',
    // How to change pages:
    // Replace &page=NUMBER in the URL.
    nextUrl: (url, pageNo) => url.replace(/(&|\?)page=\d+/, `$1page=${pageNo}`),
  },
  HireSpace: {
    seed: 'https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&page=1&perPage=36&sort=relevance',
    nextUrl: (url, pageNo) => url.replace(/(&|\?)page=\d+/, `$1page=${pageNo}`)
  }
};

// How many listing pages per brand to sample
const PAGES_PER_BRAND = 3;

// Where to dump diagnostics
const ARTIFACT_DIR = path.join(__dirname, 'artifacts');

// Simple extractors that try multiple patterns on listing pages
async function extractOnListing(page) {
  // Try a bunch of things. We’ll dedupe by name+city.
  function pickText(el, sel) {
    const n = el.querySelector(sel);
    return n ? n.textContent.trim() : '';
  }
  const results = [];

  // Strategy A: look for items exposing name/city on the card itself
  // (works for many SSR/CSR mixtures).
  const cardSelectors = [
    '[data-qa*="card"]',
    '[class*="card"]',
    'article',
    'li',
    'div'
  ];

  for (const cardSel of cardSelectors) {
    const batch = await page.$$eval(cardSel, cards => cards.map(c => {
      // Try a variety of common sub-selectors
      const name =
        (c.querySelector('h2,h1,[data-qa="venue-name"],[itemprop="name"]')?.textContent || '').trim();
      const city =
        (c.querySelector('.city,[itemprop="addressLocality"],.venue-location')?.textContent || '').trim();
      const hrefEl =
        c.querySelector('a[href*="/space/"], a[href*="/venues/"], a[href*="/Spaces/"], a[href*="/Space/"], a[href*="/Venues/"]');
      const href = hrefEl ? hrefEl.href : '';

      if (name || href) {
        return { name, city, dirUrl: href };
      }
      return null;
    }).filter(Boolean));
    results.push(...batch);
  }

  // Strategy B: fall back to grabbing all anchors that look like venue links
  const urlBatch = await page.$$eval('a[href]', as =>
    Array.from(new Set(as.map(a => a.href)))
      .filter(href =>
        /tagvenue\.com\/.+(space|venues)\//i.test(href) ||
        /hirespace\.com\/(Space|Spaces|Venues)\//i.test(href)
      )
      .map(href => ({ name: '', city: '', dirUrl: href }))
  );
  results.push(...urlBatch);

  // Dedupe by (name|city|dirUrl)
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = (r.name + '|' + r.city + '|' + r.dirUrl).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }
  return deduped;
}

async function run() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1365, height: 900 },
    locale: 'en-GB'
  });

  let total = 0;
  const all = [];

  for (const [brand, cfg] of Object.entries(BRANDS)) {
    let pageUrl = cfg.seed;
    const page = await context.newPage();

    for (let i = 1; i <= PAGES_PER_BRAND; i++) {
      const url = i === 1 ? pageUrl : cfg.nextUrl(cfg.seed, i);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      // Gentle scroll to trigger lazy rendering
      for (let y = 0; y <= 2000; y += 400) {
        await page.evaluate(h => window.scrollTo(0, h), y);
        await page.waitForTimeout(300);
      }

      // Save diagnostics
      const safeName = `${brand.toLowerCase()}-p${i}`;
      const png = path.join(ARTIFACT_DIR, `${safeName}.png`);
      const html = path.join(ARTIFACT_DIR, `${safeName}.html`);
      await page.screenshot({ path: png, fullPage: true });
      fs.writeFileSync(html, await page.content(), 'utf8');

      // Try to extract on the listing
      const items = await extractOnListing(page);
      all.push(...items);
      total += items.length;

      console.log(`[${brand}] page ${i} => items: ${items.length} | saved ${safeName}.png/.html`);
    }

    await page.close();
  }

  // Print a compact summary to logs
  console.log(`TOTAL extracted: ${total}`);
  console.log('Sample (up to 10):');
  console.log(all.slice(0, 10));

  await browser.close();

  // If you also post to Apps Script, you can keep your existing POST here.
  // The diagnostics will tell us first what the pages look like in CI.
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
