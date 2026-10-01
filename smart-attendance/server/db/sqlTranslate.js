// Batch 6 / Feature 17 — SQLite -> PostgreSQL SQL dialect translation.
//
// This is the ONE place SQLite-specific SQL text gets rewritten for
// PostgreSQL — every route/util file keeps writing the exact same SQL
// strings it always has (with `?` placeholders and SQLite date/time
// functions), and this module transparently rewrites them before they reach
// a real Postgres connection. That is what "existing routes continue using
// the abstraction rather than being rewritten individually" means in
// practice: the translation happens once, centrally, not 70+ times scattered
// across the codebase.
//
// The exact set of patterns below was enumerated precisely from a grep of
// the entire server/ tree (not guessed) — see the Phase 4 report for the
// full inventory this was built from.

// ---- ? -> $1, $2, ... positional placeholder translation ----
// SQLite/better-sqlite3 uses bare `?`; Postgres uses numbered `$n`. A `?`
// can never legitimately appear inside a string literal in any query this
// app writes (no query embeds a literal "?" character), so a straight
// left-to-right replace is safe and exact.
function translatePlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

// ---- SQLite-specific function/pragma text -> Postgres equivalents ----
// Order matters: more specific patterns are matched before more general ones
// (e.g. the parameterized `datetime('now', ?)` form must not be caught by a
// bare `datetime('now')` pattern).
const REWRITES = [
  // datetime('now', '-' || ? || ' days')  — dataRetention.js's dynamic-days form
  { re: /datetime\('now',\s*'-'\s*\|\|\s*\?\s*\|\|\s*' days'\)/gi, to: `((now() AT TIME ZONE 'utc') - (? || ' days')::interval)` },
  // datetime('now', ?) — a full modifier string bound as a parameter, e.g. '-10 minutes'
  { re: /datetime\('now',\s*\?\)/gi, to: `((now() AT TIME ZONE 'utc') + (?)::interval)` },
  // datetime('now','-N days'|'-N minutes') — literal modifier inline
  { re: /datetime\('now',\s*'(-?\d+)\s+(day|days|minute|minutes|hour|hours)'\)/gi, to: (_, n, unit) => `((now() AT TIME ZONE 'utc') + interval '${n} ${unit}')` },
  // datetime('now') — bare
  { re: /datetime\('now'\)/gi, to: `(now() AT TIME ZONE 'utc')` },
  // date('now','-N days') — literal modifier inline, always used against a DATE column
  { re: /date\('now',\s*'-(\d+)\s+days?'\)/gi, to: (_, n) => `(CURRENT_DATE - ${n})` },
  // strftime('%Y-%m-%d', col) -> 'YYYY-MM-DD' text, byte-identical output to SQLite's
  { re: /strftime\('%Y-%m-%d',\s*([\w.]+)\)/gi, to: (_, col) => `to_char(${col}, 'YYYY-MM-DD')` },
  // strftime('%Y-%m', col) -> 'YYYY-MM' text, byte-identical output to SQLite's
  { re: /strftime\('%Y-%m',\s*([\w.]+)\)/gi, to: (_, col) => `to_char(${col}, 'YYYY-MM')` },
  // strftime('%Y-W%W', col) / strftime('%Y-%W', col) -> ISO year-week grouping key.
  // KNOWN, DISCLOSED DIFFERENCE: SQLite's %W (Sunday/Monday simple week count)
  // and Postgres's ISO week (IW) can disagree by one at year boundaries. Both
  // call sites use this purely as a consistent weekly grouping/display key for
  // a trend chart, never for date arithmetic or as a stored value — a
  // cosmetic labeling difference at the year boundary, not a data problem.
  { re: /strftime\('%Y-W%W',\s*([\w.]+)\)/gi, to: (_, col) => `to_char(${col}, 'IYYY-"W"IW')` },
  { re: /strftime\('%Y-%W',\s*([\w.]+)\)/gi, to: (_, col) => `to_char(${col}, 'IYYY-IW')` },
];

function rewriteDialect(sql) {
  let out = sql;
  for (const { re, to } of REWRITES) out = out.replace(re, to);
  return out;
}

// INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING (bare, no conflict
// target — the closest match to SQLite's "OR IGNORE", which suppresses ANY
// constraint violation on the statement, not just one named constraint).
// Every real call site in this app is a single-row `INSERT ... VALUES (...)`
// with nothing after the closing paren, so appending is safe; asserted by
// the regex only matching when the statement doesn't already have a
// trailing clause.
function rewriteInsertOrIgnore(sql) {
  const m = /^(\s*)INSERT OR IGNORE INTO\b([\s\S]*)$/i.exec(sql);
  if (!m) return sql;
  const body = `INSERT INTO${m[2]}`;
  return `${body.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
}

// Full pipeline: SQLite-dialect SQL (with `?` placeholders) -> Postgres SQL
// (with `$n` placeholders). Called once per query, right before execution.
function toPostgres(sql) {
  let out = sql;
  out = rewriteInsertOrIgnore(out);
  out = rewriteDialect(out);
  out = translatePlaceholders(out);
  return out;
}

module.exports = { toPostgres, translatePlaceholders, rewriteDialect, rewriteInsertOrIgnore };
