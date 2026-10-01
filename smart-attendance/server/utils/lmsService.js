// Integration service — the ONLY module that knows about providers, sync
// logging, and course mappings. Routes call this, never a provider directly.
//
//   Smart Attendance routes → lmsService (this file) → provider (mock | real)
//
// Live connection state (provider name, last test/sync results, running
// totals) is a single mutable record reused from the existing app_settings
// key/value store — the same mechanism already used for location_config —
// rather than a new one-row table. Batch 6: this state, the course mappings,
// and the sync logs are all institution-scoped, so Institution A's LMS
// connection/sync history is fully isolated from Institution B's.
//
// KNOWN LIMITATION (disclosed, not silently glossed over): the REAL (non-mock)
// provider is still configured via server-wide environment variables
// (LMS_PROVIDER/LMS_BASE_URL/LMS_API_KEY) — this is a single, process-wide
// credential set, not yet a genuine per-institution credential store. Every
// institution on this server would share the same real LMS connection if one
// were configured. The Mock provider (the default, and the only path this
// batch's tests actually exercise) has no such limitation — its course
// mappings, sync logs, and matched local data are fully institution-scoped.
const db = require('../db');
const { getSetting, setSetting } = require('./sessionAuto');
const mockProvider = require('../lms/providers/mockProvider');
const { createGenericRestProvider } = require('../lms/providers/genericRestProvider');

const STATE_KEY = 'lms_integration_state';

function defaultState() {
  return {
    provider: 'mock', status: 'disconnected',
    lastTestAt: null, lastTestResult: null,
    lastSyncAt: null, lastAttemptAt: null,
    coursesSynced: 0, studentsSynced: 0, attendanceSynced: 0
  };
}

// Real mode activates ONLY when every one of these is set — otherwise the app
// stays on the Mock provider, fully functional with zero configuration.
function getProvider() {
  const { LMS_PROVIDER, LMS_BASE_URL, LMS_API_KEY } = process.env;
  if (LMS_PROVIDER && LMS_BASE_URL && LMS_API_KEY) {
    return createGenericRestProvider({ baseUrl: LMS_BASE_URL, apiKey: LMS_API_KEY, providerLabel: LMS_PROVIDER });
  }
  return mockProvider;
}
function isRealProviderConfigured() {
  const { LMS_PROVIDER, LMS_BASE_URL, LMS_API_KEY } = process.env;
  return !!(LMS_PROVIDER && LMS_BASE_URL && LMS_API_KEY);
}

async function getState(institutionId) {
  const state = await getSetting(institutionId, STATE_KEY, defaultState());
  return { ...state, provider: getProvider().name, isMock: getProvider().name === 'mock' };
}
async function patchState(institutionId, patch) {
  const current = await getSetting(institutionId, STATE_KEY, defaultState());
  const merged = { ...current, ...patch };
  await setSetting(institutionId, STATE_KEY, merged);
  return merged;
}

async function startLog(institutionId, provider, syncType, triggeredBy) {
  const info = await db.run(`
    INSERT INTO lms_sync_logs (institution_id, provider, sync_type, status, triggered_by) VALUES (?,?,?,'running',?)
  `, [institutionId, provider, syncType, triggeredBy || null]);
  return info.lastInsertRowid;
}
async function finishLog(logId, { status, processed, succeeded, failed, errorSummary }) {
  await db.run(`
    UPDATE lms_sync_logs SET status=?, completed_at=datetime('now'), records_processed=?, records_succeeded=?, records_failed=?, error_summary=?
    WHERE id=?
  `, [status, processed, succeeded, failed, errorSummary || null, logId]);
}

async function testConnection(institutionId, userId) {
  const provider = getProvider();
  const logId = await startLog(institutionId, provider.name, 'connection_test', userId);
  await patchState(institutionId, { lastAttemptAt: new Date().toISOString() });
  try {
    const result = await provider.testConnection();
    await finishLog(logId, { status: result.ok ? 'success' : 'failed', processed: 1, succeeded: result.ok ? 1 : 0, failed: result.ok ? 0 : 1, errorSummary: result.ok ? null : result.message });
    await patchState(institutionId, { status: result.ok ? 'connected' : 'error', lastTestAt: new Date().toISOString(), lastTestResult: result.ok ? 'success' : 'failure' });
    return result;
  } catch (e) {
    await finishLog(logId, { status: 'failed', processed: 1, succeeded: 0, failed: 1, errorSummary: e.message });
    await patchState(institutionId, { status: 'error', lastTestAt: new Date().toISOString(), lastTestResult: 'failure' });
    return { ok: false, message: e.message };
  }
}

