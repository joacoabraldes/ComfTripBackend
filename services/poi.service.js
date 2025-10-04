// services/poi.service.js
// Improved POI fetcher that geocodes the trip destination and queries OSM using bbox.
// Also filters DB results by proximity to the geocoded center to avoid returning far-away DB rows.
// New: persists OSM candidates into `locations` to avoid repeated Overpass calls.

"use strict";

/* ---------- env/fetch bootstrap (unchanged) ---------- */
let fetchImpl = null;
let AbortControllerImpl = null;
try { if (typeof globalThis.fetch === "function") fetchImpl = globalThis.fetch; } catch (e) {}
if (!fetchImpl) {
  try {
    const undici = require("undici");
    if (undici && typeof undici.fetch === "function") fetchImpl = undici.fetch.bind(undici);
    if (!AbortControllerImpl && undici && undici.AbortController) AbortControllerImpl = undici.AbortController;
  } catch (e) {}
}
if (!AbortControllerImpl) {
  if (typeof globalThis.AbortController === "function") AbortControllerImpl = globalThis.AbortController;
  else {
    try {
      const ac = require("abort-controller");
      if (ac && ac.AbortController) AbortControllerImpl = ac.AbortController;
    } catch (e) { AbortControllerImpl = null; }
  }
}
if (!fetchImpl) throw new Error("No fetch implementation found. Install node >=18 or `npm install undici`.");

const NOMINATIM_URL = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  if (AbortControllerImpl) {
    const controller = new AbortControllerImpl();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...opts, signal: controller.signal });
      return res;
    } finally { clearTimeout(id); }
  } else {
    return await Promise.race([
      fetchImpl(url, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Fetch timeout")), timeoutMs))
    ]);
  }
}

/* ---------- helpers ---------- */
function haversineMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lat2, lon1, lon2].some(v => v === null || v === undefined || Number.isNaN(v))) return Number.POSITIVE_INFINITY;
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function normalizeDbRow(r) {
  return {
    id: r.id,
    titulo: r.titulo,
    fk_interest: r.fk_interest,
    lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null,
    lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null,
    imagenes: r.imagenes || null,
    relevancia: r.relevancia !== null && r.relevancia !== undefined ? Number(r.relevancia) : 0,
    country: r.country || null,
    source: "db"
  };
}

/* ---------- constants / mappings ---------- */
const OSM_UNWANTED_AMENITIES = new Set([
  "parking","parking_space","bicycle_parking","post_box","bench","waste_basket","recycling","fuel","charging_station",
  "bus_station","taxi","car_rental","bicycle_rental","toilets","public_building","community_centre"
]);

const OSM_UNWANTED_TOURISM = new Set(["hotel","guest_house","motel"]);

// Broader mapping so culture/nature/shops are included
const INTEREST_TO_OSM = {
  gastronomia: ['restaurant','cafe','bar','fast_food','pub'],
  deportes: ['stadium','pitch','sports_centre','fitness_centre','leisure','pitch'],
  cultura: ['museum','gallery','theatre','attraction','arts_centre','viewpoint','memorial','monument'],
  naturaleza: ['park','garden','nature_reserve','wood','water','coastline','forest','wetland'],
  compras: ['mall','supermarket','market','shop'],
  nocturna: ['nightclub','bar','pub'],
  otro: ['tourism','historic','leisure']
};

/* ---------- OSM normalization & scoring helpers ---------- */
function normalizeOsmElement(el) {
  const tags = el.tags || {};
  const amenity = tags.amenity || null;
  const tourism = tags.tourism || null;
  const leisure = tags.leisure || null;

  // filter obvious service-only elements
  if (amenity && OSM_UNWANTED_AMENITIES.has(amenity)) return null;
  if (tourism && OSM_UNWANTED_TOURISM.has(tourism)) return null;

  const name = tags.name || tags['name:en'] || tags.int_name || null;
  const lat = (el.lat !== undefined && el.lat !== null) ? Number(el.lat) : (el.center && el.center.lat ? Number(el.center.lat) : null);
  const lon = (el.lon !== undefined && el.lon !== null) ? Number(el.lon) : (el.center && el.center.lon ? Number(el.center.lon) : null);
  const id = `osm-${el.type}-${el.id}`;
  const titleFallback = amenity || tourism || leisure || tags.historic || 'unnamed';

  return {
    id,
    titulo: name || titleFallback,
    fk_interest: null,
    lat,
    lng: lon,
    imagenes: null,
    relevancia: 5,
    source: 'osm',
    osm: { type: el.type, osm_id: el.id, tags },
    osmTag: amenity || tourism || leisure || null
  };
}

