// services/poi.service.js
// Improved POI fetcher that geocodes the trip destination and queries OSM using bbox.
// Also filters DB results by proximity to the geocoded center to avoid returning far-away DB rows.

'use strict';

/**
 * Robust fetch + AbortController detection:
 * - prefer global fetch / AbortController (Node 18+)
 * - fallback to undici (npm install undici)
 * - fallback to abort-controller (npm install abort-controller) only for AbortController
 */
let fetchImpl = null;
let AbortControllerImpl = null;

try {
  if (typeof globalThis.fetch === 'function') {
    fetchImpl = globalThis.fetch;
  }
} catch (e) {}

if (!fetchImpl) {
  try {
    const undici = require('undici'); // recommended for CommonJS environments
    if (undici && typeof undici.fetch === 'function') {
      fetchImpl = undici.fetch.bind(undici);
    }
    // undici may export AbortController
    if (!AbortControllerImpl && undici && undici.AbortController) AbortControllerImpl = undici.AbortController;
  } catch (e) {
    // ignore
  }
}

// fallback for AbortController
if (!AbortControllerImpl) {
  if (typeof globalThis.AbortController === 'function') {
    AbortControllerImpl = globalThis.AbortController;
  } else {
    try {
      // lightweight polyfill if needed
      const ac = require('abort-controller');
      if (ac && ac.AbortController) AbortControllerImpl = ac.AbortController;
    } catch (e) {
      // if still missing, we'll handle later by using Promise.race timeout
      AbortControllerImpl = null;
    }
  }
}

if (!fetchImpl) {
  throw new Error('No fetch implementation found. Install node >=18 or `npm install undici`.');
}

const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || ''; // put contact email to respect policies

/**
 * fetchWithTimeout:
 * - uses AbortController if available for actual abort
 * - otherwise uses Promise.race fallback (will not abort underlying socket)
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  if (AbortControllerImpl) {
    const controller = new AbortControllerImpl();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...opts, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(id);
    }
  } else {
    // Promise.race fallback (no deterministic abort)
    return await Promise.race([
      fetchImpl(url, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
    ]);
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lat2, lon1, lon2].some(v => v === null || v === undefined || Number.isNaN(v))) return Number.POSITIVE_INFINITY;
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
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
    source: 'db'
  };
}

function normalizeOsmElement(el) {
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'] || tags.int_name || null;
  const lat = el.lat !== undefined && el.lat !== null ? Number(el.lat) : (el.center && el.center.lat ? Number(el.center.lat) : null);
  const lon = el.lon !== undefined && el.lon !== null ? Number(el.lon) : (el.center && el.center.lon ? Number(el.center.lon) : null);
  const id = `osm-${el.type}-${el.id}`;
  return {
    id,
    titulo: name || (tags.amenity || tags.tourism || tags.historic || 'unnamed'),
    fk_interest: null,
    lat: lat,
    lng: lon,
    imagenes: null,
    relevancia: 5,
    source: 'osm',
    osm: { type: el.type, osm_id: el.id, tags }
  };
}

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
        } else {
          foundIdx = i; break;
        }
      }
      if (ex.lat !== null && inc.lat !== null && isFinite(ex.lat) && isFinite(inc.lat)) {
        const d = haversineMeters(ex.lat, ex.lng, inc.lat, inc.lng);
        if (d < 10) { foundIdx = i; break; }
      }
    }
    if (foundIdx === -1) {
      merged.push(inc);
    } else {
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

async function geocodeDestination(query) {
  // returns { lat, lon, bbox: [south,west,north,east], display_name } or null
  if (!query || !String(query).trim()) return null;
  const q = encodeURIComponent(String(query));
  const url = `${NOMINATIM_URL}?q=${q}&format=json&limit=3&addressdetails=1&polygon_geojson=0`;
  const headers = {
    'User-Agent': `itinerary-service/1.0 (${NOMINATIM_EMAIL || 'dev'})`,
    'Accept-Language': 'en'
  };
  if (NOMINATIM_EMAIL) headers['From'] = NOMINATIM_EMAIL;
  try {
    const resp = await fetchWithTimeout(url, { headers }, 15000);
    if (!resp.ok) throw new Error(`Nominatim ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    // pick best result: prefer type=city/town/village if available
    let pick = data[0];
    for (const cand of data) {
      if (cand.type && ['city','town','village','municipality'].includes(cand.type)) { pick = cand; break; }
    }
    const bbox = (pick.boundingbox || []).map(Number); // [south, north, west, east] (strings)
    // normalize to [south,west,north,east]
    let normBbox = null;
    if (bbox.length === 4) {
      normBbox = [bbox[0], bbox[2], bbox[1], bbox[3]]; // south, west, north, east
    }
    return {
      lat: Number(pick.lat),
      lon: Number(pick.lon),
      bbox: normBbox,
      display_name: pick.display_name,
      raw: pick
    };
  } catch (err) {
    console.warn('geocodeDestination failed:', err?.message || err);
    return null;
  }
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&'); }

/**
 * Overpass bbox query: bbox = [south, west, north, east]
 * We pick a compact set of tags: tourism, amenity, historic, leisure, shop (popular)
 */
