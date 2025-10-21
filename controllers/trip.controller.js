// controllers/trip.controller.js
'use strict';

const express = require('express');
const https = require('https');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

// kept: normalizeTripRow and PLACES_AGG_SUBQUERY (used by many endpoints)
function normalizeTripRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    destination: row.destination,
    start_date: row.start_date,
    end_date: row.end_date,
    budget: row.budget,
    notes: row.notes,
    created_at: row.created_at,
  };
}

// PLACES_AGG_SUBQUERY used to aggregate trip_places with locations
const PLACES_AGG_SUBQUERY = `
  SELECT fk_trips,
         json_agg(json_build_object(
           'id', tp.id,
           'fk_location', tp.fk_locations,
           'date', tp.date,
           'start_hour', tp.start_hour,
           'end_hour', tp.end_hour,
           'notes', tp.notes,
           'location', json_build_object(
             'id', l.id,
             'titulo', l.titulo,
             'fk_interest', l.fk_interest,
             'descripcion', l.descripcion,
             'latitude', l.latitud,
             'longitude', l.longitud,
             'imagenes', l.imagenes,
             'relevancia', l.relevancia,
             'opening_hours', l.opening_hours,
             'website', l.website,
             'category', l.category,
             'country', l.country,
             'city', l.city
           )
         ) ORDER BY tp.date, tp.start_hour) AS places
  FROM trip_places tp
  JOIN locations l ON l.id = tp.fk_locations
  GROUP BY fk_trips
`;

// ----------------------
// Itinerary generator helpers
// ----------------------

// Simple helper to add days to an ISO date string and return YYYY-MM-DD
function addDaysToIso(dateIso, days) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

// Map pace -> places per day (accepts multiple synonyms)
const PACE_MAP = {
  relajado: 2,
  medio: 4,
  moderado: 4,
  intenso: 6
};

function normalizePace(p) {
  if (!p) return 'relajado';
  const s = String(p).toLowerCase();
  if (s.includes('relaj')) return 'relajado';
  if (s.includes('intens')) return 'intenso';
  if (s.includes('mod') || s.includes('medi')) return 'medio';
  return 'relajado';
}

// Parse trip.destination into city/country pieces
function parseDestinationParts(dest) {
  if (!dest) return { city: null, country: null };
  const parts = String(dest).split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const single = parts[0];
    const n = normalizeStr(single);
    for (const key of Object.keys(COUNTRY_EQUIV)) {
      if (COUNTRY_EQUIV[key].includes(n)) {
        return { city: null, country: single };
      }
    }
    return { city: single, country: null };
  }
  const country = parts[parts.length - 1];
  const city = parts.slice(0, parts.length - 1).join(', ');
  return { city: city || null, country: country || null };
}

// Haversine distance (km)
function haversineKm(a, b) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad((b.lat - a.lat));
  const dLon = toRad((b.lng - a.lng));
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat/2);
  const sinDLon = Math.sin(dLon/2);
  const x = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  return R * c;
}

// Simple k-means clustering on lat/lng with small iteration count
function kmeans(points, k, maxIter = 10) {
  if (k <= 0) return [];
  if (points.length === 0) return Array.from({length:k}, () => []);

  const centers = [];
  centers.push({ lat: points[0].lat, lng: points[0].lng });
  while (centers.length < k) {
    let bestIdx = 0; let bestDist = -1;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let dmin = Infinity;
      for (const c of centers) {
        const d = haversineKm(p, c);
        if (d < dmin) dmin = d;
      }
      if (dmin > bestDist) { bestDist = dmin; bestIdx = i; }
    }
    centers.push({ lat: points[bestIdx].lat, lng: points[bestIdx].lng });
  }

  let clusters = [];
  for (let iter = 0; iter < maxIter; iter++) {
    clusters = Array.from({length:k}, () => []);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let best = 0; let bestD = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const d = haversineKm(p, centers[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      clusters[best].push(i);
    }
    let moved = false;
    for (let j = 0; j < k; j++) {
      if (clusters[j].length === 0) continue;
      let sumLat = 0, sumLng = 0;
      for (const idx of clusters[j]) { sumLat += points[idx].lat; sumLng += points[idx].lng; }
      const newC = { lat: sumLat / clusters[j].length, lng: sumLng / clusters[j].length };
      if (Math.abs(newC.lat - centers[j].lat) > 1e-6 || Math.abs(newC.lng - centers[j].lng) > 1e-6) moved = true;
      centers[j] = newC;
    }
    if (!moved) break;
  }
  return clusters;
}

// Estimate travel minutes between two points assuming average transport speed
function estimateTravelMinutes(a, b, mode = 'fast') {
  const km = haversineKm(a, b);
  const speedKmh = mode === 'walk' ? 5 : (mode === 'bike' ? 12 : 30);
  return (km / speedKmh) * 60; // minutes
}

// Format time (HH:MM:SS) given start minutes from midnight
function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

// Determine if a place is gastronomia by category or keywords
function isGastronomia(place) {
  const cat = (place.category || '').toString().toLowerCase();
  if (cat) {
    if (cat.includes('gastronom') || cat.includes('restaurant') || cat.includes('cafe') || cat.includes('bar') || cat.includes('pub') || cat.includes('fast_food')) return true;
  }
  const t = (place.titulo || '').toString().toLowerCase();
  if (t.includes('rest') || t.includes('café') || t.includes('cafe') || t.includes('bar') || t.includes('cafeter') || t.includes('parrilla')) return true;
  return false;
}

// ----- Country matching helpers -----
// small mapping of common names to canonical tokens
const COUNTRY_EQUIV = {
  'spain': ['spain','españa','espana','reino de españa','es'],
  'italy': ['italy','italia','italie','it'],
  'france': ['france','francia','fr'],
  'germany': ['germany','deutschland','alemania','de'],
  'argentina': ['argentina','ar']
};

