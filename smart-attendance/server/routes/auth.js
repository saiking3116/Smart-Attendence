const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, signToken, signPendingTwoFactorToken, verifyPendingTwoFactorToken, logAudit } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { YEARS, getDepartments, getSections, isValidDepartment, isValidSection } = require('../utils/academicStructure');
const { loginLimiter, registerLimiter, twoFactorLoginLimiter, twoFactorManageLimiter } = require('../middleware/rateLimit');
const { generateSecret, buildOtpauthUri, verifyTotp, generateRecoveryCodes, hashRecoveryCodes, consumeRecoveryCode } = require('../utils/twoFactor');

const router = express.Router();

// Resolves an institution for a PRE-authentication request (registration,
// academic-structure lookup) — there is no req.user yet here, so the only
// trusted signal is an explicit institution code the caller provides.
// Defaults to the original Demo Institution (id 1) so every existing
// self-registration/signup flow keeps working exactly as it did pre-Batch-6
// when no code is given.
async function resolvePublicInstitutionId(code) {
  if (!code) return 1;
  const inst = await db.get(`SELECT id FROM institutions WHERE code = ? AND status = 'active'`, [String(code).trim().toUpperCase()]);
  return inst ? inst.id : null;
}

// Public — populates the Department / Academic Year / Section dropdowns on the
// signup form. Never hardcoded in the frontend; always read live from the database.
router.get('/academic-structure', asyncHandler(async (req, res) => {
  const institutionId = await resolvePublicInstitutionId(req.query.institutionCode);
  if (institutionId == null) return res.status(400).json({ error: 'Unknown institution code.' });
  const [departments, sections] = await Promise.all([getDepartments(institutionId), getSections(institutionId)]);
  res.json({ departments, years: YEARS, sections });
}));

