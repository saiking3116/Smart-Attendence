const db = require('../db');

const THRESHOLD = 75;

// Overall + subject-wise attendance for a student, computed from real attendance
// rows. An approved excuse (Batch 3) reclassifies an 'absent' row as "excused":
// it is removed from the total/percentage entirely (neither helps nor hurts),
// but is still tracked and returned separately so the UI can show it. The
// attendance row itself is never modified — this is a read-time relabel only.
async function studentAttendanceSummary(studentId) {
  const rows = await db.all(`
    SELECT c.id as course_id, c.course_code, c.course_name,
           a.status, ex.id as excuse_id
    FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN class_sessions cs ON cs.course_id = c.id AND cs.status != 'open'
    LEFT JOIN attendance a ON a.session_id = cs.id AND a.student_id = e.student_id
    LEFT JOIN student_excuses ex ON ex.student_id = e.student_id AND ex.session_id = cs.id AND ex.status = 'approved'
    WHERE e.student_id = ?
  `, [studentId]);

  const bySubject = {};
  for (const r of rows) {
    if (!r.course_id) continue;
    if (!bySubject[r.course_id]) bySubject[r.course_id] = { name: r.course_name, code: r.course_code, total: 0, present: 0, excused: 0 };
    if (r.status === null) continue; // session exists but no session was actually held/counted (shouldn't happen once seeded)
    const isExcused = r.status === 'absent' && r.excuse_id != null;
    if (isExcused) {
      bySubject[r.course_id].excused += 1;
      continue;
    }
    bySubject[r.course_id].total += 1;
    if (r.status === 'present' || r.status === 'late') bySubject[r.course_id].present += 1;
  }

  const subjects = Object.entries(bySubject).map(([courseId, s]) => ({
    courseId: Number(courseId), name: s.name, code: s.code, total: s.total, present: s.present, excused: s.excused,
    pct: s.total ? Math.round((s.present / s.total) * 100) : 0
  }));

  const totalClasses = subjects.reduce((a, b) => a + b.total, 0);
  const totalPresent = subjects.reduce((a, b) => a + b.present, 0);
  const totalExcused = subjects.reduce((a, b) => a + b.excused, 0);
  const overall = totalClasses ? Math.round((totalPresent / totalClasses) * 100) : 0;

  return { subjects, overall, totalClasses, totalPresent, totalExcused };
}

// how many consecutive future classes (of a given weekly pace) needed to reach 75%, or null if not reachable within cap
function classesNeededFor75(present, total, cap = 30) {
  if (total === 0) return { needed: 0, reachable: true };
  let p = present, t = total, needed = 0;
  const currentPct = (p / t) * 100;
  if (currentPct >= THRESHOLD) return { needed: 0, reachable: true };
  while ((p / t) * 100 < THRESHOLD && needed < cap) {
    p += 1; t += 1; needed += 1;
  }
  return { needed, reachable: (p / t) * 100 >= THRESHOLD };
}

function riskLevel(pct) {
  if (pct >= 85) return 'Low Risk';
  if (pct >= 75) return 'Low Risk';
  if (pct >= 65) return 'Medium Risk';
  return 'High Risk';
}

// Simple, student-facing status label (distinct wording from the admin/faculty
// "risk" terminology — a student's own dashboard shouldn't read like a fraud report).
function attendanceStatusLabel(pct) {
  if (pct >= THRESHOLD) return 'Good';
  if (pct >= THRESHOLD - 10) return 'Warning';
  return 'Critical';
}

// One-sentence, plain-language prediction reusing classesNeededFor75 — never a
// separate calculation, so the number always agrees with the rest of the dashboard.
function predictionText(present, total) {
  const need = classesNeededFor75(present, total);
  if (total === 0) return 'Not enough attendance data yet to make a prediction.';
  const currentPct = Math.round((present / total) * 100);
  if (currentPct >= THRESHOLD) return `You're at ${currentPct}% — already meeting the ${THRESHOLD}% requirement.`;
  if (!need.reachable) return `At your current attendance rate, reaching ${THRESHOLD}% is not possible within the next 30 classes — talk to your faculty advisor.`;
  return `At your current attendance rate, you need ${need.needed} more consecutive class${need.needed === 1 ? '' : 'es'} to reach ${THRESHOLD}%.`;
}

