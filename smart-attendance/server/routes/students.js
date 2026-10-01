const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { studentAttendanceSummary, classesNeededFor75, riskLevel, studentInsights, THRESHOLD, attendanceStatusLabel, predictionText, getStudentAttendanceRows } = require('../utils/analytics');
const { predictRisk } = require('../utils/attendancePrediction');
const { toCSV } = require('../utils/exportUtils');
const { isValidDescriptor, averageDescriptors, EXPECTED_LENGTH } = require('../utils/face');
const { autoCloseExpiredSessions, getTodaysTimetable, getWeeklyTimetable } = require('../utils/sessionAuto');
const { buildDemoWeekGrid } = require('../utils/timetableDemo');
const { buildWeeklyReport } = require('../utils/reports');
const { getEligibleSessions, fetchExcuses } = require('../utils/excuses');
const { excuseLimiter } = require('../middleware/rateLimit');
const { notifyExcuseSubmitted, notifyWeeklyReport } = require('../utils/notificationService');

const router = express.Router();

async function getStudentByUser(userId) {
  return db.get('SELECT * FROM students WHERE user_id = ?', [userId]);
}

router.use(authenticate);

router.get('/dashboard', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  await autoCloseExpiredSessions();

  const summary = await studentAttendanceSummary(student.id);
  const need = classesNeededFor75(summary.totalPresent, summary.totalClasses);

  const today = new Date().toISOString().slice(0, 10);
  const todaysClasses = await db.all(`
    SELECT cs.id as session_id, cs.start_time, cs.end_time, cs.room, cs.status as session_status,
           c.course_name, u.name as faculty_name,
           (SELECT status FROM attendance WHERE session_id = cs.id AND student_id = ?) as my_status
    FROM class_sessions cs
    JOIN courses c ON c.id = cs.course_id
    JOIN faculty f ON f.id = cs.faculty_id
    JOIN users u ON u.id = f.user_id
    JOIN enrollments e ON e.course_id = c.id AND e.student_id = ?
    WHERE cs.date = ?
    ORDER BY cs.start_time ASC
  `, [student.id, student.id, today]);

  const recent = await db.all(`
    SELECT a.status, a.method, a.confidence, a.marked_at, c.course_name, cs.date
    FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    JOIN courses c ON c.id = cs.course_id
    WHERE a.student_id = ?
    ORDER BY cs.date DESC, a.marked_at DESC
    LIMIT 6
  `, [student.id]);

  // weekly trend: attendance % per ISO week for this student, last 8 weeks
  const trendRows = await db.all(`
    SELECT strftime('%Y-%W', cs.date) as wk, a.status
    FROM attendance a JOIN class_sessions cs ON cs.id = a.session_id
    WHERE a.student_id = ? AND cs.status != 'open'
    ORDER BY cs.date ASC
  `, [student.id]);
  const weekMap = {};
  for (const r of trendRows) {
    if (!weekMap[r.wk]) weekMap[r.wk] = { total: 0, present: 0 };
    weekMap[r.wk].total++;
    if (r.status !== 'absent') weekMap[r.wk].present++;
  }
  const weeks = Object.keys(weekMap).sort().slice(-8);
  const trend = weeks.map(w => Math.round((weekMap[w].present / weekMap[w].total) * 100));
  const trendLabels = weeks.map((_, i) => `W${i + 1}`);

  const unreadRow = await db.get('SELECT COUNT(*) c FROM notifications WHERE recipient_id = ? AND read = FALSE', [req.user.id]);
  const unreadCount = Number(unreadRow.c);

  const [insights, todaysTimetable, riskPrediction] = await Promise.all([
    studentInsights(student.id),
    getTodaysTimetable(student.institution_id, student.department, student.section),
    getStudentAttendanceRows(student.id).then(rows => predictRisk(rows)),
  ]);

  res.json({
    student: { name: student.name, roll: student.roll_number, department: student.department, section: student.section },
    overall: summary.overall,
    eligible: summary.overall >= THRESHOLD,
    threshold: THRESHOLD,
    subjects: summary.subjects,
    todaysClasses,
    recent,
    trend, trendLabels,
    classesNeededFor75: need,
    risk: riskLevel(summary.overall),
    insights,
    unreadNotifications: unreadCount,
    todaysTimetable,
    classesAttended: summary.totalPresent,
    classesMissed: summary.totalClasses - summary.totalPresent,
    classesExcused: summary.totalExcused,
    attendanceStatus: attendanceStatusLabel(summary.overall),
    prediction: predictionText(summary.totalPresent, summary.totalClasses),
    // Batch 5 — Predictive Attendance Model. Read-only decision support: never
    // marks/modifies/deletes attendance. Reuses classesNeededFor75 internally.
    riskPrediction
  });
}));

