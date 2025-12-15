// controllers/trip.controller.js
'use strict';

const express = require('express');
const https = require('https');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

// ----------------------
// Initialize trip_reviews table if it doesn't exist
// ----------------------
(async function initTripReviewsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trip_reviews (
        id SERIAL PRIMARY KEY,
        trip_id INT NOT NULL,
        user_id INT NOT NULL,
        rating INT CHECK (rating >= 1 AND rating <= 5),
        title VARCHAR(255),
        comment TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT fk_tr_trip FOREIGN KEY(trip_id) REFERENCES trips(id) ON DELETE CASCADE,
        CONSTRAINT fk_tr_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT unique_trip_review UNIQUE(trip_id, user_id)
      )
    `);
    console.log('trip_reviews table initialized');
  } catch (err) {
    console.error('Error initializing trip_reviews table:', err);
  }
})();

// ----------------------
// Utilities kept from original file (normalizeTripRow, PLACES_AGG_SUBQUERY)
// ----------------------
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
function addDaysToIso(dateIso, days) {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}

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

function estimateTravelMinutes(a, b, mode = 'fast') {
  const km = haversineKm(a, b);
  const speedKmh = mode === 'walk' ? 5 : (mode === 'bike' ? 12 : 30);
  return (km / speedKmh) * 60;
}

function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
}

function isGastronomia(place) {
  const cat = (place.category || '').toString().toLowerCase();
  if (cat) {
    if (cat.includes('gastronom') || cat.includes('restaurant') || cat.includes('cafe') || cat.includes('bar') || cat.includes('pub') || cat.includes('fast_food')) return true;
  }
  const t = (place.titulo || '').toString().toLowerCase();
  if (t.includes('rest') || t.includes('café') || t.includes('cafe') || t.includes('bar') || t.includes('cafeter') || t.includes('parrilla')) return true;
  return false;
}

// ----- Country helpers -----
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
// HF / AI helpers (robust, with logs)
// ----------------------

// callHfJson returns { parsed, raw, parsedFromTxt } or throws if HF not configured
async function callHfJson(prompt, timeoutMs = 5000) {
  const HF_ROUTER_URL = process.env.HF_ROUTER_URL;
  const HF_API_TOKEN = process.env.HF_API_TOKEN;
  const HF_MODEL = process.env.HF_MODEL;

  if (!HF_ROUTER_URL || !HF_API_TOKEN || !HF_MODEL) {
    console.warn('callHfJson: HF not configured (missing env).');
    throw new Error('HF not configured');
  }

  const body = JSON.stringify({
    model: HF_MODEL,
    input: [{ role: 'user', content: prompt }]
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
      res.on('data', (d) => data += d);
      res.on('end', () => {
        console.info(`callHfJson: HF responded status=${res.statusCode}`);
        const rawPreview = String(data).slice(0, 4000);
        try {
          let parsedTop = null;
          try { parsedTop = JSON.parse(data); } catch (e) { parsedTop = null; }

          let txt = null;
          if (parsedTop && parsedTop.responses && parsedTop.responses.length && typeof parsedTop.responses[0].generated_text === 'string') {
            txt = parsedTop.responses[0].generated_text;
          } else if (parsedTop && parsedTop.output && typeof parsedTop.output[0] === 'string') {
            txt = parsedTop.output[0];
          } else if (parsedTop && parsedTop.generated_text && typeof parsedTop.generated_text === 'string') {
            txt = parsedTop.generated_text;
          } else if (typeof parsedTop === 'string') {
            txt = parsedTop;
          } else {
            const maybe = data.match(/{[\s\S]*}/);
            if (maybe) txt = maybe[0];
          }

          if (!txt) {
            if (parsedTop && typeof parsedTop === 'object') {
              console.info('callHfJson: returning top-level parsed object from HF (no nested generated_text).');
              return resolve({ parsed: parsedTop, raw: data, parsedFromTxt: false });
            }
            console.error('callHfJson: HF returned unexpected shape; preview:', rawPreview);
            return reject(new Error('HF returned unexpected shape'));
          }

          try {
            const j2 = JSON.parse(txt);
            console.info('callHfJson: parsed JSON from HF generated_text.');
            return resolve({ parsed: j2, raw: txt, parsedFromTxt: true });
          } catch (err) {
            const maybe = txt.match(/{[\s\S]*}/);
            if (maybe) {
              try {
                const j3 = JSON.parse(maybe[0]);
                console.info('callHfJson: parsed JSON from substring of generated_text.');
                return resolve({ parsed: j3, raw: txt, parsedFromTxt: true });
              } catch (e) {
                console.warn('callHfJson: inner JSON parse failed; returning raw generated_text (parse failed). Preview:', String(txt).slice(0,500));
                return resolve({ parsed: null, raw: txt, parsedFromTxt: false });
              }
            }
            console.warn('callHfJson: HF output not JSON. Preview:', String(txt).slice(0,500));
            return resolve({ parsed: null, raw: txt, parsedFromTxt: false });
          }
        } catch (err) {
          console.error('callHfJson: error while parsing HF response:', err && err.message, 'rawPreview:', rawPreview);
          return reject(err);
        }
      });
    });

    req.on('error', (err) => {
      console.error('callHfJson: request error:', err && err.message);
      reject(err);
    });
    req.on('timeout', () => { req.destroy(); console.error('callHfJson: request timeout'); reject(new Error('HF request timeout')); });
    req.write(body);
    req.end();
  });
}

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

  if (pace === 'intenso') out.prefer_titles.push('mirador', 'viewpoint', 'tour');
  else if (pace === 'relajado') out.prefer_titles.push('park', 'jardin', 'cafe');

  out.prefer_titles = Array.from(new Set(out.prefer_titles)).slice(0,6);
  out.prefer_interests = Array.from(new Set(out.prefer_interests)).slice(0,6);
  return out;
}

async function getAiSuggestions(destCountry, destCity, pace) {
  const prompt = `Generate short location keywords for destination country="${destCountry}" city="${destCity}" pace="${pace}". Return only JSON with keys prefer_titles (array) and prefer_interests (array).`;
  try {
    console.info('getAiSuggestions: calling HF router...');
    const hfRes = await callHfJson(prompt, 4000);
    console.info('getAiSuggestions: hf raw preview:', String(hfRes.raw).slice(0,500));
    if (!hfRes.parsed) {
      console.warn('getAiSuggestions: HF parsed null -> using heuristic.');
      const heur = heuristicAiSuggestions(destCountry, destCity, pace);
      return { ...heur, source: 'heuristic', hf_raw: hfRes.raw, hf_parse_ok: false };
    }
    const j = hfRes.parsed;
    const prefer_titles = Array.isArray(j.prefer_titles) ? j.prefer_titles.map(x => String(x).trim()).filter(Boolean).slice(0,6) : [];
    const prefer_interests = Array.isArray(j.prefer_interests) ? j.prefer_interests.map(x => String(x).trim()).filter(Boolean).slice(0,6) : [];
    if (prefer_titles.length || prefer_interests.length) {
      console.info('getAiSuggestions: HF parse ok, returning HF suggestions.');
      return { prefer_titles, prefer_interests, source: 'hf', hf_raw: hfRes.raw, hf_parse_ok: true };
    }
    console.warn('getAiSuggestions: HF parsed but empty useful fields -> heuristic.');
    const heur = heuristicAiSuggestions(destCountry, destCity, pace);
    return { ...heur, source: 'heuristic', hf_raw: hfRes.raw, hf_parse_ok: false };
  } catch (err) {
    console.warn('getAiSuggestions: HF call failed, falling back to heuristic. Error:', err && err.message);
    return { ...heuristicAiSuggestions(destCountry, destCity, pace), source: 'heuristic', hf_raw: null, hf_parse_ok: false, hf_error: err && err.message };
  }
}

// parse user notes to structured constraints
async function parseUserNotesWithAi(notes) {
  if (!notes || !String(notes).trim()) return { use_ai: false };
  const prompt = `Eres un asistente que extrae instrucciones de viaje desde texto libre en español. Devuelve SOLO JSON válido con claves:
{
  "use_ai": true|false,
  "pace_override": "relajado|medio|intenso|null",
  "must_visit": ["nombre lugar 1", "nombre lugar 2"],
  "day_paces": {"1":"relajado","2":"intenso"},
  "place_on_day": [{"place":"Museo X","day":2}],
  "prefer_titles": ["short","phrases"],
  "prefer_interests": ["museums","historic"]
}
Analiza el siguiente texto y responde solo el JSON:
"""${notes}"""`;

  try {
    console.info('parseUserNotesWithAi: calling HF for notes extraction...');
    const hfRes = await callHfJson(prompt, 4500);
    console.info('parseUserNotesWithAi: hf raw preview:', String(hfRes.raw).slice(0,600));
    if (!hfRes.parsed) {
      console.warn('parseUserNotesWithAi: HF parsed null -> using regex fallback.');
      return { use_ai: false, pace_override: null, must_visit: [], day_paces: {}, place_on_day: [], prefer_titles: [], prefer_interests: [], hf_raw: hfRes.raw, hf_parse_ok: false };
    }
    const j = hfRes.parsed;
    const out = {
      use_ai: j.use_ai === true,
      pace_override: j.pace_override || null,
      must_visit: Array.isArray(j.must_visit) ? j.must_visit.map(String).filter(Boolean) : [],
      day_paces: (j.day_paces && typeof j.day_paces === 'object') ? j.day_paces : {},
      place_on_day: Array.isArray(j.place_on_day) ? j.place_on_day.filter(x => x && (x.place || x.day)) : [],
      prefer_titles: Array.isArray(j.prefer_titles) ? j.prefer_titles.map(String).slice(0,6) : [],
      prefer_interests: Array.isArray(j.prefer_interests) ? j.prefer_interests.map(String).slice(0,6) : [],
      hf_raw: hfRes.raw,
      hf_parse_ok: true
    };
    console.info('parseUserNotesWithAi: extracted constraints:', { use_ai: out.use_ai, must_visit_count: out.must_visit.length, place_on_day_count: out.place_on_day.length });
    return out;
  } catch (err) {
    console.warn('parseUserNotesWithAi: HF extraction failed, using regex fallback. Error:', err && err.message);
    const text = String(notes).toLowerCase();
    const res = { use_ai: false, pace_override: null, must_visit: [], day_paces: {}, place_on_day: [], prefer_titles: [], prefer_interests: [], hf_raw: null, hf_parse_ok: false };
    if (text.match(/1(er|ro)? dia.*relaj/)) res.day_paces['1'] = 'relajado';
    if (text.match(/primer dia.*relaj/)) res.day_paces['1'] = 'relajado';
    if (text.match(/ultimo dia.*intens/)) res.day_paces['last'] = 'intenso';
    const visitPattern = /visitar\s+([\w\s\-\'\.,]+?)\s*(?:el\s+dia|día)?\s*(\d+)/g;
    let m;
    while ((m = visitPattern.exec(text)) !== null) {
      const place = (m[1] || '').trim();
      const day = Number(m[2]);
      if (place) res.place_on_day.push({ place, day });
      else res.must_visit.push(place);
    }
    const simpleVisit = /visitar\s+([\w\s\-\'\.,]+)/g;
    while ((m = simpleVisit.exec(text)) !== null) {
      const place = (m[1] || '').trim();
      if (place && !res.must_visit.includes(place)) res.must_visit.push(place);
    }
    console.info('parseUserNotesWithAi: regex fallback result', res);
    return res;
  }
}

// ----------------------
// Main itinerary handler (prioritizes body.llm_notes over trip.notes)
// ----------------------
async function handleItinerary(req, res) {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    console.info('handleItinerary ENTRY', { tripId, userId, timestamp: new Date().toISOString() });
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const body = req.body || {};
    const paceRaw = body.pace || 'relajado';
    let pace = normalizePace(paceRaw);
    const save = !!body.save;
    const mandatoryPlaceNames = Array.isArray(body.places) ? body.places.map(String).filter(Boolean) : [];
    const bodyLlMNotes = (body.llm_notes || '').toString().trim();

    // fetch trip and ownership
    const tripRes = await client.query('SELECT id, user_id, destination, start_date, end_date, notes FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) return res.status(404).json({ message: 'Trip no encontrado' });
    const trip = tripRes.rows[0];
    if (trip.user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // choose notes: priority -> body.llm_notes, else trip.notes
    let notesSource = 'none';
    let notesToParse = '';
    if (bodyLlMNotes) { notesToParse = bodyLlMNotes; notesSource = 'body'; }
    else if (trip.notes && String(trip.notes).trim()) { notesToParse = trip.notes; notesSource = 'trip'; }
    console.info('handleItinerary: notes source selected', { notesSource, notesLength: notesToParse ? notesToParse.length : 0 });

    // parse notes (HF extraction or regex fallback)
    let notesConstraints = { use_ai: false };
    if (notesToParse) {
      try {
        notesConstraints = await parseUserNotesWithAi(notesToParse);
        console.info('handleItinerary: notesConstraints loaded hf_parse_ok=', !!notesConstraints.hf_parse_ok);
      } catch (e) {
        console.warn('handleItinerary: parseUserNotesWithAi failed, using defaults. Error:', e && e.message);
        notesConstraints = { use_ai: false, hf_parse_ok: false };
      }
    }

    // get dest parts
    const { city: destCityRaw, country: destCountryRaw } = parseDestinationParts(trip.destination);
    const destCity = destCityRaw ? destCityRaw.toString() : null;
    const destCountry = destCountryRaw ? destCountryRaw.toString() : null;

    // get AI suggestions according to whether notes requested AI or not
    let ai = null;
    if (notesToParse && notesConstraints.use_ai) {
      console.info('handleItinerary: notes requested AI -> calling getAiSuggestions with destination context');
      ai = await getAiSuggestions(destCountry, destCity, pace);
      // merge notes prefer_* into ai suggestions if present
      if (notesConstraints.prefer_titles && notesConstraints.prefer_titles.length) ai.prefer_titles = Array.from(new Set([...(ai.prefer_titles||[]), ...notesConstraints.prefer_titles])).slice(0,6);
      if (notesConstraints.prefer_interests && notesConstraints.prefer_interests.length) ai.prefer_interests = Array.from(new Set([...(ai.prefer_interests||[]), ...notesConstraints.prefer_interests])).slice(0,6);
    } else if (notesToParse && !notesConstraints.use_ai) {
      console.info('handleItinerary: notes present but user did not request AI -> using heuristic suggestions and preserving parsed constraints.');
      ai = { ...heuristicAiSuggestions(destCountry, destCity, pace), source: 'heuristic', hf_raw: notesConstraints.hf_raw || null, hf_parse_ok: !!notesConstraints.hf_parse_ok };
    } else {
      console.info('handleItinerary: no notes provided -> using getAiSuggestions based on destination');
      ai = await getAiSuggestions(destCountry, destCity, pace);
    }

    console.info('handleItinerary: AI suggestion source:', ai && ai.source, 'hf_parse_ok:', !!ai.hf_parse_ok);

    // apply pace overrides from notesConstraints
    if (notesConstraints && notesConstraints.pace_override) {
      const pnorm = normalizePace(notesConstraints.pace_override);
      console.info(`handleItinerary: notes override pace ${pace} -> ${pnorm}`);
      pace = pnorm;
    }

    // date range
    const startDate = trip.start_date ? trip.start_date.toISOString().slice(0,10) : (new Date()).toISOString().slice(0,10);
    const endDate = trip.end_date ? trip.end_date.toISOString().slice(0,10) : startDate;
    const startD = new Date(startDate + 'T00:00:00Z');
    const endD = new Date(endDate + 'T00:00:00Z');
    const days = Math.max(1, Math.round((endD - startD) / (24*3600*1000)) + 1);

    // per-day slots with possible overrides from notesConstraints.day_paces
    const defaultPerDay = PACE_MAP[pace] || PACE_MAP['relajado'];
    const perDayArray = Array.from({ length: days }, () => defaultPerDay);
    if (notesConstraints && notesConstraints.day_paces) {
      for (const k of Object.keys(notesConstraints.day_paces)) {
        if (k === 'last') {
          const val = normalizePace(notesConstraints.day_paces[k]);
          perDayArray[days-1] = PACE_MAP[val] || perDayArray[days-1];
        } else {
          const dayIdx = Number(k) - 1;
          if (Number.isFinite(dayIdx) && dayIdx >= 0 && dayIdx < days) {
            const val = normalizePace(notesConstraints.day_paces[k]);
            perDayArray[dayIdx] = PACE_MAP[val] || perDayArray[dayIdx];
            console.info(`handleItinerary: overriding day ${dayIdx+1} pace -> ${val}`);
          }
        }
      }
    }

    const totalNeeded = perDayArray.reduce((s,v)=>s+v,0);

    // fetch user interests
    const uiRes = await client.query(
      `SELECT i.id, i.slug, i.title
       FROM user_interests ui
       JOIN interests i ON i.id = ui.interest_id
       WHERE ui.user_id = $1`,
      [userId]
    );
    const interestIds = uiRes.rows.map(r => r.id);

    // Merge mandatory place names from request body + notesConstraints.must_visit
    const combinedMandatoryNames = [...mandatoryPlaceNames];
    if (notesConstraints && Array.isArray(notesConstraints.must_visit)) {
      for (const m of notesConstraints.must_visit) if (m && !combinedMandatoryNames.includes(m)) combinedMandatoryNames.push(m);
    }

    // Validate mandatory places against country if destCountry present
    if (destCountry && combinedMandatoryNames.length) {
      const missing = [];
      for (const name of combinedMandatoryNames) {
        const r = await client.query('SELECT id, country FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${name}%`]);
        if (!r.rows.length) { missing.push(name); continue; }
        const foundCountry = r.rows[0].country;
        if (!countryMatches(foundCountry, destCountry)) missing.push(name);
      }
      if (missing.length) {
        console.warn('handleItinerary: mandatory places missing in country', { destCountry, missing });
        return res.status(400).json({ message: 'Algunas ubicaciones obligatorias no se encuentran en el país destino', missing });
      }
    }

    // Build candidate SQL (strict when destCountry present)
    let candidateSQL = `SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations`;
    const queryValues = [];
    let idx = 1;

    if (destCountry) {
      candidateSQL += ` WHERE country IS NOT NULL AND LOWER(country) LIKE $${idx}`;
      queryValues.push(`%${normalizeStr(destCountry)}%`);
      idx++;
      candidateSQL += ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      queryValues.push(Math.max(totalNeeded * 4, 200));
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

      if (ai && Array.isArray(ai.prefer_titles) && ai.prefer_titles.length) {
        const titleChecks = ai.prefer_titles.slice(0,6).map(t => {
          const ph = `$${idx}`; idx++; queryValues.push(`%${t}%`); return `titulo ILIKE ${ph}`;
        });
        if (titleChecks.length) whereClauses.push(`(${titleChecks.join(' OR ')})`);
      }

      if (whereClauses.length) candidateSQL += ` WHERE (${whereClauses.join(' OR ')})`;
      candidateSQL += ` ORDER BY relevancia DESC NULLS LAST, titulo ASC LIMIT $${idx}`;
      queryValues.push(Math.max(totalNeeded * 4, 200));
    }

    console.info('handleItinerary: candidateSQL preview', { sqlPreview: candidateSQL.slice(0,300), paramsCount: queryValues.length });

    const candRes = await client.query(candidateSQL, queryValues);
    let candidates = candRes.rows || [];

    if (destCountry && (!candidates || candidates.length === 0)) {
      console.warn('handleItinerary: zero candidates found for destCountry', destCountry);
      return res.status(400).json({ message: `No se encontraron ubicaciones en el país destino: ${destCountry}. Generador interrumpido.` });
    }

    if (destCountry) {
      const filtered = candidates.filter(c => c.country && countryMatches(c.country, destCountry));
      candidates = filtered;
      if (!candidates.length) {
        console.warn('handleItinerary: after country filter no candidates remain for', destCountry);
        return res.status(400).json({ message: `No se encontraron ubicaciones en el país destino (después del filtrado): ${destCountry}. Generador interrumpido.` });
      }
    }

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

    // ensure mandatory included in candidate pool
    for (const name of combinedMandatoryNames) {
      const exists = candidates.find(c => c.titulo && c.titulo.toString().toLowerCase().includes(name.toLowerCase()));
      if (!exists) {
        if (!destCountry) {
          const r = await client.query('SELECT id, titulo, latitud, longitud, relevancia, fk_interest, country, city, category FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${name}%`]);
          if (r.rows.length) candidates.unshift(r.rows[0]);
        } else {
          console.warn('handleItinerary: mandatory location required but not in candidates despite earlier validation:', name);
          return res.status(400).json({ message: `Ubicación obligatoria "${name}" no encontrada en ${destCountry}` });
        }
      }
    }

    // dedupe and limit pool
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

    // build clusters
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

    // mandatoryById
    const mandatoryById = new Map();
    for (const name of combinedMandatoryNames) {
      const found = candidates.find(c => c.titulo && c.titulo.toString().toLowerCase().includes(name.toLowerCase()));
      if (found) mandatoryById.set(String(found.id), found);
    }

    // place_on_day from notesConstraints
    if (notesConstraints && Array.isArray(notesConstraints.place_on_day) && notesConstraints.place_on_day.length) {
      for (const pod of notesConstraints.place_on_day) {
        const placeName = (pod.place || '').toString().trim();
        const dayNum = Number(pod.day);
        if (!placeName || !Number.isFinite(dayNum)) continue;
        const found = candidates.find(c => c.titulo && c.titulo.toString().toLowerCase().includes(placeName.toLowerCase()));
        if (found) {
          const di = Math.max(0, Math.min(days-1, dayNum-1));
          perDayCandidates[di].push(found);
          mandatoryById.set(String(found.id), found);
          console.info(`handleItinerary: placing "${found.titulo}" on day ${di+1} as requested in notes`);
        } else {
          console.warn(`handleItinerary: requested notes place "${placeName}" on day ${dayNum} not found in candidates`);
        }
      }
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
        if (perDayCandidates[di].length >= (perDayArray[di] * 3)) break;
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
        if (dayPlaces.length >= perDayArray[di]) break;
      }

      for (const nm of nonMandatory) {
        if (dayPlaces.length >= perDayArray[di]) break;
        if (!nm) continue;
        if (usedIds.has(String(nm.id))) continue;
        dayPlaces.push(nm);
        usedIds.add(String(nm.id));
      }

      const ensureMealPlace = (mealPlace) => {
        if (!mealPlace) return null;
        if (dayPlaces.find(p => String(p.id) === String(mealPlace.id))) return null;
        if (dayPlaces.length < perDayArray[di]) {
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

      const finalPlaces = dayPlaces.slice(0, perDayArray[di]);

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

    // final country enforcement
    if (destCountry) {
      for (const day of itineraryDays) {
        day.places = day.places.filter(pl => {
          const found = candidates.find(c => String(c.id) === String(pl.id));
          if (found) return countryMatches(found.country, destCountry);
          return false;
        });
      }
    }

    // Build itinerary + AI metadata (hf raw & parse flags included)
    const itinerary = {
      trip_id: tripId,
      pace,
      days: itineraryDays,
      generated_at: new Date().toISOString(),
      ai: {
        source: ai && ai.source ? ai.source : 'heuristic',
        suggestions: { prefer_titles: ai && ai.prefer_titles ? ai.prefer_titles : [], prefer_interests: ai && ai.prefer_interests ? ai.prefer_interests : [] },
        hf_raw: (ai && ai.hf_raw) || (notesConstraints && notesConstraints.hf_raw) || null,
        hf_parse_ok: !!((ai && ai.hf_parse_ok) || (notesConstraints && notesConstraints.hf_parse_ok)),
        hf_error: (ai && ai.hf_error) || null,
        notes_source: notesSource,
        notes_constraints: notesConstraints
      }
    };

    // persist generation record and optionally save places
    await client.query('BEGIN');
    const genRes = await client.query(
      `INSERT INTO itinerary_generations (trip_id, user_id, model, status, progress, generated_json, created_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), now()) RETURNING id`,
      [tripId, userId, 'heuristic-strict-country-v4-llm-notes', 'finished', 100, JSON.stringify(itinerary)]
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
              console.warn('handleItinerary: skipping save for place outside destCountry', { placeId: p.id });
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

    console.info('handleItinerary: generation finished', { generation_id: genId, tripId, notesSource });

    return res.status(201).json({ generation_id: genId, itinerary, saved_places: save ? savedPlaces : undefined });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /trips/:id/itinerary error:', err && err.message, err);
    return res.status(500).json({ message: 'Error generando itinerario', error: err && err.message });
  } finally {
    client.release();
  }
}

// SHARE
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

// ======================
// REVIEW ROUTES (must be before /:id route)
// ======================

/* GET /trips/:id/review */
router.get('/:id/review', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;

    if (!Number.isFinite(tripId) || tripId <= 0) {
      return res.status(400).json({ message: 'trip_id inválido' });
    }

    // Verify trip exists and user has access
    const tripRes = await client.query('SELECT user_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) {
      return res.status(404).json({ message: 'Viaje no encontrado' });
    }

    // Get review for this trip and user
    const reviewRes = await client.query(
      'SELECT id, trip_id, user_id, rating, title, comment, created_at, updated_at FROM trip_reviews WHERE trip_id = $1 AND user_id = $2 LIMIT 1',
      [tripId, userId]
    );

    if (!reviewRes.rows.length) {
      return res.status(404).json({ message: 'Review no encontrado' });
    }

    return res.json(reviewRes.rows[0]);
  } catch (err) {
    console.error('GET /trips/:id/review error:', err);
    return res.status(500).json({ message: 'Error obteniendo review' });
  } finally {
    client.release();
  }
});

