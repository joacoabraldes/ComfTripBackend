// services/poi.service.js
// Improved POI fetcher that prefers DB city entries; falls back to OpenTripMap, then OSM when DB has none.

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
const OPENTRIPMAP_API_KEY = process.env.OPENTRIPMAP_API_KEY || "5ae2e3f221c38a28845f05b6fc9e3160c40397c5b7a3ae2bdb772d93";
const OPENTRIPMAP_BASE_URL = process.env.OPENTRIPMAP_BASE_URL || "https://api.opentripmap.com/0.1/en";

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

  let relev = 5;
  if (tags.wikidata || tags.wikipedia) relev = Math.max(relev, 7);

  return {
    titulo: name.trim(),
    latitud: lat,
    longitud: lon,
    relevancia: relev,
    descripcion: JSON.stringify({ source: 'osm', tags }).slice(0, 2000),
    opening_hours: opening_hours ? { raw: opening_hours } : null,
    website,
    imagenes: photos.length ? photos : null,
    category
  };
}

/* merge/dedupe */
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
          opentripmap: { ...(ex.opentripmap || {}), ...(inc.opentripmap || {}) },
          source: ex.source === 'db' ? (inc.source === 'opentripmap' ? 'db+opentripmap' : inc.source === 'osm' ? 'db+osm' : 'db') : inc.source
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

/* ---------- nominatim geocode (unchanged) ---------- */
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

/* ---------- OpenTripMap API functions ---------- */
/**
 * Search POIs within a radius using OpenTripMap API
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} radius - Radius in meters (default: 10000 = 10km)
 * @param {number} limit - Maximum number of results (default: 50)
 * @returns {Promise<Array>} Array of POI objects with xid, name, kinds, point
 */
async function searchOpenTripMapRadius(lat, lon, radius = 10000, limit = 50) {
  if (!OPENTRIPMAP_API_KEY || OPENTRIPMAP_API_KEY === "5ae2e3f221c38a28845f05b6fc9e3160c40397c5b7a3ae2bdb772d93") {
    console.warn('OpenTripMap API key not configured');
    return [];
  }

  try {
    const url = `${OPENTRIPMAP_BASE_URL}/places/radius?lat=${lat}&lon=${lon}&radius=${radius}&limit=${limit}&apikey=${OPENTRIPMAP_API_KEY}`;
    const resp = await fetchWithTimeout(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ComfTripBackend/1.0'
      }
    }, 15000);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenTripMap radius search ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    
    return data.map(item => ({
      xid: item.xid,
      name: item.name || null,
      kinds: item.kinds ? item.kinds.split(',') : [],
      lat: item.point?.lat ? Number(item.point.lat) : null,
      lon: item.point?.lon ? Number(item.point.lon) : null,
      rate: item.rate || null,
      osm: item.osm || null,
      wikidata: item.wikidata || null
    })).filter(item => item.xid && item.name && item.lat !== null && item.lon !== null);
  } catch (err) {
    console.warn('searchOpenTripMapRadius failed:', err?.message || err);
    return [];
  }
}

/**
 * Get detailed information about a POI using its xid
 * @param {string} xid - OpenTripMap xid identifier
 * @returns {Promise<Object|null>} Detailed POI information
 */
async function getOpenTripMapDetails(xid) {
  if (!OPENTRIPMAP_API_KEY || OPENTRIPMAP_API_KEY === "5ae2e3f221c38a28845f05b6fc9e3160c40397c5b7a3ae2bdb772d93") {
    return null;
  }

  if (!xid) return null;

  try {
    const url = `${OPENTRIPMAP_BASE_URL}/places/xid/${encodeURIComponent(xid)}?apikey=${OPENTRIPMAP_API_KEY}`;
    const resp = await fetchWithTimeout(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ComfTripBackend/1.0'
      }
    }, 10000);

    if (!resp.ok) {
      if (resp.status === 404) return null; // POI not found
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenTripMap details ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data;
  } catch (err) {
    console.warn(`getOpenTripMapDetails failed for xid ${xid}:`, err?.message || err);
    return null;
  }
}

