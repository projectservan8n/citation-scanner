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
      /\b(llc|llp|inc|incorporated|corp|corporation|co|company|ltd|limited|pc|pllc|lp|pa|dba|the|and|of|for|at|in|on|by|to|a|an)\b/g,
      ''
    )
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common filler words that appear on every directory page — never count these
const STOP_WORDS = new Set([
  'law', 'legal', 'firm', 'group', 'attorney', 'attorneys', 'lawyer', 'lawyers',
  'services', 'service', 'solutions', 'consulting', 'associates', 'professional',
  'business', 'medical', 'health', 'care', 'center', 'dental', 'clinic',
  'wedding', 'venue', 'event', 'events', 'photography', 'photo',
  'home', 'design', 'real', 'estate', 'auto', 'car', 'insurance',
  'construction', 'roofing', 'plumbing', 'electric', 'electrical',
  'search', 'find', 'near', 'best', 'top', 'local', 'city', 'state',
  'review', 'reviews', 'rating', 'ratings', 'free', 'consultation',
  'results', 'found', 'showing', 'listed', 'directory', 'profile',
  'view', 'more', 'all', 'contact', 'phone', 'address', 'location',
  'about', 'website', 'visit', 'get', 'call', 'now', 'today',
]);

/**
 * Extract only the meaningful text content from HTML, stripping nav, header,
 * footer, scripts, styles, and other boilerplate.
 */
