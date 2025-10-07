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
// simple in-memory cache for wikipedia/name lookups
const wikiCache = new Map();

// concurrency helper: runs worker(items[i]) with up to `concurrency` parallel tasks
async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const running = [];
  function next() {
    if (idx >= items.length) return null;
    const cur = idx++;
    const p = (async () => {
      try { results[cur] = await worker(items[cur], cur); }
      catch (err) { results[cur] = { error: err }; }
    })();
    running.push(p);
    p.then(() => { const i = running.indexOf(p); if (i >= 0) running.splice(i, 1); });
    return p;
  }
  for (let i = 0; i < Math.min(concurrency, items.length); i++) next();
  while (running.length) {
    await Promise.race(running);
    next();
  }
  return results;
}

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
// (simpleGreedyGenerator and helper functions - minor tweaks applied below)
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
  // default visit length from spec
  let defaultVisit = Number(spec?.visit_default_minutes || 90);

  // If many candidates relative to days, reduce defaultVisit to allow more stops.
  // Previously min was 30 — lower to 20 to allow "intenso" to schedule more.
  try {
    if (candidates.length > days.length * 6) {
      defaultVisit = Math.max(20, Math.round(defaultVisit * 0.6));
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
  // realistic walking speed: ~80-90 m/min (about 4.8-5.4 km/h)
  const speedMetersPerMin = 80;

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
      if (prev && cand.lat != null && prev.lat != null && cand.lng != null && prev.lng != null) {
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
        // parsed open now -> accept
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
      fallbackDays.push({ date: dayDate, visits: [{ id: cand.id, titulo: cand.titulo, visit_minutes: defaultVisit, travel_to_prev_minutes: 10, start: minutesToHHMM(startMinGlobal), end: minutesToHHMM(startMinGlobal + defaultVisit), reason: 'fallback' }]} );
    }
    return fallbackDays;
  }
  return itinerary;
}

/* ---------- Additional helpers for more robust fallback scoring ---------- */

// Heuristic scoring helper used when HF fails (returns score 1.0..5.0)
function heuristicScorePOI(p, spec = {}) {
  // p: { id, title, relevancia, opening_hours, photos, avg_duration_min, ...}
  const rel = Math.max(0, Math.min(100, Number(p.relevancia || 0)));
  let score = 1.0;
  // map relevancia to up to +3.0
  score += (rel / 100) * 3.0;
  if (p.photos || p.imagenes) score += 0.45;
  if (p.opening_hours) score += 0.3;
  if (p.website) score += 0.2;
  if (p.avg_duration_min && spec.visit_default_minutes) {
    const diff = Math.abs(Number(p.avg_duration_min) - Number(spec.visit_default_minutes || 90));
    const bonus = Math.max(0, 0.25 - Math.min(0.25, diff / 240));
    score += bonus;
  }
  try {
    if (Array.isArray(spec.must_visit_ids) && spec.must_visit_ids.includes(p.id)) score += 0.8;
  } catch (e) { /* ignore */ }
  score = Math.max(1.0, Math.min(5.0, Math.round(score * 10) / 10));
  const reasons = [];
  if (rel > 0) reasons.push(`relev:${rel}`);
  if (p.photos) reasons.push('img');
  if (p.opening_hours) reasons.push('hours');
  if (p.website) reasons.push('web');
  if (Array.isArray(spec.must_visit_ids) && spec.must_visit_ids.includes(p.id)) reasons.push('must');
  return { score, reason: (reasons.slice(0,3).join(', ') || 'heuristic') };
}

