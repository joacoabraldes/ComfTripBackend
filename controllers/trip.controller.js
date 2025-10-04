// controllers/trip.controller.js
'use strict';

const express = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');
const router = express.Router();

/* (fetch / AbortController bootstrapping unchanged) */
let fetchImpl = null;
let AbortControllerImpl = null;
try {
  if (typeof globalThis.fetch === 'function') fetchImpl = globalThis.fetch;
} catch (e) { /* ignore */ }

if (!fetchImpl) {
  try {
    const undici = require('undici');
    if (undici && typeof undici.fetch === 'function') fetchImpl = undici.fetch.bind(undici);
    if (!AbortControllerImpl && undici && undici.AbortController) AbortControllerImpl = undici.AbortController;
  } catch (e) {}
}

if (!AbortControllerImpl) {
  if (typeof globalThis.AbortController === 'function') AbortControllerImpl = globalThis.AbortController;
  else {
    try {
      const AC = require('abort-controller');
      if (AC && AC.AbortController) AbortControllerImpl = AC.AbortController;
    } catch (e) { AbortControllerImpl = null; }
  }
}

if (!fetchImpl) {
  throw new Error('No fetch implementation found. Install node >=18 or run `npm install undici`.');
}
if (typeof globalThis.fetch !== 'function') globalThis.fetch = fetchImpl;
if (AbortControllerImpl && typeof globalThis.AbortController !== 'function') globalThis.AbortController = AbortControllerImpl;

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  if (AbortControllerImpl) {
    const controller = new AbortControllerImpl();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...opts, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(id);
    }
  } else {
    return await Promise.race([
      fetchImpl(url, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
    ]);
  }
}

/* helpers unchanged (normalizeTripRow, PLACES_AGG_SUBQUERY, haversineMeters) */
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
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* services */
const poiService = require('../services/poi.service');
const routingService = require('../services/routing.service');
const optimizer = require('../services/optimizer.service');

/* robust JSON extraction from a text blob - uses balanced-brace parsing */
function extractJsonFromText(text) {
  text = (text || '').trim();
  if (!text) return null;

  // quick attempt
  try { return JSON.parse(text); } catch (e) {}

  // find first '{' or '['
  const startIdx = (() => {
    const o = text.indexOf('{');
    const b = text.indexOf('[');
    if (o === -1) return b;
    if (b === -1) return o;
    return Math.min(o,b);
  })();
  if (startIdx === -1) return null;

  // walk forward balancing brackets, ignoring those inside strings
  const openToClose = { '{': '}', '[': ']' };
  const stack = [];
  let inString = false;
  let escape = false;
  let startChar = text[startIdx];
  if (!('{[').includes(startChar)) return null;
  stack.push(openToClose[startChar]);
  for (let i = startIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; continue; }
      continue;
    } else {
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') { stack.push(openToClose[ch]); continue; }
      if (ch === '}' || ch === ']') {
        const expected = stack.pop();
        if (ch !== expected) {
          // mismatch -> try to continue but this likely fails parse
          // break early if stack empty and mismatch doesn't make sense
        }
        if (stack.length === 0) {
          const candidate = text.slice(startIdx, i + 1);
          try { return JSON.parse(candidate); } catch (e) { return null; }
        }
      }
    }
  }

  // fallback: try to find any JSON-like substring with a looser approach (small windows)
  for (let s = startIdx; s < Math.min(startIdx + 2000, text.length); s++) {
    if (!('{[').includes(text[s])) continue;
    for (let e = s + 1; e < Math.min(s + 2000, text.length); e++) {
      const substr = text.slice(s, e);
      try { return JSON.parse(substr); } catch (e) { /* continue */ }
    }
  }
  return null;
}


