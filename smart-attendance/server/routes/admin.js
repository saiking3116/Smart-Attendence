const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { THRESHOLD, getStudentAttendanceRows } = require('../utils/analytics');
const { predictRisk } = require('../utils/attendancePrediction');
const { toCSV, toExcelBuffer, pdfReport } = require('../utils/exportUtils');
const { getSetting, setSetting, autoCloseExpiredSessions } = require('../utils/sessionAuto');
const { YEARS, getDepartments, getSections, isValidDepartment, isValidSection } = require('../utils/academicStructure');
const { fetchAttendanceRows, buildAdvancedReport, buildWeeklyReport } = require('../utils/reports');
const { createUserRecord, ValidationError } = require('../utils/userAdmin');
const { parseCSV, rowsToObjects } = require('../utils/csv');
const { validateImportRows, runImport, SAMPLE_CSV, MAX_ROWS, MAX_TEXT_LENGTH } = require('../utils/bulkImport');
const { fetchExcuses, notifyStudentOfReview } = require('../utils/excuses');
const { notifyWeeklyReport } = require('../utils/notificationService');
const lmsService = require('../utils/lmsService');
const dataRetention = require('../utils/dataRetention');

const router = express.Router();
router.use(authenticate, authorize('admin'));

/* ---------------- Dashboard / Analytics ---------------- */
router.get('/dashboard', asyncHandler(async (req, res) => {
  await autoCloseExpiredSessions();
  const iid = req.user.institution_id;
  const [totalStudentsRow, totalFacultyRow, activeCoursesRow] = await Promise.all([
    db.get(`SELECT COUNT(*) c FROM students WHERE institution_id = ?`, [iid]),
    db.get(`SELECT COUNT(*) c FROM faculty WHERE institution_id = ?`, [iid]),
    db.get(`SELECT COUNT(*) c FROM courses WHERE status='active' AND institution_id = ?`, [iid]),
  ]);
  const totalStudents = Number(totalStudentsRow.c), totalFaculty = Number(totalFacultyRow.c), activeCourses = Number(activeCoursesRow.c);

  const allRows = await db.all(`SELECT a.status FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id WHERE cs.status != 'open' AND a.institution_id = ?`, [iid]);
  const overallAttendance = allRows.length ? Math.round((allRows.filter(r => r.status !== 'absent').length / allRows.length) * 100) : 0;

  const deptRows = await db.all(`
    SELECT c.department, a.status FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    JOIN courses c ON c.id = cs.course_id
    WHERE cs.status != 'open' AND a.institution_id = ?
  `, [iid]);
  const deptMap = {};
  for (const r of deptRows) {
    if (!deptMap[r.department]) deptMap[r.department] = { total: 0, present: 0 };
    deptMap[r.department].total++;
    if (r.status !== 'absent') deptMap[r.department].present++;
  }
  const deptComparison = Object.entries(deptMap).map(([name, v]) => ({ name, pct: Math.round((v.present / v.total) * 100) }));

  // weekly institution trend (by calendar date grouped loosely into 8 buckets)
  const trendRows = await db.all(`
    SELECT cs.date, a.status FROM attendance a JOIN class_sessions cs ON cs.id = a.session_id
    WHERE cs.status != 'open' AND a.institution_id = ? ORDER BY cs.date ASC
  `, [iid]);
  const byDate = {};
  for (const r of trendRows) {
    if (!byDate[r.date]) byDate[r.date] = { total: 0, present: 0 };
    byDate[r.date].total++;
    if (r.status !== 'absent') byDate[r.date].present++;
  }
  const dates = Object.keys(byDate).sort();
  const bucketCount = 8;
  const bucketSize = Math.max(1, Math.ceil(dates.length / bucketCount));
  const trend = [];
  for (let i = 0; i < dates.length; i += bucketSize) {
    const slice = dates.slice(i, i + bucketSize);
    let total = 0, present = 0;
    slice.forEach(d => { total += byDate[d].total; present += byDate[d].present; });
    trend.push(total ? Math.round((present / total) * 100) : 0);
  }
  const trendLabels = trend.map((_, i) => `W${i + 1}`);

  const lowAttendanceRows = await db.all(`
    SELECT s.id, COUNT(*) total, SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) present
    FROM students s
    JOIN attendance a ON a.student_id = s.id
    JOIN class_sessions cs ON cs.id = a.session_id AND cs.status != 'open'
    WHERE s.institution_id = ?
    GROUP BY s.id HAVING COUNT(*) > 0 AND (SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END)*1.0/COUNT(*))*100 < ${THRESHOLD}
  `, [iid]);
  const lowAttendanceCount = lowAttendanceRows.length;

  const [methodDist, lateRow, absentRow] = await Promise.all([
    db.all(`SELECT method, COUNT(*) c FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id WHERE cs.status != 'open' AND a.institution_id = ? GROUP BY method`, [iid]),
    db.get(`SELECT COUNT(*) c FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id WHERE a.status='late' AND cs.status != 'open' AND a.institution_id = ?`, [iid]),
    db.get(`SELECT COUNT(*) c FROM attendance a JOIN class_sessions cs ON cs.id=a.session_id WHERE a.status='absent' AND cs.status != 'open' AND a.institution_id = ?`, [iid]),
  ]);

  res.json({
    totalStudents, totalFaculty, activeCourses, overallAttendance,
    deptComparison, trend, trendLabels, lowAttendanceCount,
    methodDist: Object.fromEntries(methodDist.map(m => [m.method, Number(m.c)])),
    lateCount: Number(lateRow.c), absentCount: Number(absentRow.c)
  });
}));

