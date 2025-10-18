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
// Itinerary generator helpers (the code you requested)
// ----------------------

// Simple helper to add days to an ISO date string and return YYYY-MM-DD
function addDaysToIso(dateIso, days) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

// Map pace -> places per day
const PACE_MAP = {
  relajado: 2,
  medio: 4,
  intenso: 6
};

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

  // initialize centers with kmeans++ style
  const centers = [];
  centers.push({ lat: points[0].lat, lng: points[0].lng });
  while (centers.length < k) {
    // pick farthest from existing centers
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
    // assign
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let best = 0; let bestD = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const d = haversineKm(p, centers[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      clusters[best].push(i);
    }
    // recompute
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
  // mode 'walk' ~5 km/h, 'fast' ~30 km/h, 'bike' ~12 km/h
  const speedKmh = mode === 'walk' ? 5 : (mode === 'bike' ? 12 : 30);
  return (km / speedKmh) * 60; // minutes
}

// Format time (HH:MM) given start minutes from midnight
function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

// Determine if a place is gastronomia by category or keywords
function isGastronomia(place) {
  const cat = (place.category || '').toString().toLowerCase();
  if (!cat) return false;
  if (cat.includes('gastronom') || cat.includes('restaurant') || cat.includes('cafe') || cat.includes('bar') || cat.includes('pub') || cat.includes('fast_food')) return true;
  // fallback: titulo keywords
  const t = (place.titulo || '').toString().toLowerCase();
  if (t.includes('rest') || t.includes('café') || t.includes('cafe') || t.includes('bar') || t.includes('cafeter') || t.includes('parrilla')) return true;
  return false;
}

/**
 * POST /trips/:id/itinerary
 * Generates an itinerary heuristically using:
 *  - pace: 'relajado'|'medio'|'intenso'
 *  - places: array of mandatory place names (strings)
 *  - save: boolean (whether to persist generated places into trip_places)
 *
 * This improved generator:
 *  - ensures mandatory places are included and respected
 *  - clusters activities geographically so each day covers a zone
 *  - schedules gastronomic places at meal times (almuerzo/merienda/cena)
 *  - leaves reasonable travel/visit durations and gaps between activities
 */
async function handleItinerary(req, res) {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const body = req.body || {};
    const pace = (body.pace || 'relajado').toString().toLowerCase();
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

    // Resolve mandatory places by title (best-effort ILIKE) - ensure they are located in the trip destination if possible
    const mandatoryLocations = [];
    for (const name of mandatoryPlaceNames) {
      const r = await client.query('SELECT id, titulo, latitud, longitud, relevancia, category, country, city FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${name}%`]);
      if (r.rows.length) {
        const row = r.rows[0];
        // if trip.destination exists try to filter by same country/city
        if (trip.destination && row.country && row.country.toString().toLowerCase().includes(trip.destination.toString().toLowerCase())) {
          mandatoryLocations.push(row);
        } else {
          // accept it anyway but prefer ones matching destination
          mandatoryLocations.push(row);
        }
      }
    }

    // Build candidates query: prefer interest matches or same city/country as trip.destination
    let candidateSQL = `SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations`;
    const whereClauses = [];
    const queryValues = [];
    let idx = 1;

    if (interestIds.length) {
      const placeholders = interestIds.map((_,i)=>`$${idx+i}`).join(',');
      whereClauses.push(`fk_interest::text IN (${placeholders})`);
      for (let i=0;i<interestIds.length;i++) queryValues.push(String(interestIds[i]));
      idx += interestIds.length;
    }

    if (trip.destination) {
      // attempt to match country or city
      whereClauses.push(`(country ILIKE $${idx} OR city ILIKE $${idx} OR titulo ILIKE $${idx})`);
      queryValues.push(`%${trip.destination}%`);
      idx++;
    }

    // if no where clauses, avoid selecting the whole world; allow fallback later
    if (whereClauses.length) candidateSQL += ` WHERE (${whereClauses.join(' OR ')})`;
    candidateSQL += ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
    queryValues.push(totalNeeded * 3 + 50); // get a larger pool to allow clustering and cuisine picks

    const candRes = await client.query(candidateSQL, queryValues);
    let candidates = candRes.rows || [];

    // if no candidates found that match destination/interests, broaden query to trip.destination only as free text or take top by relevancia
    if (candidates.length === 0) {
      const broadRes = await client.query(`SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations ORDER BY relevancia DESC NULLS LAST LIMIT $1`, [totalNeeded * 3 + 50]);
      candidates = broadRes.rows || [];
    }

    // ensure mandatory locations included (fetch any missing by id/title explicitly)
    const mandatoryById = new Map();
    for (const m of mandatoryLocations) mandatoryById.set(String(m.id), m);
    for (const name of mandatoryPlaceNames) {
      const exists = candidates.find(c => c.titulo && c.titulo.toString().toLowerCase().includes(name.toString().toLowerCase()));
      if (!exists) {
        const r = await client.query('SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${name}%`]);
        if (r.rows.length) {
          const row = r.rows[0];
          candidates.unshift(row); // high priority
          mandatoryById.set(String(row.id), row);
        }
      } else {
        mandatoryById.set(String(exists.id), exists);
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
      if (dedup.length >= Math.max(totalNeeded * 3, 50)) break;
    }
    candidates = dedup;

    // build points array for clustering
    const points = candidates.filter(c => c.latitud != null && c.longitud != null).map(c => ({ lat: Number(c.latitud), lng: Number(c.longitud) }));

    // perform clustering into `days` clusters
    const k = Math.min(days, Math.max(1, points.length));
    const clustersIndices = k >= 1 && points.length ? kmeans(points, k, 12) : Array.from({length:k}, () => []);

    // map cluster index -> candidate list
    const clusterCandidates = Array.from({length:k}, () => []);
    // map point index to candidate object
    const pointIdxToCand = {};
    let pIdx = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.latitud == null || c.longitud == null) continue;
      const key = `${Number(c.latitud)}:${Number(c.longitud)}:${c.id}`;
      pointIdxToCand[pIdx] = c;
      pIdx++;
    }
    // fill clusterCandidates using clustersIndices
    for (let ci = 0; ci < clustersIndices.length; ci++) {
      const arr = clustersIndices[ci];
      for (const idxPoint of arr) {
        const cand = pointIdxToCand[idxPoint];
        if (cand) clusterCandidates[ci].push(cand);
      }
    }

    // Some candidates may have no coords (push them to first cluster)
    const noCoordCands = candidates.filter(c => c.latitud == null || c.longitud == null);
    if (noCoordCands.length) clusterCandidates[0].push(...noCoordCands);

    // Prepare day buckets, each day gets a cluster; if clusters < days, some days will be empty and we'll fill later
    const daysArr = [];
    for (let d = 0; d < days; d++) daysArr.push({ date: addDaysToIso(startDate, d), places: [] });

    // assign clusters to days in order of cluster size (largest clusters first to earlier days)
    const clusterOrder = clusterCandidates.map((c, i) => ({ i, len: c.length })).sort((a,b) => b.len - a.len).map(x => x.i);

    // We'll populate a per-day candidate list prioritizing mandatory places
    const perDayCandidates = Array.from({length:days}, () => []);

    // For each mandatory location, put it into the nearest cluster/day
    for (const [mid, mloc] of mandatoryById.entries()) {
      if (!mloc || mloc.latitud == null || mloc.longitud == null) continue;
      // find nearest cluster center (approx using first element of cluster or compute mean)
      let bestCluster = 0; let bestD = Infinity;
      for (let ci = 0; ci < clusterCandidates.length; ci++) {
        const cluster = clusterCandidates[ci];
        if (!cluster || cluster.length === 0) continue;
        // use first candidate as proxy
        const proxy = cluster[0];
        const d = haversineKm({lat: Number(mloc.latitud), lng: Number(mloc.longitud)}, {lat: Number(proxy.latitud), lng: Number(proxy.longitud)});
        if (d < bestD) { bestD = d; bestCluster = ci; }
      }
      // map cluster index to day index (use clusterOrder ordering)
      const dayIndex = Math.min(days - 1, clusterOrder.indexOf(bestCluster) >= 0 ? clusterOrder.indexOf(bestCluster) : 0);
      perDayCandidates[dayIndex].push(mloc);
    }

    // Fill each day's candidate list with cluster candidates (de-duplicated) preferring relevancia
    for (let di = 0; di < days; di++) {
      const clusterIdx = clusterOrder[di] ?? clusterOrder[0] ?? 0;
      const pool = clusterCandidates[clusterIdx] || [];
      // sort pool by relevancia desc
      pool.sort((a,b) => (b.relevancia || 0) - (a.relevancia || 0));
      for (const c of pool) {
        if (perDayCandidates[di].find(x => String(x.id) === String(c.id))) continue;
        perDayCandidates[di].push(c);
        if (perDayCandidates[di].length >= perDay * 2) break; // keep some headroom
      }
    }

    // Now pick final per-day places respecting limits, prioritizing mandatory and gastronomia for meal slots
    const itineraryDays = [];
    for (let di = 0; di < days; di++) {
      const date = addDaysToIso(startDate, di);
      const pool = perDayCandidates[di] || [];

      // ensure mandatory first
      const mandatoryHere = pool.filter(p => mandatoryById.has(String(p.id)));
      const nonMandatory = pool.filter(p => !mandatoryById.has(String(p.id)));

      // plan meal slots: lunch ~13:00 (780 min), merienda ~17:00 (1020), dinner ~20:00 (1200)
      const mealSlots = { lunch: 13*60, merienda: 17*60, dinner: 20*60 };
      const assigned = [];

      // try to pick one gastronomic for lunch and dinner if available
      const gastrCandidates = pool.filter(isGastronomia);
      const usedIds = new Set();

      // prefer gastrCandidates located near other planned items; but here we simply pick top relevancia in pool
      const pickGastrFor = (slot) => {
        for (const g of gastrCandidates) {
          if (usedIds.has(String(g.id))) continue;
          usedIds.add(String(g.id));
          return g;
        }
        return null;
      };

      const lunchPlace = pickGastrFor('lunch');
      const dinnerPlace = pickGastrFor('dinner');
      const meriendaPlace = pickGastrFor('merienda');

      // assemble day's places list starting with morning attractions
      const dayPlaces = [];

      // add mandatory first (highest relevancia first)
      mandatoryHere.sort((a,b) => (b.relevancia || 0) - (a.relevancia || 0));
      for (const m of mandatoryHere) {
        dayPlaces.push(m);
        usedIds.add(String(m.id));
        if (dayPlaces.length >= perDay) break;
      }

      // fill remaining with top non-mandatory
      for (const nm of nonMandatory) {
        if (dayPlaces.length >= perDay) break;
        if (usedIds.has(String(nm.id))) continue;
        dayPlaces.push(nm);
        usedIds.add(String(nm.id));
      }

      // if there is room for gastronomic slots but not included yet, ensure they appear (replace last if necessary)
      const ensureMealPlace = (mealPlace, timeMin) => {
        if (!mealPlace) return null;
        // if already included, done
        if (dayPlaces.find(p => String(p.id) === String(mealPlace.id))) return null;
        // try to insert near middle of day
        if (dayPlaces.length < perDay) {
          dayPlaces.splice(Math.floor(dayPlaces.length/2), 0, mealPlace);
        } else {
          // replace last low-relevance
          dayPlaces[dayPlaces.length-1] = mealPlace;
        }
        usedIds.add(String(mealPlace.id));
        return mealPlace;
      };

      ensureMealPlace(lunchPlace, mealSlots.lunch);
      ensureMealPlace(meriendaPlace, mealSlots.merienda);
      ensureMealPlace(dinnerPlace, mealSlots.dinner);

      // Trim to perDay
      const finalPlaces = dayPlaces.slice(0, perDay);

      // --- schedule times for the day's places with simple sequential planning ---
      // Start day at 09:00 (540 minutes). We'll give each attraction ~90min, gastronomy ~60min.
      let currentMin = 9 * 60;
      const scheduled = [];
      for (let i = 0; i < finalPlaces.length; i++) {
        const p = finalPlaces[i];
        const isG = isGastronomia(p);
        // if there's a meal slot reserved for this place, align it
        let preferredMin = null;
        if (lunchPlace && String(lunchPlace.id) === String(p.id)) preferredMin = mealSlots.lunch; 
        if (meriendaPlace && String(meriendaPlace.id) === String(p.id)) preferredMin = mealSlots.merienda;
        if (dinnerPlace && String(dinnerPlace.id) === String(p.id)) preferredMin = mealSlots.dinner;

        // compute travel time from last scheduled
        if (scheduled.length > 0) {
          const last = scheduled[scheduled.length-1];
          const travelMin = estimateTravelMinutes({lat: Number(last.lat), lng: Number(last.lng)}, {lat: Number(p.latitud || p.lat), lng: Number(p.longitud || p.lng)});
          currentMin += Math.round(travelMin) + 10; // +10 minutes buffer
        }

        // enforce preferred meal time if set (but allow small adjustments)
        if (preferredMin != null && preferredMin > currentMin + 30) {
          // wait until preferred minus small buffer
          currentMin = preferredMin - (isG ? 10 : 30);
        }
        const duration = isG ? 60 : 90; // minutes
        const startStr = minutesToTimeStr(currentMin);
        const endStr = minutesToTimeStr(currentMin + duration);

        scheduled.push({ id: p.id, titulo: p.titulo, lat: Number(p.latitud || p.lat), lng: Number(p.longitud || p.lng), category: p.category, relevance: p.relevancia, start_hour: startStr, end_hour: endStr });

        currentMin += duration + 15; // add small gap after each activity
      }

      itineraryDays.push({ date, places: scheduled });
    }

    const itinerary = { trip_id: tripId, pace, days: itineraryDays, generated_at: new Date().toISOString() };

    // Save generation record and optionally persist places
    await client.query('BEGIN');
    const genRes = await client.query(
      `INSERT INTO itinerary_generations (trip_id, user_id, model, status, progress, generated_json, created_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now()) RETURNING id`,
      [tripId, userId, 'heuristic-v2-clustered', 'finished', 100, JSON.stringify(itinerary)]
    );
    const genId = genRes.rows[0].id;

    const savedPlaces = [];
    if (save) {
      // remove existing places within trip range to avoid duplicates
      await client.query('DELETE FROM trip_places WHERE fk_trips = $1 AND date >= $2 AND date <= $3', [tripId, startDate, endDate]);

      const insertSQL = 'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *';
      for (const day of itineraryDays) {
        for (const p of day.places) {
          // convert HH:MM:SS to time string acceptable by Postgres (time with timezone optional)
          const start = p.start_hour || null;
          const end = p.end_hour || null;
          // attempt to find location id (already present as p.id). We assume p.id is location id
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

// Wire itinerary routes (replaces the previous incorrect mapping)
router.post('/:id/itinerary', auth, handleItinerary);
router.get('/:id/itinerary', auth, getLastItinerary);

// ----------------------
// The rest of the original file's endpoints are kept unchanged below.
// (share, list trips, create trip, get trip, update, delete, places endpoints, auto-insert)
// ----------------------

/* NEW: POST /trips/:id/share
   Body: { mode: 'viewer'|'editor', public: boolean, shared_with_user_id (optional), expires_in_days (optional int) }
   Requires owner of trip.
   Returns { url, share } where url points to /api/share/trip/:uuid
*/
router.post('/:id/share', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const { mode = 'viewer', public: isPublic = false, shared_with_user_id, expires_in_days } = req.body || {};

    // verify ownership
    const ownerRes = await pool.query('SELECT user_id FROM trips WHERE id = $1', [tripId]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // validate mode
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

    // compute expires_at timestamp if requested
    let expiresAt = null;
    if (expires_in_days && Number.isFinite(Number(expires_in_days)) && Number(expires_in_days) > 0) {
      const days = Number(expires_in_days);
      expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    }

    // insert share
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

/* 
  Modified GET / (list trips)
  Now returns:
   - trips owned by the user
   - trips shared with the user (shared_with = user) OR public shares (public = true)
  For shared trips we include a 'share_*' metadata fields so the frontend can show them specially.
*/
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

/* GET /trips/:id - allow owner OR users with an active share (shared_with = me OR public & not expired) to read */
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

    // if not owner and no share -> forbidden
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

/**
 * PUT /trips/:id
 * Update trip fields. Optionally include `places` array to replace existing places (atomic).
 */
router.put('/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;
    const { destination, start_date, end_date, budget, notes, places } = req.body;

    // check ownership
    const ownerRes = await pool.query('SELECT user_id FROM trips WHERE id = $1', [id]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'No encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    await client.query('BEGIN');

    // update trip
    await client.query(
      'UPDATE trips SET destination=$1, start_date=$2, end_date=$3, budget=$4, notes=$5 WHERE id=$6 AND user_id=$7',
      [destination || null, start_date || null, end_date || null, budget || null, notes || null, id, userId]
    );

    // optionally replace places
    let newPlaces = [];
    if (Array.isArray(places)) {
      // delete existing
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

/**
 * DELETE /trips/:id
 * Delete trip and its places (ownership enforced). Uses transaction.
 */
router.delete('/:id', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;

    // verify ownership
    const ownerRes = await client.query('SELECT user_id FROM trips WHERE id = $1', [id]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'No encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    await client.query('BEGIN');

    // delete associated places first (safer), then trip
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

/**
 * POST /trips/:id/places
 * Add one or more places to an existing trip.
 */
router.post('/:id/places', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const { places } = req.body;

    if (!Array.isArray(places) || places.length === 0) {
      return res.status(400).json({ message: 'Debe enviar un arreglo "places" con al menos un elemento' });
    }

    // ownership check
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

/**
 * DELETE /trips/:id/places/:placeId
 * Remove a specific trip_place (ownership enforced for the trip)
 */
router.delete('/:id/places/:placeId', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const placeId = Number(req.params.placeId);
    const userId = req.user.id;

    // verify trip ownership
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

/**
 * POST /trips/:id/places/auto
 * Adds a place to a trip by calculating the best insertion (uses routing service externally).
 * Only reorders / replaces places that share the same date as the new place.
 */
router.post('/:id/places/auto', auth, async (req, res) => {
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

    // ownership check
    const ownerRes = await client.query('SELECT user_id, destination, start_date, end_date, budget, notes FROM trips WHERE id = $1', [tripId]);
    if (!ownerRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    if (ownerRes.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    const dateOnly = (place.date || '').split('T')[0];

    await client.query('BEGIN');

    // Fetch existing places for that date (preserve order by id/created_at)
    const existingRes = await client.query(
      `SELECT tp.id, tp.fk_locations, tp.date, tp.start_hour, tp.end_hour, tp.notes, l.latitud AS latitude, l.longitud AS longitude
       FROM trip_places tp
       JOIN locations l ON l.id = tp.fk_locations
       WHERE tp.fk_trips = $1 AND tp.date::text = $2
       ORDER BY tp.id ASC`,
      [tripId, dateOnly]
    );
    const existingPlaces = existingRes.rows;

    // Fetch coords for the new location
    const locRes = await client.query('SELECT id, latitud AS latitude, longitud AS longitude FROM locations WHERE id = $1 LIMIT 1', [Number(place.fk_location)]);
    if (!locRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Location (fk_location) no encontrada' });
    }
    const newLoc = locRes.rows[0];

    // Build coords array: existing places (in order) + new location at the end
    const coords = [];
    const indexMap = [];
    for (let i = 0; i < existingPlaces.length; i++) {
      const p = existingPlaces[i];
      coords.push({ id: p.fk_locations, lat: Number(p.latitude), lng: Number(p.longitude) });
      indexMap.push({ type: 'existing', existingIndex: i });
    }
    coords.push({ id: Number(place.fk_location), lat: Number(newLoc.latitude), lng: Number(newLoc.longitude) });
    indexMap.push({ type: 'new', existingIndex: null });

    // Ask routing service for matrix (this expects a `routing` module available in runtime)
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
