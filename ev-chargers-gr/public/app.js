'use strict';

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([38.5, 23.8], 7);

const ATTR = ' · Δεδομένα: Μ.Υ.Φ.Α.Η. (ΥΠ.Υ.ΜΕ.)';
const baseDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap, &copy; CARTO' + ATTR, subdomains: 'abcd', maxZoom: 19,
}).addTo(map);
const baseStreets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap' + ATTR, maxZoom: 19,
});
const baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Δορυφ.: Esri, Maxar, Earthstar Geographics' + ATTR, maxZoom: 19,
});
const layersControl = L.control.layers(
  { 'Σκούρο': baseDark, 'Δρόμοι': baseStreets, 'Δορυφόρος': baseSat },
  null,
  { position: 'topright' }
).addTo(map);

// Προαιρετικό υπόβαθρο LocationIQ — προστίθεται μόνο αν το κλειδί είναι ενεργό
// (server-proxied ώστε το κλειδί να μένει κρυφό). Προσοχή: τα tiles μετράνε στο
// ημερήσιο όριο του LocationIQ, γι' αυτό δεν είναι προεπιλογή.
async function initGeoProvider() {
  try {
    const h = await fetch('/api/health').then((x) => x.json());
    if (h && h.geoProvider === 'locationiq') {
      const liq = L.tileLayer('/api/tiles/streets/{z}/{x}/{y}', {
        attribution: '&copy; LocationIQ, OpenStreetMap' + ATTR, maxZoom: 19,
      });
      layersControl.addBaseLayer(liq, 'LocationIQ');
    }
  } catch (e) { /* αγνόησε */ }
}

// ---- Ζωντανή θέση χρήστη (Geolocation API) ----
let posMarker = null, accCircle = null, watchId = null, currentPos = null, firstFix = true;

function onPos(p) {
  const { latitude: lat, longitude: lng, accuracy } = p.coords;
  currentPos = { lat, lng, accuracy };
  if (!posMarker) {
    posMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 2000,
    }).addTo(map).bindTooltip('Η θέση μου');
    accCircle = L.circle([lat, lng], { radius: accuracy, color: '#34d8ff', weight: 1, fillColor: '#34d8ff', fillOpacity: 0.12 }).addTo(map);
  } else {
    posMarker.setLatLng([lat, lng]);
    accCircle.setLatLng([lat, lng]).setRadius(accuracy);
  }
  if (firstFix) { firstFix = false; map.setView([lat, lng], 13); }
  if (nearestPending) { nearestPending = false; showNearest(); }
}
function onPosErr(e) {
  const el = document.getElementById('route-info');
  if (el) { el.textContent = 'Δεν ήταν δυνατός ο εντοπισμός θέσης (έλεγξε τα δικαιώματα).'; el.classList.add('err'); }
}
function startLocate(center) {
  if (!('geolocation' in navigator)) { onPosErr(); return; }
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  } else if (center && currentPos) {
    map.setView([currentPos.lat, currentPos.lng], 14);
  }
}

// Κουμπί «η θέση μου» πάνω στον χάρτη (κάτω δεξιά)
const LocateControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const b = L.DomUtil.create('button', 'locate-ctl');
    b.innerHTML = '◎';
    b.title = 'Η θέση μου';
    L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); startLocate(true); });
    return b;
  },
});
map.addControl(new LocateControl());

const clusters = L.markerClusterGroup({
  maxClusterRadius: 50,
  spiderfyOnMaxZoom: true,
  chunkedLoading: true,
});
map.addLayer(clusters);

const planLayer = L.layerGroup().addTo(map); // markers του σχεδίου φόρτισης
const nearestLayer = L.layerGroup().addTo(map); // highlight κοντινών φορτιστών
const poiLayer = L.layerGroup().addTo(map);     // σημεία ενδιαφέροντος (POIs)

