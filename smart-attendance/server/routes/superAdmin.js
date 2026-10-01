// Batch 6 — Super Admin surface: institution management only. Deliberately a
// SEPARATE, narrow route file rather than folding cross-institution powers
// into admin.js — a super_admin is NOT "every admin route, but global," it's
// a distinct role with a distinct, much smaller job (create/manage
// institutions, see light cross-institution stats). Regular institution-admin
// routes in admin.js remain authorize('admin') only and are never reachable
// by this role, by design — see the architecture note in the Batch 6 report.
const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate, authorize('super_admin'));

const CODE_RE = /^[A-Z0-9]{2,20}$/;

async function institutionStats(institutionId) {
  const [students, faculty, courses, admins, attendanceRecords] = await Promise.all([
    db.get('SELECT COUNT(*) c FROM students WHERE institution_id = ?', [institutionId]),
    db.get('SELECT COUNT(*) c FROM faculty WHERE institution_id = ?', [institutionId]),
    db.get(`SELECT COUNT(*) c FROM courses WHERE institution_id = ? AND status='active'`, [institutionId]),
    db.get(`SELECT COUNT(*) c FROM users WHERE institution_id = ? AND role='admin'`, [institutionId]),
    db.get('SELECT COUNT(*) c FROM attendance WHERE institution_id = ?', [institutionId]),
  ]);
  return {
    students: Number(students.c), faculty: Number(faculty.c), courses: Number(courses.c),
    admins: Number(admins.c), attendanceRecords: Number(attendanceRecords.c),
  };
}

router.get('/institutions', asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT * FROM institutions ORDER BY created_at ASC');
  const withStats = await Promise.all(rows.map(async (i) => ({ ...i, stats: await institutionStats(i.id) })));
  res.json({ rows: withStats });
}));

router.get('/institutions/:id', asyncHandler(async (req, res) => {
  const inst = await db.get('SELECT * FROM institutions WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: 'Institution not found.' });
  res.json({ institution: inst, stats: await institutionStats(inst.id) });
}));

router.post('/institutions', asyncHandler(async (req, res) => {
  const { code, name } = req.body || {};
  const normCode = (code || '').trim().toUpperCase();
  if (!CODE_RE.test(normCode)) return res.status(400).json({ error: 'Institution code must be 2-20 letters/numbers (e.g. TESTENG).' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Institution name is required.' });
  const dup = await db.get('SELECT 1 FROM institutions WHERE code = ?', [normCode]);
  if (dup) return res.status(409).json({ error: `Institution code "${normCode}" already exists.` });
  const info = await db.run(`INSERT INTO institutions (code, name, status) VALUES (?,?,'active')`, [normCode, name.trim()]);
  await logAudit(req.user.id, 'CREATE_INSTITUTION', 'institutions', info.lastInsertRowid, { code: normCode, name: name.trim() });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

// Code is intentionally immutable — every user/student/faculty/course row
// carries institution_id as a numeric FK (not the code), so renaming the code
// itself is always safe, but changing it here is still avoided to match the
// same "codes are stable identifiers" convention departments already use.
router.put('/institutions/:id', asyncHandler(async (req, res) => {
  const inst = await db.get('SELECT * FROM institutions WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: 'Institution not found.' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : inst.name;
  if (!name) return res.status(400).json({ error: 'Institution name is required.' });
  await db.run(`UPDATE institutions SET name=?, updated_at=datetime('now') WHERE id=?`, [name, inst.id]);
  await logAudit(req.user.id, 'UPDATE_INSTITUTION', 'institutions', inst.id, { name });
  res.json({ ok: true });
}));

router.put('/institutions/:id/status', asyncHandler(async (req, res) => {
  const inst = await db.get('SELECT * FROM institutions WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: 'Institution not found.' });
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'status must be "active" or "inactive".' });
  await db.run(`UPDATE institutions SET status=?, updated_at=datetime('now') WHERE id=?`, [status, inst.id]);
  await logAudit(req.user.id, status === 'active' ? 'ACTIVATE_INSTITUTION' : 'DEACTIVATE_INSTITUTION', 'institutions', inst.id, { code: inst.code });
  res.json({ ok: true });
}));

// Light aggregate across every institution — counts only, no student/user
// names or other per-person detail. Used for a super_admin overview screen.
router.get('/overview', asyncHandler(async (req, res) => {
  const institutions = await db.all('SELECT * FROM institutions ORDER BY created_at ASC');
  const [totalStudentsRow, totalFacultyRow, totalAttendanceRow] = await Promise.all([
    db.get('SELECT COUNT(*) c FROM students'),
    db.get('SELECT COUNT(*) c FROM faculty'),
    db.get('SELECT COUNT(*) c FROM attendance'),
  ]);
  const withStats = await Promise.all(institutions.map(async (i) => ({ ...i, stats: await institutionStats(i.id) })));
  res.json({
    totalInstitutions: institutions.length,
    activeInstitutions: institutions.filter(i => i.status === 'active').length,
    totalStudents: Number(totalStudentsRow.c), totalFaculty: Number(totalFacultyRow.c), totalAttendanceRecords: Number(totalAttendanceRow.c),
    institutions: withStats,
  });
}));

module.exports = router;
