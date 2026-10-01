const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { THRESHOLD, getStudentAttendanceRows } = require('../utils/analytics');
const { predictRisk } = require('../utils/attendancePrediction');
const { toCSV, toExcelBuffer, pdfReport } = require('../utils/exportUtils');
const { autoCloseExpiredSessions } = require('../utils/sessionAuto');
const { buildWeeklyReport } = require('../utils/reports');
const { fetchExcuses, facultyOwnsCourse, notifyStudentOfReview } = require('../utils/excuses');

const router = express.Router();
router.use(authenticate);

async function getFacultyByUser(userId) {
  return db.get('SELECT * FROM faculty WHERE user_id = ?', [userId]);
}

router.get('/courses', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  const courses = await db.all(`SELECT * FROM courses WHERE faculty_id = ? AND status='active' ORDER BY course_name`, [faculty.id]);
  res.json({ courses });
}));

router.get('/dashboard', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  await autoCloseExpiredSessions(faculty.id);

  const today = new Date().toISOString().slice(0, 10);
  const todaySessions = await db.all(`
    SELECT cs.*, c.course_name FROM class_sessions cs JOIN courses c ON c.id = cs.course_id
    WHERE cs.faculty_id = ? AND cs.date = ? ORDER BY cs.start_time`, [faculty.id, today]);
  const completedToday = todaySessions.filter(s => s.status === 'closed').length;

  const courses = (await db.all(`SELECT id FROM courses WHERE faculty_id = ?`, [faculty.id])).map(c => c.id);
  let avgAttendance = 0, studentsBelow = 0, proxyAlerts = 0;
  let lowAttendance = [];
  if (courses.length) {
    const placeholders = courses.map(() => '?').join(',');
    const rows = await db.all(`
      SELECT a.status FROM attendance a
      JOIN class_sessions cs ON cs.id = a.session_id
      WHERE cs.course_id IN (${placeholders}) AND cs.status != 'open'
        AND cs.date >= date('now','-7 days')
    `, courses);
    if (rows.length) avgAttendance = Math.round((rows.filter(r => r.status !== 'absent').length / rows.length) * 100);

    // students below threshold across all of this faculty's courses
    const perStudent = await db.all(`
      SELECT s.id, COUNT(*) total, SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) present
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      JOIN class_sessions cs ON cs.course_id = e.course_id AND cs.status != 'open'
      JOIN attendance a ON a.session_id = cs.id AND a.student_id = s.id
      WHERE e.course_id IN (${placeholders})
      GROUP BY s.id
    `, courses);
    studentsBelow = perStudent.filter(s => s.total > 0 && (s.present / s.total) * 100 < THRESHOLD).length;

    const proxyRow = await db.get(`SELECT COUNT(*) c FROM audit_logs WHERE action IN ('DUPLICATE_ATTEMPT_BLOCKED','EXPIRED_QR_ATTEMPT') AND timestamp >= datetime('now','-7 days') AND institution_id = ?`, [faculty.institution_id]);
    proxyAlerts = Number(proxyRow.c);

    lowAttendance = await db.all(`
      SELECT s.roll_number, s.name, COUNT(*) total, SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) present
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      JOIN class_sessions cs ON cs.course_id = e.course_id AND cs.status != 'open'
      JOIN attendance a ON a.session_id = cs.id AND a.student_id = s.id
      WHERE e.course_id IN (${placeholders})
      GROUP BY s.id
      HAVING COUNT(*) > 0
      ORDER BY (SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) ASC
      LIMIT 6
    `, courses);
  }

  res.json({
    faculty: { name: faculty.name, employee_id: faculty.employee_id, department: faculty.department },
    todaySessions, completedToday, avgAttendance, studentsBelow, proxyAlerts,
    lowAttendance: lowAttendance.map(s => ({ ...s, total: Number(s.total), present: Number(s.present), pct: Math.round((s.present / s.total) * 100) }))
  });
}));

// A client-supplied course_id is only ever honored if it's actually one of
// this faculty's own courses — never trusted at face value. This also closes
// what would otherwise be a cross-institution leak: without this check, a
// faculty member could pass any course_id (including one from a different
// institution) and see that course's data.
async function reportFilters(req, faculty) {
  const { course_id, from, to } = req.query;
  const ownCourseIds = (await db.all('SELECT id FROM courses WHERE faculty_id = ?', [faculty.id])).map(c => c.id);
  const courseRows = course_id
    ? ownCourseIds.filter(id => id === Number(course_id))
    : ownCourseIds;
  return { courseRows, from, to };
}

