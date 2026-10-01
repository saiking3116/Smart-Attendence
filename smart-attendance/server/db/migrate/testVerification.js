// Batch 6 / Feature 17 — self-test for verifyMigration.js.
//
// A verifier that always reports PASS is worthless. This module proves the
// verifier actually has teeth: given an ALREADY-migrated (sqliteDb, pgClient)
// pair, it deliberately corrupts one real, non-structural value directly in
// the PostgreSQL target (never in SQLite — the source is never touched by
// this module), re-runs verify(), and confirms the corruption is caught and
// correctly attributed. The pgClient passed in must be a disposable instance
// the caller is prepared to discard afterward — this module does not revert
// its corruption, since the point is to then throw the whole target away and
// re-migrate fresh for any further use.
const { verify } = require('./verifyMigration');

// Picks one real attendance row and flips its status (present<->absent) —
// a normal, valid value for the column (so this isn't caught by a CHECK
// constraint, only by the verifier's own content comparison), directly in
// Postgres only.
async function corruptOneValue(pgClient) {
  const row = (await pgClient.query(`SELECT id, status FROM attendance ORDER BY id LIMIT 1`)).rows[0];
  if (!row) throw new Error('No attendance rows to corrupt — run this against an already-migrated instance.');
  const newStatus = row.status === 'present' ? 'absent' : 'present';
  await pgClient.query(`UPDATE attendance SET status = $1 WHERE id = $2`, [newStatus, row.id]);
  return { table: 'attendance', id: row.id, from: row.status, to: newStatus };
}

// Runs the full negative-test cycle against an already-migrated pair:
//   1. Confirms the given pair is currently clean (sanity precondition).
//   2. Corrupts one value in Postgres only.
//   3. Re-verifies and asserts the corruption WAS detected, in the right table.
// Returns a report; throws only for a genuine harness problem (e.g. nothing
// to corrupt), never for "the verifier failed to detect it" — that's
// reported as ok:false in the returned object so the caller can decide how
// loudly to fail.
async function runNegativeTest({ sqliteDb, pgClient }) {
  const before = await verify({ sqliteDb, pgClient });
  if (!before.ok) {
    return { ok: false, reason: 'precondition failed: the pair was not clean before corruption', beforeIssues: before.issues };
  }

  const corruption = await corruptOneValue(pgClient);

  const after = await verify({ sqliteDb, pgClient });
  const attendanceResult = after.tables.attendance;
  const detected = after.ok === false && attendanceResult && attendanceResult.checksumMatch === false;
  const mentionsRightTable = after.issues.some(i => i.startsWith('attendance:'));

  return {
    ok: detected && mentionsRightTable,
    corruption,
    verifierReportedOk: after.ok,
    attendanceChecksumMatch: attendanceResult ? attendanceResult.checksumMatch : undefined,
    issuesAfterCorruption: after.issues,
  };
}

module.exports = { runNegativeTest, corruptOneValue };