async function queryOverpassByBBox(bbox, extraNameRegexes = [], limit = 200) {
  if (!bbox || bbox.length !== 4) throw new Error('Invalid bbox for Overpass query');
  const [south, west, north, east] = bbox;
  const nameFilter = extraNameRegexes && extraNameRegexes.length ? `node["name"~"${extraNameRegexes.join('|')}"](${south},${west},${north},${east});way["name"~"${extraNameRegexes.join('|')}"](${south},${west},${north},${east});` : '';
  const q = `[out:json][timeout:25];
(
  node["tourism"](${south},${west},${north},${east});
  way["tourism"](${south},${west},${north},${east});
  node["amenity"](${south},${west},${north},${east});
  way["amenity"](${south},${west},${north},${east});
  node["historic"](${south},${west},${north},${east});
  way["historic"](${south},${west},${north},${east});
  node["leisure"](${south},${west},${north},${east});
  way["leisure"](${south},${west},${north},${east});
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
      const t = await resp.text();
      throw new Error(`Overpass ${resp.status}: ${t.slice(0,200)}`);
    }
    const body = await resp.json();
    const elements = body.elements || [];
    const normalized = elements.map(normalizeOsmElement).filter(x => x.titulo && x.lat !== null && x.lng !== null);
    return normalized;
  } catch (err) {
    console.warn('queryOverpassByBBox failed:', err?.message || err);
    return [];
  }
}

/**
 * Main exported function
 * options: { db, interestSlugs, country, destination, limit, mustVisits, notes }
 *
 * IMPORTANT: prefer passing `destination` (string like "Berlin, Germany"). The service will geocode it.
 */
async function getCandidates(options = {}) {
  const { db, interestSlugs = [], country = null, destination = null, limit = 300, mustVisits = [], notes = '' } = options;
  if (!db) throw new Error('db pool required');

  const parsedMusts = extractMustVisitsFromNotes(notes || '');
  const explicitMusts = Array.from(new Set([...(mustVisits || []), ...parsedMusts])).slice(0, 20);

  // 1) geocode destination to bbox & center (if present)
  let geo = null;
  if (destination) {
    geo = await geocodeDestination(destination);
  } else if (country) {
    // try minimal geocode of country name if destination not provided
    geo = await geocodeDestination(country);
  }

  // 2) Query DB but filter by proximity to geocoded center if available
  let rows = [];
  try {
    // base DB query (no geographic filter) but limited
    const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`;
    const r = await db.query(q, [limit]);
    rows = r.rows || [];
  } catch (err) {
    console.warn('DB candidate fetch failed:', err?.message || err);
    rows = [];
  }

  // normalize DB rows and optionally filter by distance: if geo is present, keep only within radius (e.g., 50km)
  const dbCandidatesAll = (rows || []).map(normalizeDbRow);
  let dbCandidates = dbCandidatesAll;
  if (geo && geo.lat && geo.lon) {
    const radiusMeters = Number(process.env.POI_DB_RADIUS_METERS || 50000); // default 50km
    dbCandidates = dbCandidatesAll.filter(c => {
      if (c.lat === null || c.lng === null) return false;
      const d = haversineMeters(geo.lat, geo.lon, c.lat, c.lng);
      return isFinite(d) && d <= radiusMeters;
    });
  }

  // 3) If DB returned few results or mustVisits not present in DB, query OSM via bbox
  let osmCandidates = [];
  const needExtra = dbCandidates.length < Math.min(limit, 60) || explicitMusts.length > 0 || !geo;
  if (geo && (needExtra || dbCandidates.length === 0)) {
    // build regex list for mustVisits to prioritize
    const nameRegexes = explicitMusts.map(s => escapeRegex(s)).slice(0, 10);
    try {
      const bbox = geo.bbox; // [south,west,north,east]
      if (bbox && bbox.length === 4) {
        osmCandidates = await queryOverpassByBBox(bbox, nameRegexes, Math.max(100, limit - dbCandidates.length));
      } else {
        // fallback: search small bbox around center
        const delta = 0.25; // ~25km depending on lat
        const bbox2 = [geo.lat - delta, geo.lon - delta, geo.lat + delta, geo.lon + delta];
        osmCandidates = await queryOverpassByBBox(bbox2, nameRegexes, Math.max(50, limit - dbCandidates.length));
      }
    } catch (err) {
      console.warn('Overpass bbox query failed:', err?.message || err);
      osmCandidates = [];
    }
  } else if (!geo) {
    // no geocode at all: attempt a small Overpass search around some DB candidate (if any)
    if (dbCandidates.length) {
      const c = dbCandidates[0];
      if (c.lat && c.lng) {
        const delta = 0.25;
        try {
          osmCandidates = await queryOverpassByBBox([c.lat-delta, c.lng-delta, c.lat+delta, c.lng+delta], [], 100);
        } catch (err) { osmCandidates = []; }
      }
    }
  }

  // 4) Merge & dedupe OSM + DB
  let candidates = dedupeMerge(dbCandidates, osmCandidates, 75);

  // 5) Ensure explicit mustVisits are included: if a must-visit name wasn't matched, attempt to find by name in OSM (small focused search)
  if (explicitMusts.length && geo) {
    for (const mv of explicitMusts) {
      const present = candidates.find(c => c.titulo && c.titulo.toLowerCase().includes(mv.toLowerCase()));
      if (!present) {
        // query Overpass for the name inside bbox
        try {
          const nameRegex = escapeRegex(mv);
          const more = await queryOverpassByBBox(geo.bbox || [geo.lat-0.25, geo.lon-0.25, geo.lat+0.25, geo.lon+0.25], [nameRegex], 20);
          if (more && more.length) {
            candidates = dedupeMerge(candidates, more, 50);
          }
        } catch (err) {
          // ignore
        }
      }
    }
  }

  // 6) Final scoring and normalization: compute combined_score and mark isMust
  const maxRelev = Math.max(1, ...candidates.map(c => c.relevancia || 0));
  candidates = candidates.map(c => {
    const lat = c.lat !== null && c.lat !== undefined ? Number(c.lat) : null;
    const lng = c.lng !== null && c.lng !== undefined ? Number(c.lng) : null;
    let isMust = false;
    if (explicitMusts.length && c.titulo) {
      for (const mv of explicitMusts) { if (c.titulo.toLowerCase().includes(mv.toLowerCase())) { isMust = true; break; } }
    }
    const base = (c.relevancia || 0) / maxRelev; // 0..1
    const osmBoost = (c.source && String(c.source).includes('osm')) ? 0.2 : 0;
    const mustBoost = isMust ? 1.5 : 0;
    const combined = (base * 3.0) + osmBoost + mustBoost;
    // compute distance to center if geo present
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
      isMust: isMust,
      combined_score: combined,
      distance_to_center: distanceToCenter
    };
  });

  // 7) sort: prefer musts, then combined_score, then proximity
  candidates.sort((a, b) => {
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

module.exports = { getCandidates, geocodeDestination };
