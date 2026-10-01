const db = require('../db');
const { logAudit } = require('../middleware/auth');
const { CSE_ROOM_BY_COURSE_CODE } = require('./timetableDemo');
const { THRESHOLD } = require('./analytics');
const { notifyLowAttendance } = require('./notificationService');

/* ---------------- app_settings (generic key/value store) ---------------- */
// Batch 6: every setting here (location config, LMS state, retention config)
// is institution-specific, but the app_settings table itself is untouched —
// its PRIMARY KEY is still the bare `key` TEXT column. Isolation instead comes
// from namespacing the key string itself as "<institutionId>:<key>", so
// Institution A and B can never read or overwrite each other's settings even
// though they share one table. institutionId is required (no default) so a
// caller can never accidentally fall back to a shared/global setting.

function settingKey(institutionId, key) {
  if (institutionId == null) throw new Error('getSetting/setSetting require an institutionId.');
  return `${institutionId}:${key}`;
}

async function getSetting(institutionId, key, fallback = null) {
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [settingKey(institutionId, key)]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

async function setSetting(institutionId, key, valueObj) {
  const value = JSON.stringify(valueObj);
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, [settingKey(institutionId, key), value]);
}

/* ---------------- session lifecycle ---------------- */

// Finds today's already-open session for this course, or creates one. Reused by
// both the faculty-manual "start session" route and the automatic timetable-driven
// path, so a location/end-time backfill applied here benefits every session no
// matter how it was opened — a manually-started "special case" session must be
// just as GPS-capable as an automatic one, or mandatory GPS becomes unsatisfiable
// for it.
async function findOrCreateSession(course, { room, endTime, actorUserId } = {}) {
  if (!course.faculty_id) return null; // course has no assigned faculty — nothing to attach the session to

  const today = new Date().toISOString().slice(0, 10);
  const loc = await getSetting(course.institution_id, 'location_config', null);

  let session = await db.get(`SELECT * FROM class_sessions WHERE course_id = ? AND date = ? AND status = 'open'`, [course.id, today]);

  if (!session) {
    const startTime = new Date().toTimeString().slice(0, 5);
    const info = await db.run(`
      INSERT INTO class_sessions (institution_id, course_id, faculty_id, date, start_time, end_time, room, status, room_lat, room_lng, allowed_radius_m)
      VALUES (?,?,?,?,?,?,?,'open',?,?,?)
    `, [
      course.institution_id, course.id, course.faculty_id, today, startTime, endTime || null, room || 'CS-204',
      loc ? loc.lat : null, loc ? loc.lng : null, loc ? loc.radius_m : 100
    ]);
    session = await db.get('SELECT * FROM class_sessions WHERE id = ?', [info.lastInsertRowid]);
    await logAudit(actorUserId || null, 'SESSION_OPENED', 'class_sessions', session.id, { course: course.course_name, auto: !actorUserId });
    return session;
  }

  // Reusing an already-open session: backfill location/end-time if still missing,
  // but never overwrite a value that's already set (e.g. faculty already ran
  // "Set classroom location" manually for this exact session).
  const needsLocation = session.room_lat == null && loc;
  const needsEndTime = session.end_time == null && endTime;
  if (needsLocation || needsEndTime) {
    const room_lat = needsLocation ? loc.lat : session.room_lat;
    const room_lng = needsLocation ? loc.lng : session.room_lng;
    const allowed_radius_m = needsLocation ? loc.radius_m : session.allowed_radius_m;
    const finalEndTime = needsEndTime ? endTime : session.end_time;
    await db.run(`UPDATE class_sessions SET room_lat=?, room_lng=?, allowed_radius_m=?, end_time=? WHERE id=?`,
      [room_lat, room_lng, allowed_radius_m, finalEndTime, session.id]);
    session = await db.get('SELECT * FROM class_sessions WHERE id = ?', [session.id]);
  }
  return session;
}