/**
 * Map OpenTripMap kinds to our interest categories
 */
const OPENTRIPMAP_KINDS_TO_INTEREST = {
  'restaurants': 'gastronomia',
  'cafes': 'gastronomia',
  'bars': 'gastronomia',
  'fast_food': 'gastronomia',
  'pubs': 'gastronomia',
  'museums': 'cultura',
  'galleries': 'cultura',
  'theatres': 'cultura',
  'monuments': 'cultura',
  'memorials': 'cultura',
  'parks': 'naturaleza',
  'gardens': 'naturaleza',
  'viewpoints': 'naturaleza',
  'beaches': 'naturaleza',
  'stadiums': 'deportes',
  'sports': 'deportes',
  'shops': 'compras',
  'markets': 'compras',
  'nightclubs': 'nocturna',
  'clubs': 'nocturna'
};

/**
 * Normalize OpenTripMap POI details to our database format
 * @param {Object} details - OpenTripMap details object
 * @param {Object} basicInfo - Basic info from radius search (xid, name, lat, lon, kinds)
 * @returns {Object|null} Normalized POI data for database insertion
 */
function normalizeOpenTripMapForInsert(details, basicInfo) {
  if (!basicInfo || !basicInfo.name || basicInfo.lat === null || basicInfo.lon === null) {
    return null;
  }

  // Extract image from details
  let images = null;
  if (details) {
    const imageUrls = [];
    if (details.preview && details.preview.source) {
      imageUrls.push(details.preview.source);
    }
    if (details.image && typeof details.image === 'string') {
      imageUrls.push(details.image);
    }
    if (details.images && Array.isArray(details.images)) {
      details.images.forEach(img => {
        if (img && img.source) imageUrls.push(img.source);
        else if (typeof img === 'string') imageUrls.push(img);
      });
    }
    if (imageUrls.length > 0) {
      images = imageUrls.slice(0, 6);
    }
  }

  // Extract description
  let description = null;
  if (details) {
    if (details.wikipedia_extracts && details.wikipedia_extracts.text) {
      description = details.wikipedia_extracts.text.slice(0, 2000);
    } else if (details.info && details.info.descr) {
      description = details.info.descr.slice(0, 2000);
    } else if (details.wikidata && typeof details.wikidata === 'string') {
      description = `Wikidata: ${details.wikidata}`;
    }
  }

  // Determine category from kinds
  let category = null;
  if (basicInfo.kinds && basicInfo.kinds.length > 0) {
    const primaryKind = basicInfo.kinds[0].split('_')[0]; // Get first part of kind
    category = primaryKind;
  }

  // Calculate relevance based on rate, wikidata, wikipedia
  let relevancia = 5;
  if (basicInfo.rate) {
    relevancia = Math.max(relevancia, Number(basicInfo.rate) || 5);
  }
  if (details && (details.wikidata || details.wikipedia)) {
    relevancia = Math.max(relevancia, 7);
  }

  // Extract website
  let website = null;
  if (details && details.url) {
    website = details.url;
  } else if (details && details.wikipedia) {
    website = `https://${details.wikipedia}`;
  }

  return {
    titulo: basicInfo.name.trim(),
    latitud: basicInfo.lat,
    longitud: basicInfo.lon,
    relevancia,
    descripcion: description || JSON.stringify({ source: 'opentripmap', xid: basicInfo.xid, kinds: basicInfo.kinds }).slice(0, 2000),
    opening_hours: null, // OpenTripMap doesn't provide this
    website,
    imagenes: images,
    category,
    opentripmap: {
      xid: basicInfo.xid,
      kinds: basicInfo.kinds,
      rate: basicInfo.rate,
      wikidata: details?.wikidata || basicInfo.wikidata || null,
      wikipedia: details?.wikipedia || null
    }
  };
}

