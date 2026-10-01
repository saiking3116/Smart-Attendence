// Haversine distance between two lat/lng points, in meters.
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Validates a reported student location against a session's configured classroom
// location + allowed radius. Always computed server-side — never trust a client
// "verified" boolean.
function validateLocation({ studentLat, studentLng, roomLat, roomLng, radiusM }) {
  if (studentLat == null || studentLng == null) {
    return { verified: false, distance: null, reason: 'No location was provided.' };
  }
  if (roomLat == null || roomLng == null) {
    return { verified: false, distance: null, reason: 'This session has no classroom location configured.' };
  }
  const distance = haversineDistanceMeters(studentLat, studentLng, roomLat, roomLng);
  const allowed = radiusM || 100;
  return {
    verified: distance <= allowed,
    distance: Math.round(distance),
    allowed,
    reason: distance <= allowed ? null : `You are ${Math.round(distance)}m from the classroom — outside the ${allowed}m allowed radius.`
  };
}

module.exports = { haversineDistanceMeters, validateLocation };
