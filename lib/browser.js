const { chromium } = require('playwright');

let browser = null;
let closeTimer = null;

async function getBrowser() {
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

module.exports = { getBrowser, closeBrowser };
