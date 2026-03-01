const axios = require('axios');
const cheerio = require('cheerio');
const { getBrowser } = require('./browser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace {{business}} and {{location}} placeholders with URI-encoded values.
 */
function buildSearchUrl(template, business, location) {
  return template
    .replace(/\{\{business\}\}/gi, encodeURIComponent(business))
    .replace(/\{\{location\}\}/gi, encodeURIComponent(location));
}

/**
 * Lowercase, strip common legal suffixes (LLC, LLP, Inc, PC, etc.),
 * remove special characters.
 */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(
      /\b(llc|llp|inc|incorporated|corp|corporation|co|company|ltd|limited|pc|pllc|lp|pa|dba)\b/gi,
      ''
    )
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check whether at least 60% of significant words (length > 2) from the
 * business name appear somewhere in the HTML.
 */
function htmlContainsBusiness(html, businessName) {
  const normalizedHtml = normalize(html);
  const words = normalize(businessName)
    .split(' ')
    .filter((w) => w.length > 2);

  if (words.length === 0) return false;

  const matches = words.filter((w) => normalizedHtml.includes(w));
  return matches.length / words.length >= 0.6;
}

// ---------------------------------------------------------------------------
// Axios check
// ---------------------------------------------------------------------------

const AXIOS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

/**
 * Attempt a plain HTTP GET and check for the business name in the response.
 * Returns { found: boolean, html: string }.
 * Throws on network / blocking errors so the caller can fall through to Playwright.
 */
async function checkWithAxios(url, businessName, timeout = 15000) {
  const response = await axios.get(url, {
    headers: AXIOS_HEADERS,
    timeout,
    maxRedirects: 5,
    validateStatus: (s) => s < 400,
  });

  const html = typeof response.data === 'string' ? response.data : '';

  if (!html || html.length < 200) {
    throw new Error('Empty or too-short response — likely blocked or JS-rendered');
  }

  return {
    found: htmlContainsBusiness(html, businessName),
    html,
  };
}

// ---------------------------------------------------------------------------
// Playwright check
// ---------------------------------------------------------------------------

/**
 * Open the URL in shared Chromium, wait for JS rendering, then check content.
 * Returns { found: boolean }.
 */
async function checkWithPlaywright(url, businessName, timeout = 30000) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Give JS-heavy pages a moment to hydrate
    await page.waitForTimeout(3000);

    const content = await page.content();
    return { found: htmlContainsBusiness(content, businessName) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Live-URL extraction (Cheerio)
// ---------------------------------------------------------------------------

/**
 * Pull a hostname from a URL string, stripping "www." prefix.
 */
function hostnameFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Scan the HTML for an <a> tag whose href contains the directory hostname
 * AND at least one significant word from the business name.
 * Returns the href string or null.
 */
function extractLiveUrl(html, directoryHostname, businessName) {
  try {
    const $ = cheerio.load(html);
    const words = normalize(businessName)
      .split(' ')
      .filter((w) => w.length > 2);

    if (words.length === 0) return null;

    let bestUrl = null;

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes(directoryHostname)) return;

      const hrefLower = href.toLowerCase();
      const textLower = ($(el).text() || '').toLowerCase();
      const combined = hrefLower + ' ' + textLower;

      const hasWord = words.some((w) => combined.includes(w));
      if (hasWord) {
        bestUrl = href.startsWith('http') ? href : null;
        if (bestUrl) return false; // break .each
      }
    });

    return bestUrl;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main: checkDirectory
// ---------------------------------------------------------------------------

/**
 * Check a single directory for a business listing using a hybrid
 * Axios -> Playwright strategy.
 *
 * @param {Object} dir           Directory object from directories.json
 * @param {string} businessName  The business to search for
 * @param {string} location      City / region for the search
 *
 * @returns {Object} result with fields:
 *   directoryId, name, url, searchUrl, category,
 *   status ("listed" | "not_found" | "error"),
 *   method ("axios" | "playwright"),
 *   liveUrl (string | null)
 */
async function checkDirectory(dir, businessName, location) {
  const searchUrl = buildSearchUrl(dir.searchUrlTemplate, businessName, location);
  const directoryHostname = hostnameFromUrl(dir.url);

  const result = {
    directoryId: dir.id,
    name: dir.name,
    url: dir.url,
    searchUrl,
    category: dir.category || 'general',
    status: 'not_found',
    method: null,
    liveUrl: null,
  };

  // ---- Axios attempt (skip if directory is playwright-only) ---------------
  if (dir.checkMethod !== 'playwright') {
    try {
      const axiosResult = await checkWithAxios(searchUrl, businessName);
      result.method = 'axios';
      result.status = axiosResult.found ? 'listed' : 'not_found';

      // Try to pull a direct listing link from the HTML
      if (axiosResult.html) {
        result.liveUrl = extractLiveUrl(
          axiosResult.html,
          directoryHostname,
          businessName
        );
      }

      return result;
    } catch (_err) {
      // Axios failed (blocked, timeout, empty response, JS-rendered)
      // Fall through to Playwright
    }
  }

  // ---- Playwright fallback (skip if directory is axios-only) --------------
  if (dir.checkMethod !== 'axios') {
    try {
      const pwResult = await checkWithPlaywright(searchUrl, businessName);
      result.method = 'playwright';
      result.status = pwResult.found ? 'listed' : 'not_found';
      return result;
    } catch (_err) {
      result.status = 'error';
      result.method = 'playwright';
      return result;
    }
  }

  // If we reach here, Axios was the only allowed method and it failed.
  result.status = 'error';
  result.method = 'axios';
  return result;
}

module.exports = {
  buildSearchUrl,
  normalize,
  htmlContainsBusiness,
  checkWithAxios,
  checkWithPlaywright,
  checkDirectory,
};