/* ---------- main handler (POST/GET) ---------- */
async function handleItinerary(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  // read params from body for POST, query for GET
  const source = (method === 'POST') ? req.body || {} : req.query || {};

  // Normalize params
  const saveFlag = (source.save === undefined) ? true : ((String(source.save) === 'false' || source.save === false) ? false : true);
  const pace = source.pace ? String(source.pace).trim() : null;
  let places = [];
  if (Array.isArray(source.places)) places = source.places.map(p => (typeof p === 'string' ? p.trim() : p)).filter(Boolean);
  else if (typeof source.places === 'string' && source.places.trim()) {
    // try JSON parse first
    try { places = JSON.parse(source.places); if (!Array.isArray(places)) places = String(source.places).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean); }
    catch (e) { places = String(source.places).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean); }
  }
  const llm_notes = source.llm_notes || source.notes || null;
  const incomingBudget = (source.budget === undefined || source.budget === '') ? null : source.budget;

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

    // derive country and city from destination (best-effort)
    let country = null;
    let cityVal = null;
    if (typeof trip.destination === 'string' && trip.destination.includes(',')) {
      const parts = trip.destination.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length) {
        country = parts[parts.length - 1];
        cityVal = parts.slice(0, parts.length - 1).join(', ');
      }
    } else if (typeof trip.destination === 'string') {
      const parts = trip.destination.trim().split(' ');
      country = parts.length > 1 ? parts[parts.length - 1] : trip.destination.trim();
      // best-effort city (first token)
      cityVal = parts.length > 1 ? parts.slice(0, parts.length - 1).join(' ') : null;
    }

    // 3) fetch candidate POIs (db-first)
    // Note: pass trip.notes to poiService as before; we'll also include llm_notes in prompts later
    let candidates = await poiService.getCandidates({ db: pool, interestSlugs, destination: trip.destination, limit: 300, notes: trip.notes });

    if (!candidates || !candidates.length) return res.status(404).json({ message: 'No candidate locations found' });

    // sort by relevancia and take topK for the LLM
    candidates.sort((a,b) => (b.relevancia || 0) - (a.relevancia || 0));
    const topCandidates = candidates.slice(0, topK);

    // --- ENRICH topCandidates with full location fields (robust null-safe assignments) ---
    try {
      const numericIds = topCandidates.map(p => {
        const n = Number(p.id);
        return Number.isFinite(n) ? n : null;
      }).filter(Boolean);

      if (numericIds.length > 0) {
        const whereParts = [];
        const params = [];
        let idx = 1;
        whereParts.push(`id = ANY($${idx}::bigint[])`);
        params.push(numericIds);
        idx++;

        const q = `
          SELECT id, opening_hours, imagenes, latitud, longitud, relevancia, country, city, website, category
          FROM locations
          WHERE ${whereParts.join(' OR ')}
        `;
        const r = await pool.query(q, params);
        const byId = new Map();
        for (const rr of r.rows) {
          if (rr.id != null) byId.set(String(rr.id), rr);
        }

        for (const p of topCandidates) {
          const key = (p.id === null || p.id === undefined) ? null : String(p.id);
          const rr = (key && byId.has(key) && byId.get(key));
          if (rr) {
            // Null-safe preference: DB values preferred but preserve existing if set
            p.opening_hours = rr.opening_hours ?? p.opening_hours ?? null;
            p.photos = rr.imagenes ?? p.photos ?? null;
            p.avg_duration_min = p.avg_duration_min ?? null;
            p.timezone = p.timezone ?? null;
            p.price_level = p.price_level ?? null;
            p.tags = p.tags ?? null;

            // Null-safe numeric lat/lng assignment (avoid `||` which drops 0)
            const latVal = (p.lat ?? p.latitude ?? rr.latitud ?? null);
            const lngVal = (p.lng ?? p.longitude ?? rr.longitud ?? null);
            p.lat = (latVal !== null && latVal !== undefined && !Number.isNaN(Number(latVal))) ? Number(latVal) : null;
            p.lng = (lngVal !== null && lngVal !== undefined && !Number.isNaN(Number(lngVal))) ? Number(lngVal) : null;

            p.country = p.country ?? rr.country ?? null;
            p.city = p.city ?? rr.city ?? null;
            p.website = p.website ?? rr.website ?? null;
            p.category = p.category ?? rr.category ?? null;

            if (rr.id && (!p.id || !/^\d+$/.test(String(p.id)))) {
              p.db_id = Number(rr.id);
            }
          } else {
            // ensure lat/lng fields are normalized types even when no rr found
            const latRaw = p.lat ?? p.latitude ?? null;
            const lngRaw = p.lng ?? p.longitude ?? null;
            p.lat = (latRaw !== null && latRaw !== undefined && !Number.isNaN(Number(latRaw))) ? Number(latRaw) : null;
            p.lng = (lngRaw !== null && lngRaw !== undefined && !Number.isNaN(Number(lngRaw))) ? Number(lngRaw) : null;
          }
        }
      } else {
        // ensure numeric normals for lat/lng if no numericIds
        for (const p of topCandidates) {
          const latRaw = p.lat ?? p.latitude ?? null;
          const lngRaw = p.lng ?? p.longitude ?? null;
          p.lat = (latRaw !== null && latRaw !== undefined && !Number.isNaN(Number(latRaw))) ? Number(latRaw) : null;
          p.lng = (lngRaw !== null && lngRaw !== undefined && !Number.isNaN(Number(lngRaw))) ? Number(lngRaw) : null;
        }
      }
    } catch (err) {
      console.warn('Could not enrich topCandidates from DB:', err?.message || err, err?.stack || '');
      // best-effort normalization
      for (const p of topCandidates) {
        const latRaw = p.lat ?? p.latitude ?? p.latitud ?? null;
        const lngRaw = p.lng ?? p.longitude ?? p.longitud ?? null;
        p.lat = (latRaw !== null && latRaw !== undefined && !Number.isNaN(Number(latRaw))) ? Number(latRaw) : null;
        p.lng = (lngRaw !== null && lngRaw !== undefined && !Number.isNaN(Number(lngRaw))) ? Number(lngRaw) : null;
      }
    }

    // 4) Parse user preferences into a structured spec
    // Merge trip.notes + llm_notes into the prompt input so HF sees both
    const combinedNotesForLLM = [trip.notes || '', llm_notes || ''].filter(Boolean).join('\n\n');

    const prefInputObj = {
      destination: trip.destination,
      start_date: (new Date(trip.start_date)).toISOString().slice(0,10),
      end_date: (new Date(trip.end_date)).toISOString().slice(0,10),
      budget: incomingBudget ?? trip.budget,
      interests: interestSlugs,
      notes: combinedNotesForLLM,
      pace: pace || null,
      places: places || []
    };

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
${JSON.stringify(prefInputObj, null, 2)}
Return only JSON.
`;
    let spec = null;
    try {
      if (mode === 'hf') {
        const hfRaw = await callHF(prefPrompt, { max_new_tokens: 300, temperature: 0.0, timeout: 120000 });
        const parsed = parseHFResultToJson(hfRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) spec = parsed;
        else throw new Error('Spec parse returned non-object');
      }
    } catch (err) {
      console.warn('Spec parsing with HF failed, using heuristic fallback', err?.message || err);
      spec = { daily_hours: { start: '09:00', end: '18:00' }, visit_default_minutes: 90, relaxation: 'moderate', must_visit: [], avoid: [], max_travel_minutes_per_day: 180 };
    }

    // If incoming places exist, merge them into spec.must_visit (keep names/ids)
    if (!Array.isArray(spec.must_visit)) spec.must_visit = [];
    const incomingPlacesNormalized = (places || []).map(p => (typeof p === 'string' ? p.trim() : (p && p.name ? String(p.name).trim() : String(p))));
    spec.must_visit = Array.from(new Set([ ...(spec.must_visit || []).filter(Boolean).map(String), ...incomingPlacesNormalized.filter(Boolean).map(String) ]));

    // Apply pace mapping to tweak relaxation and visit_default_minutes
    // NOTE: 'intenso' reduces default visit by a larger delta to allow more stops
    const paceMap = {
      relajado: { relaxation: 'high', delta: +30 },
      moderado: { relaxation: 'moderate', delta: 0 },
      intenso: { relaxation: 'low', delta: -40 }
    };
    if (pace && paceMap[pace]) {
      spec.relaxation = paceMap[pace].relaxation;
      spec.visit_default_minutes = Math.max(20, (spec.visit_default_minutes || 90) + (paceMap[pace].delta || 0));
    } else {
      spec.visit_default_minutes = spec.visit_default_minutes || 90;
      spec.relaxation = spec.relaxation || 'moderate';
    }

    // 5) Score POIs semantically with HF (batched). Add retry + strong heuristic fallback
    const smallPois = topCandidates.map((p, idx) => ({
      id: p.id, title: p.titulo, interest: p.fk_interest, country: p.country, relevancia: p.relevancia || 0, idx,
      opening_hours: p.opening_hours || null,
      avg_duration_min: p.avg_duration_min || null,
      photos: p.photos || p.imagenes || null,
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
User prefs: ${JSON.stringify({...spec, notes: combinedNotesForLLM, budget: incomingBudget ?? trip.budget, interests: interestSlugs})}
POIS: ${JSON.stringify(chunk)}
Return only JSON.
`;
        try {
          const hfRaw = await callHF(scorePrompt, { max_new_tokens: 400, temperature: 0.0, timeout: 120000 });
          const parsed = parseHFResultToJson(hfRaw);
          if (!Array.isArray(parsed)) throw new Error('HF scoring returned non-array');
          parsed.forEach(p => scoreResults.push(p));
        } catch (err) {
          console.warn('HF POI scoring failed for chunk, attempting single retry then heuristics', err?.message || err);

          // single retry attempt (to recover from transient router aborts)
          let retriedSuccessfully = false;
          try {
            const hfRawRetry = await callHF(scorePrompt, { max_new_tokens: 400, temperature: 0.0, timeout: 90000, forceRouter: false });
            const parsedRetry = parseHFResultToJson(hfRawRetry);
            if (Array.isArray(parsedRetry)) {
              parsedRetry.forEach(p => scoreResults.push(p));
              retriedSuccessfully = true;
            }
          } catch (retryErr) {
            console.warn('HF retry failed for chunk, falling back to heuristic scoring:', retryErr?.message || retryErr);
          }

          if (!retriedSuccessfully) {
            // heuristic fallback for each candidate in this chunk
            for (const c of chunk) {
              const h = heuristicScorePOI(c, spec);
              scoreResults.push({ id: c.id, score: h.score, reason: h.reason });
            }
          }
        }
      }
    } else {
      smallPois.forEach(c => {
        const h = heuristicScorePOI(c, spec);
        scoreResults.push({ id: c.id, score: h.score, reason: h.reason });
      });
    }

    // merge scores into topCandidates and compute combined_score
    const scoreMap = new Map(scoreResults.map(s => [String(s.id), s]));
    topCandidates.forEach(p => {
      const s = scoreMap.get(String(p.id));
      p.llm_score = s ? Number(s.score) : 1.0;
      p.llm_reason = s ? String(s.reason).slice(0,200) : null;
      // combined_score uses relevancia (DB), llm_score (1..5), and duration as mild factor
      p.combined_score = ((p.relevancia || 0) * 0.55) + ((p.llm_score || 1) * 2.0) + ((p.avg_duration_min || spec.visit_default_minutes || 90) / 120);
    });
    topCandidates.sort((a,b)=> (b.combined_score || 0) - (a.combined_score || 0));

    // Attempt to resolve spec.must_visit names to numeric candidate ids
    const mustVisitResolvedIds = [];
    const mustVisitNamesFallback = [];
    for (const mv of (spec.must_visit || [])) {
      const mvStr = String(mv || '').trim();
      if (!mvStr) continue;
      // match candidate title (case-insensitive) or id
      const candById = topCandidates.find(x => String(x.id) === mvStr);
      if (candById) { mustVisitResolvedIds.push(candById.id); continue; }
      const candByTitle = topCandidates.find(x => x.titulo && String(x.titulo).toLowerCase() === mvStr.toLowerCase());
      if (candByTitle) { mustVisitResolvedIds.push(candByTitle.id); continue; }
      // partial match
      const candPartial = topCandidates.find(x => x.titulo && String(x.titulo).toLowerCase().includes(mvStr.toLowerCase()));
      if (candPartial) { mustVisitResolvedIds.push(candPartial.id); continue; }
      // else keep as a name fallback
      mustVisitNamesFallback.push(mvStr);
    }
    spec.must_visit_ids = Array.from(new Set(mustVisitResolvedIds));
    spec.must_visit_names = Array.from(new Set(mustVisitNamesFallback));

    // 6) compute travel matrix for topCandidates (seconds) via routing service
    // robust coords mapping
    const coords = topCandidates.map(c => {
      const latRaw = c.lat ?? c.latitude ?? c.latitud ?? null;
      const lngRaw = c.lng ?? c.longitude ?? c.longitud ?? null;
      const latNum = (latRaw !== null && latRaw !== undefined && !Number.isNaN(Number(latRaw))) ? Number(latRaw) : null;
      const lngNum = (lngRaw !== null && lngRaw !== undefined && !Number.isNaN(Number(lngRaw))) ? Number(lngRaw) : null;
      return { id: c.id, db_id: c.db_id ?? null, lat: latNum, lng: lngNum };
    });

    let travelMatrixSeconds = null;
    try {
      travelMatrixSeconds = await routingService.getMatrix(coords);
    } catch (err) {
      console.warn('routingService.getMatrix failed:', err?.message || err);
      travelMatrixSeconds = null;
    }

    // Validate travelMatrixSeconds shape; fallback to robust distance->seconds matrix if invalid
    const n = topCandidates.length;
    if (!Array.isArray(travelMatrixSeconds) || travelMatrixSeconds.length !== n ||
        travelMatrixSeconds.some(row => !Array.isArray(row) || row.length !== n)) {
      console.warn('Invalid travelMatrixSeconds, falling back to default distance-based matrix');
      const walkingMetersPerSec = 1.4; // ~5 km/h => 1.388... m/s; use 1.4 for safety
      travelMatrixSeconds = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => {
          if (i === j) return 0;
          const a = topCandidates[i], b = topCandidates[j];
          const latA = (a.lat ?? a.latitude ?? a.latitud);
          const lonA = (a.lng ?? a.longitude ?? a.longitud);
          const latB = (b.lat ?? b.latitude ?? b.latitud);
          const lonB = (b.lng ?? b.longitude ?? b.longitud);
          if (latA == null || lonA == null || latB == null || lonB == null) {
            // no coords -> default 10 minutes (600s)
            return 600;
          }
          const dist = haversineMeters(Number(latA), Number(lonA), Number(latB), Number(lonB)); // meters
          // convert meters -> seconds using walkingMetersPerSec (min 20s)
          const secs = Math.max(20, Math.round(dist / walkingMetersPerSec));
          return secs;
        })
      );
    }

    // 7) call optimizer (try/catch)
    let itinerary = null;
    const daysArr = (() => { const s=new Date(trip.start_date), e=new Date(trip.end_date), days=[]; for(let d=new Date(s); d<=e; d.setDate(d.getDate()+1)) days.push(new Date(d)); return days; })();

    try {
      const useOrtools = (process.env.ITINERARY_MODE === 'ortools' || req.query.useOrtools === '1');
      // pass spec (now includes must_visit_ids/names, visit_default_minutes, relaxation)
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

    // repair/validate (unchanged)
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

      // New insert matching updated locations schema
      const insertLocationSQL =
        `INSERT INTO locations (titulo, fk_interest, descripcion, latitud, longitud, imagenes, relevancia, country, opening_hours, website, category, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) RETURNING id`;

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
              const vIdStr = String(v.id ?? '');
              return (
                xid === vIdStr ||
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
          // gather coords (from visit, or topCandidates)
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
            const visitMin = (v.visit_minutes !== undefined && v.visit_minutes !== null) ? Number(v.visit_minutes) : (v.avg_duration_min || spec.visit_default_minutes || 90);
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
            // ensure imagenes is JSON or null
            const imagenes = (v.imagenes || v.images || v.photos) ? (typeof (v.imagenes || v.images || v.photos) === 'string' ? JSON.parse(v.imagenes || v.images || v.photos) : (v.imagenes || v.images || v.photos)) : null;
            const relevancia = toNumOrNull(v.relevancia) ?? 5;
            const countryVal = country || null;
            const opening_hours = v.opening_hours ? (typeof v.opening_hours === 'object' ? JSON.stringify(v.opening_hours) : JSON.stringify({ raw: v.opening_hours })) : null;
            const websiteVal = v.website || v.url || null;
            const categoryVal = v.category || null;
            const cityToInsert = v.city || cityVal || null;

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
              websiteVal,
              categoryVal,
              cityToInsert
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
      try { client.release(); } catch (e) {}
      client = null;
    }

    // success: return itinerary and save metadata
    return res.json({
      itinerary,
      saved: true,
      insertedCount: insertedPlaces.length,
      insertedPlaces,
      skippedPlaces,
      specUsed: spec // return spec for debugging / front-end use
    });

  } catch (err) {
    // ensure any still-open client is rolled back & released
    if (client) {
      try { await client.query('ROLLBACK').catch(()=>{}); } catch(e) {}
      try { client.release(); } catch(e) {}
      client = null;
    }
    console.error('GET/POST /trips/:id/itinerary error:', err);
    const status = err.status || 500;
    const msg = err.message || 'Error generating itinerary';
    return res.status(status).json({ message: msg, detail: err.detail || undefined });
  }
}