function parseHFResultToJson(hfResp) {
  if (hfResp === null || hfResp === undefined) return null;

  // If already a parsed array/object and not a router wrapper, return it
  if (Array.isArray(hfResp) || (typeof hfResp === 'object' && hfResp !== null && !hfResp._text && !hfResp.choices && !hfResp.generated_text && !hfResp.outputs)) {
    return hfResp;
  }

  // Build candidate text from known fields
  let text = '';
  if (typeof hfResp === 'string') {
    text = hfResp;
  } else if (hfResp && typeof hfResp === 'object') {
    // if we already set _text earlier in callHF, use it
    if (hfResp._text && typeof hfResp._text === 'string') {
      text = hfResp._text;
    } else if (Array.isArray(hfResp.choices) && hfResp.choices.length) {
      text = hfResp.choices.map(c => {
        return (c.message && (c.message.content || c.message.content?.text)) ||
               c.text ||
               c.generated_text ||
               (typeof c === 'string' ? c : '');
      }).filter(Boolean).join('\n').trim();
    } else if (Array.isArray(hfResp.outputs) && hfResp.outputs.length) {
      text = hfResp.outputs.map(o => (o.generated_text || o.text || o.content || '')).join('\n').trim();
    } else if (hfResp.generated_text) {
      text = String(hfResp.generated_text);
    } else {
      try { text = JSON.stringify(hfResp); } catch (e) { text = String(hfResp); }
    }
  }

  // Try direct parse of whole text
  try { return JSON.parse(text); } catch (e) {}

  // Fallback: extract first JSON block
  const parsed = extractJsonFromText(text);
  return parsed;
}


/* Call Hugging Face inference for a prompt (uses fetchWithTimeout) - unchanged except logs */
async function callHF(promptOrMessages, opts = {}) {
  const rawModel = process.env.HF_MODEL;
  const token = process.env.HF_API_TOKEN;
  const routerUrl = process.env.HF_ROUTER_URL || 'https://router.huggingface.co/v1/chat/completions';
  const useRouterEnv = !!process.env.HF_USE_ROUTER;
  if (!rawModel || !token) throw new Error('Please set HF_MODEL and HF_API_TOKEN env vars.');

  const max_new_tokens = opts.max_new_tokens ?? 1024;
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.2;
  const top_p = opts.top_p ?? 0.95;
  const timeout = opts.timeout || 120000;
  const shouldUseRouter = useRouterEnv || rawModel.includes(':') || (opts.forceRouter === true);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let resp;
  try {
    if (shouldUseRouter) {
      let messages = [];
      if (Array.isArray(promptOrMessages)) messages = promptOrMessages;
      else if (typeof promptOrMessages === 'string') messages = [{ role: 'user', content: promptOrMessages }];
      else if (promptOrMessages && promptOrMessages.messages) messages = promptOrMessages.messages;
      else messages = [{ role: 'user', content: String(promptOrMessages || '') }];

      const body = { model: rawModel, messages, max_new_tokens, temperature, top_p };

      resp = await fetchWithTimeout(routerUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }, timeout);

      const text = await resp.text().catch(() => '');
      console.log('HF router response status', resp.status, 'bodySnippet:', text.slice(0,5000));
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }

      if (!resp.ok) {
        throw new Error(`Router HF ${resp.status}: ${text}`);
      }

      if (json && Array.isArray(json.choices) && json.choices.length && json.choices[0].message) {
        json._text = String(json.choices.map(c => (c.message?.content ?? '')).join('\n')).trim();
        return json;
      }
      return json ?? text;
    } else {
      const modelUrl = `https://api-inference.huggingface.co/models/${rawModel}`;
      const promptString = (typeof promptOrMessages === 'string') ? promptOrMessages : JSON.stringify(promptOrMessages);
      const body = { inputs: promptString, options: { wait_for_model: true, use_cache: false }, parameters: { max_new_tokens, temperature, top_p } };

      resp = await fetchWithTimeout(modelUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }, timeout);

      const text = await resp.text().catch(() => '');
      console.log('HF model response status', resp.status, 'bodySnippet:', text.slice(0,1200));
      if (!resp.ok) throw new Error(`HF ${resp.status}: ${text}`);

      const parsed = extractJsonFromText(text);
      if (!parsed) throw new Error('Could not parse JSON from HF response');
      return parsed;
    }
  } catch (err) {
    throw new Error(`callHF error (router=${shouldUseRouter}): ${err?.message || err}`);
  }
}

/**
 * Simple greedy itinerary generator used as a final fallback.
 * Distributes topCandidates across days respecting daily_hours and visit_default_minutes.
 */
