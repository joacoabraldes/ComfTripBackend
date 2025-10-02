// workers/itinerary.worker.js
require('dotenv').config();
const pool = require('../db'); // adjust path as needed
const { generateText, embedTexts } = require('../services/hf.client');
const { estimateTravelMinutes } = require('../services/travelTime');

/**
 * Simple scheduling strategy (MVP):
 * 1. Fetch trip & user interests
 * 2. Fetch candidate locations for trip destination (same country or top relevancia)
 * 3. If user has interests -> filter candidates by interest OR fallback to top relevancia
 * 4. Use HF generateText to ask for an initial ordered list (optional)
 * 5. Greedy schedule per day: pick highest relevancia not used, ensure travel buffer (estimate), assign start/end times (9:00-18:00 default)
 * 6. Insert into trip_places
 *
 * This is intentionally simple and robust; later replace with more advanced DP/local search.
 */

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function pickCandidatesForTrip(trip) {
  // derive country from trip.destination: expecting "Province, Country" or "City, Country"
  const dest = (trip.destination || '');
  const parts = dest.split(',').map(s => s.trim());
  const country = parts.length ? parts[parts.length - 1] : null;

  // first try to fetch locations in same country
  let q = `
    SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country
    FROM locations
    WHERE country ILIKE $1
    ORDER BY relevancia DESC NULLS LAST
    LIMIT 200
  `;
  let params = [country || '%'];
  let res = await pool.query(q, params);

  // fallback: if none in that country, take top by relevancia globally
  if (!res.rows.length) {
    res = await pool.query(`
      SELECT id, titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country
      FROM locations
      ORDER BY relevancia DESC NULLS LAST
      LIMIT 200
    `);
  }
  return res.rows;
}

