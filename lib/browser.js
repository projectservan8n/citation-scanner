let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.warn('Playwright not available — browser-based checks will be skipped');
  chromium = null;
}

let browser = null;
let closeTimer = null;

async function getBrowser() {
  if (!chromium) throw new Error('Playwright is not installed');
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  closeTimer = setTimeout(async () => {
    if (browser) { await browser.close().catch(() => {}); browser = null; }
  }, 60000);
  return browser;
}

async function closeBrowser() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (browser) { await browser.close().catch(() => {}); browser = null; }
}

function isAvailable() {
  return chromium !== null;
}

module.exports = { getBrowser, closeBrowser, isAvailable };