router.post('/:id/itinerary', auth, handleItinerary);
router.get('/:id/itinerary', auth, handleItinerary);


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

/**
 * POST /trips/:id/places/auto
 * Body: { place: { fk_location, date, start_hour?, end_hour?, notes? } }
 * Adds a place to a trip by calculating the best insertion (using routing service).
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
      `SELECT tp.id, tp.fk_locations, tp.date, tp.start_hour, tp.end_hour, tp.notes, l.latitude, l.longitude
       FROM trip_places tp
       JOIN locations l ON l.id = tp.fk_locations
       WHERE tp.fk_trips = $1 AND tp.date::text = $2
       ORDER BY tp.id ASC`, // ORDER BY created order; change if you have explicit order column
      [tripId, dateOnly]
    );
    const existingPlaces = existingRes.rows;

    // Fetch coords for the new location
    const locRes = await client.query('SELECT id, latitude, longitude FROM locations WHERE id = $1 LIMIT 1', [Number(place.fk_location)]);
    if (!locRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Location (fk_location) no encontrada' });
    }
    const newLoc = locRes.rows[0];

    // Build coords array: existing places (in order) + new location at the end
    // We'll compute best order (full permute for small n) or best insertion for larger n.
    const coords = [];
    const indexMap = []; // maps coords index -> { type: 'existing'|'new', existingIndex }
    for (let i = 0; i < existingPlaces.length; i++) {
      const p = existingPlaces[i];
      coords.push({ id: p.fk_locations, lat: Number(p.latitude), lng: Number(p.longitude) });
      indexMap.push({ type: 'existing', existingIndex: i });
    }
    // new place last
    coords.push({ id: Number(place.fk_location), lat: Number(newLoc.latitude), lng: Number(newLoc.longitude) });
    indexMap.push({ type: 'new', existingIndex: null });

    // Ask routing service for matrix (seconds)
    const matrix = await routing.getMatrix(coords.map(c => ({ lat: c.lat, lng: c.lng, id: c.id })));
    // matrix is NxN seconds (integers) or fallback haversine estimates

    // Helper to compute total duration for an order (array of indices into coords)
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

    // Build best order:
    const n = coords.length; // existingCount + 1
    let bestOrder = null;

    if (n <= 8) {
      // Try all permutations (small n)
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
        if (d < bestDur) {
          bestDur = d;
          bestOrder = p;
        }
      }
    } else {
      // Heuristic: keep current existing order, try every insertion position for the new node
      const existingIndices = Array.from({length: n-1}, (_,i) => i); // 0..n-2
      let bestDur = Infinity;
      for (let insertAt = 0; insertAt <= existingIndices.length; insertAt++) {
        // create order: existingIndices with new index (n-1) inserted at insertAt
        const order = existingIndices.slice(0, insertAt).concat([n-1], existingIndices.slice(insertAt));
        const d = totalDuration(order);
        if (d < bestDur) {
          bestDur = d;
          bestOrder = order;
        }
      }
      // Note: this won't reorder existing items, only chooses insertion position (cheap)
    }

    if (!bestOrder) {
      // fallback: append to end
      bestOrder = Array.from({length: n-1}, (_,i) => i).concat([n-1]);
    }

    // Map bestOrder to place objects to insert into DB in that order
    const newDayPlacesToInsert = [];
    for (const idx of bestOrder) {
      const mapEntry = indexMap[idx];
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
        // new place
        newDayPlacesToInsert.push({
          fk_location: Number(place.fk_location),
          date: dateOnly,
          start_hour: place.start_hour || null,
          end_hour: place.end_hour || null,
          notes: place.notes || null
        });
      }
    }

    // Replace only the places for that date atomically: delete then insert in order
    await client.query('DELETE FROM trip_places WHERE fk_trips = $1 AND date::text = $2', [tripId, dateOnly]);

    const insertPlaceSQL =
      'INSERT INTO trip_places (fk_locations, fk_trips, date, start_hour, end_hour, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fk_locations, fk_trips, date, start_hour, end_hour, notes, created_at';

    const created = [];
    for (const p of newDayPlacesToInsert) {
      const r = await client.query(insertPlaceSQL, [
        p.fk_location,
        tripId,
        p.date,
        p.start_hour,
        p.end_hour,
        p.notes
      ]);
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
