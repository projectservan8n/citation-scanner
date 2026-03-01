# Citation Scanner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a hybrid Axios/Playwright citation scanner that checks 100+ directories for business listings, with multi-client support, CSV import, and a polished Tailwind + Framer Motion UI.

**Architecture:** Express backend serves a single-page frontend. The check engine tries Axios first (fast HTTP), falls back to Playwright (browser) when Axios fails. Results stream via SSE. Directories stored in JSON file for easy expansion. Client profiles and scan history stored in JSON files.

**Tech Stack:** Node.js, Express, Axios, Cheerio, Playwright, Tailwind CSS (CDN), Framer Motion (CDN), SSE

---

### Task 1: Create directories.json with 100+ directories

**Files:**
- Create: `data/directories.json`
- Create: `data/clients.json` (empty array)

**Step 1: Create the data directory and directories.json**

Merge all 65 directories from current `server.js` + unique directories from the ClickUp CSV into a single JSON file. Each entry uses this schema:

```json
{
  "id": "yelp",
  "name": "Yelp",
  "url": "https://www.yelp.com",
  "searchUrlTemplate": "https://www.yelp.com/search?find_desc={{business}}&find_loc={{location}}",
  "category": "General",
  "checkMethod": "hybrid",
  "active": true
}
```

Categories: `General`, `Legal`, `Medical`, `Wedding/Venue`, `Chamber`, `Regional`, `Other`

Include all directories from the CSV that have a domain URL (the `Domain (url)` column). Dedupe by domain. Skip entries without a domain.

CSV directories to add (not already in server.js):
- find-us-here.com, provenexpert.com, crunchbase.com, opendi.us, tuugo.us, ibegin.com, localstack.com, ezlocal.com, golocal247.com, n49.com
- brownbook.net, callupcontact.com, sitelike.org, goodfirms.co, cybo.com, 2findlocal.com, about.me, threebestrated.com, citylocalpro.com, trustvetted.com
- ontoplist.com, generalbar.com, topratedlocal.com, uslegal.com, clutch.co, trustpilot.com, birdeye.com, elocal.com
- jasminedirectory.com, botw.org, somuch.com, reviewcentre.com, crowdreviews.com, sitejabber.com, complaintsboard.com
- data-axle.com, merchantcircle.com, showmelocal.com, hotfrog.com
- dnb.com, brandfetch.com, gravatar.com, apsense.com, contactout.com, featured.com, bunity.com
- attorneys: lawlink.com, lawyerland.com, attorneyyellowpages.com, lawleaders.com, legalreach.com, lawserver.com, hg.org, justia.com, findlaw.com, avvo.com, superlawyers.com, martindale.com, lawyers.com, bestlawfirms.com, lawyerlegion.com, expertise.com, chamberofcommerce.com
- medical: healthgrades.com, ratemds.com, doximity.com, manta.com
- wedding: theknot.com, weddingwire.com, partyslate.com, eventective.com, caratsandcake.com, stylemepretty.com, heartofncweddings.com, junebugweddings.com
- regional: totallyboise.com, buyidaho.org, boisechamber.org, meridianchamber.org, phoenixmag.com, downtownraleigh.org, localfirstaz.com, thescottsdaleliving.com

**Step 2: Create empty clients.json**

```json
[]
```

**Step 3: Commit**

```bash
git add data/
git commit -m "feat: add directories.json with 100+ directories and empty clients store"
```

---

### Task 2: Build the hybrid check engine

**Files:**
- Create: `lib/checker.js`
- Create: `lib/browser.js`

**Step 1: Create browser.js — shared Playwright browser manager**

This module manages a single shared Chromium browser instance. It lazy-launches on first use and reuses for all subsequent checks. Auto-closes after 60s of inactivity.

```javascript
// lib/browser.js
const { chromium } = require('playwright');

let browser = null;
let closeTimer = null;

async function getBrowser() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  // Auto-close after 60s idle
  closeTimer = setTimeout(async () => {
    if (browser) { await browser.close(); browser = null; }
  }, 60000);
  return browser;
}

async function closeBrowser() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (browser) { await browser.close(); browser = null; }
}

module.exports = { getBrowser, closeBrowser };
```

**Step 2: Create checker.js — hybrid Axios/Playwright check engine**