// Marks every enrolled student without an attendance row for this session absent,
// then closes it. Idempotent — closing an already-closed session is a no-op.
async function closeSessionAndMarkAbsent(sessionId, { closedByUserId } = {}) {
  const session = await db.get('SELECT * FROM class_sessions WHERE id = ?', [sessionId]);
  if (!session || session.status !== 'open') return session;

  const enrolled = await db.all('SELECT student_id FROM enrollments WHERE course_id = ?', [session.course_id]);
  const nowHHMM = new Date().toTimeString().slice(0, 5);

  // Track which students were ACTUALLY newly marked absent by this call (not
  // just "enrolled") — INSERT OR IGNORE silently no-ops for anyone who already
  // has a present/late row, and only a fresh absence is worth a low-attendance check.
  const newlyAbsentStudentIds = [];
  await db.transaction(async () => {
    for (const r of enrolled) {
      const info = await db.run(`
        INSERT OR IGNORE INTO attendance (institution_id, student_id, session_id, status, method, marked_at)
        VALUES (?,?,?,'absent','manual', datetime('now'))
      `, [session.institution_id, r.student_id, session.id]);
      if (info.changes > 0) newlyAbsentStudentIds.push(r.student_id);
    }
    // COALESCE preserves a pre-set scheduled end_time (auto-created sessions already
    // know when they should end) instead of overwriting with whenever this happened to run.
    await db.run(`UPDATE class_sessions SET status='closed', end_time=COALESCE(end_time, ?), qr_token=NULL WHERE id=?`,
      [nowHHMM, session.id]);
  });

  await logAudit(closedByUserId || null, 'SESSION_CLOSED', 'class_sessions', session.id, { auto: !closedByUserId });

  // Fire-and-forget: an email failure here must never affect session closing,
  // which has already fully committed above.
  for (const studentId of newlyAbsentStudentIds) {
    checkAndNotifyLowAttendance(studentId, session.course_id).catch(err => console.error('[email] low-attendance check failed:', err.message));
  }

  return db.get('SELECT * FROM class_sessions WHERE id = ?', [session.id]);
}

async function checkAndNotifyLowAttendance(studentId, courseId) {
  const info = await db.get(`
    SELECT s.name, u.id as user_id, u.email, c.course_name
    FROM students s
    JOIN users u ON u.id = s.user_id
    JOIN courses c ON c.id = ?
    WHERE s.id = ?
  `, [courseId, studentId]);
  if (!info || !info.email) return;

  // Same excuse-aware rule as every other percentage in this app (utils/reports.js,
  // utils/analytics.js): an approved excuse is excluded from the denominator, never
  // counted as present.
  const rows = await db.all(`
    SELECT a.status, ex.id as excuse_id
    FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    LEFT JOIN student_excuses ex ON ex.student_id = a.student_id AND ex.session_id = a.session_id AND ex.status = 'approved'
    WHERE a.student_id = ? AND cs.course_id = ? AND cs.status != 'open'
  `, [studentId, courseId]);
  const counted = rows.filter(r => !(r.status === 'absent' && r.excuse_id != null));
  const total = counted.length;
  if (!total) return;
  const present = counted.filter(r => r.status === 'present' || r.status === 'late').length;
  const pct = Math.round((present / total) * 100);
  if (pct >= THRESHOLD) return;

  await notifyLowAttendance({
    user: { id: info.user_id, name: info.name, email: info.email },
    courseName: info.course_name, pct, threshold: THRESHOLD
  });
}

// Lazily closes any session whose scheduled end has passed. Only sessions with a
// populated end_time are ever matched, so faculty-opened "special case" sessions
// for courses with no timetable slot (end_time stays NULL until manually closed)
// are correctly left alone.
async function autoCloseExpiredSessions(facultyId = null) {
  const today = new Date().toISOString().slice(0, 10);
  const nowHHMM = new Date().toTimeString().slice(0, 5);
  const clauses = [`status = 'open'`, `date = ?`, `end_time IS NOT NULL`, `end_time <= ?`];
  const params = [today, nowHHMM];
  if (facultyId) { clauses.push('faculty_id = ?'); params.push(facultyId); }
  const rows = await db.all(`SELECT id FROM class_sessions WHERE ${clauses.join(' AND ')}`, params);
  for (const r of rows) await closeSessionAndMarkAbsent(r.id);
  return rows.length;
}

