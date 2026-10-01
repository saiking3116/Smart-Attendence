// Batch 6 / Feature 17 — post-migration integrity verification.
//
// Compares the SQLite source (read-only) against the PostgreSQL target across
// every table: row counts, primary-key ranges, per-column NULL counts, a
// content checksum of every row, institution-scoped count consistency, and a
// live functional recheck that UNIQUE/CHECK/FK constraints are still actually
// enforced after the bulk load (not just "present in the DDL"). Returns a
// structured report; never claims success by row-count alone.
//
// The only normalization applied when computing checksums is for values that
// are genuinely represented differently by the two engines and nothing else:
//   - SQLite INTEGER 0/1/NULL <-> Postgres BOOLEAN false/true/NULL, for
//     exactly the columns the target schema declares as boolean.
// Every other value is compared as-is. This means the caller MUST hand this
// module a pgClient that already returns date/timestamp columns as raw
// strings (see server/db/postgres/typeParsers.js) — otherwise a genuine
// engine-representation difference (JS Date vs string) would be mistaken for
// a real mismatch, or worse, silently "normalized away" past what's honest.
const crypto = require('crypto');
const { listTables } = require('./schemaGraph');

// Column-name-only FK descriptor per table, straight from the SQLite schema
// (not the topological order from schemaGraph — self-refs excluded there,
// but this sweep wants every edge, and needs the actual column names too).
function foreignKeyColumnEdges(sqliteDb, table) {
  return sqliteDb.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map(fk => ({ table, column: fk.from, refTable: fk.table, refColumn: fk.to }));
}

async function loadTargetColumnInfo(pgClient) {
  const res = await pgClient.query(`
    SELECT table_name, column_name, data_type, is_identity, is_nullable
    FROM information_schema.columns WHERE table_schema = 'public'
  `);
  const info = {};
  for (const row of res.rows) {
    if (!info[row.table_name]) info[row.table_name] = { columns: {}, identityColumn: null };
    info[row.table_name].columns[row.column_name] = row.data_type;
    if (row.is_identity === 'YES') info[row.table_name].identityColumn = row.column_name;
  }
  return info;
}

function orderKey(sqliteDb, table) {
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes('id')) return 'id';
  if (table === 'app_settings') return 'key';
  if (cols.includes('user_id')) return 'user_id'; // user_2fa, notification_preferences (PK)
  return null;
}

function quoteIdent(name) { return `"${name.replace(/"/g, '""')}"`; }

// Parses ANY of the date/time text formats this app's own codebase has
// actually produced into it — WITHOUT ever going through `new Date(string)`,
// whose interpretation of a no-timezone string depends on the runtime's
// local timezone (see server/db/postgres/typeParsers.js for the empirical
// discovery of exactly that pitfall). Every component is pulled out by
// regex and combined with Date.UTC(), so the result is unambiguous
// regardless of where this code runs.
//
// Genuinely found via this migration's own verification run (not assumed):
//   - SQLite:   'YYYY-MM-DD HH:MM'                  (seed.js's absent-row
//                                                     fallback omits seconds)
//   - SQLite:   'YYYY-MM-DDTHH:MM:SS.sssZ'           (seed.js's notification
//                                                     rows use JS .toISOString())
//   - SQLite:   'YYYY-MM-DD HH:MM:SS'                (the SQL datetime('now')
//                                                     default, used almost
//                                                     everywhere else)
//   - Postgres: 'YYYY-MM-DD HH:MM:SS[.ffffff]'       (its own canonical text
//                                                     form, always re-derived
//                                                     from the stored value —
//                                                     never the original string)
// All four represent an instant, not an opaque string — a real Postgres
// engine will always normalize to its own text form on read, so comparing
// raw text here would flag a false mismatch on the exact rows that prove the
// migration worked correctly.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?)?Z?$/;
function parseToEpochMs(value) {
  const m = DATETIME_RE.exec(value);
  if (!m) return undefined; // not a recognized date/time string — caller falls back to raw comparison
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? Math.round(Number(('0.' + frac)) * 1000) : 0;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(s || 0), ms);
}

