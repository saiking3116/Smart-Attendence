const db = require('../db');
const { notifyExcuseReviewed } = require('./notificationService');

async function getStudentByUserId(userId) {
  return db.get('SELECT * FROM students WHERE user_id = ?', [userId]);
}
async function getFacultyByUserId(userId) {
  return db.get('SELECT * FROM faculty WHERE user_id = ?', [userId]);
}

// A session is "eligible" for an excuse request if the student is enrolled in
// its course, the session has actually settled (not still open — you can't
// excuse a class that hasn't finished), and there isn't already an excuse
// covering it (the UNIQUE(student_id, session_id) constraint is the hard
// backstop; this is what keeps the picker from offering a duplicate).
async function getEligibleSessions(studentId) {
  return db.all(`
    SELECT cs.id as session_id, cs.date, cs.start_time, cs.end_time, c.id as course_id, c.course_name,
           u.name as faculty_name, a.status as attendance_status
    FROM class_sessions cs
    JOIN courses c ON c.id = cs.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.student_id = ?
    JOIN faculty f ON f.id = cs.faculty_id
    JOIN users u ON u.id = f.user_id
    LEFT JOIN attendance a ON a.session_id = cs.id AND a.student_id = e.student_id
    WHERE cs.status != 'open'
      AND NOT EXISTS (SELECT 1 FROM student_excuses ex WHERE ex.student_id = e.student_id AND ex.session_id = cs.id)
    ORDER BY cs.date DESC, cs.start_time DESC
    LIMIT 100
  `, [studentId]);
}

function excuseRowShape(prefix = 'ex') {
  return `
    ${prefix}.id, ${prefix}.student_id, ${prefix}.session_id, ${prefix}.course_id, ${prefix}.reason, ${prefix}.details,
    ${prefix}.status, ${prefix}.reviewer_id, ${prefix}.reviewer_comment,
    ${prefix}.created_at, ${prefix}.updated_at, ${prefix}.reviewed_at`;
}

// Joined, display-ready excuse rows for any WHERE clause the caller supplies.
async function fetchExcuses(whereClause, params) {
  return db.all(`
    SELECT ${excuseRowShape()},
           s.roll_number, s.name as student_name,
           c.course_name, c.course_code,
           cs.date as session_date, cs.start_time, cs.end_time,
           ru.name as reviewer_name
    FROM student_excuses ex
    JOIN students s ON s.id = ex.student_id
    JOIN courses c ON c.id = ex.course_id
    JOIN class_sessions cs ON cs.id = ex.session_id
    LEFT JOIN users ru ON ru.id = ex.reviewer_id
    ${whereClause}
    ORDER BY ex.created_at DESC
  `, params);
}

// True if this faculty member teaches the course a given course_id belongs to.
async function facultyOwnsCourse(facultyId, courseId) {
  return !!(await db.get('SELECT 1 FROM courses WHERE id = ? AND faculty_id = ?', [courseId, facultyId]));
}

// Shared by both faculty and admin review endpoints — fire-and-forget, never
// awaited by the caller before responding. Looks up the student's user record
// itself so both call sites stay a single line.
async function notifyStudentOfReview(excuseId, status, reviewerComment) {
  try {
    const info = await db.get(`
      SELECT c.course_name, cs.date as session_date, u.id as student_user_id, u.name as student_name, u.email as student_email
      FROM student_excuses ex
      JOIN courses c ON c.id = ex.course_id
      JOIN class_sessions cs ON cs.id = ex.session_id
      JOIN students s ON s.id = ex.student_id
      JOIN users u ON u.id = s.user_id
      WHERE ex.id = ?
    `, [excuseId]);
    if (!info) return;
    await notifyExcuseReviewed({
      studentUser: { id: info.student_user_id, name: info.student_name, email: info.student_email },
      courseName: info.course_name, sessionDate: info.session_date, status, reviewerComment
    });
  } catch (err) {
    console.error('[email] excuse-reviewed notify failed:', err.message);
  }
}

module.exports = { getStudentByUserId, getFacultyByUserId, getEligibleSessions, fetchExcuses, facultyOwnsCourse, notifyStudentOfReview };