/* ===== REGISTER ===== */
router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const { role, password, confirmPassword, email, institutionCode } = req.body || {};

  const institutionId = await resolvePublicInstitutionId(institutionCode);
  if (institutionId == null) return res.status(400).json({ error: 'Unknown institution code.' });

  // --- common validation ---
  const ROLES = ['student', 'faculty', 'admin'];
  if (!role || !ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be student, faculty, or admin.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  // --- admin key check (server-side only, never exposed to client) ---
  if (role === 'admin') {
    const { adminKey } = req.body;
    const expectedKey = process.env.ADMIN_REGISTRATION_KEY;
    if (!expectedKey) {
      return res.status(500).json({ error: 'Admin registration is not configured on this server. Contact the system administrator.' });
    }
    if (!adminKey || adminKey !== expectedKey) {
      return res.status(403).json({ error: 'Invalid admin registration key.' });
    }
  }

  // --- duplicate email check ---
  const existingEmail = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
  if (existingEmail) {
    return res.status(409).json({ error: 'This email address is already registered.' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  // --- role-specific handling ---
  if (role === 'student') {
    const { registerNumber, fullName, department, year_of_study, section } = req.body;
    if (!registerNumber || !fullName || !department || !year_of_study || !section) {
      return res.status(400).json({ error: 'Register Number, Full Name, Department, Academic Year, and Section are required.' });
    }
    const trimmedReg = String(registerNumber).trim().toUpperCase();
    const trimmedName = String(fullName).trim();
    const trimmedDept = String(department).trim();
    const trimmedYear = String(year_of_study).trim();
    const trimmedSection = String(section).trim();

    if (!YEARS.includes(trimmedYear)) {
      return res.status(400).json({ error: 'Invalid academic year.' });
    }
    if (!(await isValidSection(institutionId, trimmedDept, trimmedYear, trimmedSection))) {
      return res.status(400).json({ error: 'That department / academic year / section combination does not exist. Please choose from the dropdown options.' });
    }

    // check duplicate user_id (register number used as login ID) — scoped to
    // this institution, since the same register number may exist elsewhere
    if (await db.get('SELECT id FROM users WHERE user_id = ? AND institution_id = ?', [trimmedReg, institutionId])) {
      return res.status(409).json({ error: `Register number ${trimmedReg} is already registered.` });
    }
    // check duplicate roll_number in students table (same institution)
    if (await db.get('SELECT id FROM students WHERE roll_number = ? AND institution_id = ?', [trimmedReg, institutionId])) {
      return res.status(409).json({ error: `Register number ${trimmedReg} already exists.` });
    }

    await db.transaction(async () => {
      const userInfo = await db.run(
        `INSERT INTO users (institution_id, user_id, name, email, password_hash, role, department, year_of_study, section, status)
         VALUES (?, ?, ?, ?, ?, 'student', ?, ?, ?, 'active')`,
        [institutionId, trimmedReg, trimmedName, email.toLowerCase().trim(), passwordHash, trimmedDept, trimmedYear, trimmedSection]
      );
      const uid = userInfo.lastInsertRowid;

      await db.run(
        `INSERT INTO students (institution_id, user_id, roll_number, name, department, year_of_study, section, semester, face_enrolled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 5, FALSE)`,
        [institutionId, uid, trimmedReg, trimmedName, trimmedDept, trimmedYear, trimmedSection]
      );

      await logAudit(uid, 'SELF_REGISTER', 'users', uid, { role: 'student', roll: trimmedReg });
    });

    return res.status(201).json({ ok: true, message: 'Student account created successfully. You can now log in.' });
  }

  if (role === 'faculty') {
    const { facultyId, fullName, department } = req.body;
    if (!facultyId || !fullName || !department) {
      return res.status(400).json({ error: 'Faculty ID, Full Name, and Department are required.' });
    }
    const trimmedFacId = String(facultyId).trim().toUpperCase();
    const trimmedName = String(fullName).trim();
    const trimmedDept = String(department).trim();

    if (!(await isValidDepartment(institutionId, trimmedDept))) {
      return res.status(400).json({ error: 'Invalid department. Please choose from the dropdown options.' });
    }

    if (await db.get('SELECT id FROM users WHERE user_id = ? AND institution_id = ?', [trimmedFacId, institutionId])) {
      return res.status(409).json({ error: `Faculty ID ${trimmedFacId} is already registered.` });
    }
    if (await db.get('SELECT id FROM faculty WHERE employee_id = ? AND institution_id = ?', [trimmedFacId, institutionId])) {
      return res.status(409).json({ error: `Faculty ID ${trimmedFacId} already exists.` });
    }

    await db.transaction(async () => {
      const userInfo = await db.run(
        `INSERT INTO users (institution_id, user_id, name, email, password_hash, role, department, section, status)
         VALUES (?, ?, ?, ?, ?, 'faculty', ?, NULL, 'active')`,
        [institutionId, trimmedFacId, trimmedName, email.toLowerCase().trim(), passwordHash, trimmedDept]
      );
      const uid = userInfo.lastInsertRowid;

      await db.run(
        `INSERT INTO faculty (institution_id, user_id, employee_id, name, department)
         VALUES (?, ?, ?, ?, ?)`,
        [institutionId, uid, trimmedFacId, trimmedName, trimmedDept]
      );

      await logAudit(uid, 'SELF_REGISTER', 'users', uid, { role: 'faculty', employee_id: trimmedFacId });
    });

    return res.status(201).json({ ok: true, message: 'Faculty account created successfully. You can now log in.' });
  }

  if (role === 'admin') {
    const { adminId, fullName } = req.body;
    if (!adminId || !fullName) {
      return res.status(400).json({ error: 'Admin ID and Full Name are required.' });
    }
    const trimmedAdminId = String(adminId).trim().toUpperCase();
    const trimmedName = String(fullName).trim();

    if (await db.get('SELECT id FROM users WHERE user_id = ? AND institution_id = ?', [trimmedAdminId, institutionId])) {
      return res.status(409).json({ error: `Admin ID ${trimmedAdminId} is already registered.` });
    }

    const userInfo = await db.run(
      `INSERT INTO users (institution_id, user_id, name, email, password_hash, role, department, section, status)
       VALUES (?, ?, ?, ?, ?, 'admin', NULL, NULL, 'active')`,
      [institutionId, trimmedAdminId, trimmedName, email.toLowerCase().trim(), passwordHash]
    );
    const uid = userInfo.lastInsertRowid;

    await logAudit(uid, 'SELF_REGISTER', 'users', uid, { role: 'admin', admin_id: trimmedAdminId });
    return res.status(201).json({ ok: true, message: 'Admin account created successfully. You can now log in.' });
  }
}));

// Shared by the normal login success path and the post-2FA verification path,
// so the two never risk returning a differently-shaped session response.
async function buildLoginResponse(user) {
  const token = signToken(user);
  let profile = null;
  if (user.role === 'student') profile = await db.get('SELECT * FROM students WHERE user_id = ?', [user.id]);
  if (user.role === 'faculty') profile = await db.get('SELECT * FROM faculty WHERE user_id = ?', [user.id]);
  const institution = user.institution_id != null
    ? await db.get('SELECT id, code, name FROM institutions WHERE id = ?', [user.institution_id])
    : null;
  return {
    token,
    user: {
      id: user.id, user_id: user.user_id, name: user.name, role: user.role,
      department: user.department, section: user.section, email: user.email
    },
    institution,
    profile
  };
}

// user_id is only unique WITHIN an institution now (Batch 6) — a bare
// `WHERE user_id = ?` can match more than one row once a second institution
// exists. Resolves to exactly one account: an explicit institutionCode
// disambiguates outright; otherwise, if more than one institution's account
// shares this id, the real password is what disambiguates (a genuine
// collision — same id AND same password in two institutions — is vanishingly
// unlikely, and still safely falls through to "please specify institution").
async function resolveLoginUser({ userId, password, role, institutionCode }) {
  let candidates;
  if (institutionCode) {
    const inst = await db.get(`SELECT id, status FROM institutions WHERE code = ?`, [String(institutionCode).trim().toUpperCase()]);
    if (!inst) return { error: 'Unknown institution code.' };
    candidates = await db.all('SELECT * FROM users WHERE user_id = ? AND institution_id = ?', [String(userId).trim(), inst.id]);
  } else {
    candidates = await db.all('SELECT * FROM users WHERE user_id = ?', [String(userId).trim()]);
  }
  if (role) candidates = candidates.filter(u => u.role === role);
  if (candidates.length === 0) return { user: null };
  if (candidates.length === 1) return { user: candidates[0] };

  const matches = candidates.filter(u => bcrypt.compareSync(password, u.password_hash));
  if (matches.length === 1) return { user: matches[0] };
  return { error: 'Multiple institutions use this ID — please specify your institution code.', code: 'INSTITUTION_REQUIRED' };
}

/* ===== LOGIN ===== */
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { userId, password, role, institutionCode } = req.body || {};
  if (!userId || !password) {
    return res.status(400).json({ error: 'ID and password are required.' });
  }
  const resolved = await resolveLoginUser({ userId, password, role, institutionCode });
  if (resolved.error) return res.status(400).json({ error: resolved.error, code: resolved.code });
  const user = resolved.user;
  if (!user) return res.status(401).json({ error: 'Invalid ID or password.' });
  if (role && user.role !== role) {
    return res.status(401).json({ error: `${userId} is not registered as a ${role}.` });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
  if (user.institution_id != null) {
    const inst = await db.get('SELECT status FROM institutions WHERE id = ?', [user.institution_id]);
    if (!inst || inst.status !== 'active') {
      return res.status(403).json({ error: 'This institution has been deactivated. Contact the platform administrator.' });
    }
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    await logAudit(user.id, 'LOGIN_FAILED', 'users', user.id, { user_id: userId });
    return res.status(401).json({ error: 'Invalid ID or password.' });
  }

  // Password is correct. If this account has 2FA enabled, stop here — issue
  // only a short-lived pending ticket, never the real session token, until a
  // valid TOTP/recovery code comes back through /2fa/verify-login.
  const twoFa = await db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [user.id]);
  if (twoFa && twoFa.enabled) {
    await logAudit(user.id, 'LOGIN_2FA_PENDING', 'users', user.id, {});
    return res.json({ requires2FA: true, pendingToken: signPendingTwoFactorToken(user), userLabel: user.name });
  }

  await logAudit(user.id, 'LOGIN_SUCCESS', 'users', user.id, {});
  res.json(await buildLoginResponse(user));
}));

