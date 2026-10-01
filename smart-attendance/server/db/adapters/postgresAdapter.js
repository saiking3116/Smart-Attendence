// Batch 6 / Feature 17 — PostgreSQL adapter.
//
// Accepts anything exposing an async `.query(sql, params) -> {rows, rowCount}`
// — a real `pg.Pool`/`pg.Client`, or PGlite (which implements the same
// shape). SQL text is translated once, centrally, via sqlTranslate.js —
// every route/util file keeps writing the exact same SQLite-flavored SQL
// it always has.
//
// Transactions use AsyncLocalStorage to bind the checked-out client for the
// duration of a transaction() callback, so code INSIDE that callback keeps
// calling the same top-level db.get/all/run(...) — no separate `tx` object
// needs to be threaded through, which is what keeps this a genuine
// abstraction rather than a second parallel calling convention.
const { AsyncLocalStorage } = require('async_hooks');
const { toPostgres } = require('../sqlTranslate');

// Tables whose primary key is NOT an auto-generated `id` column — INSERTs
// into these must never have `RETURNING id` appended (there is no such
// column). Everything else in this schema uses a GENERATED ALWAYS AS
// IDENTITY `id` column (see server/db/postgres/schema.sql).
const NO_ID_TABLES = new Set(['app_settings', 'user_2fa', 'notification_preferences']);

function extractInsertTable(sql) {
  const m = /^\s*INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+["']?(\w+)["']?/i.exec(sql);
  return m ? m[1] : null;
}

function needsReturningId(sql) {
  const table = extractInsertTable(sql);
  if (!table || NO_ID_TABLES.has(table)) return false;
  if (/\bRETURNING\b/i.test(sql)) return false; // caller already asked for something
  return true;
}

function createPostgresAdapter(poolOrClient) {
  const als = new AsyncLocalStorage();
  const canCheckout = typeof poolOrClient.connect === 'function';

  function currentClient() {
    return als.getStore() || poolOrClient;
  }

  async function get(sql, params = []) {
    const res = await currentClient().query(toPostgres(sql), params);
    return res.rows[0];
  }

  async function all(sql, params = []) {
    const res = await currentClient().query(toPostgres(sql), params);
    return res.rows;
  }

  async function run(sql, params = []) {
    const translated = toPostgres(sql);
    const augmented = needsReturningId(sql) ? `${translated.replace(/;\s*$/, '')} RETURNING id` : translated;
    const res = await currentClient().query(augmented, params);
    const idRow = res.rows && res.rows[0];
    return {
      changes: res.rowCount,
      lastInsertRowid: idRow && idRow.id !== undefined ? Number(idRow.id) : undefined,
    };
  }

  async function exec(sql) {
    // Multi-statement DDL/backfill text — translate each `;`-separated
    // statement independently so dialect rewrites apply throughout, then
    // send as one batch (pg/pglite both support multi-statement .query()
    // when no params are given).
    await currentClient().query(toPostgres(sql));
  }

  async function transaction(fn) {
    const client = canCheckout ? await poolOrClient.connect() : poolOrClient;
    try {
      await client.query('BEGIN');
      const result = await als.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection may already be broken */ }
      throw e;
    } finally {
      if (canCheckout) client.release();
    }
  }

  return { engine: 'postgres', get, all, run, exec, transaction, raw: poolOrClient };
}

module.exports = { createPostgresAdapter, needsReturningId, extractInsertTable };