/* merge/dedupe - unchanged logic but preserved */
function dedupeMerge(existing, incoming, distanceThresholdMeters = 50) {
  const merged = existing.slice();
  for (const inc of incoming) {
    let foundIdx = -1;
    for (let i = 0; i < merged.length; i++) {
      const ex = merged[i];
      if (typeof ex.id === 'number' && typeof inc.id === 'number' && ex.id === inc.id) { foundIdx = i; break; }
      if (ex.titulo && inc.titulo && ex.titulo.toLowerCase() === inc.titulo.toLowerCase()) {
        if (ex.lat !== null && inc.lat !== null && isFinite(ex.lat) && isFinite(inc.lat)) {
          const d = haversineMeters(ex.lat, ex.lng, inc.lat, inc.lng);
          if (d <= distanceThresholdMeters) { foundIdx = i; break; }
        } else { foundIdx = i; break; }
      }
      if (ex.lat !== null && inc.lat !== null && isFinite(ex.lat) && isFinite(inc.lat)) {
        const d = haversineMeters(ex.lat, ex.lng, inc.lat, inc.lng);
        if (d < 10) { foundIdx = i; break; }
      }
    }
    if (foundIdx === -1) merged.push(inc);
    else {
      const ex = merged[foundIdx];
      merged[foundIdx] = {
        ...ex,
        titulo: ex.titulo || inc.titulo,
        lat: ex.lat || inc.lat,
        lng: ex.lng || inc.lng,
        imagenes: ex.imagenes || inc.imagenes || null,
        relevancia: Math.max(ex.relevancia || 0, inc.relevancia || 0),
        osm: { ...(ex.osm || {}), ...(inc.osm || {}) },
        source: ex.source === 'db' ? 'db+osm' : inc.source
      };
    }
  }
  return merged;
}

function extractMustVisitsFromNotes(notes) {
  if (!notes || typeof notes !== 'string') return [];
  const found = new Set();
  const quoteRe = /\"([^\"]{3,80})\"|'([^']{3,80})'/g;
  let m;
  while ((m = quoteRe.exec(notes)) !== null) {
    const p = (m[1] || m[2] || '').trim();
    if (p) found.add(p);
  }
  const mustRe = /(?:must visit|want to visit|visit|must-see)\s*[:\-\s]?\s*([^.\n]{3,80})/ig;
  while ((m = mustRe.exec(notes)) !== null) {
    const p = (m[1] || '').split(/[;,\n]/)[0].trim();
    if (p) found.add(p);
  }
  return Array.from(found);
}

/* ---------- nominatim geocode ---------- */
async function geocodeDestination(query) {
  if (!query || !String(query).trim()) return null;
  const q = encodeURIComponent(String(query));
  const url = `${NOMINATIM_URL}?q=${q}&format=json&limit=3&addressdetails=1&polygon_geojson=0`;
  const headers = { 'User-Agent': `itinerary-service/1.0 (${NOMINATIM_EMAIL || 'dev'})`, 'Accept-Language': 'en' };
  if (NOMINATIM_EMAIL) headers['From'] = NOMINATIM_EMAIL;
  try {
    const resp = await fetchWithTimeout(url, { headers }, 15000);
    if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    let pick = data[0];
    for (const cand of data) {
      if (cand.type && ['city','town','village','municipality'].includes(cand.type)) { pick = cand; break; }
    }
    const bbox = (pick.boundingbox || []).map(Number);
    let normBbox = null;
    if (bbox.length === 4) {
      // boundingbox from Nominatim is [south, north, west, east]
      normBbox = [bbox[0], bbox[2], bbox[1], bbox[3]]; // south, west, north, east
    }
    return { lat: Number(pick.lat), lon: Number(pick.lon), bbox: normBbox, display_name: pick.display_name, raw: pick };
  } catch (err) {
    console.warn('geocodeDestination failed:', err?.message || err);
    return null;
  }
}

/* ---------- Overpass bbox query ---------- */
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&'); }

