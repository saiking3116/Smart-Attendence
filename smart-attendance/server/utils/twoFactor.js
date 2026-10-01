// TOTP via otplib (pinned to the stable v12 `authenticator` API — a
// well-maintained, standard implementation; no custom crypto here). Compatible
// with Google Authenticator, Microsoft Authenticator, Authy, and any other
// RFC 6238 app, since it just builds a standard otpauth:// URI.
const { authenticator } = require('otplib');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Tolerate one 30s step of clock drift on either side — the single most common
// cause of "my code doesn't work" with real authenticator apps.
authenticator.options = { window: 1 };

const ISSUER = 'Smart Attendance';
const RECOVERY_CODE_COUNT = 10;

function generateSecret() {
  return authenticator.generateSecret();
}

function buildOtpauthUri(accountLabel, secret) {
  return authenticator.keyuri(accountLabel, ISSUER, secret);
}

function verifyTotp(code, secret) {
  if (!code || !secret) return false;
  try {
    return authenticator.check(String(code).trim(), secret);
  } catch (e) {
    return false; // malformed input, e.g. non-numeric — never a crash
  }
}

// Recovery codes: human-typeable (XXXX-XXXX), generated with crypto.randomInt
// (not Math.random), returned in plaintext exactly once by the caller, and
// stored here only as bcrypt hashes — the same protection level as a password,
// since redeeming one is functionally equivalent to authenticating with it.
function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const part = () => crypto.randomInt(0, 36 ** 4).toString(36).toUpperCase().padStart(4, '0');
    codes.push(`${part()}-${part()}`);
  }
  return codes;
}

function hashRecoveryCodes(codes) {
  return codes.map(c => bcrypt.hashSync(c, 8));
}

// Checks `code` against the stored hash list; returns the remaining hash list
// with the matched one removed (so it can never be used again), or null if no
// match was found (caller should treat null as "invalid code", not touch storage).
function consumeRecoveryCode(code, hashedCodes) {
  const normalized = String(code || '').trim().toUpperCase();
  const idx = hashedCodes.findIndex(h => bcrypt.compareSync(normalized, h));
  if (idx === -1) return null;
  return [...hashedCodes.slice(0, idx), ...hashedCodes.slice(idx + 1)];
}

module.exports = { generateSecret, buildOtpauthUri, verifyTotp, generateRecoveryCodes, hashRecoveryCodes, consumeRecoveryCode, RECOVERY_CODE_COUNT };