// Batch 5 — course-level predictions, one entry per enrolled course. Reuses
// the same predictRisk() scoring as the overall dashboard card.
router.get('/predictions/courses', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const courses = await db.all(`
    SELECT c.id, c.course_name, c.course_code FROM enrollments e JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = ? ORDER BY c.course_name ASC
  `, [student.id]);
  const rows = await Promise.all(courses.map(async (c) => ({
    courseId: c.id, courseName: c.course_name, courseCode: c.course_code,
    ...predictRisk(await getStudentAttendanceRows(student.id, c.id))
  })));
  res.json({ rows });
}));

// Feature 2 — Weekly Reports: this student's own week, with a prior-week
// comparison. Read-only, same underlying aggregator as admin/faculty weekly
// reports, scoped to this student only.
router.get('/reports/weekly', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  await autoCloseExpiredSessions();
  const report = await buildWeeklyReport(student.institution_id, { student_id: student.id }, req.query.week);
  res.json(report);
}));

// Self-service: email me my own weekly report now. Reuses buildWeeklyReport —
// no separate calculation exists for the emailed version.
router.post('/reports/weekly/email', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const report = await buildWeeklyReport(student.institution_id, { student_id: student.id }, req.query.week);
  const result = await notifyWeeklyReport({ user: { id: req.user.id, name: student.name, email: req.user.email }, report });
  res.json({ ok: result.ok, mode: result.mode });
}));

/* ---------------- Feature: Student Excuse System ---------------- */
router.get('/excuses/eligible-sessions', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  res.json({ rows: await getEligibleSessions(student.id) });
}));

router.get('/excuses', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  res.json({ rows: await fetchExcuses('WHERE ex.student_id = ?', [student.id]) });
}));

router.post('/excuses', excuseLimiter, authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const { session_id, reason, details } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id is required.' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required.' });

  // A student may only request an excuse for a session belonging to a course
  // they are actually enrolled in — never trust the client-supplied session_id
  // beyond looking up its real course and checking enrollment server-side.
  const session = await db.get('SELECT * FROM class_sessions WHERE id = ?', [session_id]);
  if (!session) return res.status(404).json({ error: 'Class session not found.' });
  if (session.status === 'open') return res.status(400).json({ error: 'This session has not finished yet.' });
  const enrolled = await db.get('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?', [session.course_id, student.id]);
  if (!enrolled) return res.status(403).json({ error: 'You are not enrolled in this course.' });

  const existing = await db.get('SELECT 1 FROM student_excuses WHERE student_id = ? AND session_id = ?', [student.id, session_id]);
  if (existing) return res.status(409).json({ error: 'You have already submitted an excuse request for this session.' });

  const info = await db.run(`
    INSERT INTO student_excuses (institution_id, student_id, session_id, course_id, reason, details)
    VALUES (?,?,?,?,?,?)
  `, [student.institution_id, student.id, session_id, session.course_id, reason.trim(), (details || '').trim() || null]);
  await logAudit(req.user.id, 'EXCUSE_SUBMITTED', 'student_excuses', info.lastInsertRowid, { session_id, course_id: session.course_id });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });

  // Fire-and-forget — the request has already been recorded and responded to
  // above; an email hiccup here must never surface as an excuse-submission failure.
  const notifyInfo = await db.get(`
    SELECT c.course_name, u.id as faculty_user_id, u.name as faculty_name, u.email as faculty_email
    FROM courses c JOIN faculty f ON f.id = c.faculty_id JOIN users u ON u.id = f.user_id
    WHERE c.id = ?
  `, [session.course_id]);
  if (notifyInfo) {
    notifyExcuseSubmitted({
      facultyUser: { id: notifyInfo.faculty_user_id, name: notifyInfo.faculty_name, email: notifyInfo.faculty_email },
      studentName: student.name, courseName: notifyInfo.course_name, sessionDate: session.date, reason: reason.trim()
    }).catch(err => console.error('[email] excuse-submitted notify failed:', err.message));
  }
}));

// Separate Timetable workspace — read-only schedule view, never creates any
// class_sessions or attendance rows. Marking attendance still goes through the
// existing /api/attendance/active + /api/attendance/verify flow untouched.
router.get('/timetable', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });

  const now = new Date();
  const dayOfWeek = now.getDay();
  const hhmm = now.toTimeString().slice(0, 5);

  // Departments with a curated multi-subject demo grid always use it (their real
  // timetable_slots rows, where present, just repeat that department's one seeded
  // course all day and would look unrealistic in a schedule view). Only a
  // department with no curated grid — currently just CSE — falls back to whatever
  // is actually in timetable_slots, which for CSE is the real Mon-Fri grid wired
  // to the live attendance demo.
  let week = buildDemoWeekGrid(student.department);
  let source = 'demo';
  if (!week.length) {
    week = await getWeeklyTimetable(student.institution_id, student.department, student.section);
    source = 'live';
  }

  week = week.map(row => {
    let status = null;
    if (row.day_of_week === dayOfWeek) {
      if (hhmm < row.start_time) status = 'upcoming';
      else if (hhmm >= row.end_time) status = 'completed';
      else status = 'ongoing';
    }
    return { ...row, status };
  });

  const todayDate = now.toISOString().slice(0, 10);
  const todayHoliday = (await db.get('SELECT name, description FROM holidays WHERE holiday_date = ? AND institution_id = ?', [todayDate, student.institution_id])) || null;

  res.json({
    department: student.department,
    section: student.section,
    source,
    dayOfWeek,
    today: week.filter(row => row.day_of_week === dayOfWeek),
    week,
    todayHoliday
  });
}));