// ---------------------------------------------------------------------------
// Δεδομένα οχημάτων — ΕΝΔΕΙΚΤΙΚΑ, ρυθμιζόμενα.
// batt = ωφέλιμη χωρητικότητα (kWh), cons = πραγματική κατανάλωση (kWh/100km).
// Η αυτονομία εξαρτάται από ταχύτητα, καιρό, φορτίο — οι τιμές είναι εκτιμήσεις.
// ---------------------------------------------------------------------------
const CARS = [
  { n: 'Tesla Model 3 RWD', batt: 57.5, cons: 15 },
  { n: 'Tesla Model 3 Long Range', batt: 75, cons: 16 },
  { n: 'Tesla Model Y RWD', batt: 57.5, cons: 16 },
  { n: 'Tesla Model Y Long Range', batt: 75, cons: 17 },
  { n: 'VW ID.3 Pro', batt: 58, cons: 16.5 },
  { n: 'VW ID.4 Pro', batt: 77, cons: 18 },
  { n: 'Hyundai Kona Electric 64', batt: 64, cons: 16 },
  { n: 'Hyundai Ioniq 5 (77)', batt: 74, cons: 18 },
  { n: 'Kia EV6 (77)', batt: 74, cons: 17.5 },
  { n: 'Kia Niro EV', batt: 64.8, cons: 16 },
  { n: 'Nissan Leaf 40', batt: 39, cons: 17 },
  { n: 'Renault Megane E-Tech', batt: 60, cons: 16 },
  { n: 'Renault Zoe R135', batt: 52, cons: 16 },
  { n: 'Peugeot e-208', batt: 46.3, cons: 15.5 },
  { n: 'Fiat 500e', batt: 37.3, cons: 14.5 },
  { n: 'MG4 64', batt: 61.7, cons: 16.5 },
  { n: 'Cupra Born 58', batt: 58, cons: 16.5 },
  { n: 'BMW i4 eDrive40', batt: 80.7, cons: 17 },
  { n: 'Mercedes EQB 300', batt: 66.5, cons: 19 },
  { n: 'Skoda Enyaq 80', batt: 77, cons: 17.5 },
  { n: 'Polestar 2 Long Range', batt: 78, cons: 17 },
  { n: 'Volvo EX30 Extended', batt: 64, cons: 16 },
  { n: 'BYD Atto 3', batt: 60, cons: 16 },
  { n: 'Audi Q4 e-tron 45', batt: 77, cons: 18 },
  { n: 'Ford Mustang Mach-E ER', batt: 91, cons: 19 },
  { n: 'Dacia Spring', batt: 26.8, cons: 14 },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ALL = [];                 // όλοι οι φορτιστές από το API
let routeLine = null;         // Leaflet polyline
let routeGeoJSON = null;      // turf LineString
let routeTotalKm = 0;         // συνολικό μήκος διαδρομής
const picked = { from: null, to: null }; // επιλεγμένα μέρη από autocomplete {lat,lng,label}
const markerById = new Map(); // id -> marker

const els = {
  dc50: document.getElementById('f-dc50'),
  dc120: document.getElementById('f-dc120'),
  ac: document.getElementById('f-ac'),
  avail: document.getElementById('f-avail'),
  nDc50: document.getElementById('n-dc50'),
  nDc120: document.getElementById('n-dc120'),
  nAc: document.getElementById('n-ac'),
  car: document.getElementById('car'),
  batt: document.getElementById('batt'),
  cons: document.getElementById('cons'),
  autonomy: document.getElementById('autonomy'),
  soc: document.getElementById('soc'),
  socVal: document.getElementById('soc-val'),
  target: document.getElementById('target'),
  targetVal: document.getElementById('target-val'),
  chargeto: document.getElementById('chargeto'),
  chargetoVal: document.getElementById('chargeto-val'),
  from: document.getElementById('from'),
  to: document.getElementById('to'),
  fromSug: document.getElementById('from-sug'),
  toSug: document.getElementById('to-sug'),
  buffer: document.getElementById('buffer'),
  bufferVal: document.getElementById('buffer-val'),
  routeBtn: document.getElementById('route-btn'),
  routeClear: document.getElementById('route-clear'),
  useLoc: document.getElementById('use-loc'),
  nearestBtn: document.getElementById('nearest-btn'),
  locateBtn: document.getElementById('locate-btn'),
  nearest: document.getElementById('nearest'),
  resultsEmpty: document.getElementById('results-empty'),
  poiBtn: document.getElementById('poi-btn'),
  aiBtn: document.getElementById('ai-btn'),
  aiOut: document.getElementById('ai-out'),
  pois: document.getElementById('pois'),
  sheetHandle: document.getElementById('sheet-handle'),
  panel: document.getElementById('panel'),
  routeInfo: document.getElementById('route-info'),
  routeList: document.getElementById('route-list'),
  routeCount: document.getElementById('route-count'),
  plan: document.getElementById('plan'),
  dataStatus: document.getElementById('data-status'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tierEnabled(tier) {
  if (tier === 'dc120') return els.dc120.checked;
  if (tier === 'dc50') return els.dc50.checked;
  return els.ac.checked; // ac + unknown
}

function statusClass(s) {
  return 'st-' + String(s || 'UNKNOWN').toUpperCase().replace(/[^A-Z]/g, '');
}

function isAvailable(c) {
  return c.availableMaxKW > 0;
}

function passesFilters(c) {
  if (!tierEnabled(c.tier)) return false;
  if (els.avail.checked && !isAvailable(c)) return false;
  return true;
}

function makeIcon(c) {
  const cls = ['cm', c.tier === 'unknown' ? 'ac' : c.tier];
  if (els.avail.checked === false && !isAvailable(c)) cls.push('unavail');
  return L.divIcon({
    className: '',
    html: `<div class="${cls.join(' ')}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 16],
    popupAnchor: [0, -16],
  });
}

function popupHtml(c) {
  const conns = c.connectors
    .map((k) => `<div class="pp-row"><span class="k">${k.standard || 'connector'} · ${k.format || ''}</span>` +
      `<span class="v">${k.kw != null ? k.kw + ' kW' : '—'} <span class="pp-st ${statusClass(k.status)}">${k.status}</span></span></div>`)
    .join('');
  return `<div class="pp-title">${c.name || 'Σταθμός φόρτισης'}</div>` +
    `<div class="pp-addr">${[c.address, c.city].filter(Boolean).join(', ') || ''}</div>` +
    `<div class="pp-row"><span class="k">Μέγιστη ισχύς</span><span class="v">${c.maxKW} kW</span></div>` +
    (c.operator ? `<div class="pp-row"><span class="k">Διαχειριστής</span><span class="v">${c.operator}</span></div>` : '') +
    (c.open247 ? `<div class="pp-row"><span class="k">Ωράριο</span><span class="v">24/7</span></div>` : '') +
    conns;
}

// ---------------------------------------------------------------------------
// Render markers
// ---------------------------------------------------------------------------
function render() {
  clusters.clearLayers();
  markerById.clear();
  let counts = { dc120: 0, dc50: 0, ac: 0 };

  const batch = [];
  for (const c of ALL) {
    // μέτρηση ανά κατηγορία (ανεξάρτητα από τα φίλτρα)
    if (c.tier === 'dc120') counts.dc120++;
    else if (c.tier === 'dc50') counts.dc50++;
    else counts.ac++;

    if (!passesFilters(c)) continue;

    const m = L.marker([c.lat, c.lng], { icon: makeIcon(c) });
    m.bindPopup(popupHtml(c), { maxWidth: 300 });
    m._charger = c;
    markerById.set(c.id, m);
    batch.push(m);
  }
  clusters.addLayers(batch);

  els.nDc50.textContent = counts.dc50.toLocaleString('el-GR');
  els.nDc120.textContent = counts.dc120.toLocaleString('el-GR');
  els.nAc.textContent = counts.ac.toLocaleString('el-GR');
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
async function loadData() {
  try {
    const res = await fetch('/api/chargers');
    const data = await res.json();
    ALL = data.chargers || [];
    render();
    const fmt = (iso) => iso ? new Date(iso).toLocaleString('el-GR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    els.dataStatus.innerHTML =
      `<b>${data.count.toLocaleString('el-GR')}</b> σταθμοί · ` +
      `στατικά: ${fmt(data.staticUpdatedAt)} · κατάσταση: ${fmt(data.dynamicUpdatedAt)}`;
    if (data.error) els.dataStatus.innerHTML += ` · <span style="color:var(--down)">${data.error}</span>`;
  } catch (e) {
    els.dataStatus.innerHTML = `<span style="color:var(--down)">Αποτυχία φόρτωσης δεδομένων.</span>`;
  }
}

// ---------------------------------------------------------------------------
// Geocoding + Routing
// ---------------------------------------------------------------------------
async function geocode(q) {
  // Συντεταγμένες "lat, lng" (π.χ. από «η θέση μου») — χωρίς κλήση δικτύου
  const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), label: 'Η θέση μου' };
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Δεν βρέθηκε: «${q}»`);
  return res.json(); // { lat, lng, label }
}

async function osrmRoute(a, b) {
  const res = await fetch(`/api/route?from=${a.lng},${a.lat}&to=${b.lng},${b.lat}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error('Δεν βρέθηκε διαδρομή.');
  return data; // { distance, duration, geometry }
}

function clearRoute() {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  routeGeoJSON = null;
  routeTotalKm = 0;
  routeAvgSpeed = 0;
  routeSpeedFactor = 1;
  lastPlan = null;
  detourCache.clear();
  detourInFlight.clear();
  planLayer.clearLayers();
  poiLayer.clearLayers();
  els.pois.innerHTML = '';
  els.aiOut.innerHTML = '';
  els.aiOut.classList.add('hidden');
  els.plan.classList.add('hidden');
  els.plan.innerHTML = '';
  els.routeInfo.textContent = '';
  els.routeInfo.classList.remove('err');
  els.routeList.innerHTML = '';
  els.routeCount.classList.add('hidden');
  updateAutonomy();
  render();
  refreshEmptyState();
}

async function planRoute() {
  const fromQ = els.from.value.trim();
  const toQ = els.to.value.trim();
  if (!fromQ || !toQ) {
    els.routeInfo.textContent = 'Συμπλήρωσε αφετηρία και προορισμό.';
    els.routeInfo.classList.add('err');
    return;
  }
  els.routeBtn.disabled = true;
  els.routeInfo.classList.remove('err');
  els.routeInfo.textContent = 'Αναζήτηση διαδρομής…';
  try {
    const a = picked.from || (await geocode(fromQ));
    const b = picked.to || (await geocode(toQ));
    const route = await osrmRoute(a, b);

    if (routeLine) map.removeLayer(routeLine);
    routeGeoJSON = route.geometry; // GeoJSON LineString [lng,lat]
    routeLine = L.geoJSON(routeGeoJSON, {
      style: { color: getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || '#ff7a18', weight: 5, opacity: .9 },
    }).addTo(map);
    map.fitBounds(routeLine.getBounds().pad(0.15));

    const km = (route.distance / 1000).toFixed(0);
    routeTotalKm = route.distance / 1000;
    routeAvgSpeed = route.duration > 0 ? routeTotalKm / (route.duration / 3600) : 0;
    routeSpeedFactor = speedFactor(routeAvgSpeed);
    detourCache.clear();
    detourInFlight.clear();
    const min = Math.round(route.duration / 60);
    els.routeInfo.textContent = `Διαδρομή: ${km} km · ~${Math.floor(min / 60)}ω ${min % 60}λ · μ.ο. ${Math.round(routeAvgSpeed)} km/h`;

    updateAutonomy();
    findChargersAlongRoute();
    expandSheetIfMobile();
  } catch (e) {
    els.routeInfo.textContent = e.message || 'Σφάλμα στον σχεδιασμό διαδρομής.';
    els.routeInfo.classList.add('err');
  } finally {
    els.routeBtn.disabled = false;
  }
}

// Βρίσκει τους (φιλτραρισμένους) φορτιστές εντός buffer από τη διαδρομή,
// ταξινομημένους κατά μήκος της.
function findChargersAlongRoute() {
  if (!routeGeoJSON) return;
  const bufferKm = parseInt(els.buffer.value, 10);
  const line = turf.lineString(routeGeoJSON.coordinates);

  const hits = [];
  for (const c of ALL) {
    if (!passesFilters(c)) continue;
    const pt = turf.point([c.lng, c.lat]);
    const d = turf.pointToLineDistance(pt, line, { units: 'kilometers' });
    if (d <= bufferKm) {
      const snapped = turf.nearestPointOnLine(line, pt, { units: 'kilometers' });
      hits.push({ c, dist: d, along: snapped.properties.location });
    }
  }
  hits.sort((x, y) => x.along - y.along);

  // σχέδιο φόρτισης (αν έχει επιλεγεί όχημα)
  renderPlan(line, hits);

  // λίστα
  els.routeCount.textContent = hits.length;
  els.routeCount.classList.remove('hidden');
  if (!hits.length) {
    els.routeList.innerHTML = '<p class="empty">Δεν βρέθηκαν φορτιστές με τα επιλεγμένα κριτήρια κοντά στη διαδρομή. Δοκίμασε μεγαλύτερη απόσταση ή ενεργοποίησε περισσότερες κατηγορίες ισχύος.</p>';
  } else {
    els.routeList.innerHTML = hits.map(({ c, dist }) => {
      const tier = c.tier === 'unknown' ? 'ac' : c.tier;
      return `<div class="rl-item" data-id="${c.id}">` +
        `<span class="rl-kw ${tier}">${c.maxKW} kW</span>` +
        `<span class="rl-body"><span class="rl-name">${c.name || 'Σταθμός φόρτισης'}</span>` +
        `<span class="rl-sub">${[c.city, c.operator].filter(Boolean).join(' · ') || ''}</span></span>` +
        `<span class="rl-dist">${dist.toFixed(1)} km</span></div>`;
    }).join('');
    els.routeList.querySelectorAll('.rl-item').forEach((el) => {
      el.addEventListener('click', () => {
        const c = ALL.find((x) => String(x.id) === el.dataset.id);
        if (!c) return;
        map.setView([c.lat, c.lng], 14);
        const m = markerById.get(c.id);
        if (m) clusters.zoomToShowLayer(m, () => m.openPopup());
      });
    });
  }
  refreshEmptyState();
}

// ---------------------------------------------------------------------------
// Όχημα & σχέδιο φόρτισης
// ---------------------------------------------------------------------------
let routeAvgSpeed = 0;     // km/h (από OSRM)
let routeSpeedFactor = 1;  // πολλαπλασιαστής κατανάλωσης λόγω ταχύτητας
let lastPlan = null;       // για τη «δεύτερη γνώμη»
const detourCache = new Map();   // chargerId -> οδική παράκαμψη (km, μετ' επιστροφής)
const detourInFlight = new Set();

// Προσαύξηση κατανάλωσης με τη μέση ταχύτητα: ~baseline ώς 80 km/h,
// +1%/km/h πάνω από 80, με ανώτατο +45% (τυπικό για αυτοκινητόδρομο).
function speedFactor(avgKmh) {
  if (!avgKmh || !isFinite(avgKmh)) return 1;
  return Math.min(1.45, Math.max(1, 1 + Math.max(0, avgKmh - 80) / 100));
}

function vehicleParams(factor) {
  const f = factor || 1;
  const batt = parseFloat(els.batt.value);
  const cons = parseFloat(els.cons.value);
  if (!(batt > 0) || !(cons > 0)) return null;
  const consEff = cons * f;
  return {
    batt,
    cons,
    consEff,
    factor: f,
    rangeFull: batt / (consEff / 100), // km από 100% σε 0% (με την πραγματική κατανάλωση)
    startSoc: parseInt(els.soc.value, 10),
    targetSoc: parseInt(els.target.value, 10),
    chargeToSoc: parseInt(els.chargeto.value, 10),
  };
}

function updateAutonomy() {
  const v = vehicleParams(routeSpeedFactor);
  if (!v) { els.autonomy.textContent = 'Επίλεξε όχημα για υπολογισμό αυτονομίας.'; return; }
  const toTarget = Math.max(0, (v.startSoc - v.targetSoc) / 100 * v.rangeFull);
  let extra = '';
  if (v.factor > 1.01) extra = ` · αυτοκ/μος ×${v.factor.toFixed(2)} → ${v.consEff.toFixed(1)} kWh/100km`;
  els.autonomy.innerHTML =
    `Αυτονομία 100→0%: <b>${Math.round(v.rangeFull)} km</b> · ` +
    `${v.startSoc}%→${v.targetSoc}%: <b>${Math.round(toTarget)} km</b>${extra}`;
}

// Χτίζει σχέδιο φόρτισης: σε κάθε σκέλος οδηγείς μέχρι να πέσεις στο targetSoc,
// επιλέγει τον πιο μακρινό φορτιστή που προλαβαίνεις (λιγότερες στάσεις),
// φορτίζεις έως chargeToSoc και συνεχίζεις.
function buildPlan(hits, totalKm, v) {
  const stops = [];
  let pos = 0, soc = v.startSoc, guard = 0;
  let firstReachKm = null;
  while (guard++ < 30) {
    const reachKm = pos + (soc - v.targetSoc) / 100 * v.rangeFull;
    if (firstReachKm === null) firstReachKm = reachKm;
    if (reachKm >= totalKm) {
      stops.push({ type: 'arrive', along: totalKm, soc: soc - (totalKm - pos) / v.rangeFull * 100 });
      break;
    }
    const reachable = hits.filter((h) => h.along > pos + 1 && h.along <= reachKm);
    let chosen = reachable.length ? reachable[reachable.length - 1] : null;
    if (!chosen) {
      // μικρή ανοχή ~10% μπαταρίας ώστε να φτάσεις τον επόμενο φορτιστή
      const soft = hits.find((h) => h.along > pos + 1 && h.along <= reachKm + 0.10 * v.rangeFull);
      if (soft) chosen = soft;
      else { stops.push({ type: 'gap', along: reachKm }); break; }
    }
    const socArrive = soc - (chosen.along - pos) / v.rangeFull * 100;
    stops.push({ type: 'charge', hit: chosen, socArrive, socLeave: v.chargeToSoc });
    pos = chosen.along;
    soc = v.chargeToSoc;
  }
  return { stops, firstReachKm };
}

function cssId(id) { return 'det-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_'); }

// Πραγματική οδική παράκαμψη (μετ' επιστροφής) από τη διαδρομή ώς τον φορτιστή.
async function computeDetour(line, stop) {
  const c = stop.hit.c;
  if (detourInFlight.has(c.id) || detourCache.has(c.id)) return;
  detourInFlight.add(c.id);
  try {
    const p = turf.along(line, stop.hit.along, { units: 'kilometers' });
    const snap = { lng: p.geometry.coordinates[0], lat: p.geometry.coordinates[1] };
    const r = await osrmRoute(snap, { lng: c.lng, lat: c.lat });
    const roundtrip = (r.distance / 1000) * 2;
    detourCache.set(c.id, roundtrip);
    const el = document.getElementById(cssId(c.id));
    if (el) el.textContent = `+${roundtrip.toFixed(1)} km οδικά (μετ' επιστροφής)`;
  } catch (e) {
    /* κρατάμε την εκτίμηση ευθείας γραμμής */
  } finally {
    detourInFlight.delete(c.id);
  }
}

function renderPlan(line, hits) {
  planLayer.clearLayers();
  const v = vehicleParams(routeSpeedFactor);
  if (!v || !routeTotalKm) { els.plan.classList.add('hidden'); els.plan.innerHTML = ''; lastPlan = null; return; }

  if (v.startSoc <= v.targetSoc) {
    els.plan.innerHTML = `<p class="headline"><span class="sub" style="color:var(--down)">Η εκκίνηση (${v.startSoc}%) πρέπει να είναι πάνω από το όριο φόρτισης (${v.targetSoc}%).</span></p>`;
    els.plan.classList.remove('hidden');
    lastPlan = null;
    return;
  }

  const { stops, firstReachKm } = buildPlan(hits, routeTotalKm, v);
  const firstIsArrive = stops.length && stops[0].type === 'arrive';

  // marker στο σημείο όπου η μπαταρία φτάνει το target
  if (!firstIsArrive && firstReachKm != null && firstReachKm < routeTotalKm) {
    const p = turf.along(line, firstReachKm, { units: 'kilometers' });
    const [lng, lat] = p.geometry.coordinates;
    L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: `<div class="plan-soc">${v.targetSoc}%</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      zIndexOffset: 900,
    }).bindTooltip(`Εδώ η μπαταρία φτάνει ~${v.targetSoc}% (≈ ${Math.round(firstReachKm)} km)`).addTo(planLayer);
  }

  // αριθμημένοι σταθμοί φόρτισης στον χάρτη
  let n = 0;
  for (const s of stops) {
    if (s.type !== 'charge') continue;
    n++;
    const c = s.hit.c;
    const tier = c.tier === 'unknown' ? 'ac' : c.tier;
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: '', html: `<div class="plan-stop ${tier}">${n}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
      zIndexOffset: 1000,
    }).bindPopup(popupHtml(c)).addTo(planLayer);
  }

  // headline
  const factorNote = v.factor > 1.01
    ? ` · κατανάλωση ${v.consEff.toFixed(1)} kWh/100km (×${v.factor.toFixed(2)} αυτοκ/μος)`
    : '';
  let html = '';
  if (firstIsArrive) {
    html += `<p class="headline"><span class="big">~${Math.round(stops[0].soc)}%</span>` +
      `<span class="sub">εκτιμώμενη μπαταρία στον προορισμό — δεν χρειάζεται φόρτιση ` +
      `(διαδρομή ${Math.round(routeTotalKm)} km · αυτονομία ≈ ${Math.round(v.rangeFull)} km${factorNote})</span></p>`;
  } else {
    html += `<p class="headline"><span class="big">${Math.round(firstReachKm)} km</span>` +
      `<span class="sub">μέχρι η μπαταρία να φτάσει ${v.targetSoc}% · εκκίνηση ${v.startSoc}% · ` +
      `αυτονομία ≈ ${Math.round(v.rangeFull)} km${factorNote}</span></p>`;
  }

  const pending = [];
  html += '<ol>';
  let idx = 0;
  for (const s of stops) {
    if (s.type === 'charge') {
      idx++;
      const c = s.hit.c;
      const tier = c.tier === 'unknown' ? 'ac' : c.tier;
      let detourTxt = '';
      if (detourCache.has(c.id)) {
        detourTxt = `+${detourCache.get(c.id).toFixed(1)} km οδικά (μετ' επιστροφής)`;
      } else if (s.hit.dist >= 0.3) {
        detourTxt = `≈ +${(2 * s.hit.dist).toFixed(1)} km (ευθεία)`;
        pending.push(s);
      }
      html += `<li class="${tier}"><span class="n">${idx}</span>` +
        `<span class="nm">${c.name || 'Σταθμός φόρτισης'}</span> · ${c.maxKW} kW<br>` +
        `<span class="meta">στα ${Math.round(s.hit.along)} km · άφιξη ~${Math.round(s.socArrive)}% ` +
        `<span class="soc-pill">→ φόρτιση ${s.socLeave}%</span>` +
        (detourTxt ? ` · <span class="detour" id="${cssId(c.id)}">${detourTxt}</span>` : '') +
        `</span></li>`;
    } else if (s.type === 'arrive') {
      html += `<li class="arrive"><span class="n">✓</span>` +
        `<span class="nm">Άφιξη στον προορισμό</span><br>` +
        `<span class="meta">~${Math.round(s.soc)}% μπαταρία${idx ? ` · μετά από ${idx} στάση(εις)` : ' · χωρίς φόρτιση'}</span></li>`;
    } else if (s.type === 'gap') {
      html += `<li class="gap"><span class="n">!</span>` +
        `<span class="nm">Κενό κάλυψης ~στο ${Math.round(s.along)}ό km</span><br>` +
        `<span class="meta">Δεν βρέθηκε φορτιστής εντός εμβέλειας με τα τρέχοντα κριτήρια. Αύξησε την «απόσταση από διαδρομή» ή ενεργοποίησε κι άλλη κατηγορία ισχύος.</span></li>`;
    }
  }
  html += '</ol>';
  els.plan.innerHTML = html;
  els.plan.classList.remove('hidden');

  // αποθήκευση πλάνου για τη «δεύτερη γνώμη»
  lastPlan = {
    from: els.from.value.trim(),
    to: els.to.value.trim(),
    car: { name: els.car.options[els.car.selectedIndex] ? els.car.options[els.car.selectedIndex].textContent : 'προσαρμογή', batt: v.batt, cons: v.cons },
    routeKm: Math.round(routeTotalKm),
    avgSpeed: Math.round(routeAvgSpeed),
    factor: +v.factor.toFixed(2),
    consEff: +v.consEff.toFixed(1),
    rangeFull: Math.round(v.rangeFull),
    startSoc: v.startSoc,
    targetSoc: v.targetSoc,
    chargeToSoc: v.chargeToSoc,
    firstReachKm: firstReachKm != null ? Math.round(firstReachKm) : null,
    stops: stops.filter((s) => s.type === 'charge').map((s) => ({
      name: s.hit.c.name || 'Σταθμός φόρτισης',
      kw: s.hit.c.maxKW,
      alongKm: Math.round(s.hit.along),
      socArrive: Math.round(s.socArrive),
      detourKm: detourCache.has(s.hit.c.id) ? +detourCache.get(s.hit.c.id).toFixed(1) : +(2 * s.hit.dist).toFixed(1),
    })),
  };

  // υπολογισμός πραγματικών οδικών παρακάμψεων (ασύγχρονα, με cache)
  pending.forEach((s) => computeDetour(line, s));
}

function populateCars() {
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '— Επίλεξε όχημα —';
  els.car.appendChild(blank);
  CARS.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.n} · ${c.batt} kWh`;
    els.car.appendChild(o);
  });
  const custom = document.createElement('option');
  custom.value = 'custom'; custom.textContent = 'Άλλο (προσαρμογή)';
  els.car.appendChild(custom);
}

function onCarChange() {
  const val = els.car.value;
  if (val !== '' && val !== 'custom') {
    const c = CARS[parseInt(val, 10)];
    els.batt.value = c.batt;
    els.cons.value = c.cons;
  }
  updateAutonomy();
  if (routeGeoJSON) findChargersAlongRoute();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function requestSecondOpinion() {
  const out = els.aiOut;
  const btn = els.aiBtn;
  out.classList.remove('hidden');
  if (!routeGeoJSON) {
    out.innerHTML = '<span class="muted">Σχεδίασε πρώτα μια διαδρομή για να πάρεις δεύτερη γνώμη.</span>';
    refreshEmptyState();
    return;
  }
  if (!lastPlan) {
    out.innerHTML = '<span class="muted">Επίλεξε όχημα (ενότητα «Όχημα &amp; μπαταρία») ώστε να αξιολογηθεί το πλάνο φόρτισης.</span>';
    refreshEmptyState();
    return;
  }
  expandSheetIfMobile();
  out.innerHTML = '<span class="muted">Ρωτάω το Claude…</span>';
  refreshEmptyState();
  btn.disabled = true;
  try {
    const res = await fetch('/api/second-opinion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastPlan),
    });
    const data = await res.json();
    if (!res.ok) {
      out.innerHTML = `<span class="err">${escapeHtml(data.error || 'Σφάλμα.')}</span>`;
    } else {
      out.innerHTML =
        `<div class="ai-head2">🤖 Δεύτερη γνώμη</div>` +
        `<div class="ai-body">${escapeHtml(data.text || '').replace(/\n/g, '<br>')}</div>` +
        `<div class="ai-foot">— ${escapeHtml(data.model || 'Claude')}</div>`;
    }
  } catch (e) {
    out.innerHTML = '<span class="err">Αποτυχία σύνδεσης.</span>';
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Κοντινοί φορτιστές από τη θέση μου
// ---------------------------------------------------------------------------
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function refreshEmptyState() {
  const hasNearest = els.nearest.children.length > 0;
  const hasPois = els.pois.children.length > 0;
  const hasAi = !els.aiOut.classList.contains('hidden') && els.aiOut.innerHTML.trim() !== '';
  const hasPlan = !els.plan.classList.contains('hidden') && els.plan.innerHTML.trim() !== '';
  const hasList = els.routeList.children.length > 0;
  els.resultsEmpty.style.display = (hasNearest || hasPois || hasAi || hasPlan || hasList) ? 'none' : '';
}

let nearestPending = false;

function showNearest() {
  if (!currentPos) {
    startLocate(false);
    nearestPending = true;
    els.nearest.innerHTML = '<div class="ne-info">Εντοπισμός θέσης… επίτρεψε την πρόσβαση (θα εμφανιστούν μόλις βρεθεί η θέση σου).</div>';
    refreshEmptyState();
    return;
  }
  if (!ALL.length) {
    els.nearest.innerHTML = '<div class="ne-info">Τα δεδομένα φορτώνονται ακόμη…</div>';
    refreshEmptyState();
    return;
  }
  const me = currentPos;
  const cand = ALL.filter(passesFilters).map((c) => ({ c, km: haversineKm(me.lat, me.lng, c.lat, c.lng) }));
  cand.sort((a, b) => a.km - b.km);
  const top = cand.slice(0, 6);

  nearestLayer.clearLayers();
  if (!top.length) {
    els.nearest.innerHTML = '<div class="ne-info">Δεν βρέθηκαν φορτιστές με τα επιλεγμένα φίλτρα. Ενεργοποίησε κι άλλη κατηγορία ισχύος ή ξεμαρκάρισε «μόνο διαθέσιμοι».</div>';
    refreshEmptyState();
    return;
  }

  const bounds = L.latLngBounds([[me.lat, me.lng]]);
  top.forEach((t, i) => {
    bounds.extend([t.c.lat, t.c.lng]);
    if (i === 0) nearestLayer.addLayer(L.circleMarker([t.c.lat, t.c.lng], { radius: 15, color: '#2ee6a0', weight: 3, fill: false }));
  });
  map.fitBounds(bounds.pad(0.25));

  els.nearest.innerHTML =
    `<div class="ne-head">Πλησιέστεροι φορτιστές <span class="ne-from">από τη θέση σου</span></div>` +
    top.map((t, i) => {
      const c = t.c;
      const tier = c.tier === 'unknown' ? 'ac' : c.tier;
      const avail = c.availableMaxKW > 0
        ? '<span class="ne-st av">διαθέσιμος</span>'
        : '<span class="ne-st bz">κατειλημμένος/άγνωστο</span>';
      return `<div class="ne-item" data-id="${c.id}">` +
        `<span class="rl-kw ${tier}">${c.maxKW} kW</span>` +
        `<span class="ne-body"><span class="ne-name">${i + 1}. ${c.name || 'Σταθμός φόρτισης'}</span>` +
        `<span class="ne-sub">${[c.city, c.operator].filter(Boolean).join(' · ')} ${avail}</span></span>` +
        `<span class="ne-act"><span class="ne-dist">${t.km.toFixed(1)} km</span>` +
        `<button class="ne-route" data-id="${c.id}" title="Διαδρομή ώς εδώ">→</button></span></div>`;
    }).join('');
  refreshEmptyState();
  expandSheetIfMobile();

  // οδικός χρόνος/απόσταση για τον πλησιέστερο (μία κλήση OSRM)
  const first = top[0].c;
  osrmRoute({ lng: me.lng, lat: me.lat }, { lng: first.lng, lat: first.lat })
    .then((r) => {
      const head = els.nearest.querySelector('.ne-head');
      if (head) head.insertAdjacentHTML('beforeend', ` <span class="ne-eta">· πλησιέστερος ~${(r.distance / 1000).toFixed(1)} km οδικά (${Math.round(r.duration / 60)}′)</span>`);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Σημεία ενδιαφέροντος στη διαδρομή (με Claude)
// ---------------------------------------------------------------------------
const POI_ICON = { culture: '🏛️', food: '🍽️', stay: '🏨', activities: '🥾' };

function isMobile() { return window.matchMedia('(max-width: 760px)').matches; }
function expandSheetIfMobile() {
  if (isMobile()) { els.panel.classList.add('expanded'); setTimeout(() => map.invalidateSize(), 300); }
}

// Δειγματοληψία τοπωνυμίων κατά μήκος της διαδρομής (reverse geocoding, με throttle).
async function sampleWaypoints(line, total) {
  const n = Math.min(6, Math.max(3, Math.round(total / 80)));
  const names = [];
  for (let i = 1; i <= n; i++) {
    const d = (total * i) / (n + 1);
    const p = turf.along(line, d, { units: 'kilometers' });
    const [lng, lat] = p.geometry.coordinates;
    try {
      const r = await fetch(`/api/reverse?lat=${lat}&lng=${lng}`).then((x) => x.json());
      const nm = r && r.name;
      if (nm && !names.includes(nm)) names.push(nm);
    } catch (e) { /* αγνόησε */ }
    await new Promise((rr) => setTimeout(rr, 1100)); // σεβασμός ορίων (Nominatim fallback)
  }
  return names;
}

async function requestPois() {
  if (!routeGeoJSON) {
    els.pois.innerHTML = '<div class="ne-info">Σχεδίασε πρώτα μια διαδρομή, μετά πάτησε ξανά για αξιοθέατα κατά μήκος της.</div>';
    refreshEmptyState();
    return;
  }
  expandSheetIfMobile();
  els.poiBtn.disabled = true;
  els.pois.innerHTML = '<div class="ne-info">Εντοπισμός περιοχών διαδρομής & αναζήτηση με Claude…</div>';
  refreshEmptyState();
  try {
    const line = turf.lineString(routeGeoJSON.coordinates);
    const waypoints = await sampleWaypoints(line, routeTotalKm);
    const res = await fetch('/api/route-pois', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: els.from.value.trim() || 'αφετηρία',
        to: els.to.value.trim() || 'προορισμός',
        routeKm: Math.round(routeTotalKm),
        waypoints,
      }),
    });
    const data = await res.json();
    if (!res.ok) { els.pois.innerHTML = `<div class="ne-info err">${escapeHtml(data.error || 'Σφάλμα.')}</div>`; refreshEmptyState(); return; }
    renderPois(data, waypoints);
  } catch (e) {
    els.pois.innerHTML = '<div class="ne-info err">Αποτυχία σύνδεσης.</div>';
    refreshEmptyState();
  } finally {
    els.poiBtn.disabled = false;
  }
}

function renderPois(data, waypoints) {
  poiLayer.clearLayers();
  if (!data.categories) {
    els.pois.innerHTML = `<div class="ne-info">${escapeHtml(data.raw || 'Δεν βρέθηκαν προτάσεις.')}</div>`;
    refreshEmptyState();
    return;
  }
  let html = `<div class="poi-head">Στη διαδρομή ${waypoints && waypoints.length ? `<span class="ne-from">μέσω ${escapeHtml(waypoints.join(' · '))}</span>` : ''}</div>`;
  for (const cat of data.categories) {
    if (!cat.items || !cat.items.length) continue;
    const icon = POI_ICON[cat.key] || '•';
    html += `<div class="poi-cat"><div class="poi-cat-title">${icon} ${escapeHtml(cat.title || '')}</div>`;
    for (const it of cat.items) {
      const q = (it.name || '') + (it.area ? ', ' + it.area : '');
      html += `<div class="poi-item" data-q="${escapeHtml(q)}">` +
        `<span class="poi-name">${escapeHtml(it.name || '')}</span>` +
        (it.area ? `<span class="poi-area">${escapeHtml(it.area)}</span>` : '') +
        (it.note ? `<span class="poi-note">${escapeHtml(it.note)}</span>` : '') +
        `</div>`;
    }
    html += `</div>`;
  }
  html += `<div class="poi-foot">— προτάσεις από ${escapeHtml(data.model || 'Claude')} · πάτησε ένα σημείο για να το δεις στον χάρτη</div>`;
  els.pois.innerHTML = html;
  refreshEmptyState();
}

// ---------------------------------------------------------------------------
// Autocomplete προτάσεων για Αφετηρία/Προορισμό (άρση αμφισημίας)
// ---------------------------------------------------------------------------
function attachAutocomplete(input, sug, key) {
  let timer = null;
  input.addEventListener('input', () => {
    picked[key] = null; // ο χρήστης πληκτρολογεί -> ακύρωσε προηγούμενη επιλογή
    const q = input.value.trim();
    clearTimeout(timer);
    // μη δείχνεις προτάσεις για συντεταγμένες ή πολύ μικρό κείμενο
    if (q.length < 3 || /^\s*-?\d{1,2}\.\d+\s*,/.test(q)) { sug.classList.remove('open'); sug.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const arr = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`).then((x) => x.json());
        if (!Array.isArray(arr) || !arr.length) { sug.classList.remove('open'); sug.innerHTML = ''; return; }
        sug._items = arr;
        sug.innerHTML = arr.map((o, i) => `<div class="sug-item" data-i="${i}">${escapeHtml(o.label)}</div>`).join('');
        sug.classList.add('open');
      } catch (e) { sug.classList.remove('open'); }
    }, 350);
  });
  sug.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.sug-item');
    if (!it) return;
    e.preventDefault();
    const o = sug._items[parseInt(it.dataset.i, 10)];
    input.value = o.label;
    picked[key] = o;
    sug.classList.remove('open');
    sug.innerHTML = '';
  });
  input.addEventListener('blur', () => setTimeout(() => sug.classList.remove('open'), 150));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
