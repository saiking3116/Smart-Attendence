// Batch 6 / Feature 17 — SQLite adapter: the DEFAULT engine, wrapping the
// existing better-sqlite3 connection (and its existing init/migrate/backfill
// pipeline from server/db.js, completely unchanged) in the same async
// interface the Postgres adapter exposes, so every route/util file can call
// `await db.get/all/run(...)` identically regardless of which engine is
// active. Every underlying operation is still the exact same synchronous
// better-sqlite3 call this app has always made — only the calling
// convention changed, never the behavior.
//
// Concurrency note: better-sqlite3 has a single shared connection. A single
// get/all/run is one atomic synchronous call, so it can never be interleaved
// by another request. A multi-statement transaction() block, however, awaits
// multiple times — and Express serves requests concurrently — so a simple
// mutex serializes transactions on this one connection, exactly preserving
// the "one transaction completes before the next begins" guarantee
// better-sqlite3's own (synchronous-only) db.transaction() provided.
function createSqliteAdapter(rawDb) {
  let mutex = Promise.resolve();

  function get(sql, params = []) {
    return Promise.resolve(rawDb.prepare(sql).get(...params));
  }
  function all(sql, params = []) {
    return Promise.resolve(rawDb.prepare(sql).all(...params));
  }
  function run(sql, params = []) {
    const info = rawDb.prepare(sql).run(...params);
    return Promise.resolve({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
  }
  function exec(sql) {
    rawDb.exec(sql);
    return Promise.resolve();
  }

  async function transaction(fn) {
    const run = async () => {
      rawDb.exec('BEGIN');
      try {
        const result = await fn();
        rawDb.exec('COMMIT');
        return result;
      } catch (e) {
        try { rawDb.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
        throw e;
      }
    };
    // Chain onto the mutex so overlapping transaction() calls from concurrent
    // requests never interleave their statements on the one shared connection.
    const result = mutex.then(run, run);
    mutex = result.catch(() => {}); // never let a failed transaction poison the chain for the next caller
    return result;
  }

  return { engine: 'sqlite', get, all, run, exec, transaction, raw: rawDb };
}

module.exports = { createSqliteAdapter };