```javascript
// lib/checker.js
const axios = require('axios');
const cheerio = require('cheerio');
const { getBrowser } = require('./browser');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function buildSearchUrl(template, business, location) {
  return template
    .replace(/\{\{business\}\}/g, encodeURIComponent(business))
    .replace(/\{\{location\}\}/g, encodeURIComponent(location));
}

// Normalize business name for matching (lowercase, strip common suffixes)
function normalize(str) {
  return str.toLowerCase()
    .replace(/,?\s*(llc|llp|inc|pllc|pc|p\.c\.|apc|corp|ltd)\.?$/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function htmlContainsBusiness(html, businessName) {
  const norm = normalize(businessName);
  const words = norm.split(/\s+/).filter(w => w.length > 2);
  const lowerHtml = html.toLowerCase();
  // Require at least 60% of significant words to match
  const matches = words.filter(w => lowerHtml.includes(w));
  return matches.length >= Math.ceil(words.length * 0.6);
}

async function checkWithAxios(url, businessName, timeout = 8000) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout,
    maxRedirects: 5,
    validateStatus: (s) => s < 400,
  });
  const html = response.data;
  if (typeof html !== 'string' || html.length < 200) {
    throw new Error('Empty or non-HTML response');
  }
  return { found: htmlContainsBusiness(html, businessName), html };
}

async function checkWithPlaywright(url, businessName, timeout = 15000) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000); // let JS render
    const content = await page.content();
    return { found: htmlContainsBusiness(content, businessName) };
  } finally {
    await page.close();
    await context.close();
  }
}

async function checkDirectory(dir, businessName, location) {
  const searchUrl = buildSearchUrl(dir.searchUrlTemplate, businessName, location);
  const result = {
    directoryId: dir.id,
    name: dir.name,
    url: dir.url,
    searchUrl,
    category: dir.category,
    status: 'error',
    method: null,
    liveUrl: null,
  };

  // Step 1: Try Axios
  if (dir.checkMethod !== 'playwright') {
    try {
      const axiosResult = await checkWithAxios(searchUrl, businessName);
      result.status = axiosResult.found ? 'listed' : 'not_found';
      result.method = 'axios';
      // Try to extract a live URL from the HTML
      if (axiosResult.found && axiosResult.html) {
        const $ = cheerio.load(axiosResult.html);
        const hostname = new URL(dir.url).hostname.replace('www.', '');
        const links = $('a[href]').map((_, el) => $(el).attr('href')).get();
        const match = links.find(l => l && l.includes(hostname) && l.includes(normalize(businessName).split(/\s+/)[0]));
        if (match) result.liveUrl = match.startsWith('http') ? match : `https://${hostname}${match}`;
      }
      return result;
    } catch (err) {
      // Axios failed — fall through to Playwright
    }
  }

  // Step 2: Playwright fallback
  if (dir.checkMethod !== 'axios') {
    try {
      const pwResult = await checkWithPlaywright(searchUrl, businessName);
      result.status = pwResult.found ? 'listed' : 'not_found';
      result.method = 'playwright';
      return result;
    } catch (err) {
      result.status = 'error';
      result.method = 'playwright';
      return result;
    }
  }

  return result;
}