/* ---------------- timetable-driven lookup ---------------- */

// Two institutions may have different (or coincidentally identical) holiday
// calendars — always scoped, never a shared/global calendar.
async function isHoliday(institutionId, dateStr) {
  return !!(await db.get('SELECT 1 FROM holidays WHERE holiday_date = ? AND institution_id = ?', [dateStr, institutionId]));
}

// Resolves the student's current class (if any) from the timetable, and ensures
// the corresponding session exists — this is what makes attendance automatic.
// Never materializes a session on a declared holiday (no timetable slot lookup
// even runs) — this only suppresses the AUTOMATIC path; a faculty member can
// still deliberately open a manual session on a holiday date if they choose to
// (e.g. a scheduled makeup class), since that route doesn't call this function.
async function getCurrentClassForStudent(student) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const hhmm = now.toTimeString().slice(0, 5);
  const today = now.toISOString().slice(0, 10);
  if (await isHoliday(student.institution_id, today)) return null;

  const slot = await db.get(`
    SELECT * FROM timetable_slots
    WHERE institution_id = ? AND department = ? AND section = ? AND day_of_week = ?
      AND period_type = 'class' AND course_id IS NOT NULL
      AND start_time <= ? AND end_time > ?
    ORDER BY start_time ASC LIMIT 1
  `, [student.institution_id, student.department, student.section, dayOfWeek, hhmm, hhmm]);
  if (!slot) return null;

  const course = await db.get(`SELECT * FROM courses WHERE id = ? AND status = 'active' AND institution_id = ?`, [slot.course_id, student.institution_id]);
  if (!course) return null;

  const enrolled = await db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?', [course.id, student.id]);
  if (!enrolled) return null;

  return findOrCreateSession(course, { endTime: slot.end_time });
}

async function getTodaysTimetable(institutionId, department, section) {
  const dayOfWeek = new Date().getDay();
  const hhmm = new Date().toTimeString().slice(0, 5);
  const rows = await db.all(`
    SELECT ts.id, ts.start_time, ts.end_time, ts.period_type, ts.label, ts.course_id, c.course_name
    FROM timetable_slots ts LEFT JOIN courses c ON c.id = ts.course_id
    WHERE ts.institution_id = ? AND ts.department = ? AND ts.section = ? AND ts.day_of_week = ?
    ORDER BY ts.start_time ASC
  `, [institutionId, department, section, dayOfWeek]);
  return rows.map(r => ({ ...r, isCurrent: r.start_time <= hhmm && hhmm < r.end_time }));
}

// Full Mon-Fri grid for a department/section straight from timetable_slots (only
// populated for "III CSE - B" today — other departments fall back to the static
// demo grid in timetableDemo.js when this returns empty). Used by the Timetable
// workspace; unrelated to attendance-session creation.
async function getWeeklyTimetable(institutionId, department, section) {
  const rows = await db.all(`
    SELECT ts.day_of_week, ts.start_time, ts.end_time, ts.period_type, ts.label,
           ts.course_id, c.course_name, c.course_code, u.name as faculty_name
    FROM timetable_slots ts
    LEFT JOIN courses c ON c.id = ts.course_id
    LEFT JOIN faculty f ON f.id = c.faculty_id
    LEFT JOIN users u ON u.id = f.user_id
    WHERE ts.institution_id = ? AND ts.department = ? AND ts.section = ? AND ts.day_of_week BETWEEN 1 AND 6
    ORDER BY ts.day_of_week ASC, ts.start_time ASC
  `, [institutionId, department, section]);
  return rows.map(r => ({ ...r, room: r.course_code ? (CSE_ROOM_BY_COURSE_CODE[r.course_code] || null) : null }));
}

module.exports = {
  getSetting, setSetting,
  findOrCreateSession, closeSessionAndMarkAbsent, autoCloseExpiredSessions,
  getCurrentClassForStudent, getTodaysTimetable, getWeeklyTimetable, isHoliday
};
