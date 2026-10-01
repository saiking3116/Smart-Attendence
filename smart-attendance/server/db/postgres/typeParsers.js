// Batch 6 / Feature 17 — raw-string date/time type parsers.
//
// WHY THIS FILE EXISTS (found empirically, not theoretically, while building
// the Phase 2 data migration): by default, every Postgres JS driver — the
// standard `pg` package AND pglite — auto-parses `timestamp`/`date` columns
// into JS `Date` objects, and does so by treating the naive (no-timezone)
// wire value as being in the PROCESS'S LOCAL TIMEZONE. This environment's
// local timezone is IST (UTC+5:30). SQLite's `datetime('now')` convention
// (used everywhere in this app) always produces UTC-naive strings with no
// timezone marker. Left unfixed, reading a value back through the default
// driver parsing silently shifts every timestamp by -5:30 — e.g. a row
// stored as '2026-08-27 15:24:23' comes back as the JS Date instant
// 2026-08-27T09:54:23.000Z. This is not data corruption (confirmed via
// `to_char()` — the raw stored bytes are exactly correct) — it is a
// driver-side misinterpretation on READ, but it is just as dangerous: every
// call site in this app treats these columns as opaque strings (slicing,
// comparing, re-formatting), and a silently-shifted Date object would break
// all of that in a way that depends on the deploying server's timezone.
//
// Fix: register a parser for each date/time OID that returns the raw wire
// string unchanged. Postgres already sends `timestamp`/`date` values as
// plain 'YYYY-MM-DD[ HH:MM:SS]' text over the wire (no timezone suffix for
// these types) — this is *exactly* the format SQLite already used, so every
// existing call site keeps working with zero changes.
//
// OIDs (standard, stable Postgres catalog values — see pg_type):
//   1082 = date
//   1083 = time
//   1114 = timestamp (without time zone)
//   1184 = timestamptz (without time zone) — not used by this schema today,
//          included for safety since it's the same class of column.
const RAW_DATE_TIME_OIDS = { date: 1082, time: 1083, timestamp: 1114, timestamptz: 1184 };

const identity = (value) => value;

// Shape used directly by PGlite's `new PGlite({ parsers })` constructor
// option, and by the migration/verification scripts. { [oid]: (raw) => raw }
const pgliteParsers = {
  [RAW_DATE_TIME_OIDS.date]: identity,
  [RAW_DATE_TIME_OIDS.time]: identity,
  [RAW_DATE_TIME_OIDS.timestamp]: identity,
  [RAW_DATE_TIME_OIDS.timestamptz]: identity,
};

// Applies the same raw-string behavior to the standard `pg` package, which
// uses a different registration API (`pg.types.setTypeParser(oid, fn)`,
// process-wide on that module's shared `types` registry). Call this once
// before creating any `pg.Pool`/`pg.Client` (see the Phase 4 postgres
// adapter) — never call it against a `pg` instance that other, unrelated
// code in the same process also depends on for auto-parsed dates.
function applyToPgModule(pgModule) {
  for (const oid of Object.values(RAW_DATE_TIME_OIDS)) {
    pgModule.types.setTypeParser(oid, identity);
  }
}

module.exports = { RAW_DATE_TIME_OIDS, pgliteParsers, applyToPgModule };
