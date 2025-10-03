// services/poi.service.js
// Fetch candidate POIs for itinerary planning.
// Strategy:
//  - Prefer POIs already in local DB (fast).
//  - If DB has few or missing entries, query OpenStreetMap via Overpass API as fallback.
//  - Respect interest slugs when possible, but always include user-specified `mustVisits` (or names parsed from notes).
//  - De-duplicate OSM and DB results (by name+proximity).
//  - Normalize output to the shape your app expects.

const fetch = require('node-fetch');

// Default Overpass endpoint (public)
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

function haversineMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lat2, lon1, lon2].some(v => v === null || v === undefined || Number.isNaN(v))) return Number.POSITIVE_INFINITY;
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
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
    source: 'db'
  };
}

function normalizeOsmElement(el) {
  // el can be node or way; if way, center may be in el.center
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'] || tags['int_name'] || null;
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
    relevancia: 5, // default mid score; will be combined with DB relevancia if available
    source: 'osm',
    osm: { type: el.type, osm_id: el.id, tags }
  };
}

function dedupeMerge(existing, incoming, distanceThresholdMeters = 50) {
  // existing: array of normalized items (from DB), incoming: items (from OSM)
  const merged = existing.slice();
  for (const inc of incoming) {
    // try to find match by exact id (if ids share) or by name + distance
    let foundIdx = -1;
    for (let i = 0; i < merged.length; i++) {
      const ex = merged[i];
      // prefer same DB id
      if (typeof ex.id === 'number' && typeof inc.id === 'number' && ex.id === inc.id) { foundIdx = i; break; }
      // if both have titles and similar
      if (ex.titulo && inc.titulo && ex.titulo.toLowerCase() === inc.titulo.toLowerCase()) {
        // check proximity if coords available
        if (ex.lat !== null && inc.lat !== null && isFinite(ex.lat) && isFinite(inc.lat)) {
          const d = haversineMeters(ex.lat, ex.lng, inc.lat, inc.lng);
          if (d <= distanceThresholdMeters) { foundIdx = i; break; }
        } else {
          foundIdx = i; break;
        }
      }
      // fallback proximity-only match
      if (ex.lat !== null && inc.lat !== null && isFinite(ex.lat) && isFinite(inc.lat)) {
        const d = haversineMeters(ex.lat, ex.lng, inc.lat, inc.lng);
        if (d < 10) { foundIdx = i; break; }
      }
    }

    if (foundIdx === -1) {
      merged.push(inc);
    } else {
      // merge: keep DB fields when present, add osm info and bump relevancia
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
  // phrases in quotes
  const quoteRe = /"([^"]{3,80})"|'([^']{3,80})'/g;
  let m;
  while ((m = quoteRe.exec(notes)) !== null) {
    const p = (m[1] || m[2] || '').trim();
    if (p) found.add(p);
  }
  // phrases after "must visit" or "want to visit"
  const mustRe = /(?:must visit|want to visit|visit)\s*[:\-]?\s*([^\.\n]{3,80})/ig;
  while ((m = mustRe.exec(notes)) !== null) {
    const p = (m[1] || '').split(/[;,\n]/)[0].trim();
    if (p) found.add(p);
  }
  return Array.from(found);
}

