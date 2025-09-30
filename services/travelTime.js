// services/travelTime.js
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * estimateTravelMinutes: fallback estimate using walking/driving speed.
 * mode: 'walk'|'drive' (driving faster)
 */
function estimateTravelMinutes(lat1, lon1, lat2, lon2, mode = 'drive') {
  const meters = haversineMeters(lat1, lon1, lat2, lon2);
  const speed_m_per_min = mode === 'walk' ? 80 : 800; // 80m/min ~ 4.8km/h, 800m/min ~48km/h
  const minutes = Math.max(5, Math.round(meters / speed_m_per_min));
  return minutes;
}

module.exports = { haversineMeters, estimateTravelMinutes };
