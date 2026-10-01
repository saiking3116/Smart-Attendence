// Lightweight, in-process rate limiting via express-rate-limit — chosen because
// it's the de-facto standard for Express (huge install base, actively
// maintained), needs zero external infrastructure (in-memory Map store, no
// Redis), and hand-rolling this ourselves would be re-implementing a
// well-tested wheel for a security-sensitive feature. Its default store is
// per-process, which is exactly right for this single-process SQLite app —
// there is nothing to coordinate across instances.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// One consistent, information-minimal 429 shape for every limiter — never
// reveals the specific threshold/window, just that the caller should slow down.
function limitHandler(req, res) {
  res.status(429).json({ error: 'Too many requests. Please try again later.' });
}

// Keys by authenticated user when available — fairer than IP-only, since it
// means one abusive account can't exhaust the quota for everyone behind the
// same NAT/campus IP. Falls back to IP (via the library's IPv6-safe helper,
// which normalizes to a /56 subnet so one IPv6 host can't cycle through
// addresses to dodge the limit) for routes that run before authentication.
function userOrIpKey(req) {
  return req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip);
}
function ipOnlyKey(req) {
  return ipKeyGenerator(req.ip);
}

const base = { standardHeaders: true, legacyHeaders: false, handler: limitHandler };

// Broad baseline applied to every request — a soft guard against gross abuse,
// generous enough that no normal page (several API calls per load) ever
// comes close in real use.
const generalLimiter = rateLimit({ ...base, windowMs: 5 * 60 * 1000, limit: 300, keyGenerator: ipOnlyKey });

// Brute-force login protection. Pre-authentication, so always IP-keyed.
const loginLimiter = rateLimit({ ...base, windowMs: 5 * 60 * 1000, limit: 8, keyGenerator: ipOnlyKey });

// Self-registration — same abuse shape as login (unauthenticated, spammable).
const registerLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 6, keyGenerator: ipOnlyKey });

// Face + GPS attendance verification. A real student may retry a handful of
// times (camera glitch, GPS drift); this is not a route a script should hammer.
const verifyLimiter = rateLimit({ ...base, windowMs: 5 * 60 * 1000, limit: 20, keyGenerator: userOrIpKey });

// QR redemption (student scanning a poster/screen).
const qrScanLimiter = rateLimit({ ...base, windowMs: 5 * 60 * 1000, limit: 20, keyGenerator: userOrIpKey });

// QR generation (faculty). The client auto-refreshes the QR roughly every
// QR_TOKEN_TTL_SECONDS (25s default) while the modal stays open — about
// 12/min at most, so this ceiling leaves ~3x headroom over a 5-minute window
// for a faculty member who leaves the modal open for a whole class period.
const qrGenerateLimiter = rateLimit({ ...base, windowMs: 5 * 60 * 1000, limit: 40, keyGenerator: userOrIpKey });

// Excuse submission — a deliberate, occasional student action.
const excuseLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: userOrIpKey });

// 2FA login-step verification (TOTP/recovery code). A 6-digit TOTP has only a
// million possibilities, so this stays tight — pre-session (no req.user yet
// here either), so IP-keyed like login. The pending ticket itself also expires
// in 10 minutes, which independently bounds the attack window.
const twoFactorLoginLimiter = rateLimit({ ...base, windowMs: 10 * 60 * 1000, limit: 10, keyGenerator: ipOnlyKey });

// 2FA self-service (enroll/verify-setup/disable/regenerate codes) — an
// authenticated user managing their own account, not a brute-force target in
// the same way, but still deserves a sane ceiling.
const twoFactorManageLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: userOrIpKey });

module.exports = {
  generalLimiter, loginLimiter, registerLimiter, verifyLimiter, qrScanLimiter, qrGenerateLimiter, excuseLimiter,
  twoFactorLoginLimiter, twoFactorManageLimiter
};