// Second step of login for accounts with 2FA enabled. Accepts EITHER a 6-digit
// TOTP code OR a recovery code in the same field — tries TOTP first (cheap),
// falls back to recovery-code matching (bcrypt compare against each stored hash).
router.post('/2fa/verify-login', twoFactorLoginLimiter, asyncHandler(async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (!pendingToken || !code) return res.status(400).json({ error: 'pendingToken and code are required.' });

  let payload;
  try {
    payload = verifyPendingTwoFactorToken(pendingToken);
  } catch (e) {
    return res.status(401).json({ error: 'This login attempt has expired. Please log in again.' });
  }

  const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.id]);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'This login attempt is no longer valid. Please log in again.' });
  const twoFa = await db.get('SELECT * FROM user_2fa WHERE user_id = ? AND enabled = TRUE', [user.id]);
  if (!twoFa) return res.status(400).json({ error: '2FA is not enabled on this account.' });

  if (verifyTotp(code, twoFa.secret)) {
    await logAudit(user.id, 'LOGIN_SUCCESS_2FA', 'users', user.id, { method: 'totp' });
    return res.json(await buildLoginResponse(user));
  }

  // Not a valid TOTP — try it as a one-time recovery code.
  const hashedCodes = JSON.parse(twoFa.recovery_codes || '[]');
  const remaining = consumeRecoveryCode(code, hashedCodes);
  if (remaining) {
    await db.run(`UPDATE user_2fa SET recovery_codes = ?, updated_at = datetime('now') WHERE user_id = ?`, [JSON.stringify(remaining), user.id]);
    await logAudit(user.id, 'LOGIN_SUCCESS_2FA', 'users', user.id, { method: 'recovery_code', codesRemaining: remaining.length });
    return res.json(await buildLoginResponse(user));
  }

  await logAudit(user.id, 'LOGIN_2FA_FAILED', 'users', user.id, {});
  return res.status(401).json({ error: 'Invalid or expired code.' });
}));

