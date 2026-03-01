const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { checkDirectory } = require('./lib/checker');
const { closeBrowser } = require('./lib/browser');

// ---------------------------------------------------------------------------
// Data paths
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const SCANS_DIR = path.join(DATA_DIR, 'scans');
const DIRECTORIES_PATH = path.join(DATA_DIR, 'directories.json');
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');

// Ensure data/scans directory exists
if (!fs.existsSync(SCANS_DIR)) {
  fs.mkdirSync(SCANS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// In-memory data stores (loaded from JSON at startup, written back on changes)
// ---------------------------------------------------------------------------
let directories = [];
let clients = [];

function loadDirectories() {
  try {
    const raw = fs.readFileSync(DIRECTORIES_PATH, 'utf-8');
    directories = JSON.parse(raw);
  } catch {
    directories = [];
    fs.writeFileSync(DIRECTORIES_PATH, JSON.stringify(directories, null, 2));
  }
}

function saveDirectories() {
  fs.writeFileSync(DIRECTORIES_PATH, JSON.stringify(directories, null, 2));
}

function loadClients() {
  try {
    const raw = fs.readFileSync(CLIENTS_PATH, 'utf-8');
    clients = JSON.parse(raw);
  } catch {
    clients = [];
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify(clients, null, 2));
  }
}

function saveClients() {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(clients, null, 2));
}

loadDirectories();
loadClients();

// ---------------------------------------------------------------------------
// Multer setup (memory storage — no temp files on disk)
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a name to a URL-friendly kebab-case id.
 * "Google Business Profile" -> "google-business-profile"
 */
function toKebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a CSV string, correctly handling quoted fields that may contain
 * commas and newlines.  Returns an array of arrays (rows x columns).
 */
function parseCsv(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  let row = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Peek ahead: doubled quote means escaped literal quote
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current.trim());
        current = '';
      } else if (ch === '\n' || ch === '\r') {
        // Handle \r\n
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i++;
        }
        row.push(current.trim());
        if (row.length > 0 && row.some((cell) => cell !== '')) {
          rows.push(row);
        }
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }
  }

  // Final row (if file doesn't end with newline)
  row.push(current.trim());
  if (row.length > 0 && row.some((cell) => cell !== '')) {
    rows.push(row);
  }

  return rows;
}

/**
 * Run the scan logic against a set of directories for a given business.
 * Streams SSE events through `res`.
 * Optionally saves results to a file if `saveAs` path is provided.
 */