async function queryOverpassByBBox(bbox, extraNameRegexes = [], limit = 200, interestSlugs = []) {
  if (!bbox || bbox.length !== 4) throw new Error('Invalid bbox for Overpass query');
  const [south, west, north, east] = bbox;
  const clauses = [];
  const nameFilter = extraNameRegexes && extraNameRegexes.length
    ? `node["name"~"${extraNameRegexes.join('|')}"](${south},${west},${north},${east});way["name"~"${extraNameRegexes.join('|')}"](${south},${west},${north},${east});`
    : '';

  if (Array.isArray(interestSlugs) && interestSlugs.length) {
    const uniq = new Set(interestSlugs.map(s => String(s).toLowerCase()));
    if (uniq.has('gastronomia')) {
      clauses.push(`node["amenity"~"restaurant|cafe|bar|fast_food|pub"](${south},${west},${north},${east});`);
      clauses.push(`way["amenity"~"restaurant|cafe|bar|fast_food|pub"](${south},${west},${north},${east});`);
    }
    if (uniq.has('deportes')) {
      clauses.push(`node["leisure"~"pitch|sports_centre|stadium|fitness_centre|sports_hall"](${south},${west},${north},${east});`);
      clauses.push(`way["leisure"~"pitch|sports_centre|stadium|fitness_centre|sports_hall"](${south},${west},${north},${east});`);
      clauses.push(`node["tourism"~"stadium|sports_centre"](${south},${west},${north},${east});`);
    }
    // if other interest slugs exist, we still want a broad set
    if (clauses.length === 0) {
      clauses.push(
        `node["tourism"](${south},${west},${north},${east});`,
        `way["tourism"](${south},${west},${north},${east});`,
        `node["amenity"](${south},${west},${north},${east});`,
        `way["amenity"](${south},${west},${north},${east});`
      );
    } else {
      clauses.push(`node["tourism"](${south},${west},${north},${east});`);
      clauses.push(`way["tourism"](${south},${west},${north},${east});`);
    }
  } else {
    clauses.push(
      `node["tourism"](${south},${west},${north},${east});`,
      `way["tourism"](${south},${west},${north},${east});`,
      `node["amenity"](${south},${west},${north},${east});`,
      `way["amenity"](${south},${west},${north},${east});`,
      `node["historic"](${south},${west},${north},${east});`,
      `way["historic"](${south},${west},${north},${east});`,
      `node["leisure"](${south},${west},${north},${east});`,
      `way["leisure"](${south},${west},${north},${east});`
    );
  }

  const q = `[out:json][timeout:25];
(
  ${clauses.join('\n  ')}
  ${nameFilter}
);
out center ${Math.min(limit, 500)};`;

  try {
    const resp = await fetchWithTimeout(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `itinerary-service/1.0 (${NOMINATIM_EMAIL || 'dev'})` },
      body: `data=${encodeURIComponent(q)}`
    }, 30000);
    if (!resp.ok) {
      const t = await resp.text().catch(()=>'');
      throw new Error(`Overpass ${resp.status}: ${t.slice(0,200)}`);
    }
    const body = await resp.json();
    const elements = body.elements || [];
    const normalized = elements.map(normalizeOsmElement).filter(x => x && x.titulo && x.lat !== null && x.lng !== null);
    return normalized;
  } catch (err) {
    console.warn('queryOverpassByBBox failed:', err?.message || err);
    return [];
  }
}

