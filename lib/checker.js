const axios = require('axios');
const cheerio = require('cheerio');
const { getBrowser } = require('./browser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSearchUrl(template, business, location) {
  return template
    .replace(/\{\{business\}\}/gi, encodeURIComponent(business))
    .replace(/\{\{location\}\}/gi, encodeURIComponent(location));
}

/**
 * Lowercase, strip legal suffixes + articles, remove special chars.
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

// Industry terms that appear in boilerplate on every directory page.
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

// ---------------------------------------------------------------------------
// "No results" detection
// ---------------------------------------------------------------------------

const NO_RESULTS_PATTERNS = [
  /no results?\s*(found|for|matching)/i,
  /0 results/i,
  /didn['']?t find/i,
  /no match(es)?\s*(found|for)?/i,
  /your search.*did not match/i,
  /we couldn['']?t find/i,
  /sorry,?\s*we couldn/i,
  /no listings?\s*(found|available|match)/i,
  /sorry.*no results/i,
  /no businesses?\s*(found|match)/i,
  /nothing found/i,
  /no records?\s*(found|match)/i,
  /we (could not|couldn't) find/i,
  /there are no results/i,
  /no professionals?\s*(found|match)/i,
  /no attorneys?\s*(found|match)/i,
  /no lawyers?\s*(found|match)/i,
  /no doctors?\s*(found|match)/i,
  /no providers?\s*(found|match)/i,
  /no vendors?\s*(found|match)/i,
  /couldn['']?t find any results/i,
  /if the business you['']?re looking for isn['']?t/i,
];

function pageHasNoResults(text) {
  return NO_RESULTS_PATTERNS.some(p => p.test(text));
}

// ---------------------------------------------------------------------------
// Search echo removal — the core fix for false positives
// ---------------------------------------------------------------------------

// Patterns in text that are just the directory echoing back the search term.
// These lines should be REMOVED before checking for the business name.
const ECHO_PATTERNS = [
  /top \d+\s*(best)?\s/i,
  /showing\s*(results?\s*)?(for|near)/i,
  /results?\s*(for|near|in)\s/i,
  /you searched (for|:)/i,
  /search(ed|ing)?\s*(for|results?)\s*(:|\s)/i,
  /similar to\s/i,
  /people (also )?(search|looked)\s/i,
  /related search/i,
  /did people search for/i,
  /browse .* near/i,
  /find .* near/i,
  /best .* near/i,
  /\d+\s*results?\s*(for|near|in)\s/i,
  /explore other/i,
  /try (widening|a different|another|broadening)/i,
  /what (are|is) .* near/i,
  /frequently asked/i,
  /people also ask/i,
  /can['']?t find the business/i,
  /add (a |your )?business/i,
  /claim (this|your) (business|listing)/i,
];

/**
 * Remove lines from the text that are search echo — the directory repeating
 * the business name in headings, breadcrumbs, FAQ sections, etc.
 *
 * This is the key fix: Yelp shows "Top 10 Best Gallagher & Kennedy" even
 * when the business isn't listed. We strip these echo lines so they don't
 * cause false positives.
 */
function removeSearchEchoText(text, businessName) {
  const normalizedBiz = normalize(businessName);
  if (normalizedBiz.length < 3) return text;

  // Split into sentences/lines
  const segments = text.split(/(?<=[.!?\n])\s+|(?:\n)+/);

  const filtered = segments.filter(segment => {
    const normalizedSeg = normalize(segment);

    // If this segment doesn't contain the business name, keep it
    if (!normalizedSeg.includes(normalizedBiz)) return true;

    // If it contains the business name AND matches an echo pattern, remove it
    return !ECHO_PATTERNS.some(p => p.test(segment));
  });

  return filtered.join(' ');
}

// ---------------------------------------------------------------------------
// Listing link detection (Cheerio-based)
// ---------------------------------------------------------------------------

// URL path segments that indicate an actual listing page (not a search page).
const LISTING_PATH_PATTERNS = /\/(biz|profile|listing|business|company|attorney|doctor|lawyer|vendor|pro|firm|provider|professional|member|detail|place|location|organization)\b/i;

/**
 * Look for <a> tags whose text matches the business name AND whose href
 * looks like a direct listing page on the directory.
 *
 * This is the most reliable signal: if the directory links to a dedicated
 * page for this business, it's definitely listed.
 */
