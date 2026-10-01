// Transport layer only — knows how to send ONE email, nothing about attendance,
// excuses, or who wants what. notificationService.js is the business-logic layer
// above this that decides WHAT to send and to whom; routes never call this
// module directly. Real sending uses nodemailer (the standard, dependency-light
// Node mailer — no native bindings, huge install base) but nodemailer is only
// ever required lazily, inside real mode, so a demo deployment with zero SMTP
// config never even loads it.
const db = require('../db');

// Real mode activates ONLY when every one of these is present — a partially
// configured environment (e.g. just SMTP_HOST) safely stays in mock mode
// rather than half-attempting a real send.
function getSmtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    return { host: SMTP_HOST, port: Number(SMTP_PORT) || 587, user: SMTP_USER, pass: SMTP_PASS, from: SMTP_FROM || SMTP_USER };
  }
  return null;
}

function isRealModeConfigured() {
  return getSmtpConfig() !== null;
}

let cachedTransporter = null;
function getTransporter(config) {
  if (cachedTransporter) return cachedTransporter;
  const nodemailer = require('nodemailer'); // lazy require — never loaded in mock mode
  cachedTransporter = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.port === 465,
    auth: { user: config.user, pass: config.pass }
  });
  return cachedTransporter;
}

// institutionId is derived here (from recipientUserId), the same pattern
// logAudit() uses — so every existing call site keeps working unchanged while
// still getting correct institution tagging for the compliance dashboard's
// per-institution export/email-activity view.
async function logEmailEvent({ recipientUserId, recipientEmail, eventType, subject, status, error }) {
  try {
    let institutionId = null;
    if (recipientUserId) {
      const row = await db.get('SELECT institution_id FROM users WHERE id = ?', [recipientUserId]);
      if (row) institutionId = row.institution_id;
    }
    await db.run(`
      INSERT INTO email_notification_log (recipient_user_id, recipient_email, event_type, subject, status, error, institution_id)
      VALUES (?,?,?,?,?,?,?)
    `, [recipientUserId ?? null, recipientEmail || null, eventType, subject, status, error || null, institutionId]);
  } catch (e) {
    console.error('Failed to write email_notification_log row:', e.message);
  }
}

// Sends (or mocks) one email. NEVER throws — always resolves to { ok, mode } so
// a caller can fire-and-forget this without risking the calling request.
// `text` is required (plain-text fallback); `html` is optional.
async function sendEmail({ to, subject, text, html, recipientUserId, eventType }) {
  if (!to) {
    await logEmailEvent({ recipientUserId, recipientEmail: to, eventType, subject, status: 'skipped', error: 'No recipient email on file.' });
    return { ok: false, mode: 'skipped' };
  }
  const config = getSmtpConfig();

  if (!config) {
    // Mock/dev mode — the default. Log a safe summary (recipient, subject,
    // timestamp) so the flow is visible and testable without ever touching a
    // real mail server or exposing anything sensitive (there ARE no
    // credentials to expose in this branch).
    console.log(`[email:mock] to=${to} subject="${subject}" event=${eventType} at=${new Date().toISOString()}`);
    await logEmailEvent({ recipientUserId, recipientEmail: to, eventType, subject, status: 'mocked' });
    return { ok: true, mode: 'mock' };
  }

  try {
    const transporter = getTransporter(config);
    await transporter.sendMail({ from: config.from, to, subject, text, html: html || undefined });
    await logEmailEvent({ recipientUserId, recipientEmail: to, eventType, subject, status: 'sent' });
    return { ok: true, mode: 'real' };
  } catch (e) {
    // Never leak SMTP host/credentials in the logged error — just the failure reason.
    console.error(`[email:error] event=${eventType} to=${to} — ${e.message}`);
    await logEmailEvent({ recipientUserId, recipientEmail: to, eventType, subject, status: 'failed', error: e.message });
    return { ok: false, mode: 'real', error: e.message };
  }
}

module.exports = { sendEmail, isRealModeConfigured };
