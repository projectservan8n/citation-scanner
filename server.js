const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─── Directory List ───────────────────────────────────────────────
const DIRECTORIES = [
  // General - High Priority
  { name: 'Google Business Profile', url: 'https://www.google.com/maps/search/', searchUrl: (b, l) => `https://www.google.com/maps/search/${encodeURIComponent(b + ' ' + l)}`, category: 'General' },
  { name: 'Yelp', url: 'https://www.yelp.com', searchUrl: (b, l) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(b)}&find_loc=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'Yellow Pages', url: 'https://www.yellowpages.com', searchUrl: (b, l) => `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(b)}&geo_location_terms=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'Bing Places', url: 'https://www.bingplaces.com', searchUrl: (b, l) => `https://www.bing.com/maps?q=${encodeURIComponent(b + ' ' + l)}`, category: 'General' },
  { name: 'Better Business Bureau', url: 'https://www.bbb.org', searchUrl: (b, l) => `https://www.bbb.org/search?find_country=USA&find_text=${encodeURIComponent(b)}&find_loc=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'Manta', url: 'https://www.manta.com', searchUrl: (b, l) => `https://www.manta.com/search?search=${encodeURIComponent(b)}&location=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'Hotfrog', url: 'https://www.hotfrog.com', searchUrl: (b, l) => `https://www.hotfrog.com/search/${encodeURIComponent(l)}/${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Foursquare', url: 'https://foursquare.com', searchUrl: (b, l) => `https://foursquare.com/v/${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Superpages', url: 'https://www.superpages.com', searchUrl: (b, l) => `https://www.superpages.com/search?search_terms=${encodeURIComponent(b)}&geo_location_terms=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'ChamberOfCommerce.com', url: 'https://www.chamberofcommerce.com', searchUrl: (b, l) => `https://www.chamberofcommerce.com/search?q=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Nextdoor', url: 'https://nextdoor.com', searchUrl: (b, l) => `https://nextdoor.com/search/?q=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Alignable', url: 'https://www.alignable.com', searchUrl: (b, l) => `https://www.alignable.com/search?q=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'MerchantCircle', url: 'https://www.merchantcircle.com', searchUrl: (b, l) => `https://www.merchantcircle.com/search?q=${encodeURIComponent(b)}&l=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'ShowMeLocal', url: 'https://www.showmelocal.com', searchUrl: (b, l) => `https://www.showmelocal.com/search.aspx?q=${encodeURIComponent(b)}&l=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'Whitepages', url: 'https://www.whitepages.com', searchUrl: (b, l) => `https://www.whitepages.com/business/search?search[name]=${encodeURIComponent(b)}&search[where]=${encodeURIComponent(l)}`, category: 'General' },
  { name: 'Thumbtack', url: 'https://www.thumbtack.com', searchUrl: (b, l) => `https://www.thumbtack.com/search/?q=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Angi', url: 'https://www.angi.com', searchUrl: (b, l) => `https://www.angi.com/companylist/search.htm?keyword=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'D&B Hoovers', url: 'https://www.dnb.com', searchUrl: (b, l) => `https://www.dnb.com/business-directory/company-profiles.${encodeURIComponent(b.replace(/\s+/g,'_').toLowerCase())}.html`, category: 'General' },
  { name: 'Clutch', url: 'https://clutch.co', searchUrl: (b, l) => `https://clutch.co/profile/${encodeURIComponent(b.replace(/\s+/g,'-').toLowerCase())}`, category: 'General' },
  { name: 'Trustpilot', url: 'https://www.trustpilot.com', searchUrl: (b, l) => `https://www.trustpilot.com/search?query=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Birdeye', url: 'https://reviews.birdeye.com', searchUrl: (b, l) => `https://reviews.birdeye.com/search?q=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'ProvenExpert', url: 'https://www.provenexpert.com', searchUrl: (b, l) => `https://www.provenexpert.com/en-us/search/?q=${encodeURIComponent(b)}`, category: 'General' },
  { name: 'Patch', url: 'https://patch.com', searchUrl: (b, l) => `https://patch.com/search?q=${encodeURIComponent(b)}`, category: 'General' },
  // Legal
  { name: 'Avvo', url: 'https://www.avvo.com', searchUrl: (b, l) => `https://www.avvo.com/search#q=${encodeURIComponent(b)}&type=lawyer`, category: 'Legal' },
  { name: 'FindLaw', url: 'https://www.findlaw.com', searchUrl: (b, l) => `https://lawyers.findlaw.com/lawyer/firm/${encodeURIComponent(b.replace(/\s+/g,'-').toLowerCase())}`, category: 'Legal' },
  { name: 'Justia', url: 'https://www.justia.com', searchUrl: (b, l) => `https://lawyers.justia.com/search?q=${encodeURIComponent(b)}&location=${encodeURIComponent(l)}`, category: 'Legal' },
  { name: 'Martindale', url: 'https://www.martindale.com', searchUrl: (b, l) => `https://www.martindale.com/search/#q=${encodeURIComponent(b)}&p=1`, category: 'Legal' },
  { name: 'Lawyers.com', url: 'https://www.lawyers.com', searchUrl: (b, l) => `https://www.lawyers.com/find-a-lawyer/`, category: 'Legal' },
  { name: 'LegalZoom Directory', url: 'https://www.legalzoom.com', searchUrl: (b, l) => `https://www.legalzoom.com/attorney-directory/search?q=${encodeURIComponent(b)}`, category: 'Legal' },
  { name: 'Super Lawyers', url: 'https://www.superlawyers.com', searchUrl: (b, l) => `https://www.superlawyers.com/all/search.html?query=${encodeURIComponent(b)}`, category: 'Legal' },
  { name: 'HG.org', url: 'https://www.hg.org', searchUrl: (b, l) => `https://www.hg.org/find-lawyers.html?q=${encodeURIComponent(b)}`, category: 'Legal' },
  { name: 'LawyerLegion', url: 'https://www.lawyerlegion.com', searchUrl: (b, l) => `https://www.lawyerlegion.com/search/?q=${encodeURIComponent(b)}`, category: 'Legal' },
  { name: 'Yelp Legal', url: 'https://www.yelp.com', searchUrl: (b, l) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(b)}&find_loc=${encodeURIComponent(l)}&cflt=lawyers`, category: 'Legal' },
  // Medical
  { name: 'WebMD Physician Directory', url: 'https://doctor.webmd.com', searchUrl: (b, l) => `https://doctor.webmd.com/doctor/search?q=${encodeURIComponent(b)}`, category: 'Medical' },
  { name: 'Healthgrades', url: 'https://www.healthgrades.com', searchUrl: (b, l) => `https://www.healthgrades.com/find-a-doctor?what=${encodeURIComponent(b)}&where=${encodeURIComponent(l)}`, category: 'Medical' },
  { name: 'Vitals', url: 'https://www.vitals.com', searchUrl: (b, l) => `https://www.vitals.com/doctors/search?q=${encodeURIComponent(b)}`, category: 'Medical' },
  { name: 'Zocdoc', url: 'https://www.zocdoc.com', searchUrl: (b, l) => `https://www.zocdoc.com/search?q=${encodeURIComponent(b)}`, category: 'Medical' },
  { name: 'RateMDs', url: 'https://www.ratemds.com', searchUrl: (b, l) => `https://www.ratemds.com/doctor-ratings/?q=${encodeURIComponent(b)}&loc=${encodeURIComponent(l)}`, category: 'Medical' },
  { name: 'Doximity', url: 'https://www.doximity.com', searchUrl: (b, l) => `https://www.doximity.com/pub/${encodeURIComponent(b.replace(/\s+/g,'-').toLowerCase())}`, category: 'Medical' },
  // Wedding/Venue
  { name: 'The Knot', url: 'https://www.theknot.com', searchUrl: (b, l) => `https://www.theknot.com/marketplace/search?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
  { name: 'WeddingWire', url: 'https://www.weddingwire.com', searchUrl: (b, l) => `https://www.weddingwire.com/search?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
  { name: 'Zola', url: 'https://www.zola.com', searchUrl: (b, l) => `https://www.zola.com/wedding-vendors/search?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
  { name: 'PartySlate', url: 'https://www.partyslate.com', searchUrl: (b, l) => `https://www.partyslate.com/venues?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
  { name: 'Peerspace', url: 'https://www.peerspace.com', searchUrl: (b, l) => `https://www.peerspace.com/s?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
  { name: 'Eventective', url: 'https://www.eventective.com', searchUrl: (b, l) => `https://www.eventective.com/search?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
  { name: 'Cvent', url: 'https://www.cvent.com', searchUrl: (b, l) => `https://www.cvent.com/rfp/venue-search.aspx?q=${encodeURIComponent(b)}`, category: 'Wedding/Venue' },
];

// ─── Check function (Google search proxy) ─────────────────────────
async function checkDirectory(dir, businessName, location) {
  try {
    // Search Google for the business on this specific directory
    const searchQuery = `site:${new URL(dir.url).hostname} "${businessName}"`;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    
    const response = await axios.get(googleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 8000,
    });

    const html = response.data;
    const hostname = new URL(dir.url).hostname.replace('www.', '');
    
    // Check if results exist from this domain
    const hasResult = html.includes(hostname) && 
      (html.toLowerCase().includes(businessName.toLowerCase().split(' ')[0]) ||
       html.includes('cite'));
    
    const listed = hasResult && !html.includes('did not match any documents');

    // Try to extract the live URL from results
    const urlMatch = html.match(new RegExp(`https?://[^"\\s]*${hostname.replace('.', '\\.')}[^"\\s]*`, 'i'));
    const liveUrl = urlMatch ? urlMatch[0].split('"')[0] : null;

    return {
      name: dir.name,
      url: dir.url,
      searchUrl: dir.searchUrl(businessName, location),
      category: dir.category,
      status: listed ? 'listed' : 'not_found',
      liveUrl: liveUrl || null,
    };
  } catch (err) {
    return {
      name: dir.name,
      url: dir.url,
      searchUrl: dir.searchUrl(businessName, location),
      category: dir.category,
      status: 'error',
      liveUrl: null,
    };
  }
}

// ─── API Routes ───────────────────────────────────────────────────
app.post('/api/scan', async (req, res) => {
  const { businessName, location, categories } = req.body;
  
  if (!businessName || !location) {
    return res.status(400).json({ error: 'businessName and location are required' });
  }

  // Filter by category if specified
  const dirs = categories && categories.length > 0
    ? DIRECTORIES.filter(d => categories.includes(d.category))
    : DIRECTORIES;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const results = [];
  
  res.write(`data: ${JSON.stringify({ type: 'start', total: dirs.length })}\n\n`);

  // Process in batches of 5 to avoid rate limiting
  const BATCH = 5;
  for (let i = 0; i < dirs.length; i += BATCH) {
    const batch = dirs.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(dir => checkDirectory(dir, businessName, location))
    );
    
    batchResults.forEach(result => {
      results.push(result);
      res.write(`data: ${JSON.stringify({ type: 'result', result })}\n\n`);
    });

    // Small delay between batches
    if (i + BATCH < dirs.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const summary = {
    listed: results.filter(r => r.status === 'listed').length,
    not_found: results.filter(r => r.status === 'not_found').length,
    error: results.filter(r => r.status === 'error').length,
    total: results.length,
  };

  res.write(`data: ${JSON.stringify({ type: 'done', summary, results })}\n\n`);
  res.end();
});

app.get('/api/directories', (req, res) => {
  const categories = [...new Set(DIRECTORIES.map(d => d.category))];
  res.json({ directories: DIRECTORIES.length, categories });
});

app.listen(PORT, () => {
  console.log(`Citation Scanner running on port ${PORT}`);
});