function findListingLinks($, normalizedName, significantWords, directoryHostname) {
  const links = [];

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const text = normalize($(el).text());

    // Skip search/pagination/nav links
    if (/[?&](q|query|search|find_desc|find_text|search_terms|keyword)=/i.test(href)) return;
    if (/[?&](page|start|offset)=/i.test(href)) return;
    if (text.length < 3 || text.length > 200) return;

    // Check if link text contains the full business name
    const hasFullName = normalizedName.length >= 4 && text.includes(normalizedName);

    // Or check significant words in the link text
    let hasSignificantWords = false;
    if (!hasFullName && significantWords.length > 0) {
      const matched = significantWords.filter(w => text.includes(w));
      // Require ALL significant words for link text matching (strict)
      hasSignificantWords = matched.length === significantWords.length;
    }

    if (!hasFullName && !hasSignificantWords) return;

    // Check if this looks like a listing link (not a search link)
    const isOnDirectoryDomain = directoryHostname && href.includes(directoryHostname);
    const isListingPath = LISTING_PATH_PATTERNS.test(href);
    const isAbsoluteListingUrl = href.startsWith('http') && !href.includes('/search');
    const isRelativeListingPath = href.startsWith('/') && !href.startsWith('/search') && href.length > 5;

    if (isListingPath || (isOnDirectoryDomain && (isAbsoluteListingUrl || isRelativeListingPath))) {
      links.push({ href, text });
      return false; // break early — one is enough
    }
  });

  return links;
}

// ---------------------------------------------------------------------------
// Main matching function
// ---------------------------------------------------------------------------

/**
 * Three-strategy approach to determine if a business is listed:
 *
 * 1. **Listing links** — Look for <a> tags that link to a dedicated listing
 *    page for this business (most reliable signal).
 * 2. **Echo-stripped text matching** — Remove all "search echo" text (headings,
 *    breadcrumbs that repeat the search query), then check if the business
 *    name still appears in the remaining content.
 * 3. **"No results" detection** — Catch pages that say "No results found".
 */
