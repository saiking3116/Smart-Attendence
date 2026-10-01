const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateLocation } = require('../utils/geo');
const { isValidDescriptor, verifyFace, MATCH_THRESHOLD } = require('../utils/face');
const { autoCloseExpiredSessions, getCurrentClassForStudent, getSetting } = require('../utils/sessionAuto');
const { recordRiskEvent, getRecentAttemptCount, isOffSchedule, RAPID_ATTEMPT_COUNT } = require('../utils/riskEngine');
const { verifyLimiter, qrScanLimiter } = require('../middleware/rateLimit');

const FACE_CACHE_DAYS = 7;

const router = express.Router();
router.use(authenticate);

async function getStudentByUser(userId) {
  return db.get('SELECT * FROM students WHERE user_id = ?', [userId]);
}

async function getFacultyByUser(userId) {
  return db.get('SELECT * FROM faculty WHERE user_id = ?', [userId]);
}

// Is this student's cached face verification (from a real match within the last
// FACE_CACHE_DAYS) still good, so a fresh camera capture can be skipped?
async function isFaceCacheValid(studentId) {
  const enrollment = await db.get('SELECT last_verified_at FROM face_enrollments WHERE student_id = ?', [studentId]);
  if (!enrollment || !enrollment.last_verified_at) return false;
  const ageMs = Date.now() - Date.parse(enrollment.last_verified_at.replace(' ', 'T') + 'Z');
  return ageMs <= FACE_CACHE_DAYS * 24 * 60 * 60 * 1000;
}

// sessions currently open (or auto-derivable from the timetable right now) that
// this student is enrolled in
router.get('/active', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  await autoCloseExpiredSessions();
  await getCurrentClassForStudent(student); // side effect: materializes today's timetable session, if any
  const sessions = await db.all(`
    SELECT cs.id as session_id, cs.start_time, cs.end_time, cs.room, c.course_name,
           u.name as faculty_name, cs.allowed_radius_m, cs.room_lat, cs.room_lng,
           (cs.room_lat IS NOT NULL AND cs.room_lng IS NOT NULL) as location_required,
           (SELECT status FROM attendance WHERE session_id = cs.id AND student_id = ?) as my_status
    FROM class_sessions cs
    JOIN courses c ON c.id = cs.course_id
    JOIN faculty f ON f.id = cs.faculty_id
    JOIN users u ON u.id = f.user_id
    JOIN enrollments e ON e.course_id = c.id AND e.student_id = ?
    WHERE cs.status = 'open'
    ORDER BY cs.start_time ASC
  `, [student.id, student.id]);
  const faceEnrolled = !!(await db.get('SELECT 1 FROM face_enrollments WHERE student_id = ?', [student.id]));
  const faceVerificationValid = faceEnrolled && (await isFaceCacheValid(student.id));
  res.json({ sessions, faceEnrolled, faceVerificationValid });
}));