function coerceForHash(value, colType) {
  if (value === null || value === undefined) return null;
  if (colType === 'boolean') return value === 1 || value === true ? true : value === 0 || value === false ? false : value;
  if (colType === 'timestamp without time zone' || colType === 'timestamp with time zone' || colType === 'date') {
    if (typeof value === 'string') {
      const epoch = parseToEpochMs(value);
      if (epoch !== undefined) return epoch; // compare by instant, not by which text format wrote it
    }
  }
  return value;
}

function canonicalRow(row, columns, colTypes) {
  const obj = {};
  for (const col of columns) obj[col] = coerceForHash(row[col], colTypes[col]);
  return JSON.stringify(obj);
}

function hashRows(rows, columns, colTypes) {
  const h = crypto.createHash('sha256');
  for (const row of rows) h.update(canonicalRow(row, columns, colTypes));
  return h.digest('hex');
}

async function verifyTable(sqliteDb, pgClient, table, targetInfo) {
  const info = targetInfo[table];
  const issues = [];
  const key = orderKey(sqliteDb, table);
  const orderSql = key ? ` ORDER BY ${quoteIdent(key)}` : '';

  const sqliteRows = sqliteDb.prepare(`SELECT * FROM ${table}${key ? ` ORDER BY ${key}` : ''}`).all();
  const pgRes = await pgClient.query(`SELECT * FROM ${quoteIdent(table)}${orderSql}`);
  const pgRows = pgRes.rows;

  const result = {
    table,
    sqliteCount: sqliteRows.length,
    postgresCount: pgRows.length,
    countMatch: sqliteRows.length === pgRows.length,
  };
  if (!result.countMatch) issues.push(`${table}: row count mismatch — sqlite=${sqliteRows.length} postgres=${pgRows.length}`);

  if (key === 'id' && sqliteRows.length) {
    const sMin = Math.min(...sqliteRows.map(r => r.id));
    const sMax = Math.max(...sqliteRows.map(r => r.id));
    const pMin = Math.min(...pgRows.map(r => Number(r.id)));
    const pMax = Math.max(...pgRows.map(r => Number(r.id)));
    result.idRange = { sqlite: [sMin, sMax], postgres: [pMin, pMax] };
    if (sMin !== pMin || sMax !== pMax) issues.push(`${table}: id range mismatch — sqlite=[${sMin},${sMax}] postgres=[${pMin},${pMax}]`);
  }

  if (sqliteRows.length === 0) {
    result.bothEmpty = pgRows.length === 0;
    if (!result.bothEmpty) issues.push(`${table}: expected empty (0 rows in SQLite) but Postgres has ${pgRows.length}`);
    return { result, issues };
  }

  const columns = Object.keys(sqliteRows[0]);
  const colTypes = Object.fromEntries(columns.map(c => [c, info ? info.columns[c] : undefined]));

  // NULL counts per column, both sides
  const nullMismatches = [];
  for (const col of columns) {
    const sNulls = sqliteRows.filter(r => r[col] === null).length;
    const pNulls = pgRows.filter(r => r[col] === null || r[col] === undefined).length;
    if (sNulls !== pNulls) nullMismatches.push({ column: col, sqliteNulls: sNulls, postgresNulls: pNulls });
  }
  result.nullCountsMatch = nullMismatches.length === 0;
  if (nullMismatches.length) { issues.push(`${table}: NULL count mismatch on columns ${nullMismatches.map(m => m.column).join(', ')}`); result.nullMismatches = nullMismatches; }

  // Content checksum — boolean and timestamp/date columns are compared by
  // normalized value (see coerceForHash), everything else byte-for-byte.
  const sqliteHash = hashRows(sqliteRows, columns, colTypes);
  const pgHash = hashRows(pgRows, columns, colTypes);
  result.checksumMatch = sqliteHash === pgHash;
  result.sqliteChecksum = sqliteHash;
  result.postgresChecksum = pgHash;
  if (!result.checksumMatch) issues.push(`${table}: content checksum mismatch (sqlite=${sqliteHash.slice(0, 12)}… postgres=${pgHash.slice(0, 12)}…)`);

  return { result, issues };
}