router.get('/analytics/proxy', asyncHandler(async (req, res) => {
  const iid = req.user.institution_id;
  const [flaggedRow, prevFlaggedRow, totalAttemptsRow] = await Promise.all([
    db.get(`SELECT COUNT(*) c FROM audit_logs WHERE action IN ('DUPLICATE_ATTEMPT_BLOCKED','EXPIRED_QR_ATTEMPT') AND timestamp >= datetime('now','-30 days') AND institution_id = ?`, [iid]),
    db.get(`SELECT COUNT(*) c FROM audit_logs WHERE action IN ('DUPLICATE_ATTEMPT_BLOCKED','EXPIRED_QR_ATTEMPT') AND timestamp < datetime('now','-30 days') AND timestamp >= datetime('now','-60 days') AND institution_id = ?`, [iid]),
    db.get(`SELECT COUNT(*) c FROM attendance WHERE institution_id = ?`, [iid]),
  ]);
  const flagged = Number(flaggedRow.c), prevFlagged = Number(prevFlaggedRow.c), totalAttempts = Number(totalAttemptsRow.c);
  const cleanPct = totalAttempts ? Math.round(100 - (flagged / Math.max(totalAttempts, 1)) * 100) : 100;
  res.json({ flagged, prevFlagged, cleanPct: Math.max(0, Math.min(100, cleanPct)) });
}));

function adminReportFilters(req) {
  const { from, to, department, course_id, faculty_id, student_id, status } = req.query;
  return {
    from: from || undefined, to: to || undefined,
    department: department || undefined,
    course_id: course_id ? Number(course_id) : undefined,
    faculty_id: faculty_id ? Number(faculty_id) : undefined,
    student_id: student_id ? Number(student_id) : undefined,
    status: status || undefined,
  };
}

// Feature 1 — Advanced Reporting Dashboard: one filtered, multi-dimensional
// report built from the same attendance rows every other report in this app
// already reads, via the shared aggregator in utils/reports.js.
router.get('/reports/advanced', asyncHandler(async (req, res) => {
  await autoCloseExpiredSessions();
  res.json(await buildAdvancedReport(req.user.institution_id, adminReportFilters(req)));
}));

// Feature 2 — Weekly Reports: institution-wide, with the same optional filters
// as the advanced report, anchored to a given week (defaults to the current week).
router.get('/reports/weekly', asyncHandler(async (req, res) => {
  await autoCloseExpiredSessions();
  const filters = adminReportFilters(req);
  delete filters.from; delete filters.to; // week boundaries are derived from `week`, not passed through
  res.json(await buildWeeklyReport(req.user.institution_id, filters, req.query.week));
}));

// Batch 5 — Predictive Attendance Analytics, institution-wide aggregate.
// Runs the same predictRisk() model used by student/faculty views over every
// student (optionally scoped to a department), returning only counts and
// roll-number/name-level summaries — no descriptors, tokens, or other
// personal data beyond what the admin dashboard already surfaces elsewhere.
router.get('/predictions/summary', asyncHandler(async (req, res) => {
  await autoCloseExpiredSessions();
  const { department } = req.query;
  const iid = req.user.institution_id;
  const students = department
    ? await db.all('SELECT id, roll_number, name, department FROM students WHERE department = ? AND institution_id = ?', [department, iid])
    : await db.all('SELECT id, roll_number, name, department FROM students WHERE institution_id = ?', [iid]);

  const counts = { low: 0, medium: 0, high: 0, insufficient: 0 };
  const decliningTrend = [];
  for (const s of students) {
    const pred = predictRisk(await getStudentAttendanceRows(s.id));
    counts[pred.level] = (counts[pred.level] || 0) + 1;
    if (pred.trend === 'declining') {
      decliningTrend.push({ studentId: s.id, rollNumber: s.roll_number, name: s.name, department: s.department, pct: pred.pct, level: pred.level });
    }
  }

  const studentIds = new Set(students.map(s => s.id));
  const enrollmentPairsAll = await db.all(`
    SELECT e.student_id, c.id as course_id, c.course_name FROM enrollments e JOIN courses c ON c.id = e.course_id
    WHERE e.institution_id = ?
  `, [iid]);
  const enrollmentPairs = enrollmentPairsAll.filter(p => studentIds.has(p.student_id));
  const courseRiskMap = {};
  for (const p of enrollmentPairs) {
    const pred = predictRisk(await getStudentAttendanceRows(p.student_id, p.course_id));
    if (!courseRiskMap[p.course_id]) courseRiskMap[p.course_id] = { courseId: p.course_id, courseName: p.course_name, high: 0, medium: 0, low: 0, insufficient: 0, total: 0 };
    const bucket = courseRiskMap[p.course_id];
    bucket.total++;
    bucket[pred.level] = (bucket[pred.level] || 0) + 1;
  }
  const concerningCourses = Object.values(courseRiskMap)
    .filter(c => c.high > 0)
    .sort((a, b) => b.high - a.high)
    .slice(0, 10);

  res.json({ totalStudents: students.length, counts, decliningTrend, concerningCourses });
}));

router.get('/departments', asyncHandler(async (req, res) => {
  res.json({ rows: await getDepartments(req.user.institution_id) });
}));

/* ---------------- Feature: Department Management ---------------- */
// A separate, richer resource from GET /departments above (which several
// existing filter dropdowns already depend on returning a bare string array —
// left untouched). This is the full CRUD surface for the new admin UI.
const DEPT_CODE_RE = /^[A-Z0-9]{2,10}$/;

async function departmentCounts(institutionId, code) {
  const [students, faculty, courses] = await Promise.all([
    db.get('SELECT COUNT(*) c FROM students WHERE department = ? AND institution_id = ?', [code, institutionId]),
    db.get('SELECT COUNT(*) c FROM faculty WHERE department = ? AND institution_id = ?', [code, institutionId]),
    db.get('SELECT COUNT(*) c FROM courses WHERE department = ? AND institution_id = ?', [code, institutionId]),
  ]);
  return { students: Number(students.c), faculty: Number(faculty.c), courses: Number(courses.c) };
}

// Every /depts/:id route below first loads the row scoped to the caller's own
// institution — a department id from another institution is treated exactly
// like "not found", never leaked or actionable.
async function getOwnDept(req) {
  return db.get('SELECT * FROM departments WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
}

router.get('/depts', asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT * FROM departments WHERE institution_id = ? ORDER BY code ASC', [req.user.institution_id]);
  const withCounts = await Promise.all(rows.map(async (d) => ({ ...d, counts: await departmentCounts(req.user.institution_id, d.code) })));
  res.json({ rows: withCounts });
}));

