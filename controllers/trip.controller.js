// controllers/trip.controller.js
'use strict';

const express = require('express');
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
// Parse trip.destination into city/country pieces
function parseDestinationParts(dest) {
  if (!dest) return { city: null, country: null };
  const parts = String(dest).split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    // If it's a single token, check if it matches a known country variant.
    const single = parts[0];
    const n = normalizeStr(single);
    for (const key of Object.keys(COUNTRY_EQUIV)) {
      // COUNTRY_EQUIV contains small arrays of variants (e.g. 'spain' -> ['spain','espana',...])
      if (COUNTRY_EQUIV[key].includes(n)) {
        return { city: null, country: single }; // treat single token as country
      }
    }
    // fallback: treat single token as city if no country match
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
  // return variants from mapping if found, else include normalized destCountry
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
  // token match: check tokens split by non-word
  const candTokens = cand.split(/\W+/).filter(Boolean);
  for (const v of variants) {
    if (cand === v) return true;
    if (cand.includes(v)) return true;
    if (candTokens.includes(v)) return true;
  }
  // also check destCountry tokens inside candidate
  const destTokens = normalizeStr(destCountry).split(/\W+/).filter(Boolean);
  for (const t of destTokens) {
    if (candTokens.includes(t)) return true;
    if (cand.includes(t)) return true;
  }
  return false;
}