async function markAttendance({ student, session, method, confidence, userId, location, face }) {
  // Shared by both call sites below — computed once so a duplicate attempt and a
  // legitimate one aren't counted against each other twice.
  const recentAttempts = await getRecentAttemptCount(student.id);

  const existing = await db.get('SELECT * FROM attendance WHERE student_id = ? AND session_id = ?', [student.id, session.id]);
  if (existing) {
    await logAudit(userId, 'DUPLICATE_ATTEMPT_BLOCKED', 'attendance', session.id, { student: student.roll_number, method });
    await recordRiskEvent({
      institutionId: student.institution_id, studentId: student.id, sessionId: session.id, attendanceId: null, method, outcome: 'rejected',
      signals: { duplicate: true, rapidAttempts: recentAttempts >= RAPID_ATTEMPT_COUNT }
    });
    const err = new Error('Attendance has already been marked for this session.');
    err.code = 'DUPLICATE';
    throw err;
  }
  const loc = location || {};
  const fc = face || {};
  const info = await db.run(`INSERT INTO attendance
      (institution_id, student_id, session_id, status, method, confidence, marked_at,
       latitude, longitude, accuracy, location_verified, distance_from_classroom,
       face_verified, face_distance)
    VALUES (?,?,?,?,?,?, datetime('now'), ?,?,?,?,?, ?,?)`, [
    session.institution_id, student.id, session.id, 'present', method, confidence || null,
    loc.latitude ?? null, loc.longitude ?? null, loc.accuracy ?? null,
    loc.verified ? 1 : 0, loc.distance ?? null,
    fc.matched ? 1 : 0, fc.distance ?? null
  ]);

  const methodLabel = method === 'face' ? 'Face + GPS Verification' : method === 'qr' ? 'QR Code' : 'Demo Verification';
  await db.run(`INSERT INTO notifications (recipient_id, title, message, type) VALUES (?,?,?,?)`, [
    student.user_id, 'Attendance marked successfully',
    `You were marked Present for this session via ${methodLabel}.`,
    'success'
  ]);
  await logAudit(userId, 'ATTENDANCE_MARKED', 'attendance', info.lastInsertRowid, { method, session_id: session.id });

  await recordRiskEvent({
    institutionId: student.institution_id, studentId: student.id, sessionId: session.id, attendanceId: info.lastInsertRowid, method, outcome: 'accepted',
    signals: {
      rapidAttempts: recentAttempts >= RAPID_ATTEMPT_COUNT,
      offSchedule: isOffSchedule(session, new Date()),
      demoMethod: method === 'demo',
      lowFaceConfidence: !!(fc.matched && fc.distance != null && fc.distance >= MATCH_THRESHOLD * 0.75),
      gpsNearBoundary: !!(loc.verified && loc.distance != null && loc.allowed != null && loc.distance >= loc.allowed * 0.85)
    }
  });

  return db.get('SELECT * FROM attendance WHERE id = ?', [info.lastInsertRowid]);
}