router.post('/depts', asyncHandler(async (req, res) => {
  const { code, name, description } = req.body || {};
  const normCode = (code || '').trim().toUpperCase();
  if (!DEPT_CODE_RE.test(normCode)) return res.status(400).json({ error: 'Department code must be 2-10 letters/numbers (e.g. CSE).' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Department name is required.' });
  const dup = await db.get('SELECT 1 FROM departments WHERE code = ? AND institution_id = ?', [normCode, req.user.institution_id]);
  if (dup) return res.status(409).json({ error: `Department code "${normCode}" already exists.` });
  const info = await db.run(`INSERT INTO departments (institution_id, code, name, description) VALUES (?,?,?,?)`, [req.user.institution_id, normCode, name.trim(), (description || '').trim() || null]);
  await logAudit(req.user.id, 'CREATE_DEPARTMENT', 'departments', info.lastInsertRowid, { code: normCode, name: name.trim() });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.get('/depts/:id', asyncHandler(async (req, res) => {
  const dept = await getOwnDept(req);
  if (!dept) return res.status(404).json({ error: 'Department not found.' });
  const iid = req.user.institution_id;
  const [students, faculty, courses] = await Promise.all([
    db.all('SELECT id, roll_number, name, year_of_study, section FROM students WHERE department = ? AND institution_id = ? ORDER BY roll_number', [dept.code, iid]),
    db.all('SELECT id, employee_id, name FROM faculty WHERE department = ? AND institution_id = ? ORDER BY name', [dept.code, iid]),
    db.all('SELECT id, course_code, course_name, status FROM courses WHERE department = ? AND institution_id = ? ORDER BY course_name', [dept.code, iid]),
  ]);
  res.json({ department: dept, students, faculty, courses });
}));

// Code is intentionally immutable here — every existing student/faculty/course
// row references the code by value (not a foreign key), so silently renaming
// it would orphan all of them. Name/description only.
router.put('/depts/:id', asyncHandler(async (req, res) => {
  const dept = await getOwnDept(req);
  if (!dept) return res.status(404).json({ error: 'Department not found.' });
  const body = req.body || {};
  const name = body.name !== undefined ? body.name.trim() : dept.name;
  if (!name) return res.status(400).json({ error: 'Department name is required.' });
  const description = body.description !== undefined ? ((body.description || '').trim() || null) : dept.description;
  await db.run(`UPDATE departments SET name=?, description=?, updated_at=datetime('now') WHERE id=?`, [name, description, dept.id]);
  await logAudit(req.user.id, 'UPDATE_DEPARTMENT', 'departments', dept.id, { name });
  res.json({ ok: true });
}));

router.put('/depts/:id/status', asyncHandler(async (req, res) => {
  const dept = await getOwnDept(req);
  if (!dept) return res.status(404).json({ error: 'Department not found.' });
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'status must be "active" or "inactive".' });
  await db.run(`UPDATE departments SET status=?, updated_at=datetime('now') WHERE id=?`, [status, dept.id]);
  await logAudit(req.user.id, status === 'active' ? 'ACTIVATE_DEPARTMENT' : 'DEACTIVATE_DEPARTMENT', 'departments', dept.id, { code: dept.code });
  res.json({ ok: true });
}));

// Destructive delete only ever succeeds when nothing references this
// department — otherwise it's a 409 pointing the admin at deactivation instead.
router.delete('/depts/:id', asyncHandler(async (req, res) => {
  const dept = await getOwnDept(req);
  if (!dept) return res.status(404).json({ error: 'Department not found.' });
  const counts = await departmentCounts(req.user.institution_id, dept.code);
  if (counts.students || counts.faculty || counts.courses) {
    return res.status(409).json({
      error: `Cannot delete — ${counts.students} student(s), ${counts.faculty} faculty and ${counts.courses} course(s) still reference this department. Deactivate it instead.`,
      counts
    });
  }
  await db.run('DELETE FROM departments WHERE id = ?', [dept.id]);
  await logAudit(req.user.id, 'DELETE_DEPARTMENT', 'departments', dept.id, { code: dept.code });
  res.json({ ok: true });
}));

// Institution-wide trigger: emails every active student their own weekly
// report (each built via the same buildWeeklyReport used everywhere else),
// respecting each student's own preference toggle. There is no background job
// scheduler in this app, so this is deliberately an on-demand admin action
// rather than an automatic "every Sunday at midnight" send.
router.post('/notifications/weekly-reports', asyncHandler(async (req, res) => {
  const iid = req.user.institution_id;
  const students = await db.all(`
    SELECT s.id as student_id, s.name, u.id as user_id, u.email
    FROM students s JOIN users u ON u.id = s.user_id
    WHERE u.status = 'active' AND s.institution_id = ?
  `, [iid]);
  let sent = 0, skipped = 0, failed = 0;
  for (const s of students) {
    const report = await buildWeeklyReport(iid, { student_id: s.student_id }, req.query.week);
    const result = await notifyWeeklyReport({ user: { id: s.user_id, name: s.name, email: s.email }, report });
    if (result.ok) sent++; else if (result.mode === 'skipped') skipped++; else failed++;
  }
  await logAudit(req.user.id, 'BULK_WEEKLY_REPORT_EMAILS', 'users', null, { sent, skipped, failed });
  res.json({ ok: true, sent, skipped, failed, total: students.length });
}));

/* ---------------- Feature 3 — Risk / anomaly detection ---------------- */
// Read-only visibility over risk_events, which attendance.js populates at the
// moment of each attempt (accepted or rejected) — never gates whether an
// attempt is accepted, only records what the rule-based engine observed.
router.get('/risk', asyncHandler(async (req, res) => {
  const { from, to, student_id, department, course_id, level, method, page = 1, pageSize = 25 } = req.query;
  const clauses = ['re.institution_id = ?'];
  const params = [req.user.institution_id];
  if (from) { clauses.push('date(re.created_at) >= ?'); params.push(from); }
  if (to) { clauses.push('date(re.created_at) <= ?'); params.push(to); }
  if (student_id) { clauses.push('re.student_id = ?'); params.push(Number(student_id)); }
  if (level) { clauses.push('re.level = ?'); params.push(level); }
  if (method) { clauses.push('re.method = ?'); params.push(method); }
  if (department) { clauses.push('s.department = ?'); params.push(department); }
  if (course_id) { clauses.push('cs.course_id = ?'); params.push(Number(course_id)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const baseFrom = `
    FROM risk_events re
    JOIN students s ON s.id = re.student_id
    LEFT JOIN class_sessions cs ON cs.id = re.session_id
    LEFT JOIN courses c ON c.id = cs.course_id
    ${where}`;

  const totalRow = await db.get(`SELECT COUNT(*) c ${baseFrom}`, params);
  const total = Number(totalRow.c);
  const limit = Math.min(parseInt(pageSize) || 25, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;
  const rawRows = await db.all(`
    SELECT re.id, re.created_at, re.method, re.outcome, re.score, re.level, re.reasons,
           s.roll_number, s.name as student_name, s.department,
           c.course_name, c.course_code
    ${baseFrom}
    ORDER BY re.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const rows = rawRows.map(r => ({ ...r, reasons: JSON.parse(r.reasons) }));

  const summary = await db.all(`SELECT re.level, COUNT(*) c ${baseFrom} GROUP BY re.level`, params);
  const summaryMap = { low: 0, medium: 0, high: 0 };
  summary.forEach(s => { summaryMap[s.level] = Number(s.c); });

  res.json({
    rows, total, page: parseInt(page) || 1, pageSize: limit,
    summary: { total, high: summaryMap.high, medium: summaryMap.medium, low: summaryMap.low }
  });
}));

/* ---------------- Feature: Student Excuse System (institution-wide) ---------------- */
router.get('/excuses', asyncHandler(async (req, res) => {
  const { course_id, student_id, department, from, to, status } = req.query;
  const clauses = ['ex.institution_id = ?'];
  const params = [req.user.institution_id];
  if (course_id) { clauses.push('ex.course_id = ?'); params.push(Number(course_id)); }
  if (student_id) { clauses.push('ex.student_id = ?'); params.push(Number(student_id)); }
  if (department) { clauses.push('s.department = ?'); params.push(department); }
  if (from) { clauses.push('cs.date >= ?'); params.push(from); }
  if (to) { clauses.push('cs.date <= ?'); params.push(to); }
  if (status) { clauses.push('ex.status = ?'); params.push(status); }
  const where = 'WHERE ' + clauses.join(' AND ');
  res.json({ rows: await fetchExcuses(where, params) });
}));

router.put('/excuses/:id', asyncHandler(async (req, res) => {
  const excuse = await db.get('SELECT * FROM student_excuses WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!excuse) return res.status(404).json({ error: 'Excuse request not found.' });
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

/* ---------------- Users ---------------- */
// Only ever lists/creates/edits users within the caller's OWN institution —
// an institution admin has no visibility into another institution's roster
// at all, not even via search.
router.get('/users', asyncHandler(async (req, res) => {
  const { search, role, page = 1, pageSize = 20 } = req.query;
  const clauses = ['u.institution_id = ?'];
  const params = [req.user.institution_id];
  if (role) { clauses.push('u.role = ?'); params.push(role); }
  if (search) {
    clauses.push('(u.user_id LIKE ? OR u.name LIKE ? OR u.department LIKE ?)');
    const s = `%${search}%`; params.push(s, s, s);
  }
  const where = 'WHERE ' + clauses.join(' AND ');
  const totalRow = await db.get(`SELECT COUNT(*) c FROM users u ${where}`, params);
  const total = Number(totalRow.c);
  const limit = Math.min(parseInt(pageSize) || 20, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;
  // student_id (students.id, distinct from users.id) is included only so the
  // admin UI can link a student row to their notes/records — null for non-students.
  const rows = await db.all(`
    SELECT u.id, u.user_id, u.name, u.email, u.role, u.department, u.year_of_study, u.section, u.status, u.created_at,
           s.id as student_id, COALESCE(tf.enabled, FALSE) as twofa_enabled
    FROM users u LEFT JOIN students s ON s.user_id = u.id
    LEFT JOIN user_2fa tf ON tf.user_id = u.id
    ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ rows, total, page: parseInt(page) || 1, pageSize: limit });
}));

router.post('/users', asyncHandler(async (req, res) => {
  const { user_id, name, email, password, role, department, year_of_study, section } = req.body || {};
  try {
    const created = await createUserRecord(req.user.institution_id, { user_id, name, email, password, role, department, year_of_study, section });
    await logAudit(req.user.id, 'CREATE_USER', 'users', created.id, { user_id: created.user_id, role: created.role });
    res.status(201).json({ ok: true, id: created.id });
  } catch (e) {
    if (e instanceof ValidationError) {
      const status = /already exists/.test(e.message) ? 409 : 400;
      return res.status(status).json({ error: e.message });
    }
    throw e;
  }
}));

/* ---------------- Bulk user import (CSV) ---------------- */
router.get('/users/bulk-import/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="user_import_template.csv"');
  res.send(SAMPLE_CSV);
});

function parseAndSizeCheckCsv(req, res) {
  const { csv } = req.body || {};
  if (typeof csv !== 'string' || !csv.trim()) {
    res.status(400).json({ error: 'CSV content is required.' });
    return null;
  }
  if (csv.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: 'CSV file is too large.' });
    return null;
  }
  const rows = rowsToObjects(parseCSV(csv));
  if (!rows.length) {
    res.status(400).json({ error: 'No data rows found in the CSV.' });
    return null;
  }
  if (rows.length > MAX_ROWS) {
    res.status(400).json({ error: `Too many rows — the limit is ${MAX_ROWS} per import.` });
    return null;
  }
  return rows;
}

// Read-only preview: parses + validates every row, never writes anything.
router.post('/users/bulk-import/preview', asyncHandler(async (req, res) => {
  const rows = parseAndSizeCheckCsv(req, res);
  if (!rows) return;
  res.json(await validateImportRows(req.user.institution_id, rows));
}));

// Actual import: re-validates fresh, then writes all currently-valid rows in one
// transaction. Never logs the parsed rows (which contain plaintext passwords) —
// only counts and IDs reach the audit log. Every imported user is created in
// the importing admin's own institution.
router.post('/users/bulk-import/confirm', asyncHandler(async (req, res) => {
  const rows = parseAndSizeCheckCsv(req, res);
  if (!rows) return;
  const result = await runImport(req.user.institution_id, rows, req.user.id, logAudit);
  res.status(result.ok ? 200 : 500).json(result);
}));

// Every user-management route below first loads the target scoped to the
// caller's own institution — a user id from another institution reads and
// behaves exactly like "not found", never leaked or actionable.
async function getOwnUser(req) {
  return db.get('SELECT * FROM users WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
}

router.put('/users/:id', asyncHandler(async (req, res) => {
  const user = await getOwnUser(req);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const { name, email, department, year_of_study, section, status } = req.body || {};

  if (user.role === 'student' && (department || year_of_study || section)) {
    const effDept = department || user.department;
    const effYear = year_of_study || user.year_of_study;
    const effSection = section || user.section;
    if (year_of_study && !YEARS.includes(year_of_study)) return res.status(400).json({ error: 'Invalid academic year.' });
    if (!(await isValidSection(req.user.institution_id, effDept, effYear, effSection))) return res.status(400).json({ error: 'That department / academic year / section combination does not exist.' });
  } else if (user.role === 'faculty' && department && !(await isValidDepartment(req.user.institution_id, department))) {
    return res.status(400).json({ error: 'Invalid department.' });
  }

  await db.run(`UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), department=COALESCE(?,department), year_of_study=COALESCE(?,year_of_study), section=COALESCE(?,section), status=COALESCE(?,status) WHERE id=?`,
    [name, email, department, year_of_study, section, status, user.id]);
  if (name && user.role === 'student') await db.run('UPDATE students SET name=? WHERE user_id=?', [name, user.id]);
  if (name && user.role === 'faculty') await db.run('UPDATE faculty SET name=? WHERE user_id=?', [name, user.id]);
  if (department && user.role === 'student') await db.run('UPDATE students SET department=? WHERE user_id=?', [department, user.id]);
  if (year_of_study && user.role === 'student') await db.run('UPDATE students SET year_of_study=? WHERE user_id=?', [year_of_study, user.id]);
  if (section && user.role === 'student') await db.run('UPDATE students SET section=? WHERE user_id=?', [section, user.id]);
  if (department && user.role === 'faculty') await db.run('UPDATE faculty SET department=? WHERE user_id=?', [department, user.id]);
  // Log only the fields this endpoint actually reads/applies above — never the
  // raw req.body, which is client-controlled and could carry an extra field
  // (e.g. a stray "password") that has no functional effect here but must
  // still never land in the permanent audit trail.
  await logAudit(req.user.id, 'UPDATE_USER', 'users', user.id, { name, email, department, year_of_study, section, status });
  res.json({ ok: true });
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
  const user = await getOwnUser(req);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  await db.run(`UPDATE users SET status='disabled' WHERE id = ?`, [user.id]);
  await logAudit(req.user.id, 'DISABLE_USER', 'users', user.id, {});
  res.json({ ok: true });
}));

router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const user = await getOwnUser(req);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const newPassword = req.body?.password || Math.random().toString(36).slice(2, 10);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 8), user.id]);
  await logAudit(req.user.id, 'RESET_PASSWORD', 'users', user.id, {});
  res.json({ ok: true, temporaryPassword: newPassword });
}));