/* ===== 2FA self-service (manage MY OWN account only — authenticated) ===== */
router.get('/2fa/status', authenticate, asyncHandler(async (req, res) => {
  const row = await db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [req.user.id]);
  res.json({ enabled: !!(row && row.enabled) });
}));

// Batch 5 — Account security visibility. Reuses the EXISTING audit trail
// (login events are already logged by /login and /2fa/verify-login below) and
// the existing user_2fa table — no new tracking, no new sensitive columns.
// "Last login" is the most recent successful login event on this account, not
// a stored profile field, so it can never go stale relative to the real trail.
router.get('/security-status', authenticate, asyncHandler(async (req, res) => {
  const [row, lastLogin, lastFailedLogin] = await Promise.all([
    db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [req.user.id]),
    db.get(`
      SELECT timestamp, action FROM audit_logs
      WHERE user_id = ? AND action IN ('LOGIN_SUCCESS','LOGIN_SUCCESS_2FA')
      ORDER BY timestamp DESC LIMIT 1
    `, [req.user.id]),
    db.get(`
      SELECT timestamp FROM audit_logs
      WHERE user_id = ? AND action IN ('LOGIN_FAILED','LOGIN_2FA_FAILED')
      ORDER BY timestamp DESC LIMIT 1
    `, [req.user.id]),
  ]);
  res.json({
    twoFactorEnabled: !!(row && row.enabled),
    accountCreatedAt: req.user.created_at,
    lastLogin: lastLogin ? { at: lastLogin.timestamp, via2fa: lastLogin.action === 'LOGIN_SUCCESS_2FA' } : null,
    lastFailedLoginAt: lastFailedLogin ? lastFailedLogin.timestamp : null,
  });
}));

// Batch 5 — self-service data export. Every user can export their OWN data
// only (req.user.id is the sole scope — never client-supplied), reusing the
// same excuse-aware attendance query pattern the rest of the app already
// uses. Never includes password_hash, TOTP secret/recovery codes, JWTs, or
// any other student's/user's data.
router.get('/my-data-export', authenticate, asyncHandler(async (req, res) => {
  const profile = {
    userId: req.user.user_id, name: req.user.name, email: req.user.email,
    role: req.user.role, department: req.user.department, accountCreatedAt: req.user.created_at
  };
  const notifications = await db.all(`
    SELECT title, message, type, created_at, read FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC LIMIT 200
  `, [req.user.id]);

  if (req.user.role !== 'student') {
    await logAudit(req.user.id, 'DATA_EXPORT_SELF', 'users', req.user.id, { role: req.user.role });
    return res.json({ exportedAt: new Date().toISOString(), profile, notifications });
  }

  const student = await db.get('SELECT * FROM students WHERE user_id = ?', [req.user.id]);
  const attendance = student ? await db.all(`
    SELECT cs.date, c.course_name, a.status, a.method, a.marked_at
    FROM attendance a JOIN class_sessions cs ON cs.id = a.session_id JOIN courses c ON c.id = cs.course_id
    WHERE a.student_id = ? ORDER BY cs.date DESC
  `, [student.id]) : [];
  const excuses = student ? await db.all(`
    SELECT ex.reason, ex.details, ex.status, ex.created_at, ex.reviewed_at, ex.reviewer_comment, c.course_name, cs.date as session_date
    FROM student_excuses ex JOIN class_sessions cs ON cs.id = ex.session_id JOIN courses c ON c.id = ex.course_id
    WHERE ex.student_id = ? ORDER BY ex.created_at DESC
  `, [student.id]) : [];

  await logAudit(req.user.id, 'DATA_EXPORT_SELF', 'students', student ? student.id : null, { role: 'student', attendanceRows: attendance.length, excuseRows: excuses.length });
  res.json({
    exportedAt: new Date().toISOString(),
    profile: { ...profile, rollNumber: student ? student.roll_number : null, section: student ? student.section : null },
    attendance, excuses, notifications
  });
}));

