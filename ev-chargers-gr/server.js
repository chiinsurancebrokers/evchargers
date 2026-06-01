'use strict';

/**
 * EV Chargers GR — backend
 * --------------------------------------------------------------------------
 * Κατεβάζει τα ΔΗΜΟΣΙΑ δεδομένα του Μ.Υ.Φ.Α.Η. (Υπ. Υποδομών & Μεταφορών),
 * τα αποσυμπιέζει, τα κανονικοποιεί και τα σερβίρει ως καθαρό JSON.
 *
 * Πηγή: https://electrokinisi.yme.gov.gr/public/HelpMyfah/PublicData/
 *  - Στατικά  (ημερήσια ενημέρωση)
 *  - Δυναμικά (κατάσταση φορτιστών, ~κάθε 10 λεπτά)
 *
 * Τα δεδομένα ακολουθούν το πρωτόκολλο OCPI 2.2 (αντικείμενα Location/EVSE/Connector).
 */

const path = require('path');
const express = require('express');
const compression = require('compression');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const STATIC_URL =
  process.env.MYFAH_STATIC_URL ||
  'https://electrokinisi.yme.gov.gr/public/static_files/GR.IDRO.static.data.latest.json.zip';
const DYNAMIC_URL =
  process.env.MYFAH_DYNAMIC_URL ||
  'https://electrokinisi.yme.gov.gr/public/static_files/GR.IDRO.dynamic.data.latest.json.zip';

// (Προαιρετικό) Άντληση απευθείας από το OCPI API αντί για τα public zip.
// Ενεργοποιείται ΜΟΝΟ αν οριστούν ΚΑΙ οι δύο μεταβλητές. Χρειάζεται ΠΑΡΑΓΩΓΙΚΟ
// token + endpoint από το Μ.Υ.Φ.Α.Η. — το δοκιμαστικό (dev.e-research.gr) έχει
// μόνο test δεδομένα. Σε αυτή την κατάσταση η απάντηση περιέχει ήδη τις καταστάσεις,
// οπότε δεν χρειάζεται ξεχωριστή δυναμική λήψη.
const API_URL = process.env.MYFAH_API_URL || '';      // π.χ. https://.../ocpi/2.2/locations/
const API_TOKEN = process.env.MYFAH_API_TOKEN || '';  // το Token χωρίς το πρόθεμα "Token "
const USE_API = !!(API_URL && API_TOKEN);

