// controllers/trip.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

/**
 * Helper: normalize trip row (keep same keys frontend expects)
 */
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

/**
 * SQL fragment used to aggregate trip_places + basic location info as JSON array.
 * We'll inject this as a LEFT JOIN subquery in queries below.
 */
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
             'latitude', l.latitud,
             'longitude', l.longitud,
             'imagenes', l.imagenes,
             'relevancia', l.relevancia,
             'country', l.country
           )
         ) ORDER BY tp.date, tp.start_hour) AS places
  FROM trip_places tp
  JOIN locations l ON l.id = tp.fk_locations
  GROUP BY fk_trips
`;

/* ---------- small helpers for itinerary generation ---------- */

/**
 * Haversine distance in kilometers
 */
function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDlat = Math.sin(dLat / 2) ** 2;
  const sinDlon = Math.sin(dLon / 2) ** 2;
  const inner = sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon;
  return 2 * R * Math.asin(Math.sqrt(inner));
}

/**
 * Simple greedy clustering by proximity that returns ordered arrays per day.
 * - places: array of { id, titulo, latitude, longitude, relevancia, fk_interest }
 * - days: integer (>0)
 *
 * Strategy:
 *  - pick highest relevancia as seed for day 1, then greedily pick nearest unassigned to fill day
 *  - limit visits per day to roughly ceil(total / days) with min 1 and max 6
 */
function clusterByProximity(places, days) {
  if (!Array.isArray(places) || places.length === 0) return Array.from({ length: days }, () => []);
  const total = places.length;
  const perDayBase = Math.max(1, Math.ceil(total / days));
  const maxPerDay = Math.min(6, perDayBase + 1);

  // copy and sort by relevancia desc
  const pool = places
    .map((p) => ({
      ...p,
      latitude: p.latitude !== undefined && p.latitude !== null ? Number(p.latitude) : null,
      longitude: p.longitude !== undefined && p.longitude !== null ? Number(p.longitude) : null,
    }))
    .slice()
    .sort((a, b) => (Number(b.relevancia || 0) - Number(a.relevancia || 0)));

  const daysArr = Array.from({ length: days }, () => []);
  const assigned = new Set();

  // seeds: use top `days` relevancia items as day seeds
  for (let d = 0; d < days; d++) {
    let seed = pool.find((p) => !assigned.has(p.id));
    if (!seed) break;
    daysArr[d].push(seed);
    assigned.add(seed.id);
  }

  // now greedily fill each day
  for (let d = 0; d < days; d++) {
    while (daysArr[d].length < maxPerDay && assigned.size < pool.length) {
      // find candidate closest to the last placed item in this day
      const last = daysArr[d][daysArr[d].length - 1];
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        if (assigned.has(p.id)) continue;
        // if last has coords use distance, else use -relevancia to prefer relevant places
        let dist = 0;
        if (last && last.latitude != null && last.longitude != null && p.latitude != null && p.longitude != null) {
          dist = haversineKm(last.latitude, last.longitude, p.latitude, p.longitude);
        } else {
          // fallback: sort by negative relevancia to prefer more relevant
          dist = -Number(p.relevancia || 0);
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      daysArr[d].push(pool[bestIdx]);
      assigned.add(pool[bestIdx].id);
    }
  }

  // If still unassigned (very rare), spread them round robin
  for (const p of pool) {
    if (!assigned.has(p.id)) {
      for (let d = 0; d < days; d++) {
        if (daysArr[d].length < maxPerDay) {
          daysArr[d].push(p);
          assigned.add(p.id);
          break;
        }
      }
    }
  }

  return daysArr;
}

/* ---------- Trip endpoints ---------- */

/**
 * GET /trips
 * List trips for the authenticated user, including places as JSON array
 */
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const sql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      WHERE t.user_id = $1
      ORDER BY t.start_date DESC
    `;

    const result = await pool.query(sql, [userId]);
    const trips = result.rows.map((r) => {
      const trip = normalizeTripRow(r);
      trip.places = r.places || [];
      return trip;
    });

    res.json(trips);
  } catch (err) {
    console.error('GET /trips error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * POST /trips
 * Create a trip. Optionally provide `places` array in body to insert trip_places in same transaction.
 *
 * If no places are provided, we'll attempt to auto-generate a simple itinerary
 * based on the user's interests and locations in the destination country.
 *
 * Body:
 *  { destination, start_date, end_date, budget, notes, places: [{ fk_location | locationId, date, start_hour, end_hour, notes }, ...] }
 */
router.post('/', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.id;
    let { destination, start_date, end_date, budget, notes, places } = req.body;

    // normalize destination: sometimes front sends "Province, Country"
    // extract country heuristically (last token after comma)
    let countryName = null;
    if (typeof destination === 'string') {
      const parts = destination.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) countryName = parts[parts.length - 1];
    }
    // fallback: if destination equals country
    if (!countryName && typeof destination === 'string') countryName = destination.trim();

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

    // helper SQL for inserting a place
    const insertPlaceSQL =
      'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

    // If client provided explicit places -> insert them
    if (Array.isArray(places) && places.length > 0) {
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
    } else {
      // No places provided -> attempt to generate an itinerary
      // Determine number of days
      let days = 1;
      try {
        if (start_date && end_date) {
          const s = new Date(start_date);
          const e = new Date(end_date);
          const diff = Math.ceil((e - s) / (1000 * 60 * 60 * 24));
          days = Math.max(1, diff + 1);
        }
      } catch (e) {
        days = 1;
      }

      // 1) fetch user interests (slugs)
      const interestsRes = await client.query(`
        SELECT i.slug
        FROM interests i
        JOIN user_interests ui ON ui.interest_id = i.id
        WHERE ui.user_id = $1
      `, [userId]);
      const interestSlugs = interestsRes.rows.map(r => r.slug).filter(Boolean);

      // 2) fetch candidate locations: try country + user interests first
      let candidateSql = null;
      let candidateParams = null;

      if (countryName && interestSlugs.length) {
        candidateSql = `
          SELECT id, titulo, fk_interest, latitud AS latitude, longitud AS longitude, COALESCE(relevancia,0) AS relevancia
          FROM locations
          WHERE (country ILIKE $1 OR titulo ILIKE $1)
            AND fk_interest = ANY($2::text[])
          ORDER BY relevancia DESC NULLS LAST
          LIMIT 80
        `;
        candidateParams = [`%${countryName}%`, interestSlugs];
      } else if (countryName) {
        candidateSql = `
          SELECT id, titulo, fk_interest, latitud AS latitude, longitud AS longitude, COALESCE(relevancia,0) AS relevancia
          FROM locations
          WHERE (country ILIKE $1 OR titulo ILIKE $1)
          ORDER BY relevancia DESC NULLS LAST
          LIMIT 80
        `;
        candidateParams = [`%${countryName}%`];
      } else if (interestSlugs.length) {
        candidateSql = `
          SELECT id, titulo, fk_interest, latitud AS latitude, longitud AS longitude, COALESCE(relevancia,0) AS relevancia
          FROM locations
          WHERE fk_interest = ANY($1::text[])
          ORDER BY relevancia DESC NULLS LAST
          LIMIT 80
        `;
        candidateParams = [interestSlugs];
      } else {
        candidateSql = `
          SELECT id, titulo, fk_interest, latitud AS latitude, longitud AS longitude, COALESCE(relevancia,0) AS relevancia
          FROM locations
          ORDER BY relevancia DESC NULLS LAST
          LIMIT 80
        `;
        candidateParams = [];
      }

      const candidatesRes = candidateParams.length ? await client.query(candidateSql, candidateParams) : await client.query(candidateSql);
      const candidateRows = candidatesRes.rows || [];

      // map and filter to entries with coords if possible
      const cleaned = candidateRows
        .map(r => ({
          id: r.id,
          titulo: r.titulo,
          fk_interest: r.fk_interest,
          latitude: r.latitude !== null && r.latitude !== undefined ? Number(r.latitude) : null,
          longitude: r.longitude !== null && r.longitude !== undefined ? Number(r.longitude) : null,
          relevancia: Number(r.relevancia || 0)
        }))
        .filter(Boolean);

      // if we have almost no candidates -> expand search (ignore country)
      let finalCandidates = cleaned;
      if (finalCandidates.length < 6 && interestSlugs.length) {
        const moreRes = await client.query(`
          SELECT id, titulo, fk_interest, latitud AS latitude, longitud AS longitude, COALESCE(relevancia,0) AS relevancia
          FROM locations
          WHERE fk_interest = ANY($1::text[])
          ORDER BY relevancia DESC NULLS LAST
          LIMIT 100
        `, [interestSlugs]);
        finalCandidates = (moreRes.rows || []).map(r => ({
          id: r.id,
          titulo: r.titulo,
          fk_interest: r.fk_interest,
          latitude: r.latitude !== null && r.latitude !== undefined ? Number(r.latitude) : null,
          longitude: r.longitude !== null && r.longitude !== undefined ? Number(r.longitude) : null,
          relevancia: Number(r.relevancia || 0)
        }));
      }

      // Ensure we have at least some items
      if (finalCandidates.length > 0) {
        // pick up to (days * 4) items (rough)
        const limitItems = Math.min(finalCandidates.length, Math.max(3, days * 4));
        const selected = finalCandidates.slice(0, limitItems);

        // cluster
        const daysPlan = clusterByProximity(selected, days);

        // assign simple times: start at 09:00, each visit 2h, gap 1h (slot length 3h)
        // dateStr - generate ISO date for each day starting from start_date
        const startDateObj = start_date ? new Date(start_date) : new Date();
        for (let d = 0; d < daysPlan.length; d++) {
          const dayPlaces = daysPlan[d];
          if (!Array.isArray(dayPlaces) || dayPlaces.length === 0) continue;
          const dateObj = new Date(startDateObj);
          dateObj.setDate(startDateObj.getDate() + d);
          const isoDate = dateObj.toISOString(); // postgres timestamp with time zone ok
          let hourStart = 9; // 9AM first visit

          for (const p of dayPlaces) {
            const startHourStr = `${String(hourStart).padStart(2,'0')}:00:00`;
            const endHourStr = `${String(hourStart + 2).padStart(2,'0')}:00:00`;
            // create trip_place row
            const placeRes = await client.query(insertPlaceSQL, [
              p.id,
              tripId,
              isoDate,
              startHourStr,
              endHourStr,
              `Itinerario automático (${p.fk_interest || 'general'})`
            ]);
            createdPlaces.push(placeRes.rows[0]);
            // increase hour with gap
            hourStart += 3;
            if (hourStart > 20) hourStart = 20; // cap
          }
        }
      }
    }

    await client.query('COMMIT');

    // return created trip + inserted places (may be empty)
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

/**
 * GET /trips/:id
 * Get a single trip with its places. Ownership check.
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;

    const sql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      WHERE t.id = $1 AND t.user_id = $2
      LIMIT 1
    `;
    const result = await pool.query(sql, [id, userId]);

    if (!result.rows.length) return res.status(404).json({ message: 'No encontrado' });

    const row = result.rows[0];
    const trip = normalizeTripRow(row);
    trip.places = row.places || [];

    res.json(trip);
  } catch (err) {
    console.error('GET /trips/:id error:', err);
    res.status(500).json({ message: 'Error' });
  }
});

/**
 * NEW: GET /trips/next
 * Return the next (nearest upcoming) trip for the authenticated user.
 * If no upcoming trips (start_date >= today) exist, return the most recent past trip.
 */
router.get('/next', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1) Try to find the next upcoming trip (start_date >= today), earliest start_date
    const upcomingSql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      WHERE t.user_id = $1 AND t.start_date >= CURRENT_DATE
      ORDER BY t.start_date ASC
      LIMIT 1
    `;
    let result = await pool.query(upcomingSql, [userId]);
    if (result.rows.length) {
      const row = result.rows[0];
      const trip = normalizeTripRow(row);
      trip.places = row.places || [];
      return res.json({ trip });
    }

    // 2) If no upcoming trips, return the most recent past trip (latest start_date < today)
    const pastSql = `
      SELECT
        t.id, t.user_id, t.destination, t.start_date, t.end_date, t.budget, t.notes, t.created_at,
        COALESCE(tp.places, '[]') AS places
      FROM trips t
      LEFT JOIN (
        ${PLACES_AGG_SUBQUERY}
      ) tp ON tp.fk_trips = t.id
      WHERE t.user_id = $1
      ORDER BY t.start_date DESC
      LIMIT 1
    `;
    result = await pool.query(pastSql, [userId]);
    if (result.rows.length) {
      const row = result.rows[0];
      const trip = normalizeTripRow(row);
      trip.places = row.places || [];
      return res.json({ trip });
    }

    // no trips at all
    return res.status(404).json({ message: 'No se encontraron viajes para el usuario' });
  } catch (err) {
    console.error('GET /trips/next error:', err);
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

module.exports = router;
