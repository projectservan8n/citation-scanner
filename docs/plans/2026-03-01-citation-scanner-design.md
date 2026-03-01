# Citation Scanner — Design Document

## Overview

A citation scanner tool for Opus Automations that checks whether a business is listed across 100+ online directories. Built for SEO link-building teams to quickly audit directory presence for multiple clients.

## Architecture

### Hybrid Check Engine

For each directory, the scanner uses a two-tier approach:

1. **Axios (fast HTTP request, ~0.5s)** — Hit the directory's search URL, check if the business name appears in the HTML response. Handles ~90% of directories.

2. **Playwright (browser fallback, ~3-5s)** — Only triggered when Axios fails (blocked, JS-rendered content, timeout). Uses a single shared browser instance reused across all checks to avoid startup overhead.

```
Axios GET → directory search URL
  ├── Business name found in HTML → LISTED
  ├── No match in HTML → NOT FOUND
  └── Failed / blocked / empty body
        ↓
  Playwright (shared browser) → load page, check rendered content
    ├── Found → LISTED
    └── Not found → NOT FOUND
```

Directories are checked in parallel batches of 10 for speed. Full scan of 100+ directories completes in ~30-60 seconds.

### Directory Storage

Directories stored in a JSON file (`directories.json`) instead of hardcoded in server.js. Each directory entry:

```json
{
  "name": "Yelp",
  "url": "https://www.yelp.com",
  "searchUrlTemplate": "https://www.yelp.com/search?find_desc={{business}}&find_loc={{location}}",
  "category": "General",
  "checkMethod": "axios",
  "selectors": {
    "resultContainer": ".search-results",
    "businessName": ".css-1m051bw"
  }
}
```

- `checkMethod`: "axios" (default), "playwright" (force browser), or "hybrid" (try axios first)
- `selectors`: Optional CSS selectors for Playwright-based checking
- Easy to add new directories by editing JSON — no code changes needed

### Categories

Pulled from the CSV data:
- General / Business Directory
- Legal Directory
- Medical Directory
- Wedding / Venue Directory
- Chamber of Commerce
- Phoenix / AZ Directory
- Boise Directory
- Raleigh Directory
- Scholarship / .edu
- Sponsorship
- Guest Post Opportunities
- Others / Apps

### Client Modes

**1. Quick Scan (default)**
- Input: business name + location
- Output: real-time streaming results via SSE
- No login required

**2. CSV Import**
- Upload ClickUp CSV export
- Auto-detects unique clients (parent tasks with domains)
- Batch scan all clients sequentially
- Export results as CSV

**3. Saved Client Profiles**
- Save client: name, address, phone, location, website
- One-click rescan
- Scan history with timestamps
- Stored in a JSON file (no database needed initially)

### Data Flow

```
Frontend (Tailwind + Framer Motion)
  ↓ POST /api/scan (SSE stream)
Backend (Express)
  ↓ parallel batches of 10
Check Engine (Axios → Playwright fallback)
  ↓ results streamed back
Frontend updates in real-time
```

### API Endpoints

- `POST /api/scan` — Start a scan (SSE stream). Body: `{ businessName, location, categories?, website? }`
- `GET /api/directories` — List all directories with categories
- `POST /api/import-csv` — Upload ClickUp CSV, returns parsed clients
- `GET /api/clients` — List saved client profiles
- `POST /api/clients` — Save a client profile
- `GET /api/clients/:id/history` — Get scan history for a client
- `POST /api/directories` — Add a new directory

### Frontend

**Tech:** Single HTML file with Tailwind CSS (CDN) + Framer Motion (CDN) for animations. No build step needed.

**Design:**
- Dark theme with indigo accent (#6366f1)
- Glassmorphism cards with subtle backdrop blur
- Framer Motion: staggered result animations, progress transitions, tab switches
- Tailwind CSS: utility-first responsive design
- Mobile-friendly responsive layout

**Pages/Views (single page, tabbed):**
1. **Scan View** — Business name + location input, category filters, real-time results grid
2. **Clients View** — Saved client profiles, one-click scan, history
3. **CSV Import View** — Drag-and-drop CSV upload, preview clients, batch scan
4. **Directory Manager** — View all directories, add new ones, toggle active/inactive

**Results Display:**
- Summary cards: Listed / Not Found / Error counts with animated counters
- Circular progress indicator during scan
- Results grid with status dots (green/red/gray)
- Filter tabs: All / Listed / Missing
- Each result shows: directory name, category, status, live URL link
- Export results button (CSV download)

### Tech Stack

- **Runtime:** Node.js
- **Server:** Express.js
- **HTTP Client:** Axios (fast checks)
- **Browser Automation:** Playwright (fallback checks)
- **Frontend:** Vanilla HTML + Tailwind CSS (CDN) + Framer Motion (CDN)
- **Data Storage:** JSON files (directories.json, clients.json)
- **Streaming:** Server-Sent Events (SSE)
- **Deployment:** Railway

### Directory Count Target

Starting with 100+ directories:
- 65 from current codebase
- ~40 unique additions from ClickUp CSV (deduped)
- Expandable via JSON file or directory manager UI
