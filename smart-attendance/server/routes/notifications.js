const express = require('express');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { getPreferences, upsertPreferences } = require('../utils/notificationService');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.all(`SELECT * FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const unread = rows.filter(r => !r.read).length;
  res.json({ rows, unread });
}));

router.put('/:id/read', asyncHandler(async (req, res) => {
  const n = await db.get('SELECT * FROM notifications WHERE id = ? AND recipient_id = ?', [req.params.id, req.user.id]);
  if (!n) return res.status(404).json({ error: 'Notification not found.' });
  await db.run('UPDATE notifications SET read = TRUE WHERE id = ?', [n.id]);
  res.json({ ok: true });
}));

router.put('/read-all', asyncHandler(async (req, res) => {
  await db.run('UPDATE notifications SET read = TRUE WHERE recipient_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

/* ---------------- Feature: Notification preferences ---------------- */
// Same shape for every role — the UI only shows the checkboxes relevant to the
// signed-in user's role; unused columns are simply never read for that role.
router.get('/preferences', asyncHandler(async (req, res) => {
  res.json(await getPreferences(req.user.id));
}));

router.put('/preferences', asyncHandler(async (req, res) => {
  const { low_attendance_alerts, weekly_reports, excuse_updates, system_notifications } = req.body || {};
  const patch = {};
  if (low_attendance_alerts !== undefined) patch.low_attendance_alerts = !!low_attendance_alerts;
  if (weekly_reports !== undefined) patch.weekly_reports = !!weekly_reports;
  if (excuse_updates !== undefined) patch.excuse_updates = !!excuse_updates;
  if (system_notifications !== undefined) patch.system_notifications = !!system_notifications;
  res.json(await upsertPreferences(req.user.id, patch));
}));

module.exports = router;
