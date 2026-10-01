const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // A pending-2FA ticket (issued between password check and TOTP/recovery
    // verification) must never work as a real session token, even though it's
    // signed with the same secret — reject it here so no protected route is
    // reachable with only a password, once 2FA is enabled on that account.
    if (payload.purpose) return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(401).json({ error: 'Session invalid. Please log in again.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'This account has been disabled.' });
    // Institution status is re-checked live on every request (not just at
    // login) so deactivating an institution takes effect immediately for
    // every session already in progress, the same way user.status already does.
    if (user.institution_id != null) {
      const inst = await db.get('SELECT status FROM institutions WHERE id = ?', [user.institution_id]);
      if (!inst || inst.status !== 'active') {
        return res.status(403).json({ error: 'Your institution has been deactivated. Contact the platform administrator.' });
      }
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You are not authorized to perform this action.' });
    }
    next();
  };
}

function signToken(user) {
  // institution_id rides along for client display convenience only — every
  // authorization decision server-side re-fetches the live user row (see
  // authenticate() above) rather than trusting this claim.
  return jwt.sign({ id: user.id, role: user.role, user_id: user.user_id, institution_id: user.institution_id }, JWT_SECRET, { expiresIn: '12h' });
}

// Short-lived ticket issued after password verification when 2FA is enabled —
// proves "this caller just entered the right password" without granting any
// real access. Only /api/auth/2fa/verify-login accepts it, and authenticate()
// above explicitly refuses to treat it as a session token.
function signPendingTwoFactorToken(user) {
  return jwt.sign({ id: user.id, purpose: 'pending_2fa' }, JWT_SECRET, { expiresIn: '10m' });
}
function verifyPendingTwoFactorToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.purpose !== 'pending_2fa') throw new Error('Not a pending-2FA token.');
  return payload;
}

// institution_id is derived here (from the acting user's own row), never
// passed in by any of the ~50 existing call sites — so every one of them
// gets correct institution tagging on audit rows for free, with no call-site
// changes needed anywhere else in the app.
async function logAudit(userId, action, entity, entityId, metadata) {
  let institutionId = null;
  if (userId) {
    const row = await db.get('SELECT institution_id FROM users WHERE id = ?', [userId]);
    if (row) institutionId = row.institution_id;
  }
  await db.run(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata, institution_id) VALUES (?,?,?,?,?,?)`,
    [userId || null, action, entity || null, entityId || null, metadata ? JSON.stringify(metadata) : null, institutionId]
  );
}

module.exports = { authenticate, authorize, signToken, signPendingTwoFactorToken, verifyPendingTwoFactorToken, logAudit, JWT_SECRET };