[els.dc50, els.dc120, els.ac, els.avail].forEach((el) =>
  el.addEventListener('change', () => {
    render();
    if (routeGeoJSON) findChargersAlongRoute();
    if (els.nearest.children.length && currentPos) showNearest();
  })
);
els.buffer.addEventListener('input', () => { els.bufferVal.textContent = els.buffer.value; });
els.buffer.addEventListener('change', () => { if (routeGeoJSON) findChargersAlongRoute(); });

// Κοντινοί φορτιστές + θέση
els.nearestBtn.addEventListener('click', showNearest);
els.locateBtn.addEventListener('click', () => startLocate(true));
els.nearest.addEventListener('click', (e) => {
  const routeEl = e.target.closest('.ne-route');
  if (routeEl) {
    e.stopPropagation();
    const c = ALL.find((x) => String(x.id) === routeEl.dataset.id);
    if (!c) return;
    if (!currentPos) { startLocate(false); return; }
    els.from.value = `${currentPos.lat.toFixed(5)}, ${currentPos.lng.toFixed(5)}`;
    els.to.value = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    picked.from = null;
    picked.to = null;
    planRoute();
    return;
  }
  const item = e.target.closest('.ne-item');
  if (item) {
    const c = ALL.find((x) => String(x.id) === item.dataset.id);
    if (!c) return;
    map.setView([c.lat, c.lng], 14);
    const m = markerById.get(c.id);
    if (m) clusters.zoomToShowLayer(m, () => m.openPopup());
  }
});