async function scheduleForTrip(genRow) {
  const client = await pool.connect();
  try {
    const tripId = genRow.trip_id;
    const tripRes = await client.query('SELECT * FROM trips WHERE id = $1', [tripId]);
    if (!tripRes.rows.length) throw new Error('Trip not found');
    const trip = tripRes.rows[0];

    await client.query('BEGIN');
    // mark running
    await client.query('UPDATE itinerary_generations SET status=$1, progress=$2 WHERE id=$3', ['running', 0.05, genRow.id]);

    // 1) fetch candidates
    const candidates = await pickCandidatesForTrip(trip);

    // quick normalization
    const norm = candidates.map(c => ({
      id: c.id,
      title: c.titulo,
      lat: c.latitud ? Number(c.latitud) : null,
      lng: c.longitud ? Number(c.longitud) : null,
      interest: c.fk_interest,
      relevancia: Number(c.relevancia || 0),
      descripcion: c.descripcion
    }));

    // 2) if user has interests, attempt to prefer those:
    const userInterestsRes = await client.query(`
      SELECT i.slug
      FROM user_interests ui
      JOIN interests i ON ui.interest_id = i.id
      WHERE ui.user_id = $1
    `, [genRow.user_id]);
    const interestSlugs = (userInterestsRes.rows || []).map(r => r.slug);

    // filter/pref score
    let filtered = norm;
    if (interestSlugs.length) {
      // prefer matched interest, but keep others as fallback
      filtered = norm.map(l => ({
        ...l,
        score: (interestSlugs.includes(l.interest) ? 2 : 1) * (l.relevancia || 1)
      })).sort((a,b) => b.score - a.score);
    } else {
      // no interests -> just sort by relevancia
      filtered = norm.sort((a,b) => (b.relevancia||0) - (a.relevancia||0));
    }

    // 3) schedule greedily across trip days
    const startDate = trip.start_date ? new Date(trip.start_date) : null;
    const endDate = trip.end_date ? new Date(trip.end_date) : null;
    if (!startDate || !endDate) {
      throw new Error('Trip missing start_date or end_date');
    }
    const days = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate()+1)) {
      days.push(new Date(d));
    }

    // simple per-day times: day starts 09:00, end 18:00, allocate visits with avg_duration 90 min + travel buffers
    const defaultVisitMin = Number(process.env.DEFAULT_VISIT_MIN || 90);
    const travelBufferMin = Number(process.env.TRAVEL_BUFFER_MIN || 20);

    const finalPlaces = [];

    // We will pick different top N per day, skipping already used IDs
    const used = new Set();

    for (const day of days) {
      let currentTimeMin = 9 * 60; // 09:00 in minutes
      const dayEndMin = 18 * 60;   // 18:00
      // choose up to a few places per day
      for (let i = 0; i < filtered.length && currentTimeMin + defaultVisitMin <= dayEndMin; i++) {
        const candidate = filtered[i];
        if (used.has(candidate.id)) continue;
        // if candidate has coordinates, estimate travel from last chosen place
        let travelMin = 0;
        const last = finalPlaces.length ? finalPlaces[finalPlaces.length -1] : null;
        if (last && candidate.lat && candidate.lng && last.latitude && last.longitude) {
          travelMin = estimateTravelMinutes(last.latitude, last.longitude, candidate.lat, candidate.lng, 'drive');
        } else {
          travelMin = 15; // heuristics
        }
        // ensure we have time with travel buffer
        if (currentTimeMin + travelMin + defaultVisitMin + travelBufferMin > dayEndMin) {
          // no time for this candidate today
          continue;
        }
        // schedule it
        const startHour = Math.floor((currentTimeMin + travelMin) / 60).toString().padStart(2,'0') + ':' + ((currentTimeMin+travelMin)%60).toString().padStart(2,'0');
        const endMin = currentTimeMin + travelMin + defaultVisitMin;
        const endHour = Math.floor(endMin/60).toString().padStart(2,'0') + ':' + (endMin%60).toString().padStart(2,'0');

        finalPlaces.push({
          fk_locations: candidate.id,
          date: new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString(),
          start_hour: startHour,
          end_hour: endHour,
          notes: `Sugerido por algoritmo (score ${candidate.score ?? candidate.relevancia})`,
          latitude: candidate.lat,
          longitude: candidate.lng,
        });
        used.add(candidate.id);
        // move clock forward
        currentTimeMin = endMin + travelBufferMin;
      }
      // small progress update
      await client.query('UPDATE itinerary_generations SET progress = LEAST(1, COALESCE(progress,0) + 0.2) WHERE id = $1', [genRow.id]);
    }

    // 4) write trip_places (delete existing ones for the trip? we will append but you can change)
    // here we will INSERT created places
    const inserted = [];
    for (const p of finalPlaces) {
      const r = await client.query(
        `INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at`,
        [p.fk_locations, tripId, p.date, p.start_hour, p.end_hour, p.notes]
      );
      inserted.push(r.rows[0]);
    }

    // mark done and save generated json
    await client.query('UPDATE itinerary_generations SET status=$1, progress=$2, finished_at=now(), generated_json = $3 WHERE id=$4',
      ['done', 1.0, JSON.stringify({ insertedCount: inserted.length, places: inserted }), genRow.id]);

    await client.query('COMMIT');
    return { inserted };
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('scheduleForTrip error', err);
    try {
      await pool.query('UPDATE itinerary_generations SET status=$1, error=$2, finished_at=now() WHERE id=$3', ['failed', String(err.message || err), genRow.id]);
    } catch(e){ console.error('update failed status err', e); }
    throw err;
  } finally {
    client.release();
  }
}

async function processPending() {
  console.log('Worker starting, polling pending generations...');
  while (true) {
    try {
      // pick a pending generation (simple FIFO)
      const r = await pool.query(`SELECT * FROM itinerary_generations WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`);
      if (!r.rows.length) {
        // no pending job, sleep
        await sleep(3000);
        continue;
      }
      const gen = r.rows[0];
      console.log('Processing generation id=', gen.id, 'trip=', gen.trip_id);
      await pool.query('UPDATE itinerary_generations SET status=$1 WHERE id=$2', ['running', gen.id]);
      await scheduleForTrip(gen);
      console.log('Finished generation', gen.id);
    } catch (err) {
      console.error('Worker loop error', err);
      await sleep(2500);
    }
  }
}

// start
if (require.main === module) {
  processPending().catch(e => {
    console.error('worker fatal', e);
    process.exit(1);
  });
}

module.exports = { processPending };