function normalizeStr(s) {
  if (!s) return '';
  return s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function getCountryVariants(destCountry) {
  const n = normalizeStr(destCountry);
  for (const key of Object.keys(COUNTRY_EQUIV)) {
    if (COUNTRY_EQUIV[key].includes(n)) {
      return COUNTRY_EQUIV[key].map(x => normalizeStr(x));
    }
  }
  return [n];
}

function countryMatches(candidateCountry, destCountry) {
  if (!candidateCountry || !destCountry) return false;
  const cand = normalizeStr(candidateCountry);
  const variants = getCountryVariants(destCountry);
  const candTokens = cand.split(/\W+/).filter(Boolean);
  for (const v of variants) {
    if (cand === v) return true;
    if (cand.includes(v)) return true;
    if (candTokens.includes(v)) return true;
  }
  const destTokens = normalizeStr(destCountry).split(/\W+/).filter(Boolean);
  for (const t of destTokens) {
    if (candTokens.includes(t)) return true;
    if (cand.includes(t)) return true;
  }
  return false;
}

// ----------------------
// AI integration helpers (new)
// ----------------------

// Try to call HuggingFace router/chat endpoint. If unavailable or fails, we fallback to a heuristic generator.
async function callHfRouter(prompt, timeoutMs = 5000) {
  const HF_ROUTER_URL = process.env.HF_ROUTER_URL;
  const HF_API_TOKEN = process.env.HF_API_TOKEN;
  const HF_MODEL = process.env.HF_MODEL;

  if (!HF_ROUTER_URL || !HF_API_TOKEN || !HF_MODEL) throw new Error('HF not configured');

  const body = JSON.stringify({
    model: HF_MODEL,
    input: [
      {
        role: "user",
        content: `You are a helpful assistant that returns ONLY valid JSON (no explanations).
Return a JSON object with keys:
{
  "prefer_titles": ["short phrases to prioritize in location titles (max 6)"],
  "prefer_interests": ["interest slugs or keywords (max 6)"]
}
Given this user prompt: ${prompt}
Make values short, lowercase when possible.`
      }
    ]
  });

  const url = new URL(HF_ROUTER_URL);

  const options = {
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname + (url.search || ''),
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HF_API_TOKEN}`
    },
    timeout: timeoutMs
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          let txt = null;
          if (parsed.responses && parsed.responses.length && typeof parsed.responses[0].generated_text === 'string') {
            txt = parsed.responses[0].generated_text;
          } else if (parsed.output && typeof parsed.output[0] === 'string') {
            txt = parsed.output[0];
          } else if (parsed.generated_text && typeof parsed.generated_text === 'string') {
            txt = parsed.generated_text;
          } else if (typeof parsed === 'string') {
            txt = parsed;
          } else {
            const maybe = data.match(/{[\s\S]*}/);
            if (maybe) txt = maybe[0];
          }

          if (!txt) {
            try {
              const j = JSON.parse(data);
              return resolve(j);
            } catch (e) {
              return reject(new Error('HF returned unexpected shape'));
            }
          }

          try {
            const j2 = JSON.parse(txt);
            return resolve(j2);
          } catch (err) {
            const maybe = txt.match(/{[\s\S]*}/);
            if (maybe) {
              try { return resolve(JSON.parse(maybe[0])); } catch (e) { return reject(new Error('HF json parse failed')); }
            }
            return reject(new Error('HF output not JSON'));
          }
        } catch (err) {
          const maybe = data.match(/{[\s\S]*}/);
          if (maybe) {
            try { return resolve(JSON.parse(maybe[0])); } catch (e) { return reject(new Error('HF parse fallback failed')); }
          }
          return reject(err);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('HF request timeout')); });
    req.write(body);
    req.end();
  });
}

// Local heuristic "AI" fallback: generate prefer_titles / prefer_interests based on destination and pace.
function heuristicAiSuggestions(destCountry, destCity, pace) {
  const out = { prefer_titles: [], prefer_interests: [] };
  const target = (destCity || destCountry || '').toString().toLowerCase();

  if (target.includes('spain') || target.includes('espa')) {
    out.prefer_interests.push('museums', 'historic', 'architecture');
    out.prefer_titles.push('plaza', 'museo', 'catedral', 'real', 'parque');
  } else if (target.includes('italy') || target.includes('italia')) {
    out.prefer_interests.push('historic', 'architecture', 'monument');
    out.prefer_titles.push('coliseo', 'pantheon', 'fontana', 'piazza', 'duomo');
  } else if (target.includes('argentina') || target.includes('buenos')) {
    out.prefer_interests.push('historic', 'museums');
    out.prefer_titles.push('teatro', 'museo', 'plaza', 'obelisco');
  } else {
    out.prefer_interests.push('historic', 'culture', 'parks');
    out.prefer_titles.push('museum', 'plaza', 'park', 'cathedral');
  }

  if (pace === 'intenso') {
    out.prefer_titles.push('mirador', 'viewpoint', 'tour');
  } else if (pace === 'relajado') {
    out.prefer_titles.push('park', 'jardin', 'cafe');
  }
  out.prefer_titles = Array.from(new Set(out.prefer_titles)).slice(0,6);
  out.prefer_interests = Array.from(new Set(out.prefer_interests)).slice(0,6);
  return out;
}

// Wrapper: try HF, else fallback heuristic
async function getAiSuggestions(destCountry, destCity, pace) {
  const prompt = `Generate short location keywords for destination country="${destCountry}" city="${destCity}" pace="${pace}". Return only JSON as described.`;
  try {
    const j = await callHfRouter(prompt, 4000);
    const prefer_titles = Array.isArray(j.prefer_titles) ? j.prefer_titles.map(x => String(x).trim()).filter(Boolean).slice(0,6) : [];
    const prefer_interests = Array.isArray(j.prefer_interests) ? j.prefer_interests.map(x => String(x).trim()).filter(Boolean).slice(0,6) : [];
    if (prefer_titles.length || prefer_interests.length) return { prefer_titles, prefer_interests };
    return heuristicAiSuggestions(destCountry, destCity, pace);
  } catch (err) {
    return heuristicAiSuggestions(destCountry, destCity, pace);
  }
}

// ----------------------
// Itinerary generator: strict-country variant (AI-enhanced)
// ----------------------

async function handleItinerary(req, res) {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const body = req.body || {};
    const paceRaw = body.pace || 'relajado';
    const pace = normalizePace(paceRaw);
    const save = !!body.save;
    const mandatoryPlaceNames = Array.isArray(body.places) ? body.places.map(String).filter(Boolean) : [];

    // fetch trip and ownership
    const tripRes = await client.query('SELECT id, user_id, destination, start_date, end_date FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    const trip = tripRes.rows[0];
    if (trip.user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // determine inclusive date range
    const startDate = trip.start_date ? trip.start_date.toISOString().slice(0,10) : (new Date()).toISOString().slice(0,10);
    const endDate = trip.end_date ? trip.end_date.toISOString().slice(0,10) : startDate;
    const startD = new Date(startDate + 'T00:00:00Z');
    const endD = new Date(endDate + 'T00:00:00Z');
    const days = Math.max(1, Math.round((endD - startD) / (24*3600*1000)) + 1);

    const perDay = PACE_MAP[pace] || PACE_MAP['relajado'];
    const totalNeeded = perDay * days;

    // Fetch user interests
    const uiRes = await client.query(
      `SELECT i.id, i.slug, i.title
       FROM user_interests ui
       JOIN interests i ON i.id = ui.interest_id
       WHERE ui.user_id = $1`,
      [userId]
    );
    const interestIds = uiRes.rows.map(r => r.id);

    // parse trip.destination into city/country
    const { city: destCityRaw, country: destCountryRaw } = parseDestinationParts(trip.destination);
    const destCity = destCityRaw ? destCityRaw.toString() : null;
    const destCountry = destCountryRaw ? destCountryRaw.toString() : null;

    // Validate mandatory places: only accept as satisfied if they exist inside destination country (if country provided)
    if (destCountry && mandatoryPlaceNames.length) {
      const missing = [];
      for (const name of mandatoryPlaceNames) {
        const r = await client.query('SELECT id, country FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${name}%`]);
        if (!r.rows.length) { missing.push(name); continue; }
        const foundCountry = r.rows[0].country;
        if (!countryMatches(foundCountry, destCountry)) missing.push(name);
      }
      if (missing.length) {
        return res.status(400).json({ message: 'Algunas ubicaciones obligatorias no se encuentran en el país destino', missing });
      }
    }

    // --- Get AI suggestions (non-blocking but awaited here) ---
    const ai = await getAiSuggestions(destCountry, destCity, pace);
    // ai = { prefer_titles: [...], prefer_interests: [...] }

    // Build candidate query: **STRICT** behavior when destCountry present: only fetch locations in that country
    let candidateSQL = `SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations`;
    const queryValues = [];
    let idx = 1;
    const preferTitleChecks = [];
    const preferInterestPlaceholders = [];

    if (Array.isArray(ai.prefer_titles) && ai.prefer_titles.length) {
      for (const t of ai.prefer_titles.slice(0,6)) {
        preferTitleChecks.push(`titulo ILIKE $${idx}`);
        queryValues.push(`%${t}%`);
        idx++;
      }
    }
    if (Array.isArray(ai.prefer_interests) && ai.prefer_interests.length) {
      for (const it of ai.prefer_interests.slice(0,6)) {
        preferInterestPlaceholders.push(`$${idx}`);
        queryValues.push(String(it));
        idx++;
      }
    }

    if (destCountry) {
      candidateSQL += ` WHERE country IS NOT NULL AND LOWER(country) LIKE $${idx}`;
      queryValues.push(`%${normalizeStr(destCountry)}%`);
      idx++;

      let orderClause = '';
      const caseParts = [];
      if (preferTitleChecks.length) {
        caseParts.push(`(CASE WHEN (${preferTitleChecks.join(' OR ')}) THEN 1 ELSE 0 END)`);
      }
      if (preferInterestPlaceholders.length) {
        caseParts.push(`(CASE WHEN fk_interest::text IN (${preferInterestPlaceholders.join(',')}) THEN 1 ELSE 0 END)`);
      }
      if (caseParts.length) {
        orderClause = ` ORDER BY (${caseParts.join(' + ')}) DESC, relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      } else {
        orderClause = ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      }
      queryValues.push(Math.max(totalNeeded * 4, 200));
      candidateSQL += orderClause;
    } else {
      const whereClauses = [];

      if (interestIds.length) {
        const placeholders = interestIds.map((_,i)=>`$${idx+i}`).join(',');
        whereClauses.push(`fk_interest::text IN (${placeholders})`);
        for (let i=0;i<interestIds.length;i++) queryValues.push(String(interestIds[i]));
        idx += interestIds.length;
      }
      if (destCity) {
        whereClauses.push(`city ILIKE $${idx}`);
        queryValues.push(`%${destCity}%`);
        idx++;
        whereClauses.push(`titulo ILIKE $${idx}`);
        queryValues.push(`%${destCity}%`);
        idx++;
      }

      if (ai.prefer_titles && ai.prefer_titles.length) {
        const localTitleChecks = [];
        for (const t of ai.prefer_titles.slice(0,6)) {
          localTitleChecks.push(`titulo ILIKE $${idx}`);
          queryValues.push(`%${t}%`);
          idx++;
        }
        if (localTitleChecks.length) whereClauses.push(`(${localTitleChecks.join(' OR ')})`);
      }

      if (whereClauses.length) candidateSQL += ` WHERE (${whereClauses.join(' OR ')})`;
      const caseParts = [];
      if (ai.prefer_interests && ai.prefer_interests.length) {
        const ph = [];
        for (const it of ai.prefer_interests.slice(0,6)) {
          ph.push(`$${idx}`);
          queryValues.push(String(it));
          idx++;
        }
        caseParts.push(`(CASE WHEN fk_interest::text IN (${ph.join(',')}) THEN 1 ELSE 0 END)`);
      }
      if (ai.prefer_titles && ai.prefer_titles.length) {
        const titleChecks2 = [];
        for (const t of ai.prefer_titles.slice(0,6)) {
          titleChecks2.push(`titulo ILIKE $${idx}`);
          queryValues.push(`%${t}%`);
          idx++;
        }
        if (titleChecks2.length) caseParts.push(`(CASE WHEN (${titleChecks2.join(' OR ')}) THEN 1 ELSE 0 END)`);
      }

      if (caseParts.length) {
        candidateSQL += ` ORDER BY (${caseParts.join(' + ')}) DESC, relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      } else {
        candidateSQL += ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      }
      queryValues.push(Math.max(totalNeeded * 4, 200));
    }

    const candRes = await client.query(candidateSQL, queryValues);
    let candidates = candRes.rows || [];

    // If destCountry was specified and we found zero candidates, fail loudly (strict requirement).
    if (destCountry && (!candidates || candidates.length === 0)) {
      return res.status(400).json({ message: `No se encontraron ubicaciones en el país destino: ${destCountry}. Generador interrumpido.` });
    }

    // Now enforce country-match strictly in JS (safer): filter by token match using countryMatches()
    if (destCountry) {
      const filtered = candidates.filter(c => c.country && countryMatches(c.country, destCountry));
      candidates = filtered;
      if (!candidates.length) {
        return res.status(400).json({ message: `No se encontraron ubicaciones en el país destino (después del filtrado): ${destCountry}. Generador interrumpido.` });
      }
    }

    // If no country specified and too few candidates, we may broaden (existing behavior)
    if (!destCountry && (!candidates.length || candidates.length < Math.max(10, totalNeeded))) {
      const broadRes = await client.query(`SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`, [Math.max(totalNeeded * 6, 300)]);
      const broad = broadRes.rows || [];
      const combined = [];
      const seenIds = new Set();
      for (const c of candidates) { seenIds.add(String(c.id)); combined.push(c); }
      for (const b of broad) {
        if (!seenIds.has(String(b.id))) { combined.push(b); seenIds.add(String(b.id)); }
      }
      candidates = combined;
    }

    // Ensure mandatory (if any) are included in the candidate pool (they were validated earlier when country provided)
    for (const name of mandatoryPlaceNames) {
      const exists = candidates.find(c => c.titulo && c.titulo.toString().toLowerCase().includes(name.toLowerCase()));
      if (!exists) {
        // If there is still a chance (no country specified), try to fetch specific mandatory and add it
        if (!destCountry) {
          const r = await client.query('SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${name}%`]);
          if (r.rows.length) candidates.unshift(r.rows[0]);
        } else {
          return res.status(400).json({ message: `Ubicación obligatoria "${name}" no encontrada en ${destCountry}` });
        }
      }
    }

    // dedupe candidates (by id) and limit pool
    const seen = new Set();
    const dedup = [];
    for (const c of candidates) {
      if (!c || !c.id) continue;
      if (seen.has(String(c.id))) continue;
      seen.add(String(c.id));
      dedup.push(c);
      if (dedup.length >= Math.max(totalNeeded * 4, 200)) break;
    }
    candidates = dedup;

    // build points array for clustering (only those with coords)
    const points = [];
    const candWithCoords = [];
    for (const c of candidates) {
      if (c.latitud != null && c.longitud != null) {
        if (destCountry && !countryMatches(c.country, destCountry)) continue;
        points.push({ lat: Number(c.latitud), lng: Number(c.longitud) });
        candWithCoords.push(c);
      }
    }

    const candidatesNoCoords = candidates.filter(c => c.latitud == null || c.longitud == null);
    const k = Math.min(days, Math.max(1, points.length));
    const clustersIndices = k >= 1 && points.length ? kmeans(points, k, 12) : Array.from({length:Math.max(1,k)}, () => []);

    const clusterCandidates = Array.from({length:Math.max(1,k)}, () => []);
    const pointIdxToCand = {};
    for (let i = 0; i < candWithCoords.length; i++) pointIdxToCand[i] = candWithCoords[i];

    for (let ci = 0; ci < clustersIndices.length; ci++) {
      const arr = clustersIndices[ci];
      for (const idxPoint of arr) {
        const cand = pointIdxToCand[idxPoint];
        if (cand) clusterCandidates[ci].push(cand);
      }
    }

    if (candidatesNoCoords.length) {
      const validNoCoords = destCountry ? candidatesNoCoords.filter(c => c.country && countryMatches(c.country, destCountry)) : candidatesNoCoords;
      if (validNoCoords.length) clusterCandidates[0].push(...validNoCoords);
    }

    const perDayCandidates = Array.from({length:days}, () => []);

    const clusterOrder = clusterCandidates.map((c, i) => ({ i, len: c.length })).sort((a,b) => b.len - a.len).map(x => x.i);

    const mandatoryById = new Map();
    for (const name of mandatoryPlaceNames) {
      const found = candidates.find(c => c.titulo && c.titulo.toString().toLowerCase().includes(name.toLowerCase()));
      if (found) mandatoryById.set(String(found.id), found);
    }
    for (const [mid, mloc] of mandatoryById.entries()) {
      if (!mloc || mloc.latitud == null || mloc.longitud == null) { perDayCandidates[0].push(mloc); continue; }
      let bestCluster = 0; let bestD = Infinity;
      for (let ci = 0; ci < clusterCandidates.length; ci++) {
        const cluster = clusterCandidates[ci];
        if (!cluster || cluster.length === 0) continue;
        const proxy = cluster[0];
        const d = haversineKm({lat: Number(mloc.latitud), lng: Number(mloc.longitud)}, {lat: Number(proxy.latitud), lng: Number(proxy.longitud)});
        if (d < bestD) { bestD = d; bestCluster = ci; }
      }
      const dayIndex = Math.min(days - 1, clusterOrder.indexOf(bestCluster) >= 0 ? clusterOrder.indexOf(bestCluster) : 0);
      perDayCandidates[dayIndex].push(mloc);
    }

    for (let di = 0; di < days; di++) {
      const clusterIdx = clusterOrder[di] ?? clusterOrder[0] ?? 0;
      const pool = (clusterCandidates[clusterIdx] || []).slice();

      pool.sort((a,b) => {
        const aCm = a.country && destCountry && countryMatches(a.country, destCountry) ? 1 : 0;
        const bCm = b.country && destCountry && countryMatches(b.country, destCountry) ? 1 : 0;
        if (aCm !== bCm) return bCm - aCm;
        return (b.relevancia || 0) - (a.relevancia || 0);
      });

      for (const c of pool) {
        if (perDayCandidates[di].find(x => x && String(x.id) === String(c.id))) continue;
        perDayCandidates[di].push(c);
        if (perDayCandidates[di].length >= perDay * 3) break;
      }
    }

    const itineraryDays = [];
    for (let di = 0; di < days; di++) {
      const date = addDaysToIso(startDate, di);
      const pool = perDayCandidates[di] || [];

      const mandatoryHere = pool.filter(p => p && mandatoryById.has(String(p.id)));
      const nonMandatory = pool.filter(p => !mandatoryById.has(String(p.id)));

      const mealSlots = { lunch: 13*60, merienda: 17*60, dinner: 20*60 };
      const usedIds = new Set();

      const gastrCandidates = pool.filter(p => isGastronomia(p) && !(usedIds.has(String(p.id))));

      const pickGastrFor = () => {
        const local = gastrCandidates.find(g => g.country && destCountry && countryMatches(g.country, destCountry) && !usedIds.has(String(g.id)));
        if (local) { usedIds.add(String(local.id)); return local; }
        const any = gastrCandidates.find(g => !usedIds.has(String(g.id)));
        if (any) { usedIds.add(String(any.id)); return any; }
        return null;
      };

      const lunchPlace = pickGastrFor();
      const dinnerPlace = pickGastrFor();
      const meriendaPlace = pickGastrFor();

      const dayPlaces = [];

      mandatoryHere.sort((a,b) => (b.relevancia || 0) - (a.relevancia || 0));
      for (const m of mandatoryHere) {
        if (!m) continue;
        dayPlaces.push(m);
        usedIds.add(String(m.id));
        if (dayPlaces.length >= perDay) break;
      }

      for (const nm of nonMandatory) {
        if (dayPlaces.length >= perDay) break;
        if (!nm) continue;
        if (usedIds.has(String(nm.id))) continue;
        dayPlaces.push(nm);
        usedIds.add(String(nm.id));
      }

      const ensureMealPlace = (mealPlace) => {
        if (!mealPlace) return null;
        if (dayPlaces.find(p => String(p.id) === String(mealPlace.id))) return null;
        if (dayPlaces.length < perDay) {
          dayPlaces.splice(Math.floor(dayPlaces.length/2), 0, mealPlace);
        } else {
          let replaced = false;
          for (let i = dayPlaces.length - 1; i >= 0; i--) {
            const cand = dayPlaces[i];
            if (!mandatoryById.has(String(cand.id))) {
              dayPlaces[i] = mealPlace;
              replaced = true;
              break;
            }
          }
          if (!replaced) dayPlaces[dayPlaces.length - 1] = mealPlace;
        }
        usedIds.add(String(mealPlace.id));
        return mealPlace;
      };

      ensureMealPlace(lunchPlace);
      ensureMealPlace(meriendaPlace);
      ensureMealPlace(dinnerPlace);

      const finalPlaces = dayPlaces.slice(0, perDay);

      let currentMin = 9 * 60;
      const scheduled = [];
      for (let i = 0; i < finalPlaces.length; i++) {
        const p = finalPlaces[i];
        if (!p) continue;
        const isG = isGastronomia(p);
        if (scheduled.length > 0) {
          const last = scheduled[scheduled.length-1];
          const travelMin = estimateTravelMinutes({lat: Number(last.lat), lng: Number(last.lng)}, {lat: Number(p.latitud || p.lat), lng: Number(p.longitud || p.lng)});
          currentMin += Math.round(travelMin) + 10;
        }

        let preferredMin = null;
        if (lunchPlace && String(lunchPlace.id) === String(p.id)) preferredMin = mealSlots.lunch;
        if (meriendaPlace && String(meriendaPlace.id) === String(p.id)) preferredMin = mealSlots.merienda;
        if (dinnerPlace && String(dinnerPlace.id) === String(p.id)) preferredMin = mealSlots.dinner;

        if (preferredMin != null && preferredMin > currentMin + 30) {
          currentMin = preferredMin - (isG ? 10 : 30);
        }

        const duration = isG ? 60 : 90;
        const startStr = minutesToTimeStr(currentMin);
        const endStr = minutesToTimeStr(currentMin + duration);

        scheduled.push({ id: p.id, titulo: p.titulo, lat: Number(p.latitud || p.lat || 0), lng: Number(p.longitud || p.lng || 0), category: p.category, relevance: p.relevancia, start_hour: startStr, end_hour: endStr });

        currentMin += duration + 15;
      }

      itineraryDays.push({ date, places: scheduled });
    }

    if (destCountry) {
      for (const day of itineraryDays) {
        day.places = day.places.filter(pl => {
          const found = candidates.find(c => String(c.id) === String(pl.id));
          if (found) return countryMatches(found.country, destCountry);
          return false;
        });
      }
    }

    const itinerary = { trip_id: tripId, pace, days: itineraryDays, generated_at: new Date().toISOString() };

    // Save generation record and optionally persist places
    await client.query('BEGIN');
    const genRes = await client.query(
      `INSERT INTO itinerary_generations (trip_id, user_id, model, status, progress, generated_json, created_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now()) RETURNING id`,
      [tripId, userId, 'heuristic-strict-country-v2-ai', 'finished', 100, JSON.stringify(itinerary)]
    );
    const genId = genRes.rows[0].id;

    const savedPlaces = [];
    if (save) {
      await client.query('DELETE FROM trip_places WHERE fk_trips = $1 AND date >= $2 AND date <= $3', [tripId, startDate, endDate]);

      const insertSQL = 'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *';
      for (const day of itinerary.days) {
        for (const p of day.places) {
          if (destCountry) {
            const locRow = candidates.find(c => String(c.id) === String(p.id));
            if (!locRow || !locRow.country || !countryMatches(locRow.country, destCountry)) {
              continue;
            }
          }
          const start = p.start_hour || null;
          const end = p.end_hour || null;
          const r = await client.query(insertSQL, [p.id, tripId, day.date, start, end, null]);
          savedPlaces.push(r.rows[0]);
        }
      }
    }

    await client.query('COMMIT');

    return res.status(201).json({ generation_id: genId, itinerary, saved_places: save ? savedPlaces : undefined });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /trips/:id/itinerary error:', err);
    return res.status(500).json({ message: 'Error generando itinerario', error: err.message });
  } finally {
    client.release();
  }
}