function htmlContainsBusiness(html, businessName, directoryHostname) {
  try {
    const $ = cheerio.load(html);
    const normalizedName = normalize(businessName);
    const allWords = normalizedName.split(' ').filter(w => w.length > 2);
    const significantWords = allWords.filter(w => !STOP_WORDS.has(w));

    // ── Strategy 1: Listing links (highest confidence) ──────────────
    const listingLinks = findListingLinks($, normalizedName, significantWords, directoryHostname || '');
    if (listingLinks.length > 0) {
      return true;
    }

    // ── Get cleaned text content ────────────────────────────────────
    // Remove boilerplate DOM elements
    $('script, style, noscript, nav, header, footer, iframe, svg, form, ' +
      'input, select, textarea, button, ' +
      '.nav, .navbar, .header, .footer, .sidebar, .menu, .breadcrumb, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      '[role="search"], [class*="search-bar"], [class*="searchbar"], ' +
      '[class*="breadcrumb"], [class*="pagination"], [class*="pager"]'
    ).remove();

    const rawText = ($('body').text() || $.text()).replace(/\s+/g, ' ').trim();

    // ── Strategy 2: No results detection ────────────────────────────
    if (pageHasNoResults(rawText)) {
      return false;
    }

    // ── Strategy 3: Echo-stripped matching ───────────────────────────
    // Remove lines that are just the directory echoing the search term
    const cleanedText = removeSearchEchoText(rawText, businessName);
    const normalizedClean = normalize(cleanedText);

    // If business name is only stop words, we can't reliably match
    if (significantWords.length === 0) {
      // Only match if full name appears in the echo-stripped text
      return normalizedName.length >= 4 && normalizedClean.includes(normalizedName);
    }

    // Check if full name appears in cleaned text
    if (normalizedName.length >= 4 && normalizedClean.includes(normalizedName)) {
      return true;
    }

    // Check significant words with strict matching
    const sigMatches = significantWords.filter(w => normalizedClean.includes(w));

    // Require ALL significant words to be present
    if (sigMatches.length < significantWords.length) return false;

    // Require proximity — words must appear near each other
    if (significantWords.length >= 2) {
      if (!checkWordProximity(normalizedClean, significantWords, 150)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if words appear within `maxDistance` characters of each other.
 */
function checkWordProximity(text, words, maxDistance) {
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

  const firstWord = words[0];
  for (const pos of positions[firstWord]) {
    const allClose = words.every(w =>
      positions[w].some(p => Math.abs(p - pos) <= maxDistance)
    );
    if (allClose) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Google site: search handling
// ---------------------------------------------------------------------------

function isGoogleSiteSearch(url) {
  return url.includes('google.com/search') && url.includes('site:');
}

function checkGoogleResults(html, businessName) {
  try {
    const $ = cheerio.load(html);
    const bodyText = $('body').text();

    if (/did not match any documents/i.test(bodyText) ||
        /no results found/i.test(bodyText) ||
        /your search.*did not match/i.test(bodyText)) {
      return false;
    }

    const resultHeadings = $('h3').toArray();
    const normalizedName = normalize(businessName);
    const words = normalizedName.split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));

    if (words.length === 0) {
      return resultHeadings.some(h => normalize($(h).text()).includes(normalizedName));
    }

    for (const h of resultHeadings) {
      const headingText = normalize($(h).text());
      if (normalizedName.length >= 4 && headingText.includes(normalizedName)) return true;
      const matches = words.filter(w => headingText.includes(w));
      if (words.length <= 2 && matches.length === words.length) return true;
      if (words.length > 2 && matches.length / words.length >= 0.8) return true;
    }

    const snippets = $('.VwiC3b, .st, [data-content-feature], .IsZvec').toArray();
    for (const s of snippets) {
      const snippetText = normalize($(s).text());
      if (normalizedName.length >= 4 && snippetText.includes(normalizedName)) return true;
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

async function checkWithAxios(url, businessName, directoryHostname, timeout = 15000) {
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

  const found = isGoogleSiteSearch(url)
    ? checkGoogleResults(html, businessName)
    : htmlContainsBusiness(html, businessName, directoryHostname);

  return { found, html };
}

// ---------------------------------------------------------------------------
// Playwright check
// ---------------------------------------------------------------------------

async function checkWithPlaywright(url, businessName, directoryHostname, timeout = 30000) {
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
    await page.waitForTimeout(3000);

    const content = await page.content();

    const found = isGoogleSiteSearch(url)
      ? checkGoogleResults(content, businessName)
      : htmlContainsBusiness(content, businessName, directoryHostname);

    return { found };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Live-URL extraction
// ---------------------------------------------------------------------------

function hostnameFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function extractLiveUrl(html, directoryHostname, businessName) {
  try {
    const $ = cheerio.load(html);
    const normalizedName = normalize(businessName);
    const words = normalizedName.split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
    const searchTerms = words.length > 0 ? words : [normalizedName];

    let bestUrl = null;

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes(directoryHostname)) return;
      if (/[?&](q|query|search|find_desc|find_text|search_terms)=/i.test(href)) return;

      const textLower = normalize($(el).text());
      const hrefLower = href.toLowerCase();
      const combined = hrefLower + ' ' + textLower;

      const hasWord = searchTerms.some(w => combined.includes(w));
      if (hasWord) {
        bestUrl = href.startsWith('http') ? href : null;
        if (bestUrl) return false;
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

  // ---- Axios attempt ----
  if (dir.checkMethod !== 'playwright') {
    try {
      const axiosResult = await checkWithAxios(searchUrl, businessName, directoryHostname);
      result.method = 'axios';
      result.status = axiosResult.found ? 'listed' : 'not_found';

      if (axiosResult.html) {
        result.liveUrl = extractLiveUrl(axiosResult.html, directoryHostname, businessName);
      }
      return result;
    } catch (_err) {
      // Fall through to Playwright
    }
  }

  // ---- Playwright fallback ----
  if (dir.checkMethod !== 'axios') {
    try {
      const pwResult = await checkWithPlaywright(searchUrl, businessName, directoryHostname);
      result.method = 'playwright';
      result.status = pwResult.found ? 'listed' : 'not_found';
      return result;
    } catch (_err) {
      result.status = 'error';
      result.method = 'playwright';
      return result;
    }
  }

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
