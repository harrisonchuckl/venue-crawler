// crawler.js
// Playwright crawler with auto-scroll + graceful "no more pages" exit.

const fs = require("fs/promises");
const { chromium } = require("playwright");

// ===== Settings via env (set in your workflow) =====
const BRAND        = process.env.BRAND || "HireSpace";  // TagVenue | HireSpace
const SHARD_INDEX  = Number(process.env.SHARD_INDEX || 1);
const SHARD_TOTAL  = Number(process.env.SHARD_TOTAL || 1);
const MAX_PAGES    = Number(process.env.MAX_PAGES || 500); // hard ceiling
const STOP_AFTER_EMPTY = Number(process.env.STOP_AFTER_EMPTY || 2); // consecutive empty pages to stop
const APPS_SCRIPT_WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK;
const JOB_TOKEN    = process.env.JOB_TOKEN || ""; // optional header for your Apps Script

if (!APPS_SCRIPT_WEBHOOK) {
  console.error("Missing APPS_SCRIPT_WEBHOOK env var.");
  process.exit(1);
}

// ===== Brand config =====
const brands = {
  TagVenue: {
    seed: (page) =>
      `https://www.tagvenue.com/uk/search/event-venue?latitude_from=47.5554486&latitude_to=61.5471111&longitude_from=-18.5319589&longitude_to=9.5844157&form_timestamp=1757239921&getAllRoomsPositions=true&hideRoomsData=false&items_per_page=36&map_zoom=&people=&date=&time_from=&time_to=&room_layout=0&min_price=&max_price=&price_range=&price_method=&neighbourhood=London%2C%20United%20Kingdom&page=${page}&room_tag=event-venue&supervenues_only=false&flexible_cancellation_only=false&no_age_restriction=false&iso_country_code=GB&view=results&trigger=initMap`,
    listLinkSelector:
      'a[data-qa="space-card-link"], a[data-qa="venue-card-link"], a[href*="/space/"], a[href*="/venues/"]',
    cardNameSelector:
      '[data-qa="space-card-title"], .venue-card__title, h3, h2',
    humanCheckText: /verify|robot|captcha|access denied/i
  },
  HireSpace: {
    seed: (page) =>
      `https://hirespace.com/Search?budget=30-100000&area=United+Kingdom&googlePlaceId=ChIJqZHHQhE7WgIReiWIMkOg-MQ&page=${page}&perPage=36&sort=relevance`,
    listLinkSelector:
      'a[href^="/Spaces/"], a[href^="/Space/"], a[href^="/Venues/"]',
    cardNameSelector:
      '.card-title, .venue-card__title, h3, h2',
    humanCheckText: /verify|robot|captcha|access denied/i
  }
};

const cfg = brands[BRAND];
if (!cfg) {
  console.error(`Unknown BRAND: ${BRAND}`);
  process.exit(1);
}

// ===== Helpers =====

async function autoScroll(page, {
  step = 0.9,      // fraction of viewport height per tick
  maxTicks = 45,   // safety cap
  idleMs = 300,    // wait after each scroll
  selectorToCount  // the items to watch for growth
}) {
  let last = 0;
  for (let i = 0; i < maxTicks; i++) {
    await page.evaluate(s => window.scrollBy(0, Math.floor(window.innerHeight * s)), step);
    await page.waitForTimeout(idleMs);

    const count = await page.$$eval(selectorToCount, els => els.length).catch(() => 0);
    if (count <= last) {
      // one last push to very bottom
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(idleMs);
      const count2 = await page.$$eval(selectorToCount, els => els.length).catch(() => 0);
      if (count2 <= last) break;
      last = count2;
    } else {
      last = count;
    }
  }
  return last;
}

async function postToAppsScript(rows) {
  try {
    const resp = await fetch(APPS_SCRIPT_WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(JOB_TOKEN ? { "x-job-token": JOB_TOKEN } : {})
      },
      body: JSON.stringify({ kind: "catalog-batch", rows })
    });
    const text = await resp.text();
    console.log(`Posted to Apps Script: ${resp.status} ${resp.statusText} | body: ${text.slice(0, 240)}`);
  } catch (e) {
    console.error("Failed POST to Apps Script:", e.message);
  }
}