// Admin recovery path for a lost authenticator — fully removes 2FA from the
// target account so they can log in with just their password again (and
// re-enroll if they choose to). Institution-level access, same trust level as
// resetting a password above.
router.post('/users/:id/2fa/reset', asyncHandler(async (req, res) => {
  const user = await getOwnUser(req);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const row = await db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [user.id]);
  if (!row) return res.status(409).json({ error: '2FA is not enabled for this user.' });
  await db.run('DELETE FROM user_2fa WHERE user_id = ?', [user.id]);
  await logAudit(req.user.id, 'TWO_FA_ADMIN_RESET', 'users', user.id, { target_user_id: user.user_id });
  res.json({ ok: true });
}));

/* ---------------- Courses ---------------- */
router.get('/courses', asyncHandler(async (req, res) => {
  const rows = await db.all(`
    SELECT c.*, u.name as faculty_name FROM courses c
    LEFT JOIN faculty f ON f.id = c.faculty_id
    LEFT JOIN users u ON u.id = f.user_id
    WHERE c.institution_id = ?
    ORDER BY c.department, c.course_name`, [req.user.institution_id]);
  res.json({ rows });
}));

// A faculty_id supplied here must belong to the caller's own institution —
// otherwise an admin could assign a course to (and thereby leak visibility
// into) another institution's faculty member.
async function facultyBelongsToInstitution(facultyId, institutionId) {
  if (facultyId == null) return true;
  return !!(await db.get('SELECT 1 FROM faculty WHERE id = ? AND institution_id = ?', [facultyId, institutionId]));
}

