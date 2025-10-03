// services/routing.service.js
// Computes a travel-time matrix for a list of coordinates.
// - Primary: calls an OSRM-compatible table API (seconds).
// - Fallback: estimate times by haversine / 40 km/h.

const fetch = require('node-fetch');

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
    const resp = await fetch(tableUrl, { timeout: 20000 }); // 20s
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