function simpleGreedyGenerator({ candidates, days, spec }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const visitDefault = Number(spec?.visit_default_minutes || 90);
  const startMin = (() => {
    const s = spec?.daily_hours?.start || '09:00';
    return Number(s.slice(0,2)) * 60 + Number(s.slice(3,5) || 0);
  })();
  const endMin = (() => {
    const e = spec?.daily_hours?.end || '18:00';
    return Number(e.slice(0,2)) * 60 + Number(e.slice(3,5) || 0);
  })();
  const dayCapacity = Math.max(60, endMin - startMin);
  // compute simple travel minutes between sequential items using haversine (assume walking/driving speed)
  const speedMetersPerMin = 500; // ~30 km/h -> 500 m/min (adjustable)
  // sort candidates descending by combined_score
  const sorted = [...candidates].sort((a,b)=> (b.combined_score||0) - (a.combined_score||0));
  const assigned = new Set();
  const itinerary = [];
  for (let d = 0; d < days.length; d++) {
    const dayDate = days[d] instanceof Date ? days[d].toISOString().slice(0,10) : (new Date(days[d]).toISOString().slice(0,10));
    let remaining = dayCapacity;
    const visits = [];
    let prev = null;
    for (let i=0;i<sorted.length;i++) {
      const cand = sorted[i];
      if (assigned.has(cand.id)) continue;
      // compute travel to this from prev
      let travelMin = 0;
      if (prev && cand.lat != null && prev.lat != null) {
        const dist = haversineMeters(prev.lat, prev.lng, cand.lat, cand.lng);
        travelMin = Math.ceil(dist / speedMetersPerMin);
      } else {
        travelMin = 10; // small default initial travel
      }
      const needed = travelMin + visitDefault;
      if (needed <= remaining) {
        visits.push({
          id: cand.id,
          titulo: cand.titulo,
          visit_minutes: visitDefault,
          travel_to_prev_minutes: travelMin,
          reason: cand.llm_reason || null,
          score: cand.combined_score || null
        });
        assigned.add(cand.id);
        remaining -= needed;
        prev = cand;
      }
      if (remaining < visitDefault + 5) break;
    }
    itinerary.push({ date: dayDate, visits });
  }
  // If nothing assigned (rare), assign at least one POI per day from top candidates
  const anyAssigned = itinerary.some(d => (d.visits && d.visits.length));
  if (!anyAssigned) {
    const fallbackDays = [];
    for (let d=0; d<days.length; d++) {
      const dayDate = days[d] instanceof Date ? days[d].toISOString().slice(0,10) : (new Date(days[d]).toISOString().slice(0,10));
      const cand = sorted[d % sorted.length];
      fallbackDays.push({ date: dayDate, visits: [{ id: cand.id, titulo: cand.titulo, visit_minutes: visitDefault, travel_to_prev_minutes: 10, reason: 'fallback' }]});
    }
    return fallbackDays;
  }
  return itinerary;
}

/**
 * GET /trips/:id/itinerary
 * Generate itinerary (LLM + optimizer fallback) and ALWAYS persist trip_places.
 * Creates new locations rows when a visit cannot be resolved to an existing location.
 */