// Attempts operations that MUST fail if constraints are still live post-load,
// all inside a transaction that is always rolled back — never leaves test
// rows behind in the migrated data.
async function functionalConstraintRecheck(pgClient) {
  const issues = [];
  const checks = [];
  await pgClient.query('BEGIN');
  try {
    // UNIQUE: duplicate (institution_id, user_id) for an existing real row
    const anyUser = (await pgClient.query(`SELECT institution_id, user_id FROM users WHERE institution_id IS NOT NULL LIMIT 1`)).rows[0];
    if (anyUser) {
      try {
        await pgClient.query(`INSERT INTO users (institution_id, user_id, name, password_hash, role, status) VALUES ($1,$2,'dup test','x','student','active')`, [anyUser.institution_id, anyUser.user_id]);
        issues.push('UNIQUE(institution_id,user_id) did NOT reject a duplicate after migration');
        checks.push({ name: 'users UNIQUE(institution_id,user_id) still enforced', ok: false });
      } catch (e) { checks.push({ name: 'users UNIQUE(institution_id,user_id) still enforced', ok: true }); }
    }
    // CHECK: super_admin with a non-NULL institution_id
    try {
      await pgClient.query(`INSERT INTO users (institution_id, user_id, name, password_hash, role, status) VALUES (1,'CHK-BAD','x','x','super_admin','active')`);
      issues.push('CHECK (super_admin XOR institution_id) did NOT reject a violation after migration');
      checks.push({ name: 'users CHECK (super_admin XOR institution_id) still enforced', ok: false });
    } catch (e) { checks.push({ name: 'users CHECK (super_admin XOR institution_id) still enforced', ok: true }); }
    // FK: attendance referencing a non-existent student_id
    try {
      await pgClient.query(`INSERT INTO attendance (student_id, session_id, status, method) VALUES (999999999, 1, 'present', 'manual')`);
      issues.push('FK (attendance.student_id -> students) did NOT reject an orphan reference after migration');
      checks.push({ name: 'attendance FK to students still enforced', ok: false });
    } catch (e) { checks.push({ name: 'attendance FK to students still enforced', ok: true }); }
  } finally {
    await pgClient.query('ROLLBACK'); // always — this function must never leave data behind
  }
  return { checks, issues };
}

// For every table with an institution_id column, the per-institution row
// counts must match exactly between source and target — proves Feature 18's
// tenant associations survived the migration untouched.
async function institutionConsistency(sqliteDb, pgClient) {
  const issues = [];
  const results = [];
  const tables = listTables(sqliteDb).filter(t => {
    const cols = sqliteDb.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    return cols.includes('institution_id');
  });
  for (const table of tables) {
    const sRows = sqliteDb.prepare(`SELECT institution_id, COUNT(*) c FROM ${table} GROUP BY institution_id`).all();
    const pRes = await pgClient.query(`SELECT institution_id, COUNT(*)::int c FROM ${quoteIdent(table)} GROUP BY institution_id`);
    const sMap = Object.fromEntries(sRows.map(r => [r.institution_id === null ? 'null' : r.institution_id, r.c]));
    const pMap = Object.fromEntries(pRes.rows.map(r => [r.institution_id === null ? 'null' : r.institution_id, r.c]));
    const keys = new Set([...Object.keys(sMap), ...Object.keys(pMap)]);
    let ok = true;
    for (const k of keys) { if ((sMap[k] || 0) !== (pMap[k] || 0)) ok = false; }
    results.push({ table, sqlite: sMap, postgres: pMap, ok });
    if (!ok) issues.push(`${table}: per-institution row counts differ — sqlite=${JSON.stringify(sMap)} postgres=${JSON.stringify(pMap)}`);
  }
  return { results, issues };
}

// Phase 3 addition: sweeps EVERY actual foreign-key relationship in the
// schema (not just the one representative injection test in
// functionalConstraintRecheck) and looks for orphans directly — a child row
// whose FK column is non-null but points at a parent id that doesn't exist.
// Postgres already refuses these at write time (proven by the migration
// itself completing without error), so this is a defense-in-depth sweep
// confirming the loaded data actually has none, table by table.
async function foreignKeyOrphanSweep(sqliteDb, pgClient) {
  const issues = [];
  const results = [];
  for (const table of listTables(sqliteDb)) {
    for (const edge of foreignKeyColumnEdges(sqliteDb, table)) {
      const sql = `
        SELECT COUNT(*) c FROM ${quoteIdent(edge.table)} c
        LEFT JOIN ${quoteIdent(edge.refTable)} p ON p.${quoteIdent(edge.refColumn)} = c.${quoteIdent(edge.column)}
        WHERE c.${quoteIdent(edge.column)} IS NOT NULL AND p.${quoteIdent(edge.refColumn)} IS NULL
      `;
      const res = await pgClient.query(sql);
      const orphanCount = Number(res.rows[0].c);
      const ok = orphanCount === 0;
      results.push({ table: edge.table, column: edge.column, refTable: edge.refTable, refColumn: edge.refColumn, orphanCount, ok });
      if (!ok) issues.push(`${edge.table}.${edge.column} -> ${edge.refTable}.${edge.refColumn}: ${orphanCount} orphaned row(s) in PostgreSQL`);
    }
  }
  return { results, issues };
}