router.get('/reports', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  await autoCloseExpiredSessions(faculty && faculty.id);
  const { courseRows, from, to } = await reportFilters(req, faculty);
  if (!courseRows.length) return res.json({ trend: [], trendLabels: [], subjects: [], followUp: [], distribution: {} });

  const placeholders = courseRows.map(() => '?').join(',');
  const dateClauses = [];
  const params = [...courseRows];
  if (from) { dateClauses.push('cs.date >= ?'); params.push(from); }
  if (to) { dateClauses.push('cs.date <= ?'); params.push(to); }
  const dateWhere = dateClauses.length ? ' AND ' + dateClauses.join(' AND ') : '';

  const rows = await db.all(`
    SELECT a.status, a.method, cs.date, c.course_name
    FROM attendance a JOIN class_sessions cs ON cs.id = a.session_id JOIN courses c ON c.id = cs.course_id
    WHERE cs.course_id IN (${placeholders}) AND cs.status != 'open' ${dateWhere}
    ORDER BY cs.date ASC
  `, params);

  const weekMap = {};
  const subjMap = {};
  const dist = { present: 0, absent: 0, late: 0 };
  const methodDist = { face: 0, qr: 0, manual: 0 };
  for (const r of rows) {
    const wk = r.date;
    dist[r.status] = (dist[r.status] || 0) + 1;
    methodDist[r.method] = (methodDist[r.method] || 0) + 1;
    if (!subjMap[r.course_name]) subjMap[r.course_name] = { total: 0, present: 0 };
    subjMap[r.course_name].total++;
    if (r.status !== 'absent') subjMap[r.course_name].present++;
  }
  // group by week number for trend
  const weekly = {};
  for (const r of rows) {
    const d = new Date(r.date);
    const key = `${d.getFullYear()}-${Math.ceil((((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + new Date(d.getFullYear(), 0, 1).getDay() + 1) / 7)}`;
    if (!weekly[key]) weekly[key] = { total: 0, present: 0 };
    weekly[key].total++;
    if (r.status !== 'absent') weekly[key].present++;
  }
  const weekKeys = Object.keys(weekly).sort().slice(-8);
  const trend = weekKeys.map(k => Math.round((weekly[k].present / weekly[k].total) * 100));
  const trendLabels = weekKeys.map((_, i) => `W${i + 1}`);

  const subjects = Object.entries(subjMap).map(([name, v]) => ({ name, pct: Math.round((v.present / v.total) * 100) }));

  const followUp = await db.all(`
    SELECT s.roll_number, s.name, COUNT(*) total, SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) present
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    JOIN class_sessions cs ON cs.course_id = e.course_id AND cs.status != 'open'
    JOIN attendance a ON a.session_id = cs.id AND a.student_id = s.id
    WHERE e.course_id IN (${placeholders}) ${dateWhere}
    GROUP BY s.id
    HAVING COUNT(*) > 0 AND (SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) * 100 < ${THRESHOLD}
    ORDER BY (SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) ASC
  `, params);

  res.json({
    trend, trendLabels, subjects,
    followUp: followUp.map(s => ({ ...s, total: Number(s.total), present: Number(s.present), pct: Math.round((s.present / s.total) * 100) })),
    distribution: dist, methodDistribution: methodDist
  });
}));

// Feature 2 — Weekly Reports, scoped to this faculty's own courses (same
// course-ownership rule as /reports and the export endpoints below).
router.get('/reports/weekly', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  await autoCloseExpiredSessions(faculty.id);
  const { courseRows } = await reportFilters(req, faculty);
  if (!courseRows.length) return res.json({ weekStart: null, weekEnd: null, totals: { totalRecords: 0, totalSessions: 0, presentCount: 0, absentCount: 0, lateCount: 0, overallPct: 0 }, departmentWise: [], courseWise: [], belowThreshold: [], previousWeek: null, comparison: { deltaPct: null, trend: 'no-data' } });
  res.json(await buildWeeklyReport(faculty.institution_id, { course_ids: courseRows }, req.query.week));
}));

