const db = require('../db');
const { THRESHOLD } = require('./analytics');

// Single shared row-fetcher behind every reporting surface (advanced reports,
// weekly reports, and the filtered CSV/PDF/Excel exports) so filter handling and
// the underlying join only exist in one place. Only ever reads settled (non-open)
// sessions — same convention used everywhere else in this codebase.
//
// Batch 6: institutionId is a required, separate argument (not just another
// optional `filters` key) specifically so it can never be accidentally
// omitted by a caller — every report/export in this app must be scoped to
// exactly one institution (or explicitly "all" only for a super_admin, which
// callers signal by passing institutionId === null).
async function fetchAttendanceRows(institutionId, filters = {}) {
  const clauses = ["cs.status != 'open'"];
  const params = [];
  if (institutionId != null) { clauses.push('c.institution_id = ?'); params.push(institutionId); }
  if (filters.from) { clauses.push('cs.date >= ?'); params.push(filters.from); }
  if (filters.to) { clauses.push('cs.date <= ?'); params.push(filters.to); }
  if (filters.department) { clauses.push('c.department = ?'); params.push(filters.department); }
  if (filters.course_id) { clauses.push('c.id = ?'); params.push(filters.course_id); }
  if (filters.course_ids && filters.course_ids.length) {
    clauses.push(`c.id IN (${filters.course_ids.map(() => '?').join(',')})`);
    params.push(...filters.course_ids);
  }
  if (filters.faculty_id) { clauses.push('f.id = ?'); params.push(filters.faculty_id); }
  if (filters.student_id) { clauses.push('s.id = ?'); params.push(filters.student_id); }
  if (filters.status) {
    // 'excused' isn't a real attendance.status value — filter on the same
    // effective-status expression the SELECT below computes, so the filter and
    // the reported breakdown never disagree with each other.
    clauses.push(`(CASE WHEN a.status = 'absent' AND ex.id IS NOT NULL THEN 'excused' ELSE a.status END) = ?`);
    params.push(filters.status);
  }
  const where = clauses.join(' AND ');
  // effective_status reclassifies an 'absent' row as 'excused' ONLY when an
  // approved excuse exists for that exact (student, session) — the attendance
  // row itself is never touched, this is purely a reporting-time relabel.
  return db.all(`
    SELECT cs.date, a.status,
           CASE WHEN a.status = 'absent' AND ex.id IS NOT NULL THEN 'excused' ELSE a.status END as effective_status,
           a.method, cs.id as session_id,
           c.id as course_id, c.course_code, c.course_name, c.department,
           s.id as student_id, s.roll_number, s.name as student_name,
           f.id as faculty_id, u.name as faculty_name,
           strftime('%Y-%m-%d', cs.date) as day_key,
           strftime('%Y-W%W', cs.date) as week_key,
           strftime('%Y-%m', cs.date) as month_key
    FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    JOIN courses c ON c.id = cs.course_id
    JOIN students s ON s.id = a.student_id
    JOIN faculty f ON f.id = cs.faculty_id
    JOIN users u ON u.id = f.user_id
    LEFT JOIN student_excuses ex ON ex.student_id = a.student_id AND ex.session_id = a.session_id AND ex.status = 'approved'
    WHERE ${where}
    ORDER BY cs.date ASC
  `, params);
}

// Attendance-percentage rule for excused sessions (applied consistently across
// student/faculty/admin reports): an approved excuse is never counted as
// Present, and is also excluded from the percentage denominator entirely —
// it neither helps nor hurts the percentage, it just doesn't count. It IS
// still reported as its own "excused" figure for transparency.
function summarize(rows) {
  const total = rows.length;
  const presentCount = rows.filter(r => r.effective_status === 'present').length;
  const absentCount = rows.filter(r => r.effective_status === 'absent').length;
  const lateCount = rows.filter(r => r.effective_status === 'late').length;
  const excusedCount = rows.filter(r => r.effective_status === 'excused').length;
  const countedTotal = total - excusedCount;
  const overallPct = countedTotal ? Math.round(((presentCount + lateCount) / countedTotal) * 100) : 0;
  const totalSessions = new Set(rows.map(r => r.session_id)).size;
  return { totalRecords: total, totalSessions, presentCount, absentCount, lateCount, excusedCount, overallPct };
}

// Generic group-and-score: groups rows by keyFn, counts present/absent/late/excused
// per group, and returns each group's attendance % (excused excluded from the
// denominator — see summarize() above). Reused for department-wise, course-wise,
// student-wise, and daily/weekly/monthly trend breakdowns.
function groupBy(rows, keyFn, labelFn) {
  const map = {};
  for (const r of rows) {
    const key = keyFn(r);
    if (key == null) continue;
    if (!map[key]) map[key] = { key, label: labelFn(r), total: 0, present: 0, absent: 0, late: 0, excused: 0 };
    const g = map[key];
    g.total++;
    if (r.effective_status === 'present') g.present++;
    else if (r.effective_status === 'absent') g.absent++;
    else if (r.effective_status === 'late') g.late++;
    else if (r.effective_status === 'excused') g.excused++;
  }
  return Object.values(map).map(g => {
    const countedTotal = g.total - g.excused;
    return { ...g, pct: countedTotal ? Math.round(((g.present + g.late) / countedTotal) * 100) : 0 };
  });
}