/**
 * GET /trips/:id/itinerary
 * Returns the last generated itinerary for the trip (owner only).
 */
async function getLastItinerary(req, res) {
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const tripRes = await pool.query('SELECT user_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    if (tripRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const r = await pool.query('SELECT id, trip_id, user_id, status, generated_json, created_at, finished_at FROM itinerary_generations WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1', [tripId]);
    if (!r.rows.length) return res.status(404).json({ message: 'No hay generaciones' });
    return res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /trips/:id/itinerary error:', err);
    res.status(500).json({ message: 'Error' });
  }
}

// Wire itinerary routes
router.post('/:id/itinerary', auth, handleItinerary);
router.get('/:id/itinerary', auth, getLastItinerary);

// ----------------------
// The rest of the original file's endpoints are kept unchanged below.
// (share, list trips, create trip, get trip, update, delete, places endpoints, auto-insert)
// ----------------------

// The rest of the file below is identical to your previous implementation.
// (For brevity I keep the same implementations for share, list, create, get, update, delete, places, auto-insert)
router.post('/:id/share', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const { mode = 'viewer', public: isPublic = false, shared_with_user_id, expires_in_days } = req.body || {};

    const ownerRes = await pool.query('SELECT user_id FROM trips WHERE id = $1', [tripId]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    if (!['viewer','editor'].includes(mode)) return res.status(400).json({ message: 'Invalid mode' });

    let sharedWith = null;
    if (shared_with_user_id) {
      const other = await pool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [Number(shared_with_user_id)]);
      if (!other.rows.length) return res.status(404).json({ message: 'Usuario compartido no encontrado' });
      sharedWith = Number(shared_with_user_id);
      if (sharedWith === userId) {
        return res.status(400).json({ message: 'No puedes compartir un viaje contigo mismo (usa público si quieres)' });
      }
    }

    let expiresAt = null;
    if (expires_in_days && Number.isFinite(Number(expires_in_days)) && Number(expires_in_days) > 0) {
      const days = Number(expires_in_days);
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    }

    await client.query('BEGIN');
    const insertSQL = `INSERT INTO trip_shares (trip_id, shared_by, shared_with, mode, public, expires_at)
                       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, trip_id, shared_by, shared_with, mode, public, share_uuid, expires_at, created_at`;
    const values = [tripId, userId, sharedWith, mode, !!isPublic, expiresAt];
    const r = await client.query(insertSQL, values);
    await client.query('COMMIT');

    const shareRow = r.rows[0];
    const base = `${req.protocol}://${req.get('host')}`;
    const url = `${base}/api/share/trip/${shareRow.share_uuid}`;

    return res.status(201).json({ url, share: shareRow });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /trips/:id/share error:', err);
    return res.status(500).json({ message: 'Error creating share' });
  } finally {
    client.release();
  }
});