// Feature 3 — Risk/anomaly visibility, restricted to attempts against this
// faculty's own sessions. attendance.js already records every event; this is
// read-only.
router.get('/risk', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  const { from, to, student_id, course_id, level, page = 1, pageSize = 25 } = req.query;
  const clauses = ['cs.faculty_id = ?'];
  const params = [faculty.id];
  if (from) { clauses.push('date(re.created_at) >= ?'); params.push(from); }
  if (to) { clauses.push('date(re.created_at) <= ?'); params.push(to); }
  if (student_id) { clauses.push('re.student_id = ?'); params.push(Number(student_id)); }
  if (course_id) { clauses.push('cs.course_id = ?'); params.push(Number(course_id)); }
  if (level) { clauses.push('re.level = ?'); params.push(level); }
  const where = 'WHERE ' + clauses.join(' AND ');
  const baseFrom = `
    FROM risk_events re
    JOIN class_sessions cs ON cs.id = re.session_id
    JOIN students s ON s.id = re.student_id
    JOIN courses c ON c.id = cs.course_id
    ${where}`;
  const totalRow = await db.get(`SELECT COUNT(*) c ${baseFrom}`, params);
  const total = Number(totalRow.c);
  const limit = Math.min(parseInt(pageSize) || 25, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;
  const rawRows = await db.all(`
    SELECT re.id, re.created_at, re.method, re.outcome, re.score, re.level, re.reasons,
           s.roll_number, s.name as student_name, c.course_name
    ${baseFrom}
    ORDER BY re.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const rows = rawRows.map(r => ({ ...r, reasons: JSON.parse(r.reasons) }));
  res.json({ rows, total, page: parseInt(page) || 1, pageSize: limit });
}));

// Batch 5 — Predictive Attendance Analytics, restricted to this faculty's own
// courses via the same reportFilters() course-ownership scoping used by
// /reports and the export endpoints. One row per (student, course) enrolled
// pair in an owned course; ?level=high|medium|low filters server-side.
router.get('/predictions', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  const { courseRows } = await reportFilters(req, faculty);
  if (!courseRows.length) return res.json({ rows: [] });
  const placeholders = courseRows.map(() => '?').join(',');
  const pairs = await db.all(`
    SELECT e.student_id, s.roll_number, s.name as student_name, c.id as course_id, c.course_name
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    JOIN courses c ON c.id = e.course_id
    WHERE e.course_id IN (${placeholders})
    ORDER BY s.name ASC
  `, courseRows);

  const { level } = req.query;
  let rows = await Promise.all(pairs.map(async (p) => ({
    studentId: p.student_id, rollNumber: p.roll_number, studentName: p.student_name,
    courseId: p.course_id, courseName: p.course_name,
    ...predictRisk(await getStudentAttendanceRows(p.student_id, p.course_id))
  })));
  if (level) rows = rows.filter(r => r.level === level);
  res.json({ rows });
}));

/* ---------------- Feature: Student Excuse System (review) ---------------- */
// Ownership is enforced server-side via cs.faculty_id = ? — a faculty member
// can never see or act on a request for a course they don't teach, regardless
// of what course_id/student_id the client passes.
router.get('/excuses', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  const { course_id, student_id, from, to, status } = req.query;
  const clauses = ['cs.faculty_id = ?'];
  const params = [faculty.id];
  if (course_id) { clauses.push('ex.course_id = ?'); params.push(Number(course_id)); }
  if (student_id) { clauses.push('ex.student_id = ?'); params.push(Number(student_id)); }
  if (from) { clauses.push('cs.date >= ?'); params.push(from); }
  if (to) { clauses.push('cs.date <= ?'); params.push(to); }
  if (status) { clauses.push('ex.status = ?'); params.push(status); }
  res.json({ rows: await fetchExcuses('WHERE ' + clauses.join(' AND '), params) });
}));

router.put('/excuses/:id', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  const excuse = await db.get('SELECT * FROM student_excuses WHERE id = ?', [req.params.id]);
  if (!excuse) return res.status(404).json({ error: 'Excuse request not found.' });
  if (!(await facultyOwnsCourse(faculty.id, excuse.course_id))) {
    return res.status(403).json({ error: 'You may only review requests for your own courses.' });
  }
  const { status, reviewer_comment } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be "approved" or "rejected".' });

  await db.run(`
    UPDATE student_excuses SET status=?, reviewer_id=?, reviewer_comment=?, updated_at=datetime('now'), reviewed_at=datetime('now')
    WHERE id=?
  `, [status, req.user.id, (reviewer_comment || '').trim() || null, excuse.id]);
  await logAudit(req.user.id, status === 'approved' ? 'EXCUSE_APPROVED' : 'EXCUSE_REJECTED', 'student_excuses', excuse.id, { student_id: excuse.student_id, session_id: excuse.session_id });
  res.json({ ok: true });
  notifyStudentOfReview(excuse.id, status, (reviewer_comment || '').trim() || null);
}));

router.post('/notify/:roll', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return res.status(404).json({ error: 'Faculty profile not found.' });
  // roll_number is only unique WITHIN an institution (Batch 6) — always scoped
  // to the caller's own, never a bare lookup that could match another
  // institution's student.
  const student = await db.get('SELECT * FROM students WHERE roll_number = ? AND institution_id = ?', [req.params.roll, faculty.institution_id]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  const message = req.body?.message || `Your attendance has fallen below the ${THRESHOLD}% requirement. Please attend upcoming classes to stay eligible.`;
  await db.run(`INSERT INTO notifications (recipient_id, title, message, type) VALUES (?,?,?,?)`,
    [student.user_id, 'Attendance below threshold', message, 'warning']);
  await logAudit(req.user.id, 'NOTIFY_STUDENT', 'students', student.id, { roll: req.params.roll });
  res.json({ ok: true });
}));

router.get('/export/csv', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  await autoCloseExpiredSessions(faculty && faculty.id);
  const { courseRows, from, to } = await reportFilters(req, faculty);
  if (!courseRows.length) return res.status(400).json({ error: 'No courses to export.' });
  const placeholders = courseRows.map(() => '?').join(',');
  const params = [...courseRows];
  let dateWhere = '';
  if (from) { dateWhere += ' AND cs.date >= ?'; params.push(from); }
  if (to) { dateWhere += ' AND cs.date <= ?'; params.push(to); }
  const rows = await db.all(`
    SELECT cs.date, c.course_name as subject, s.roll_number, s.name, a.status, a.method
    FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id JOIN courses c ON c.id=cs.course_id JOIN students s ON s.id=a.student_id
    WHERE cs.course_id IN (${placeholders}) AND cs.status != 'open' ${dateWhere}
    ORDER BY cs.date DESC`, params);
  const csv = toCSV(rows, ['date', 'subject', 'roll_number', 'name', 'status', 'method']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
  res.send(csv);
  await logAudit(req.user.id, 'EXPORT_CSV', 'reports', null, { rows: rows.length });
}));

router.get('/export/pdf', authorize('faculty'), asyncHandler(async (req, res) => {
  const faculty = await getFacultyByUser(req.user.id);
  await autoCloseExpiredSessions(faculty && faculty.id);
  const { courseRows } = await reportFilters(req, faculty);
  const placeholders = courseRows.map(() => '?').join(',');
  const followUp = courseRows.length ? await db.all(`
    SELECT s.roll_number, s.name, COUNT(*) total, SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) present
    FROM enrollments e JOIN students s ON s.id = e.student_id
    JOIN class_sessions cs ON cs.course_id = e.course_id AND cs.status != 'open'
    JOIN attendance a ON a.session_id = cs.id AND a.student_id = s.id
    WHERE e.course_id IN (${placeholders})
    GROUP BY s.id HAVING COUNT(*) > 0
    ORDER BY (SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END)*1.0/COUNT(*)) ASC LIMIT 20
  `, courseRows) : [];
  const followUpRows = followUp.map(s => ({ ...s, total: Number(s.total), present: Number(s.present) }));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="faculty_report.pdf"');
  pdfReport(res, 'Attendance Report', `Generated by ${faculty.name} · ${new Date().toLocaleString()}`, [
    {
      heading: 'Students by attendance %',
      columns: [
        { key: 'roll_number', header: 'Roll No.', width: 90 },
        { key: 'name', header: 'Name', width: 150 },
        { key: 'total', header: 'Classes', width: 70 },
        { key: 'present', header: 'Present', width: 70 },
      ],
      rows: followUpRows
    }
  ]);
  await logAudit(req.user.id, 'EXPORT_PDF', 'reports', null, {});
}));

module.exports = router;