router.post('/courses', asyncHandler(async (req, res) => {
  const { course_code, course_name, department, academic_year, semester, section, faculty_id } = req.body || {};
  if (!course_code || !course_name) return res.status(400).json({ error: 'course_code and course_name are required.' });
  if (!(await facultyBelongsToInstitution(faculty_id, req.user.institution_id))) return res.status(400).json({ error: 'Invalid faculty.' });
  const dup = await db.get('SELECT 1 FROM courses WHERE course_code = ? AND institution_id = ?', [course_code, req.user.institution_id]);
  if (dup) return res.status(409).json({ error: `Course ${course_code} already exists.` });
  const info = await db.run(`INSERT INTO courses (institution_id,course_code,course_name,department,academic_year,semester,section,faculty_id,status) VALUES (?,?,?,?,?,?,?,?,'active')`,
    [req.user.institution_id, course_code, course_name, department || null, academic_year || null, semester || 5, section || null, faculty_id || null]);
  await logAudit(req.user.id, 'CREATE_COURSE', 'courses', info.lastInsertRowid, { course_code });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.put('/courses/:id', asyncHandler(async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  const body = req.body || {};
  // Explicit undefined-check instead of SQL COALESCE: COALESCE(?, col) treats a
  // provided NULL (e.g. "unassign faculty") the same as "field omitted", so it can
  // never clear a value — only an explicit key-presence check can distinguish them.
  const course_name = body.course_name !== undefined ? body.course_name : course.course_name;
  const department = body.department !== undefined ? body.department : course.department;
  const academic_year = body.academic_year !== undefined ? body.academic_year : course.academic_year;
  const semester = body.semester !== undefined ? (body.semester || 5) : course.semester;
  const section = body.section !== undefined ? body.section : course.section;
  const faculty_id = body.faculty_id !== undefined ? (body.faculty_id || null) : course.faculty_id;
  const status = body.status !== undefined ? body.status : course.status;
  if (!(await facultyBelongsToInstitution(faculty_id, req.user.institution_id))) return res.status(400).json({ error: 'Invalid faculty.' });
  await db.run(`UPDATE courses SET course_name=?, department=?, academic_year=?, semester=?, section=?, faculty_id=?, status=? WHERE id=?`,
    [course_name, department, academic_year, semester, section, faculty_id, status, course.id]);
  await logAudit(req.user.id, 'UPDATE_COURSE', 'courses', course.id, req.body);
  res.json({ ok: true });
}));

router.delete('/courses/:id', asyncHandler(async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!course) return res.status(404).json({ error: 'Course not found.' });
  await db.run(`UPDATE courses SET status='inactive' WHERE id = ?`, [course.id]);
  await logAudit(req.user.id, 'DEACTIVATE_COURSE', 'courses', course.id, {});
  res.json({ ok: true });
}));