router.get('/attendance', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  await autoCloseExpiredSessions();

  const { subject, status, method, from, to, page = 1, pageSize = 20 } = req.query;
  const clauses = ['a.student_id = ?', "cs.status != 'open'"];
  const params = [student.id];
  if (subject) { clauses.push('c.course_name = ?'); params.push(subject); }
  if (status) { clauses.push('a.status = ?'); params.push(status.toLowerCase()); }
  if (method) { clauses.push('a.method = ?'); params.push(method.toLowerCase()); }
  if (from) { clauses.push('cs.date >= ?'); params.push(from); }
  if (to) { clauses.push('cs.date <= ?'); params.push(to); }
  const where = clauses.join(' AND ');

  const totalRow = await db.get(`
    SELECT COUNT(*) c FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN courses c ON c.id=cs.course_id
    WHERE ${where}`, params);
  const total = Number(totalRow.c);

  const limit = Math.min(parseInt(pageSize) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;

  const rows = await db.all(`
    SELECT a.id, cs.date, c.course_name as subject, a.status, a.method, a.confidence, a.marked_at
    FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    JOIN courses c ON c.id = cs.course_id
    WHERE ${where}
    ORDER BY cs.date DESC, a.marked_at DESC
    LIMIT ? OFFSET ?`, [...params, limit, offset]);

  res.json({ rows, total, page: parseInt(page) || 1, pageSize: limit });
}));

router.get('/export', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  await autoCloseExpiredSessions();
  const { from, to } = req.query;
  const clauses = ["a.student_id = ?", "cs.status != 'open'"];
  const params = [student.id];
  if (from) { clauses.push('cs.date >= ?'); params.push(from); }
  if (to) { clauses.push('cs.date <= ?'); params.push(to); }
  const rows = await db.all(`
    SELECT cs.date, c.course_name as subject, a.status, a.method, a.marked_at
    FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN courses c ON c.id=cs.course_id
    WHERE ${clauses.join(' AND ')} ORDER BY cs.date DESC`, params);
  const csv = toCSV(rows, ['date', 'subject', 'status', 'method', 'marked_at']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${student.roll_number}.csv"`);
  res.send(csv);
  await logAudit(req.user.id, 'EXPORT_CSV', 'attendance', null, { rows: rows.length });
}));

/* ---------------- Face enrollment ---------------- */
router.get('/face/status', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const row = await db.get('SELECT sample_count, updated_at FROM face_enrollments WHERE student_id = ?', [student.id]);
  res.json({ enrolled: !!row, sampleCount: row ? row.sample_count : 0, updatedAt: row ? row.updated_at : null });
}));

router.post('/face/enroll', authorize('student'), asyncHandler(async (req, res) => {
  const student = await getStudentByUser(req.user.id);
  if (!student) return res.status(404).json({ error: 'Student profile not found.' });
  const { descriptors } = req.body || {};
  if (!Array.isArray(descriptors) || descriptors.length < 3) {
    return res.status(400).json({ error: 'At least 3 face samples are required to enroll.' });
  }
  const invalid = descriptors.some(d => !isValidDescriptor(d));
  if (invalid) {
    return res.status(400).json({ error: `Each sample must be a ${EXPECTED_LENGTH}-value face descriptor. Please try enrolling again.` });
  }

  const averaged = averageDescriptors(descriptors);
  const existing = await db.get('SELECT id FROM face_enrollments WHERE student_id = ?', [student.id]);
  if (existing) {
    await db.run(`UPDATE face_enrollments SET descriptor = ?, sample_count = ?, updated_at = datetime('now') WHERE student_id = ?`,
      [JSON.stringify(averaged), descriptors.length, student.id]);
  } else {
    await db.run(`INSERT INTO face_enrollments (student_id, descriptor, sample_count) VALUES (?,?,?)`,
      [student.id, JSON.stringify(averaged), descriptors.length]);
  }
  await db.run('UPDATE students SET face_enrolled = TRUE WHERE id = ?', [student.id]);
  await logAudit(req.user.id, 'FACE_ENROLLED', 'students', student.id, { samples: descriptors.length });
  res.json({ ok: true, sampleCount: descriptors.length });
}));

module.exports = router;
