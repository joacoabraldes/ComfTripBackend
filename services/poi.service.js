// services/poi.service.js
// Improved POI fetcher that geocodes the trip destination and queries OSM using bbox.
// Persists OSM candidates into `locations` using bulk upsert (temp table) for speed.

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
    fk_interest: r.fk_interest || null,
    lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null,
    lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null,
    imagenes: r.imagenes || null,
    relevancia: r.relevancia !== null && r.relevancia !== undefined ? Number(r.relevancia) : 0,
    country: r.country || null,
    city: r.city || null,
    website: r.website || null,
    category: r.category || null,
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

/* ---------- OSM normalization & helpers for insertion ---------- */
function pickFirstImageFromTags(tags) {
  if (!tags) return [];
  const imgs = [];
  if (tags.image) imgs.push(tags.image);
  Object.keys(tags).forEach(k => { if (/^image(:\d+)?$/.test(k) && tags[k]) imgs.push(tags[k]); });
  if (tags.photo) imgs.push(tags.photo);
  return Array.from(new Set(imgs)).slice(0,6);
}

function parsePriceLevel(tags) {
  if (!tags) return null;
  const p = tags.price || tags.fee || tags['entrance_fee'] || tags['price_level'];
  if (!p) return null;
  if (/^\$+$/.test(String(p))) return String(p).length;
  const m = String(p).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function heuristicAvgDuration(tags) {
  if (!tags) return 90;
  const tourism = (tags.tourism||'').toString().toLowerCase();
  const amen = (tags.amenity||'').toString().toLowerCase();
  const leisure = (tags.leisure||'').toString().toLowerCase();
  if (['museum','aquarium','zoo'].includes(tourism)) return 120;
  if (['attraction','viewpoint','memorial','gallery'].includes(tourism) || ['museum','gallery'].includes(amen)) return 90;
  if (['park','garden','nature_reserve'].includes(leisure)) return 60;
  if (['restaurant','cafe','bar','pub','fast_food'].includes(amen)) return 60;
  return 90;
}

/**
 * Normalize a raw OSM element into the reduced shape that fits your new schema.
 * We keep enough metadata to construct `descripcion`, `imagenes`, `opening_hours`, `website`, and `category`.
 */
function normalizeOsmForInsert(el) {
  if (!el || !el.tags) return null;
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'] || tags.int_name || null;
  const lat = (el.lat !== undefined && el.lat !== null) ? Number(el.lat) : (el.center && el.center.lat ? Number(el.center.lat) : null);
  const lon = (el.lon !== undefined && el.lon !== null) ? Number(el.lon) : (el.center && el.center.lon ? Number(el.center.lon) : null);

  const amenity = tags.amenity || null;
  const tourism = tags.tourism || null;
  const leisure = tags.leisure || null;

  if (amenity && OSM_UNWANTED_AMENITIES.has(amenity)) return null;
  if (tourism && OSM_UNWANTED_TOURISM.has(tourism)) return null;
  if (!name || lat === null || lon === null) return null;

  const photos = pickFirstImageFromTags(tags);
  const website = tags.website || tags['contact:website'] || null;
  const opening_hours = tags.opening_hours || null;
  const category = tourism || amenity || tags.historic || leisure || null;

  return {
    titulo: name.trim(),
    latitud: lat,
    longitud: lon,
    relevancia: 5,
    descripcion: JSON.stringify({ source: 'osm', tags }).slice(0, 2000),
    opening_hours: opening_hours ? { raw: opening_hours } : null,
    website,
    imagenes: photos.length ? photos : null,
    category
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

/* ---------- Overpass bbox query (unchanged) ---------- */
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

// keep older, simpler normalizer used for immediate query->candidate mapping
function normalizeOsmElement(el) {
  const tags = el.tags || {};
  const amenity = tags.amenity || null;
  const tourism = tags.tourism || null;
  const leisure = tags.leisure || null;

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

/* ---------- Persist OSM candidates to DB using bulk upsert (fast) ---------- */
/*
 Strategy (adapted to new schema):
  - normalize OSM elements into objects matching new columns (titulo, descripcion, latitud, longitud, imagenes, relevancia, opening_hours, website, category)
  - insert into a temp table tmp_pois
  - 1) update locations by exact title+country+city
  - 2) update by proximity (lat/lng epsilon) when match exists
  - 3) insert remaining rows
  - finally SELECT matching rows from locations by lower(titulo) and return them
*/
const LAT_LNG_EPS = 0.0006; // ~50-70 meters

async function persistOsmCandidatesToDb(osmCandidates = [], db, country = null, city = null) {
  if (!Array.isArray(osmCandidates) || osmCandidates.length === 0) return [];
  // normalize
  const norm = [];
  for (const c of osmCandidates) {
    const raw = c._raw || c;
    const candidate = normalizeOsmForInsert(raw);
    if (candidate) norm.push(candidate);
  }
  if (!norm.length) return [];

  // use client (db may be Pool or client)
  let client = db;
  let mustRelease = false;
  try {
    if (typeof db.connect === 'function') {
      client = await db.connect();
      mustRelease = true;
    }
  } catch (e) {
    client = db;
    mustRelease = false;
  }

  try {
    await client.query('BEGIN');

    // temp table matching the reduced set of fields
    await client.query(`CREATE TEMP TABLE tmp_pois (
      titulo text,
      latitud double precision,
      longitud double precision,
      descripcion text,
      relevancia numeric,
      opening_hours jsonb,
      website text,
      imagenes jsonb,
      category text
    ) ON COMMIT DROP;`);

    const vals = [];
    const placeholders = [];
    for (let i=0;i<norm.length;i++){
      const idx = i*9;
      placeholders.push(`($${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6}::jsonb,$${idx+7},$${idx+8}::jsonb,$${idx+9})`);
      const c = norm[i];
      vals.push(
        c.titulo,
        c.latitud,
        c.longitud,
        c.descripcion,
        c.relevancia || 5,
        c.opening_hours ? JSON.stringify(c.opening_hours) : null,
        c.website || null,
        c.imagenes ? JSON.stringify(c.imagenes) : null,
        c.category || null
      );
    }
    const insertTmpSql = `INSERT INTO tmp_pois (titulo, latitud, longitud, descripcion, relevancia, opening_hours, website, imagenes, category) VALUES ${placeholders.join(',')};`;
    await client.query(insertTmpSql, vals);

    // 1) update by exact title + country + city
    const updateByTitleSql = `
      WITH updated AS (
        UPDATE locations l
        SET
          descripcion = COALESCE(l.descripcion, t.descripcion),
          latitud = COALESCE(l.latitud, t.latitud),
          longitud = COALESCE(l.longitud, t.longitud),
          opening_hours = COALESCE(l.opening_hours, t.opening_hours),
          website = COALESCE(l.website, t.website),
          imagenes = COALESCE(l.imagenes, t.imagenes),
          relevancia = GREATEST(COALESCE(l.relevancia,0), COALESCE(t.relevancia,5)),
          category = COALESCE(l.category, t.category),
          country = COALESCE(l.country, $1::text),
          city = COALESCE(l.city, $2::text)
        FROM tmp_pois t
        WHERE lower(l.titulo) = lower(t.titulo)
          AND coalesce(l.country,'') = coalesce($1::text,'')
          AND coalesce(l.city,'') = coalesce($2::text,'')
        RETURNING l.id
      )
      SELECT COUNT(*) as cnt FROM updated;
    `;
    const upTitleRes = await client.query(updateByTitleSql, [country || null, city || null]);
    const updated_by_title = upTitleRes.rows && Number(upTitleRes.rows[0].cnt || 0) || 0;

    // 2) update by proximity for rows that have coordinates
    const updateByProxSql = `
      WITH updated AS (
        UPDATE locations l
        SET
          descripcion = COALESCE(l.descripcion, t.descripcion),
          latitud = COALESCE(l.latitud, t.latitud),
          longitud = COALESCE(l.longitud, t.longitud),
          opening_hours = COALESCE(l.opening_hours, t.opening_hours),
          website = COALESCE(l.website, t.website),
          imagenes = COALESCE(l.imagenes, t.imagenes),
          relevancia = GREATEST(COALESCE(l.relevancia,0), COALESCE(t.relevancia,5)),
          category = COALESCE(l.category, t.category),
          country = COALESCE(l.country, $3::text),
          city = COALESCE(l.city, $4::text)
        FROM tmp_pois t
        WHERE l.latitud IS NOT NULL AND l.longitud IS NOT NULL
          AND abs(l.latitud - t.latitud) < $1::double precision AND abs(l.longitud - t.longitud) < $1::double precision
          AND coalesce(l.country,'') = coalesce($3::text,'')
          AND coalesce(l.city,'') = coalesce($4::text,'')
        RETURNING l.id
      )
      SELECT COUNT(*) as cnt FROM updated;
    `;
    const upProxRes = await client.query(updateByProxSql, [LAT_LNG_EPS, /*unused*/null, country || null, city || null]);
    const updated_by_proximity = upProxRes.rows && Number(upProxRes.rows[0].cnt || 0) || 0;

    // 3) insert remaining rows that don't exist by title+country+city or proximity
    const insertSql = `
      WITH ins AS (
        INSERT INTO locations (
          titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country, city,
          opening_hours, website, category
        )
        SELECT
          t.titulo, NULL, t.descripcion, t.latitud, t.longitud, t.imagenes, COALESCE(t.relevancia,5), $1::text, $2::text,
          t.opening_hours, t.website, t.category
        FROM tmp_pois t
        WHERE NOT EXISTS (
          SELECT 1 FROM locations l
          WHERE (lower(l.titulo) = lower(t.titulo) AND coalesce(l.country,'') = coalesce($1::text,'') AND coalesce(l.city,'') = coalesce($2::text,''))
             OR (l.latitud IS NOT NULL AND l.longitud IS NOT NULL AND abs(l.latitud - t.latitud) < $3::double precision AND abs(l.longitud - t.longitud) < $3::double precision AND coalesce(l.country,'') = coalesce($1::text,'') AND coalesce(l.city,'') = coalesce($2::text,''))
        )
        RETURNING id
      )
      SELECT COUNT(*) as inserted_count FROM ins;
    `;
    const insertRes = await client.query(insertSql, [country || null, city || null, LAT_LNG_EPS]);
    const inserted = insertRes.rows && Number(insertRes.rows[0].inserted_count || 0) || 0;

    await client.query('COMMIT');

    // Fetch matching rows by titulo (lowered) to return them (we only inserted/updated by titulo/proximity)
    const tituloList = norm.map(n => (n.titulo || '').toLowerCase()).filter(Boolean);

    if (!tituloList.length) return [];

    const fetchSql = `SELECT id, titulo, latitud, longitud, imagenes, relevancia, country, city, opening_hours, website, category FROM locations WHERE lower(titulo) = ANY($1) LIMIT 500;`;
    const fetchRes = await client.query(fetchSql, [tituloList]);
    const rows = (fetchRes.rows || []).map(r => ({
      id: r.id,
      titulo: r.titulo,
      latitud: r.latitud,
      longitud: r.longitud,
      imagenes: r.imagenes || null,
      relevancia: r.relevancia || 5,
      country: r.country || country || null,
      city: r.city || city || null
    }));

    return rows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.warn('persistOsmCandidatesToDb (bulk) failed:', err?.message || err);
    return [];
  } finally {
    if (mustRelease && client && typeof client.release === 'function') client.release();
  }
}

/* ---------- Main exported function (unchanged logic but uses bulk persist) ---------- */
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
        SELECT l.id, l.titulo, l.fk_interest, l.latitud, l.longitud, l.imagenes, l.relevancia, l.country, l.city
        FROM locations l
        WHERE
          (l.fk_interest IS NOT NULL AND lower(l.fk_interest) = ANY($2))
          OR (l.fk_interest ~ '^[0-9]+$' AND (l.fk_interest::int = ANY($3)))
        ORDER BY l.relevancia DESC NULLS LAST
        LIMIT $1
      `;
      const rPrimary = await db.query(qPrimary, [primaryLimit, slugs, idsParam]);
      const primaryRows = rPrimary.rows || [];

      const qGeneral = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country, city FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`;
      const rGeneral = await db.query(qGeneral, [generalLimit]);
      const generalRows = rGeneral.rows || [];

      // merge preserving order, dedupe by id
      const byId = new Map();
      for (const rr of primaryRows) byId.set(String(rr.id), rr);
      for (const rr of generalRows) if (!byId.has(String(rr.id))) byId.set(String(rr.id), rr);

      rows = Array.from(byId.values());
    } else {
      const q = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country, city FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`;
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

  // Persist new OSM candidates into DB (so next request will pick them from DB) - bulk upsert
  if (Array.isArray(osmCandidates) && osmCandidates.length && db) {
    try {
      const insertedRows = await persistOsmCandidatesToDb(osmCandidates, db, country, geo && geo.raw && geo.raw.display_name ? (geo.raw.display_name.split(',')[0] || null) : null);
      if (insertedRows && insertedRows.length) {
        const normInserted = insertedRows.map(r => ({
          id: r.id,
          titulo: r.titulo,
          fk_interest: null,
          lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null,
          lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null,
          imagenes: r.imagenes || null,
          relevancia: r.relevancia || 5,
          country: r.country || country || null,
          city: r.city || null,
          source: 'db+osm'
        }));
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