// Accordion (αναδιπλούμενες ενότητες)
document.querySelectorAll('.acc-head').forEach((h) =>
  h.addEventListener('click', () => h.parentElement.classList.toggle('open'))
);

// Αξιοθέατα στη διαδρομή
els.poiBtn.addEventListener('click', requestPois);
els.pois.addEventListener('click', async (e) => {
  const item = e.target.closest('.poi-item');
  if (!item || !item.dataset.q) return;
  item.classList.add('loading');
  try {
    const g = await geocode(item.dataset.q + ', Ελλάδα');
    const m = L.marker([g.lat, g.lng], {
      icon: L.divIcon({ className: '', html: '<div class="poi-pin">★</div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 1500,
    }).addTo(poiLayer).bindPopup(`<b>${escapeHtml(item.dataset.q)}</b>`);
    map.setView([g.lat, g.lng], 13);
    m.openPopup();
  } catch (err) {
    item.classList.add('poi-err');
  } finally {
    item.classList.remove('loading');
  }
});

// Bottom-sheet (κινητό)
els.sheetHandle.addEventListener('click', () => {
  els.panel.classList.toggle('expanded');
  setTimeout(() => map.invalidateSize(), 300);
});
window.addEventListener('resize', () => map.invalidateSize());

els.car.addEventListener('change', onCarChange);
[els.batt, els.cons].forEach((el) =>
  el.addEventListener('input', () => {
    if (els.car.value !== 'custom') els.car.value = 'custom';
    updateAutonomy();
    if (routeGeoJSON) findChargersAlongRoute();
  })
);
els.soc.addEventListener('input', () => { els.socVal.textContent = els.soc.value; updateAutonomy(); });
els.soc.addEventListener('change', () => { if (routeGeoJSON) findChargersAlongRoute(); });
els.target.addEventListener('input', () => {
  els.targetVal.textContent = els.target.value;
  if (parseInt(els.target.value, 10) >= parseInt(els.chargeto.value, 10)) {
    els.chargeto.value = Math.min(100, parseInt(els.target.value, 10) + 10);
    els.chargetoVal.textContent = els.chargeto.value;
  }
  updateAutonomy();
});
els.target.addEventListener('change', () => { if (routeGeoJSON) findChargersAlongRoute(); });
els.chargeto.addEventListener('input', () => {
  if (parseInt(els.chargeto.value, 10) <= parseInt(els.target.value, 10)) {
    els.chargeto.value = Math.min(100, parseInt(els.target.value, 10) + 10);
  }
  els.chargetoVal.textContent = els.chargeto.value;
});
els.chargeto.addEventListener('change', () => { if (routeGeoJSON) findChargersAlongRoute(); });

els.aiBtn.addEventListener('click', requestSecondOpinion);

els.useLoc.addEventListener('click', () => {
  if (currentPos) {
    els.from.value = `${currentPos.lat.toFixed(5)}, ${currentPos.lng.toFixed(5)}`;
    picked.from = null;
    els.routeInfo.classList.remove('err');
    els.routeInfo.textContent = 'Αφετηρία ορίστηκε στη θέση σου.';
  } else {
    startLocate(false);
    els.routeInfo.classList.remove('err');
    els.routeInfo.textContent = 'Εντοπισμός θέσης… ξαναπάτησε το κουμπί σε λίγα δευτερόλεπτα.';
  }
});

els.routeBtn.addEventListener('click', planRoute);
els.routeClear.addEventListener('click', clearRoute);
[els.from, els.to].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') planRoute(); })
);

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
populateCars();
updateAutonomy();
initGeoProvider();
attachAutocomplete(els.from, els.fromSug, 'from');
attachAutocomplete(els.to, els.toSug, 'to');
loadData();
setInterval(loadData, 5 * 60 * 1000); // ανανέωση κατάστασης κάθε 5'