module.exports = { checkDirectory, buildSearchUrl, normalize, htmlContainsBusiness };
```

**Step 3: Verify it runs**

```bash
node -e "const c = require('./lib/checker'); console.log(c.normalize('Miller Kory Rowe LLP'));"
```

Expected output: `miller kory rowe`

**Step 4: Commit**

```bash
git add lib/
git commit -m "feat: add hybrid Axios/Playwright check engine with shared browser"
```

---

### Task 3: Refactor server.js with new endpoints

**Files:**
- Modify: `server.js` (complete rewrite)

**Step 1: Install multer for CSV uploads**

```bash
npm install multer uuid
```

**Step 2: Rewrite server.js**

Replace entire file. New server loads directories from JSON, uses the hybrid checker, adds all API endpoints:

- `POST /api/scan` — SSE stream scan (hybrid engine, batches of 10)
- `GET /api/directories` — List all active directories with categories
- `POST /api/directories` — Add a new directory
- `PATCH /api/directories/:id` — Toggle active/inactive
- `POST /api/import-csv` — Upload ClickUp CSV, parse and return client list
- `GET /api/clients` — List saved clients
- `POST /api/clients` — Save a client profile
- `DELETE /api/clients/:id` — Delete a client
- `GET /api/clients/:id/history` — Get scan history
- `POST /api/clients/:id/scan` — Scan a saved client (SSE stream)
- `GET /api/export/:scanId` — Export scan results as CSV

Key changes from current server.js:
- Directories loaded from `data/directories.json` instead of hardcoded
- Check engine uses `lib/checker.js` instead of Google search proxy
- Batch size increased to 10 (from 5)
- Client CRUD with JSON file storage
- CSV import with multer
- Scan history saved per client

**Step 3: Verify server starts**

```bash
npm install && node server.js
```

Expected: `Citation Scanner running on port 3000`

**Step 4: Commit**

```bash
git add server.js package.json package-lock.json
git commit -m "feat: refactor server with hybrid check engine, client management, CSV import"
```

---

### Task 4: Build the frontend with Tailwind + Framer Motion

**Files:**
- Modify: `public/index.html` (complete rewrite)

**Step 1: Use /frontend-design skill**

Invoke the `frontend-design` skill to build the complete single-page application with:

**Design requirements:**
- Tailwind CSS via CDN (`<script src="https://cdn.tailwindcss.com">`)
- Framer Motion via CDN (`<script src="https://unpkg.com/framer-motion@11/dist/framer-motion.js">`) — Note: Framer Motion is React-only, so use `motion.js` (vanilla) or CSS animations with Tailwind's `animate-` classes + custom keyframes instead
- Dark theme: bg-gray-950/bg-gray-900 cards, indigo-500 accent
- Glassmorphism: `backdrop-blur-xl bg-white/5 border border-white/10`

**Layout:**
- Top nav: "Opus Scanner" logo + nav tabs (Scan, Clients, Import, Directories)
- Active tab content below

**Scan View (default tab):**
- Hero card with inputs: business name, location
- Category filter chips (toggleable, indigo when active)
- Big "Scan Directories" button with gradient
- During scan: animated progress ring (SVG circle), live counter
- Results: summary cards (Listed/Missing/Error) with count-up animation
- Filter tabs: All | Listed | Missing
- Results grid: each item is a card with status dot, directory name, category, action link
- Staggered fade-in animation on results (CSS `animation-delay` based on index)
- Export CSV button in results header

**Clients View:**
- "Add Client" button opens a modal/slide-out form
- Client cards in a grid: name, location, website, last scanned date
- "Scan" button on each card → runs scan, shows results inline
- "History" link → shows past scans with timestamps

**CSV Import View:**
- Drag-and-drop zone with dashed border
- After upload: table preview of detected clients
- "Scan All" button to batch scan
- Progress indicator per client

**Directory Manager View:**
- Searchable/filterable list of all directories
- Toggle switch to enable/disable each directory
- "Add Directory" button with form
- Category badges on each entry
- Directory count in header

**Step 2: Verify in browser**

Open `http://localhost:3000` and check:
- All 4 tabs render
- Scan form submits and streams results
- Category chips toggle
- Results animate in
- Filter tabs work
- Mobile responsive (check at 375px width)

**Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: redesign frontend with Tailwind CSS, glassmorphism, animations"
```

---

### Task 5: Install Playwright browsers and test end-to-end

**Step 1: Install Playwright browsers**

```bash
npx playwright install chromium
```

**Step 2: Run the server and test a real scan**

```bash
node server.js
```

Open browser to `http://localhost:3000`. Enter "Miller Kory Rowe" with location "Phoenix, AZ". Select "Legal" category. Hit scan. Verify:
- Results stream in real-time
- Some directories return "listed" (the firm exists on Avvo, Justia, FindLaw, etc.)
- Axios handles most checks quickly
- Playwright kicks in for any failures (check server console logs)
- No crashes or hanging requests

**Step 3: Test CSV import**

Use the ClickUp CSV file provided by the user. Upload it. Verify:
- Clients are detected and listed
- Can scan individual clients from the import

**Step 4: Test client save + rescan**

Save "Miller Kory Rowe" as a client profile. Verify:
- Appears in Clients tab
- One-click rescan works
- History shows past scan

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: end-to-end testing fixes"
```

---

### Task 6: Push to remote

**Step 1: Push all commits**

```bash
git push origin main
```

If push fails, inform user to push manually or set up remote.

---

## Task Summary

| Task | What | Time Est |
|------|------|----------|
| 1 | directories.json with 100+ entries | Data entry |
| 2 | Hybrid check engine (lib/checker.js, lib/browser.js) | Core logic |
| 3 | Server refactor with all API endpoints | Backend |
| 4 | Frontend redesign with Tailwind + animations | UI (use /frontend-design) |
| 5 | Install browsers, end-to-end testing | QA |
| 6 | Push to remote | Deploy |