function isThisShard(pageNumber) {
  // Visit only pages whose (index modulo total) matches this shard index
  return (pageNumber - 1) % SHARD_TOTAL === (SHARD_INDEX - 1);
}

// ===== Main =====

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let allRows = [];
  let emptyStreak = 0;
  const seenLinks = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    if (!isThisShard(p)) continue;

    const url = cfg.seed(p);
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      console.warn(`[${BRAND}] page ${p} navigation error: ${e.message}`);
      emptyStreak++;
      if (emptyStreak >= STOP_AFTER_EMPTY) {
        console.log(`[${BRAND}] stopping after ${emptyStreak} consecutive empty/error pages.`);
        break;
      }
      continue;
    }

    // HTTP status check
    const status = response ? response.status() : 0;
    if (!response || status >= 400) {
      console.warn(`[${BRAND}] page ${p} HTTP status ${status}. Counting as empty.`);
      emptyStreak++;
      if (emptyStreak >= STOP_AFTER_EMPTY) {
        console.log(`[${BRAND}] stopping after ${emptyStreak} consecutive empty/error pages.`);
        break;
      }
      continue;
    }

    // quick initial settle
    await page.waitForTimeout(700);

    // human/bot wall?
    const txt = (await page.content()).slice(0, 50_000);
    if (cfg.humanCheckText.test(txt)) {
      console.warn(`[${BRAND}] page ${p} looks like a verification/bot wall. Stopping.`);
      break;
    }

    // auto-scroll to load lazy content
    const before = await page.$$eval(cfg.listLinkSelector, els => els.length).catch(() => 0);
    const after = await autoScroll(page, { selectorToCount: cfg.listLinkSelector });

    // extract links
    const links = await page.$$eval(cfg.listLinkSelector, as =>
      Array.from(new Set(as.map(a => (a.href || "").trim())))
        .filter(h => h && h.startsWith("http"))
    ).catch(() => []);

    // de-dup across pages
    const fresh = links.filter(h => !seenLinks.has(h));
    fresh.forEach(h => seenLinks.add(h));

    // sample names (for logs)
    const names = await page.$$eval(cfg.cardNameSelector, els =>
      els.slice(0, 6).map(e => (e.textContent || "").trim()).filter(Boolean)
    ).catch(() => []);

    // debug artifacts for the first page we hit in this shard
    if (allRows.length === 0) {
      const stem = `${BRAND.toLowerCase()}-p${p}`;
      try {
        await page.screenshot({ path: `${stem}.png`, fullPage: true });
        await fs.writeFile(`${stem}.html`, await page.content(), "utf8");
      } catch (_) {}
    }

    console.log(
      `[${BRAND}] page ${p} => items: ${links.length} (new: ${fresh.length}) | before: ${before}, after: ${after}`
    );
    if (names.length) console.log(`[${BRAND}] sample: ${names.join(" | ").slice(0, 180)}`);

    if (after === 0 || links.length === 0 || fresh.length === 0) {
      // Nothing here (or only repeats) → count as empty and maybe stop.
      emptyStreak++;
      if (emptyStreak >= STOP_AFTER_EMPTY) {
        console.log(`[${BRAND}] stopping after ${emptyStreak} consecutive empty pages.`);
        break;
      }
      // small pause before next page
      await page.waitForTimeout(500);
      continue;
    }

    // reset empty streak if we got something new
    emptyStreak = 0;

    // Map to rows for Sheet
    const rows = fresh.map(h => ({
      name: "",
      city: "",
      source: BRAND,
      dirUrl: h,
      fetchedAt: new Date().toISOString()
    }));

    allRows.push(...rows);

    // politeness delay between pages
    await page.waitForTimeout(650);
  }

  // POST batch if anything found
  if (allRows.length) {
    await postToAppsScript(allRows);
  } else {
    console.log(`[${BRAND}] no rows to post.`);
  }

  await browser.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