/**
 * Fetch OpenTripMap POIs and get their details, then normalize for DB insertion
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} radius - Search radius in meters
 * @param {number} limit - Maximum number of POIs to fetch
 * @returns {Promise<Array>} Array of normalized POI objects ready for DB insertion
 */
async function fetchOpenTripMapPOIs(lat, lon, radius = 10000, limit = 50) {
  try {
    // Step 1: Search POIs by radius
    const radiusResults = await searchOpenTripMapRadius(lat, lon, radius, limit);
    if (!radiusResults || radiusResults.length === 0) {
      return [];
    }

    console.info(`OpenTripMap: Found ${radiusResults.length} POIs, fetching details...`);

    // Step 2: Fetch details for each POI (with rate limiting)
    const detailsPromises = [];
    const BATCH_SIZE = 5; // Process 5 at a time to avoid rate limits
    const normalizedPOIs = [];

    for (let i = 0; i < radiusResults.length; i += BATCH_SIZE) {
      const batch = radiusResults.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (poi) => {
        const details = await getOpenTripMapDetails(poi.xid);
        const normalized = normalizeOpenTripMapForInsert(details, poi);
        if (normalized) {
          normalized._raw = { basic: poi, details };
          normalizedPOIs.push(normalized);
        }
        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 200));
      });

      await Promise.all(batchPromises);
    }

    console.info(`OpenTripMap: Successfully normalized ${normalizedPOIs.length} POIs`);
    return normalizedPOIs;
  } catch (err) {
    console.warn('fetchOpenTripMapPOIs failed:', err?.message || err);
    return [];
  }
}

/**
 * Persist OpenTripMap candidates to DB (reuses existing bulk upsert logic)
 */
