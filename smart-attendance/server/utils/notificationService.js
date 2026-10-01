// Business-logic layer between routes and emailService: decides WHETHER an
// email should go out (preference toggle, duplicate suppression) and WHAT it
// says (templates), then hands a plain {to, subject, text, html} to
// emailService — which is the only thing that knows about SMTP/mock mode.
// Routes call the notifyXxx() functions here and NEVER touch emailService
// directly, and never await them inline before responding (see attendance.js /
// students.js / faculty.js / admin.js call sites — always fire-and-forget with
// a .catch()) so a slow or failing email can never delay or break the
// underlying attendance/excuse operation.
const db = require('../db');
const { sendEmail } = require('./emailService');

const DEFAULT_PREFS = { low_attendance_alerts: 1, weekly_reports: 1, excuse_updates: 1, system_notifications: 1 };

async function getPreferences(userId) {
  const row = await db.get('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
  if (row) return row;
  return { user_id: userId, ...DEFAULT_PREFS };
}

async function upsertPreferences(userId, patch) {
  const current = await getPreferences(userId);
  const merged = { ...current, ...patch };
  await db.run(`
    INSERT INTO notification_preferences (user_id, low_attendance_alerts, weekly_reports, excuse_updates, system_notifications, updated_at)
    VALUES (?,?,?,?,?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      low_attendance_alerts = excluded.low_attendance_alerts,
      weekly_reports = excluded.weekly_reports,
      excuse_updates = excluded.excuse_updates,
      system_notifications = excluded.system_notifications,
      updated_at = datetime('now')
  `, [userId, merged.low_attendance_alerts ? 1 : 0, merged.weekly_reports ? 1 : 0, merged.excuse_updates ? 1 : 0, merged.system_notifications ? 1 : 0]);
  return getPreferences(userId);
}

async function wants(userId, key) {
  const prefs = await getPreferences(userId);
  return !!prefs[key];
}

// Has this exact event type already gone out (sent or mocked — a "skipped" or
// "failed" attempt doesn't count as a real notification) to this user within
// the window? Used to keep low-attendance alerts from repeating every time
// a student's percentage is re-checked while they're still below threshold.
async function wasRecentlyNotified(userId, eventType, withinHours) {
  const row = await db.get(`
    SELECT 1 FROM email_notification_log
    WHERE recipient_user_id = ? AND event_type = ? AND status IN ('sent','mocked')
      AND created_at >= datetime('now', ?)
    LIMIT 1
  `, [userId, eventType, `-${withinHours} hours`]);
  return !!row;
}

function emailShell(title, bodyLines) {
  const lines = bodyLines.filter(Boolean);
  const stripTags = (s) => s.replace(/<[^>]+>/g, '');
  const text = `${title}\n\n${lines.map(stripTags).join('\n')}\n\n— Smart Attendance`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;">
    <h2 style="color:#12172B;margin:0 0 12px;">${title}</h2>
    ${lines.map(l => `<p style="color:#333;font-size:14px;line-height:1.6;margin:0 0 10px;">${l}</p>`).join('')}
    <p style="color:#959CAC;font-size:12px;margin-top:20px;">This is an automated message from Smart Attendance.</p>
  </div>`;
  return { text, html };
}

const LOW_ATTENDANCE_REPEAT_WINDOW_HOURS = 24 * 7; // at most once per course per week

async function notifyLowAttendance({ user, courseName, pct, threshold }) {
  if (!user || !user.email) return { ok: false, mode: 'skipped' };
  if (!(await wants(user.id, 'low_attendance_alerts'))) return { ok: false, mode: 'skipped' };
  const eventType = `low_attendance:${courseName}`;
  if (await wasRecentlyNotified(user.id, eventType, LOW_ATTENDANCE_REPEAT_WINDOW_HOURS)) return { ok: false, mode: 'skipped' };

  const subject = `Low attendance alert — ${courseName}`;
  const { text, html } = emailShell(subject, [
    `Hi ${user.name},`,
    `Your attendance in <b>${courseName}</b> is currently <b>${pct}%</b>, below the required <b>${threshold}%</b>.`,
    `Attend your upcoming classes consistently to get back above the threshold — check your dashboard for exactly how many consecutive classes you need.`
  ]);
  return sendEmail({ to: user.email, subject, text, html, recipientUserId: user.id, eventType });
}

async function notifyWeeklyReport({ user, report }) {
  if (!user || !user.email) return { ok: false, mode: 'skipped' };
  if (!(await wants(user.id, 'weekly_reports'))) return { ok: false, mode: 'skipped' };

  const t = report.totals;
  const subject = `Weekly attendance report — ${report.weekStart} to ${report.weekEnd}`;
  const courseLines = report.courseWise.length
    ? report.courseWise.map(c => `${c.label}: ${c.pct}%`).join(', ')
    : 'No classes recorded this week.';
  const lowCourses = report.courseWise.filter(c => c.pct < 75).map(c => c.label);
  const { text, html } = emailShell(subject, [
    `Hi ${user.name},`,
    `Overall this week: <b>${t.overallPct}%</b> · Present: ${t.presentCount} · Absent: ${t.absentCount} · Late: ${t.lateCount} · Excused: ${t.excusedCount}`,
    `Course-wise: ${courseLines}`,
    lowCourses.length ? `Below 75%: <b>${lowCourses.join(', ')}</b>` : `You're on track in every course this week.`
  ]);
  return sendEmail({ to: user.email, subject, text, html, recipientUserId: user.id, eventType: 'weekly_report' });
}

async function notifyExcuseSubmitted({ facultyUser, studentName, courseName, sessionDate, reason }) {
  if (!facultyUser || !facultyUser.email) return { ok: false, mode: 'skipped' };
  if (!(await wants(facultyUser.id, 'excuse_updates'))) return { ok: false, mode: 'skipped' };

  const subject = `New excuse request — ${studentName} (${courseName})`;
  const { text, html } = emailShell(subject, [
    `Hi ${facultyUser.name},`,
    `${studentName} has submitted an excuse request for <b>${courseName}</b> on ${sessionDate}.`,
    `Reason: ${reason}`,
    `You can review it from your Excuse Requests page.`
  ]);
  return sendEmail({ to: facultyUser.email, subject, text, html, recipientUserId: facultyUser.id, eventType: 'excuse_submitted' });
}

async function notifyExcuseReviewed({ studentUser, courseName, sessionDate, status, reviewerComment }) {
  if (!studentUser || !studentUser.email) return { ok: false, mode: 'skipped' };
  if (!(await wants(studentUser.id, 'excuse_updates'))) return { ok: false, mode: 'skipped' };

  const verb = status === 'approved' ? 'approved' : 'rejected';
  const subject = `Your excuse request was ${verb} — ${courseName}`;
  const { text, html } = emailShell(subject, [
    `Hi ${studentUser.name},`,
    `Your excuse request for <b>${courseName}</b> on ${sessionDate} was <b>${verb}</b>.`,
    reviewerComment ? `Reviewer comment: "${reviewerComment}"` : null
  ]);
  return sendEmail({ to: studentUser.email, subject, text, html, recipientUserId: studentUser.id, eventType: status === 'approved' ? 'excuse_approved' : 'excuse_rejected' });
}

module.exports = {
  getPreferences, upsertPreferences, wants, wasRecentlyNotified,
  notifyLowAttendance, notifyWeeklyReport, notifyExcuseSubmitted, notifyExcuseReviewed
};