async function studentInsights(studentId) {
  const summary = await studentAttendanceSummary(studentId);
  const insights = [];

  if (summary.subjects.length) {
    const weakest = [...summary.subjects].sort((a, b) => a.pct - b.pct)[0];
    const strongest = [...summary.subjects].sort((a, b) => b.pct - a.pct)[0];
    if (weakest) insights.push(`${weakest.name} is your weakest subject at ${weakest.pct}% attendance.`);
    if (strongest && strongest.name !== weakest.name) insights.push(`${strongest.name} is your strongest subject at ${strongest.pct}% attendance.`);
  }

  // trend over last 3 weeks vs prior weeks using raw attendance rows (excused
  // absences excluded, same rule as the rest of reporting)
  const allRows = await db.all(`
    SELECT a.status, cs.date, ex.id as excuse_id
    FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    LEFT JOIN student_excuses ex ON ex.student_id = a.student_id AND ex.session_id = a.session_id AND ex.status = 'approved'
    WHERE a.student_id = ? AND cs.status != 'open'
    ORDER BY cs.date ASC
  `, [studentId]);
  const rows = allRows.filter(r => !(r.status === 'absent' && r.excuse_id != null));

  if (rows.length >= 6) {
    const mid = Math.floor(rows.length / 2);
    const firstHalf = rows.slice(0, mid);
    const secondHalf = rows.slice(mid);
    const pct = (arr) => arr.length ? Math.round((arr.filter(r => r.status !== 'absent').length / arr.length) * 100) : 0;
    const p1 = pct(firstHalf), p2 = pct(secondHalf);
    const delta = p2 - p1;
    if (delta > 0) insights.push(`Attendance improved ${delta}% comparing the most recent classes to earlier ones.`);
    else if (delta < 0) insights.push(`Attendance dropped ${Math.abs(delta)}% comparing the most recent classes to earlier ones.`);
  }

  const missedThisMonth = rows.filter(r => r.status === 'absent' && r.date >= monthAgo()).length;
  if (missedThisMonth > 0) insights.push(`You have missed ${missedThisMonth} class${missedThisMonth === 1 ? '' : 'es'} in the last 30 days.`);

  if (summary.overall < THRESHOLD) insights.push(`You are at risk of falling below the ${THRESHOLD}% attendance requirement.`);
  else insights.push(`You are currently meeting the ${THRESHOLD}% attendance requirement.`);

  return insights;
}

function monthAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

// Ordered (oldest->newest) attendance rows for a student, optionally scoped to
// one course, with approved-excused absences already excluded — the same rule
// studentAttendanceSummary/studentInsights use. Exposed so trend/streak logic
// (Batch 5 predictive analytics) has one shared source for the raw sequence
// instead of a third copy of this excuse-aware join.
async function getStudentAttendanceRows(studentId, courseId) {
  const clauses = ['a.student_id = ?', "cs.status != 'open'"];
  const params = [studentId];
  if (courseId) { clauses.push('cs.course_id = ?'); params.push(courseId); }
  const rows = await db.all(`
    SELECT a.status, cs.date, ex.id as excuse_id
    FROM attendance a
    JOIN class_sessions cs ON cs.id = a.session_id
    LEFT JOIN student_excuses ex ON ex.student_id = a.student_id AND ex.session_id = a.session_id AND ex.status = 'approved'
    WHERE ${clauses.join(' AND ')}
    ORDER BY cs.date ASC, a.marked_at ASC
  `, params);
  return rows.filter(r => !(r.status === 'absent' && r.excuse_id != null)).map(r => ({ status: r.status, date: r.date }));
}

module.exports = {
  THRESHOLD, studentAttendanceSummary, classesNeededFor75, riskLevel, studentInsights,
  attendanceStatusLabel, predictionText, getStudentAttendanceRows
};