async function entityCounts(institutionId, filters = {}) {
  const instClause = institutionId != null ? ' AND institution_id = ?' : '';
  const instParam = institutionId != null ? [institutionId] : [];
  if (filters.department) {
    const [students, faculty, courses] = await Promise.all([
      db.get(`SELECT COUNT(*) c FROM students WHERE department = ?${instClause}`, [filters.department, ...instParam]),
      db.get(`SELECT COUNT(*) c FROM faculty WHERE department = ?${instClause}`, [filters.department, ...instParam]),
      db.get(`SELECT COUNT(*) c FROM courses WHERE department = ? AND status='active'${instClause}`, [filters.department, ...instParam]),
    ]);
    return { totalStudents: Number(students.c), totalFaculty: Number(faculty.c), totalCourses: Number(courses.c) };
  }
  const [students, faculty, courses] = await Promise.all([
    db.get(`SELECT COUNT(*) c FROM students WHERE 1=1${instClause}`, instParam),
    db.get(`SELECT COUNT(*) c FROM faculty WHERE 1=1${instClause}`, instParam),
    db.get(`SELECT COUNT(*) c FROM courses WHERE status='active'${instClause}`, instParam),
  ]);
  return { totalStudents: Number(students.c), totalFaculty: Number(faculty.c), totalCourses: Number(courses.c) };
}

const TOP_N = 10;

async function buildAdvancedReport(institutionId, filters = {}) {
  const rows = await fetchAttendanceRows(institutionId, filters);
  const totals = summarize(rows);
  const departmentWise = groupBy(rows, r => r.department, r => r.department);
  const courseWise = groupBy(rows, r => r.course_id, r => r.course_name);
  const studentWise = groupBy(rows, r => r.student_id, r => r.student_name)
    .map((g, i, arr) => {
      const src = rows.find(r => r.student_id === g.key);
      return { ...g, roll_number: src ? src.roll_number : null };
    });
  const daily = groupBy(rows, r => r.day_key, r => r.day_key).sort((a, b) => a.key < b.key ? -1 : 1);
  const weekly = groupBy(rows, r => r.week_key, r => r.week_key).sort((a, b) => a.key < b.key ? -1 : 1);
  const monthly = groupBy(rows, r => r.month_key, r => r.month_key).sort((a, b) => a.key < b.key ? -1 : 1);

  return {
    filters,
    totals,
    entityCounts: await entityCounts(institutionId, filters),
    departmentWise,
    courseWise,
    studentWise,
    trend: { daily, weekly, monthly },
    belowThreshold: studentWise.filter(s => s.total > 0 && s.pct < THRESHOLD).sort((a, b) => a.pct - b.pct),
    highestStudents: [...studentWise].sort((a, b) => b.pct - a.pct).slice(0, TOP_N),
    lowestStudents: [...studentWise].sort((a, b) => a.pct - b.pct).slice(0, TOP_N),
    mostAttendedCourses: [...courseWise].sort((a, b) => b.pct - a.pct).slice(0, TOP_N),
    poorAttendanceCourses: [...courseWise].sort((a, b) => a.pct - b.pct).slice(0, TOP_N),
  };
}

// Monday..Sunday boundaries (as 'YYYY-MM-DD') for the week containing `anchor`
// (a Date; defaults to now).
function weekBounds(anchor = new Date()) {
  const d = new Date(anchor);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { weekStart: fmt(monday), weekEnd: fmt(sunday) };
}

async function buildWeeklyReport(institutionId, filters = {}, anchorDate) {
  const { weekStart, weekEnd } = weekBounds(anchorDate ? new Date(anchorDate) : new Date());
  const prevAnchor = new Date(weekStart);
  prevAnchor.setDate(prevAnchor.getDate() - 7);
  const { weekStart: prevStart, weekEnd: prevEnd } = weekBounds(prevAnchor);

  const [currentRows, previousRows] = await Promise.all([
    fetchAttendanceRows(institutionId, { ...filters, from: weekStart, to: weekEnd }),
    fetchAttendanceRows(institutionId, { ...filters, from: prevStart, to: prevEnd }),
  ]);

  const totals = summarize(currentRows);
  const previousTotals = summarize(previousRows);
  const deltaPct = totals.totalRecords && previousTotals.totalRecords ? totals.overallPct - previousTotals.overallPct : null;

  return {
    weekStart, weekEnd,
    totals,
    departmentWise: groupBy(currentRows, r => r.department, r => r.department),
    courseWise: groupBy(currentRows, r => r.course_id, r => r.course_name),
    belowThreshold: groupBy(currentRows, r => r.student_id, r => r.student_name)
      .map(g => ({ ...g, roll_number: (currentRows.find(r => r.student_id === g.key) || {}).roll_number || null }))
      .filter(s => s.total > 0 && s.pct < THRESHOLD)
      .sort((a, b) => a.pct - b.pct),
    previousWeek: { weekStart: prevStart, weekEnd: prevEnd, totals: previousTotals },
    comparison: {
      deltaPct,
      trend: deltaPct == null ? 'no-data' : deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat'
    }
  };
}

module.exports = { fetchAttendanceRows, summarize, groupBy, entityCounts, buildAdvancedReport, buildWeeklyReport, weekBounds, TOP_N };
