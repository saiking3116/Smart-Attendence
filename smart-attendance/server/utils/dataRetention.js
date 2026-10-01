// Batch 5 — Data retention configuration + manual cleanup.
// Batch 6 — every function here now takes institutionId as its first
// argument: an institution admin's retention config, preview counts, and
// cleanup runs are all scoped to their OWN institution's rows only — a
// cleanup run can never delete another institution's audit/email/LMS/risk
// rows, even ones older than the configured cutoff.
//
// This app has no background job scheduler, so "automatic" retention would
// mean silently deleting data on some timer with no admin in the loop — not
// acceptable for anything touching attendance-adjacent records. Instead this
// module gives the admin a transparent, manual, one-category-at-a-time
// cleanup: see exactly how many rows are older than the configured cutoff,
// then explicitly confirm before anything is deleted. Nothing here ever runs
// on its own; every deletion is a direct result of an authenticated admin
// action and is itself audited via logAudit.
//
// Config is stored the same way location_config and the LMS integration
// state already are — a JSON blob under one (now institution-namespaced)
// app_settings key — rather than a new one-row table.
const db = require('../db');
const { getSetting, setSetting } = require('./sessionAuto');

const SETTINGS_KEY = 'data_retention_config';
const DEFAULT_DAYS = 365;

// "attendance" is intentionally NOT deletable — it is the authoritative
// academic record this entire app exists to protect. It is still listed here
// (shown in the admin UI as policy documentation, always 0 affected/disabled)
// so retention policy is visible even where cleanup is deliberately unavailable.
const CATEGORIES = {
  audit_logs: {
    table: 'audit_logs', dateCol: 'timestamp', label: 'Audit logs', deletable: true,
    note: 'The security/admin-action audit trail. Deleting old entries reduces how far back activity can be reviewed — the cleanup action itself is always logged.'
  },
  email_notification_log: {
    table: 'email_notification_log', dateCol: 'created_at', label: 'Notification / email logs', deletable: true,
    note: 'Records that an email was sent or mocked by the app — not the email content itself.'
  },
  lms_sync_logs: {
    table: 'lms_sync_logs', dateCol: 'started_at', label: 'LMS sync logs', deletable: true,
    note: 'History of LMS integration sync runs. Does not affect course mappings or enrollments already synced.'
  },
  risk_events: {
    table: 'risk_events', dateCol: 'created_at', label: 'Risk events (anti-proxy detection)', deletable: true,
    note: 'Fraud-detection scoring history for check-in attempts. Deleting this never changes the underlying attendance record.'
  },
  attendance: {
    table: 'attendance', dateCol: 'marked_at', label: 'Attendance records', deletable: false,
    note: 'The authoritative attendance record. Retained indefinitely — shown for policy documentation only; bulk cleanup of this category is intentionally not available.'
  },
};

function defaultConfig() {
  const cfg = {};
  for (const key of Object.keys(CATEGORIES)) cfg[key] = { enabled: false, days: DEFAULT_DAYS };
  return cfg;
}

async function getConfig(institutionId) {
  const stored = await getSetting(institutionId, SETTINGS_KEY, {});
  const cfg = defaultConfig();
  for (const key of Object.keys(cfg)) {
    if (stored[key]) cfg[key] = { enabled: !!stored[key].enabled, days: Math.max(1, Number(stored[key].days) || DEFAULT_DAYS) };
  }
  return cfg;
}

async function setConfig(institutionId, patch) {
  const current = await getConfig(institutionId);
  for (const [key, val] of Object.entries(patch || {})) {
    if (!CATEGORIES[key] || !val) continue;
    current[key] = { enabled: !!val.enabled, days: Math.max(1, Number(val.days) || DEFAULT_DAYS) };
  }
  await setSetting(institutionId, SETTINGS_KEY, current);
  return current;
}

// Read-only: for every category, how many rows (within this institution only)
// are older than its configured cutoff right now. Used both by the compliance
// dashboard and as the mandatory "affected data" count shown before a cleanup
// is confirmed.
async function previewCounts(institutionId) {
  const cfg = await getConfig(institutionId);
  const out = {};
  for (const [key, meta] of Object.entries(CATEGORIES)) {
    const totalRow = await db.get(`SELECT COUNT(*) c FROM ${meta.table} WHERE institution_id = ?`, [institutionId]);
    const affectedCount = meta.deletable
      ? Number((await db.get(`SELECT COUNT(*) c FROM ${meta.table} WHERE institution_id = ? AND ${meta.dateCol} < datetime('now', '-' || ? || ' days')`, [institutionId, cfg[key].days])).c)
      : 0;
    out[key] = { label: meta.label, note: meta.note, deletable: meta.deletable, enabled: cfg[key].enabled, days: cfg[key].days, affectedCount, totalCount: Number(totalRow.c) };
  }
  return out;
}

// Deletes rows older than the cutoff for exactly one category, scoped to this
// institution only. Never invoked on a timer — only ever reachable via an
// explicit, admin-only, confirmed API call. Throws (refuses) for any
// non-deletable category, e.g. attendance.
async function runCleanup(institutionId, categoryKey, daysOverride) {
  const meta = CATEGORIES[categoryKey];
  if (!meta) throw new Error('Unknown retention category.');
  if (!meta.deletable) throw new Error(`"${meta.label}" cannot be cleaned up here — it is retained indefinitely as the authoritative record.`);
  const cfg = await getConfig(institutionId);
  const days = Math.max(1, Number(daysOverride) || cfg[categoryKey].days);
  const affectedRow = await db.get(`SELECT COUNT(*) c FROM ${meta.table} WHERE institution_id = ? AND ${meta.dateCol} < datetime('now', '-' || ? || ' days')`, [institutionId, days]);
  await db.run(`DELETE FROM ${meta.table} WHERE institution_id = ? AND ${meta.dateCol} < datetime('now', '-' || ? || ' days')`, [institutionId, days]);
  return { category: categoryKey, label: meta.label, days, deleted: Number(affectedRow.c) };
}

module.exports = { CATEGORIES, getConfig, setConfig, previewCounts, runCleanup };
