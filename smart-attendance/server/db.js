// Batch 6 / Feature 17 — database engine dispatcher.
//
// This file used to contain the entire SQLite schema/init/migrate/backfill
// pipeline directly. That logic has moved, byte-for-byte unchanged, into
// server/db/sqliteEntry.js. This file now only decides WHICH engine to load,
// based on DB_ENGINE, and re-exports that engine's adapter — the same
// { get, all, run, exec, transaction, engine, raw } async interface either
// way. Every route/util file in this app calls db.get/all/run/exec/
// transaction(...) identically regardless of which engine is active; this
// dispatcher is the only place that knows engine selection happens at all.
//
// DB_ENGINE=sqlite (default) -> server/db/sqliteEntry.js (existing behavior,
//   including all schema init/migrate/backfill logic, completely unchanged)
// DB_ENGINE=postgres -> server/db/postgresEntry.js (requires DATABASE_URL;
//   does NOT run schema init — a Postgres target must already have the
//   verified schema applied, see server/db/postgres/schema.sql)
//
// Deliberately no automatic fallback in either direction: an explicit
// DB_ENGINE=postgres that cannot connect must fail startup loudly, never
// silently continue on SQLite.
require('dotenv').config();

const DB_ENGINE = (process.env.DB_ENGINE || 'sqlite').trim().toLowerCase();

let db;
if (DB_ENGINE === 'sqlite') {
  db = require('./db/sqliteEntry');
} else if (DB_ENGINE === 'postgres' || DB_ENGINE === 'postgresql') {
  db = require('./db/postgresEntry');
} else {
  throw new Error(
    `Unrecognized DB_ENGINE "${process.env.DB_ENGINE}". Expected "sqlite" or "postgres". Refusing to start.`
  );
}

module.exports = db;
