require('dotenv').config();

// Batch 6 / Feature 17 — PostgreSQL entry point.
//
// This is the PostgreSQL counterpart to sqliteEntry.js. It deliberately does
// NOT run any schema init/migration/backfill logic — provisioning a fresh
// Postgres target is a separate, explicit, human-triggered step (see
// server/db/postgres/schema.sql and server/db/migrate/sqliteToPostgres.js).
// Loading this module only ever connects to whatever schema/data already
// exists at DATABASE_URL. It never creates tables, never seeds a super
// admin, and never touches SQLite in any way.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DB_ENGINE=postgres requires DATABASE_URL to be set (a postgres:// connection string). ' +
    'Refusing to start — no fallback to SQLite will occur.'
  );
}

const pg = require('pg');
const { applyToPgModule } = require('./postgres/typeParsers');

// Must run before the Pool is created: registers raw-string parsers for
// date/time OIDs on pg's process-wide type registry, avoiding the
// local-timezone Date-shift bug found during Phase 2 migration testing.
applyToPgModule(pg);

// PG_POOL_MAX is optional — pg's own default (10) is correct for a real
// standalone PostgreSQL server. It exists only so a constrained test target
// (e.g. a single-connection embedded engine used for validation) can be
// pointed at with a smaller pool, without that ever being the production default.
const poolMax = process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : undefined;
const pool = new pg.Pool({ connectionString: DATABASE_URL, ...(poolMax ? { max: poolMax } : {}) });

// Fail loudly and immediately on a connection-level error (e.g. the
// Postgres server disappearing after startup) rather than letting the
// process silently limp along or fall back to another engine.
pool.on('error', (err) => {
  console.error('[postgresEntry] Unexpected error on idle PostgreSQL client:', err.message);
});

const { createPostgresAdapter } = require('./adapters/postgresAdapter');

module.exports = createPostgresAdapter(pool);
