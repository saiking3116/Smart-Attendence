// Compares 128-dimensional face descriptors produced client-side by face-api.js.
// Lower euclidean distance = more similar. face-api.js's own examples use 0.6
// as the standard "same person" threshold — we use the same convention here.
const MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.6');
const EXPECTED_LENGTH = 128;

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function isValidDescriptor(d) {
  return Array.isArray(d) && d.length === EXPECTED_LENGTH && d.every(n => typeof n === 'number' && Number.isFinite(n));
}

// Averages several enrollment-time descriptors into one reference descriptor.
function averageDescriptors(list) {
  const len = list[0].length;
  const out = new Array(len).fill(0);
  for (const d of list) for (let i = 0; i < len; i++) out[i] += d[i];
  return out.map(v => v / list.length);
}

function verifyFace(liveDescriptor, enrolledDescriptor) {
  const distance = euclideanDistance(liveDescriptor, enrolledDescriptor);
  return { distance, matched: distance <= MATCH_THRESHOLD, threshold: MATCH_THRESHOLD };
}

module.exports = { euclideanDistance, isValidDescriptor, averageDescriptors, verifyFace, MATCH_THRESHOLD, EXPECTED_LENGTH };