// Συχνότητα ανανέωσης (ms)
const STATIC_REFRESH_MS = 6 * 60 * 60 * 1000;  // 6 ώρες (η πηγή ανανεώνεται ημερησίως)
const DYNAMIC_REFRESH_MS = 10 * 60 * 1000;     // 10 λεπτά

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = {
  chargers: [],
  staticUpdatedAt: null,
  dynamicUpdatedAt: null,
  rawLocations: [],   // κρατάμε τα static locations για επανα-merge με νέα statuses
  error: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function downloadJsonZip(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} για ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (!entries.length) throw new Error(`Κενό zip: ${url}`);
  // Πάρε το πρώτο .json (ή απλώς το πρώτο entry)
  const entry = entries.find((e) => /\.json$/i.test(e.entryName)) || entries[0];
  // Αφαίρεση BOM (\uFEFF) και κενών — συχνή αιτία "Unexpected token at position 0"
  const text = entry.getData().toString('utf8').replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(text);
  } catch (e1) {
    // Fallback: ξεκίνα από τον πρώτο χαρακτήρα δομής JSON (τυχόν σκουπίδια πριν)
    const i = text.search(/[[{]/);
    if (i > 0) {
      try { return JSON.parse(text.slice(i)); } catch (_) { /* συνέχισε στο σφάλμα */ }
    }
    console.error(`[parse] ${entry.entryName} — πρώτοι χαρακτήρες:`, JSON.stringify(text.slice(0, 80)));
    throw new Error(`Μη έγκυρο JSON στο ${entry.entryName}: ${e1.message}`);
  }
}

// (Προαιρετικό) Λήψη locations από το OCPI API με Authorization: Token <...>.
async function downloadJsonApi(url, token) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} για ${url}`);
  return res.json();
}

// Βρίσκει τον πίνακα των Location objects ανεξάρτητα από το τυλιγμα του αρχείου.
function extractArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.locations)) return parsed.locations;
    if (Array.isArray(parsed.results)) return parsed.results;
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
    }
  }
  return [];
}

// Ισχύς ενός connector σε kW.
function connectorPowerKW(c) {
  if (c == null) return null;
  // OCPI 2.2: max_electric_power σε Watt — η πιο αξιόπιστη πηγή.
  if (typeof c.max_electric_power === 'number' && c.max_electric_power > 0) {
    return c.max_electric_power / 1000;
  }
  const v = Number(c.max_voltage);
  const a = Number(c.max_amperage);
  if (v > 0 && a > 0) {
    const pt = String(c.power_type || '').toUpperCase();
    let watts;
    if (pt === 'AC_3_PHASE') {
      // Προσέγγιση 3φασικής ισχύος (3 × τάση φάσης × ένταση). Ενδεικτική —
      // για DC 50/120 χρησιμοποιείται πάντα το αυθεντικό max_electric_power.
      watts = 3 * v * a;
    } else {
      watts = v * a; // DC ή 1φασικό
    }
    return watts / 1000;
  }
  return null;
}

// Κατηγορία ισχύος για ομαδοποίηση/χρωματισμό.
//  'ac'   -> < 50 kW
//  'dc50' -> 50–119 kW
//  'dc120'-> >= 120 kW
function powerTier(kw) {
  if (kw == null) return 'unknown';
  if (kw >= 120) return 'dc120';
  if (kw >= 50) return 'dc50';
  return 'ac';
}

// Χτίζει χάρτη κατάστασης από τα δυναμικά δεδομένα.
function buildStatusIndex(dynParsed) {
  const byEvseId = new Map();
  const byUid = new Map();
  const arr = extractArray(dynParsed);

  const put = (rec) => {
    if (!rec) return;
    const status = rec.status;
    if (!status) return;
    const lu = rec.last_updated || rec.lastUpdated || null;
    if (rec.evse_id) byEvseId.set(String(rec.evse_id), { status, lu });
    const uid = rec.evse_uid || rec.uid;
    if (uid) byUid.set(String(uid), { status, lu });
  };

  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.evses)) {
      // σχήμα ίδιο με location -> διάβασε τα evses
      for (const e of item.evses) {
        put({ evse_id: e.evse_id, evse_uid: e.uid, status: e.status, last_updated: e.last_updated });
      }
    } else {
      // flat εγγραφή κατάστασης
      put(item);
    }
  }
  return { byEvseId, byUid };
}

// Κανονικοποίηση ενός Location -> ελαφρύ αντικείμενο για το frontend.
function normalizeLocation(loc, statusIdx) {
  const coords = loc.coordinates || {};
  const lat = parseFloat(coords.latitude);
  const lng = parseFloat(coords.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return null;

  const connectors = [];
  let maxKW = 0;
  let availableMax = 0; // μέγιστη ισχύς ΔΙΑΘΕΣΙΜΟΥ connector

  for (const evse of loc.evses || []) {
    // εφαρμογή δυναμικής κατάστασης αν υπάρχει
    let status = evse.status || 'UNKNOWN';
    if (statusIdx) {
      const hit =
        (evse.evse_id && statusIdx.byEvseId.get(String(evse.evse_id))) ||
        (evse.uid && statusIdx.byUid.get(String(evse.uid)));
      if (hit && hit.status) status = hit.status;
    }
    for (const c of evse.connectors || []) {
      const kw = connectorPowerKW(c);
      const kwR = kw != null ? Math.round(kw) : null;
      if (kw != null && kw > maxKW) maxKW = kw;
      if (kw != null && status === 'AVAILABLE' && kw > availableMax) availableMax = kw;
      connectors.push({
        kw: kwR,
        standard: c.standard || null,
        format: c.format || null,
        powerType: c.power_type || null,
        status,
      });
    }
  }

  if (!connectors.length) return null;

  const maxKWr = Math.round(maxKW);
  return {
    id: loc.id || loc.location_id || `${lat},${lng}`,
    name: loc.name || null,
    address: loc.address || null,
    city: loc.city || null,
    postalCode: loc.postal_code || null,
    lat,
    lng,
    operator: (loc.operator && loc.operator.name) || (loc.owner && loc.owner.name) || null,
    open247: !!(loc.opening_times && loc.opening_times.twentyfourseven),
    maxKW: maxKWr,
    tier: powerTier(maxKW),
    availableMaxKW: Math.round(availableMax),
    connectors,
  };
}

function rebuild(statusIdx) {
  const out = [];
  for (const loc of cache.rawLocations) {
    const n = normalizeLocation(loc, statusIdx);
    if (n) out.push(n);
  }
  cache.chargers = out;
}

// ---------------------------------------------------------------------------
// Refresh routines
// ---------------------------------------------------------------------------
let lastStatusIdx = null;

async function refreshStatic() {
  try {
    const parsed = USE_API
      ? await downloadJsonApi(API_URL, API_TOKEN)
      : await downloadJsonZip(STATIC_URL);
    const arr = extractArray(parsed);
    cache.rawLocations = arr;
    rebuild(USE_API ? null : lastStatusIdx); // σε API mode οι καταστάσεις είναι ήδη μέσα
    cache.staticUpdatedAt = new Date().toISOString();
    if (USE_API) cache.dynamicUpdatedAt = cache.staticUpdatedAt;
    cache.error = null;
    console.log(`[${USE_API ? 'api' : 'static'}] OK — ${arr.length} locations, ${cache.chargers.length} με συντεταγμένες`);
  } catch (err) {
    cache.error = `${USE_API ? 'api' : 'static'}: ${err.message}`;
    console.error(`[${USE_API ? 'api' : 'static'}] ΣΦΑΛΜΑ:`, err.message);
  }
}

async function refreshDynamic() {
  if (USE_API) return;                  // οι καταστάσεις έρχονται μαζί με το API GET
  if (!cache.rawLocations.length) return; // χρειάζεται πρώτα τα static
  try {
    const parsed = await downloadJsonZip(DYNAMIC_URL);
    lastStatusIdx = buildStatusIndex(parsed);
    rebuild(lastStatusIdx);
    cache.dynamicUpdatedAt = new Date().toISOString();
    console.log(`[dynamic] OK — ενημερώθηκαν καταστάσεις (${lastStatusIdx.byEvseId.size + lastStatusIdx.byUid.size} κλειδιά)`);
  } catch (err) {
    console.error('[dynamic] ΣΦΑΛΜΑ:', err.message);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

// Geocoding / routing: αν υπάρχει LOCATIONIQ_KEY χρησιμοποιείται το LocationIQ,
// αλλιώς fallback στους δημόσιους Nominatim / OSRM. Το κλειδί μένει ΜΟΝΟ στον server.
const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY || '';
const LOCATIONIQ_BASE = process.env.LOCATIONIQ_BASE || 'https://us1.locationiq.com';
const LOCATIONIQ_TILE_BASE = process.env.LOCATIONIQ_TILE_BASE || 'https://tiles.locationiq.com';
const NOMINATIM_BASE = process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org';
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const GEO_UA = 'EV-Chargers-GR/1.0 (+https://github.com/, Railway app)'; // για Nominatim policy

async function doGeocode(q) {
  if (!q) return null;
  const common = `format=json&limit=1&countrycodes=gr&accept-language=el&q=${encodeURIComponent(q)}`;
  let arr;
  if (LOCATIONIQ_KEY) {
    const r = await fetch(`${LOCATIONIQ_BASE}/v1/search?key=${LOCATIONIQ_KEY}&${common}`);
    if (!r.ok) throw new Error(`geocode HTTP ${r.status}`);
    arr = await r.json();
  } else {
    const r = await fetch(`${NOMINATIM_BASE}/search?${common}`, { headers: { 'User-Agent': GEO_UA, Accept: 'application/json' } });
    arr = await r.json();
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), label: arr[0].display_name };
}

// Προτάσεις (autocomplete) — έως 5 υποψήφια μέρη για άρση αμφισημίας.
async function doSuggest(q) {
  if (!q || q.trim().length < 2) return [];
  const common = `format=json&limit=5&dedupe=1&countrycodes=gr&accept-language=el&q=${encodeURIComponent(q)}`;
  let arr;
  if (LOCATIONIQ_KEY) {
    const r = await fetch(`${LOCATIONIQ_BASE}/v1/search?key=${LOCATIONIQ_KEY}&${common}`);
    if (!r.ok) throw new Error(`suggest HTTP ${r.status}`);
    arr = await r.json();
  } else {
    const r = await fetch(`${NOMINATIM_BASE}/search?${common}`, { headers: { 'User-Agent': GEO_UA, Accept: 'application/json' } });
    arr = await r.json();
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((o) => ({ lat: parseFloat(o.lat), lng: parseFloat(o.lon), label: o.display_name }));
}

async function doReverse(lat, lng) {
  let addr = {};
  if (LOCATIONIQ_KEY) {
    const r = await fetch(`${LOCATIONIQ_BASE}/v1/reverse?key=${LOCATIONIQ_KEY}&lat=${lat}&lon=${lng}&format=json&zoom=12&accept-language=el`);
    if (!r.ok) throw new Error(`reverse HTTP ${r.status}`);
    addr = (await r.json()).address || {};
  } else {
    const r = await fetch(`${NOMINATIM_BASE}/reverse?format=json&zoom=12&accept-language=el&lat=${lat}&lon=${lng}`, { headers: { 'User-Agent': GEO_UA, Accept: 'application/json' } });
    addr = ((await r.json()) || {}).address || {};
  }
  const name = addr.city || addr.town || addr.village || addr.municipality || addr.county || addr.state_district || addr.state || null;
  return { name };
}

async function doRoute(from, to) {
  // from/to σε μορφή "lng,lat"
  const path = `driving/${from};${to}`;
  const qs = 'overview=full&geometries=geojson';
  let url;
  if (LOCATIONIQ_KEY) url = `${LOCATIONIQ_BASE}/v1/directions/${path}?key=${LOCATIONIQ_KEY}&${qs}`;
  else url = `${OSRM_BASE}/route/v1/${path}?${qs}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.code !== 'Ok' || !d.routes || !d.routes.length) throw new Error('Δεν βρέθηκε διαδρομή.');
  const rt = d.routes[0];
  return { distance: rt.distance, duration: rt.duration, geometry: rt.geometry };
}