// Step 1 of enrollment: generate a secret (not yet active) and hand back the
// otpauth:// URI for the client to render as a QR code, plus the raw secret so
// it can also be typed in manually. This is the ONLY response that ever
// includes the secret.
router.post('/2fa/enroll', authenticate, twoFactorManageLimiter, asyncHandler(async (req, res) => {
  const existing = await db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [req.user.id]);
  if (existing && existing.enabled) return res.status(409).json({ error: '2FA is already enabled on this account. Disable it first to re-enroll.' });

  const secret = generateSecret();
  await db.run(`
    INSERT INTO user_2fa (user_id, secret, enabled) VALUES (?,?,FALSE)
    ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = FALSE, recovery_codes = NULL, updated_at = datetime('now')
  `, [req.user.id, secret]);

  res.json({ secret, otpauthUri: buildOtpauthUri(req.user.user_id, secret) });
}));

// Step 2: confirm the user actually captured the secret correctly by proving
// they can generate a current code. Only now does 2FA actually turn on, and
// only now are recovery codes created and shown (once, in plaintext).
router.post('/2fa/enroll/verify', authenticate, twoFactorManageLimiter, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const row = await db.get('SELECT * FROM user_2fa WHERE user_id = ?', [req.user.id]);
  if (!row) return res.status(400).json({ error: 'Start enrollment first.' });
  if (row.enabled) return res.status(409).json({ error: '2FA is already enabled on this account.' });
  if (!verifyTotp(code, row.secret)) return res.status(400).json({ error: 'Incorrect code. Check your authenticator app and try again.' });

  const recoveryCodes = generateRecoveryCodes();
  await db.run(`UPDATE user_2fa SET enabled = TRUE, recovery_codes = ?, enabled_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ?`,
    [JSON.stringify(hashRecoveryCodes(recoveryCodes)), req.user.id]);
  await logAudit(req.user.id, 'TWO_FA_ENABLED', 'users', req.user.id, {});
  res.json({ ok: true, recoveryCodes });
}));

// Disabling requires the current password — a stolen/left-open session tab
// alone should not be enough to turn off an account's second factor.
router.post('/2fa/disable', authenticate, twoFactorManageLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const row = await db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [req.user.id]);
  if (!row || !row.enabled) return res.status(409).json({ error: '2FA is not currently enabled.' });
  await db.run('DELETE FROM user_2fa WHERE user_id = ?', [req.user.id]);
  await logAudit(req.user.id, 'TWO_FA_DISABLED', 'users', req.user.id, {});
  res.json({ ok: true });
}));

// New codes replace the old set outright (old ones become unusable) — requires
// password confirmation for the same reason /disable does.
router.post('/2fa/recovery-codes/regenerate', authenticate, twoFactorManageLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const row = await db.get('SELECT enabled FROM user_2fa WHERE user_id = ?', [req.user.id]);
  if (!row || !row.enabled) return res.status(409).json({ error: '2FA is not currently enabled.' });

  const recoveryCodes = generateRecoveryCodes();
  await db.run(`UPDATE user_2fa SET recovery_codes = ?, updated_at = datetime('now') WHERE user_id = ?`,
    [JSON.stringify(hashRecoveryCodes(recoveryCodes)), req.user.id]);
  await logAudit(req.user.id, 'TWO_FA_RECOVERY_CODES_REGENERATED', 'users', req.user.id, {});
  res.json({ ok: true, recoveryCodes });
}));

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await logAudit(req.user.id, 'LOGOUT', 'users', req.user.id, {});
  res.json({ ok: true });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const u = req.user;
  let profile = null;
  if (u.role === 'student') profile = await db.get('SELECT * FROM students WHERE user_id = ?', [u.id]);
  if (u.role === 'faculty') profile = await db.get('SELECT * FROM faculty WHERE user_id = ?', [u.id]);
  const institution = u.institution_id != null
    ? await db.get('SELECT id, code, name FROM institutions WHERE id = ?', [u.institution_id])
    : null;
  res.json({
    user: { id: u.id, user_id: u.user_id, name: u.name, role: u.role, department: u.department, section: u.section, email: u.email, status: u.status },
    institution,
    profile
  });
}));

module.exports = router;
