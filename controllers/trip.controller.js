// controllers/trip.controller.js
const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();
const { generateText, embedTexts } = require('../services/hf.client'); // HF helpers (already en tu repo)
const { haversineMeters } = require('../services/travelTime'); // helper distance

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
 * Ensure a location with same title+country exists, otherwise create it.
 * Returns the location id.
 * Uses the provided client (transactional).
 */
async function ensureLocationExists(client, candidate) {
  // candidate: { title, interest, descripcion, lat, lng, imagenes, relevancia, country }
  const title = candidate.title || candidate.titulo || candidate.name;
  const country = candidate.country || null;

  // Try to match by exact title + country (case-insensitive)
  const q = `SELECT id FROM locations WHERE LOWER(titulo) = LOWER($1) ${country ? 'AND country ILIKE $2' : ''} LIMIT 1`;
  const params = country ? [title, country] : [title];
  const r = await client.query(q, params);
  if (r.rows.length) return r.rows[0].id;

  // Insert new location
  const insertSQL = `
    INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `;
  const imagenesJson = candidate.imagenes && typeof candidate.imagenes !== 'string' ? JSON.stringify(candidate.imagenes) : candidate.imagenes || null;
  const res = await client.query(insertSQL, [
    title,
    candidate.interest || null,
    candidate.descripcion || candidate.description || null,
    candidate.lat || candidate.latitude || null,
    candidate.lng || candidate.longitude || null,
    imagenesJson,
    candidate.relevancia || candidate.relevance || 1,
    country
  ]);
  return res.rows[0].id;
}

/**
 * Ask the HF model to generate a list of candidate places for a trip.
 * The prompt requests strictly JSON array of objects: [{ "title": "...", "interest": "...", "lat":..., "lng":..., "descripcion": "...", "imagenes": ["..."], "relevancia": 0..10, "country": "..." }, ...]
 * We try to parse JSON; if parsing fails we return [].
 */
async function generateCandidatesWithHF({ country, interests = [], startDate, endDate, budget = null, maxCandidates = 20 }) {
  try {
    const interestText = Array.isArray(interests) && interests.length ? interests.join(', ') : 'sin preferencias concretas';
    const prompt = `
You are a helpful travel assistant. Produce a JSON array (only valid JSON, nothing else) of up to ${maxCandidates} candidate places (points of interest) suitable for a trip to "${country}" for a user with interests: ${interestText}.
Each item must be an object with these keys:
- "title" (string): name of the place
- "interest" (string|null): the category/interest slug (e.g., "gastronomy", "museums")
- "lat" (number|null): latitude if known, otherwise null
- "lng" (number|null): longitude if known, otherwise null
- "descripcion" (string|null): a one-line description
- "imagenes" (array|null): array of image URLs (can be empty array)
- "relevancia" (number): integer 1-10 relevance score (10 highest)
- "country" (string): country name (e.g., "Argentina")

Make recommendations realistic: respect opening hours (prefer daytime attractions for daytime), and prefer popular/relevant places for the country. Output only valid JSON array.
Trip dates: ${startDate || 'N/A'} to ${endDate || 'N/A'}. Budget: ${budget || 'N/A'}.
`;
    const raw = await generateText(prompt, { model: process.env.HF_GEN_MODEL || undefined, max_new_tokens: 700 });
    // Try to extract JSON substring
    let jsonText = raw.trim();
    // If the model prepends text, find first '[' and last ']' and cut
    const start = jsonText.indexOf('[');
    const end = jsonText.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      jsonText = jsonText.slice(start, end + 1);
    }
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    // sanitize items
    return parsed.slice(0, maxCandidates).map((it) => ({
      title: it.title || it.titulo || it.name || null,
      interest: it.interest || it.fk_interest || null,
      lat: typeof it.lat === 'number' ? it.lat : (it.latitude !== undefined ? Number(it.latitude) : null),
      lng: typeof it.lng === 'number' ? it.lng : (it.longitude !== undefined ? Number(it.longitude) : null),
      descripcion: it.descripcion || it.description || null,
      imagenes: Array.isArray(it.imagenes) ? it.imagenes : (it.images && Array.isArray(it.images) ? it.images : []),
      relevancia: (typeof it.relevancia === 'number') ? it.relevancia : (typeof it.relevance === 'number' ? it.relevance : 5),
      country: it.country || country || null
    }));
  } catch (err) {
    console.warn('HF generateCandidatesWithHF failed:', err?.message || err);
    return [];
  }
}

