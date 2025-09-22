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
             'relevancia', l.relevancia
           )
         ) ORDER BY tp.date, tp.start_hour) AS places
  FROM trip_places tp
  JOIN locations l ON l.id = tp.fk_locations
  GROUP BY fk_trips
`;

/**
 * Utility: Haversine distance (meters)
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  if (
    lat1 === null ||
    lat2 === null ||
    lon1 === null ||
    lon2 === null ||
    Number.isNaN(lat1) ||
    Number.isNaN(lat2) ||
    Number.isNaN(lon1) ||
    Number.isNaN(lon2)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000; // earth radius meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Build a simple itinerary for a trip:
 * - choose locations matching the user's interests and (preferably) the trip country
 * - greedily group nearby locations per day
 * - allocate times: start at 09:00, durationPerPlace (default 2h), gap (default 1h)
 *
 * Query: GET /trips/:id/itinerary
 * Query params:
 *   - save=true  => persist generated itinerary (replace existing trip_places)
 *   - placesPerDay (optional, default 3)
 */
router.get('/:id/itinerary', auth, async (req, res) => {
  const tripId = Number(req.params.id);
  const userId = req.user.id;
  const save = req.query.save === 'true' || req.query.save === '1';
  const placesPerDay = Number(req.query.placesPerDay) || 3;

  if (!Number.isFinite(tripId) || tripId <= 0) {
    return res.status(400).json({ message: 'Invalid trip id' });
  }

  let client;
  try {
    // fetch trip + ownership
    const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip not found' });
    const trip = tripRes.rows[0];
    if (trip.user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // require start and end dates
    if (!trip.start_date || !trip.end_date) {
      return res.status(400).json({ message: 'Trip needs start_date and end_date' });
    }

    // get user interests (slugs)
    const uiRes = await pool.query(
      `SELECT i.slug
       FROM interests i
       JOIN user_interests ui ON i.id = ui.interest_id
       WHERE ui.user_id = $1`,
      [userId]
    );
    const interestSlugs = uiRes.rows.map(r => r.slug);

    // derive country from trip.destination if possible (expected "Province, Country" or "... , Country")
    let country = null;
    if (typeof trip.destination === 'string' && trip.destination.includes(',')) {
      const parts = trip.destination.split(',');
      country = parts[parts.length - 1].trim();
    } else if (typeof trip.destination === 'string') {
      // fallback attempt: last word
      const parts = trip.destination.trim().split(' ');
      country = parts.length > 1 ? parts[parts.length - 1] : trip.destination.trim();
    }

    // fetch candidate locations:
    // prefer country + interest matches, ordered by relevancia desc
    // keep a reasonable max (200)
    let candidates = [];
    if (interestSlugs.length > 0) {
      if (country) {
        const rows = await pool.query(
          `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
           FROM locations
           WHERE country ILIKE $1 AND fk_interest = ANY($2)
           ORDER BY relevancia DESC NULLS LAST
           LIMIT 200`,
          [country, interestSlugs]
        );
        candidates = rows.rows;
      }
      // fallback: if none found or country not provided, fetch by interests globally
      if (!candidates.length) {
        const rows = await pool.query(
          `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
           FROM locations
           WHERE fk_interest = ANY($1)
           ORDER BY relevancia DESC NULLS LAST
           LIMIT 300`,
          [interestSlugs]
        );
        candidates = rows.rows;
      }
    }

    // last resort: if still empty, fetch top locations by relevancia optionally filtered by country
    if (!candidates.length) {
      if (country) {
        const rows = await pool.query(
          `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
           FROM locations
           WHERE country ILIKE $1
           ORDER BY relevancia DESC NULLS LAST
           LIMIT 300`,
          [country]
        );
        candidates = rows.rows;
      } else {
        const rows = await pool.query(
          `SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
           FROM locations
           ORDER BY relevancia DESC NULLS LAST
           LIMIT 300`
        );
        candidates = rows.rows;
      }
    }

    // normalize numeric coords and relevancia
    candidates = candidates.map(c => ({
      id: c.id,
      titulo: c.titulo,
      fk_interest: c.fk_interest,
      lat: c.latitud !== null && c.latitud !== undefined ? Number(c.latitud) : null,
      lng: c.longitud !== null && c.longitud !== undefined ? Number(c.longitud) : null,
      imagenes: c.imagenes,
      relevancia: c.relevancia !== null && c.relevancia !== undefined ? Number(c.relevancia) : 0,
      country: c.country || null
    }));

    // sort initial candidates by relevancia desc (stable)
    candidates.sort((a, b) => (b.relevancia || 0) - (a.relevancia || 0));

    // Build days array (inclusive)
    const startDate = new Date(trip.start_date);
    const endDate = new Date(trip.end_date);
    const days = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      days.push(new Date(d)); // copy
    }

    // Greedy grouping: for each day pick up to placesPerDay locations,
    // choose highest relevance first, then pick nearest remaining
    const usedIds = new Set();
    const itinerary = [];

    // We'll keep a working list of candidates we can remove from
    let poolCandidates = candidates.slice();

    for (const day of days) {
      if (!poolCandidates.length) {
        // nothing left
        itinerary.push({ date: new Date(day), places: [] });
        continue;
      }

      const dayPlaces = [];

      // pick the top relevance location as seed for the day
      // find next candidate not used
      let seedIndex = poolCandidates.findIndex(c => !usedIds.has(c.id));
      if (seedIndex === -1) {
        itinerary.push({ date: new Date(day), places: [] });
        continue;
      }

      // take seed
      const seed = poolCandidates.splice(seedIndex, 1)[0];
      usedIds.add(seed.id);
      dayPlaces.push(seed);

      // greedily add nearest neighbors up to placesPerDay
      while (dayPlaces.length < placesPerDay && poolCandidates.length) {
        const prev = dayPlaces[dayPlaces.length - 1];
        // compute distance to all remaining
        let bestIdx = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < poolCandidates.length; i++) {
          const c = poolCandidates[i];
          const dist = haversineMeters(prev.lat, prev.lng, c.lat, c.lng);
          // tie-breaker: prefer higher relevance if distances similar
          const tieScore = (c.relevancia || 0) * 0.0001;
          const effective = dist - tieScore;
          if (effective < bestDist) {
            bestDist = effective;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) break;
        const chosen = poolCandidates.splice(bestIdx, 1)[0];
        usedIds.add(chosen.id);
        dayPlaces.push(chosen);
      }

      itinerary.push({ date: new Date(day), places: dayPlaces });
    }

    // assign times to places (per day):
    // startAt 09:00, durationPerPlace 2h, gap 1h (configurable constants)
    const durationHours = 2;
    const gapHours = 1;
    function hhmmssFromHourFloat(h) {
      const hh = String(Math.floor(h)).padStart(2, '0');
      const mm = String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0');
      return `${hh}:${mm}:00`;
    }

    const itineraryWithTimes = itinerary.map(dayBlock => {
      const dateOnly = dayBlock.date.toISOString().slice(0, 10); // YYYY-MM-DD
      let currentStart = 9; // 9:00
      const placesWithTimes = (dayBlock.places || []).map((loc, idx) => {
        const start_hr = hhmmssFromHourFloat(currentStart);
        const end_hr = hhmmssFromHourFloat(currentStart + durationHours);
        currentStart = currentStart + durationHours + gapHours;
        return {
          id: loc.id,
          titulo: loc.titulo,
          fk_interest: loc.fk_interest,
          latitude: loc.lat,
          longitude: loc.lng,
          imagenes: loc.imagenes,
          relevancia: loc.relevancia,
          start_hour: start_hr,
          end_hour: end_hr,
          date: dateOnly
        };
      });
      return {
        date: dateOnly,
        places: placesWithTimes
      };
    });

    // If save=true persist the itinerary (replace existing trip_places)
    let insertedPlaces = [];
    if (save) {
      client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Ensure trip exists and belongs to user (again, using client)
        const check = await client.query('SELECT user_id FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
        if (!check.rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ message: 'Trip not found' });
        }
        if (check.rows[0].user_id !== userId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ message: 'No autorizado' });
        }

        // delete existing trip_places for trip
        await client.query('DELETE FROM trip_places WHERE fk_trips = $1', [tripId]);

        const insertSQL =
          'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

        for (const day of itineraryWithTimes) {
          for (const p of day.places) {
            // p.id is location id
            const r = await client.query(insertSQL, [
              p.id,
              tripId,
              p.date, // Postgres will cast date string to timestamp
              p.start_hour,
              p.end_hour,
              null
            ]);
            insertedPlaces.push(r.rows[0]);
          }
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(()=>{});
        throw e;
      } finally {
        client.release();
        client = null;
      }
    }

    return res.json({
      itinerary: itineraryWithTimes,
      saved: !!save,
      insertedCount: insertedPlaces.length,
      insertedPlaces
    });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
    }
    console.error('GET /trips/:id/itinerary error:', err);
    return res.status(500).json({ message: 'Error generating itinerary', detail: err?.message || String(err) });
  }
});

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
 *
 * NOTE: This route must be after /:id/itinerary above.
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