/* ---------- Persist OSM candidates to DB (avoid duplicates) ---------- */
/*
  Strategy:
   - For each osm candidate:
     1) skip if no title or coords
     2) try find existing by exact lower(titulo) -> use existing id
     3) try find nearby by lat/lng bbox -> use existing id
     4) otherwise INSERT into locations and return inserted row
*/
async function persistOsmCandidatesToDb(osmCandidates = [], db, country = null) {
  if (!Array.isArray(osmCandidates) || osmCandidates.length === 0) return [];
  const inserted = [];
  const LAT_LNG_EPS = 0.0006; // ~50-70 meters
  const insertSQL = `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country, avg_duration_min, popularity)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                     RETURNING id, titulo, latitud, longitud, imagenes, relevancia, country`;
  for (const cand of osmCandidates) {
    try {
      const title = (cand.titulo || '').trim();
      const lat = (cand.lat !== null && cand.lat !== undefined) ? Number(cand.lat) : null;
      const lng = (cand.lng !== null && cand.lng !== undefined) ? Number(cand.lng) : null;
      if (!title || lat === null || lng === null) continue;

      // 1) exact title match
      const found = await db.query('SELECT id, titulo, latitud, longitud, imagenes, relevancia, country FROM locations WHERE lower(titulo) = lower($1) LIMIT 1', [title]);
      if (found.rows.length) {
        // found existing; nothing to insert
        continue;
      }

      // 2) fuzzy ILIKE match
      const found2 = await db.query('SELECT id, titulo, latitud, longitud, imagenes, relevancia, country FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${title}%`]);
      if (found2.rows.length) { continue; }

      // 3) proximity match
      const nearby = await db.query('SELECT id FROM locations WHERE latitud IS NOT NULL AND longitud IS NOT NULL AND abs(latitud - $1) < $3 AND abs(longitud - $2) < $3 LIMIT 1', [lat, lng, LAT_LNG_EPS]);
      if (nearby.rows.length) continue;

      // 4) insert new location
      const descripcion = JSON.stringify({ source: 'osm', osm: cand.osm }).slice(0, 2000);
      const imagenes = null;
      const relevancia = cand.relevancia || 5;
      const avg_duration_min = 90;
      const popularity = null;

      const r = await db.query(insertSQL, [title, null, descripcion, lat, lng, imagenes, relevancia, country || null, avg_duration_min, popularity]);
      if (r.rows && r.rows.length) {
        inserted.push(r.rows[0]);
      }
      // small throttle (optional) - commented out for speed; enable if Overpass-heavy
      // await new Promise(r => setTimeout(r, 40));
    } catch (err) {
      // don't break whole flow if one insert fails
      console.warn('persistOsmCandidatesToDb: error for', cand && cand.titulo, err?.message || err);
      continue;
    }
  }
  return inserted;
}

/* ---------- Main exported function ---------- */
/**
 * options: { db, interestSlugs, country, destination, limit, mustVisits, notes }
 * db = pg pool (has .query)
 */
async function getCandidates(options = {}) {
  const {
    db,
    interestSlugs = [],
    country = null,
    destination = null,
    limit = 300,
    mustVisits = [],
    notes = ''
  } = options;
  if (!db) throw new Error('db pool required');

  const parsedMusts = extractMustVisitsFromNotes(notes || '');
  const explicitMusts = Array.from(new Set([...(mustVisits || []), ...parsedMusts])).slice(0, 20);

  // 1) geocode destination
  let geo = null;
  if (destination) geo = await geocodeDestination(destination);
  else if (country) geo = await geocodeDestination(country);

  // 2) Query DB but return primary interest-filtered + general high-relevancia batch
  let rows = [];
  try {
    if (Array.isArray(interestSlugs) && interestSlugs.length) {
      const slugs = interestSlugs.map(s => String(s).toLowerCase());
      const primaryLimit = Math.ceil(limit * 0.6); // interest-focused
      const generalLimit = Math.max(10, Math.floor(limit * 0.4)); // general top relevancia

      // find interest ids (if fk_interest stored as id-string)
      const idsRes = await db.query('SELECT id, slug FROM interests WHERE slug = ANY($1)', [slugs]);
      const matchingIds = (idsRes.rows || []).map(r => Number(r.id)).filter(n => Number.isFinite(n));
      const idsParam = matchingIds.length ? matchingIds : [-999999];

      const qPrimary = `
        SELECT l.id, l.titulo, l.fk_interest, l.latitud, l.longitud, l.imagenes, l.relevancia, l.country
        FROM locations l
        WHERE
          (l.fk_interest IS NOT NULL AND lower(l.fk_interest) = ANY($2))
          OR (l.fk_interest ~ '^[0-9]+$' AND (l.fk_interest::int = ANY($3)))
        ORDER BY l.relevancia DESC NULLS LAST
        LIMIT $1
      `;
      const rPrimary = await db.query(qPrimary, [primaryLimit, slugs, idsParam]);
      const primaryRows = rPrimary.rows || [];

      const qGeneral = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`;
      const rGeneral = await db.query(qGeneral, [generalLimit]);
      const generalRows = rGeneral.rows || [];

      // merge preserving order, dedupe by id
      const byId = new Map();
      for (const rr of primaryRows) byId.set(String(rr.id), rr);
      for (const rr of generalRows) if (!byId.has(String(rr.id))) byId.set(String(rr.id), rr);

      rows = Array.from(byId.values());
    } else {
      const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`;
      const r = await db.query(q, [limit]);
      rows = r.rows || [];
    }
  } catch (err) {
    console.warn('DB candidate fetch failed:', err?.message || err);
    rows = [];
  }

  // normalize DB results
  const dbCandidatesAll = (rows || []).map(normalizeDbRow);
  let dbCandidates = dbCandidatesAll;

  // filter dbCandidates by proximity to geo center if available
  if (geo && geo.lat && geo.lon) {
    let radiusMeters = Number(process.env.POI_DB_RADIUS_METERS || 50000);
    if (Array.isArray(geo.bbox) && geo.bbox.length === 4) {
      const [s, w, n, e] = geo.bbox;
      const diagonal = Math.round(haversineMeters(s, w, n, e));
      radiusMeters = Math.max(5000, Math.min(50000, Math.round(diagonal / 2)));
    }
    dbCandidates = dbCandidatesAll.filter(c => {
      if (c.lat === null || c.lng === null) return false;
      const d = haversineMeters(geo.lat, geo.lon, c.lat, c.lng);
      return isFinite(d) && d <= radiusMeters;
    });
  }

  // 3) Query OSM when needed (focused by interestSlugs and/or explicit musts)
  let osmCandidates = [];
  const needExtra = dbCandidates.length < Math.min(limit, 60) || explicitMusts.length > 0 || !geo;
  if (geo && (needExtra || dbCandidates.length === 0)) {
    const nameRegexes = explicitMusts.map(s => escapeRegex(s)).slice(0, 10);
    try {
      const bbox = geo.bbox;
      if (bbox && bbox.length === 4) {
        osmCandidates = await queryOverpassByBBox(bbox, nameRegexes, Math.max(100, limit - dbCandidates.length), interestSlugs);
      } else {
        const delta = 0.25;
        const bbox2 = [geo.lat - delta, geo.lon - delta, geo.lat + delta, geo.lon + delta];
        osmCandidates = await queryOverpassByBBox(bbox2, nameRegexes, Math.max(50, limit - dbCandidates.length), interestSlugs);
      }
    } catch (err) {
      console.warn('Overpass bbox query failed:', err?.message || err);
      osmCandidates = [];
    }
  } else if (!geo) {
    if (dbCandidates.length) {
      const c = dbCandidates[0];
      if (c.lat && c.lng) {
        const delta = 0.25;
        try {
          osmCandidates = await queryOverpassByBBox([c.lat - delta, c.lng - delta, c.lat + delta, c.lng + delta], [], 100, interestSlugs);
        } catch (err) { osmCandidates = []; }
      }
    }
  }

  // Persist new OSM candidates into DB (so next request will pick them from DB)
  if (Array.isArray(osmCandidates) && osmCandidates.length && db) {
    try {
      // persist and get inserted rows (normalized)
      const inserted = await persistOsmCandidatesToDb(osmCandidates, db, country);
      // merge inserted rows into dbCandidatesAll so dedupeMerge can combine properly
      if (inserted && inserted.length) {
        const normInserted = inserted.map(r => ({ id: r.id, titulo: r.titulo, fk_interest: null, lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null, lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null, imagenes: r.imagenes || null, relevancia: r.relevancia || 5, country: r.country || country || null, source: 'db+osm' }));
        // add to dbCandidatesAll for later merging; but avoid duplicates
        for (const ni of normInserted) {
          if (!dbCandidatesAll.find(x => String(x.id) === String(ni.id))) dbCandidatesAll.push(ni);
        }
      }
    } catch (err) {
      console.warn('persistOsmCandidatesToDb failed:', err?.message || err);
    }
  }

  // 4) Merge & dedupe DB + OSM candidates
  let candidates = dedupeMerge(dbCandidates, osmCandidates, 75);

  // 5) Ensure explicit mustVisits are included (try Overpass again for missing named musts)
  if (explicitMusts.length && geo) {
    for (const mv of explicitMusts) {
      const present = candidates.find(c => c.titulo && c.titulo.toLowerCase().includes(mv.toLowerCase()));
      if (!present) {
        try {
          const nameRegex = escapeRegex(mv);
          const more = await queryOverpassByBBox(geo.bbox || [geo.lat - 0.25, geo.lon - 0.25, geo.lat + 0.25, geo.lon + 0.25], [nameRegex], 20, interestSlugs);
          if (more && more.length) candidates = dedupeMerge(candidates, more, 50);
        } catch (err) { /* ignore */ }
      }
    }
  }

  // 6) Final scoring & boosts (stronger tourism/historic boosts and interest mapping)
  const maxRelev = Math.max(1, ...candidates.map(c => c.relevancia || 0));
  const interestTags = new Set();
  if (Array.isArray(interestSlugs)) {
    for (const s of interestSlugs) {
      const tags = INTEREST_TO_OSM[s];
      if (Array.isArray(tags)) tags.forEach(t => interestTags.add(t));
    }
  }

  candidates = candidates.map(c => {
    const lat = c.lat !== null && c.lat !== undefined ? Number(c.lat) : null;
    const lng = c.lng !== null && c.lng !== undefined ? Number(c.lng) : null;
    let isMust = false;
    if (explicitMusts.length && c.titulo) {
      for (const mv of explicitMusts) { if (c.titulo.toLowerCase().includes(mv.toLowerCase())) { isMust = true; break; } }
    }
    const base = (c.relevancia || 0) / maxRelev;
    const osmBoost = (c.source && String(c.source).includes('osm')) ? 0.2 : 0;

    // tourism/historic boosts
    let tourismHistoricBoost = 0;
    if (c.osm && c.osm.tags) {
      const t = (c.osm.tags.tourism || '').toString().toLowerCase();
      const h = (c.osm.tags.historic || '').toString().toLowerCase();
      const amen = (c.osm.tags.amenity || '').toString().toLowerCase();
      if (['museum','attraction','viewpoint','gallery','zoo','aquarium'].includes(t)) tourismHistoricBoost += 2.0;
      if (['memorial','monument','castle','ruins','archaeological_site','yes'].includes(h)) tourismHistoricBoost += 2.0;
      if (['park','garden','nature_reserve'].includes((c.osm.tags.leisure || '').toString().toLowerCase())) tourismHistoricBoost += 1.2;
    }

    // interest-based boost (if POI's tags match interest mapping)
    let interestBoost = 0;
    if (Array.isArray(interestSlugs) && interestSlugs.length && c.osm && c.osm.tags) {
      const amenOrTour = (c.osm.tags.amenity || c.osm.tags.tourism || c.osm.tags.leisure || '').toString().toLowerCase();
      for (const slug of interestSlugs) {
        const map = INTEREST_TO_OSM[String(slug).toLowerCase()];
        if (Array.isArray(map) && map.includes(amenOrTour)) {
          interestBoost += 1.6;
        }
      }
    }
    const mustBoost = isMust ? 1.8 : 0;
    const combined = (base * 3.0) + osmBoost + tourismHistoricBoost + mustBoost + interestBoost;
    const distanceToCenter = (geo && geo.lat && lat && lng) ? Math.round(haversineMeters(geo.lat, geo.lon, lat, lng)) : null;

    return {
      id: c.id,
      titulo: c.titulo,
      fk_interest: c.fk_interest || null,
      lat,
      lng,
      imagenes: c.imagenes || null,
      relevancia: c.relevancia || 0,
      source: c.source || 'db',
      osm: c.osm || null,
      isMust,
      combined_score: combined,
      distance_to_center: distanceToCenter
    };
  });

  // 7) sort: prefer musts, then combined_score, then proximity
  candidates.sort((a,b) => {
    if (a.isMust && !b.isMust) return -1;
    if (!a.isMust && b.isMust) return 1;
    const cs = (b.combined_score || 0) - (a.combined_score || 0);
    if (Math.abs(cs) > 1e-6) return cs;
    const da = a.distance_to_center || Number.POSITIVE_INFINITY;
    const db = b.distance_to_center || Number.POSITIVE_INFINITY;
    return da - db;
  });

  // 8) limit result
  return candidates.slice(0, limit);
}

/* ---------- exports ---------- */
module.exports = { getCandidates, geocodeDestination };