const app = express();
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/api/chargers', (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  res.json({
    staticUpdatedAt: cache.staticUpdatedAt,
    dynamicUpdatedAt: cache.dynamicUpdatedAt,
    count: cache.chargers.length,
    error: cache.error,
    chargers: cache.chargers,
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: cache.chargers.length > 0,
    count: cache.chargers.length,
    staticUpdatedAt: cache.staticUpdatedAt,
    dynamicUpdatedAt: cache.dynamicUpdatedAt,
    error: cache.error,
    aiEnabled: !!ANTHROPIC_API_KEY,
    geoProvider: LOCATIONIQ_KEY ? 'locationiq' : 'osm',
  });
});

// --- Geocoding / routing proxy (το κλειδί μένει στον server) ---
app.get('/api/geocode', async (req, res) => {
  try {
    const out = await doGeocode(String(req.query.q || ''));
    if (!out) return res.status(404).json({ error: 'Δεν βρέθηκε.' });
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/suggest', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=600');
    res.json(await doSuggest(String(req.query.q || '')));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/reverse', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(await doReverse(req.query.lat, req.query.lng));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/route', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=600');
    res.json(await doRoute(String(req.query.from || ''), String(req.query.to || '')));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Proxy για tiles LocationIQ (το κλειδί μένει στον server). Προαιρετικό υπόβαθρο.
const TILE_STYLES = new Set(['streets', 'dark', 'light']);
app.get('/api/tiles/:style/:z/:x/:y', async (req, res) => {
  if (!LOCATIONIQ_KEY) return res.status(503).end();
  const { style, z, x, y } = req.params;
  if (!TILE_STYLES.has(style) || ![z, x, y].every((v) => /^\d{1,3}$/.test(v))) {
    return res.status(400).end();
  }
  try {
    const r = await fetch(`${LOCATIONIQ_TILE_BASE}/v3/${style}/r/${z}/${x}/${y}.png?key=${LOCATIONIQ_KEY}`);
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).end(); }
});

// Δεύτερη γνώμη: στέλνει το πλάνο στο Claude API και επιστρέφει σχόλιο/εναλλακτική.
// Το κλειδί μένει ΜΟΝΟ στον server (ποτέ στο frontend).
app.post('/api/second-opinion', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'Η δεύτερη γνώμη είναι απενεργοποιημένη. Όρισε τη μεταβλητή περιβάλλοντος ANTHROPIC_API_KEY στο Railway.',
    });
  }
  try {
    const t = req.body || {};
    const stopsTxt = (t.stops || [])
      .map((s, i) => `  ${i + 1}. ${s.name} — ${s.kw} kW, στα ${s.alongKm} km, άφιξη ~${s.socArrive}% (παράκαμψη ~${s.detourKm ?? '?'} km)`)
      .join('\n') || '  (καμία στάση — φτάνει χωρίς φόρτιση)';

    const userPrompt =
`Είσαι σύμβουλος ηλεκτροκίνησης. Έλεγξε το παρακάτω σχέδιο φόρτισης για ταξίδι με ηλεκτρικό αυτοκίνητο στην Ελλάδα και δώσε σύντομη «δεύτερη γνώμη» στα ελληνικά.

Διαδρομή: ${t.from} → ${t.to}
Συνολική απόσταση: ${t.routeKm} km, μέση ταχύτητα ~${t.avgSpeed} km/h
Όχημα: ${t.car?.name || 'άγνωστο'} — μπαταρία ${t.car?.batt} kWh, κατανάλωση βάσης ${t.car?.cons} kWh/100km
Εκτιμώμενη κατανάλωση διαδρομής: ${t.consEff} kWh/100km (συντελεστής αυτοκινητόδρομου ×${t.factor})
Αυτονομία (εκτίμηση): ${t.rangeFull} km
Εκκίνηση ${t.startSoc}% · όριο φόρτισης ${t.targetSoc}% · φόρτιση έως ${t.chargeToSoc}%
Απόσταση μέχρι το ${t.targetSoc}%: ${t.firstReachKm} km

Προτεινόμενες στάσεις:
${stopsTxt}

Δώσε: (1) μια γρήγορη κρίση αν το πλάνο είναι ασφαλές/ρεαλιστικό, (2) τυχόν ρίσκα (π.χ. χαμηλό % άφιξης, αργοί φορτιστές, μεγάλο κενό), (3) μία εναλλακτική στρατηγική στάσεων αν υπάρχει καλύτερη. Μέγιστο ~150 λέξεις, καθαρά και πρακτικά, χωρίς εισαγωγικά κλισέ.`;

    const aResp = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!aResp.ok) {
      const detail = await aResp.text();
      return res.status(502).json({ error: `Σφάλμα Claude API (${aResp.status}).`, detail: detail.slice(0, 400) });
    }
    const data = await aResp.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    res.json({ text, model: ANTHROPIC_MODEL });
  } catch (err) {
    res.status(500).json({ error: `Αποτυχία: ${err.message}` });
  }
});