async function persistOpenTripMapCandidatesToDb(otmCandidates = [], db, country = null, city = null) {
  if (!Array.isArray(otmCandidates) || otmCandidates.length === 0) return [];
  
  // Reuse the same persist logic as OSM, but with OpenTripMap normalized data
  const norm = otmCandidates.map(c => {
    // Remove _raw before insertion
    const { _raw, opentripmap, ...clean } = c;
    return clean;
  }).filter(c => c && c.titulo && c.latitud !== null && c.longitud !== null);

  if (!norm.length) return [];

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
    await client.query(updateByTitleSql, [country || null, city || null]);

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
    await client.query(updateByProxSql, [LAT_LNG_EPS, /*unused*/null, country || null, city || null]);

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
    await client.query(insertSql, [country || null, city || null, LAT_LNG_EPS]);

    await client.query('COMMIT');

    const tituloList = norm.map(n => (n.titulo || '').toLowerCase()).filter(Boolean);
    if (!tituloList.length) return [];
    const fetchSql = `SELECT id, titulo, latitud, longitud, imagenes, relevancia, country, city, opening_hours, website, category FROM locations WHERE lower(titulo) = ANY($1) LIMIT 70;`;
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
    console.warn('persistOpenTripMapCandidatesToDb (bulk) failed:', err?.message || err);
    return [];
  } finally {
    if (mustRelease && client && typeof client.release === 'function') client.release();
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
out center ${Math.min(limit, 70)};`;

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
const LAT_LNG_EPS = 0.0006; // ~50-70 meters

async function persistOsmCandidatesToDb(osmCandidates = [], db, country = null, city = null) {
  if (!Array.isArray(osmCandidates) || osmCandidates.length === 0) return [];
  const norm = [];
  for (const c of osmCandidates) {
    const raw = c._raw || c;
    const candidate = normalizeOsmForInsert(raw);
    if (candidate) norm.push(candidate);
  }
  if (!norm.length) return [];

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
    await client.query(updateByTitleSql, [country || null, city || null]);

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
    await client.query(updateByProxSql, [LAT_LNG_EPS, /*unused*/null, country || null, city || null]);

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
    await client.query(insertSql, [country || null, city || null, LAT_LNG_EPS]);

    await client.query('COMMIT');

    const tituloList = norm.map(n => (n.titulo || '').toLowerCase()).filter(Boolean);
    if (!tituloList.length) return [];
    const fetchSql = `SELECT id, titulo, latitud, longitud, imagenes, relevancia, country, city, opening_hours, website, category FROM locations WHERE lower(titulo) = ANY($1) LIMIT 70;`;
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

  // derive city/country guesses from destination (best-effort)
  let cityGuess = null;
  let countryGuess = country || null;
  if (destination && typeof destination === 'string') {
    if (destination.includes(',')) {
      const parts = destination.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length) {
        countryGuess = countryGuess || parts[parts.length - 1];
        cityGuess = parts.slice(0, parts.length - 1).join(', ');
      }
    } else {
      const parts = destination.trim().split(/\s+/);
      if (parts.length > 1) {
        countryGuess = countryGuess || parts[parts.length - 1];
        cityGuess = parts.slice(0, parts.length - 1).join(' ');
      } else {
        // single token: treat as city
        cityGuess = destination.trim();
      }
    }
  }

  // 1) Try to fetch locations directly from DB by city if we have a city guess.
  //    If any rows found for that city, use up to 100 of them and DO NOT call nominatim/overpass.
  let rows = [];
  try {
    if (cityGuess) {
      // first attempt exact equality on city
      const qExact = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country, city, opening_hours, website, category
                      FROM locations
                      WHERE lower(city) = lower($1)
                      ORDER BY relevancia DESC NULLS LAST
                      LIMIT 100`;
      const rExact = await db.query(qExact, [cityGuess]);
      if (rExact.rows && rExact.rows.length) {
        rows = rExact.rows;
        // set countryGuess if missing from row
        if (!countryGuess && rows[0] && rows[0].country) countryGuess = rows[0].country;
      } else {
        // partial match: city ILIKE '%cityGuess%'
        const qLike = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country, city, opening_hours, website, category
                       FROM locations
                       WHERE city ILIKE $1
                       ORDER BY relevancia DESC NULLS LAST
                       LIMIT 100`;
        const rLike = await db.query(qLike, [`%${cityGuess}%`]);
        if (rLike.rows && rLike.rows.length) {
          rows = rLike.rows;
          if (!countryGuess && rows[0] && rows[0].country) countryGuess = rows[0].country;
        } else {
          // fallback: maybe destinations stored in country only - try exact country
          if (countryGuess) {
            const qCountry = `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country, city, opening_hours, website, category
                              FROM locations
                              WHERE lower(country) = lower($1)
                              ORDER BY relevancia DESC NULLS LAST
                              LIMIT 100`;
            const rCountry = await db.query(qCountry, [countryGuess]);
            if (rCountry.rows && rCountry.rows.length) {
              rows = rCountry.rows;
            }
          }
        }
      }

      // if we found city rows, return them immediately (after normalization & scoring)
      if (rows && rows.length) {
        const dbCandidatesAll = rows.map(normalizeDbRow);

        // compute geo center from first row so we can return distance_to_center
        const first = dbCandidatesAll[0];
        const geo = (first && first.lat && first.lng) ? { lat: first.lat, lon: first.lng, bbox: null, raw: null } : null;

        // build interest tag set
        const interestTags = new Set();
        if (Array.isArray(interestSlugs)) {
          for (const s of interestSlugs) {
            const tags = INTEREST_TO_OSM[s];
            if (Array.isArray(tags)) tags.forEach(t => interestTags.add(t));
            interestTags.add(String(s).toLowerCase());
          }
        }

        // compute maxRelev
        const maxRelev = Math.max(1, ...dbCandidatesAll.map(c => (c.relevancia || 0)));

        const candidates = dbCandidatesAll.map(c => {
          const lat = c.lat;
          const lng = c.lng;
          let isMust = false;
          if (explicitMusts.length && c.titulo) {
            for (const mv of explicitMusts) { if (c.titulo.toLowerCase().includes(mv.toLowerCase())) { isMust = true; break; } }
          }
          const dbRelev = Number(c.relevancia || 0);
          const normRelevScore = 1 + ((dbRelev / maxRelev) * 4);
          let interestMatch = false;
          if (c.fk_interest && typeof c.fk_interest === 'string') {
            if (interestTags.has(c.fk_interest.toLowerCase())) interestMatch = true;
          }
          const interestBoost = interestMatch ? 0.35 : 0.0;
          const mustBoost = isMust ? 0.5 : 0.0;
          let combined = normRelevScore + interestBoost + mustBoost;
          if (!Number.isFinite(combined)) combined = normRelevScore;
          combined = Math.min(5, combined);
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
            opentripmap: c.opentripmap || null,
            isMust,
            combined_score: combined,
            distance_to_center: distanceToCenter
          };
        });

        // sort and limit
        candidates.sort((a,b) => {
          if (a.isMust && !b.isMust) return -1;
          if (!a.isMust && b.isMust) return 1;
          const cs = (b.combined_score || 0) - (a.combined_score || 0);
          if (Math.abs(cs) > 1e-6) return cs;
          const da = a.distance_to_center || Number.POSITIVE_INFINITY;
          const db = b.distance_to_center || Number.POSITIVE_INFINITY;
          return da - db;
        });

        return candidates.slice(0, Math.min(limit, 70));
      }
    }
  } catch (err) {
    console.warn('DB city-first fetch failed:', err?.message || err);
    // continue to fallback path (geocode + OSM)
  }

  // If we reach here, we didn't return on city-match. Continue with original logic:
  // geocode destination (only now, when DB didn't contain city rows)
  let geo = null;
  if (destination) geo = await geocodeDestination(destination);
  else if (country) geo = await geocodeDestination(country);

  // 2) Query DB fallback (interest-focused + general top relevancia)
  try {
    if (Array.isArray(interestSlugs) && interestSlugs.length) {
      const slugs = interestSlugs.map(s => String(s).toLowerCase());
      const primaryLimit = Math.ceil(limit * 0.6);
      const generalLimit = Math.max(10, Math.floor(limit * 0.4));

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

  // 3) Query OpenTripMap when needed (only if dbCandidates insufficient or explicitMusts)
  let otmCandidates = [];
  const needExtra = dbCandidates.length < Math.min(limit, 60) || explicitMusts.length > 0 || !geo;
  
  if (geo && geo.lat && geo.lon && (needExtra || dbCandidates.length === 0)) {
    try {
      // Calculate radius based on bbox or use default
      let radius = 10000; // Default 10km
      if (Array.isArray(geo.bbox) && geo.bbox.length === 4) {
        const [s, w, n, e] = geo.bbox;
        const diagonal = haversineMeters(s, w, n, e);
        radius = Math.max(5000, Math.min(20000, Math.round(diagonal / 2))); // 5-20km
      }
      
      const needed = Math.max(50, limit - dbCandidates.length);
      console.info(`OpenTripMap: Fetching POIs for lat=${geo.lat}, lon=${geo.lon}, radius=${radius}m, limit=${needed}`);
      
      const otmPOIs = await fetchOpenTripMapPOIs(geo.lat, geo.lon, radius, needed);
      
      // Convert to candidate format
      otmCandidates = otmPOIs.map(poi => ({
        id: `otm-${poi.opentripmap?.xid || Date.now()}`,
        titulo: poi.titulo,
        fk_interest: null,
        lat: poi.latitud,
        lng: poi.longitud,
        imagenes: poi.imagenes,
        relevancia: poi.relevancia || 5,
        source: 'opentripmap',
        opentripmap: poi.opentripmap || null,
        _raw: poi._raw
      }));

      console.info(`OpenTripMap: Retrieved ${otmCandidates.length} candidates`);
    } catch (err) {
      console.warn('OpenTripMap query failed:', err?.message || err);
      otmCandidates = [];
    }
  }

  // Persist new OpenTripMap candidates into DB (so next request will pick them from DB)
  if (Array.isArray(otmCandidates) && otmCandidates.length && db) {
    try {
      const cityName = geo && geo.raw && geo.raw.display_name ? (geo.raw.display_name.split(',')[0] || null) : null;
      const insertedRows = await persistOpenTripMapCandidatesToDb(otmCandidates, db, countryGuess, cityName);
      if (insertedRows && insertedRows.length) {
        const normInserted = insertedRows.map(r => ({
          id: r.id,
          titulo: r.titulo,
          fk_interest: null,
          lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null,
          lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null,
          imagenes: r.imagenes || null,
          relevancia: r.relevancia || 5,
          country: r.country || countryGuess || null,
          city: r.city || cityName || null,
          source: 'db+opentripmap'
        }));
        for (const ni of normInserted) {
          if (!dbCandidatesAll.find(x => String(x.id) === String(ni.id))) dbCandidatesAll.push(ni);
        }
      }
    } catch (err) {
      console.warn('persistOpenTripMapCandidatesToDb failed:', err?.message || err);
    }
  }

  // 4) Fallback to OSM/Overpass if OpenTripMap didn't provide enough results (optional)
  let osmCandidates = [];
  const stillNeedMore = (dbCandidates.length + otmCandidates.length) < Math.min(limit, 60);
  if (stillNeedMore && geo && geo.bbox) {
    const nameRegexes = explicitMusts.map(s => escapeRegex(s)).slice(0, 10);
    try {
      const bbox = geo.bbox;
      if (bbox && bbox.length === 4) {
        const remaining = Math.max(20, limit - dbCandidates.length - otmCandidates.length);
        osmCandidates = await queryOverpassByBBox(bbox, nameRegexes, remaining, interestSlugs);
        console.info(`Overpass fallback: Retrieved ${osmCandidates.length} additional candidates`);
      }
    } catch (err) {
      console.warn('Overpass fallback query failed:', err?.message || err);
      osmCandidates = [];
    }
  }

  // Persist OSM fallback candidates if any
  if (Array.isArray(osmCandidates) && osmCandidates.length && db) {
    try {
      const cityName = geo && geo.raw && geo.raw.display_name ? (geo.raw.display_name.split(',')[0] || null) : null;
      const insertedRows = await persistOsmCandidatesToDb(osmCandidates, db, countryGuess, cityName);
      if (insertedRows && insertedRows.length) {
        const normInserted = insertedRows.map(r => ({
          id: r.id,
          titulo: r.titulo,
          fk_interest: null,
          lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null,
          lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null,
          imagenes: r.imagenes || null,
          relevancia: r.relevancia || 5,
          country: r.country || countryGuess || null,
          city: r.city || cityName || null,
          source: 'db+osm'
        }));
        for (const ni of normInserted) {
          if (!dbCandidatesAll.find(x => String(x.id) === String(ni.id))) dbCandidatesAll.push(ni);
        }
      }
    } catch (err) {
      console.warn('persistOsmCandidatesToDb (fallback) failed:', err?.message || err);
    }
  }

  // 5) Merge & dedupe DB + OpenTripMap + OSM candidates
  let candidates = dedupeMerge(dbCandidates, otmCandidates, 75);
  candidates = dedupeMerge(candidates, osmCandidates, 75);

  // 6) Ensure explicit mustVisits are included (try Overpass again for missing named musts)
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

  // 7) Use DB relevancia as primary signal; filter out items without coords (pref) and compute combined_score
  candidates = candidates.filter(c => c && c.lat !== null && c.lng !== null);

  if (!candidates.length) {
    // fallback: return top db candidates (may include ones without coords)
    return dbCandidatesAll.slice(0, limit).map(c => ({
      id: c.id,
      titulo: c.titulo,
      fk_interest: c.fk_interest || null,
      lat: c.lat,
      lng: c.lng,
      imagenes: c.imagenes || null,
      relevancia: c.relevancia || 0,
      source: c.source || 'db',
      osm: c.osm || null,
      opentripmap: c.opentripmap || null,
      isMust: (explicitMusts.length && c.titulo) ? explicitMusts.some(mv => c.titulo.toLowerCase().includes(mv.toLowerCase())) : false,
      combined_score: c.relevancia || 0,
      distance_to_center: (geo && geo.lat && c.lat && c.lng) ? Math.round(haversineMeters(geo.lat, geo.lon, c.lat, c.lng)) : null
    }));
  }

  const maxRelev = Math.max(1, ...candidates.map(c => (c.relevancia || 0)));

  const interestTags = new Set();
  if (Array.isArray(interestSlugs)) {
    for (const s of interestSlugs) {
      const tags = INTEREST_TO_OSM[s];
      if (Array.isArray(tags)) tags.forEach(t => interestTags.add(t));
      interestTags.add(String(s).toLowerCase());
    }
  }

  candidates = candidates.map(c => {
    const lat = c.lat !== null && c.lat !== undefined ? Number(c.lat) : null;
    const lng = c.lng !== null && c.lng !== undefined ? Number(c.lng) : null;

    let isMust = false;
    if (explicitMusts.length && c.titulo) {
      for (const mv of explicitMusts) { if (c.titulo.toLowerCase().includes(mv.toLowerCase())) { isMust = true; break; } }
    }

    const dbRelev = Number(c.relevancia || 0);
    const normRelevScore = 1 + ((dbRelev / maxRelev) * 4);

    let interestMatch = false;
    if (c.fk_interest && typeof c.fk_interest === 'string') {
      if (interestTags.has(c.fk_interest.toLowerCase())) interestMatch = true;
    }
    if (!interestMatch && c.osm && c.osm.tags) {
      const amenOrTour = (c.osm.tags.amenity || c.osm.tags.tourism || c.osm.tags.leisure || '').toString().toLowerCase();
      if (interestTags.has(amenOrTour)) interestMatch = true;
    }
    if (!interestMatch && c.opentripmap && c.opentripmap.kinds) {
      // Check if any OpenTripMap kind matches our interests
      for (const kind of c.opentripmap.kinds) {
        const kindBase = kind.split('_')[0].toLowerCase();
        if (interestTags.has(kindBase)) {
          interestMatch = true;
          break;
        }
        // Also check mapped interests
        const mappedInterest = OPENTRIPMAP_KINDS_TO_INTEREST[kind];
        if (mappedInterest && interestTags.has(mappedInterest)) {
          interestMatch = true;
          break;
        }
      }
    }
    const interestBoost = interestMatch ? 0.35 : 0.0;
    const mustBoost = isMust ? 0.5 : 0.0;

    let combined = normRelevScore + interestBoost + mustBoost;
    if (!Number.isFinite(combined)) combined = normRelevScore;
    combined = Math.min(5, combined);

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
      opentripmap: c.opentripmap || null,
      isMust,
      combined_score: combined,
      distance_to_center: distanceToCenter
    };
  });

  // sort
  candidates.sort((a,b) => {
    if (a.isMust && !b.isMust) return -1;
    if (!a.isMust && b.isMust) return 1;
    const cs = (b.combined_score || 0) - (a.combined_score || 0);
    if (Math.abs(cs) > 1e-6) return cs;
    const da = a.distance_to_center || Number.POSITIVE_INFINITY;
    const db = b.distance_to_center || Number.POSITIVE_INFINITY;
    return da - db;
  });

  return candidates.slice(0, limit);
}

/* ---------- exports ---------- */
module.exports = { getCandidates, geocodeDestination };