async function queryOverpassByCountry(countryName, extraNameRegexes = [], limit = 100) {
  // Build Overpass Q: search popular tags and names matching extra regexes
  // Danger: area[name=...] may be ambiguous but works for many countries.
  // We request nodes and ways, and ask for 'center' to get coordinates of ways.
  const nameFilter = extraNameRegexes && extraNameRegexes.length ? `\n  node["name"~"${extraNameRegexes.join('|')}"](area.searchArea);\n  way["name"~"${extraNameRegexes.join('|')}"](area.searchArea);` : '';
  const q = `[out:json][timeout:25];\narea["name"~"^${escapeRegex(countryName)}$",i]->.searchArea;\n(\n  node["tourism"](area.searchArea);\n  way["tourism"](area.searchArea);\n  node["amenity"](area.searchArea);\n  way["amenity"](area.searchArea);\n  node["historic"](area.searchArea);\n  way["historic"](area.searchArea);${nameFilter}\n);\nout center ${Math.min(limit, 200)};`;

  const resp = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
    timeout: 30000
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Overpass error ${resp.status}: ${t.slice(0,200)}`);
  }
  const body = await resp.json();
  const elements = body.elements || [];
  const normalized = elements.map(normalizeOsmElement).filter(x => x.titulo && x.lat !== null && x.lng !== null);
  return normalized;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Main exported function
 * options: {
 *   db: pgPool (required),
 *   interestSlugs: [],
 *   country: string|null,
 *   limit: number (max results),
 *   mustVisits: [string] (optional),
 *   notes: string (optional)  - will be scanned for must-visit phrases
 * }
 */
async function getCandidates(options = {}) {
  const { db, interestSlugs = [], country = null, limit = 300, mustVisits = [], notes = '' } = options;
  if (!db) throw new Error('db pool required');

  // Combine explicit mustVisits with parsed ones from notes
  const parsed = extractMustVisitsFromNotes(notes || '');
  const explicitMusts = Array.from(new Set([...(mustVisits || []), ...parsed])).slice(0, 20);

  // 1) try DB queries
  let rows = [];
  try {
    if (interestSlugs.length > 0 && country) {
      const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations WHERE country ILIKE $1 AND fk_interest = ANY($2) ORDER BY relevancia DESC NULLS LAST LIMIT $3`;
      const r = await db.query(q, [country, interestSlugs, limit]);
      rows = r.rows || [];
    }
    if (!rows.length && interestSlugs.length > 0) {
      const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations WHERE fk_interest = ANY($1) ORDER BY relevancia DESC NULLS LAST LIMIT $2`;
      const r = await db.query(q, [interestSlugs, limit]);
      rows = r.rows || [];
    }
    if (!rows.length) {
      if (country) {
        const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations WHERE country ILIKE $1 ORDER BY relevancia DESC NULLS LAST LIMIT $2`;
        const r = await db.query(q, [country, limit]);
        rows = r.rows || [];
      } else {
        const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`;
        const r = await db.query(q, [limit]);
        rows = r.rows || [];
      }
    }
  } catch (err) {
    console.warn('DB candidate fetch failed, continuing to OSM fallback', err.message || err);
    rows = [];
  }

  const dbCandidates = (rows || []).map(normalizeDbRow);

  // If DB already has many items (>= limit), keep them but ensure mustVisits included
  let candidates = dbCandidates.slice();

  // Ensure mustVisits found in DB are present and prioritized
  if (explicitMusts.length) {
    for (const mv of explicitMusts) {
      // find case-insensitive title match in DB
      const found = candidates.find(c => c.titulo && c.titulo.toLowerCase().includes(mv.toLowerCase()));
      if (!found) {
        // mark to search in OSM
      } else {
        // bump relevancia so these appear first
        found.relevancia = Math.max(found.relevancia || 0, 100);
      }
    }
  }

  // If DB candidates are fewer than limit or we want to supplement with OSM for mustVisits, call Overpass
  let osmCandidates = [];
  const needExtra = candidates.length < Math.min(limit, 40) || explicitMusts.length > 0;
  if (needExtra && country) {
    // build regex list for mustVisits to prioritize them in Overpass
    const nameRegexes = explicitMusts.map(s => escapeRegex(s));
    try {
      osmCandidates = await queryOverpassByCountry(country, nameRegexes, Math.max(50, limit - candidates.length));
    } catch (err) {
      console.warn('Overpass query failed:', err.message || err);
      osmCandidates = [];
    }
  }

  // Merge OSM results into DB candidates (dedupe by name/proximity)
  candidates = dedupeMerge(candidates, osmCandidates, 50);

  // If still not enough, and country not provided, do a broad Overpass search without area (very limited)
  if (candidates.length < Math.min(limit, 20) && !country) {
    try {
      // query generic tags globally but limit by bbox around first DB candidate if exists
      let bbox = null;
      if (dbCandidates.length) {
        const c = dbCandidates[0];
        // small bbox (~0.5 deg)
        bbox = `${c.lat-0.5},${c.lng-0.5},${c.lat+0.5},${c.lng+0.5}`;
      }
      if (bbox) {
        // simple overpass by bbox: find tourism/amenity/historic nodes
        const q = `[out:json][timeout:25];(node["tourism"](${bbox});way["tourism"](${bbox});node["amenity"](${bbox});way["amenity"](${bbox}););out center 50;`;
        const resp = await fetch(OVERPASS_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}` });
        if (resp.ok) {
          const body = await resp.json();
          const els = (body.elements || []).map(normalizeOsmElement).filter(x => x.titulo && x.lat !== null && x.lng !== null);
          candidates = dedupeMerge(candidates, els, 50);
        }
      }
    } catch (err) {
      console.warn('Fallback bbox OSM search failed', err.message || err);
    }
  }

  // Final normalization: compute a combined_score that later services can use
  // combined_score = normalized(db relevancia) + osm boost + (mustVisit boost)
  const maxRelev = Math.max(1, ...candidates.map(c => c.relevancia || 0));
  candidates = candidates.map(c => {
    // ensure numeric lat/lng
    const lat = c.lat !== null && c.lat !== undefined ? Number(c.lat) : null;
    const lng = c.lng !== null && c.lng !== undefined ? Number(c.lng) : null;
    // detect if matches mustVisit
    let isMust = false;
    if (explicitMusts.length && c.titulo) {
      for (const mv of explicitMusts) {
        if (c.titulo.toLowerCase().includes(mv.toLowerCase())) { isMust = true; break; }
      }
    }
    const base = (c.relevancia || 0) / maxRelev; // 0..1
    const osmBoost = (c.source && c.source.includes('osm')) ? 0.2 : 0.0;
    const mustBoost = isMust ? 1.5 : 0.0;
    const combined = (base * 3.0) + osmBoost + mustBoost; // heuristic
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
      combined_score: combined
    };
  });

  // sort by combined_score desc
  candidates.sort((a,b) => (b.combined_score || 0) - (a.combined_score || 0));

  // limit result to `limit`
  return candidates.slice(0, limit);
}

module.exports = { getCandidates };