// ----------------------
// Itinerary generator: strict-country variant
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

    // Build candidate query: **STRICT** behavior when destCountry present: only fetch locations in that country
    let candidateSQL = `SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations`;
    const queryValues = [];
    let idx = 1;

    if (destCountry) {
      // strict: only locations whose country matches destCountry (we'll still filter again in JS for safety)
      candidateSQL += ` WHERE country IS NOT NULL AND LOWER(country) LIKE $${idx}`;
      queryValues.push(`%${normalizeStr(destCountry)}%`);
      idx++;
      candidateSQL += ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      queryValues.push(Math.max(totalNeeded * 4, 200));
    } else {
      // flexible behavior when no country specified: prefer interests/city/title
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
      if (whereClauses.length) candidateSQL += ` WHERE (${whereClauses.join(' OR ')})`;
      candidateSQL += ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
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
          // country specified & mandatory not in candidate pool -> error (we validated earlier but keep safe)
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
        // if strict country: sanity check again to avoid foreign items slipping in
        if (destCountry && !countryMatches(c.country, destCountry)) continue;
        points.push({ lat: Number(c.latitud), lng: Number(c.longitud) });
        candWithCoords.push(c);
      }
    }

    // If after removing non-coords and non-country items we have zero coordinate candidates
    // but some candidates without coords exist, we'll still include them into a fallback pool (they won't be clustered)
    const candidatesNoCoords = candidates.filter(c => c.latitud == null || c.longitud == null);
    // perform clustering into `days` clusters
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

    // Candidates without coords -> push to first cluster (but only if they match country when strict)
    if (candidatesNoCoords.length) {
      const validNoCoords = destCountry ? candidatesNoCoords.filter(c => c.country && countryMatches(c.country, destCountry)) : candidatesNoCoords;
      if (validNoCoords.length) clusterCandidates[0].push(...validNoCoords);
    }

    // Prepare per-day pools
    const perDayCandidates = Array.from({length:days}, () => []);

    const clusterOrder = clusterCandidates.map((c, i) => ({ i, len: c.length })).sort((a,b) => b.len - a.len).map(x => x.i);

    // Assign mandatory locations to nearest cluster/day (if any)
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

    // Fill each day from its cluster, preferring relevancia and local matches
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

    // Build final itinerary days, schedule times, insert gastronomia at meal times
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

    // Before building final itinerary object, ensure when destCountry provided we only include places with matching country
    if (destCountry) {
      for (const day of itineraryDays) {
        day.places = day.places.filter(pl => {
          // find location row in candidates to check country, otherwise keep only if location in candidates or has country matches
          const found = candidates.find(c => String(c.id) === String(pl.id));
          if (found) return countryMatches(found.country, destCountry);
          // if not found in candidates we are conservative and remove it
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
      [tripId, userId, 'heuristic-strict-country-v2', 'finished', 100, JSON.stringify(itinerary)]
    );
    const genId = genRes.rows[0].id;

    const savedPlaces = [];
    if (save) {
      // delete places in that date range (same behaviour as before)
      await client.query('DELETE FROM trip_places WHERE fk_trips = $1 AND date >= $2 AND date <= $3', [tripId, startDate, endDate]);

      const insertSQL = 'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *';
      for (const day of itinerary.days) {
        for (const p of day.places) {
          // final safety: ensure the location belongs to destCountry if country specified
          if (destCountry) {
            const locRow = candidates.find(c => String(c.id) === String(p.id));
            if (!locRow || !locRow.country || !countryMatches(locRow.country, destCountry)) {
              // skip non-matching location
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

/* POST /trips/:id/places/auto */
router.post('/:id/places/auto', auth, async (req, res) => {
  // Note: this endpoint referenced `routing` in the previous file. Keep this logic untouched
  // except for small error-handling; if your project has `routing` helper (matrix) ensure it's available.
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const { place } = req.body || {};

    if (!place || !place.fk_location) {
      return res.status(400).json({ message: 'Debe enviar un objeto place con fk_location' });
    }
    if (!place.date) {
      return res.status(400).json({ message: 'place.date es requerido (YYYY-MM-DD or ISO)' });
    }

    const ownerRes = await client.query('SELECT user_id, destination, start_date, end_date, budget, notes FROM trips WHERE id = $1', [tripId]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const dateOnly = (place.date || '').split('T')[0];

    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT tp.id, tp.fk_locations, tp.date, tp.start_hour, tp.end_hour, tp.notes, l.latitud AS latitude, l.longitud AS longitude
       FROM trip_places tp
       JOIN locations l ON l.id = tp.fk_locations
       WHERE tp.fk_trips = $1 AND tp.date::text = $2
       ORDER BY tp.id ASC`,
      [tripId, dateOnly]
    );
    const existingPlaces = existingRes.rows;

    const locRes = await client.query('SELECT id, latitud AS latitude, longitud AS longitude FROM locations WHERE id = $1 LIMIT 1', [Number(place.fk_location)]);
    if (!locRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Location (fk_location) no encontrada' });
    }
    const newLoc = locRes.rows[0];

    const coords = [];
    const indexMap = [];
    for (let i = 0; i < existingPlaces.length; i++) {
      const p = existingPlaces[i];
      coords.push({ id: p.fk_locations, lat: Number(p.latitude), lng: Number(p.longitude) });
      indexMap.push({ type: 'existing', existingIndex: i });
    }
    coords.push({ id: Number(place.fk_location), lat: Number(newLoc.latitude), lng: Number(newLoc.longitude) });
    indexMap.push({ type: 'new', existingIndex: null });

    // routing helper MUST exist in your project for this endpoint
    if (typeof routing === 'undefined' || !routing.getMatrix) {
      // fallback: insert new place at end
      await client.query('DELETE FROM trip_places WHERE fk_trips = $1 AND date::text = $2', [tripId, dateOnly]);
      const insertPlaceSQL =
        'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';
      const created = [];
      for (const p of existingPlaces) {
        const r = await client.query(insertPlaceSQL, [p.fk_locations, tripId, dateOnly, p.start_hour || null, p.end_hour || null, p.notes || null]);
        created.push(r.rows[0]);
      }
      const r2 = await client.query(insertPlaceSQL, [Number(place.fk_location), tripId, dateOnly, place.start_hour || null, place.end_hour || null, place.notes || null]);
      created.push(r2.rows[0]);
      await client.query('COMMIT');
      return res.status(201).json({ places: created });
    }

    const matrix = await routing.getMatrix(coords.map(c => ({ lat: c.lat, lng: c.lng, id: c.id })));

    const totalDuration = (order) => {
      if (!order || order.length <= 1) return 0;
      let sum = 0;
      for (let i = 0; i < order.length - 1; i++) {
        const a = order[i];
        const b = order[i+1];
        const v = matrix[a] && matrix[a][b];
        sum += (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER/10);
      }
      return sum;
    };

    const n = coords.length;
    let bestOrder = null;

    if (n <= 8) {
      const permute = (arr) => {
        const res = [];
        const back = (curr, remaining) => {
          if (remaining.length === 0) { res.push(curr.slice()); return; }
          for (let i = 0; i < remaining.length; i++) {
            curr.push(remaining[i]);
            const nextRem = remaining.slice(0, i).concat(remaining.slice(i+1));
            back(curr, nextRem);
            curr.pop();
          }
        };
        back([], arr);
        return res;
      };
      const indices = Array.from({length: n}, (_,i) => i);
      const perms = permute(indices);
      let bestDur = Infinity;
      for (const p of perms) {
        const d = totalDuration(p);
        if (d < bestDur) { bestDur = d; bestOrder = p; }
      }
    } else {
      const existingIndices = Array.from({length: n-1}, (_,i) => i);
      let bestDur = Infinity;
      for (let insertAt = 0; insertAt <= existingIndices.length; insertAt++) {
        const order = existingIndices.slice(0, insertAt).concat([n-1], existingIndices.slice(insertAt));
        const d = totalDuration(order);
        if (d < bestDur) { bestDur = d; bestOrder = order; }
      }
    }

    if (!bestOrder) {
      bestOrder = Array.from({length: n-1}, (_,i) => i).concat([n-1]);
    }

    const newDayPlacesToInsert = [];
    for (const ix of bestOrder) {
      const mapEntry = indexMap[ix];
      if (mapEntry.type === 'existing') {
        const orig = existingPlaces[mapEntry.existingIndex];
        newDayPlacesToInsert.push({
          fk_location: orig.fk_locations,
          date: dateOnly,
          start_hour: orig.start_hour || null,
          end_hour: orig.end_hour || null,
          notes: orig.notes || null
        });
      } else {
        newDayPlacesToInsert.push({
          fk_location: Number(place.fk_location),
          date: dateOnly,
          start_hour: place.start_hour || null,
          end_hour: place.end_hour || null,
          notes: place.notes || null
        });
      }
    }

    await client.query('DELETE FROM trip_places WHERE fk_trips = $1 AND date::text = $2', [tripId, dateOnly]);

    const insertPlaceSQL =
      'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

    const created = [];
    for (const p of newDayPlacesToInsert) {
      const r = await client.query(insertPlaceSQL, [p.fk_location, tripId, p.date, p.start_hour, p.end_hour, p.notes]);
      created.push(r.rows[0]);
    }

    await client.query('COMMIT');

    return res.status(201).json({ places: created });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /trips/:id/places/auto error:', err);
    return res.status(500).json({ message: 'Error calculando inserción automática' });
  } finally {
    client.release();
  }
});

module.exports = router;