function extractContentText(html) {
  try {
    const $ = cheerio.load(html);

    // Remove boilerplate elements
    $('script, style, noscript, nav, header, footer, iframe, svg, .nav, .navbar, .header, .footer, .sidebar, .menu, .breadcrumb, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();

    // Get the text content of the remaining body
    const text = $('body').text() || $.text();
    return text.replace(/\s+/g, ' ').trim();
  } catch {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

/**
 * Patterns that indicate the page returned zero results / no listing found.
 */
const NO_RESULTS_PATTERNS = [
  /no results?\s*(found|for|matching)/i,
  /0 results/i,
  /didn['']?t find/i,
  /no match(es)?\s*(found|for)?/i,
  /your search.*did not match/i,
  /we couldn['']?t find/i,
  /no listings?\s*(found|available|match)/i,
  /sorry.*no results/i,
  /no businesses?\s*(found|match)/i,
  /nothing found/i,
  /no records?\s*(found|match)/i,
  /we (could not|couldn't) find/i,
  /there are no results/i,
  /no professionals?\s*(found|match)/i,
  /try (a different|another|broadening)/i,
  /no attorneys?\s*(found|match)/i,
  /no lawyers?\s*(found|match)/i,
  /no doctors?\s*(found|match)/i,
  /no providers?\s*(found|match)/i,
  /no vendors?\s*(found|match)/i,
];

/**
 * Check if the page indicates "no results found".
 */
function pageHasNoResults(text) {
  const snippet = text.slice(0, 5000); // only check first portion
  return NO_RESULTS_PATTERNS.some(p => p.test(snippet));
}

/**
 * Smart business name matching against page content.
 *
 * Strategy:
 * 1. First check if the FULL normalized name appears as a substring → definite match
 * 2. Then check if "no results" patterns appear → definite not found
 * 3. Finally, check significant unique words (excluding stop words) with high threshold
 */
function htmlContainsBusiness(html, businessName) {
  const contentText = extractContentText(html);
  const normalizedContent = normalize(contentText);
  const fullNormalized = normalize(businessName);

  // 1. Exact full-name match → definitely listed
  if (fullNormalized.length >= 4 && normalizedContent.includes(fullNormalized)) {
    // But check for "no results" — page might mention the search term in
    // "No results found for XYZ" context
    if (pageHasNoResults(contentText)) {
      return false;
    }
    return true;
  }

  // 2. Check for "no results" patterns early
  if (pageHasNoResults(contentText)) {
    return false;
  }

  // 3. Word-by-word matching with stop words removed
  const allWords = fullNormalized.split(' ').filter(w => w.length > 2);
  // Split into "significant" (unique to this business) vs "generic" words
  const significantWords = allWords.filter(w => !STOP_WORDS.has(w));
  const genericWords = allWords.filter(w => STOP_WORDS.has(w));

  // If the business name is ONLY generic words (e.g. "Law Group Services"),
  // we can't reliably match — require exact match which we already checked above
  if (significantWords.length === 0) {
    return false;
  }

  // Check how many significant words appear in the content
  const sigMatches = significantWords.filter(w => normalizedContent.includes(w));

  // For short names (1-2 significant words): require ALL significant words
  // For longer names: require at least 80%
  if (significantWords.length <= 2) {
    if (sigMatches.length < significantWords.length) return false;
  } else {
    if (sigMatches.length / significantWords.length < 0.8) return false;
  }

  // Extra validation: the significant words should appear near each other
  // (within ~200 chars) to avoid matching "Smith" in nav and "Garcia" in footer
  if (significantWords.length >= 2) {
    const proximity = checkWordProximity(normalizedContent, significantWords, 200);
    if (!proximity) return false;
  }

  return true;
}

/**
 * Check if the given words appear within `maxDistance` characters of each other
 * somewhere in the text. This prevents matching scattered words across the page.
 */
function checkWordProximity(text, words, maxDistance) {
  // Find all positions of each word
  const positions = {};
  for (const word of words) {
    positions[word] = [];
    let idx = text.indexOf(word);
    while (idx !== -1) {
      positions[word].push(idx);
      idx = text.indexOf(word, idx + 1);
    }
    if (positions[word].length === 0) return false;
  }

  // Check if there's a window of maxDistance where all words appear
  const firstWord = words[0];
  for (const pos of positions[firstWord]) {
    const allClose = words.every(w => {
      return positions[w].some(p => Math.abs(p - pos) <= maxDistance);
    });
    if (allClose) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Google site: search handling
// ---------------------------------------------------------------------------

/**
 * Check if a search URL is a Google site: search.
 */
function isGoogleSiteSearch(url) {
  return url.includes('google.com/search') && url.includes('site:');
}

/**
 * For Google site: searches, check the result snippets differently.
 * Google results pages have a specific structure.
 */
function checkGoogleResults(html, businessName) {
  try {
    const $ = cheerio.load(html);

    // Check if Google returned "No results found"
    const bodyText = $('body').text();
    if (/did not match any documents/i.test(bodyText) ||
        /no results found/i.test(bodyText) ||
        /your search.*did not match/i.test(bodyText)) {
      return false;
    }

    // Look for search result entries — Google uses <h3> inside result divs
    const resultHeadings = $('h3').toArray();
    const normalizedName = normalize(businessName);
    const words = normalizedName.split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));

    if (words.length === 0) {
      // All generic words — check if full name appears in any heading
      return resultHeadings.some(h => {
        const text = normalize($(h).text());
        return text.includes(normalizedName);
      });
    }

    // Check if any result heading or snippet contains the business name
    for (const h of resultHeadings) {
      const headingText = normalize($(h).text());
      // Check for full name match in heading
      if (normalizedName.length >= 4 && headingText.includes(normalizedName)) {
        return true;
      }
      // Check if most significant words are in the heading
      const matches = words.filter(w => headingText.includes(w));
      if (words.length <= 2 && matches.length === words.length) return true;
      if (words.length > 2 && matches.length / words.length >= 0.8) return true;
    }

    // Also check the snippet text near each result
    const snippets = $('.VwiC3b, .st, [data-content-feature], .IsZvec').toArray();
    for (const s of snippets) {
      const snippetText = normalize($(s).text());
      if (normalizedName.length >= 4 && snippetText.includes(normalizedName)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
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

  // Use different matching for Google site: searches
  const found = isGoogleSiteSearch(url)
    ? checkGoogleResults(html, businessName)
    : htmlContainsBusiness(html, businessName);

  return { found, html };
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

    const found = isGoogleSiteSearch(url)
      ? checkGoogleResults(content, businessName)
      : htmlContainsBusiness(content, businessName);

    return { found };
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
    const normalizedName = normalize(businessName);
    const words = normalizedName.split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));

    // If no significant words, try full name
    const searchTerms = words.length > 0 ? words : [normalizedName];

    let bestUrl = null;

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes(directoryHostname)) return;

      const hrefLower = href.toLowerCase();
      const textLower = ($(el).text() || '').toLowerCase();
      const combined = hrefLower + ' ' + textLower;

      const hasWord = searchTerms.some((w) => combined.includes(w));
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
