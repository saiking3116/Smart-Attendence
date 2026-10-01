// Batch 6 / Feature 17 — Express 4 does not catch a rejected promise from an
// async route handler on its own; an unhandled rejection there would hang
// the request with no response instead of reaching the existing central
// error handler in server.js. This wrapper forwards any thrown/rejected
// error to next(err) so that existing handler keeps working unchanged,
// regardless of which DB engine (sync SQLite vs async Postgres) is active.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
