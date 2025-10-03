// services/optimizer.service.js
const { spawnSync } = require('child_process');

/**
 * Utility: format time floats to HH:MM:SS
 */
function hhmmssFromHourFloat(h) {
  const hh = String(Math.floor(h)).padStart(2, '0');
  const mm = String(Math.round((h - Math.floor(h)) * 60)).padStart(2, '0');
  return `${hh}:${mm}:00`;
}

/**
 * Greedy optimizer:
 * - candidates: [{ id,titulo,lat,lng,relevancia,combined_score, ... }]
 * - days: [Date,...]
 * - travelMatrix: optional NxN matrix in seconds (matching the candidates array order)
 * - spec: { visit_default_minutes, daily_hours: {start,end}, max_travel_per_day_minutes, ... }
 * - placesPerDay: optional (if null greedy will estimate)
 *
 * returns: [ { date: 'YYYY-MM-DD', places: [ { id, titulo, start_hour, end_hour, visit_minutes, travel_to_prev_minutes } ] } ]
 */
function haversineMeters(lat1, lon1, lat2, lon2){
  if ([lat1, lat2, lon1, lon2].some(v => v === null || v === undefined || Number.isNaN(v))) return Number.POSITIVE_INFINITY;
  const toRad = v => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R*c;
}

async function greedy({ candidates = [], days = [], travelMatrix = null, spec = {}, placesPerDay = null }) {
  // Defensive copy & sort by combined score high->low
  let pool = (candidates || []).slice();
  pool.sort((a,b) => (b.combined_score || 0) - (a.combined_score || 0));
  const used = new Set();
  const itinerary = [];

  // compute default visit/minutes from spec
  const visitDefault = spec.visit_default_minutes || 90;
  // estimate per-POI minutes including average travel ~30 -> capacity
  const dailyStart = spec.daily_hours?.start || '09:00';
  const dailyEnd = spec.daily_hours?.end || '18:00';
  const startMin = Number(dailyStart.slice(0,2))*60 + Number(dailyStart.slice(3,5) || 0);
  const endMin = Number(dailyEnd.slice(0,2))*60 + Number(dailyEnd.slice(3,5) || 0);
  const dayCapacity = Math.max(60, endMin - startMin);
  const defaultEstimatePerPlace = Math.max(30, Math.min(240, visitDefault + 30)); // visit + travel buffer

  // If placesPerDay not provided, estimate
  const perDay = placesPerDay || Math.max(1, Math.floor(dayCapacity / defaultEstimatePerPlace));

  for (const day of days) {
    if (!pool.length) {
      itinerary.push({ date: day.toISOString().slice(0,10), places: [] });
      continue;
    }
    const dayPlaces = [];

    // seed = highest combined score not used
    const seedIdx = pool.findIndex(p => !used.has(p.id));
    if (seedIdx === -1) { itinerary.push({ date: day.toISOString().slice(0,10), places: [] }); continue; }
    const seed = pool.splice(seedIdx, 1)[0];
    used.add(seed.id);
    dayPlaces.push(seed);

    // add neighbors greedy
    while (dayPlaces.length < perDay && pool.length) {
      const prev = dayPlaces[dayPlaces.length - 1];
      let bestIdx = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        let metric = Number.POSITIVE_INFINITY;
        if (travelMatrix) {
          const idxPrev = candidates.findIndex(x => x.id === prev.id);
          const idxC = candidates.findIndex(x => x.id === c.id);
          if (idxPrev !== -1 && idxC !== -1 && travelMatrix[idxPrev]) {
            const seconds = travelMatrix[idxPrev][idxC];
            metric = (isFinite(seconds) ? seconds : Number.POSITIVE_INFINITY);
          }
        } else if (prev.lat !== null && c.lat !== null) {
          const meters = haversineMeters(prev.lat, prev.lng, c.lat, c.lng);
          metric = meters;
        }
        // tiebreaker: prefer higher combined_score
        metric -= (c.combined_score || 0) * 0.0001;
        if (metric < bestScore) { bestScore = metric; bestIdx = i; }
      }
      if (bestIdx === -1) break;
      const chosen = pool.splice(bestIdx, 1)[0];
      used.add(chosen.id);
      dayPlaces.push(chosen);
    }

    // Assign times for the day in order
    let currentHour = Number(dailyStart.slice(0,2)) + (Number(dailyStart.slice(3,5) || 0)/60);
    const placesWithTimes = dayPlaces.map((loc, idx) => {
      const visitMinutes = spec.visit_default_minutes || visitDefault;
      const start = hhmmssFromHourFloat(currentHour);
      const end = hhmmssFromHourFloat(currentHour + (visitMinutes/60));
      // advance: add visit + small gap (30 min)
      currentHour = currentHour + (visitMinutes / 60) + 0.5;
      return {
        id: loc.id,
        titulo: loc.titulo,
        start_hour: start,
        end_hour: end,
        visit_minutes: visitMinutes,
        travel_to_prev_minutes: idx === 0 ? null : null // we did not compute inline travel minutes here
      };
    });

    itinerary.push({ date: day.toISOString().slice(0,10), places: placesWithTimes });
  }

  return itinerary;
}

/**
 * callOrtools: attempt to call a Python OR-Tools script if available.
 * Expects the script (ORTOOLS_SCRIPT_PATH) to read JSON from stdin and print JSON to stdout.
 * If call fails, returns null.
 */
function callOrtools(candidates, days, travelMatrix, spec, placesPerDay) {
  try {
    const input = JSON.stringify({ candidates, days: days.map(d => d.toISOString().slice(0,10)), travelMatrix, spec, placesPerDay });
    const python = process.env.ORTOOLS_PY_PATH || 'python3';
    const script = process.env.ORTOOLS_SCRIPT_PATH || './ortools_solver.py';
    const res = spawnSync(python, [script], { input, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
    if (res.status !== 0) {
      console.warn('optimizer.callOrtools: process exited non-zero', res.stderr || res.stdout);
      return null;
    }
    const out = res.stdout;
    if (!out) return null;
    return JSON.parse(out);
  } catch (err) {
    console.warn('optimizer.callOrtools failed:', err?.message || err);
    return null;
  }
}

/**
 * generateItinerary: main exported function
 * mode: 'greedy' or 'ortools' (if ortools fails it falls back to greedy)
 */
async function generateItinerary({ mode = 'greedy', candidates = [], days = [], travelMatrix = null, spec = {}, placesPerDay = null }) {
  if (mode === 'ortools') {
    const ort = callOrtools(candidates, days, travelMatrix, spec, placesPerDay);
    if (ort) return ort;
    // if OR-Tools failed, log and fallback
    console.warn('optimizer: OR-Tools returned null, falling back to greedy');
  }
  return greedy({ candidates, days, travelMatrix, spec, placesPerDay });
}

module.exports = { generateItinerary, hhmmssFromHourFloat };
