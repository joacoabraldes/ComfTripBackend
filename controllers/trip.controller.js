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
             'imagenes', l.imagenes
           )
         ) ORDER BY tp.date, tp.start_hour) AS places
  FROM trip_places tp
  JOIN locations l ON l.id = tp.fk_locations
  GROUP BY fk_trips
`;

/* ---------------------------
   Existing trip endpoints
   --------------------------- */

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
 */
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

/* ---------------------------------------------------------------------
   NEW: GET /trips/:id/itinerary
   - Generate an itinerary suggestion for a trip taking into account:
     * user's interests (user_interests)
     * locations in the trip's country / matching destination
     * prioritizing relevance and spatial proximity (nearest neighbors)
   - Optional querystring: ?save=true will persist generated places into trip_places
   --------------------------------------------------------------------- */
router.get('/:id/itinerary', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const save = String(req.query.save || '').toLowerCase() === 'true';

    // 1) Load trip and ensure ownership
    const tripRes = await pool.query('SELECT id, user_id, destination, start_date, end_date FROM trips WHERE id = $1', [tripId]);
    if (!tripRes.rows.length) {
      return res.status(404).json({ message: 'No encontrado' });
    }
    const trip = tripRes.rows[0];
    if (trip.user_id !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    // Compute trip days
    let days = 1;
    let startDate = trip.start_date ? new Date(trip.start_date) : null;
    let endDate = trip.end_date ? new Date(trip.end_date) : null;
    if (startDate && endDate) {
      // include both dates
      const ms = endDate.setHours(0,0,0,0) - (new Date(startDate).setHours(0,0,0,0));
      days = Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)) + 1);
      // restore endDate var
      endDate = new Date(trip.end_date);
    } else {
      // fallback: 1 day trip, set startDate to today if not provided
      if (!startDate) startDate = new Date();
      endDate = new Date(startDate);
      days = 1;
    }

    // 2) Load user's interests (slugs)
    const uiRes = await pool.query(`
      SELECT i.slug
      FROM interests i
      JOIN user_interests ui ON ui.interest_id = i.id
      WHERE ui.user_id = $1
    `, [userId]);
    const userInterestSlugs = uiRes.rows.map(r => String(r.slug));

    // 3) Determine country or fallback search term from trip.destination
    const destRaw = (trip.destination || '').trim();
    let countryGuess = null;
    if (destRaw.includes(',')) {
      const parts = destRaw.split(',').map(s => s.trim()).filter(Boolean);
      countryGuess = parts.length ? parts[parts.length - 1] : null;
    }
    // fallback to whole destination if no comma
    const fallbackTerm = destRaw || '';

    // 4) Fetch candidate locations
    let candidatesRes;
    if (countryGuess) {
      // use ILIKE for partial match
      const sql = `
        SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country
        FROM locations
        WHERE country ILIKE $1
        ORDER BY relevancia DESC NULLS LAST
        LIMIT 500
      `;
      candidatesRes = await pool.query(sql, [`%${countryGuess}%`]);
    }

    if (!candidatesRes || candidatesRes.rows.length === 0) {
      // fallback: search by title or description containing the main destination token
      const searchTerm = fallbackTerm.split(',')[0] || fallbackTerm;
      const sql2 = `
        SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country
        FROM locations
        WHERE (titulo ILIKE $1 OR descripcion ILIKE $1)
        ORDER BY relevancia DESC NULLS LAST
        LIMIT 500
      `;
      candidatesRes = await pool.query(sql2, [`%${searchTerm}%`]);
    }

    const rawCandidates = candidatesRes.rows.map(r => ({
      id: r.id,
      titulo: r.titulo,
      fk_interest: r.fk_interest,
      descripcion: r.descripcion,
      lat: r.latitud !== null && r.latitud !== undefined ? Number(r.latitud) : null,
      lng: r.longitud !== null && r.longitud !== undefined ? Number(r.longitud) : null,
      imagenes: r.imagenes,
      relevancia: r.relevancia !== null && r.relevancia !== undefined ? Number(r.relevancia) : 0,
      country: r.country || null
    })).filter(Boolean);

    if (!rawCandidates.length) {
      return res.status(200).json({ itinerary: [], message: 'No se encontraron localidades para generar el itinerario' });
    }

    // 5) Prefer locations that match user's interests
    const preferred = [];
    const others = [];
    for (const c of rawCandidates) {
      if (userInterestSlugs.length && c.fk_interest && userInterestSlugs.includes(String(c.fk_interest))) {
        preferred.push(c);
      } else {
        others.push(c);
      }
    }
    // combine: preferred first (already ordered by relevancia), then others
    const candidates = [...preferred, ...others];

    // 6) Helper: haversine distance (km)
    function haversineKm(a, b) {
      if (a == null || b == null) return Number.POSITIVE_INFINITY;
      const lat1 = a.lat, lon1 = a.lng, lat2 = b.lat, lon2 = b.lng;
      if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Number.POSITIVE_INFINITY;
      const toRad = (v) => (v * Math.PI) / 180;
      const R = 6371; // km
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const la1 = toRad(lat1);
      const la2 = toRad(lat2);
      const aHarv = Math.sin(dLat/2) * Math.sin(dLat/2) +
                    Math.cos(la1) * Math.cos(la2) *
                    Math.sin(dLon/2) * Math.sin(dLon/2);
      const cHarv = 2 * Math.atan2(Math.sqrt(aHarv), Math.sqrt(1 - aHarv));
      return R * cHarv;
    }

    // 7) Build itinerary days using greedy nearest neighbor
    const placesPerDay = 3; // you can tweak this; currently up to 3 per day
    const used = new Set();
    const itinerary = [];

    // copy candidates to mutable array
    const poolLocations = candidates.slice();

    for (let dayIdx = 0; dayIdx < days; dayIdx++) {
      const dayDateObj = new Date(startDate);
      dayDateObj.setDate(startDate.getDate() + dayIdx);
      // select up to placesPerDay for this day
      const dayPlaces = [];

      // pick seed: highest relevance unused
      while (dayPlaces.length < placesPerDay) {
        // find best unused candidate (highest relevancia) as seed for the day if dayPlaces empty
        if (dayPlaces.length === 0) {
          let seedIdx = -1;
          for (let i = 0; i < poolLocations.length; i++) {
            const c = poolLocations[i];
            if (!used.has(c.id)) {
              seedIdx = i;
              break;
            }
          }
          if (seedIdx === -1) break; // none left
          const seed = poolLocations[seedIdx];
          if (!seed || seed.lat == null || seed.lng == null) {
            // if missing coordinates, mark used and continue
            used.add(seed.id);
            continue;
          }
          dayPlaces.push(seed);
          used.add(seed.id);
        } else {
          // find nearest unused to last place
          const last = dayPlaces[dayPlaces.length - 1];
          let nearest = null;
          let nearestIdx = -1;
          let nearestDist = Number.POSITIVE_INFINITY;
          for (let i = 0; i < poolLocations.length; i++) {
            const c = poolLocations[i];
            if (used.has(c.id)) continue;
            if (c.lat == null || c.lng == null) continue;
            const d = haversineKm(last, c);
            // factor relevance as tie-breaker: prefer closer and higher relevance => score = d - relevance*0.01
            const score = d - (c.relevancia ? (c.relevancia * 0.0001) : 0);
            if (score < nearestDist) {
              nearestDist = score;
              nearest = c;
              nearestIdx = i;
            }
          }
          if (!nearest) break;
          dayPlaces.push(nearest);
          used.add(nearest.id);
        }
      }

      // format places for response, include distances from day's first place
      const dayFormatted = dayPlaces.map((p, idx) => {
        const distFromFirst = dayPlaces.length ? haversineKm(dayPlaces[0], p) : 0;
        return {
          id: p.id,
          titulo: p.titulo,
          fk_interest: p.fk_interest,
          descripcion: p.descripcion,
          lat: p.lat,
          lng: p.lng,
          relevancia: p.relevancia,
          distance_from_first_km: Number(distFromFirst.toFixed(3)),
        };
      });

      itinerary.push({
        date: dayDateObj.toISOString().slice(0,10),
        places: dayFormatted
      });
    }

    // if save requested, persist into trip_places table in a transaction
    let savedRows = [];
    if (save) {
      await client.query('BEGIN');
      try {
        const insertSQL = 'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

        // basic schedule: first place start 09:00, each activity 2 hours
        for (const day of itinerary) {
          for (let idx = 0; idx < (day.places || []).length; idx++) {
            const p = day.places[idx];
            const startHour = `${String(9 + idx * 2).padStart(2,'0')}:00:00`;
            const endHour = `${String(9 + idx * 2 + 2).padStart(2,'0')}:00:00`;
            const r = await client.query(insertSQL, [
              p.id,
              tripId,
              day.date,
              startHour,
              endHour,
              null
            ]);
            savedRows.push(r.rows[0]);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error saving itinerary into trip_places:', err);
        return res.status(500).json({ message: 'Error guardando el itinerario' });
      }
    }

    return res.json({ itinerary, saved: save, savedPlaces: savedRows });
  } catch (err) {
    console.error('GET /trips/:id/itinerary error:', err);
    res.status(500).json({ message: 'Error generando itinerario' });
  } finally {
    client.release();
  }
});

/* ---------------------------
   Existing update / delete / places endpoints below
   (unchanged from your original implementation)
   --------------------------- */

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
    const ownerRes = await pool.query('SELECT user_id FROM trips WHERE id = $1', [id]);
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
