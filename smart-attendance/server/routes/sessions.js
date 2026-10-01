const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { generateToken } = require('../utils/qr');
const { findOrCreateSession, closeSessionAndMarkAbsent } = require('../utils/sessionAuto');
const { qrGenerateLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(authenticate);

async function getFacultyByUser(userId) {
  return db.get('SELECT * FROM faculty WHERE user_id = ?', [userId]);
}

// Faculty starts (opens) a new session for one of their courses
router.post('/', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  const { course_id, room } = req.body || {};
  const course = await db.get('SELECT * FROM courses WHERE id = ? AND faculty_id = ?', [course_id, faculty.id]);
  if (!course) return res.status(404).json({ error: 'Course not found or not assigned to you.' });

  const session = await findOrCreateSession(course, { room, actorUserId: req.user.id });
  res.json({ session });
}));

// Faculty sets/updates the classroom GPS location + allowed radius for a session
// (typically populated from the faculty device's own browser geolocation).
router.put('/:id/location', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  const session = await db.get('SELECT * FROM class_sessions WHERE id = ? AND faculty_id = ?', [req.params.id, faculty.id]);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  const { latitude, longitude, radius_m } = req.body || {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'latitude and longitude are required.' });
  }
  const radius = Number.isFinite(radius_m) && radius_m > 0 ? Math.round(radius_m) : 100;
  await db.run('UPDATE class_sessions SET room_lat = ?, room_lng = ?, allowed_radius_m = ? WHERE id = ?',
    [latitude, longitude, radius, session.id]);
  await logAudit(req.user.id, 'SESSION_LOCATION_SET', 'class_sessions', session.id, { latitude, longitude, radius });
  res.json({ ok: true, room_lat: latitude, room_lng: longitude, allowed_radius_m: radius });
}));

router.post('/:id/qr', qrGenerateLimiter, authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  const session = await db.get('SELECT * FROM class_sessions WHERE id = ? AND faculty_id = ?', [req.params.id, faculty.id]);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (session.status !== 'open') return res.status(400).json({ error: 'Session is closed. Open it before generating a QR.' });
  const { token, expiresAt, ttl } = generateToken(session.id);
  await db.run('UPDATE class_sessions SET qr_token = ?, qr_expires_at = ? WHERE id = ?', [token, expiresAt, session.id]);
  res.json({ token, expiresAt, ttl, sessionId: session.id });
}));

// Was previously reachable by ANY authenticated faculty/admin for ANY session
// id, with no ownership check at all — fixed here to match every other
// session route's rule: faculty only their own sessions, admin only within
// their own institution.
router.get('/:id/roster', authorize('faculty', 'admin'), asyncHandler(async (req, res) => {
  const session = await db.get('SELECT * FROM class_sessions WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (req.user.role === 'faculty') {
    const faculty = await getFacultyByUser(req.user.id);
    if (!faculty || session.faculty_id !== faculty.id) {
      return res.status(403).json({ error: 'You may only view the roster for your own sessions.' });
    }
  }
  const roster = await db.all(`
    SELECT s.id as student_id, s.roll_number, s.name,
           a.id as attendance_id, a.status, a.method, a.confidence, a.marked_at,
           a.location_verified, a.distance_from_classroom, a.face_verified
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    LEFT JOIN attendance a ON a.session_id = ? AND a.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.roll_number ASC
  `, [session.id, session.course_id]);
  res.json({ session, roster });
}));

router.post('/:id/close', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  const session = await db.get('SELECT * FROM class_sessions WHERE id = ? AND faculty_id = ?', [req.params.id, faculty.id]);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  await closeSessionAndMarkAbsent(session.id, { closedByUserId: req.user.id });
  res.json({ ok: true });
}));

module.exports = router;