// Phase 3 addition: for every table that both has an institution_id column
// AND a real per-row primary key, confirms EACH row's institution_id matches
// between source and target — not just that the aggregate counts per
// institution happen to agree (which alone couldn't catch two rows in
// different institutions being swapped with each other, since the aggregate
// counts would stay identical either way).
async function institutionRowLevelCheck(sqliteDb, pgClient) {
  const issues = [];
  const results = [];
  for (const table of listTables(sqliteDb)) {
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes('institution_id') || !cols.includes('id')) continue;
    const sRows = sqliteDb.prepare(`SELECT id, institution_id FROM ${table}`).all();
    if (sRows.length === 0) { results.push({ table, checked: 0, mismatches: 0 }); continue; }
    const pRes = await pgClient.query(`SELECT id, institution_id FROM ${quoteIdent(table)}`);
    const pMap = new Map(pRes.rows.map(r => [Number(r.id), r.institution_id === null ? null : Number(r.institution_id)]));
    let mismatches = 0;
    const examples = [];
    for (const r of sRows) {
      const pVal = pMap.has(r.id) ? pMap.get(r.id) : undefined;
      if (pVal !== r.institution_id) { mismatches++; if (examples.length < 5) examples.push({ id: r.id, sqlite: r.institution_id, postgres: pVal }); }
    }
    results.push({ table, checked: sRows.length, mismatches, examples: examples.length ? examples : undefined });
    if (mismatches > 0) issues.push(`${table}: ${mismatches} row(s) have a different institution_id in PostgreSQL than in SQLite (e.g. ${JSON.stringify(examples[0])})`);
  }
  return { results, issues };
}

// Phase 3 addition: every IDENTITY-column table's sequence must be
// positioned so the NEXT auto-generated id can never collide with an already
// imported row. Read-only — uses pg_sequence_last_value() rather than
// nextval(), so checking never itself advances anything.
async function verifySequenceSafety(pgClient) {
  const issues = [];
  const results = [];
  const targetInfo = await loadTargetColumnInfo(pgClient);
  for (const [table, info] of Object.entries(targetInfo)) {
    if (!info.identityColumn) continue;
    const idCol = info.identityColumn;
    const maxRow = (await pgClient.query(`SELECT MAX(${quoteIdent(idCol)}) as mx FROM ${quoteIdent(table)}`)).rows[0];
    const maxId = maxRow.mx === null ? null : Number(maxRow.mx);
    const seqRow = (await pgClient.query(
      `SELECT pg_sequence_last_value(pg_get_serial_sequence($1, $2)) as last_value`, [table, idCol]
    )).rows[0];
    const lastValue = seqRow.last_value === null ? null : Number(seqRow.last_value);
    // No rows yet: any sequence state is safe (nothing to collide with).
    // Rows exist: the sequence must have been set (lastValue not null) and
    // its recorded value must be >= the highest imported id — since setval
    // was called with is_called=true during migration, nextval() will
    // return lastValue+1, which is then necessarily > maxId too.
    const safe = maxId === null ? true : (lastValue !== null && lastValue >= maxId);
    results.push({ table, column: idCol, maxId, sequenceLastValue: lastValue, safe });
    if (!safe) issues.push(`${table}: sequence for "${idCol}" (last_value=${lastValue}) is not safely ahead of MAX(${idCol})=${maxId} — next insert could collide`);
  }
  return { results, issues };
}