/* POST /trips/:id/review */
router.post('/:id/review', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const { rating, title, comment } = req.body || {};

    if (!Number.isFinite(tripId) || tripId <= 0) {
      return res.status(400).json({ message: 'trip_id inválido' });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'rating debe ser un número entre 1 y 5' });
    }

    if (!title || String(title).trim().length === 0) {
      return res.status(400).json({ message: 'title es requerido' });
    }

    // Verify trip exists and user owns it
    const tripRes = await client.query('SELECT user_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) {
      return res.status(404).json({ message: 'Viaje no encontrado' });
    }
    if (tripRes.rows[0].user_id !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    // Check if review already exists
    const existingRes = await client.query(
      'SELECT id FROM trip_reviews WHERE trip_id = $1 AND user_id = $2 LIMIT 1',
      [tripId, userId]
    );

    if (existingRes.rows.length > 0) {
      return res.status(409).json({ message: 'Ya existe un review para este viaje' });
    }

    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO trip_reviews (trip_id, user_id, rating, title, comment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       RETURNING id, trip_id, user_id, rating, title, comment, created_at, updated_at`,
      [tripId, userId, rating, String(title).trim(), comment ? String(comment).trim() : null]
    );

    await client.query('COMMIT');

    return res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /trips/:id/review error:', err);
    return res.status(500).json({ message: 'Error creando review' });
  } finally {
    client.release();
  }
});

/* PUT /trips/:id/review */
router.put('/:id/review', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    const userId = req.user.id;
    const { rating, title, comment } = req.body || {};

    if (!Number.isFinite(tripId) || tripId <= 0) {
      return res.status(400).json({ message: 'trip_id inválido' });
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      return res.status(400).json({ message: 'rating debe ser un número entre 1 y 5' });
    }

    if (title !== undefined && String(title).trim().length === 0) {
      return res.status(400).json({ message: 'title no puede estar vacío' });
    }

    // Verify trip exists and user owns it
    const tripRes = await client.query('SELECT user_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!tripRes.rows.length) {
      return res.status(404).json({ message: 'Viaje no encontrado' });
    }
    if (tripRes.rows[0].user_id !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    // Check if review exists
    const existingRes = await client.query(
      'SELECT id FROM trip_reviews WHERE trip_id = $1 AND user_id = $2 LIMIT 1',
      [tripId, userId]
    );

    if (!existingRes.rows.length) {
      return res.status(404).json({ message: 'Review no encontrado' });
    }

    await client.query('BEGIN');

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (rating !== undefined) {
      updates.push(`rating = $${paramIndex++}`);
      values.push(rating);
    }
    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(String(title).trim());
    }
    if (comment !== undefined) {
      updates.push(`comment = $${paramIndex++}`);
      values.push(comment ? String(comment).trim() : null);
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No hay campos para actualizar' });
    }

    updates.push(`updated_at = now()`);
    values.push(tripId, userId);

    const updateRes = await client.query(
      `UPDATE trip_reviews 
       SET ${updates.join(', ')}
       WHERE trip_id = $${paramIndex++} AND user_id = $${paramIndex++}
       RETURNING id, trip_id, user_id, rating, title, comment, created_at, updated_at`,
      values
    );

    await client.query('COMMIT');

    return res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /trips/:id/review error:', err);
    return res.status(500).json({ message: 'Error actualizando review' });
  } finally {
    client.release();
  }
});

// ======================
// ITINERARY ROUTES (must be before /:id route)
// ======================

router.post('/:id/itinerary', auth, handleItinerary);
router.get('/:id/itinerary', auth, getLastItinerary);

// ======================
// TRIP CRUD ROUTES
// ======================

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
        ts.expires_at AS share_expires_at,
        tr.id AS review_id,
        tr.rating AS review_rating,
        tr.title AS review_title,
        tr.comment AS review_comment,
        tr.created_at AS review_created_at,
        tr.updated_at AS review_updated_at
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
      LEFT JOIN trip_reviews tr ON tr.trip_id = t.id AND tr.user_id = $2
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

    if (row.review_id) {
      trip.review = {
        id: row.review_id,
        trip_id: row.id,
        user_id: row.user_id,
        rating: row.review_rating,
        title: row.review_title,
        comment: row.review_comment,
        created_at: row.review_created_at,
        updated_at: row.review_updated_at
      };
    } else {
      trip.review = null;
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

    const ownerRes = await client.query('SELECT user_id FROM trips WHERE id = $1', [id]);
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

    // Eliminar todas las tablas relacionadas primero
    await client.query('DELETE FROM trip_reviews WHERE trip_id = $1', [id]);
    await client.query('DELETE FROM trip_shares WHERE trip_id = $1', [id]);
    await client.query('DELETE FROM itinerary_generations WHERE trip_id = $1', [id]);
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
    console.log('POST /trips/:id/places/auto body:', body);
    console.log('tripId:', tripId, 'userId:', userId);

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
      // no routing helper: use estimateTravelMinutes
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

   // ------------------ Helpers: shuffle + twoOpt ------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function twoOpt(order, matrix) {
  if (!order || order.length < 3) return order.slice();
  const n = order.length;
  const calc = (ord) => {
    let s = 0;
    for (let i = 0; i < ord.length - 1; i++) {
      const a = ord[i], b = ord[i+1];
      const v = matrix[a] && matrix[a][b];
      s += Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER/10;
    }
    return s;
  };

  let best = order.slice();
  let bestCost = calc(best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 2; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = calc(cand);
        if (c + 1e-9 < bestCost) {
          best = cand;
          bestCost = c;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best;
}

// ------------------ Nuevo computeBestOrderForIndices (exacto DP para n<=12, heurístico para >12) ------------------
const computeBestOrderForIndices = (indices) => {
  const uniq = Array.from(new Set(indices));
  if (uniq.length <= 1) return { order: uniq.slice(), cost: 0 };

  // cost helper (uses outer-scope matrix)
  const calcCostFor = (arr) => {
    let c = 0;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i+1];
      const v = matrix[a] && matrix[a][b];
      c += Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER/10;
    }
    return c;
  };

  // ---------- Exact DP (shortest Hamiltonian PATH) for small n ----------
  if (uniq.length <= 12) {
    const n = uniq.length;
    // remap: pos -> node (locList index)
    const nodes = uniq.slice();
    // build reduced matrix m2[i][j] using nodes indices
    const m2 = Array.from({length: n}, () => Array.from({length: n}, () => Number.MAX_SAFE_INTEGER/10));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) { m2[i][j] = 0; continue; }
        const realA = nodes[i], realB = nodes[j];
        const val = matrix[realA] && matrix[realA][realB];
        m2[i][j] = Number.isFinite(val) ? val : Number.MAX_SAFE_INTEGER/10;
      }
    }

    const FULL = (1<<n);
    const dp = Array.from({length: FULL}, () => new Array(n).fill(Infinity));
    const parent = Array.from({length: FULL}, () => new Array(n).fill(-1));

    // init
    for (let i = 0; i < n; i++) dp[1<<i][i] = 0;

    for (let mask = 1; mask < FULL; mask++) {
      for (let last = 0; last < n; last++) {
        if (!(mask & (1<<last))) continue;
        const cur = dp[mask][last];
        if (!Number.isFinite(cur)) continue;
        // try extend to nxt
        for (let nxt = 0; nxt < n; nxt++) {
          if (mask & (1<<nxt)) continue;
          const nm = mask | (1<<nxt);
          const cand = cur + m2[last][nxt];
          if (cand < dp[nm][nxt]) {
            dp[nm][nxt] = cand;
            parent[nm][nxt] = last;
          }
        }
      }
    }

    // find best end (we allow any start and any end -> shortest PATH)
    let bestCost = Infinity;
    let bestEnd = -1;
    const fullMask = FULL - 1;
    for (let end = 0; end < n; end++) {
      if (dp[fullMask][end] < bestCost) { bestCost = dp[fullMask][end]; bestEnd = end; }
    }

    // reconstruct path (in terms of nodes indices)
    const path = [];
    if (bestEnd === -1) {
      // fallback identity
      for (let i = 0; i < n; i++) path.push(nodes[i]);
    } else {
      let cur = bestEnd;
      let mask = fullMask;
      while (cur !== -1) {
        path.push(nodes[cur]); // push real node index
        const prev = parent[mask][cur];
        mask = mask ^ (1<<cur);
        cur = prev;
      }
      path.reverse();
    }

    console.info('computeBestOrderForIndices (DP exact) ->', { nodes: n, order: path, cost: bestCost });
    return { order: path, cost: bestCost === Infinity ? 0 : bestCost };
  }

  // ---------- Heuristic for larger n: multiple seeds + 2-opt ----------
  const candidates = uniq.slice();
  const seeds = [];
  // seed 1: NN from a few starts
  const maxStarts = Math.min(8, candidates.length);
  for (let s = 0; s < maxStarts; s++) {
    const start = candidates[Math.floor((s * candidates.length) / maxStarts)];
    const pool = candidates.filter(x => x !== start);
    const tour = [start];
    while (pool.length) {
      const last = tour[tour.length - 1];
      let bestIdx = 0, bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const d = matrix[last] && matrix[last][p];
        if (Number.isFinite(d) && d < bestD) { bestD = d; bestIdx = i; }
        else if (!Number.isFinite(d) && bestD === Infinity) { bestIdx = i; }
      }
      tour.push(pool.splice(bestIdx,1)[0]);
    }
    seeds.push(tour.slice());
    seeds.push(tour.slice().reverse());
  }
  // seed 2: some random shuffles
  for (let r = 0; r < Math.min(6, candidates.length); r++) seeds.push(shuffle(candidates));
  // seed 3: identity
  seeds.push(candidates.slice());

  let bestOrder = null, bestCost = Infinity;
  for (const s of seeds) {
    const improved = twoOpt(s, matrix);
    const c = calcCostFor(improved);
    console.info('computeBestOrderForIndices: seed evaluated', { seedPreview: s.slice(0,5), improvedPreview: improved.slice(0,5), cost: c });
    if (c < bestCost) { bestCost = c; bestOrder = improved.slice(); }
  }

  if (!bestOrder) { bestOrder = uniq.slice(); bestCost = calcCostFor(bestOrder); }

  console.info('computeBestOrderForIndices (heuristic final) ->', { nodes: uniq.length, order: bestOrder, cost: bestCost });
  return { order: bestOrder, cost: bestCost };
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
