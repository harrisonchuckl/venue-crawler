import playwright from 'playwright';

function getProxyForScraperAPI() {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('Missing SCRAPERAPI_KEY env var.');
  const country = (process.env.SCRAPERAPI_COUNTRY || 'gb').toLowerCase();
  // Proxy mode: https proxy with username=api_key (no password)
  return {
    server: 'http://proxy-server.scraperapi.com:8001',
    username: key,
    password: '', // empty on purpose
  };
}

export async function launchBrowser() {
  const proxy = getProxyForScraperAPI();
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    proxy,
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    locale: 'en-GB',
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}
