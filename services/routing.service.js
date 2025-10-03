// services/routing.service.js
// Computes a travel-time matrix for a list of coordinates.
// - Primary: calls an OSRM-compatible table API (seconds).
// - Fallback: estimate times by haversine / 40 km/h.
//
// This module will attempt to use global.fetch (Node 18+ or environment-provided).
// If not available it tries a dynamic import('undici'). If neither is available,
// it will throw when trying to call OSRM (and fall back to haversine).

'use strict';

let _fetch = null;
let _AbortController = null;
let _fetchInitialized = false;

async function ensureFetch() {
  if (_fetchInitialized) return;
  _fetchInitialized = true;

  // 1) prefer global fetch (Node 18+ or polyfilled)
  if (typeof globalThis.fetch === 'function') {
    _fetch = globalThis.fetch.bind(globalThis);
    _AbortController = typeof globalThis.AbortController === 'function' ? globalThis.AbortController : null;
    return;
  }

  // 2) try dynamic import of undici (works even if undici is ESM-only)
  try {
    const undici = await import('undici');
    if (undici && typeof undici.fetch === 'function') {
      _fetch = undici.fetch.bind(undici);
      _AbortController = undici.AbortController || (typeof globalThis.AbortController === 'function' ? globalThis.AbortController : null);
      return;
    }
  } catch (e) {
    // ignore - undici not available or import failed
  }

  // 3) try to get AbortController from 'abort-controller' package (optional)
  try {
    // require may work for 'abort-controller' if installed
    // not necessary for fetch, just for timeout support if user has that package
    // keep in try/catch so missing package is fine
    // eslint-disable-next-line global-require
    const ac = require('abort-controller');
    if (ac && typeof ac.AbortController === 'function' && !_AbortController) _AbortController = ac.AbortController;
  } catch (e) {
    // ignore
  }

  // If we still have no fetch, leave _fetch null: caller will fall back to haversine.
}

/**
 * fetchWithTimeout - uses AbortController when available, else Promise.race fallback.
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  await ensureFetch();

  if (_fetch === null) {
    // no fetch available in environment — throw to allow callers to fallback
    throw new Error('No fetch implementation available (install undici or use Node 18+)');
  }

  if (_AbortController) {
    const controller = new _AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // copy opts so we don't mutate caller's object
      const o = { ...opts, signal: controller.signal };
      const resp = await _fetch(url, o);
      return resp;
    } finally {
      clearTimeout(id);
    }
  } else {
    // fallback: Promise.race (won't abort underlying request)
    return await Promise.race([
      _fetch(url, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), timeoutMs))
    ]);
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  if ([lat1, lat2, lon1, lon2].some(v => v === null || v === undefined || Number.isNaN(v))) return Number.POSITIVE_INFINITY;
  const toRad = v => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * coords: [{ id, lat, lng }]
 * returns: matrix in seconds (NxN), using OSRM if possible, otherwise haversine estimate
 */
async function getMatrix(coords = []) {
  // If no coords or all coords missing coords, return huge values
  if (!Array.isArray(coords) || coords.length === 0) return [];

  const inf = Number.MAX_SAFE_INTEGER;

  // Build mapping of valid points (OSRM requires valid lat/lng)
  const valid = coords.map((c, i) => ({ ...c, idx: i })).filter(c => c.lat !== null && c.lng !== null && isFinite(c.lat) && isFinite(c.lng));

  // Prepopulate full matrix with infinities
  const fullInit = coords.map(() => coords.map(() => inf));

  if (!valid.length) return fullInit;

  const osrmBase = process.env.OSRM_URL || 'https://router.project-osrm.org';
  const coordStr = valid.map(c => `${c.lng},${c.lat}`).join(';');
  const tableUrl = `${osrmBase}/table/v1/driving/${coordStr}?annotations=duration`;

  try {
    // attempt OSRM call
    const resp = await fetchWithTimeout(tableUrl, { method: 'GET' }, 20000);
    if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
    const body = await resp.json();
    if (!body || !body.durations) throw new Error('OSRM response missing durations');

    // Insert durations into full matrix according to original indices
    const full = coords.map(() => coords.map(() => inf));
    for (let i = 0; i < valid.length; i++) {
      for (let j = 0; j < valid.length; j++) {
        const seconds = body.durations[i][j];
        const origI = valid[i].idx;
        const origJ = valid[j].idx;
        full[origI][origJ] = typeof seconds === 'number' && isFinite(seconds) ? Math.round(seconds) : inf;
      }
    }
    return full;
  } catch (err) {
    // OSRM failed — fallback to haversine estimate (assume 40 km/h)
    const speedMetersPerSec = 40000 / 3600; // 40 km/h
    const fallback = coords.map(a =>
      coords.map(b => {
        if (a.lat === null || b.lat === null) return inf;
        const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
        if (!isFinite(meters)) return inf;
        return Math.max(0, Math.round(meters / speedMetersPerSec));
      })
    );
    console.warn('routing.service: OSRM failed, used haversine fallback:', err?.message || err);
    return fallback;
  }
}

module.exports = { getMatrix };