// Σημεία ενδιαφέροντος στη διαδρομή (αρχαιολογικά, φαγητό, διαμονή, δραστηριότητες).
// Το Claude επιστρέφει δομημένο JSON ώστε να εμφανίζεται καθαρά.
app.post('/api/route-pois', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Η λειτουργία είναι ανενεργή. Όρισε ANTHROPIC_API_KEY στο Railway.' });
  }
  try {
    const t = req.body || {};
    const wp = (t.waypoints || []).filter(Boolean).join(', ');
    const prompt =
`Ταξίδι με αυτοκίνητο στην Ελλάδα: ${t.from} → ${t.to} (~${t.routeKm} km).
Η διαδρομή περνά κοντά από: ${wp || '(άγνωστα ενδιάμεσα — βασίσου στη λογική διαδρομή)'}.

Πρότεινε ΥΠΑΡΚΤΑ, αξιόλογα σημεία κοντά σε αυτή τη διαδρομή (όχι πολύ εκτός πορείας), σε 4 κατηγορίες.
Επέστρεψε ΜΟΝΟ έγκυρο JSON (χωρίς markdown, χωρίς σχόλια), αυστηρά στη μορφή:
{"categories":[
 {"key":"culture","title":"Αρχαιολογικοί & πολιτιστικοί χώροι","items":[{"name":"","area":"","note":""}]},
 {"key":"food","title":"Φαγητό & εστιατόρια","items":[]},
 {"key":"stay","title":"Διαμονή","items":[]},
 {"key":"activities","title":"Δραστηριότητες","items":[]}
]}
Κανόνες: 3–5 items ανά κατηγορία· "area" = πόλη/περιοχή κοντά στη διαδρομή· "note" σύντομο (≤14 λέξεις), στα ελληνικά· μόνο πραγματικά, γνωστά μέρη.`;

    const aResp = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!aResp.ok) {
      const detail = await aResp.text();
      return res.status(502).json({ error: `Σφάλμα Claude API (${aResp.status}).`, detail: detail.slice(0, 400) });
    }
    const data = await aResp.json();
    let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* fallback ως raw */ }
    res.json({ categories: parsed && parsed.categories ? parsed.categories : null, raw: parsed ? null : text, model: ANTHROPIC_MODEL });
  } catch (err) {
    res.status(500).json({ error: `Αποτυχία: ${err.message}` });
  }
});

if (require.main === module) {
  app.listen(PORT, HOST, async () => {
    console.log(`EV Chargers GR — http://${HOST}:${PORT}  [πηγή: ${USE_API ? 'OCPI API' : 'public zip'}]`);
    await refreshStatic();
    await refreshDynamic();
    // Σε API mode όλα έρχονται μαζί -> ανανέωση κάθε 10'. Αλλιώς static 6h + dynamic 10'.
    setInterval(refreshStatic, USE_API ? DYNAMIC_REFRESH_MS : STATIC_REFRESH_MS);
    if (!USE_API) setInterval(refreshDynamic, DYNAMIC_REFRESH_MS);
  });
}

// εξαγωγή για δοκιμές
module.exports = {
  connectorPowerKW,
  powerTier,
  extractArray,
  buildStatusIndex,
  normalizeLocation,
};
