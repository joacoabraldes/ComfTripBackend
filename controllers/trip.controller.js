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

// Updated PLACES_AGG_SUBQUERY to include new columns added to `locations`
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
             'opening_hours', l.opening_hours,
             'opening_hours_parsed', l.opening_hours_parsed,
             'photos', l.photos,
             'avg_duration_min', l.avg_duration_min,
             'timezone', l.timezone,
             'price_level', l.price_level,
             'tags', l.tags,
             'osm_id', l.osm_id
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
 * Now uses candidate.avg_duration_min when available and respects a simple opening-hours window heuristic.
 */
function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const hh = Number(t.slice(0,2));
  const mm = Number(t.slice(3,5) || 0);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh*60 + mm;
}

function minutesToHHMM(m) {
  if (!Number.isFinite(m)) return null;
  const hh = Math.floor(m/60).toString().padStart(2,'0');
  const mm = Math.round(m%60).toString().padStart(2,'0');
  return `${hh}:${mm}`;
}

function extractOpeningWindowFromString(openingStr) {
  if (!openingStr || typeof openingStr !== 'string') return null;
  // very simple regex to find first occurrence of HH:MM-HH:MM
  const re = /([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)/;
  const m = openingStr.match(re);
  if (!m) return null;
  const open = `${m[1].padStart(2,'0')}:${m[2].padStart(2,'0')}`;
  const close = `${m[3].padStart(2,'0')}:${m[4].padStart(2,'0')}`;
  return [open, close];
}

function simpleGreedyGenerator({ candidates, days, spec }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
    let defaultVisit = Number(spec?.visit_default_minutes || 90);
  // if there are many candidates per day, reduce default visit to allow more stops
  try {
    if (candidates.length > days.length * 6) {
      defaultVisit = Math.max(30, Math.round(defaultVisit * 0.6));
    }
  } catch (e) { /* defensive */ }

  const startMinGlobal = (() => {
    const s = spec?.daily_hours?.start || '09:00';
    return parseTimeToMinutes(s) ?? (9*60);
  })();
  const endMinGlobal = (() => {
    const e = spec?.daily_hours?.end || '18:00';
    return parseTimeToMinutes(e) ?? (18*60);
  })();
  const dayCapacity = Math.max(60, endMinGlobal - startMinGlobal);
  const speedMetersPerMin = 500; // ~30 km/h -> 500 m/min

  const sorted = [...candidates].sort((a,b)=> (b.combined_score||0) - (a.combined_score||0));
  const assigned = new Set();
  const itinerary = [];

  for (let d = 0; d < days.length; d++) {
    const dayDate = days[d] instanceof Date ? days[d].toISOString().slice(0,10) : (new Date(days[d]).toISOString().slice(0,10));
    let remaining = dayCapacity;
    const visits = [];
    let prev = null;
    let cursorMin = startMinGlobal; // minutes from midnight

    for (let i=0;i<sorted.length;i++) {
      const cand = sorted[i];
      if (assigned.has(cand.id)) continue;
      // determine visit duration (prefer candidate.avg_duration_min)
      const visitDur = Number(cand.avg_duration_min) && Number(cand.avg_duration_min) > 0 ? Number(cand.avg_duration_min) : defaultVisit;

      // compute travel to this from prev
      let travelMin = 0;
      if (prev && cand.lat != null && prev.lat != null) {
        const dist = haversineMeters(prev.lat, prev.lng, cand.lat, cand.lng);
        travelMin = Math.ceil(dist / speedMetersPerMin);
      } else {
        travelMin = 10; // small default initial travel
      }

      let proposedStart = cursorMin + travelMin;
      let proposedEnd = proposedStart + visitDur;

      // try respect simple opening hours heuristic if available
      let window = null;
      if (cand.opening_hours_parsed && cand.opening_hours_parsed.is_open_now === true) {
        // if parsed exists and indicates open_now, accept
      } else if (cand.opening_hours) {
        window = extractOpeningWindowFromString(typeof cand.opening_hours === 'string' ? cand.opening_hours : String(cand.opening_hours));
      }
      if (window) {
        const openMin = parseTimeToMinutes(window[0]);
        const closeMin = parseTimeToMinutes(window[1]);
        // shift proposedStart to be at least openMin
        if (proposedStart < openMin) {
          proposedStart = openMin;
          proposedEnd = proposedStart + visitDur;
        }
        // if it doesn't fit before close, try reduce duration
        if (proposedEnd > closeMin) {
          const avail = Math.max(0, closeMin - proposedStart);
          if (avail < 15) {
            // can't schedule this visit in this window
            continue;
          }
          // reduce visit to fit available time
          proposedEnd = closeMin;
        }
      }

      const needed = (proposedEnd - cursorMin) || (travelMin + visitDur);
      if (needed <= remaining) {
        visits.push({
          id: cand.id,
          titulo: cand.titulo,
          visit_minutes: (proposedEnd - proposedStart),
          travel_to_prev_minutes: travelMin,
          start_min: proposedStart,
          end_min: proposedEnd,
          start_time: minutesToHHMM(proposedStart),
          end_time: minutesToHHMM(proposedEnd),
          reason: cand.llm_reason || null,
          score: cand.combined_score || null
        });
        assigned.add(cand.id);
        remaining -= needed;
        cursorMin = proposedEnd; // next cursor
        prev = cand;
      }
      if (remaining < 15) break;
    }
    // transform visits to expected output shape
    const visitsOut = visits.map(v => ({ id: v.id, titulo: v.titulo, visit_minutes: v.visit_minutes, travel_to_prev_minutes: v.travel_to_prev_minutes, start: v.start_time, end: v.end_time, reason: v.reason, score: v.score }));
    itinerary.push({ date: dayDate, visits: visitsOut });
  }

  const anyAssigned = itinerary.some(d => (d.visits && d.visits.length));
  if (!anyAssigned) {
    const fallbackDays = [];
    for (let d=0; d<days.length; d++) {
      const dayDate = days[d] instanceof Date ? days[d].toISOString().slice(0,10) : (new Date(days[d]).toISOString().slice(0,10));
      const cand = sorted[d % sorted.length];
      fallbackDays.push({ date: dayDate, visits: [{ id: cand.id, titulo: cand.titulo, visit_minutes: defaultVisit, travel_to_prev_minutes: 10, start: minutesToHHMM(startMinGlobal), end: minutesToHHMM(startMinGlobal + defaultVisit), reason: 'fallback' }]});
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
  // --- ENRICH topCandidates with full location fields (opening_hours, avg_duration_min, photos, tags, timezone)
    try {
      // separate numeric DB ids from OSM-style ids
      const numericIds = topCandidates.map(p => {
        const n = Number(p.id);
        return Number.isFinite(n) ? n : null;
      }).filter(Boolean);

      const osmIds = topCandidates.map(p => {
        if (!p.id && p.osm_id) return String(p.osm_id);
        return (typeof p.id === 'string' && !/^\d+$/.test(p.id)) ? String(p.id) : null;
      }).filter(Boolean);

      if (numericIds.length === 0 && osmIds.length === 0) {
        // nothing to enrich
      } else {
        // build flexible WHERE: id = ANY($1::bigint[]) OR osm_id = ANY($2::text[])
        const whereParts = [];
        const params = [];
        let idx = 1;
        if (numericIds.length) {
          whereParts.push(`id = ANY($${idx}::bigint[])`);
          params.push(numericIds);
          idx++;
        }
        if (osmIds.length) {
          whereParts.push(`osm_id = ANY($${idx}::text[])`);
          params.push(osmIds);
          idx++;
        }

        const q = `
          SELECT id, osm_id, opening_hours, opening_hours_parsed, photos, imagenes, avg_duration_min, timezone, price_level, tags, latitud, longitud
          FROM locations
          WHERE ${whereParts.join(' OR ')}
        `;
        const r = await pool.query(q, params);
        // map results by id and osm_id
        const byId = new Map();
        const byOsm = new Map();
        for (const rr of r.rows) {
          if (rr.id != null) byId.set(String(rr.id), rr);
          if (rr.osm_id) byOsm.set(String(rr.osm_id), rr);
        }

        for (const p of topCandidates) {
          // try numeric id match first, then osm_id match, then if p.osm_id present
          const key = (p.id === null || p.id === undefined) ? null : String(p.id);
          const rr = (key && byId.has(key) && byId.get(key)) ||
                     (key && byOsm.has(key) && byOsm.get(key)) ||
                     (p.osm_id && byOsm.has(String(p.osm_id)) && byOsm.get(String(p.osm_id)));

          if (rr) {
            p.opening_hours = rr.opening_hours || null;
            p.opening_hours_parsed = rr.opening_hours_parsed || null;
            p.photos = rr.photos || rr.imagenes || null;
            p.avg_duration_min = Number(rr.avg_duration_min) || p.avg_duration_min || null;
            p.timezone = rr.timezone || null;
            p.price_level = rr.price_level || null;
            p.tags = rr.tags || null;
            // ensure we keep numeric lat/lng on the candidate for routing/haversine
            p.lat = (p.lat || p.latitude || rr.latitud || rr.latitude) ?? null;
            p.lng = (p.lng || p.longitude || rr.longitud || rr.longitude) ?? null;
            // keep osm_id and a canonical id if available
            if (rr.osm_id && !p.osm_id) p.osm_id = rr.osm_id;
            if (rr.id && (!p.id || !/^\d+$/.test(String(p.id)))) {
              // preserve original p.id as string but also expose db_id for clarity if you need it later
              p.db_id = Number(rr.id);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Could not enrich topCandidates from DB:', err?.message || err, err?.stack || '');
    }

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
      id: p.id, title: p.titulo, interest: p.fk_interest, country: p.country, relevancia: p.relevancia || 0, idx,
      opening_hours: p.opening_hours || null,
      avg_duration_min: p.avg_duration_min || null,
      photos: p.photos || null,
      price_level: p.price_level || null,
      tags: p.tags || null
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
      // use avg_duration_min if available for combined scoring influence
      p.combined_score = ((p.relevancia || 0) * 0.5) + ((p.llm_score || 1) * 2.0) + ((p.avg_duration_min || 90) / 120);
    });
    topCandidates.sort((a,b)=> (b.combined_score || 0) - (a.combined_score || 0));

        // 6) compute travel matrix for topCandidates (seconds) via routing service
    // ensure lat/lng fields exist and are numeric
    const coords = topCandidates.map(c => {
      const lat = (c.lat ?? c.latitude ?? c.latitud) !== undefined ? Number(c.lat ?? c.latitude ?? c.latitud) : null;
      const lng = (c.lng ?? c.longitude ?? c.longitud) !== undefined ? Number(c.lng ?? c.longitude ?? c.longitud) : null;
      return { id: c.id, db_id: c.db_id ?? null, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
    });

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
      const startMin = parseTimeToMinutes(spec.daily_hours?.start || '09:00');
      const endMin = parseTimeToMinutes(spec.daily_hours?.end || '18:00');
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
        `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country, opening_hours, opening_hours_parsed, timezone, avg_duration_min, popularity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13) RETURNING id`;

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
              const candidate = topCandidates.find(x => {
              const xid = String(x.id ?? '');
              const xosm = String(x.osm_id ?? '');
              const vIdStr = String(v.id ?? '');
              return (
                xid === vIdStr ||
                xosm === vIdStr ||
                (x.db_id && String(x.db_id) === vIdStr) ||
                (v.titulo && x.titulo && String(x.titulo).toLowerCase() === String(v.titulo).toLowerCase())
              );
            });
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

          // compute start/end if not provided using the visit_minutes and window heuristics
          let startHour = v.start || v.start_hour || null;
          let endHour = v.end || v.end_hour || null;

          // If startHour missing, try to compute sequentially based on day's visits already planned
          if (!startHour) {
            // find how many places already planned for this day (in our current save loop)
            const existingForDay = insertedPlaces.filter(p => p.date && p.date.toISOString().slice(0,10) === String(day.date));
            // compute cursor: either last inserted end_hour or spec.daily_hours.start
            let cursorMin = parseTimeToMinutes(spec.daily_hours?.start || '09:00');
            if (existingForDay.length) {
              const last = existingForDay[existingForDay.length-1];
              if (last.end_hour) {
                const mm = parseTimeToMinutes(last.end_hour);
                if (mm !== null) cursorMin = mm;
              }
            }
            const travelMin = v.travel_to_prev_minutes || v.travel_to_prev || 10;
            const visitMin = v.visit_minutes || v.visit_minutes || v.visit_minutes === 0 ? v.visit_minutes : (v.visit_minutes || v.visit_minutes === 0 ? v.visit_minutes : (v.avg_duration_min || spec.visit_default_minutes || 90));
            const proposedStart = cursorMin + (Number(travelMin) || 10);
            const proposedEnd = proposedStart + (Number(visitMin) || 90);

            // respect opening_hours if available (simple parse)
            let window = null;
            const candidateInfo = topCandidates.find(x => String(x.id) === String(v.id));
            if (candidateInfo) {
              if (candidateInfo.opening_hours_parsed && candidateInfo.opening_hours_parsed.is_open_now === true) {
                // assume open during day
              } else if (candidateInfo.opening_hours) {
                window = extractOpeningWindowFromString(typeof candidateInfo.opening_hours === 'string' ? candidateInfo.opening_hours : String(candidateInfo.opening_hours));
              }
            }
            let finalStart = proposedStart;
            let finalEnd = proposedEnd;

            if (window) {
              const openMin = parseTimeToMinutes(window[0]);
              const closeMin = parseTimeToMinutes(window[1]);
              if (finalStart < openMin) finalStart = openMin;
              if (finalEnd > closeMin) finalEnd = Math.max(openMin, closeMin); // clamp
              if (finalEnd - finalStart < 10) {
                // cannot schedule realistically
                startHour = null; endHour = null;
              } else {
                startHour = minutesToHHMM(finalStart);
                endHour = minutesToHHMM(finalEnd);
              }
            } else {
              startHour = minutesToHHMM(finalStart);
              endHour = minutesToHHMM(finalEnd);
            }
          }

          // 5) If still not found -> create location (if we have title or coords)
          if (!fk_location) {
            if (!title && (lat === null || lng === null)) {
              skippedPlaces.push({ id: v.id, titulo: v.titulo || null, reason: 'No title and no coordinates — cannot create location' });
              continue;
            }

            const fk_interest = null; // unknown at creation time
            const descripcion = v.descripcion || v.description || null;
            const imagenes = v.imagenes || v.images || v.photos || null;
            const relevancia = toNumOrNull(v.relevancia) ?? 5;
            const countryVal = country || null;
            const opening_hours = v.opening_hours ? (typeof v.opening_hours === 'object' ? JSON.stringify(v.opening_hours) : v.opening_hours) : null;
            const opening_hours_parsed = v.opening_hours_parsed ? (typeof v.opening_hours_parsed === 'object' ? JSON.stringify(v.opening_hours_parsed) : v.opening_hours_parsed) : null;
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
              opening_hours_parsed,
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
              startHour,
              endHour,
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
    // build URL that points to the backend share endpoint (share.controller)
    const base = `${req.protocol}://${req.get('host')}`; // e.g., http://localhost:5432
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
      // attach share metadata if present
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

module.exports = router;