router.get('/:id/itinerary', auth, async (req, res) => {
  const tripId = Number(req.params.id);
  const userId = req.user.id;
  const topK = Number(req.query.topK) || Number(process.env.LLM_TOP_K) || 20;
  const mode = req.query.mode || 'hf';

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

    // derive country from destination (best-effort)
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

    // 4) Parse user preferences into a structured spec
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
      if (mode === 'hf') {
        const hfRaw = await callHF(prefPrompt, { max_new_tokens: 300, temperature: 0.0 });
        const parsed = parseHFResultToJson(hfRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) spec = parsed;
        else throw new Error('Spec parse returned non-object');
      }
    } catch (err) {
      console.warn('Spec parsing with HF failed, using heuristic fallback', err?.message || err);
      spec = { daily_hours: { start: '09:00', end: '18:00' }, visit_default_minutes: 90, relaxation: 'moderate', must_visit: [], avoid: [], max_travel_minutes_per_day: 180 };
    }

    // 5) Score POIs semantically with HF (batched)
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
          const hfRaw = await callHF(scorePrompt, { max_new_tokens: 400, temperature: 0.0 });
          const parsed = parseHFResultToJson(hfRaw);
          if (!Array.isArray(parsed)) throw new Error('HF scoring returned non-array');
          parsed.forEach(p => scoreResults.push(p));
        } catch (err) {
          console.warn('HF POI scoring failed for chunk, using fallback heuristics', err?.message || err);
          chunk.forEach(c => scoreResults.push({ id: c.id, score: Math.max(1, Math.min(5, 1 + ((c.relevancia||0)/10)*4)), reason: 'heuristic fallback' }));
        }
      }
    } else {
      smallPois.forEach(c => scoreResults.push({ id: c.id, score: Math.max(1, Math.min(5, 1 + ((c.relevancia||0)/10)*4)), reason:'heuristic' } ));
    }

    // merge scores into topCandidates and compute combined_score
    const scoreMap = new Map(scoreResults.map(s => [s.id, s]));
    topCandidates.forEach(p => {
      const s = scoreMap.get(p.id);
      p.llm_score = s ? Number(s.score) : 1.0;
      p.llm_reason = s ? String(s.reason).slice(0,200) : null;
      p.combined_score = ((p.relevancia || 0) * 0.6) + ((p.llm_score || 1) * 2.0);
    });
    topCandidates.sort((a,b)=> (b.combined_score || 0) - (a.combined_score || 0));

    // 6) compute travel matrix for topCandidates (seconds) via routing service
    const coords = topCandidates.map(c => ({ id: c.id, lat: c.lat, lng: c.lng }));
    let travelMatrixSeconds = null;
    try {
      travelMatrixSeconds = await routingService.getMatrix(coords);
    } catch (err) {
      console.warn('routingService.getMatrix failed:', err?.message || err);
      travelMatrixSeconds = null;
    }

    // Validate travelMatrixSeconds shape; fallback to approximate matrix if invalid
    const n = topCandidates.length;
    if (!Array.isArray(travelMatrixSeconds) || travelMatrixSeconds.length !== n ||
        travelMatrixSeconds.some(row => !Array.isArray(row) || row.length !== n)) {
      console.warn('Invalid travelMatrixSeconds, falling back to default distance-based matrix');
      travelMatrixSeconds = Array.from({length: n}, (_,i) => Array.from({length: n}, (_,j) => (i===j?0: (topCandidates[i] && topCandidates[j] && topCandidates[i].lat != null && topCandidates[j].lat != null ?
        Math.round(haversineMeters(topCandidates[i].lat, topCandidates[i].lng, topCandidates[j].lat, topCandidates[j].lng) / 10) : 600))));
    }

    // 7) call optimizer (try/catch)
    let itinerary = null;
    const daysArr = (() => { const s=new Date(trip.start_date), e=new Date(trip.end_date), days=[]; for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)) days.push(new Date(d)); return days; })();

    try {
      const useOrtools = (process.env.ITINERARY_MODE === 'ortools' || req.query.useOrtools === '1');
      itinerary = await optimizer.generateItinerary({
        mode: useOrtools ? 'ortools' : 'greedy',
        candidates: topCandidates,
        days: daysArr,
        travelMatrix: travelMatrixSeconds,
        spec: spec,
        placesPerDay: null
      });
    } catch (err) {
      console.warn('Optimizer failed, falling back to greedy simple generator', err?.message || err);
      itinerary = null;
    }

    // fallback to greedy if needed
    const validItinerary = Array.isArray(itinerary) && itinerary.length > 0 && itinerary.some(d => Array.isArray(d.visits) && d.visits.length > 0);
    if (!validItinerary) {
      console.warn('Optimizer produced no valid itinerary — using simpleGreedyGenerator fallback');
      itinerary = simpleGreedyGenerator({ candidates: topCandidates, days: daysArr, spec });
    }

    // repair/validate
    function validateAndRepair(itin) {
      const maxDailyMinutes = spec.max_travel_minutes_per_day || 24*60;
      const startMin = Number(spec.daily_hours?.start?.slice(0,2)) * 60 + Number(spec.daily_hours?.start?.slice(3,5) || 0);
      const endMin = Number(spec.daily_hours?.end?.slice(0,2)) * 60 + Number(spec.daily_hours?.end?.slice(3,5) || 0);
      const dayCapacity = Math.max(60, endMin - startMin);
      for (const day of itin) {
        let total = 0;
        for (const v of day.visits || []) {
          total += (v.visit_minutes || spec.visit_default_minutes || 90) + (v.travel_to_prev_minutes || 0);
        }
        if (total > dayCapacity || total > maxDailyMinutes) {
          day.visits.sort((a,b)=> {
            const ca = topCandidates.find(x=>String(x.id)===String(a.id))?.combined_score || 0;
            const cb = topCandidates.find(x=>String(x.id)===String(b.id))?.combined_score || 0;
            return ca - cb;
          });
          while (day.visits.length && (total > dayCapacity || total > maxDailyMinutes)) {
            const removed = day.visits.shift();
            total -= (removed.visit_minutes || spec.visit_default_minutes || 90) + (removed.travel_to_prev_minutes || 0);
          }
        }
      }
      return itin;
    }

    itinerary = validateAndRepair(itinerary);

    // --- 8) ALWAYS save itinerary into DB (replace existing places). Create locations when needed.
    const insertedPlaces = [];
    const skippedPlaces = [];
    client = await pool.connect();
    try {
      await client.query('BEGIN');

      // check ownership (FOR UPDATE)
      const check = await client.query('SELECT user_id FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
      if (!check.rows.length) { const e = new Error('Trip not found'); e.status = 404; throw e; }
      if (check.rows[0].user_id !== userId) { const e = new Error('No autorizado'); e.status = 403; throw e; }

      // delete existing places
      await client.query('DELETE FROM trip_places WHERE fk_trips = $1', [tripId]);

      const insertTripPlaceSQL =
        'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

      const insertLocationSQL =
        `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country, opening_hours, timezone, avg_duration_min, popularity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`;

      // helper
      const toNumOrNull = v => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);

      // tolerance for lat/lng near-duplicate (approx degrees)
      const LAT_LNG_EPS = 0.0006; // roughly ~50-70 meters

      for (const day of itinerary) {
        for (const v of day.visits || []) {
          let fk_location = null;

          // 1) numeric id
          if (v && (typeof v.id === 'number' || (/^\d+$/.test(String(v.id))))) {
            const n = Number(v.id);
            if (Number.isFinite(n)) fk_location = n;
          }

          // 2) match topCandidates by id or exact title (case-insensitive)
          if (!fk_location) {
            const candidate = topCandidates.find(x =>
              String(x.id) === String(v.id) ||
              (v.titulo && x.titulo && String(x.titulo).toLowerCase() === String(v.titulo).toLowerCase())
            );
            if (candidate && (typeof candidate.id === 'number' || /^\d+$/.test(String(candidate.id)))) {
              fk_location = Number(candidate.id);
            }
          }

          // 3) attempt DB title lookup (exact lower() or ILIKE)
          const title = (v.titulo || v.name || v.title || '').trim();
          // gather coords (from visit, osm, or topCandidates)
          let lat = toNumOrNull(v.lat ?? v.latitude ?? v.latitud ?? (v.osm && v.osm.center && v.osm.center.lat) ?? null);
          let lng = toNumOrNull(v.lng ?? v.longitude ?? v.lon ?? v.longitud ?? (v.osm && v.osm.center && v.osm.center.lon) ?? null);

          // if coords are missing, try to derive from a matching topCandidate
          if ((lat === null || lng === null) && topCandidates && topCandidates.length) {
            const cand = topCandidates.find(x =>
              String(x.id) === String(v.id) ||
              (title && x.titulo && x.titulo.toLowerCase() === title.toLowerCase())
            );
            if (cand) { lat = toNumOrNull(cand.lat); lng = toNumOrNull(cand.lng); }
          }

          if (!fk_location && title) {
            const found = await client.query('SELECT id, latitud, longitud FROM locations WHERE lower(titulo) = lower($1) LIMIT 1', [title]);
            if (found.rows.length) fk_location = found.rows[0].id;
            else {
              const found2 = await client.query('SELECT id, latitud, longitud FROM locations WHERE titulo ILIKE $1 LIMIT 1', [`%${title}%`]);
              if (found2.rows.length) fk_location = found2.rows[0].id;
            }
          }

          // 4) try lat/lng nearby detect to avoid duplicates
          if (!fk_location && lat !== null && lng !== null) {
            const nearby = await client.query(
              'SELECT id FROM locations WHERE latitud IS NOT NULL AND longitud IS NOT NULL AND abs(latitud - $1) < $3 AND abs(longitud - $2) < $3 LIMIT 1',
              [lat, lng, LAT_LNG_EPS]
            );
            if (nearby.rows.length) fk_location = nearby.rows[0].id;
          }

          // 5) If still not found -> create location (if we have title or coords)
          if (!fk_location) {
            if (!title && (lat === null || lng === null)) {
              skippedPlaces.push({ id: v.id, titulo: v.titulo || null, reason: 'No title and no coordinates — cannot create location' });
              continue;
            }

            const fk_interest = null; // unknown at creation time
            const descripcion = v.descripcion || v.description || null;
            const imagenes = v.imagenes || v.images || null;
            const relevancia = toNumOrNull(v.relevancia) ?? 5;
            const countryVal = country || null;
            const opening_hours = null;
            const timezone = v.timezone || null;
            const avg_duration_min = toNumOrNull(v.visit_minutes) || toNumOrNull(v.avg_duration_min) || 90;
            const popularity = null;

            const locRes = await client.query(insertLocationSQL, [
              title || 'unnamed',
              fk_interest,
              descripcion,
              lat,
              lng,
              imagenes,
              relevancia,
              countryVal,
              opening_hours,
              timezone,
              avg_duration_min,
              popularity
            ]);
            fk_location = locRes.rows[0].id;
          }

          // 6) Insert trip_place
          try {
            const r = await client.query(insertTripPlaceSQL, [
              fk_location,
              tripId,
              day.date || null,
              v.start || v.start_hour || null,
              v.end || v.end_hour || null,
              v.reason || v.notes || null
            ]);
            insertedPlaces.push(r.rows[0]);
          } catch (err) {
            skippedPlaces.push({ id: v.id, titulo: title || null, reason: `Insert trip_place failed: ${err.message}` });
            // continue with next visit
          }
        } // end visits
      } // end days

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      throw err;
    } finally {
      // release DB client used for save
      client.release();
      client = null;
    }

    // success: return itinerary and save metadata
    return res.json({ itinerary, saved: true, insertedCount: insertedPlaces.length, insertedPlaces, skippedPlaces });

  } catch (err) {
    // ensure any still-open client is rolled back & released
    if (client) {
      try { await client.query('ROLLBACK').catch(()=>{}); } catch(e) {}
      try { client.release(); } catch(e) {}
      client = null;
    }
    console.error('GET /trips/:id/itinerary error:', err);
    const status = err.status || 500;
    const msg = err.message || 'Error generating itinerary';
    return res.status(status).json({ message: msg, detail: err.detail || undefined });
  }
});

