const db = require('../db');

// Transparent, additive rule-based scoring — NOT a fraud-proof AI detector. Every
// point on the score maps to one named, human-readable reason, and the caller
// (attendance.js) always makes its accept/reject decision BEFORE this runs; this
// module only ever records what happened, it never blocks an attempt.
const SIGNAL_WEIGHTS = [
  ['faceFailed', 30, 'Face verification failed'],
  ['locationFailed', 30, 'Location verification failed (outside allowed radius)'],
  ['qrExpired', 25, 'Expired QR code used'],
  ['qrInvalid', 20, 'Invalid or unrecognized QR code'],
  ['duplicate', 20, 'Duplicate attendance attempt for this session'],
  ['rapidAttempts', 20, 'Multiple rapid attendance attempts in a short time'],
  ['offSchedule', 15, 'Attendance attempted outside the scheduled session time'],
  ['lowFaceConfidence', 10, 'Face match confidence was low (near the threshold)'],
  ['gpsNearBoundary', 10, 'Location was near the edge of the allowed radius'],
  ['demoMethod', 10, 'Marked using fallback demo verification (no camera/GPS proof)'],
];

const HIGH_THRESHOLD = 60;
const MEDIUM_THRESHOLD = 30;
const RAPID_WINDOW_MINUTES = 10;
const RAPID_ATTEMPT_COUNT = 3;

function evaluateSignals(signals) {
  let score = 0;
  const reasons = [];
  for (const [key, weight, reason] of SIGNAL_WEIGHTS) {
    if (signals[key]) { score += weight; reasons.push(reason); }
  }
  score = Math.min(100, score);
  const level = score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';
  return { score, level, reasons };
}

// How many attendance attempts (accepted or rejected) this student has made,
// across any session, in the last RAPID_WINDOW_MINUTES — the basis for the
// "multiple rapid attendance attempts" signal.
async function getRecentAttemptCount(studentId, windowMinutes = RAPID_WINDOW_MINUTES) {
  const row = await db.get(`
    SELECT COUNT(*) c FROM risk_events
    WHERE student_id = ? AND created_at >= datetime('now', ?)
  `, [studentId, `-${windowMinutes} minutes`]);
  return Number(row.c);
}

// Was `nowDate` (a real Date) outside the session's scheduled window, allowing a
// small grace period on both ends? Sessions with no start/end recorded (rare,
// faculty-opened ad-hoc sessions) are never flagged — there's nothing to compare against.
function isOffSchedule(session, nowDate, graceMinutes = 15) {
  if (!session.start_time) return false;
  const hhmm = nowDate.toTimeString().slice(0, 5);
  const addMinutes = (time, mins) => {
    const [h, m] = time.split(':').map(Number);
    const total = h * 60 + m + mins;
    const wrapped = ((total % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  const earliestOk = addMinutes(session.start_time, -graceMinutes);
  if (hhmm < earliestOk) return true;
  if (session.end_time) {
    const latestOk = addMinutes(session.end_time, graceMinutes);
    if (hhmm > latestOk) return true;
  }
  return false;
}

async function recordRiskEvent({ institutionId, studentId, sessionId, attendanceId, method, outcome, signals }) {
  const { score, level, reasons } = evaluateSignals(signals);
  await db.run(`
    INSERT INTO risk_events (institution_id, student_id, session_id, attendance_id, method, outcome, score, level, reasons)
    VALUES (?,?,?,?,?,?,?,?,?)
  `, [institutionId, studentId, sessionId ?? null, attendanceId ?? null, method || null, outcome, score, level, JSON.stringify(reasons)]);
  return { score, level, reasons };
}

module.exports = {
  evaluateSignals, recordRiskEvent, getRecentAttemptCount, isOffSchedule,
  RAPID_WINDOW_MINUTES, RAPID_ATTEMPT_COUNT, HIGH_THRESHOLD, MEDIUM_THRESHOLD, SIGNAL_WEIGHTS
};
