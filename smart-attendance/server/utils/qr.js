const crypto = require('crypto');

const TTL = parseInt(process.env.QR_TOKEN_TTL_SECONDS || '25', 10);

function generateToken(sessionId) {
  const random = crypto.randomBytes(16).toString('hex');
  const raw = `${sessionId}.${Date.now()}.${random}`;
  const token = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
  const expiresAt = new Date(Date.now() + TTL * 1000).toISOString();
  return { token, expiresAt, ttl: TTL };
}

module.exports = { generateToken, TTL };