/**
 * Build itinerary items (simple greedy) from candidate locations.
 * Returns an array of objects for insertion: { locationId, date, start_hour, end_hour, notes }
 *
 * This function does not persist locations; expects candidates to include either id (existing) or lat/lng/title for creation.
 */
function buildItineraryFromCandidates({ candidates = [], tripStart, tripEnd, placesPerDay = 3, durationMinutes = 120, gapMinutes = 60 }) {
  // Normalize days
  const start = new Date(tripStart);
  const end = new Date(tripEnd);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }

  // clone candidates and compute initial score (relevancia)
  let pool = (candidates || []).map((c) => ({
    ...c,
    score: (c.relevancia || c.relevance || 1)
  }));

  // sort by score desc
  pool.sort((a, b) => (b.score || 0) - (a.score || 0));

  const used = new Set();
  const final = [];

  for (const day of days) {
    const dateIso = day.toISOString().slice(0, 10); // YYYY-MM-DD
    // pick seed = highest score not used
    const dayPlaces = [];
    let seedIdx = pool.findIndex(c => !used.has(c.id));
    if (seedIdx === -1) {
      // maybe pool items have no id (generated by HF) - allow them too
      seedIdx = pool.findIndex((c, idx) => !used.has(`HF-${idx}`));
    }
    if (seedIdx === -1) {
      final.push({ date: dateIso, places: [] });
      continue;
    }

    // choose seed
    const seed = pool.splice(seedIdx, 1)[0];
    const seedKey = seed.id ? seed.id : `HF-seed-${Math.random().toString(36).slice(2,8)}`;
    used.add(seedKey);
    dayPlaces.push(seed);

    // choose up to placesPerDay-1 nearest neighbors from remaining pool
    while (dayPlaces.length < placesPerDay && pool.length) {
      const last = dayPlaces[dayPlaces.length - 1];
      let bestIdx = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        // compute distance; if coords missing, prefer higher relevance
        let dist = Number.POSITIVE_INFINITY;
        if (last.lat !== null && last.lng !== null && c.lat !== null && c.lng !== null) {
          dist = haversineMeters(last.lat, last.lng, c.lat, c.lng);
        } else {
          dist = 1e9; // huge
        }
        // combine distance and inverse relevance: we want small effective score
        const effective = dist - ((c.relevancia || 1) * 1000);
        if (effective < bestScore) { bestScore = effective; bestIdx = i; }
      }
      if (bestIdx === -1) break;
      const chosen = pool.splice(bestIdx, 1)[0];
      used.add(chosen.id || `HF-${Math.random().toString(36).slice(2,8)}`);
      dayPlaces.push(chosen);
    }

    // assign simple times: start 09:00, each durationMinutes then gap
    let startMin = 9 * 60;
    const dayPlaced = dayPlaces.map((loc) => {
      const start_hour = `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
      const endMin = startMin + durationMinutes;
      const end_hour = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      startMin = endMin + gapMinutes;
      return {
        loc,
        date: dateIso,
        start_hour,
        end_hour,
        notes: `Sugerido (score ${(loc.relevancia||loc.score||0)})`
      };
    });

    final.push({ date: dateIso, places: dayPlaced });
  }

  return final;
}

/**
 * POST /trips
 * Create a trip. Optionally provide `places` array in body to insert trip_places in same transaction.
 *
 * NEW BEHAVIOR:
 * - After creating the trip, attempt to build an itinerary from DB locations filtered by country/interests.
 * - If not enough locations exist, call HF to generate candidates, create corresponding locations and then create trip_places.
 * - All done inside the same transaction so the trip + generated places are persisted atomically.
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

    // If client sent explicit places array, insert them (same as before)
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
    } else {
      // ELSE: try to auto-generate itinerary
      // 1) derive country from destination
      let country = null;
      if (typeof destination === 'string' && destination.includes(',')) {
        const parts = destination.split(',');
        country = parts[parts.length - 1].trim();
      } else if (typeof destination === 'string') {
        const parts = destination.trim().split(' ');
        country = parts.length > 1 ? parts[parts.length - 1] : destination.trim();
      }

      // 2) get user interests
      const uiRes = await client.query(
        `SELECT i.slug
         FROM interests i
         JOIN user_interests ui ON i.id = ui.interest_id
         WHERE ui.user_id = $1`,
        [userId]
      );
      const interestSlugs = uiRes.rows.map(r => r.slug);

      // 3) fetch candidate locations from DB filtered by country & interests
      let candidates = [];
      if (interestSlugs.length > 0) {
        if (country) {
          const q = `
            SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
            FROM locations
            WHERE country ILIKE $1 AND fk_interest = ANY($2)
            ORDER BY relevancia DESC NULLS LAST
            LIMIT 200
          `;
          const r = await client.query(q, [country, interestSlugs]);
          candidates = r.rows;
        }
        if (!candidates.length) {
          const q = `
            SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
            FROM locations
            WHERE fk_interest = ANY($1)
            ORDER BY relevancia DESC NULLS LAST
            LIMIT 300
          `;
          const r = await client.query(q, [interestSlugs]);
          candidates = r.rows;
        }
      }

      // if still empty, try by country only
      if (!candidates.length && country) {
        const q = `
          SELECT id, titulo, fk_interest, latitud, longitud, imagenes, relevancia, country
          FROM locations
          WHERE country ILIKE $1
          ORDER BY relevancia DESC NULLS LAST
          LIMIT 300
        `;
        const r = await client.query(q, [country]);
        candidates = r.rows;
      }

      // Now we have some DB candidates (maybe empty). Normalize them into candidate objects
      const normalizedDbCandidates = (candidates || []).map(c => ({
        id: c.id,
        titulo: c.titulo,
        fk_interest: c.fk_interest,
        lat: c.latitud !== null && c.latitud !== undefined ? Number(c.latitud) : null,
        lng: c.longitud !== null && c.longitud !== undefined ? Number(c.longitud) : null,
        imagenes: c.imagenes,
        relevancia: c.relevancia !== null && c.relevancia !== undefined ? Number(c.relevancia) : 0,
        country: c.country || null
      }));

      // If DB has enough candidates (>= placesPerDay * days), use DB-only path
      const startDate = start_date ? new Date(start_date) : null;
      const endDate = end_date ? new Date(end_date) : null;
      const daysCount = startDate && endDate ? Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1 : 1;
      const placesPerDay = 3;
      const threshold = Math.max(1, Math.min(placesPerDay * daysCount, 6)); // require at least this many to not call HF

      let finalStructuredItinerary = [];

      if (normalizedDbCandidates.length >= threshold) {
        // Build itinerary from DB candidates
        const built = buildItineraryFromCandidates({
          candidates: normalizedDbCandidates,
          tripStart: start_date,
          tripEnd: end_date,
          placesPerDay
        });
        finalStructuredItinerary = built;
      } else {
        // Not enough DB candidates -> ask HF to generate suggestions
        const hfCandidates = await generateCandidatesWithHF({
          country,
          interests: interestSlugs,
          startDate,
          endDate,
          budget,
          maxCandidates: Math.max(10, placesPerDay * daysCount * 2)
        });

        // Merge DB candidates + HF candidates (HF candidates may not have id)
        const combined = [
          ...normalizedDbCandidates,
          ...hfCandidates.map((hc, idx) => ({
            id: null,
            titulo: hc.title,
            fk_interest: hc.interest,
            lat: hc.lat,
            lng: hc.lng,
            imagenes: hc.imagenes,
            relevancia: hc.relevancia || 5,
            country: hc.country
          }))
        ];

        if (!combined.length) {
          // nothing to schedule
          finalStructuredItinerary = [];
        } else {
          finalStructuredItinerary = buildItineraryFromCandidates({
            candidates: combined,
            tripStart: start_date,
            tripEnd: end_date,
            placesPerDay
          });
        }
      }

      // Persist generated itinerary (create locations when needed, then trip_places)
      // Insert each day/place in order
      const insertPlaceSQL =
        'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

      for (const dayBlock of finalStructuredItinerary) {
        for (const p of dayBlock.places) {
          const candidate = p.loc || p; // in case shape differs
          // if candidate has id (existing location), use it; otherwise ensure creation
          let locationId = candidate.id || candidate.loc?.id || null;
          if (!locationId) {
            // ensureLocationExists (create)
            locationId = await ensureLocationExists(client, {
              title: candidate.titulo || candidate.title || candidate.name,
              interest: candidate.fk_interest || candidate.interest,
              descripcion: candidate.descripcion || candidate.description || null,
              lat: candidate.lat || candidate.latitude || null,
              lng: candidate.lng || candidate.longitude || null,
              imagenes: candidate.imagenes || null,
              relevancia: candidate.relevancia || 5,
              country: candidate.country || country
            });
          }
          const r = await client.query(insertPlaceSQL, [
            locationId,
            tripId,
            p.date,
            p.start_hour,
            p.end_hour,
            p.notes || null
          ]);
          createdPlaces.push(r.rows[0]);
        }
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
    res.status(500).json({ message: 'Error creando viaje', detail: err?.message || String(err) });
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

/* --- REST of routes unchanged from original --- */

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