async function runScan(res, { businessName, location, website, categories, saveAs }) {
  // Filter directories
  let dirs = directories.filter((d) => d.active);
  if (categories && categories.length > 0) {
    dirs = dirs.filter((d) => categories.includes(d.category));
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send start event
  res.write(`data: ${JSON.stringify({ type: 'start', total: dirs.length })}\n\n`);

  const results = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < dirs.length; i += BATCH_SIZE) {
    const batch = dirs.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map((dir) => checkDirectory(dir, businessName, location))
    );

    for (const result of batchResults) {
      results.push(result);
      res.write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
    }

    // Small delay between batches to avoid overwhelming targets
    if (i + BATCH_SIZE < dirs.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Build summary
  const summary = {
    listed: results.filter((r) => r.status === 'listed').length,
    not_found: results.filter((r) => r.status === 'not_found').length,
    error: results.filter((r) => r.status === 'error').length,
    total: results.length,
  };

  // Save results if a path was provided
  if (saveAs) {
    const scanData = {
      id: path.basename(saveAs, '.json'),
      businessName,
      location,
      website: website || '',
      scannedAt: new Date().toISOString(),
      summary,
      results,
    };
    fs.writeFileSync(saveAs, JSON.stringify(scanData, null, 2));
  }

  // Send done event
  res.write(`data: ${JSON.stringify({ type: 'done', summary, results })}\n\n`);
  res.end();
}

// ---------------------------------------------------------------------------
// 1. POST /api/scan — SSE stream scan (ad-hoc, not tied to a saved client)
// ---------------------------------------------------------------------------
app.post('/api/scan', async (req, res) => {
  const { businessName, location, categories, website } = req.body;

  if (!businessName || !location) {
    return res.status(400).json({ error: 'businessName and location are required' });
  }

  await runScan(res, { businessName, location, website, categories });
});

// ---------------------------------------------------------------------------
// 2. GET /api/directories — List directories
// ---------------------------------------------------------------------------
app.get('/api/directories', (req, res) => {
  const showAll = req.query.all === 'true';
  const filtered = showAll ? directories : directories.filter((d) => d.active);
  const categories = [...new Set(directories.map((d) => d.category))];

  res.json({ directories: filtered, categories });
});

// ---------------------------------------------------------------------------
// 3. POST /api/directories — Add a new directory
// ---------------------------------------------------------------------------
app.post('/api/directories', (req, res) => {
  const { name, url, searchUrlTemplate, category, checkMethod } = req.body;

  if (!name || !url || !searchUrlTemplate || !category) {
    return res.status(400).json({ error: 'name, url, searchUrlTemplate, and category are required' });
  }

  const id = toKebabCase(name);

  // Prevent duplicate ids
  if (directories.find((d) => d.id === id)) {
    return res.status(409).json({ error: `Directory with id "${id}" already exists` });
  }

  const newDir = {
    id,
    name,
    url,
    searchUrlTemplate,
    category,
    checkMethod: checkMethod || 'hybrid',
    active: true,
  };

  directories.push(newDir);
  saveDirectories();

  res.status(201).json(newDir);
});

// ---------------------------------------------------------------------------
// 4. PATCH /api/directories/:id — Update a directory
// ---------------------------------------------------------------------------
app.patch('/api/directories/:id', (req, res) => {
  const idx = directories.findIndex((d) => d.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Directory not found' });
  }

  const allowedFields = ['name', 'url', 'searchUrlTemplate', 'category', 'checkMethod', 'active'];
  const updates = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  directories[idx] = { ...directories[idx], ...updates };
  saveDirectories();

  res.json(directories[idx]);
});

// ---------------------------------------------------------------------------
// 5. POST /api/import-csv — Upload and parse a ClickUp CSV
// ---------------------------------------------------------------------------
app.post('/api/import-csv', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  }

  const csvText = req.file.buffer.toString('utf-8');
  const rows = parseCsv(csvText);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'CSV file is empty or could not be parsed' });
  }

  // Build header index map (case-insensitive)
  const headerRow = rows[0];
  const headers = {};
  headerRow.forEach((h, i) => {
    headers[h.toLowerCase().trim()] = i;
  });

  const dataRows = rows.slice(1);

  // Column indices (try common ClickUp column names)
  const taskNameIdx = headers['task name'] ?? headers['name'] ?? headers['task'] ?? 0;
  const parentIdIdx = headers['parent id'] ?? headers['parentid'] ?? null;
  const siteTypeIdx = headers['site type'] ?? headers['labels'] ?? headers['tags'] ?? null;
  const drIdx = headers['dr'] ?? headers['domain rating'] ?? null;
  const trafficIdx = headers['traffic'] ?? headers['organic traffic'] ?? null;
  const domainUrlIdx = headers['domain url'] ?? headers['url'] ?? headers['domain'] ?? null;

  // Separate parent rows (no Parent ID) and child rows (have Parent ID)
  const parentRows = [];
  const childRows = [];

  for (const row of dataRows) {
    const parentId = parentIdIdx !== null && row[parentIdIdx] ? row[parentIdIdx].trim() : '';
    if (parentId === '') {
      parentRows.push(row);
    } else {
      childRows.push(row);
    }
  }

  // Extract unique businesses from parent rows
  const businessMap = new Map();

  for (const row of parentRows) {
    const taskName = row[taskNameIdx] ? row[taskNameIdx].trim() : '';
    const domainUrl = domainUrlIdx !== null && row[domainUrlIdx] ? row[domainUrlIdx].trim() : '';
    const siteType = siteTypeIdx !== null && row[siteTypeIdx] ? row[siteTypeIdx].trim() : '';
    const dr = drIdx !== null && row[drIdx] ? row[drIdx].trim() : '';
    const traffic = trafficIdx !== null && row[trafficIdx] ? row[trafficIdx].trim() : '';

    const key = taskName || domainUrl;
    if (!key) continue;

    if (!businessMap.has(key)) {
      businessMap.set(key, {
        name: taskName,
        domainUrl,
        siteType,
        dr,
        traffic,
        clientNames: [],
      });
    }
  }

  // Extract client names from child rows (Task Name where Parent ID exists)
  for (const row of childRows) {
    const clientName = row[taskNameIdx] ? row[taskNameIdx].trim() : '';
    if (clientName) {
      // Try to find which parent this child belongs to by checking parent rows
      // In ClickUp exports, the Parent ID links to a parent task
      // For simplicity, collect all unique client names
      for (const [, business] of businessMap) {
        if (!business.clientNames.includes(clientName)) {
          business.clientNames.push(clientName);
        }
      }
    }
  }

  // If no parent/child distinction worked, fall back to extracting all unique names
  const detectedClients = [];
  const seenNames = new Set();

  // Add client names found from child rows
  for (const [, business] of businessMap) {
    for (const cn of business.clientNames) {
      if (!seenNames.has(cn.toLowerCase())) {
        seenNames.add(cn.toLowerCase());
        detectedClients.push({ name: cn, source: business.name || business.domainUrl });
      }
    }
  }

  // Also add parent row names as potential businesses
  for (const [, business] of businessMap) {
    const name = business.name || business.domainUrl;
    if (name && !seenNames.has(name.toLowerCase())) {
      seenNames.add(name.toLowerCase());
      detectedClients.push({
        name,
        domainUrl: business.domainUrl,
        siteType: business.siteType,
        dr: business.dr,
        traffic: business.traffic,
      });
    }
  }

  res.json({
    clients: detectedClients,
    totalParentRows: parentRows.length,
    totalChildRows: childRows.length,
  });
});

