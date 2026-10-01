const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);
// Staff-only end to end — a student token never satisfies this, regardless of
// which student_id/note id is requested, so there is no path for a student to
// reach their own (or anyone else's) notes through this router.
router.use(authorize('faculty', 'admin'));

async function getFacultyByUser(userId) {
  return db.get('SELECT * FROM faculty WHERE user_id = ?', [userId]);
}

// True only if this faculty member teaches at least one course the student is
// enrolled in. Re-checked on every read/write below — never trust a prior check
// or anything the client claims. (Institution-safe by construction: a faculty
// member's own courses can only ever be in their own institution.)
async function facultyCanAccessStudent(facultyId, studentId) {
  return !!(await db.get(`
    SELECT 1 FROM enrollments e
    JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = ? AND c.faculty_id = ?
    LIMIT 1
  `, [studentId, facultyId]));
}

// Resolves the acting user's access level for a given student: returns
// { ok, facultyId } — facultyId is null for admin (unrestricted WITHIN their
// own institution — an admin is never unrestricted across institutions).
async function resolveAccess(req, student) {
  if (!student) return { ok: false };
  if (student.institution_id !== req.user.institution_id) return { ok: false }; // cross-institution: always denied, even for admin
  if (req.user.role === 'admin') return { ok: true, facultyId: null };
  const faculty = await getFacultyByUser(req.user.id);
  if (!faculty) return { ok: false };
  return { ok: await facultyCanAccessStudent(faculty.id, student.id), facultyId: faculty.id };
}

router.get('/student/:studentId', asyncHandler(async (req, res) => {
  const studentId = Number(req.params.studentId);
  const student = await db.get('SELECT id, roll_number, name, institution_id FROM students WHERE id = ?', [studentId]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const access = await resolveAccess(req, student);
  if (!access.ok) return res.status(403).json({ error: 'You do not have access to this student\'s notes.' });

  const rows = await db.all(`
    SELECT n.id, n.student_id, n.author_id, n.author_role, n.course_id, n.content, n.created_at, n.updated_at,
           u.name as author_name, c.course_name
    FROM student_notes n
    JOIN users u ON u.id = n.author_id
    LEFT JOIN courses c ON c.id = n.course_id
    WHERE n.student_id = ?
    ORDER BY n.created_at DESC
  `, [studentId]);

  res.json({ student: { id: student.id, roll_number: student.roll_number, name: student.name }, rows: rows.map(r => ({ ...r, isOwn: r.author_id === req.user.id })) });
}));

router.post('/student/:studentId', asyncHandler(async (req, res) => {
  const studentId = Number(req.params.studentId);
  const student = await db.get('SELECT id, institution_id FROM students WHERE id = ?', [studentId]);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const access = await resolveAccess(req, student);
  if (!access.ok) return res.status(403).json({ error: 'You do not have access to this student\'s notes.' });

  const { content, course_id } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Note content is required.' });

  let courseId = null;
  if (course_id) {
    // A faculty member may only tag a note with a course they actually teach —
    // prevents spoofing course context to imply a relationship that doesn't
    // exist. An admin may only tag a course from their own institution.
    const course = await db.get('SELECT id, faculty_id, institution_id FROM courses WHERE id = ?', [course_id]);
    if (!course || course.institution_id !== req.user.institution_id) return res.status(400).json({ error: 'Course not found.' });
    if (req.user.role === 'faculty' && course.faculty_id !== access.facultyId) {
      return res.status(403).json({ error: 'You may only tag notes with a course you teach.' });
    }
    courseId = course.id;
  }

  const info = await db.run(`
    INSERT INTO student_notes (institution_id, student_id, author_id, author_role, course_id, content)
    VALUES (?,?,?,?,?,?)
  `, [req.user.institution_id, studentId, req.user.id, req.user.role, courseId, content.trim()]);
  await logAudit(req.user.id, 'CREATE_STUDENT_NOTE', 'student_notes', info.lastInsertRowid, { student_id: studentId });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

// Both PUT and DELETE below: admin may act on any note IN THEIR OWN
// INSTITUTION; faculty may only act on their own (author_id === req.user.id)
// — checked here, server-side, not left to the UI to hide a button.
router.put('/:noteId', asyncHandler(async (req, res) => {
  const note = await db.get('SELECT * FROM student_notes WHERE id = ? AND institution_id = ?', [req.params.noteId, req.user.institution_id]);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  if (req.user.role !== 'admin' && note.author_id !== req.user.id) {
    return res.status(403).json({ error: 'You may only edit your own notes.' });
  }
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Note content is required.' });
  await db.run(`UPDATE student_notes SET content = ?, updated_at = datetime('now') WHERE id = ?`, [content.trim(), note.id]);
  await logAudit(req.user.id, 'UPDATE_STUDENT_NOTE', 'student_notes', note.id, { student_id: note.student_id });
  res.json({ ok: true });
}));

router.delete('/:noteId', asyncHandler(async (req, res) => {
  const note = await db.get('SELECT * FROM student_notes WHERE id = ? AND institution_id = ?', [req.params.noteId, req.user.institution_id]);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  if (req.user.role !== 'admin' && note.author_id !== req.user.id) {
    return res.status(403).json({ error: 'You may only delete your own notes.' });
  }
  await db.run('DELETE FROM student_notes WHERE id = ?', [note.id]);
  await logAudit(req.user.id, 'DELETE_STUDENT_NOTE', 'student_notes', note.id, { student_id: note.student_id });
  res.json({ ok: true });
}));

module.exports = router;