/* (other routes unchanged below) */

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
 * POST /trips/:id/share
 * Create a share link (public or per-user) for a trip.
 * Body:
 *   { mode: 'viewer'|'editor', public: boolean, expires_in_days: number, shared_with_user_id: number }
 * Returns: { url, share_uuid, id, created_at }
 */
router.post('/:id/share', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const tripId = Number(req.params.id);
    if (!Number.isFinite(tripId) || tripId <= 0) return res.status(400).json({ message: 'Invalid trip id' });

    const userId = req.user.id;
    const { mode = 'viewer', public: isPublic = true, expires_in_days = null, shared_with_user_id = null } = req.body || {};

    if (!['viewer','editor'].includes(mode)) return res.status(400).json({ message: 'Invalid mode' });

    // Verify ownership
    const t = await client.query('SELECT user_id FROM trips WHERE id = $1 LIMIT 1', [tripId]);
    if (!t.rows.length) return res.status(404).json({ message: 'Trip not found' });
    if (t.rows[0].user_id !== userId) return res.status(403).json({ message: 'No autorizado' });

    // compute expires_at if requested
    let expiresAt = null;
    if (expires_in_days && Number.isFinite(Number(expires_in_days))) {
      const days = Number(expires_in_days);
      const d = new Date();
      d.setDate(d.getDate() + days);
      expiresAt = d.toISOString();
    }

    // If shared_with_user_id provided, create a non-public share for that user
    const sharedWith = shared_with_user_id ? Number(shared_with_user_id) : null;

    await client.query('BEGIN');

    const insertSQL = `
      INSERT INTO trip_shares (trip_id, shared_by, shared_with, mode, public, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING share_uuid, id, created_at
    `;
    const ins = await client.query(insertSQL, [tripId, userId, sharedWith, mode, isPublic, expiresAt]);

    await client.query('COMMIT');

    const row = ins.rows[0];
    // build URL from request host/origin if possible
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.get('host');
    // public URL path we provide: /share/trip/:uuid
    const url = `${proto}://${host}/share/trip/${row.share_uuid}`;

    res.status(201).json({ url, share_uuid: row.share_uuid, id: row.id, created_at: row.created_at });
  } catch (err) {
    try { await client.query('ROLLBACK').catch(()=>{}); } catch (e) {}
    console.error('POST /trips/:id/share error:', err);
    res.status(500).json({ message: 'Error generando share' });
  } finally {
    client.release();
  }
});

/* GET /trips/:id, PUT, DELETE, POST /trips/:id/places, DELETE /trips/:id/places/:placeId unchanged below - omitted for brevity in snippet */
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