// student self check-in: camera-based face verification (real descriptor match) +
// GPS verification, or a plain demo-verification fallback when face-api / camera
// isn't available. Neither the face match nor the location check is trusted from
// the client — both are recomputed here from raw data (descriptor / lat+lng).
router.post('/verify', verifyLimiter, authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  await autoCloseExpiredSessions();
  const { session_id, method, descriptor, latitude, longitude, accuracy } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id is required.' });

  const session = await db.get('SELECT * FROM class_sessions WHERE id = ?', [session_id]);
  if (!session) return res.status(404).json({ error: 'Class session not found.' });
  if (session.status !== 'open') return res.status(400).json({ error: 'This class session is not currently open for check-in.' });

  const enrolled = await db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?', [session.course_id, student.id]);
  if (!enrolled) return res.status(403).json({ error: 'You are not enrolled in this course.' });

  const useMethod = method === 'face' ? 'face' : 'demo';

  // ---- GPS verification (server-computed, never trusts a client "verified" flag) ----
  // The student's device location is always required (proves location services were
  // actually on), but a classroom location to measure distance against is optional
  // metadata, not a prerequisite for attendance — falls back to the app-wide demo
  // campus anchor when this session has none, and if even that isn't configured,
  // the distance/radius check is simply skipped rather than blocking check-in.
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'Location permission is required for attendance.', code: 'GPS_REQUIRED' });
  }
  let roomLat = session.room_lat, roomLng = session.room_lng, radiusM = session.allowed_radius_m;
  if (roomLat == null || roomLng == null) {
    const loc = await getSetting(session.institution_id, 'location_config', null);
    if (loc) { roomLat = loc.lat; roomLng = loc.lng; radiusM = radiusM || loc.radius_m; }
  }
  let locationResult;
  if (roomLat == null || roomLng == null) {
    locationResult = { verified: true, distance: null, allowed: null, reason: null };
  } else {
    locationResult = validateLocation({
      studentLat: latitude, studentLng: longitude,
      roomLat, roomLng, radiusM
    });
    if (!locationResult.verified) {
      await logAudit(req.user.id, 'LOCATION_VERIFICATION_FAILED', 'class_sessions', session.id, { distance: locationResult.distance, allowed: locationResult.allowed });
      await recordRiskEvent({
        institutionId: student.institution_id, studentId: student.id, sessionId: session.id, attendanceId: null, method: useMethod, outcome: 'rejected',
        signals: { locationFailed: true, rapidAttempts: (await getRecentAttemptCount(student.id)) >= RAPID_ATTEMPT_COUNT }
      });
      return res.status(400).json({ error: locationResult.reason, code: 'GPS_OUT_OF_RANGE', distance: locationResult.distance, allowed: locationResult.allowed });
    }
  }

  // ---- Face verification — required once every FACE_CACHE_DAYS, cached after that ----
  let faceResult = null;
  let refreshFaceCache = false;
  if (useMethod === 'face') {
    const enrollment = await db.get('SELECT * FROM face_enrollments WHERE student_id = ?', [student.id]);
    if (!enrollment) {
      return res.status(400).json({ error: 'Face is not enrolled yet. Please enroll your face before using face verification.', code: 'NOT_ENROLLED' });
    }
    const cacheValid = enrollment.last_verified_at != null &&
      (Date.now() - Date.parse(enrollment.last_verified_at.replace(' ', 'T') + 'Z')) <= FACE_CACHE_DAYS * 24 * 60 * 60 * 1000;

    if (descriptor == null) {
      if (!cacheValid) {
        // Not a failure — signals the client to open the camera and resend with a descriptor.
        return res.status(400).json({ error: 'Weekly face verification has expired. Please verify your face.', code: 'FACE_CAPTURE_REQUIRED' });
      }
      faceResult = { distance: null, matched: true, threshold: null, cached: true };
    } else {
      if (!isValidDescriptor(descriptor)) {
        return res.status(400).json({ error: 'Face verification failed — no face detected. Please try again.', code: 'NO_FACE' });
      }
      faceResult = verifyFace(descriptor, JSON.parse(enrollment.descriptor));
      if (!faceResult.matched) {
        await logAudit(req.user.id, 'FACE_VERIFICATION_FAILED', 'attendance', session.id, { distance: faceResult.distance, threshold: faceResult.threshold });
        await recordRiskEvent({
          institutionId: student.institution_id, studentId: student.id, sessionId: session.id, attendanceId: null, method: useMethod, outcome: 'rejected',
          signals: { faceFailed: true, rapidAttempts: (await getRecentAttemptCount(student.id)) >= RAPID_ATTEMPT_COUNT }
        });
        return res.status(400).json({ error: 'Face does not match your enrolled identity.', code: 'FACE_MISMATCH', distance: faceResult.distance });
      }
      refreshFaceCache = true;
    }
  }

  // real, computed similarity percentage — never a random number, and never fabricated for a cached match
  const confidence = faceResult && faceResult.distance != null ? +Math.max(0, (1 - faceResult.distance / 1.0) * 100).toFixed(1) : null;

  try {
    const record = await markAttendance({
      student, session, method: useMethod, confidence, userId: req.user.id,
      location: { latitude, longitude, accuracy, verified: locationResult.verified, distance: locationResult.distance, allowed: locationResult.allowed },
      face: faceResult
    });
    if (refreshFaceCache) {
      await db.run(`UPDATE face_enrollments SET last_verified_at = datetime('now') WHERE student_id = ?`, [student.id]);
    }
    res.json({
      ok: true, record, confidence,
      location: { verified: locationResult.verified, distance: locationResult.distance, accuracy },
      face: faceResult ? { matched: faceResult.matched, distance: faceResult.distance, cached: !!faceResult.cached } : null
    });
  } catch (e) {
    if (e.code === 'DUPLICATE') return res.status(409).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Could not mark attendance. Please try again.' });
  }
}));