/* GET / (list trips) */
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const sql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places,
        ts.id AS share_id,
        ts.shared_by AS share_shared_by,
        ts.shared_with AS share_shared_with,
        ts.mode AS share_mode,
        ts.public AS share_public,
        ts.share_uuid AS share_uuid,
        ts.expires_at AS share_expires_at
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      LEFT JOIN LATERAL (
        SELECT * FROM trip_shares
        WHERE trip_id = t.id
          AND (shared_with = $1 OR public = true)
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (shared_with = $1) DESC, created_at DESC
        LIMIT 1
      ) ts ON true
      WHERE t.user_id = $1 OR ts.id IS NOT NULL
      ORDER BY t.start_date DESC
    `;

    const result = await pool.query(sql, [userId]);
    const trips = result.rows.map((r) => {
      const trip = normalizeTripRow(r);
      trip.places = r.places || [];
      if (r.share_id) {
        trip.share = {
          id: r.share_id,
          shared_by: r.share_shared_by,
          shared_with: r.share_shared_with,
          mode: r.share_mode,
          public: r.share_public,
          share_uuid: r.share_uuid,
          expires_at: r.share_expires_at
        };
      } else {
        trip.share = null;
      }
      return trip;
    });

    res.json(trips);
  } catch (err) {
    console.error('GET /trips error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

router.post('/', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    const { destination, start_date, end_date, budget, notes, places } = req.body;

    await client.query('BEGIN');

    const insertTripSQL =
      'INSERT INTO trips (user_id, destination, start_date, end_date, budget, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, user_id, destination, start_date, end_date, budget, notes, created_at';
    const tripRes = await client.query(insertTripSQL, [
      userId,
      destination,
      start_date || null,
      end_date || null,
      budget || null,
      notes || null
    ]);
    const tripRow = tripRes.rows[0];
    const tripId = tripRow.id;

    const createdPlaces = [];

    if (Array.isArray(places) && places.length > 0) {
      const insertPlaceSQL =
        'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

      for (const p of places) {
        const fk_location = p.fk_location ?? p.locationId ?? p.location_id ?? p.fk_locations;
        if (!fk_location) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: 'Cada place necesita fk_location (id de location)' });
        }
        const placeRes = await client.query(insertPlaceSQL, [
          fk_location,
          tripId,
          p.date || null,
          p.start_hour || null,
          p.end_hour || null,
          p.notes || null
        ]);
        createdPlaces.push(placeRes.rows[0]);
      }
    }

    await client.query('COMMIT');

    const response = {
      trip: normalizeTripRow(tripRow),
      places: createdPlaces
    };
    res.status(201).json(response);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /trips error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

/* GET /trips/:id */
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;

    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'Invalid id' });

    const sql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places,
        ts.id AS share_id,
        ts.shared_by AS share_shared_by,
        ts.shared_with AS share_shared_with,
        ts.mode AS share_mode,
        ts.public AS share_public,
        ts.share_uuid AS share_uuid,
        ts.expires_at AS share_expires_at
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      LEFT JOIN LATERAL (
        SELECT * FROM trip_shares
        WHERE trip_id = t.id
          AND (shared_with = $2 OR public = true)
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY (shared_with = $2) DESC, created_at DESC
        LIMIT 1
      ) ts ON true
      WHERE t.id = $1
      LIMIT 1
    `;

    const result = await pool.query(sql, [id, userId]);
    if (!result.rows.length) return res.status(404).json({ message: 'No encontrado' });

    const row = result.rows[0];

    if (row.user_id !== userId && !row.share_id) return res.status(403).json({ message: 'No autorizado' });

    const trip = {
      id: row.id,
      user_id: row.user_id,
      destination: row.destination,
      start_date: row.start_date,
      end_date: row.end_date,
      budget: row.budget,
      notes: row.notes,
      created_at: row.created_at,
      places: row.places || []
    };

    if (row.share_id) {
      trip.share = {
        id: row.share_id,
        shared_by: row.share_shared_by,
        shared_with: row.share_shared_with,
        mode: row.share_mode,
        public: row.share_public,
        share_uuid: row.share_uuid,
        expires_at: row.share_expires_at
      };
    } else {
      trip.share = null;
    }

    res.json(trip);
  } catch (err) {
    console.error('GET /trips/:id error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/* PUT /trips/:id */
router.put('/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;
    const { destination, start_date, end_date, budget, notes, places } = req.body;

    const ownerRes = await pool.query('SELECT user_id FROM trips WHERE id = $1', [id]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'No encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    await client.query('BEGIN');

    await client.query(
      'UPDATE trips SET destination=$1, start_date=$2, end_date=$3, budget=$4, notes=$5 WHERE id=$6 AND user_id=$7',
      [destination || null, start_date || null, end_date || null, budget || null, notes || null, id, userId]
    );

    let newPlaces = [];
    if (Array.isArray(places)) {
      await client.query('DELETE FROM trip_places WHERE fk_trips = $1', [id]);

      const insertPlaceSQL =
        'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

      for (const p of places) {
        const fk_location = p.fk_location ?? p.locationId ?? p.location_id ?? p.fk_locations;
        if (!fk_location) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: 'Cada place necesita fk_location (id de location)' });
        }
        const placeRes = await client.query(insertPlaceSQL, [
          fk_location,
          id,
          p.date || null,
          p.start_hour || null,
          p.end_hour || null,
          p.notes || null
        ]);
        newPlaces.push(placeRes.rows[0]);
      }
    }

    await client.query('COMMIT');

    return res.json({ message: 'Actualizado', places: newPlaces });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /trips/:id error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

/* DELETE /trips/:id */
router.delete('/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;

    const ownerRes = await client.query('SELECT user_id FROM trips WHERE id = $1', [id]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'No encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    await client.query('BEGIN');

    await client.query('DELETE FROM trip_places WHERE fk_trips = $1', [id]);
    await client.query('DELETE FROM trips WHERE id = $1 AND user_id = $2', [id, userId]);

    await client.query('COMMIT');

    res.json({ message: 'Eliminado' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /trips/:id error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

/* POST /trips/:id/places */
router.post('/:id/places', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const { places } = req.body;

    if (!Array.isArray(places) || places.length === 0) {
      return res.status(400).json({ message: 'Debe enviar un arreglo "places" con al menos un elemento' });
    }

    const ownerRes = await client.query('SELECT user_id FROM trips WHERE id = $1', [tripId]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'No encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    await client.query('BEGIN');
    const insertPlaceSQL =
      'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

    const created = [];
    for (const p of places) {
      const fk_location = p.fk_location ?? p.locationId ?? p.location_id ?? p.fk_locations;
      if (!fk_location) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Cada place necesita fk_location (id de location)' });
      }
      const r = await client.query(insertPlaceSQL, [
        fk_location,
        tripId,
        p.date || null,
        p.start_hour || null,
        p.end_hour || null,
        p.notes || null
      ]);
      created.push(r.rows[0]);
    }

    await client.query('COMMIT');
    return res.status(201).json({ places: created });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /trips/:id/places error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

/* DELETE /trips/:id/places/:placeId */
router.delete('/:id/places/:placeId', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const placeId = Number(req.params.placeId);
    const userId = req.user.id;

    const ownerRes = await client.query('SELECT user_id FROM trips WHERE id = $1', [tripId]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'No encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const delRes = await client.query('DELETE FROM trip_places WHERE id = $1 AND fk_trips = $2 RETURNING id', [placeId, tripId]);
    if (!delRes.rows.length) return res.status(404).json({ message: 'Place no encontrado' });

    res.json({ message: 'Place eliminado' });
  } catch (err) {
    console.error('DELETE /trips/:id/places/:placeId error:', err);
    res.status(500).json({ message: 'Error' });
  } finally {
    client.release();
  }
});

/* POST /trips/:id/places/auto
   Insert a new fk_location into the trip WITHOUT removing any existing places.
   It selects the best day (does not move existing places between days),
   reorders that day's places (existing + new) to minimize travel, updates their times,
   and inserts the new place row.
   Body: { place: { fk_location: <id>, notes?: string } }
*/
router.post('/:id/places/auto', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const body = req.body || {};
    const place = body.place || {};

    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });
    if (!place || !place.fk_location) return res.status(400).json({ message: 'Debe enviar un objeto place con fk_location' });

    // fetch trip & ownership
    const tripRes = await client.query('SELECT id, user_id, destination, start_date, end_date FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    const trip = tripRes.rows[0];
    if (trip.user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // trip date range (inclusive)
    const startDateIso = trip.start_date ? trip.start_date.toISOString().slice(0,10) : (new Date()).toISOString().slice(0,10);
    const endDateIso = trip.end_date ? trip.end_date.toISOString().slice(0,10) : startDateIso;
    const startD = new Date(startDateIso + 'T00:00:00Z');
    const endD = new Date(endDateIso + 'T00:00:00Z');
    const days = Math.max(1, Math.round((endD - startD) / (24*3600*1000)) + 1);

    // load all existing trip_places for the trip date range (we keep them, will only update times for chosen day)
    const existingRes = await client.query(
      `SELECT tp.id AS tp_id, tp.fk_locations AS fk_location, tp.date::text AS date_text,
              tp.start_hour, tp.end_hour, tp.notes,
              l.id AS loc_id, l.titulo, l.latitud, l.longitud, l.relevancia, l.category, l.country, l.city
       FROM trip_places tp
       JOIN locations l ON l.id = tp.fk_locations
       WHERE tp.fk_trips = $1 AND tp.date::text >= $2 AND tp.date::text <= $3
       ORDER BY tp.date, tp.start_hour`,
      [tripId, startDateIso, endDateIso]
    );
    const existingPlaces = existingRes.rows || [];

    // fetch new location
    const newLocId = Number(place.fk_location);
    const locRes = await client.query('SELECT id, titulo, latitud, longitud, relevancia, category, country, city FROM locations WHERE id = $1 LIMIT 1', [newLocId]);
    if (!locRes.rows.length) {
      return res.status(404).json({ message: 'Location (fk_location) no encontrada' });
    }
    const newLocRow = locRes.rows[0];

    // map days: dayIndex -> array of existing place objects (keep tp_id for updates)
    const dateToIndex = {};
    for (let i = 0; i < days; i++) dateToIndex[addDaysToIso(startDateIso, i)] = i;
    const dayMap = Array.from({length: days}, () => []);
    for (const ex of existingPlaces) {
      const d = ex.date_text;
      const idx = dateToIndex[d];
      if (idx === undefined) continue;
      dayMap[idx].push({
        tp_id: ex.tp_id,
        loc_id: Number(ex.loc_id),
        titulo: ex.titulo,
        lat: ex.latitud != null ? Number(ex.latitud) : null,
        lng: ex.longitud != null ? Number(ex.longitud) : null,
        relevancia: ex.relevancia || 0,
        category: ex.category || null
      });
    }

    // For matrix computation gather unique location ids involved across all days plus new loc
    const allLocIdSet = new Set();
    for (const dayArr of dayMap) for (const p of dayArr) allLocIdSet.add(Number(p.loc_id));
    allLocIdSet.add(Number(newLocRow.id));
    const allLocIds = Array.from(allLocIdSet);

    // fetch location rows for matrix
    const placeholders = allLocIds.map((_,i) => `$${i+1}`).join(',');
    const allLocRowsRes = await client.query(
      `SELECT id, titulo, latitud, longitud, relevancia, category FROM locations WHERE id IN (${placeholders})`,
      allLocIds
    );
    const allLocRows = allLocRowsRes.rows || [];
    const locById = new Map();
    for (const r of allLocRows) {
      locById.set(Number(r.id), {
        id: Number(r.id),
        titulo: r.titulo,
        lat: r.latitud != null ? Number(r.latitud) : null,
        lng: r.longitud != null ? Number(r.longitud) : null,
        relevancia: r.relevancia || 0,
        category: r.category || null
      });
    }

    // build locList and id->index mapping for matrix
    const locList = allLocIds.map(id => locById.get(Number(id)));
    const idToIndex = new Map();
    for (let i = 0; i < locList.length; i++) idToIndex.set(String(locList[i].id), i);
    const n = locList.length;

    // build travel matrix (minutes) between locList entries
    let matrix = Array.from({length:n}, () => Array.from({length:n}, () => Number.MAX_SAFE_INTEGER/10));
    if (typeof routing !== 'undefined' && typeof routing.getMatrix === 'function') {
      try {
        const coords = locList.map(L => ({ id: L.id, lat: L.lat, lng: L.lng }));
        const rawMatrix = await routing.getMatrix(coords);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            if (i === j) { matrix[i][j] = 0; continue; }
            const ida = String(locList[i].id);
            const idb = String(locList[j].id);
            let val = null;
            if (rawMatrix && rawMatrix[ida] && rawMatrix[ida][idb] != null) val = Number(rawMatrix[ida][idb]);
            else if (rawMatrix && Array.isArray(rawMatrix) && rawMatrix[i] && rawMatrix[i][j] != null) val = Number(rawMatrix[i][j]);
            if (val != null && Number.isFinite(val)) matrix[i][j] = val;
            else {
              const a = locList[i], b = locList[j];
              if (a.lat == null || b.lat == null) matrix[i][j] = Number.MAX_SAFE_INTEGER/10;
              else matrix[i][j] = Math.max(1, Math.round(estimateTravelMinutes({lat: a.lat, lng: a.lng}, {lat: b.lat, lng: b.lng})));
            }
          }
        }
      } catch (err) {
        // fallback to estimate
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            if (i === j) { matrix[i][j] = 0; continue; }
            const a = locList[i], b = locList[j];
            if (a.lat == null || b.lat == null) matrix[i][j] = Number.MAX_SAFE_INTEGER/10;
            else matrix[i][j] = Math.max(1, Math.round(estimateTravelMinutes({lat: a.lat, lng: a.lng}, {lat: b.lat, lng: b.lng})));
          }
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) { matrix[i][j] = 0; continue; }
          const a = locList[i], b = locList[j];
          if (a.lat == null || b.lat == null) matrix[i][j] = Number.MAX_SAFE_INTEGER/10;
          else matrix[i][j] = Math.max(1, Math.round(estimateTravelMinutes({lat: a.lat, lng: a.lng}, {lat: b.lat, lng: b.lng})));
        }
      }
    }

    // helper to compute total duration of an order (array of indices into locList)
    const totalDuration = (order) => {
      if (!order || order.length <= 1) return 0;
      let sum = 0;
      for (let i = 0; i < order.length - 1; i++) {
        const a = order[i], b = order[i+1];
        const v = matrix[a] && matrix[a][b];
        sum += (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER/10);
      }
      return sum;
    };

    // compute best order for a set of locList indices
    const computeBestOrderForIndices = (indices) => {
      const uniq = Array.from(new Set(indices));
      if (uniq.length <= 1) return { order: uniq.slice(), cost: 0 };

      if (uniq.length <= 8) {
        const perms = [];
        const back = (curr, rem) => {
          if (rem.length === 0) { perms.push(curr.slice()); return; }
          for (let i = 0; i < rem.length; i++) {
            curr.push(rem[i]);
            const next = rem.slice(0,i).concat(rem.slice(i+1));
            back(curr, next);
            curr.pop();
          }
        };
        back([], uniq.slice());
        let best = null; let bestCost = Infinity;
        for (const p of perms) {
          const c = totalDuration(p);
          if (c < bestCost) { bestCost = c; best = p.slice(); }
        }
        return { order: best || uniq.slice(0,1), cost: bestCost === Infinity ? 0 : bestCost };
      }

      // greedy insertion
      const pool = uniq.slice();
      pool.sort((a,b) => (locList[b].relevancia || 0) - (locList[a].relevancia || 0));
      const order = [pool.shift()];
      while (pool.length) {
        const item = pool.shift();
        let bestPos = 0; let bestCost = Infinity;
        for (let pos = 0; pos <= order.length; pos++) {
          const trial = order.slice(0,pos).concat([item], order.slice(pos));
          const c = totalDuration(trial);
          if (c < bestCost) { bestCost = c; bestPos = pos; }
        }
        order.splice(bestPos, 0, item);
      }
      return { order: order.slice(), cost: totalDuration(order) };
    };

    // Evaluate insertion into each day: for each day, compute best order for that day's existing locs + new loc,
    // but DO NOT move places between days (we only permute inside the day).
    let bestDay = 0;
    let bestDayCost = Infinity;
    let bestDayOrder = null;

    for (let di = 0; di < days; di++) {
      const dayExisting = dayMap[di] || [];
      // create indices (locList indices) for this day's places
      const dayIndices = dayExisting.map(p => idToIndex.get(String(p.loc_id))).filter(x => x !== undefined);
      // add new loc index if not already present in this day
      const newIdx = idToIndex.get(String(newLocRow.id));
      if (newIdx === undefined) continue; // should not happen
      const withNew = dayIndices.slice();
      if (!withNew.includes(newIdx)) withNew.push(newIdx);

      const r = computeBestOrderForIndices(withNew);
      // cost measure is r.cost; pick minimal cost (tie-breaker earliest day)
      if (r.cost < bestDayCost) {
        bestDayCost = r.cost;
        bestDay = di;
        bestDayOrder = r.order;
      }
    }

    // If for some reason none evaluated, default to first day and append
    if (!bestDayOrder || bestDayOrder.length === 0) {
      bestDay = 0;
      // get existing indices for day 0 and append new
      const dayExisting = dayMap[0] || [];
      const dayIndices = dayExisting.map(p => idToIndex.get(String(p.loc_id))).filter(x => x !== undefined);
      const newIdx = idToIndex.get(String(newLocRow.id));
      const orderIndices = dayIndices.slice();
      if (newIdx !== undefined && !orderIndices.includes(newIdx)) orderIndices.push(newIdx);
      bestDayOrder = orderIndices;
    }

    // Build schedule for chosen day using bestDayOrder
    const mealSlots = { lunch: 13*60, merienda: 17*60, dinner: 20*60 };
    let currentMin = 9 * 60;
    const scheduled = [];
    for (let k = 0; k < bestDayOrder.length; k++) {
      const li = bestDayOrder[k];
      const placeObj = locList[li];
      if (!placeObj) continue;
      if (scheduled.length > 0) {
        const lastLi = bestDayOrder[k-1];
        const travelMin = Number.isFinite(matrix[lastLi] && matrix[lastLi][li]) ? matrix[lastLi][li] : Math.round(estimateTravelMinutes({lat: locList[lastLi].lat, lng: locList[lastLi].lng}, {lat: placeObj.lat, lng: placeObj.lng}));
        currentMin += Math.round(travelMin) + 10;
      }

      const isG = isGastronomia(placeObj);
      let preferredMin = null;
      if (isG) {
        if (Math.abs(currentMin - mealSlots.lunch) < 90) preferredMin = mealSlots.lunch;
        else if (Math.abs(currentMin - mealSlots.merienda) < 90) preferredMin = mealSlots.merienda;
        else if (Math.abs(currentMin - mealSlots.dinner) < 120) preferredMin = mealSlots.dinner;
      }
      if (preferredMin != null && preferredMin > currentMin + 20) {
        currentMin = preferredMin - (isG ? 15 : 30);
      }

      const duration = isG ? 60 : 90;
      const startStr = minutesToTimeStr(currentMin);
      const endStr = minutesToTimeStr(currentMin + duration);

      scheduled.push({
        loc_id: placeObj.id,
        titulo: placeObj.titulo,
        start_hour: startStr,
        end_hour: endStr,
      });

      currentMin += duration + 15;
    }

    // Persist only updates for the chosen day: update existing rows' times and insert the new one.
    await client.query('BEGIN');

    const chosenDate = addDaysToIso(startDateIso, bestDay);

    // Build mapping loc_id -> tp_id for existing places on chosen day (so we can update)
    const existingOnChosen = (existingPlaces || []).filter(ep => ep.date_text === chosenDate);
    const locIdToTpId = new Map();
    for (const e of existingOnChosen) locIdToTpId.set(Number(e.loc_id), e.tp_id);

    const updatedRows = [];
    let insertedRow = null;

    // For each scheduled entry:
    for (const s of scheduled) {
      const locId = Number(s.loc_id);
      const start = s.start_hour;
      const end = s.end_hour;
      if (locIdToTpId.has(locId)) {
        // update existing trip_places row times
        const tpId = locIdToTpId.get(locId);
        const upd = await client.query('UPDATE trip_places SET start_hour = $1, end_hour = $2 WHERE id = $3 RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at', [start, end, tpId]);
        if (upd.rows.length) updatedRows.push(upd.rows[0]);
      } else {
        // this is the new inserted place (or an existing place that previously wasn't present as a row - but that should not happen)
        const ins = await client.query('INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at', [locId, tripId, chosenDate, start, end, place.notes || null]);
        if (ins.rows.length) {
          // If multiple 'new' entries (should only be one: our newLoc), we detect which corresponds to the newLocRow.id
          const r = ins.rows[0];
          insertedRow = r;
        }
      }
    }

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Place inserted and day schedule updated',
      inserted_place: insertedRow,
      updated_places: updatedRows,
      chosen_date: chosenDate,
      itinerary_day: { date: chosenDate, places: scheduled }
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /trips/:id/places/auto error:', err);
    return res.status(500).json({ message: 'Error calculando inserción automática', error: err.message });
  } finally {
    client.release();
  }
});


module.exports = router;
