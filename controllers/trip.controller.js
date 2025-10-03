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

// inside controllers/trip.controller.js near the top:
const fetch = require('node-fetch'); // if Node < 18
const poiService = require('../services/poi.service');
const routingService = require('../services/routing.service');
const optimizer = require('../services/optimizer.service'); // should accept spec & travelMatrix
// pool, auth, router already declared in your file

// Helper: robust JSON extraction from model output
function extractJsonFromText(text) {
  text = (text || '').trim();
  try { return JSON.parse(text); } catch (e) {}
  // try to find first {..} or [..] block
  const o = text.indexOf('{'); const b = text.indexOf('[');
  const start = (o === -1) ? b : (b === -1 ? o : Math.min(o,b));
  if (start === -1) return null;
  for (let end = text.length; end > start; end--) {
    try {
      const substr = text.slice(start, end);
      return JSON.parse(substr);
    } catch (e) { /* continue */ }
  }
  return null;
}

// Call Hugging Face inference for a prompt
async function callHF(prompt, opts = {}) {
  const model = process.env.HF_MODEL;
  const token = process.env.HF_API_TOKEN;
  if (!model || !token) throw new Error('Please set HF_MODEL and HF_API_TOKEN env vars.');
  const url = `https://api-inference.huggingface.co/models/${model}`;
  const body = {
    inputs: prompt,
    options: { wait_for_model: true, use_cache: false },
    parameters: {
      max_new_tokens: opts.max_new_tokens || 1024,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
      top_p: opts.top_p ?? 0.95
    }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: opts.timeout || 120000
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HF ${resp.status}: ${text}`);
  const parsed = extractJsonFromText(text);
  if (!parsed) throw new Error('Could not parse JSON from HF response');
  return parsed;
}

/**
 * GET /trips/:id/itinerary
 * Implements Google-style hybrid: LLM->spec + LLM->POI scoring -> routing matrix -> optimizer (OR-Tools preferred) -> repair -> save
 *
 * Query params:
 *   - save=true => persist result
 *   - topK (default 20) => how many candidates to include in LLM prompts
 *   - mode: 'hf' (default) or 'greedy' to skip HF planning and use greedy
 */
router.get('/:id/itinerary', auth, async (req, res) => {
  const tripId = Number(req.params.id);
  const userId = req.user.id;
  const save = req.query.save === 'true' || req.query.save === '1';
  const topK = Number(req.query.topK) || Number(process.env.LLM_TOP_K) || 20;
  const mode = req.query.mode || 'hf'; // 'hf' or 'greedy'

  if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

  let client = null;
  try {
    // 1) load trip & ownership
    const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip not found' });
    const trip = tripRes.rows[0];
    if (trip.user_id !== userId) return res.status(403).json({ message: 'No autorizado' });
    if (!trip.start_date || !trip.end_date) return res.status(400).json({ message: 'Trip needs start_date and end_date' });

    // 2) user interests
    const uiRes = await pool.query(
      `SELECT i.slug FROM interests i JOIN user_interests ui ON i.id = ui.interest_id WHERE ui.user_id = $1`,
      [userId]
    );
    const interestSlugs = uiRes.rows.map(r => r.slug);

    // derive country (best-effort)
    let country = null;
    if (typeof trip.destination === 'string' && trip.destination.includes(',')) {
      const parts = trip.destination.split(',');
      country = parts[parts.length - 1].trim();
    } else if (typeof trip.destination === 'string') {
      const parts = trip.destination.trim().split(' ');
      country = parts.length > 1 ? parts[parts.length - 1] : trip.destination.trim();
    }

    // 3) fetch candidate POIs (db-first)
    let candidates = await poiService.getCandidates({ db: pool, interestSlugs, destination: trip.destination, limit: 300, notes: trip.notes });

    if (!candidates || !candidates.length) return res.status(404).json({ message: 'No candidate locations found' });

    // sort by relevancia and take topK for the LLM
    candidates.sort((a,b) => (b.relevancia || 0) - (a.relevancia || 0));
    const topCandidates = candidates.slice(0, topK);

    // 4) Parse user preferences into a structured spec (LLM role 1)
    // Build a compact spec prompt
    const prefPrompt = `
You are a trip-spec parser. Input: user preferences and trip metadata. Output: EXACT JSON with keys:
{
 "daily_hours": {"start":"HH:MM","end":"HH:MM"},
 "visit_default_minutes": <int>,
 "relaxation": "low|moderate|high",
 "must_visit": [ <poi ids or names> ],
 "avoid": [ <keywords to avoid> ],
 "max_travel_minutes_per_day": <int|null>
}
Input object:
${JSON.stringify({
      destination: trip.destination,
      start_date: (new Date(trip.start_date)).toISOString().slice(0,10),
      end_date: (new Date(trip.end_date)).toISOString().slice(0,10),
      budget: trip.budget,
      interests: interestSlugs,
      notes: trip.notes || ''
    }, null, 2)}
Return only JSON.
`;
    let spec = null;
    try {
      if (mode === 'hf') spec = await callHF(prefPrompt, { max_new_tokens: 300, temperature: 0.0 });
    } catch (err) {
      console.warn('Spec parsing with HF failed, using heuristic fallback', err?.message || err);
      // fallback heuristic
      spec = { daily_hours: { start: '09:00', end: '18:00' }, visit_default_minutes: 90, relaxation: 'moderate', must_visit: [], avoid: [], max_travel_minutes_per_day: 180 };
    }

    // 5) Score POIs semantically with HF (LLM role 2) — batch to reduce calls
    // Build compact POI payload
    const smallPois = topCandidates.map((p, idx) => ({
      id: p.id, title: p.titulo, interest: p.fk_interest, country: p.country, relevancia: p.relevancia || 0, idx
    }));
    const batchSize = Number(process.env.HF_BATCH) || 12;
    const scoreResults = [];
    if (mode === 'hf') {
      for (let i=0;i<smallPois.length;i+=batchSize) {
        const chunk = smallPois.slice(i,i+batchSize);
        const scorePrompt = `
You are a travel assistant. Given the user's preferences and the following POIs, return a JSON array exactly with elements:
[{"id": <poi id>, "score": <1.0..5.0 float>, "reason": "short (max 15 words)"}]
User prefs: ${JSON.stringify({...spec, notes: trip.notes || '', budget: trip.budget, interests: interestSlugs})}
POIS: ${JSON.stringify(chunk)}
Return only JSON.
`;
        try {
          const parsed = await callHF(scorePrompt, { max_new_tokens: 400, temperature: 0.0 });
          if (!Array.isArray(parsed)) throw new Error('HF scoring returned non-array');
          parsed.forEach(p => scoreResults.push(p));
        } catch (err) {
          console.warn('HF POI scoring failed for chunk, using fallback heuristics', err?.message || err);
          chunk.forEach(c => scoreResults.push({ id: c.id, score: Math.max(1, Math.min(5, 1 + ((c.relevancia||0)/10)*4)), reason: 'heuristic fallback' }));
        }
      }
    } else {
      // forced greedy mode: just heuristic score
      smallPois.forEach(c => scoreResults.push({ id: c.id, score: Math.max(1, Math.min(5, 1 + ((c.relevancia||0)/10)*4)), reason:'heuristic' }));
    }

    // merge scores into topCandidates and compute combined_score
    const scoreMap = new Map(scoreResults.map(s => [s.id, s]));
    topCandidates.forEach(p => {
      const s = scoreMap.get(p.id);
      p.llm_score = s ? Number(s.score) : 1.0;
      p.llm_reason = s ? String(s.reason).slice(0,200) : null;
      // combined score: tweak weights as you like
      p.combined_score = ((p.relevancia || 0) * 0.6) + ((p.llm_score || 1) * 2.0);
    });
    topCandidates.sort((a,b)=> (b.combined_score || 0) - (a.combined_score || 0));

    // 6) compute travel matrix for topCandidates (seconds) via routing service
    const coords = topCandidates.map(c => ({ id: c.id, lat: c.lat, lng: c.lng }));
    let travelMatrixSeconds = await routingService.getMatrix(coords); // fallback is haversine-based inside service

    // convert seconds->minutes for some solvers / prompt if needed
    const travelMatrixMinutes = travelMatrixSeconds.map(row => row.map(v => (isFinite(v) ? Math.round(v/60) : null)));

    // 7) call optimizer: prefer OR-Tools VRP with time windows (mode 'ortools'), else greedy fallback.
    // Pass the spec (visit_default_minutes, daily window) and travelMatrixSeconds.
    let itinerary = null;
    try {
      // if you have OR-Tools python solver ready, call with mode 'ortools' by setting ITINERARY_MODE env var
      const useOrtools = (process.env.ITINERARY_MODE === 'ortools' || req.query.useOrtools === '1');
      itinerary = await optimizer.generateItinerary({
        mode: useOrtools ? 'ortools' : 'greedy',
        candidates: topCandidates,
        days: (() => { const s=new Date(trip.start_date), e=new Date(trip.end_date), days=[]; for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)) days.push(new Date(d)); return days; })(),
        travelMatrix: travelMatrixSeconds,
        spec: spec, // includes visit_default_minutes and max_travel_minutes_per_day etc.
        placesPerDay: null // intentionally allow optimizer to decide; greedy fallback will use an internal heuristic
      });
    } catch (err) {
      console.warn('Optimizer failed, falling back to greedy simple generator', err?.message || err);
      itinerary = await optimizer.generateItinerary({
        mode: 'greedy',
        candidates: topCandidates,
        days: (() => { const s=new Date(trip.start_date), e=new Date(trip.end_date), days=[]; for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)) days.push(new Date(d)); return days; })(),
        travelMatrix: travelMatrixSeconds,
        spec: spec,
        placesPerDay: 4 // fallback heuristic
      });
    }

    // 8) repair loop: validate that each day's visits fit daily_hours and travel estimates; if a day violates hard constraint, remove lowest combined_score POI(s) from that day and re-run small local repair.
    function validateAndRepair(itin) {
      const maxDailyMinutes = spec.max_travel_minutes_per_day || 24*60;
      const startMin = Number(spec.daily_hours?.start?.slice(0,2)) * 60 + Number(spec.daily_hours?.start?.slice(3,5) || 0);
      const endMin = Number(spec.daily_hours?.end?.slice(0,2)) * 60 + Number(spec.daily_hours?.end?.slice(3,5) || 0);
      const dayCapacity = Math.max(60, endMin - startMin);
      // simple pass: if any day's total visit_minutes + travel_to_prev_minutes > dayCapacity, drop lowest-scoring visit(s)
      for (const day of itin) {
        let total = 0;
        for (const v of day.visits || []) {
          total += (v.visit_minutes || spec.visit_default_minutes || 90) + (v.travel_to_prev_minutes || 0);
        }
        if (total > dayCapacity || total > maxDailyMinutes) {
          // drop lowest combined score visit(s) until fits
          day.visits.sort((a,b)=> {
            const ca = topCandidates.find(x=>x.id===a.id)?.combined_score || 0;
            const cb = topCandidates.find(x=>x.id===b.id)?.combined_score || 0;
            return ca - cb; // ascending
          });
          while (day.visits.length && (total > dayCapacity || total > maxDailyMinutes)) {
            const removed = day.visits.shift(); // remove least valuable
            total -= (removed.visit_minutes || spec.visit_default_minutes || 90) + (removed.travel_to_prev_minutes || 0);
          }
        }
      }
      return itin;
    }

    itinerary = validateAndRepair(itinerary);

    // 9) optionally save to DB if save=true (replace trip_places)
    const insertedPlaces = [];
    if (save) {
      client = await pool.connect();
      try {
        await client.query('BEGIN');
        const check = await client.query('SELECT user_id FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
        if (!check.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Trip not found' }); }
        if (check.rows[0].user_id !== userId) { await client.query('ROLLBACK'); return res.status(403).json({ message:'No autorizado' }); }

        await client.query('DELETE FROM trip_places WHERE fk_trips = $1', [tripId]);
        const insertSQL = 'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';
        for (const day of itinerary) {
          for (const v of day.visits || []) {
            const r = await client.query(insertSQL, [v.id, tripId, day.date, v.start, v.end, v.reason || null]);
            insertedPlaces.push(r.rows[0]);
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(()=>{});
        throw err;
      } finally {
        client.release();
        client = null;
      }
    }

    return res.json({ itinerary, saved: !!save, insertedCount: insertedPlaces.length, insertedPlaces });

  } catch (err) {
    if (client) { await client.query('ROLLBACK').catch(()=>{}); client.release(); }
    console.error('GET /trips/:id/itinerary error:', err);
    return res.status(500).json({ message:'Error generating itinerary', detail: err?.message || String(err) });
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