// student check-in via scanned QR token
router.post('/qr', qrScanLimiter, authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'QR token is required.' });

  const session = await db.get(`SELECT * FROM class_sessions WHERE qr_token = ?`, [token]);
  if (!session) {
    await recordRiskEvent({
      institutionId: student.institution_id, studentId: student.id, sessionId: null, attendanceId: null, method: 'qr', outcome: 'rejected',
      signals: { qrInvalid: true, rapidAttempts: (await getRecentAttemptCount(student.id)) >= RAPID_ATTEMPT_COUNT }
    });
    return res.status(400).json({ error: 'Invalid or unrecognized QR code.' });
  }
  if (session.status !== 'open') return res.status(400).json({ error: 'This session is closed.' });
  if (!session.qr_expires_at || new Date(session.qr_expires_at) < new Date()) {
    await logAudit(req.user.id, 'EXPIRED_QR_ATTEMPT', 'class_sessions', session.id, {});
    await recordRiskEvent({
      institutionId: student.institution_id, studentId: student.id, sessionId: session.id, attendanceId: null, method: 'qr', outcome: 'rejected',
      signals: { qrExpired: true, rapidAttempts: (await getRecentAttemptCount(student.id)) >= RAPID_ATTEMPT_COUNT }
    });
    return res.status(400).json({ error: 'This QR code has expired. Ask your faculty to refresh it.' });
  }
  const enrolled = await db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?', [session.course_id, student.id]);
  if (!enrolled) return res.status(403).json({ error: 'You are not enrolled in this course.' });

  try {
    const record = await markAttendance({ student, session, method: 'qr', confidence: null, userId: req.user.id });
    res.json({ ok: true, record });
  } catch (e) {
    if (e.code === 'DUPLICATE') return res.status(409).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Could not mark attendance. Please try again.' });
  }
}));

// faculty manual toggle / override for a roster row (creates the row if it does not exist yet).
// Faculty may only touch the CURRENT (open) session for a course they teach —
// admin remains an unrestricted superuser, consistent with every other resource
// in this app (courses, users).
router.put('/:id', authorize('faculty', 'admin'), asyncHandler(async (req, res) => {
  const { status, student_id, session_id } = req.body || {};
  if (!['present', 'absent'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  // Every branch below is scoped to the caller's own institution — an admin
  // here is an institution admin, not a global superuser; cross-institution
  // access (if ever needed) belongs on a dedicated super_admin surface, not
  // this route.
  let record;
  let targetSessionId = session_id;
  if (req.params.id && req.params.id !== 'new') {
    record = await db.get('SELECT * FROM attendance WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
    if (!record) return res.status(404).json({ error: 'Attendance record not found.' });
    targetSessionId = record.session_id;
  } else if (!student_id || !session_id) {
    return res.status(400).json({ error: 'student_id and session_id are required.' });
  }

  const session = await db.get('SELECT * FROM class_sessions WHERE id = ? AND institution_id = ?', [targetSessionId, req.user.institution_id]);
  if (!session) return res.status(404).json({ error: 'Class session not found.' });
  if (req.user.role === 'faculty') {
    const faculty = await getFacultyByUser(req.user.id);
    if (!faculty || session.faculty_id !== faculty.id) {
      return res.status(403).json({ error: 'You may only edit attendance for your own sessions.' });
    }
    if (session.status !== 'open') {
      return res.status(403).json({ error: 'This session has closed. Only the current session can be edited.' });
    }
  }

  if (record) {
    await db.run('UPDATE attendance SET status=?, method=?, marked_at=datetime(\'now\'), remarks=? WHERE id=?',
      [status, 'manual', 'Manually overridden by faculty', record.id]);
  } else {
    const existing = await db.get('SELECT * FROM attendance WHERE student_id=? AND session_id=?', [student_id, session_id]);
    if (existing) {
      await db.run('UPDATE attendance SET status=?, method=?, marked_at=datetime(\'now\'), remarks=? WHERE id=?',
        [status, 'manual', 'Manually overridden by faculty', existing.id]);
      record = existing;
    } else {
      const info = await db.run(`INSERT INTO attendance (institution_id, student_id, session_id, status, method, marked_at, remarks) VALUES (?,?,?,?,'manual',datetime('now'),'Manually recorded by faculty')`,
        [req.user.institution_id, student_id, session_id, status]);
      record = { id: info.lastInsertRowid };
    }
  }
  await logAudit(req.user.id, 'ATTENDANCE_MANUAL_OVERRIDE', 'attendance', record.id, { status });
  res.json({ ok: true, id: record.id });
}));

module.exports = router;
