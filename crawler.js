const fs = require("fs");
const path = require("path");
const playwright = require("playwright");
const pLimit = require("p-limit");
const selectors = require("./selectors.config.js");

const JOB_TOKEN = process.env.JOB_TOKEN;
const APPS_SCRIPT_WEBHOOK = process.env.APPS_SCRIPT_WEBHOOK;
const PROXY_URL = process.env.PROXY_URL || null; // <-- NEW: support proxy

const LIST_CONCURRENCY = 2;
const PAGE_TIMEOUT = 60000;

async function crawlBrandRange(brand, baseUrl, venueSelector, nextSelector) {
  const browserArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];

  // If proxy is set, add it to Chromium launch
  if (PROXY_URL) {
    console.log(`[${brand}] Using proxy: ${PROXY_URL}`);
    browserArgs.push(`--proxy-server=${PROXY_URL}`);
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: browserArgs,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  let pageNum = 1;
  let results = [];
  let keepGoing = true;

  while (keepGoing) {
    const url = baseUrl.replace("PAGE_NUM", pageNum);
    console.log(`[${brand}] Visiting ${url}`);

    try {
      await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: "networkidle" });
    } catch (err) {
      console.error(`[${brand}] page ${pageNum} navigation error: ${err.message}`);
      break;
    }

    // Save debug snapshot
    const pngFile = `${brand.toLowerCase()}-p${pageNum}.png`;
    const htmlFile = `${brand.toLowerCase()}-p${pageNum}.html`;
    await page.screenshot({ path: pngFile, fullPage: true });
    await fs.promises.writeFile(htmlFile, await page.content());

    // Extract venue links
    const links = await page.$$eval(venueSelector, els => els.map(e => e.href));
    console.log(`[${brand}] page ${pageNum} => items: ${links.length}`);

    if (links.length === 0) {
      console.log(`[${brand}] No links found on page ${pageNum}, stopping.`);
      break;
    }

    results.push(...links);

    // Check if next page exists
    const nextExists = await page.$(nextSelector);
    if (nextExists) {
      pageNum++;
    } else {
      console.log(`[${brand}] No next page after ${pageNum}, stopping.`);
      keepGoing = false;
    }
  }

  await browser.close();
  return results;
}

async function run() {
  const allSelectors = Object.entries(selectors);

  for (const [brand, config] of allSelectors) {
    const { url, venueLinkSelector, nextPageSelector } = config;

    // Replace PAGE_NUM placeholder in base URL
    const baseUrl = url.includes("PAGE_NUM") ? url : url + "&page=PAGE_NUM";

    const links = await crawlBrandRange(
      brand,
      baseUrl,
      venueLinkSelector,
      nextPageSelector
    );

    console.log(`[${brand}] Total links found: ${links.length}`);

    // Optionally send to Google Sheets webhook
    if (!APPS_SCRIPT_WEBHOOK) {
      console.error("Missing APPS_SCRIPT_WEBHOOK env var.");
      continue;
    }

    const payload = links.map(link => ({
      source: brand,
      dirUrl: link,
      fetchedAt: new Date().toISOString(),
    }));

    const fetch = (await import("node-fetch")).default;
    await fetch(APPS_SCRIPT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log(`[${brand}] Posted ${payload.length} rows to Google Sheets`);
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