/* ---------------- Timetable ---------------- */
router.get('/timetable', asyncHandler(async (req, res) => {
  const { department, section } = req.query;
  const clauses = ['ts.institution_id = ?'];
  const params = [req.user.institution_id];
  if (department) { clauses.push('ts.department = ?'); params.push(department); }
  if (section) { clauses.push('ts.section = ?'); params.push(section); }
  const where = 'WHERE ' + clauses.join(' AND ');
  const rows = await db.all(`
    SELECT ts.*, c.course_name, c.course_code FROM timetable_slots ts
    LEFT JOIN courses c ON c.id = ts.course_id
    ${where}
    ORDER BY ts.department, ts.section, ts.day_of_week, ts.start_time`, params);
  res.json({ rows });
}));

router.post('/timetable', asyncHandler(async (req, res) => {
  const { department, section, day_of_week, start_time, end_time, course_id, label, period_type } = req.body || {};
  if (!department || !section || day_of_week == null || !start_time || !end_time) {
    return res.status(400).json({ error: 'department, section, day_of_week, start_time and end_time are required.' });
  }
  const type = ['class', 'break', 'study', 'lunch'].includes(period_type) ? period_type : 'class';
  if (type === 'class' && !course_id) return res.status(400).json({ error: 'course_id is required for a class period.' });
  const info = await db.run(`
    INSERT INTO timetable_slots (institution_id, department, section, day_of_week, start_time, end_time, course_id, label, period_type)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user.institution_id, department, section, day_of_week, start_time, end_time, type === 'class' ? course_id : null, label || null, type]);
  await logAudit(req.user.id, 'CREATE_TIMETABLE_SLOT', 'timetable_slots', info.lastInsertRowid, { department, section, day_of_week, start_time, end_time });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.put('/timetable/:id', asyncHandler(async (req, res) => {
  const slot = await db.get('SELECT * FROM timetable_slots WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!slot) return res.status(404).json({ error: 'Timetable slot not found.' });
  const body = req.body || {};
  const department = body.department !== undefined ? body.department : slot.department;
  const section = body.section !== undefined ? body.section : slot.section;
  const day_of_week = body.day_of_week !== undefined ? body.day_of_week : slot.day_of_week;
  const start_time = body.start_time !== undefined ? body.start_time : slot.start_time;
  const end_time = body.end_time !== undefined ? body.end_time : slot.end_time;
  const period_type = ['class', 'break', 'study', 'lunch'].includes(body.period_type) ? body.period_type : slot.period_type;
  const course_id = period_type === 'class' ? (body.course_id !== undefined ? body.course_id : slot.course_id) : null;
  const label = body.label !== undefined ? body.label : slot.label;
  await db.run(`
    UPDATE timetable_slots SET department=?, section=?, day_of_week=?, start_time=?, end_time=?, course_id=?, label=?, period_type=?
    WHERE id=?`,
    [department, section, day_of_week, start_time, end_time, course_id, label, period_type, slot.id]);
  await logAudit(req.user.id, 'UPDATE_TIMETABLE_SLOT', 'timetable_slots', slot.id, req.body);
  res.json({ ok: true });
}));

router.delete('/timetable/:id', asyncHandler(async (req, res) => {
  const slot = await db.get('SELECT * FROM timetable_slots WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!slot) return res.status(404).json({ error: 'Timetable slot not found.' });
  await db.run('DELETE FROM timetable_slots WHERE id = ?', [slot.id]);
  await logAudit(req.user.id, 'DELETE_TIMETABLE_SLOT', 'timetable_slots', slot.id, {});
  res.json({ ok: true });
}));

/* ---------------- Settings (college/classroom GPS location) ---------------- */
router.get('/settings', asyncHandler(async (req, res) => {
  const location_config = await getSetting(req.user.institution_id, 'location_config', null);
  res.json({ location_config });
}));

router.put('/settings/location', asyncHandler(async (req, res) => {
  const { lat, lng, radius_m } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng are required numbers.' });
  }
  const radius = Number.isFinite(radius_m) && radius_m > 0 ? Math.round(radius_m) : 100;
  await setSetting(req.user.institution_id, 'location_config', { lat, lng, radius_m: radius });
  await logAudit(req.user.id, 'UPDATE_LOCATION_SETTINGS', 'app_settings', null, { lat, lng, radius_m: radius });
  res.json({ ok: true, location_config: { lat, lng, radius_m: radius } });
}));

router.get('/faculty-list', asyncHandler(async (req, res) => {
  const rows = await db.all(`SELECT f.id, f.name, f.employee_id, f.department FROM faculty f WHERE f.institution_id = ? ORDER BY f.name`, [req.user.institution_id]);
  res.json({ rows });
}));

router.get('/students-list', asyncHandler(async (req, res) => {
  const rows = await db.all(`SELECT id, roll_number, name, department, section FROM students WHERE institution_id = ? ORDER BY roll_number`, [req.user.institution_id]);
  res.json({ rows });
}));

/* ---------------- Audit logs ---------------- */
router.get('/audit-logs', asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 25 } = req.query;
  const limit = Math.min(parseInt(pageSize) || 25, 100);
  const offset = (Math.max(parseInt(page) || 1, 1) - 1) * limit;
  const totalRow = await db.get('SELECT COUNT(*) c FROM audit_logs WHERE institution_id = ?', [req.user.institution_id]);
  const total = Number(totalRow.c);
  const rows = await db.all(`
    SELECT al.*, u.name as user_name, u.user_id as user_login
    FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
    WHERE al.institution_id = ?
    ORDER BY al.timestamp DESC LIMIT ? OFFSET ?`, [req.user.institution_id, limit, offset]);
  res.json({ rows, total, page: parseInt(page) || 1, pageSize: limit });
}));

/* ---------------- Exports ---------------- */
router.get('/export/excel', asyncHandler(async (req, res) => {
  await autoCloseExpiredSessions();
  // Optional filters (same shape as /reports/advanced) — omitted, this is the
  // original unfiltered whole-institution export, unchanged.
  const { from, to, department, course_id } = req.query;
  const joinClauses = ["cs.status != 'open'"];
  const joinParams = [];
  if (from) { joinClauses.push('cs.date >= ?'); joinParams.push(from); }
  if (to) { joinClauses.push('cs.date <= ?'); joinParams.push(to); }
  if (course_id) { joinClauses.push('cs.course_id = ?'); joinParams.push(Number(course_id)); }
  const whereClauses = ['s.institution_id = ?'];
  const whereParams = [req.user.institution_id];
  if (department) { whereClauses.push('s.department = ?'); whereParams.push(department); }
  const where = 'WHERE ' + whereClauses.join(' AND ');

  const rows = await db.all(`
    SELECT s.roll_number, s.name, s.department, s.section,
      COUNT(a.id) total, SUM(CASE WHEN a.status!='absent' THEN 1 ELSE 0 END) present
    FROM students s
    LEFT JOIN attendance a ON a.student_id = s.id
    LEFT JOIN class_sessions cs ON cs.id = a.session_id AND ${joinClauses.join(' AND ')}
    ${where}
    GROUP BY s.id ORDER BY s.roll_number`, [...joinParams, ...whereParams]);
  const withPct = rows.map(r => {
    const total = Number(r.total), present = Number(r.present);
    return { ...r, total, present, pct: total ? Math.round((present / total) * 100) : 0 };
  });
  const buffer = await toExcelBuffer(withPct, [
    { key: 'roll_number', header: 'Roll No.' }, { key: 'name', header: 'Name' },
    { key: 'department', header: 'Department' }, { key: 'section', header: 'Section' },
    { key: 'total', header: 'Total Classes' }, { key: 'present', header: 'Present' }, { key: 'pct', header: 'Attendance %' }
  ], 'Institution Attendance');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="institution_attendance.xlsx"');
  await logAudit(req.user.id, 'EXPORT_EXCEL', 'reports', null, {});
  res.send(Buffer.from(buffer));
}));

router.get('/export/pdf', asyncHandler(async (req, res) => {
  await autoCloseExpiredSessions();
  const filters = adminReportFilters(req);
  const report = await buildAdvancedReport(req.user.institution_id, filters);
  const filterBits = [];
  if (filters.from || filters.to) filterBits.push(`${filters.from || '…'} to ${filters.to || '…'}`);
  if (filters.department) filterBits.push(filters.department);
  const subtitle = `Generated ${new Date().toLocaleString()}${filterBits.length ? ' · Filtered: ' + filterBits.join(', ') : ''}`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="institution_report.pdf"');
  pdfReport(res, 'Institution Attendance Report', subtitle, [
    {
      heading: `Summary — ${report.totals.overallPct}% overall (${report.totals.presentCount} present, ${report.totals.absentCount} absent, ${report.totals.lateCount} late)`,
      columns: [{ key: 'department', header: 'Department', width: 200 }, { key: 'pct', header: 'Attendance %', width: 120 }],
      rows: report.departmentWise.map(d => ({ department: d.label, pct: d.pct }))
    },
    {
      heading: 'Course-wise attendance',
      columns: [{ key: 'course', header: 'Course', width: 250 }, { key: 'pct', header: 'Attendance %', width: 100 }],
      rows: report.courseWise.map(c => ({ course: c.label, pct: c.pct }))
    },
    {
      heading: 'Students below 75% attendance',
      columns: [
        { key: 'roll_number', header: 'Roll No.', width: 90 },
        { key: 'label', header: 'Name', width: 150 },
        { key: 'pct', header: 'Attendance %', width: 100 },
      ],
      rows: report.belowThreshold
    }
  ]);
  await logAudit(req.user.id, 'EXPORT_PDF', 'reports', null, {});
}));

/* ---------------- Feature: LMS Integration ---------------- */
router.get('/lms/status', asyncHandler(async (req, res) => {
  const state = await lmsService.getState(req.user.institution_id);
  res.json({ ...state, realProviderConfigured: lmsService.isRealProviderConfigured() });
}));

router.get('/lms/logs', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  res.json({ rows: await lmsService.getSyncLogs(req.user.institution_id, limit) });
}));

router.post('/lms/test-connection', asyncHandler(async (req, res) => {
  const result = await lmsService.testConnection(req.user.institution_id, req.user.id);
  await logAudit(req.user.id, 'LMS_TEST_CONNECTION', 'lms_integrations', null, { provider: lmsService.getProvider().name, ok: result.ok });
  res.json(result);
}));

router.post('/lms/sync/courses', asyncHandler(async (req, res) => {
  const result = await lmsService.syncCourses(req.user.institution_id, req.user.id);
  await logAudit(req.user.id, 'LMS_SYNC_COURSES', 'lms_sync_logs', null, { provider: lmsService.getProvider().name, succeeded: result.succeeded, failed: result.failed });
  res.json(result);
}));

router.post('/lms/sync/enrollments', asyncHandler(async (req, res) => {
  const result = await lmsService.syncEnrollments(req.user.institution_id, req.user.id);
  await logAudit(req.user.id, 'LMS_SYNC_ENROLLMENTS', 'lms_sync_logs', null, { provider: lmsService.getProvider().name, succeeded: result.succeeded, failed: result.failed });
  res.json(result);
}));

router.post('/lms/sync/attendance', asyncHandler(async (req, res) => {
  const result = await lmsService.syncAttendance(req.user.institution_id, req.user.id);
  await logAudit(req.user.id, 'LMS_SYNC_ATTENDANCE', 'lms_sync_logs', null, { provider: lmsService.getProvider().name, succeeded: result.succeeded });
  res.json(result);
}));

router.post('/lms/sync/all', asyncHandler(async (req, res) => {
  const result = await lmsService.syncAll(req.user.institution_id, req.user.id);
  await logAudit(req.user.id, 'LMS_SYNC_ALL', 'lms_sync_logs', null, { provider: lmsService.getProvider().name });
  res.json(result);
}));

/* ==========================================================================
   Feature: Compliance / Privacy / Security Foundation (Batch 5).
   No new security system here — this reads the EXISTING audit_logs, user_2fa
   and app_settings state built by earlier batches and presents it for admin
   accountability. Static text sections (biometric/location) describe only
   what the real implementation actually does — see the inline notes below.
   ========================================================================== */

// Aggregate, read-only. No sensitive data (secrets, tokens, descriptors,
// passwords) leaves this endpoint — only counts and roll-number/name-level
// summaries the admin already has access to elsewhere in the app.
router.get('/compliance/summary', asyncHandler(async (req, res) => {
  const iid = req.user.institution_id;
  const [totalUsersRow, usersWith2faRow, withoutTwoFa, exportActivity, faceEnrolledRow, lms, retention] = await Promise.all([
    db.get(`SELECT COUNT(*) c FROM users WHERE status='active' AND institution_id = ?`, [iid]),
    db.get(`SELECT COUNT(*) c FROM user_2fa t JOIN users u ON u.id = t.user_id WHERE t.enabled = TRUE AND u.institution_id = ?`, [iid]),
    db.all(`
      SELECT u.id, u.user_id, u.name, u.role FROM users u
      LEFT JOIN user_2fa t ON t.user_id = u.id AND t.enabled = TRUE
      WHERE u.status = 'active' AND u.institution_id = ? AND t.user_id IS NULL
      ORDER BY u.role, u.name LIMIT 50
    `, [iid]),
    db.all(`
      SELECT al.action, al.timestamp, u.name as user_name, u.user_id as user_login
      FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
      WHERE al.action IN ('EXPORT_EXCEL','EXPORT_PDF','EXPORT_CSV','DATA_EXPORT_SELF') AND al.institution_id = ?
      ORDER BY al.timestamp DESC LIMIT 20
    `, [iid]),
    db.get(`SELECT COUNT(*) c FROM face_enrollments fe JOIN students s ON s.id = fe.student_id WHERE s.institution_id = ?`, [iid]),
    lmsService.getState(iid),
    dataRetention.previewCounts(iid),
  ]);
  const totalUsers = Number(totalUsersRow.c), usersWith2fa = Number(usersWith2faRow.c);

  res.json({
    security: { totalUsers, usersWith2fa, usersWithout2fa: totalUsers - usersWith2fa, withoutTwoFa },
    data: { exportActivity, faceEnrolledCount: Number(faceEnrolledRow.c), retention },
    privacy: {
      // Accurately describes the real face.js implementation: face_enrollments
      // stores a numeric descriptor array (a fixed-length vector of numbers
      // produced by the face-matching model), never the raw photo/image.
      biometric: 'Face verification stores a numerical face descriptor (a list of numbers derived from your face at enrollment) — it does not store your photo or a recognizable image. The descriptor is used only to compare against future check-ins.',
      location: 'GPS location is read only at the moment you check in, to confirm you are within the allowed distance of the session location; that single coordinate is stored with the resulting attendance record. Location is never tracked continuously, and no separate location-history log is kept.',
    },
    lms: { provider: lms.provider, isMock: lms.isMock, status: lms.status, lastSyncAt: lms.lastSyncAt },
  });
}));

router.get('/compliance/retention', asyncHandler(async (req, res) => {
  res.json({ categories: await dataRetention.previewCounts(req.user.institution_id) });
}));

router.put('/compliance/retention', asyncHandler(async (req, res) => {
  const { category, enabled, days } = req.body || {};
  if (!category || !dataRetention.CATEGORIES[category]) return res.status(400).json({ error: 'Unknown retention category.' });
  const daysNum = Number(days);
  if (!Number.isFinite(daysNum) || daysNum < 1) return res.status(400).json({ error: 'days must be a positive number.' });
  const updated = await dataRetention.setConfig(req.user.institution_id, { [category]: { enabled: !!enabled, days: daysNum } });
  await logAudit(req.user.id, 'RETENTION_CONFIG_UPDATED', 'app_settings', null, { category, enabled: !!enabled, days: daysNum });
  res.json({ ok: true, categories: await dataRetention.previewCounts(req.user.institution_id), config: updated });
}));

// Destructive, admin-only, and requires an explicit confirm:true — the client
// must have already shown the admin the affected-row count from
// GET /compliance/retention before this can be called meaningfully. Scoped to
// the caller's own institution — can never delete another institution's rows.
router.post('/compliance/retention/cleanup', asyncHandler(async (req, res) => {
  const { category, confirm } = req.body || {};
  if (confirm !== true) return res.status(400).json({ error: 'Cleanup requires explicit confirmation.' });
  try {
    const result = await dataRetention.runCleanup(req.user.institution_id, category);
    await logAudit(req.user.id, 'RETENTION_CLEANUP_EXECUTED', 'app_settings', null, result);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

module.exports = router;
