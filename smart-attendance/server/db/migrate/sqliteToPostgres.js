// Batch 6 / Feature 17 — SQLite -> PostgreSQL data migration.
//
// Reads every row from a SQLite database (the caller supplies a better-sqlite3
// instance — this module ALWAYS treats it as read-only and never calls
// anything but SELECT/PRAGMA against it) and loads it into a PostgreSQL-
// compatible target (anything exposing an async `.query(sql, params)` — the
// standard `pg` Pool/Client, or PGlite, which intentionally implements the
// same interface). The target's schema must already exist (server/db/postgres
// /schema.sql applied) — this module only inserts data, it never creates or
// alters tables.
//
// Design choices, and why:
//   - Load order comes from schemaGraph.topologicalOrder() (real FK
//     introspection), never a hardcoded table list.
//   - Every table load happens inside ONE transaction spanning the whole
//     migration. Any single row failing anywhere rolls back everything —
//     there is no partial migration and no "skip the bad table" path.
//   - Explicit primary keys are preserved via `OVERRIDING SYSTEM VALUE`
//     (the standard SQL mechanism for inserting into a GENERATED ALWAYS AS
//     IDENTITY column) rather than letting Postgres assign new ids, which
//     would break every foreign key relationship on re-insert.
//   - Column boolean-ness is read from the TARGET schema
//     (information_schema.columns), not hardcoded — SQLite has no native
//     boolean type (these are plain INTEGER 0/1/NULL there), so the target
//     schema is the only authoritative source for which columns need
//     0/1/NULL -> false/true/NULL conversion.
//   - INSERT OR IGNORE / OR REPLACE semantics are never used anywhere in this
//     module — a real constraint violation always throws and stops the
//     migration, exactly as requested.
const { topologicalOrder, listTables } = require('./schemaGraph');

async function loadTargetColumnInfo(pgClient) {
  const res = await pgClient.query(`
    SELECT table_name, column_name, data_type, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);
  const info = {}; // info[table] = { columns: { colName: dataType }, identityColumn: string|null }
  for (const row of res.rows) {
    if (!info[row.table_name]) info[row.table_name] = { columns: {}, identityColumn: null };
    info[row.table_name].columns[row.column_name] = row.data_type;
    if (row.is_identity === 'YES') info[row.table_name].identityColumn = row.column_name;
  }
  return info;
}

// SQLite has no boolean type — these columns are plain INTEGER 0/1/NULL
// there. Converted here (and ONLY here) because the target column is
// genuinely BOOLEAN in Postgres; every other value passes through unchanged.
function coerceValue(value, pgDataType) {
  if (value === null || value === undefined) return null;
  if (pgDataType === 'boolean') return value === 1 || value === true ? true : value === 0 || value === false ? false : Boolean(value);
  return value;
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// Reads every row of `table` from the SQLite source, in insertion (rowid)
// order, and loads it into the Postgres target using the already-open
// transaction on pgClient. Returns the number of rows loaded.
async function loadTable(sqliteDb, pgClient, table, targetInfo) {
  const rows = sqliteDb.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  if (rows.length === 0) return 0;

  const info = targetInfo[table];
  if (!info) throw new Error(`Target schema has no table "${table}" — cannot migrate rows for it.`);
  const columns = Object.keys(rows[0]);
  for (const col of columns) {
    if (!(col in info.columns)) {
      throw new Error(`Target table "${table}" has no column "${col}" that exists in the SQLite source — refusing to silently drop a column's data.`);
    }
  }

  const overriding = info.identityColumn && columns.includes(info.identityColumn) ? ' OVERRIDING SYSTEM VALUE' : '';
  const colList = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${quoteIdent(table)} (${colList})${overriding} VALUES (${placeholders})`;

  for (const row of rows) {
    const values = columns.map(col => coerceValue(row[col], info.columns[col]));
    try {
      await pgClient.query(sql, values);
    } catch (e) {
      // Fail loudly with exact table + row context — never continue past this.
      const idDesc = 'id' in row ? `id=${row.id}` : JSON.stringify(row).slice(0, 200);
      throw new Error(`Migration failed loading table "${table}" (row ${idDesc}): ${e.message}`);
    }
  }
  return rows.length;
}

// Advances every identity sequence to at least MAX(id) so a subsequent
// application insert can never collide with an imported row. Skipped for a
// table with zero rows (the sequence's default start of 1 is already correct).
async function syncSequences(pgClient, targetInfo, tablesLoaded) {
  const synced = [];
  for (const table of Object.keys(targetInfo)) {
    const idCol = targetInfo[table].identityColumn;
    if (!idCol) continue;
    const maxRes = await pgClient.query(`SELECT MAX(${quoteIdent(idCol)}) as mx FROM ${quoteIdent(table)}`);
    const max = maxRes.rows[0].mx;
    if (max == null) continue; // empty table — default sequence start is already correct
    await pgClient.query(`SELECT setval(pg_get_serial_sequence($1, $2), $3, true)`, [table, idCol, max]);
    synced.push({ table, column: idCol, setTo: Number(max) });
  }
  return synced;
}

// Main entry point. sqliteDb: a better-sqlite3 instance opened readonly
// against a DISPOSABLE copy (never the live file — this module doesn't care
// which file it's given, but the caller must guarantee that). pgClient: any
// object with async query(sql, params[]) -> {rows}.
async function migrate({ sqliteDb, pgClient }) {
  const order = topologicalOrder(sqliteDb);
  const targetInfo = await loadTargetColumnInfo(pgClient);

  const rowCounts = {};
  await pgClient.query('BEGIN');
  try {
    for (const table of order) {
      rowCounts[table] = await loadTable(sqliteDb, pgClient, table, targetInfo);
    }
    const sequences = await syncSequences(pgClient, targetInfo, rowCounts);
    await pgClient.query('COMMIT');
    return { ok: true, order, rowCounts, sequences };
  } catch (e) {
    await pgClient.query('ROLLBACK');
    throw e; // never swallow — the caller must see the exact table/row that failed
  }
}

module.exports = { migrate, loadTargetColumnInfo, coerceValue, listTables };