// Phase 3 addition: an explicit, separately-reported confirmation that
// date/timestamp handling preserves the represented INSTANT with no
// unintended timezone shift (see server/db/postgres/typeParsers.js for the
// IST-shift bug this guards against). Re-parses every date/timestamp column
// value on both sides via the same non-ambiguous parseToEpochMs() the
// checksum uses, and additionally flags the specific ±5:30h delta pattern
// that would indicate the local-timezone auto-parsing bug has resurfaced.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
async function verifyTimestampHandling(sqliteDb, pgClient, targetInfo) {
  const issues = [];
  const results = [];
  for (const table of listTables(sqliteDb)) {
    const info = targetInfo[table];
    if (!info) continue;
    const dtCols = Object.keys(info.columns).filter(c =>
      ['timestamp without time zone', 'timestamp with time zone', 'date'].includes(info.columns[c]));
    if (dtCols.length === 0) continue;
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    const key = cols.includes('id') ? 'id' : null;
    const sRows = sqliteDb.prepare(`SELECT * FROM ${table}`).all();
    if (sRows.length === 0) continue;
    const pRows = (await pgClient.query(`SELECT * FROM ${quoteIdent(table)}`)).rows;
    const pByKey = key ? new Map(pRows.map(r => [Number(r[key]), r])) : null;

    let compared = 0, mismatched = 0, istShiftDetected = false;
    for (let i = 0; i < sRows.length; i++) {
      const sRow = sRows[i];
      const pRow = pByKey ? pByKey.get(sRow[key]) : pRows[i];
      if (!pRow) continue;
      for (const col of dtCols) {
        const sVal = sRow[col];
        const pVal = pRow[col];
        if (sVal === null && pVal === null) continue;
        if (sVal === null || pVal === null) continue; // already caught by the NULL-count check
        const sEpoch = parseToEpochMs(sVal);
        const pEpoch = parseToEpochMs(pVal);
        if (sEpoch === undefined || pEpoch === undefined) continue;
        compared++;
        const delta = Math.abs(sEpoch - pEpoch);
        if (delta !== 0) {
          mismatched++;
          if (Math.abs(delta - IST_OFFSET_MS) < 1000) istShiftDetected = true;
        }
      }
    }
    results.push({ table, columns: dtCols, comparisons: compared, mismatched, istShiftDetected });
    if (mismatched > 0) {
      issues.push(`${table}: ${mismatched}/${compared} date/timestamp value(s) resolve to a different instant between SQLite and PostgreSQL` +
        (istShiftDetected ? ' — matches the exact +5:30h IST auto-parse shift; typeParsers.js is not being applied to this connection.' : ''));
    }
  }
  return { results, issues };
}

async function verify({ sqliteDb, pgClient }) {
  const tables = listTables(sqliteDb);
  const targetInfo = await loadTargetColumnInfo(pgClient);
  const tableResults = {};
  const allIssues = [];

  for (const table of tables) {
    const { result, issues } = await verifyTable(sqliteDb, pgClient, table, targetInfo);
    tableResults[table] = result;
    allIssues.push(...issues);
  }

  const constraintRecheck = await functionalConstraintRecheck(pgClient);
  allIssues.push(...constraintRecheck.issues);

  const institutionCheck = await institutionConsistency(sqliteDb, pgClient);
  allIssues.push(...institutionCheck.issues);

  const fkSweep = await foreignKeyOrphanSweep(sqliteDb, pgClient);
  allIssues.push(...fkSweep.issues);

  const institutionRowCheck = await institutionRowLevelCheck(sqliteDb, pgClient);
  allIssues.push(...institutionRowCheck.issues);

  const sequenceCheck = await verifySequenceSafety(pgClient);
  allIssues.push(...sequenceCheck.issues);

  const timestampCheck = await verifyTimestampHandling(sqliteDb, pgClient, targetInfo);
  allIssues.push(...timestampCheck.issues);

  return {
    ok: allIssues.length === 0,
    tables: tableResults,
    constraintRecheck: constraintRecheck.checks,
    institutionConsistency: institutionCheck.results,
    foreignKeyOrphanSweep: fkSweep.results,
    institutionRowLevelCheck: institutionRowCheck.results,
    sequenceSafety: sequenceCheck.results,
    timestampHandling: timestampCheck.results,
    issues: allIssues,
  };
}

module.exports = {
  verify, verifyTable, functionalConstraintRecheck, institutionConsistency, loadTargetColumnInfo,
  foreignKeyOrphanSweep, institutionRowLevelCheck, verifySequenceSafety, verifyTimestampHandling, parseToEpochMs,
};