// ---------------------------------------------------------------------------
// 6. GET /api/clients — List saved clients
// ---------------------------------------------------------------------------
app.get('/api/clients', (req, res) => {
  res.json(clients);
});

// ---------------------------------------------------------------------------
// 7. POST /api/clients — Save a new client
// ---------------------------------------------------------------------------
app.post('/api/clients', (req, res) => {
  const { name, location, website, phone, address } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const newClient = {
    id: uuidv4(),
    name,
    location: location || '',
    website: website || '',
    phone: phone || '',
    address: address || '',
    createdAt: new Date().toISOString(),
  };

  clients.push(newClient);
  saveClients();

  res.status(201).json(newClient);
});

// ---------------------------------------------------------------------------
// 8. DELETE /api/clients/:id — Delete a client
// ---------------------------------------------------------------------------
app.delete('/api/clients/:id', (req, res) => {
  const idx = clients.findIndex((c) => c.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Client not found' });
  }

  const removed = clients.splice(idx, 1)[0];
  saveClients();

  res.json({ deleted: removed.id });
});

// ---------------------------------------------------------------------------
// 9. GET /api/clients/:id/history — Get scan history for a client
// ---------------------------------------------------------------------------
app.get('/api/clients/:id/history', (req, res) => {
  const clientId = req.params.id;

  // Verify client exists
  const client = clients.find((c) => c.id === clientId);
  if (!client) {
    return res.status(404).json({ error: 'Client not found' });
  }

  // Read all scan files for this client from data/scans/
  let scanFiles;
  try {
    scanFiles = fs.readdirSync(SCANS_DIR).filter((f) => f.startsWith(clientId) && f.endsWith('.json'));
  } catch {
    scanFiles = [];
  }

  const scans = scanFiles
    .map((filename) => {
      try {
        const raw = fs.readFileSync(path.join(SCANS_DIR, filename), 'utf-8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt));

  res.json(scans);
});

// ---------------------------------------------------------------------------
// 10. POST /api/clients/:id/scan — Scan a saved client (SSE)
// ---------------------------------------------------------------------------
app.post('/api/clients/:id/scan', async (req, res) => {
  const clientId = req.params.id;
  const client = clients.find((c) => c.id === clientId);

  if (!client) {
    return res.status(404).json({ error: 'Client not found' });
  }

  if (!client.name || !client.location) {
    return res.status(400).json({ error: 'Client must have both name and location to scan' });
  }

  const { categories } = req.body || {};

  const timestamp = Date.now();
  const saveAs = path.join(SCANS_DIR, `${clientId}-${timestamp}.json`);

  await runScan(res, {
    businessName: client.name,
    location: client.location,
    website: client.website,
    categories,
    saveAs,
  });
});

// ---------------------------------------------------------------------------
// 11. GET /api/export/:scanId — Export a scan as CSV
// ---------------------------------------------------------------------------
app.get('/api/export/:scanId', (req, res) => {
  const scanId = req.params.scanId;

  // Find the scan file — scanId might be the full filename stem or partial
  let scanFiles;
  try {
    scanFiles = fs.readdirSync(SCANS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return res.status(500).json({ error: 'Could not read scans directory' });
  }

  // Match by scanId (the id field inside the JSON, or the filename stem)
  let scanData = null;
  for (const filename of scanFiles) {
    const stem = filename.replace('.json', '');
    if (stem === scanId || filename === scanId || filename === `${scanId}.json`) {
      try {
        const raw = fs.readFileSync(path.join(SCANS_DIR, filename), 'utf-8');
        scanData = JSON.parse(raw);
        break;
      } catch {
        continue;
      }
    }
  }

  // Also try matching by the id field inside each scan
  if (!scanData) {
    for (const filename of scanFiles) {
      try {
        const raw = fs.readFileSync(path.join(SCANS_DIR, filename), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.id === scanId) {
          scanData = parsed;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!scanData || !scanData.results) {
    return res.status(404).json({ error: 'Scan not found' });
  }

  // Build CSV
  const csvHeader = 'Directory,URL,Category,Status,Method,Live URL';
  const csvRows = scanData.results.map((r) => {
    // Escape fields that might contain commas
    const esc = (val) => {
      const str = (val || '').toString();
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      esc(r.name),
      esc(r.url),
      esc(r.category),
      esc(r.status),
      esc(r.method),
      esc(r.liveUrl || ''),
    ].join(',');
  });

  const csvContent = [csvHeader, ...csvRows].join('\n');

  const exportFilename = `scan-${scanData.businessName || 'export'}-${scanData.scannedAt || Date.now()}.csv`
    .replace(/[^a-zA-Z0-9._-]/g, '_');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename}"`);
  res.send(csvContent);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — close Playwright browser
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  console.log(`\n${signal} received. Closing browser and shutting down...`);
  try {
    await closeBrowser();
  } catch {
    // Browser may not have been opened
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Citation Scanner running on port ${PORT}`);
  console.log(`Loaded ${directories.length} directories across ${[...new Set(directories.map((d) => d.category))].length} categories`);
  console.log(`Loaded ${clients.length} client(s)`);
});
