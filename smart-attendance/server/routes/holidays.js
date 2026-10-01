const express = require('express');
const db = require('../db');
const { authenticate, authorize, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Readable by any authenticated role (student/faculty timetable views need to
// know about holidays too) — only create/update/delete are admin-only. Always
// scoped to the caller's own institution — two institutions may have
// completely different holiday calendars.
router.get('/', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const clauses = ['institution_id = ?'];
  const params = [req.user.institution_id];
  if (from) { clauses.push('holiday_date >= ?'); params.push(from); }
  if (to) { clauses.push('holiday_date <= ?'); params.push(to); }
  const where = 'WHERE ' + clauses.join(' AND ');
  const rows = await db.all(`SELECT id, holiday_date, name, description FROM holidays ${where} ORDER BY holiday_date ASC`, params);
  res.json({ rows });
}));

router.post('/', authorize('admin'), asyncHandler(async (req, res) => {
  const { holiday_date, name, description } = req.body || {};
  if (!holiday_date || !DATE_RE.test(holiday_date)) return res.status(400).json({ error: 'A valid holiday date (YYYY-MM-DD) is required.' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Holiday name is required.' });
  const dup = await db.get('SELECT 1 FROM holidays WHERE holiday_date = ? AND institution_id = ?', [holiday_date, req.user.institution_id]);
  if (dup) return res.status(409).json({ error: 'A holiday is already defined for this date.' });
  const info = await db.run(
    `INSERT INTO holidays (institution_id, holiday_date, name, description, created_by) VALUES (?,?,?,?,?)`,
    [req.user.institution_id, holiday_date, name.trim(), (description || '').trim() || null, req.user.id]
  );
  await logAudit(req.user.id, 'CREATE_HOLIDAY', 'holidays', info.lastInsertRowid, { holiday_date, name: name.trim() });
  res.status(201).json({ ok: true, id: info.lastInsertRowid });
}));

router.put('/:id', authorize('admin'), asyncHandler(async (req, res) => {
  const holiday = await db.get('SELECT * FROM holidays WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!holiday) return res.status(404).json({ error: 'Holiday not found.' });
  const body = req.body || {};
  const holiday_date = body.holiday_date !== undefined ? body.holiday_date : holiday.holiday_date;
  if (!DATE_RE.test(holiday_date)) return res.status(400).json({ error: 'A valid holiday date (YYYY-MM-DD) is required.' });
  const name = body.name !== undefined ? body.name.trim() : holiday.name;
  if (!name) return res.status(400).json({ error: 'Holiday name is required.' });
  const description = body.description !== undefined ? ((body.description || '').trim() || null) : holiday.description;

  if (holiday_date !== holiday.holiday_date) {
    const dup = await db.get('SELECT 1 FROM holidays WHERE holiday_date = ? AND institution_id = ? AND id != ?', [holiday_date, req.user.institution_id, holiday.id]);
    if (dup) return res.status(409).json({ error: 'A holiday is already defined for this date.' });
  }
  await db.run(
    `UPDATE holidays SET holiday_date=?, name=?, description=?, updated_at=datetime('now') WHERE id=?`,
    [holiday_date, name, description, holiday.id]
  );
  await logAudit(req.user.id, 'UPDATE_HOLIDAY', 'holidays', holiday.id, { holiday_date, name });
  res.json({ ok: true });
}));

router.delete('/:id', authorize('admin'), asyncHandler(async (req, res) => {
  const holiday = await db.get('SELECT * FROM holidays WHERE id = ? AND institution_id = ?', [req.params.id, req.user.institution_id]);
  if (!holiday) return res.status(404).json({ error: 'Holiday not found.' });
  await db.run('DELETE FROM holidays WHERE id = ?', [holiday.id]);
  await logAudit(req.user.id, 'DELETE_HOLIDAY', 'holidays', holiday.id, { holiday_date: holiday.holiday_date, name: holiday.name });
  res.json({ ok: true });
}));

module.exports = router;