// Matches each LMS course to a local course by course_code — never creates a
// new local course, and only ever matches within the caller's OWN institution
// (a course_code collision with another institution's course must never
// cross-map). A code with no local match in this institution is a skip.
async function syncCourses(institutionId, userId) {
  const provider = getProvider();
  const logId = await startLog(institutionId, provider.name, 'courses', userId);
  await patchState(institutionId, { lastAttemptAt: new Date().toISOString() });
  let succeeded = 0, failed = 0, processed = 0;
  const notes = [];
  try {
    const lmsCourses = await provider.getCourses();
    processed = lmsCourses.length;
    for (const c of lmsCourses) {
      const local = await db.get('SELECT id FROM courses WHERE course_code = ? AND institution_id = ?', [c.code, institutionId]);
      if (!local) { failed++; notes.push(`No local course matches code "${c.code}" — skipped.`); continue; }
      await db.run(`
        INSERT INTO lms_course_mappings (institution_id, course_id, provider, lms_course_id, lms_course_code, last_synced_at)
        VALUES (?,?,?,?,?, datetime('now'))
        ON CONFLICT(course_id, provider) DO UPDATE SET lms_course_id=excluded.lms_course_id, lms_course_code=excluded.lms_course_code, last_synced_at=datetime('now')
      `, [institutionId, local.id, provider.name, c.lmsCourseId, c.code]);
      succeeded++;
    }
    const status = failed === 0 ? 'success' : succeeded > 0 ? 'partial' : 'failed';
    await finishLog(logId, { status, processed, succeeded, failed, errorSummary: notes.length ? notes.join(' ') : null });
    await patchState(institutionId, { lastSyncAt: new Date().toISOString(), coursesSynced: succeeded });
    return { ok: true, processed, succeeded, failed, notes };
  } catch (e) {
    await finishLog(logId, { status: 'failed', processed, succeeded, failed: processed - succeeded, errorSummary: e.message });
    return { ok: false, error: e.message };
  }
}

// For every locally-mapped course IN THIS INSTITUTION, pulls the LMS roster
// and adds any missing LOCAL enrollment (matched by roll number, scoped to
// this institution's students) — never creates a new user account, never
// removes an existing enrollment, and never matches a student belonging to a
// different institution even if their roll number happens to coincide.
async function syncEnrollments(institutionId, userId) {
  const provider = getProvider();
  const logId = await startLog(institutionId, provider.name, 'enrollments', userId);
  await patchState(institutionId, { lastAttemptAt: new Date().toISOString() });
  let processed = 0, succeeded = 0, failed = 0;
  const notes = [];
  try {
    const mappings = await db.all('SELECT * FROM lms_course_mappings WHERE provider = ? AND institution_id = ?', [provider.name, institutionId]);
    for (const m of mappings) {
      const enrollments = await provider.getEnrollments(m.lms_course_id);
      for (const e of enrollments) {
        processed++;
        const student = await db.get('SELECT id FROM students WHERE roll_number = ? AND institution_id = ?', [e.rollNumber, institutionId]);
        if (!student) { failed++; notes.push(`No local student for roll number "${e.rollNumber}" (LMS: ${e.name}) — skipped.`); continue; }
        await db.run('INSERT OR IGNORE INTO enrollments (institution_id, student_id, course_id) VALUES (?,?,?)', [institutionId, student.id, m.course_id]);
        succeeded++;
      }
    }
    const status = failed === 0 ? (processed ? 'success' : 'success') : succeeded > 0 ? 'partial' : 'failed';
    await finishLog(logId, { status, processed, succeeded, failed, errorSummary: notes.length ? notes.join(' ') : null });
    await patchState(institutionId, { lastSyncAt: new Date().toISOString(), studentsSynced: succeeded });
    return { ok: true, processed, succeeded, failed, notes };
  } catch (e) {
    await finishLog(logId, { status: 'failed', processed, succeeded, failed: processed - succeeded, errorSummary: e.message });
    return { ok: false, error: e.message };
  }
}

// READ-ONLY from Smart Attendance's perspective: counts recent local
// attendance records for mapped courses IN THIS INSTITUTION and simulates
// "pushing" them to the LMS. Never writes to the attendance table — local
// attendance stays authoritative no matter how many times this runs.
async function syncAttendance(institutionId, userId) {
  const provider = getProvider();
  const logId = await startLog(institutionId, provider.name, 'attendance', userId);
  await patchState(institutionId, { lastAttemptAt: new Date().toISOString() });
  try {
    const mappings = await db.all('SELECT course_id FROM lms_course_mappings WHERE provider = ? AND institution_id = ?', [provider.name, institutionId]);
    if (!mappings.length) {
      await finishLog(logId, { status: 'success', processed: 0, succeeded: 0, failed: 0, errorSummary: 'No mapped courses yet — run Sync Courses first.' });
      return { ok: true, processed: 0, succeeded: 0, failed: 0 };
    }
    const placeholders = mappings.map(() => '?').join(',');
    const row = await db.get(`
      SELECT COUNT(*) c FROM attendance a JOIN class_sessions cs ON cs.id = a.session_id
      WHERE cs.course_id IN (${placeholders}) AND cs.status != 'open' AND cs.date >= date('now','-30 days') AND a.institution_id = ?
    `, [...mappings.map(m => m.course_id), institutionId]);
    const processed = Number(row.c);
    await new Promise(r => setTimeout(r, 200)); // simulated push latency
    await finishLog(logId, { status: 'success', processed, succeeded: processed, failed: 0 });
    await patchState(institutionId, { lastSyncAt: new Date().toISOString(), attendanceSynced: processed });
    return { ok: true, processed, succeeded: processed, failed: 0 };
  } catch (e) {
    await finishLog(logId, { status: 'failed', processed: 0, succeeded: 0, failed: 0, errorSummary: e.message });
    return { ok: false, error: e.message };
  }
}

async function syncAll(institutionId, userId) {
  const courses = await syncCourses(institutionId, userId);
  const enrollments = await syncEnrollments(institutionId, userId);
  const attendance = await syncAttendance(institutionId, userId);
  return { courses, enrollments, attendance };
}

async function getSyncLogs(institutionId, limit = 20) {
  return db.all('SELECT * FROM lms_sync_logs WHERE institution_id = ? ORDER BY started_at DESC LIMIT ?', [institutionId, limit]);
}

module.exports = {
  getProvider, isRealProviderConfigured, getState,
  testConnection, syncCourses, syncEnrollments, syncAttendance, syncAll, getSyncLogs
};
