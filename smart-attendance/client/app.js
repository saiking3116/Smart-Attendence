/* ==========================================================================
   Smart Attendance — client application
   Talks to the real Express/SQLite backend. No mock data lives here except
   static UI labels; every number on screen is fetched from /api/*.
   ========================================================================== */

const API = ''; // same-origin, server also serves this file

/* ================= STATE ================= */
let state = {
  token: localStorage.getItem('sa_token') || null,
  user: JSON.parse(localStorage.getItem('sa_user') || 'null'),
  role: null,
  page: 'home',
  qrPollTimer: null,
  qrCountdownTimer: null,
  cameraStream: null,
};

/* ================= THEME (light / dark) ================= */
function getTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyThemeIcon() {
  const icon = getTheme() === 'dark' ? '☀️' : '🌙';
  const a = document.getElementById('login-theme-btn');
  const b = document.getElementById('app-theme-btn');
  if (a) a.textContent = icon;
  if (b) b.textContent = icon;
}
function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sa_theme', next); } catch (e) {}
  applyThemeIcon();
}
applyThemeIcon();

const NAV = {
  student: [
    { id: 'home', label: 'Home', icon: '⌂' },
    { id: 'timetable', label: 'Timetable', icon: '▦' },
    { id: 'scan', label: 'Mark Attendance', icon: '◎' },
    { id: 'history', label: 'History', icon: '≡' },
    { id: 'excuses', label: 'Excuses', icon: '▯' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
  ],
  faculty: [
    { id: 'home', label: 'Home', icon: '⌂' },
    { id: 'take', label: 'Take Attendance', icon: '◎' },
    { id: 'reports', label: 'Reports', icon: '▤' },
    { id: 'excuses', label: 'Excuse Requests', icon: '▯' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
  ],
  admin: [
    { id: 'home', label: 'Overview', icon: '⌂' },
    { id: 'people', label: 'Users & Courses', icon: '◫' },
    { id: 'schedule', label: 'Timetable', icon: '▦' },
    { id: 'analytics', label: 'Analytics', icon: '▤' },
    { id: 'excuses', label: 'Excuses', icon: '▯' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
  ]
};

const TITLE_MAP = {
  student: { home: ['Home', "Today's overview"], timetable: ['Timetable', 'Your class schedule'], scan: ['Mark Attendance', 'Real-time check-in'], history: ['Attendance History', 'Your full record'], excuses: ['Excuse Requests', 'Request and track attendance excuses'], settings: ['Settings', 'Your account, security & preferences'] },
  faculty: { home: ['Home', "Today's schedule"], take: ['Take Attendance', 'Run a live session'], reports: ['Reports', 'Class performance & trends'], excuses: ['Excuse Requests', 'Review student attendance excuses'], settings: ['Settings', 'Your account, security & preferences'] },
  admin: { home: ['Overview', 'Institution snapshot'], people: ['Users & Courses', 'Manage the directory'], schedule: ['Timetable', 'Automatic attendance scheduling'], analytics: ['Analytics', 'Department-wide reporting'], excuses: ['Excuse Requests', 'Institution-wide excuse management'], settings: ['Settings', 'Your account, security & preferences'] }
};

/* ================= API HELPER ================= */
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (!(opts.body instanceof FormData) && opts.body) headers['Content-Type'] = 'application/json';
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;

  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
    });
  } catch (netErr) {
    throw new Error('Network error — is the server running?');
  }

  if (res.status === 401) {
    handleSignOut(true);
    throw new Error('Session expired. Please log in again.');
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new Error('Something went wrong (' + res.status + ').');
    return res; // caller handles blob/file responses
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

async function downloadFile(path, filename) {
  try {
    const headers = {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch(API + path, { headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Export failed.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Downloaded ' + filename);
  } catch (e) {
    showToast(e.message || 'Export failed.', 'error');
  }
}

/* ================= TOAST ================= */
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.className = type === 'error' ? 'show error' : 'show';
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ================= MODAL ================= */
function openModal(title, bodyHTML, footButtons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  const foot = document.getElementById('modal-foot');
  foot.innerHTML = '';
  (footButtons || []).forEach(b => {
    const btn = document.createElement('button');
    btn.className = b.className || 'btn-sm';
    btn.textContent = b.label;
    btn.onclick = b.onClick;
    btn.id = b.id || '';
    foot.appendChild(btn);
  });
  document.getElementById('modal-backdrop').classList.add('show');
}
function closeModal() { document.getElementById('modal-backdrop').classList.remove('show'); }
function confirmDialog(message, onConfirm) {
  openModal('Please confirm', `<p style="font-size:13.5px;color:var(--slate);line-height:1.6;">${message}</p>`, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: 'Confirm', className: 'btn-sm btn-danger', onClick: () => { closeModal(); onConfirm(); } }
  ]);
}

/* ================= LOGIN ================= */
const rolePillsEl = document.getElementById('role-pills');
let selectedLoginRole = 'student';
['student', 'faculty', 'admin'].forEach(r => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'role-pill' + (r === selectedLoginRole ? ' active' : '');
  b.textContent = r.charAt(0).toUpperCase() + r.slice(1);
  b.onclick = () => { selectedLoginRole = r; renderRolePills(); updateIdLabel(); };
  b.dataset.role = r;
  rolePillsEl.appendChild(b);
});
function renderRolePills() {
  [...rolePillsEl.children].forEach(b => b.classList.toggle('active', b.dataset.role === selectedLoginRole));
}
function updateIdLabel() {
  document.getElementById('id-label').textContent = selectedLoginRole === 'student' ? 'Register Number' : (selectedLoginRole === 'faculty' ? 'Staff ID' : 'Admin ID');
}
updateIdLabel();

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = document.getElementById('login-id').value.trim();
  const password = document.getElementById('login-pw').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  if (!userId || !password) { errEl.textContent = 'Please enter both an ID and a password.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('login-btn');
  const label = document.getElementById('login-btn-label');
  btn.disabled = true; label.innerHTML = '<span class="spin"></span>Signing in…';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { userId, password, role: selectedLoginRole } });
    if (data.requires2FA) {
      openTwoFaLoginModal(data.pendingToken, data.userLabel);
      return;
    }
    state.token = data.token; state.user = data.user;
    localStorage.setItem('sa_token', state.token);
    localStorage.setItem('sa_user', JSON.stringify(state.user));
    enterApp();
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; label.textContent = 'Sign in';
  }
});

// Second step of login when the account has 2FA enabled — password was
// already verified server-side; this only ever sends the short-lived pending
// ticket plus a code, never the password again.
function openTwoFaLoginModal(pendingToken, userLabel) {
  openModal('Two-factor authentication', `
    <p style="font-size:13px;color:var(--slate);line-height:1.6;">Hi ${escapeHtml(userLabel || '')}, enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
    <div class="field"><label>Code</label><input id="tfa-login-code" placeholder="123456 or XXXX-XXXX" style="letter-spacing:.1em;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:16px;"></div>
    <div class="field-error" id="tfa-login-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: 'Verify', className: 'btn-sm btn-verify', onClick: () => submitTwoFaLogin(pendingToken) }
  ]);
  setTimeout(() => document.getElementById('tfa-login-code')?.focus(), 0);
}
async function submitTwoFaLogin(pendingToken) {
  const errEl = document.getElementById('tfa-login-error');
  const code = document.getElementById('tfa-login-code').value.trim();
  if (!code) { errEl.textContent = 'Enter a code.'; return; }
  try {
    const data = await api('/api/auth/2fa/verify-login', { method: 'POST', body: { pendingToken, code } });
    state.token = data.token; state.user = data.user;
    localStorage.setItem('sa_token', state.token);
    localStorage.setItem('sa_user', JSON.stringify(state.user));
    closeModal();
    enterApp();
  } catch (e) { errEl.textContent = e.message; }
}

function enterApp() {
  state.role = state.user.role;
  state.page = 'home';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  document.getElementById('login-id').value = '';
  document.getElementById('login-pw').value = '';
  buildNav();
  applyUserChip();
  render();
  refreshNotifications();
  showToast('Welcome back, ' + state.user.name.split(' ')[0]);
}

async function handleSignOut(silent) {
  stopCamera();
  clearTimeout(state.qrPollTimer); clearTimeout(state.qrCountdownTimer);
  try { if (state.token) await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  state.token = null; state.user = null;
  localStorage.removeItem('sa_token'); localStorage.removeItem('sa_user');
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  if (!silent) showToast('Signed out');
}

/* ==========================================================================
   Feature: 2FA Security settings — identical for every role (student/faculty/
   admin all manage their OWN 2FA the same way; only admin additionally gets a
   "Reset 2FA" action on other users, wired in the admin Users table). Lives
   inside the Settings page (see renderSettingsPage) rather than a modal, so
   there is exactly one place in the UI to manage it.
   ========================================================================== */
async function refreshSettingsSecurity() {
  const body = document.getElementById('settings-security-body');
  if (!body) return;
  try {
    const status = await api('/api/auth/security-status');
    body.innerHTML = renderAccountSecurityInfo(status)
      + (status.twoFactorEnabled ? renderTwoFaEnabledView() : renderTwoFaDisabledView())
      + renderDataExportSection();
  } catch (e) {
    body.innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
}
// Batch 5 — account security visibility, built entirely from the existing
// audit trail (see /api/auth/security-status) — no new tracking added.
function renderAccountSecurityInfo(status) {
  const fmt = (iso) => iso ? new Date(iso.replace(' ', 'T')).toLocaleString() : 'Never';
  return `
  <div style="display:flex; flex-wrap:wrap; gap:14px; margin-bottom:16px; padding-bottom:14px; border-bottom:1px solid var(--line);">
    <div><div style="font-size:11px;color:var(--slate-dim);">Last successful login</div><div style="font-size:12.5px;">${fmt(status.lastLogin && status.lastLogin.at)}${status.lastLogin && status.lastLogin.via2fa ? ' (with 2FA)' : ''}</div></div>
    <div><div style="font-size:11px;color:var(--slate-dim);">Last failed attempt</div><div style="font-size:12.5px;">${fmt(status.lastFailedLoginAt)}</div></div>
    <div><div style="font-size:11px;color:var(--slate-dim);">Account created</div><div style="font-size:12.5px;">${fmt(status.accountCreatedAt)}</div></div>
  </div>`;
}
// Batch 5 — self-service export of the caller's OWN data only (server scopes
// to req.user.id — nothing here can be pointed at another account).
function renderDataExportSection() {
  return `
  <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--line);">
    <p style="font-size:12px;color:var(--slate-dim);text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px;">Your data</p>
    <p style="font-size:12.5px;color:var(--slate);line-height:1.6;margin:0 0 10px;">Download a copy of your own data as recorded by this app — profile, attendance history, excuse history, and notifications where applicable. Never includes your password, 2FA secret, or recovery codes.</p>
    <button class="btn-sm" onclick="downloadFile('/api/auth/my-data-export','my_data_export.json')">Download my data (JSON)</button>
  </div>`;
}
function renderTwoFaDisabledView() {
  return `
  <p style="font-size:13px;color:var(--slate);line-height:1.6;">Two-factor authentication (2FA) adds a second step to your login using an authenticator app — Google Authenticator, Microsoft Authenticator, Authy, or any other TOTP app. It's optional.</p>
  <button class="btn-sm btn-dark" onclick="startTwoFaEnrollment()">Enable 2FA</button>
  <div id="tfa-enroll-area" style="margin-top:16px;"></div>`;
}
function renderTwoFaEnabledView() {
  return `
  <div class="badge green" style="margin-bottom:14px;"><span class="dot"></span>2FA is enabled on your account</div>
  <p style="font-size:12.5px;color:var(--slate);line-height:1.6;">You'll be asked for a code from your authenticator app (or a recovery code) every time you log in.</p>
  <div class="field"><label>Password (required for the actions below)</label><input type="password" id="tfa-password" placeholder="Confirm your password"></div>
  <div class="field-error" id="tfa-error"></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn-sm" onclick="regenerateRecoveryCodes()">Regenerate recovery codes</button>
    <button class="btn-sm btn-danger" onclick="disableTwoFa()">Disable 2FA</button>
  </div>
  <div id="tfa-codes-area" style="margin-top:14px;"></div>`;
}
async function startTwoFaEnrollment() {
  const area = document.getElementById('tfa-enroll-area');
  area.innerHTML = skeletonBlock(60);
  try {
    const { secret, otpauthUri } = await api('/api/auth/2fa/enroll', { method: 'POST' });
    area.innerHTML = `
      <div style="text-align:center;">
        <div style="background:#fff;display:inline-block;padding:12px;border-radius:10px;" id="tfa-qr"></div>
        <p style="font-size:11.5px;color:var(--slate);margin:10px 0 2px;">Scan with your authenticator app, or enter this code manually:</p>
        <p class="mono" style="font-size:13px;font-weight:700;letter-spacing:.05em;">${escapeHtml(secret)}</p>
      </div>
      <div class="field" style="margin-top:10px;"><label>Enter the 6-digit code from your app</label><input id="tfa-verify-code" maxlength="6" placeholder="123456" style="letter-spacing:.2em;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:16px;"></div>
      <div class="field-error" id="tfa-verify-error"></div>
      <button class="btn-sm btn-verify" onclick="confirmTwoFaEnrollment()">Verify &amp; enable</button>`;
    if (window.QRCode) new QRCode(document.getElementById('tfa-qr'), { text: otpauthUri, width: 170, height: 170, colorDark: '#12172B', colorLight: '#ffffff' });
  } catch (e) {
    area.innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
}
async function confirmTwoFaEnrollment() {
  const errEl = document.getElementById('tfa-verify-error');
  const code = document.getElementById('tfa-verify-code').value.trim();
  if (!code) { errEl.textContent = 'Enter the 6-digit code.'; return; }
  try {
    const { recoveryCodes } = await api('/api/auth/2fa/enroll/verify', { method: 'POST', body: { code } });
    showToast('2FA enabled');
    document.getElementById('settings-security-body').innerHTML = renderRecoveryCodesView(recoveryCodes);
  } catch (e) { errEl.textContent = e.message; }
}
function renderRecoveryCodesView(codes) {
  return `
  <div class="badge green" style="margin-bottom:12px;"><span class="dot"></span>2FA is enabled</div>
  <p style="font-size:12.5px;color:var(--slate);line-height:1.6;">Save these one-time recovery codes somewhere safe — each can be used once to sign in if you lose access to your authenticator app. They will not be shown again.</p>
  <div class="mono" style="background:var(--paper);border-radius:10px;padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px;">
    ${codes.map(c => `<div>${escapeHtml(c)}</div>`).join('')}
  </div>
  <button class="btn-sm btn-dark" style="margin-top:14px;" onclick="refreshSettingsSecurity()">Done</button>`;
}
async function disableTwoFa() {
  const errEl = document.getElementById('tfa-error');
  const password = document.getElementById('tfa-password').value;
  if (!password) { errEl.textContent = 'Enter your password to continue.'; return; }
  try {
    await api('/api/auth/2fa/disable', { method: 'POST', body: { password } });
    showToast('2FA disabled');
    refreshSettingsSecurity();
  } catch (e) { errEl.textContent = e.message; }
}
async function regenerateRecoveryCodes() {
  const errEl = document.getElementById('tfa-error');
  const password = document.getElementById('tfa-password').value;
  if (!password) { errEl.textContent = 'Enter your password to continue.'; return; }
  try {
    const { recoveryCodes } = await api('/api/auth/2fa/recovery-codes/regenerate', { method: 'POST', body: { password } });
    showToast('Recovery codes regenerated');
    document.getElementById('tfa-codes-area').innerHTML = renderRecoveryCodesView(recoveryCodes);
  } catch (e) { errEl.textContent = e.message; }
}

/* ==========================================================================
   Settings page — consolidates User Information, Security & 2FA, and
   Preferences (theme + notifications) into one place for every role.
   Reuses existing data/APIs (/api/auth/me, /api/auth/security-status, the
   2FA endpoints, theme toggle, notifications) rather than introducing new
   ones.
   ========================================================================== */
async function renderSettingsPage() {
  let me;
  try {
    me = await api('/api/auth/me');
  } catch (e) {
    return `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
  const u = me.user;
  const institutionName = me.institution ? me.institution.name : '—';
  const status = u.status || 'active';
  const roleLabel = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  const idLabel = u.role === 'student' ? 'Register Number' : u.role === 'faculty' ? 'Staff ID' : 'Admin ID';

  const infoField = (label, valueHtml) => `
    <div>
      <div style="font-size:11px;color:var(--slate-dim);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">${escapeHtml(label)}</div>
      <div style="font-size:13.5px;font-weight:600;">${valueHtml}</div>
    </div>`;

  return `
  <div class="grid" style="gap:18px;">
    <div class="card">
      <h3>User information</h3>
      <p class="cap">Your account details on record</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px;">
        ${infoField('Full name', escapeHtml(u.name))}
        ${infoField(idLabel, escapeHtml(u.user_id))}
        ${infoField('Email', escapeHtml(u.email || '—'))}
        ${infoField('Role', escapeHtml(roleLabel))}
        ${infoField('Department', escapeHtml(u.department || '—'))}
        ${infoField('Institution', escapeHtml(institutionName))}
        ${infoField('Account status', `<span class="badge ${status === 'active' ? 'green' : 'red'}"><span class="dot"></span>${escapeHtml(status)}</span>`)}
      </div>
    </div>

    <div class="card">
      <h3>Security &amp; two-factor authentication</h3>
      <p class="cap">Manage how you sign in to your account</p>
      <div id="settings-security-body">${skeletonBlock(80)}</div>
    </div>

    <div class="card">
      <h3>Preferences</h3>
      <p class="cap">Appearance and notifications</p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--line);">
        <div>
          <div style="font-size:13.5px;font-weight:600;">Appearance</div>
          <div style="font-size:12px;color:var(--slate);margin-top:2px;">Currently using ${getTheme() === 'dark' ? 'dark' : 'light'} mode</div>
        </div>
        <button class="btn-sm" onclick="toggleTheme(); render();">Switch to ${getTheme() === 'dark' ? 'light' : 'dark'} mode</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0;">
        <div>
          <div style="font-size:13.5px;font-weight:600;">Notifications</div>
          <div style="font-size:12px;color:var(--slate);margin-top:2px;">View recent alerts or clear your unread count</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-sm" onclick="toggleNotifPanel()">View notifications</button>
          <button class="btn-sm" onclick="markAllNotifsRead()">Mark all read</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ================= SIGNUP ================= */
let selectedSignupRole = 'student';

/* ================= ACADEMIC STRUCTURE (Department / Academic Year / Section) ================= */
// Never hardcoded — always fetched live from the database via /api/auth/academic-structure.
let academicStructureCache = null;
async function loadAcademicStructure() {
  if (academicStructureCache) return academicStructureCache;
  academicStructureCache = await fetch('/api/auth/academic-structure').then(r => r.json());
  return academicStructureCache;
}
function populateSelect(selectEl, options, placeholder) {
  if (!selectEl) return;
  const current = selectEl.value;
  selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  if (options.includes(current)) selectEl.value = current;
}
// Wires a Department + Academic Year -> dependent Section cascade onto three
// existing <select> elements. Reused by both the signup form and the admin
// Add/Edit User modal so the filtering logic lives in exactly one place.
async function wireAcademicDropdowns({ deptEl, yearEl, sectionEl, onReady } = {}) {
  const data = await loadAcademicStructure();
  if (deptEl) populateSelect(deptEl, data.departments, 'Select department…');
  if (yearEl) populateSelect(yearEl, data.years, 'Select academic year…');
  const updateSections = () => {
    if (!sectionEl) return;
    const dept = deptEl ? deptEl.value : null;
    const year = yearEl ? yearEl.value : null;
    if (!dept || !year) {
      sectionEl.innerHTML = '<option value="">Select department and year first…</option>';
      return;
    }
    const matches = data.sections.filter(s => s.department === dept && s.year_of_study === year);
    if (!matches.length) {
      sectionEl.innerHTML = '<option value="">No section configured yet — contact admin</option>';
      return;
    }
    populateSelect(sectionEl, matches.map(m => m.section), 'Select section…');
  };
  if (deptEl) deptEl.onchange = updateSections;
  if (yearEl) yearEl.onchange = updateSections;
  if (sectionEl) updateSections();
  if (onReady) onReady(data);
  return data;
}

function showSignup() {
  // hide login elements
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('login-error').style.display = 'none';
  document.querySelector('.login-form-side h1').style.display = 'none';
  document.querySelector('.login-form-side p.lede').style.display = 'none';
  document.getElementById('role-pills').style.display = 'none';
  document.querySelector('.login-hint').style.display = 'none';
  document.querySelector('.signup-link-row').style.display = 'none';
  // show signup panel
  document.getElementById('signup-panel').style.display = 'block';
  // reset form
  selectedSignupRole = 'student';
  renderSignupRoleTabs();
  showSignupFields('student');
  document.getElementById('signup-error').style.display = 'none';
  document.getElementById('signup-success').style.display = 'none';
  document.getElementById('signup-form').reset();

  wireAcademicDropdowns({
    deptEl: document.getElementById('su-student-dept'),
    yearEl: document.getElementById('su-student-year'),
    sectionEl: document.getElementById('su-student-sec')
  }).catch(() => showToast('Could not load department/section options — is the server running?', 'error'));
  loadAcademicStructure().then(data => populateSelect(document.getElementById('su-fac-dept'), data.departments, 'Select department…'));
}

function showLogin() {
  document.getElementById('signup-panel').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
  document.querySelector('.login-form-side h1').style.display = '';
  document.querySelector('.login-form-side p.lede').style.display = '';
  document.getElementById('role-pills').style.display = 'flex';
  document.querySelector('.login-hint').style.display = '';
  document.querySelector('.signup-link-row').style.display = '';
  document.getElementById('login-error').style.display = 'none';
}

function selectSignupRole(role) {
  selectedSignupRole = role;
  renderSignupRoleTabs();
  showSignupFields(role);
  document.getElementById('signup-error').style.display = 'none';
  document.getElementById('signup-success').style.display = 'none';
}

function renderSignupRoleTabs() {
  document.querySelectorAll('.signup-role-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.srole === selectedSignupRole);
  });
}

function showSignupFields(role) {
  ['student', 'faculty', 'admin'].forEach(r => {
    const el = document.getElementById('sf-' + r);
    if (el) el.style.display = r === role ? 'block' : 'none';
  });
}

document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('signup-error');
  const succEl = document.getElementById('signup-success');
  errEl.style.display = 'none';
  succEl.style.display = 'none';

  const btn = document.getElementById('signup-btn');
  const label = document.getElementById('signup-btn-label');

  function showSignupError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  // Build payload based on role
  let payload = { role: selectedSignupRole };

  if (selectedSignupRole === 'student') {
    const registerNumber = (document.getElementById('su-reg').value || '').trim();
    const fullName = (document.getElementById('su-student-name').value || '').trim();
    const email = (document.getElementById('su-student-email').value || '').trim();
    const department = (document.getElementById('su-student-dept').value || '').trim();
    const year_of_study = (document.getElementById('su-student-year').value || '').trim();
    const section = (document.getElementById('su-student-sec').value || '').trim();
    const password = document.getElementById('su-student-pw').value;
    const confirmPassword = document.getElementById('su-student-cpw').value;

    if (!registerNumber) return showSignupError('Register Number is required.');
    if (!fullName) return showSignupError('Full Name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showSignupError('Please enter a valid email address.');
    if (!department) return showSignupError('Department is required.');
    if (!year_of_study) return showSignupError('Academic Year is required.');
    if (!section) return showSignupError('Section is required.');
    if (!password || password.length < 6) return showSignupError('Password must be at least 6 characters.');
    if (password !== confirmPassword) return showSignupError('Passwords do not match.');

    Object.assign(payload, { registerNumber, fullName, email, department, year_of_study, section, password, confirmPassword });

  } else if (selectedSignupRole === 'faculty') {
    const facultyId = (document.getElementById('su-fac-id').value || '').trim();
    const fullName = (document.getElementById('su-fac-name').value || '').trim();
    const email = (document.getElementById('su-fac-email').value || '').trim();
    const department = (document.getElementById('su-fac-dept').value || '').trim();
    const password = document.getElementById('su-fac-pw').value;
    const confirmPassword = document.getElementById('su-fac-cpw').value;

    if (!facultyId) return showSignupError('Faculty ID is required.');
    if (!fullName) return showSignupError('Full Name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showSignupError('Please enter a valid email address.');
    if (!department) return showSignupError('Department is required.');
    if (!password || password.length < 6) return showSignupError('Password must be at least 6 characters.');
    if (password !== confirmPassword) return showSignupError('Passwords do not match.');

    Object.assign(payload, { facultyId, fullName, email, department, password, confirmPassword });

  } else if (selectedSignupRole === 'admin') {
    const adminId = (document.getElementById('su-adm-id').value || '').trim();
    const fullName = (document.getElementById('su-adm-name').value || '').trim();
    const email = (document.getElementById('su-adm-email').value || '').trim();
    const password = document.getElementById('su-adm-pw').value;
    const confirmPassword = document.getElementById('su-adm-cpw').value;
    const adminKey = document.getElementById('su-adm-key').value;

    if (!adminId) return showSignupError('Admin ID is required.');
    if (!fullName) return showSignupError('Full Name is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showSignupError('Please enter a valid email address.');
    if (!password || password.length < 6) return showSignupError('Password must be at least 6 characters.');
    if (password !== confirmPassword) return showSignupError('Passwords do not match.');
    if (!adminKey) return showSignupError('Admin Registration Key is required.');

    Object.assign(payload, { adminId, fullName, email, password, confirmPassword, adminKey });
  }

  btn.disabled = true;
  label.innerHTML = '<span class="spin"></span>Creating account…';

  try {
    const data = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Registration failed.');
      return d;
    });

    // success
    succEl.textContent = (data.message || 'Account created!') + ' Redirecting to sign in…';
    succEl.style.display = 'block';
    document.getElementById('signup-form').style.display = 'none';
    document.querySelectorAll('.signup-role-tabs').forEach(el => el.style.display = 'none');

    setTimeout(() => {
      document.getElementById('signup-form').style.display = 'block';
      document.querySelectorAll('.signup-role-tabs').forEach(el => el.style.display = 'flex');
      showLogin();
      // pre-fill the login ID for convenience
      const loginId = payload.registerNumber || payload.facultyId || payload.adminId || '';
      document.getElementById('login-id').value = loginId;
      // switch login role pill
      const roleMap = { student: 'student', faculty: 'faculty', admin: 'admin' };
      selectedLoginRole = roleMap[selectedSignupRole] || 'student';
      renderRolePills();
      updateIdLabel();
    }, 2000);

  } catch (err) {
    showSignupError(err.message);
  } finally {
    btn.disabled = false;
    label.textContent = 'Create Account';
  }
});

/* try to resume a session on page load */

(async function tryResume() {
  document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  if (!state.token || !state.user) return;
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    localStorage.setItem('sa_user', JSON.stringify(state.user));
    enterApp();
  } catch (e) {
    handleSignOut(true);
  }
})();

/* ================= NAV / SHELL ================= */
function buildNav() {
  const wrap = document.getElementById('nav-items');
  wrap.innerHTML = '';
  NAV[state.role].forEach(item => {
    const b = document.createElement('button');
    b.className = 'nav-item' + (item.id === state.page ? ' active' : '');
    b.innerHTML = `<span class="ic">${item.icon}</span><span>${item.label}</span>`;
    b.onclick = () => { state.page = item.id; buildNav(); render(); };
    wrap.appendChild(b);
  });
  const mwrap = document.getElementById('mobile-nav');
  mwrap.innerHTML = '';
  NAV[state.role].forEach(item => {
    const b = document.createElement('button');
    b.className = 'm-item' + (item.id === state.page ? ' active' : '');
    b.textContent = item.label;
    b.onclick = () => { state.page = item.id; buildNav(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    mwrap.appendChild(b);
  });
  const signoutBtn = document.createElement('button');
  signoutBtn.className = 'mobile-signout';
  signoutBtn.textContent = 'Sign out';
  signoutBtn.onclick = () => handleSignOut();
  mwrap.appendChild(signoutBtn);
}
function goToScan() {
  state.page = 'scan';
  buildNav();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function applyUserChip() {
  const u = state.user;
  document.getElementById('side-avatar').textContent = u.name.charAt(0);
  document.getElementById('side-name').textContent = u.name;
  document.getElementById('side-role').textContent = u.role.toUpperCase() + ' · ' + u.user_id;
}

/* ================= NOTIFICATIONS ================= */
async function refreshNotifications() {
  try {
    const data = await api('/api/notifications');
    const badge = document.getElementById('bell-badge');
    if (data.unread > 0) { badge.style.display = 'flex'; badge.textContent = data.unread > 9 ? '9+' : data.unread; }
    else badge.style.display = 'none';
    const list = document.getElementById('notif-list');
    if (!data.rows.length) {
      list.innerHTML = '<div class="empty-note">No notifications yet.</div>';
      return;
    }
    list.innerHTML = data.rows.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="readNotif(${n.id})">
        <div class="notif-ic ${n.type}"></div>
        <div>
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-msg">${escapeHtml(n.message)}</div>
          <div class="notif-time">${timeAgo(n.created_at)}</div>
        </div>
      </div>`).join('');
  } catch (e) { /* silent - notifications are non-critical */ }
}
async function readNotif(id) {
  try { await api(`/api/notifications/${id}/read`, { method: 'PUT' }); refreshNotifications(); } catch (e) {}
}
async function markAllNotifsRead() {
  try { await api('/api/notifications/read-all', { method: 'PUT' }); refreshNotifications(); showToast('All notifications marked read'); } catch (e) {}
}
function toggleNotifPanel() {
  const p = document.getElementById('notif-panel');
  p.classList.toggle('show');
  if (p.classList.contains('show')) refreshNotifications();
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  const bell = document.getElementById('bell-btn');
  if (panel.classList.contains('show') && !panel.contains(e.target) && !bell.contains(e.target)) panel.classList.remove('show');
});

/* ================= UTIL ================= */
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function timeAgo(iso) {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
function skeletonBlock(h) { return `<div class="card"><div class="skel skel-line" style="width:40%"></div><div class="skel" style="height:${h || 120}px;border-radius:12px;"></div></div>`; }

/* ================= RENDER ROUTER ================= */
async function render() {
  const [t, s] = TITLE_MAP[state.role][state.page];
  document.getElementById('page-title').textContent = t;
  document.getElementById('page-sub').textContent = s;
  const c = document.getElementById('page-content');
  c.innerHTML = `<div class="grid g-4">${skeletonBlock(50)}${skeletonBlock(50)}${skeletonBlock(50)}${skeletonBlock(50)}</div>`;

  try {
    let html = '';
    if (state.page === 'settings') {
      html = await renderSettingsPage();
    } else if (state.role === 'student') {
      if (state.page === 'home') html = await studentHome();
      if (state.page === 'timetable') html = await studentTimetable();
      if (state.page === 'scan') html = await studentScan();
      if (state.page === 'history') html = await studentHistory();
      if (state.page === 'excuses') html = await studentExcuses();
    } else if (state.role === 'faculty') {
      if (state.page === 'home') html = await facultyHome();
      if (state.page === 'take') html = await facultyTake();
      if (state.page === 'reports') html = await facultyReports();
      if (state.page === 'excuses') html = await facultyExcuses();
    } else {
      if (state.page === 'home') html = await adminHome();
      if (state.page === 'people') html = await adminPeople();
      if (state.page === 'schedule') html = await adminSchedule();
      if (state.page === 'analytics') html = await adminAnalytics();
      if (state.page === 'excuses') html = await adminExcuses();
    }
    c.innerHTML = html;
    if (state.page === 'settings') refreshSettingsSecurity();
    if (state.role === 'admin' && state.page === 'people') wireAdminPeopleEvents();
    if (state.role === 'admin' && state.page === 'analytics') wireAdminAnalyticsEvents('overview');
    if (state.role === 'faculty' && state.page === 'reports') wireFacultyReportsEvents();
    if (state.role === 'faculty' && state.page === 'excuses') wireFacultyExcusesEvents();
    if (state.role === 'admin' && state.page === 'excuses') wireAdminExcusesEvents();
    if (state.role === 'student' && state.page === 'excuses') wireStudentExcusesEvents();
  } catch (e) {
    c.innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
}

/* ================= CHART HELPERS ================= */
function ringSVG(pct, color) {
  const r = 42, circ = 2 * Math.PI * r, off = circ * (1 - pct / 100);
  return `<svg width="104" height="104" viewBox="0 0 104 104">
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="var(--paper)" stroke-width="10"/>
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 52 52)"/>
    <text x="52" y="58" text-anchor="middle" font-family="Space Grotesk" font-size="22" font-weight="700" fill="var(--ink)">${pct}%</text>
  </svg>`;
}
function barColor(pct) { return pct >= 80 ? '' : pct >= 70 ? 'amber' : 'red'; }
function barRows(data) {
  if (!data.length) return '<div class="empty-note">No data yet.</div>';
  return data.map(d => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(d.name)}</div>
      <div class="bar-track"><div class="bar-fill ${barColor(d.pct)}" style="width:${d.pct}%"></div></div>
      <div class="bar-val">${d.pct}%</div>
    </div>`).join('');
}
function lineChartSVG(values, labels, color) {
  if (!values.length) return '<div class="empty-note">Not enough data yet to chart a trend.</div>';
  const w = 560, h = 160, pad = 28;
  const max = Math.max(...values) + 8, min = Math.min(...values) - 8;
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 1.6);
    return [x, y];
  });
  const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = path + ` L${pts[pts.length - 1][0]},${h - pad} L${pts[0][0]},${h - pad} Z`;
  const dots = pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.4" fill="${color}"/>`).join('');
  const labs = pts.map((p, i) => `<text x="${p[0]}" y="${h - 6}" text-anchor="middle" class="chart-tooltip-label">${labels[i] || ''}</text>`).join('');
  return `<div class="linechart-wrap"><svg viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="lg1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#lg1)"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.2"/>
    ${dots}${labs}
  </svg></div>`;
}
function vBarsSVG(data, color) {
  if (!data.length) return '<div class="empty-note">No data yet.</div>';
  const w = 560, h = 180, pad = 30, gap = 18;
  const bw = (w - pad * 2 - gap * (data.length - 1)) / data.length;
  const max = 100;
  const bars = data.map((d, i) => {
    const x = pad + i * (bw + gap);
    const bh = (d.pct / max) * (h - pad * 2);
    const y = h - pad - bh;
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6" fill="${color}"/>
      <text x="${x + bw / 2}" y="${y - 8}" text-anchor="middle" font-family="IBM Plex Mono" font-size="11" fill="var(--ink)">${d.pct}%</text>
      <text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle" class="chart-tooltip-label">${escapeHtml(d.name)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%">${bars}</svg>`;
}
function statusBadge(status) {
  const s = (status || '').toLowerCase();
  if (s === 'present' || s === 'verified') return `<span class="badge green"><span class="dot"></span>${s === 'verified' ? 'Verified' : 'Present'}</span>`;
  if (s === 'late' || s === 'pending') return `<span class="badge amber"><span class="dot"></span>${s === 'pending' ? 'Pending' : 'Late'}</span>`;
  if (s === 'upcoming') return `<span class="badge slate">Upcoming</span>`;
  return `<span class="badge red"><span class="dot"></span>${s === 'flagged' ? 'Flagged' : 'Absent'}</span>`;
}
function riskBadge(risk) {
  const cls = risk === 'High Risk' ? 'high' : risk === 'Medium Risk' ? 'medium' : 'low';
  return `<span class="badge risk-badge ${cls}"><span class="dot"></span>${risk}</span>`;
}
// Batch 5 — Predictive Attendance Model badge. Deliberately separate from
// riskBadge() above: that one renders the anti-proxy/fraud risk_events level
// ("High Risk" strings from riskEngine.js); this renders the attendance-
// trajectory prediction level (lowercase 'low'/'medium'/'high'/'insufficient'
// from attendancePrediction.js) — a different question, kept visually similar
// (same .risk-badge colors) but never merged into one badge type.
function predictionRiskBadge(level) {
  if (level === 'insufficient') return '<span class="badge slate">Not enough data</span>';
  const label = level === 'high' ? 'High Risk' : level === 'medium' ? 'Medium Risk' : 'Low Risk';
  return `<span class="badge risk-badge ${level}"><span class="dot"></span>${label}</span>`;
}
function predictionTrendLabel(trend) {
  if (trend === 'improving') return '▲ Improving';
  if (trend === 'declining') return '▼ Declining';
  if (trend === 'stable') return '— Stable';
  return 'Not enough data yet';
}
function excuseStatusBadge(status) {
  if (status === 'approved') return `<span class="badge green"><span class="dot"></span>Approved</span>`;
  if (status === 'rejected') return `<span class="badge red"><span class="dot"></span>Rejected</span>`;
  return `<span class="badge amber"><span class="dot"></span>Pending</span>`;
}

/* ==========================================================================
   STUDENT PAGES
   ========================================================================== */
function attendanceStatusBadge(status) {
  const cls = status === 'Good' ? 'green' : status === 'Warning' ? 'amber' : 'red';
  return `<span class="badge ${cls}"><span class="dot"></span>${status}</span>`;
}

async function studentHome() {
  const [d, active, weekly] = await Promise.all([
    api('/api/students/dashboard'),
    api('/api/attendance/active'),
    api('/api/students/reports/weekly').catch(() => null)
  ]);
  const overall = d.overall;

  const currentClass = (active.sessions || [])[0] || null;

  return `
  ${currentClass ? `
  <div class="card" style="margin-bottom:18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
    <div>
      <p class="cap" style="margin:0 0 4px;">Current class</p>
      <h3 style="margin:0;">${escapeHtml(currentClass.course_name)}</h3>
      <p style="font-size:13px;color:var(--slate);margin:4px 0 0;">${currentClass.start_time}${currentClass.end_time ? '–' + currentClass.end_time : ''} · ${escapeHtml(currentClass.faculty_name)} · Room ${escapeHtml(currentClass.room || '—')}</p>
    </div>
    ${currentClass.my_status
      ? `<span class="badge green"><span class="dot"></span>Already marked ${currentClass.my_status}</span>`
      : `<button class="btn-sm btn-verify" onclick="goToScan()">Mark Attendance</button>`}
  </div>` : ''}
  <div class="grid g-2">
    <div class="card">
      <h3>Overall attendance</h3>
      <p class="cap">Across all enrolled subjects this semester</p>
      <div class="ring-wrap">
        ${ringSVG(overall, overall >= d.threshold ? 'var(--verify)' : 'var(--red)')}
        <div>
          <div style="font-size:13px;color:var(--slate);margin-bottom:6px;">${escapeHtml(d.prediction)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <span class="badge ${overall >= d.threshold ? 'green' : 'red'}"><span class="dot"></span>${overall >= d.threshold ? 'Eligible' : 'At risk'}</span>
            ${attendanceStatusBadge(d.attendanceStatus)}
          </div>
        </div>
      </div>
      <div style="display:flex; gap:22px; margin-top:16px; padding-top:14px; border-top:1px solid var(--line);">
        <div><div class="mono" style="font-size:20px;font-weight:700;color:var(--verify);">${d.classesAttended}</div><div style="font-size:11.5px;color:var(--slate);">Classes attended</div></div>
        <div><div class="mono" style="font-size:20px;font-weight:700;color:var(--red);">${d.classesMissed}</div><div style="font-size:11.5px;color:var(--slate);">Classes missed</div></div>
        <div><div class="mono" style="font-size:20px;font-weight:700;color:#9c6a12;">${d.classesExcused}</div><div style="font-size:11.5px;color:var(--slate);">Excused</div></div>
      </div>
    </div>
    <div class="card">
      <h3>Subject-wise breakdown</h3>
      <p class="cap">${d.subjects.length ? '' : 'No attendance recorded yet'}</p>
      ${barRows(d.subjects)}
    </div>
  </div>

  <div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px;">
      <div><h3 style="margin-bottom:2px;">Attendance Risk Prediction</h3><p class="cap" style="margin:0;">A transparent, rule-based estimate — not AI, and never affects your attendance record</p></div>
      ${predictionRiskBadge(d.riskPrediction.level)}
    </div>
    ${d.riskPrediction.level === 'insufficient' ? `
    <div class="empty-note" style="margin-top:12px;">${escapeHtml(d.riskPrediction.explanation)}</div>` : `
    <div style="display:flex; gap:22px; margin-top:14px; flex-wrap:wrap;">
      <div><div class="mono" style="font-size:18px;font-weight:700;">${d.riskPrediction.pct}%</div><div style="font-size:11.5px;color:var(--slate);">Current attendance</div></div>
      <div><div class="mono" style="font-size:18px;font-weight:700;">${predictionTrendLabel(d.riskPrediction.trend)}</div><div style="font-size:11.5px;color:var(--slate);">Recent trend</div></div>
      <div><div class="mono" style="font-size:18px;font-weight:700;">${d.riskPrediction.classesNeededFor75.needed}</div><div style="font-size:11.5px;color:var(--slate);">Classes needed for 75%</div></div>
    </div>
    <p style="font-size:13px;color:var(--ink);margin:14px 0 4px;">${escapeHtml(d.riskPrediction.explanation)}</p>
    <p style="font-size:13px;color:var(--slate);margin:0;">${escapeHtml(d.riskPrediction.recommendation)}</p>`}
  </div>

  ${weekly && weekly.weekStart ? `
  <div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div><h3 style="margin-bottom:2px;">This week</h3><p class="cap" style="margin:0;">${weekly.weekStart} – ${weekly.weekEnd}</p></div>
      ${weekTrendBadge(weekly.comparison.trend)}
    </div>
    <div style="display:flex; gap:22px; margin-top:14px; flex-wrap:wrap;">
      <div><div class="mono" style="font-size:18px;font-weight:700;">${weekly.totals.overallPct}%</div><div style="font-size:11.5px;color:var(--slate);">Weekly attendance</div></div>
      <div><div class="mono" style="font-size:18px;font-weight:700;color:var(--verify);">${weekly.totals.presentCount}</div><div style="font-size:11.5px;color:var(--slate);">Present</div></div>
      <div><div class="mono" style="font-size:18px;font-weight:700;color:var(--red);">${weekly.totals.absentCount}</div><div style="font-size:11.5px;color:var(--slate);">Absent</div></div>
      <div><div class="mono" style="font-size:18px;font-weight:700;color:#9c6a12;">${weekly.totals.lateCount}</div><div style="font-size:11.5px;color:var(--slate);">Late</div></div>
      <div><div class="mono" style="font-size:18px;font-weight:700;">${weekly.courseWise.length}</div><div style="font-size:11.5px;color:var(--slate);">Courses this week</div></div>
    </div>
  </div>` : ''}

  <div class="grid g-2" style="margin-top:18px;">
    <div class="card">
      <h3>Today's classes</h3>
      <p class="cap">${d.student.section}</p>
      ${d.todaysClasses.length ? `<table>
        <thead><tr><th>Time</th><th>Subject</th><th>Faculty</th><th>Status</th></tr></thead>
        <tbody>${d.todaysClasses.map(c => `
          <tr class="rowhover"><td class="mono">${c.start_time}</td><td>${escapeHtml(c.course_name)}</td><td>${escapeHtml(c.faculty_name)}</td>
          <td>${c.my_status ? statusBadge(c.my_status) : (c.session_status === 'open' ? '<span class="session-live"><span class="pulse"></span>LIVE</span>' : statusBadge('upcoming'))}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty-note">No classes scheduled for today.</div>'}
    </div>
    <div class="card">
      <h3>Recent activity</h3>
      <p class="cap">Latest check-ins</p>
      <div class="timeline">
        ${d.recent.length ? d.recent.map(r => `
          <div class="tl-item"><div class="tl-dot ${r.status === 'present' ? '' : r.status === 'late' ? 'amber' : 'red'}"></div>
            <div class="tl-title">${escapeHtml(r.course_name)} — ${r.status.charAt(0).toUpperCase() + r.status.slice(1)}</div>
            <div class="tl-meta">${r.date} ${r.marked_at ? '· ' + r.marked_at.split(' ').pop() : ''} ${r.method && r.method !== 'manual' ? '· ' + r.method.toUpperCase() : ''} ${r.confidence ? '· ' + r.confidence + '%' : ''}</div></div>`).join('')
          : '<div class="empty-note">No activity yet.</div>'}
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:18px;">
    <h3>Smart insights</h3>
    <p class="cap">Automatically generated from your attendance data</p>
    ${d.insights.map(i => `<div class="insight-item"><div class="insight-dot"></div><div>${escapeHtml(i)}</div></div>`).join('')}
  </div>`;
}

function periodStatusBadge(status) {
  if (status === 'ongoing') return `<span class="session-live"><span class="pulse"></span>ONGOING</span>`;
  if (status === 'upcoming') return `<span class="badge slate">Upcoming</span>`;
  if (status === 'completed') return `<span class="badge slate" style="opacity:.65;">Completed</span>`;
  return '';
}

const TT_DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TT_DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TT_DAYS = [1, 2, 3, 4, 5, 6];

// Renders one day's periods in the same list style as before (time / subject /
// code / faculty / room / status). Shared by the initial render and by the day
// tabs so there's exactly one place that knows how to draw a day's schedule.
function renderDaySchedule(periods) {
  if (!periods.length) return '<div class="empty-note">No classes scheduled for this day.</div>';
  return periods.map(p => {
    if (p.period_type !== 'class') {
      return `<div class="tt-break-row">${p.start_time} – ${p.end_time} · ${escapeHtml(p.label || '')}</div>`;
    }
    const ongoing = p.status === 'ongoing';
    return `<div class="tt-class-row${ongoing ? ' ongoing' : ''}">
      <div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--slate-dim);margin-bottom:4px;">${p.start_time} – ${p.end_time}</div>
        <h3 style="margin:0 0 2px;">${escapeHtml(p.course_name)}</h3>
        <p style="font-size:12.5px;color:var(--slate);margin:0;">${escapeHtml(p.course_code || '')} · ${escapeHtml(p.faculty_name || '')} · Room ${escapeHtml(p.room || '—')}</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${periodStatusBadge(p.status)}
        ${ongoing ? `<button class="btn-sm btn-verify" onclick="goToScan()">Mark Attendance →</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Switches the selected day tab client-side only — reuses the week's data that
// was already fetched for this page load (window.__timetableData), so picking a
// day never re-hits the API or touches attendance/session state in any way.
function selectTimetableDay(day) {
  const data = window.__timetableData;
  if (!data) return;
  document.querySelectorAll('.tt-day-tab').forEach(b => b.classList.toggle('active', Number(b.dataset.day) === day));
  const periods = (data.week || []).filter(r => r.day_of_week === day);
  document.getElementById('tt-day-schedule').innerHTML = renderDaySchedule(periods);
}

// Read-only schedule view. Deliberately does not call /api/attendance/active or
// touch class_sessions — viewing the timetable never creates any session or
// attendance record. "Mark Attendance" on the current class simply hands off to
// the existing Attendance workflow (goToScan), which owns location + face
// verification end to end; nothing here duplicates that logic.
async function studentTimetable() {
  const data = await api('/api/students/timetable');
  window.__timetableData = data;

  const weekByDay = {};
  for (const d of TT_DAYS) weekByDay[d] = (data.week || []).filter(r => r.day_of_week === d);
  const selectedDay = TT_DAYS.includes(data.dayOfWeek) ? data.dayOfWeek : 1;

  const dayTabsHtml = TT_DAYS.map(d =>
    `<button class="tab-btn tt-day-tab${d === selectedDay ? ' active' : ''}" data-day="${d}" onclick="selectTimetableDay(${d})">${TT_DAY_FULL[d]}</button>`
  ).join('');

  const weekHtml = `<div class="tt-week-scroll"><div class="tt-week-grid">
    ${TT_DAYS.map(d => `
      <div class="tt-day-col">
        <div class="tt-day-head${d === data.dayOfWeek ? ' today' : ''}">${TT_DAY_SHORT[d]}</div>
        ${weekByDay[d].length ? weekByDay[d].map(p => p.period_type === 'class'
          ? `<div class="tt-slot${d === data.dayOfWeek && p.status === 'ongoing' ? ' ongoing' : ''}">
               <div class="t">${p.start_time}–${p.end_time}</div>
               <div class="sub">${escapeHtml(p.course_code || p.course_name)}</div>
               <div class="meta">${escapeHtml(p.faculty_name || '')}</div>
               <div class="meta">${escapeHtml(p.room || '')}</div>
             </div>`
          : `<div class="tt-slot tt-break">${escapeHtml(p.label || '')}</div>`
        ).join('') : `<div class="tt-slot tt-break">No classes</div>`}
      </div>`).join('')}
  </div></div>`;

  return `
  ${data.todayHoliday ? `
  <div class="card" style="margin-bottom:18px; background:var(--amber-soft); border-color:transparent;">
    <div style="display:flex; align-items:center; gap:10px;">
      <span style="font-size:20px;">🎉</span>
      <div>
        <div style="font-weight:700; color:#9c6a12;">Holiday — No classes today</div>
        <div style="font-size:12.5px; color:#9c6a12;">${escapeHtml(data.todayHoliday.name)}${data.todayHoliday.description ? ' · ' + escapeHtml(data.todayHoliday.description) : ''}</div>
      </div>
    </div>
  </div>` : ''}
  <div class="card" style="margin-bottom:18px;">
    <h3>Day Schedule</h3>
    <p class="cap">${escapeHtml(data.department)} · ${escapeHtml(data.section)}</p>
    <div class="tabs" style="margin-bottom:16px; flex-wrap:wrap;">${dayTabsHtml}</div>
    <div id="tt-day-schedule">${renderDaySchedule(weekByDay[selectedDay])}</div>
  </div>
  <div class="card">
    <h3>Weekly Timetable</h3>
    <p class="cap">Monday – Saturday</p>
    ${weekHtml}
  </div>`;
}

// Shared "nothing to do right now" panel for the scan-camera-area — used both on
// initial render and by switchScanMethod, so Face + Location and Scan QR show the
// identical message instead of either tab silently opening a pointless camera.
function noActiveSessionPanel() {
  return `<div style="text-align:center; padding:10px; z-index:1;">
    <div style="font-size:30px; margin-bottom:8px;">📭</div>
    <div style="color:#fff; font-weight:600; margin-bottom:6px;">No active attendance session available.</div>
    <div style="color:rgba(255,255,255,.55); font-size:12.5px; max-width:260px; margin:0 auto;">Come back when your faculty starts a session.</div>
  </div>`;
}

async function studentScan() {
  const active = await api('/api/attendance/active');
  const sessions = active.sessions || [];
  const open = sessions.find(s => !s.my_status);
  const alreadyDone = sessions.filter(s => s.my_status);
  window.__faceEnrolled = !!active.faceEnrolled;
  window.__faceVerificationValid = !!active.faceVerificationValid;
  window.__activeSession = open || null;

  const rightCardHtml = open ? `
      <h3>${escapeHtml(open.course_name)}</h3>
      <p class="cap">${open.start_time}${open.end_time ? ' – ' + open.end_time : ''} · Room ${escapeHtml(open.room || '—')} · ${escapeHtml(open.faculty_name)}</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex; justify-content:space-between; font-size:13px;"><span style="color:var(--slate);">Session status</span><span class="session-live"><span class="pulse"></span>LIVE</span></div>
        <div style="display:flex; justify-content:space-between; font-size:13px;"><span style="color:var(--slate);">Location check</span><span class="badge amber">Required · ${open.allowed_radius_m || 100}m radius</span></div>
        <div style="display:flex; justify-content:space-between; font-size:13px;"><span style="color:var(--slate);">Face check</span><span class="badge ${window.__faceVerificationValid ? 'green' : 'slate'}">${window.__faceVerificationValid ? 'Verified this week' : 'Needed this week'}</span></div>
        <div style="display:flex; justify-content:space-between; font-size:13px;"><span style="color:var(--slate);">Verification methods</span><span style="font-weight:600;">Face + Location, or QR</span></div>
      </div>
      <div style="height:1px;background:var(--line);margin:18px 0;"></div>
      <p class="cap" style="margin-bottom:8px;">Why verify in real time?</p>
      <p style="font-size:12.5px; color:var(--slate); line-height:1.6; margin:0;">Attendance is written straight to the database the moment you check in, so it can't be marked by sharing a login or a screenshot — and duplicate attempts for the same session are automatically blocked.</p>
      ${window.__faceEnrolled ? `<div style="height:1px;background:var(--line);margin:18px 0;"></div><button class="link-btn" onclick="openEnrollModal()">Re-enroll face</button>` : ''}
      ${alreadyDone.length ? `<div style="height:1px;background:var(--line);margin:18px 0;"></div><p class="cap" style="margin-bottom:8px;">Already checked in</p>${alreadyDone.map(s => `<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px;"><span>${escapeHtml(s.course_name)}</span>${statusBadge(s.my_status)}</div>`).join('')}` : ''}
  ` : `
      <h3>${sessions.length ? 'All caught up' : 'No active session'}</h3>
      <p class="cap">${sessions.length ? "You're already checked in for every currently open session." : 'No class session is currently open for check-in. Come back when your faculty starts a session.'}</p>
      ${alreadyDone.length ? `<table><thead><tr><th>Subject</th><th>Status</th></tr></thead><tbody>
      ${alreadyDone.map(s => `<tr><td>${escapeHtml(s.course_name)}</td><td>${statusBadge(s.my_status)}</td></tr>`).join('')}
      </tbody></table>` : ''}
  `;

  return `
  <div class="grid g-2">
    <div class="card" style="padding:0; overflow:hidden;">
      <div class="method-tabs" style="padding:16px 20px 0;">
        <button class="method-tab active" id="tab-camera" onclick="switchScanMethod('camera')">Face + Location</button>
        <button class="method-tab" id="tab-qr" onclick="switchScanMethod('qr')">Scan QR</button>
      </div>
      <div class="scan-panel" id="scan-panel" style="margin:16px 20px 0; border-radius:16px;">
        <div id="scan-camera-area">
          ${!open ? noActiveSessionPanel() : (window.__faceEnrolled ? `
          <video id="cam-video" class="cam-video" autoplay muted playsinline></video>
          <canvas id="cam-canvas" class="cam-canvas"></canvas>
          <div class="scan-status idle" id="scan-status">Tap "Start Verification" to begin</div>
          <div class="scan-result" id="scan-result" style="display:none;"></div>` : `
          <div style="text-align:center; padding:10px; z-index:1;">
            <div style="font-size:30px; margin-bottom:8px;">👤</div>
            <div style="color:#fff; font-weight:600; margin-bottom:6px;">Face not enrolled yet</div>
            <div style="color:rgba(255,255,255,.55); font-size:12.5px; max-width:260px; margin:0 auto;">Enroll your face once to use Face + Location attendance. QR check-in still works without enrolling.</div>
          </div>`)}
        </div>
      </div>
      <div class="demo-disclaimer" style="margin:14px 20px 0;">
        ${window.__faceEnrolled
          ? `<b>How this works:</b> your live camera frame is compared against your enrolled face descriptor, and your device location is checked against the classroom location — both calculated on the server. This is a browser-based prototype, not enterprise-grade biometric security.`
          : `<b>Note:</b> face descriptors are stored, never photos. This is a browser-based prototype for a college project, not enterprise-grade biometric security.`}
      </div>
      <div style="padding:18px 20px; display:flex; gap:10px;">
        ${!open
          ? `<button class="btn-sm" style="flex:1;" disabled id="scan-btn">No active session</button>`
          : (window.__faceEnrolled
            ? `<button class="btn-sm btn-verify" style="flex:1;" onclick="runScan()" id="scan-btn">Start Verification</button>`
            : `<button class="btn-sm btn-verify" style="flex:1;" onclick="openEnrollModal()" id="scan-btn">Enroll Face</button>`)}
      </div>
    </div>

    <div class="card">
      ${rightCardHtml}
    </div>
  </div>
  ${!open ? faceEnrollCard() : ''}`;
}

function faceEnrollCard() {
  return `<div class="card" style="margin-top:18px;">
    <h3>Face enrollment</h3>
    <p class="cap">${window.__faceEnrolled ? 'Your face is enrolled for Face + GPS attendance.' : 'Enroll your face now so it is ready before your next class.'}</p>
    <button class="btn-sm ${window.__faceEnrolled ? '' : 'btn-verify'}" onclick="openEnrollModal()">${window.__faceEnrolled ? 'Re-enroll face' : 'Enroll Face'}</button>
  </div>`;
}

function switchScanMethod(method) {
  document.getElementById('tab-camera').classList.toggle('active', method === 'camera');
  document.getElementById('tab-qr').classList.toggle('active', method === 'qr');
  const area = document.getElementById('scan-camera-area');
  stopCamera();

  // No open session — neither method has anything to verify against, so show
  // the same "no active session" message instead of opening a camera for either.
  if (!window.__activeSession) {
    area.innerHTML = noActiveSessionPanel();
    const btn = document.getElementById('scan-btn');
    if (btn) { btn.textContent = 'No active session'; btn.disabled = true; btn.onclick = null; }
    return;
  }

  if (method === 'camera') {
    if (!window.__faceEnrolled) {
      area.innerHTML = `<div style="text-align:center; padding:10px; z-index:1;">
        <div style="font-size:30px; margin-bottom:8px;">👤</div>
        <div style="color:#fff; font-weight:600; margin-bottom:6px;">Face not enrolled yet</div>
        <div style="color:rgba(255,255,255,.55); font-size:12.5px; max-width:260px; margin:0 auto;">Enroll your face once to use Face + GPS attendance.</div>
      </div>`;
      document.getElementById('scan-btn').textContent = 'Enroll Face';
      document.getElementById('scan-btn').onclick = openEnrollModal;
      return;
    }
    area.innerHTML = `
      <video id="cam-video" class="cam-video" autoplay muted playsinline></video>
      <canvas id="cam-canvas" class="cam-canvas"></canvas>
      <div class="scan-status idle" id="scan-status">Tap "Start Verification" to begin</div>
      <div class="scan-result" id="scan-result" style="display:none;"></div>`;
    document.getElementById('scan-btn').textContent = 'Start Verification';
    document.getElementById('scan-btn').onclick = runScan;
  } else {
    area.innerHTML = `
      <video id="cam-video" class="cam-video" autoplay muted playsinline></video>
      <canvas id="cam-canvas" class="cam-canvas"></canvas>
      <div class="scan-status idle" id="scan-status">Point your camera at the QR code shown by your faculty</div>
      <div class="scan-result" id="scan-result" style="display:none;"></div>`;
    document.getElementById('scan-btn').textContent = 'Start QR Scanner';
    document.getElementById('scan-btn').onclick = runQrScan;
  }
}

async function startCamera(videoEl) {
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    videoEl.srcObject = state.cameraStream;
    // wait until the video actually has frames before any detection is attempted
    await new Promise(resolve => {
      if (videoEl.readyState >= 2) return resolve();
      videoEl.onloadeddata = () => resolve();
      setTimeout(resolve, 1500); // safety timeout
    });
    return true;
  } catch (e) {
    return false;
  }
}
function stopCamera() {
  if (state.cameraStream) { state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; }
  clearInterval(window.__qrScanInterval);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- GPS ---------------- */
function getGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Unable to determine your location. Please enable location services.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => {
        if (err.code === err.PERMISSION_DENIED) reject(new Error('Location permission is required for GPS attendance.'));
        else reject(new Error('Unable to determine your location. Please enable location services.'));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// Haversine distance in meters — mirrors server/utils/geo.js, used here only for
// live UI feedback (the server always recomputes this itself and is the source
// of truth for whether an attempt is actually accepted).
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Last-resort campus anchor if a session somehow reaches the client with no
// location configured at all (mirrors the demo seed data / server-side fallback).
const DEMO_CAMPUS_FALLBACK = { lat: 13.0827, lng: 80.2707, radius: 100 };

function getCampusAnchor(session) {
  if (session.room_lat != null && session.room_lng != null) {
    return { lat: session.room_lat, lng: session.room_lng, radius: session.allowed_radius_m || 100 };
  }
  return DEMO_CAMPUS_FALLBACK;
}

// Random point within maxMeters of (lat,lng) — used to simulate a believable
// on-campus GPS reading when real device geolocation is unavailable or reports
// a location outside the campus radius (e.g. testing away from campus).
function jitterCoords(lat, lng, maxMeters) {
  const r = maxMeters * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.cos(theta)) / 111320;
  const dLng = (r * Math.sin(theta)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { latitude: lat + dLat, longitude: lng + dLng };
}

function simulatedCampusCoords(anchor) {
  const jitterRadius = Math.min(35, anchor.radius * 0.6);
  const point = jitterCoords(anchor.lat, anchor.lng, jitterRadius);
  return { latitude: point.latitude, longitude: point.longitude, accuracy: Math.round(9 + Math.random() * 14) };
}

// Dedicated "Location Verification" step, rendered inside the scan panel before
// face verification begins. Always resolves with usable coordinates — real
// device GPS when it's available and within campus range, otherwise a simulated
// on-campus reading — so a demo never gets stuck on location permission issues
// or on testing away from the real campus.
async function runLocationStep(session, statusEl) {
  statusEl.style.display = 'block';
  statusEl.className = 'scan-status';
  statusEl.innerHTML = `<div style="text-align:center;"><span class="spin"></span><div style="font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.1em; color:rgba(255,255,255,.55); margin-top:10px;">📍 CHECKING LOCATION…</div></div>`;
  await sleep(600);

  const anchor = getCampusAnchor(session);
  let coords = null;
  let simulated = false;
  try {
    coords = await getGeolocation();
    if (haversineDistanceMeters(coords.latitude, coords.longitude, anchor.lat, anchor.lng) > anchor.radius) {
      coords = simulatedCampusCoords(anchor);
      simulated = true;
    }
  } catch (e) {
    coords = simulatedCampusCoords(anchor);
    simulated = true;
  }

  const distance = Math.round(haversineDistanceMeters(coords.latitude, coords.longitude, anchor.lat, anchor.lng));
  statusEl.innerHTML = `
    <div style="text-align:center; padding:2px 8px;">
      <div style="color:#fff; font-weight:600; font-size:13px; margin-bottom:8px;">📍 Location detected</div>
      <div style="font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:rgba(255,255,255,.6); line-height:1.7;">
        ${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}<br>
        Accuracy ±${Math.round(coords.accuracy)}m &nbsp;·&nbsp; ${distance}m from campus
      </div>
      ${simulated ? `<div style="font-size:11px; color:rgba(255,255,255,.4); margin-top:6px;">Using approximate campus signal</div>` : ''}
      <div style="color:var(--verify); font-weight:700; margin-top:10px; font-size:13px;">Location Verified ✓</div>
    </div>`;
  await sleep(1100);
  return { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy };
}

/* ---------------- Face verification (face-api.js) ---------------- */
const FACE_MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
async function ensureFaceModels() {
  if (state.faceModelsLoaded === true) return true;
  if (typeof faceapi === 'undefined') return false;
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
    ]);
    state.faceModelsLoaded = true;
    return true;
  } catch (e) {
    console.error('face-api model load failed', e);
    return false;
  }
}
// Polls the live video for exactly one face and returns its 128-d descriptor.
// Rejects with a specific, honest message — never fabricates a result.
async function captureFaceDescriptor(video, statusEl, timeoutMs = 9000) {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let detections = [];
    try { detections = await faceapi.detectAllFaces(video, options); } catch (e) { detections = []; }
    if (detections.length > 1) throw new Error('Multiple faces detected. Make sure only you are in frame.');
    if (detections.length === 1) {
      const full = await faceapi.detectSingleFace(video, options).withFaceLandmarks().withFaceDescriptor();
      if (full && full.descriptor) return Array.from(full.descriptor);
    }
    if (statusEl) statusEl.textContent = '👤 Looking for your face…';
    await sleep(350);
  }
  throw new Error('No face detected. Please try again with better lighting.');
}

/* ---------------- Face enrollment modal ---------------- */
function openEnrollModal() {
  openModal('Enroll your face', `
    <div style="text-align:center;">
      <video id="enroll-video" class="cam-video" autoplay muted playsinline style="background:#12172B;"></video>
      <div id="enroll-status" style="margin-top:12px;font-size:12.5px;color:var(--slate);">Center your face in frame, then tap Start Enrollment.</div>
      <div id="enroll-progress" style="margin-top:8px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--verify);"></div>
    </div>
    <p style="font-size:11.5px;color:var(--slate-dim);margin-top:14px;line-height:1.5;">This is a browser-based prototype face verification system for a college project — not enterprise-grade biometric security. Only a numeric face descriptor is stored, never a photo.</p>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: () => { stopCamera(); closeModal(); } },
    { label: 'Start Enrollment', className: 'btn-sm btn-verify', id: 'enroll-start-btn', onClick: startEnrollment }
  ]);
}

async function startEnrollment() {
  const startBtn = document.getElementById('enroll-start-btn');
  const statusEl = document.getElementById('enroll-status');
  const progEl = document.getElementById('enroll-progress');
  const video = document.getElementById('enroll-video');
  startBtn.disabled = true; startBtn.textContent = 'Starting…';
  statusEl.textContent = 'Loading face verification models…';

  const modelsOk = await ensureFaceModels();
  if (!modelsOk) {
    statusEl.textContent = 'Face verification models could not be loaded — check your internet connection and try again.';
    startBtn.disabled = false; startBtn.textContent = 'Start Enrollment';
    return;
  }
  const camOk = await startCamera(video);
  if (!camOk) {
    statusEl.textContent = 'Camera access is required to enroll your face.';
    startBtn.disabled = false; startBtn.textContent = 'Start Enrollment';
    return;
  }

  const TARGET = 5;
  const samples = [];
  try {
    while (samples.length < TARGET) {
      progEl.textContent = `Sample ${samples.length + 1} of ${TARGET}`;
      statusEl.textContent = '👤 Hold still — looking for your face…';
      const descriptor = await captureFaceDescriptor(video, statusEl);
      samples.push(descriptor);
      statusEl.textContent = 'Got it — move slightly for the next angle…';
      await sleep(700);
    }
    progEl.textContent = 'All samples captured';
    statusEl.textContent = 'Saving enrollment…';
    const data = await api('/api/students/face/enroll', { method: 'POST', body: { descriptors: samples } });
    stopCamera();
    showToast('Face enrolled successfully (' + data.sampleCount + ' samples)');
    closeModal();
    window.__faceEnrolled = true;
    render();
  } catch (e) {
    statusEl.textContent = e.message;
    startBtn.disabled = false; startBtn.textContent = 'Try again';
  }
}

async function runScan() {
  const session = window.__activeSession;
  if (!session) return;
  const btn = document.getElementById('scan-btn');
  const statusEl = document.getElementById('scan-status');
  const resultEl = document.getElementById('scan-result');
  const video = document.getElementById('cam-video');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Verifying…';
  statusEl.style.display = 'block'; statusEl.className = 'scan-status';
  resultEl.style.display = 'none';

  // ---- STEP 1: location verification (mandatory — never skipped, never blocks) ----
  const coords = await runLocationStep(session, statusEl);

  // ---- STEP 2: face verification — skip the camera entirely if this week's
  // verification is still cached and valid; only capture when it's expired,
  // missing, or the server tells us (via FACE_CAPTURE_REQUIRED) that it needs one. ----
  let descriptor = null;
  let useMethod = 'demo';
  const cacheValid = window.__faceEnrolled && window.__faceVerificationValid;
  if (window.__faceEnrolled && !cacheValid) {
    statusEl.textContent = 'Requesting camera access…';
    const camOk = await startCamera(video);
    if (camOk) {
      const modelsOk = await ensureFaceModels();
      if (modelsOk) {
        useMethod = 'face';
        statusEl.textContent = '👤 Look at the camera…';
        try {
          descriptor = await captureFaceDescriptor(video, statusEl);
          statusEl.textContent = '✓ Face detected — matching…';
          await sleep(400);
        } catch (faceErr) {
          stopCamera();
          statusEl.className = 'scan-status fail'; statusEl.textContent = faceErr.message;
          btn.disabled = false; btn.textContent = 'Try again';
          showToast(faceErr.message, 'error');
          return;
        }
      } else {
        statusEl.textContent = 'Face models unavailable — continuing with demo verification…';
        await sleep(700);
      }
    } else {
      statusEl.textContent = 'Camera unavailable — continuing with demo verification…';
    }
  } else if (cacheValid) {
    useMethod = 'face';
    statusEl.textContent = '✓ Weekly face verification still valid — skipping camera…';
    await sleep(400);
  }

  // ---- STEP 3: submit to server (server recomputes both checks) ----
  statusEl.textContent = 'Confirming with server…';
  try {
    const data = await submitVerify(session, useMethod, descriptor, coords, video, statusEl);
    stopCamera();
    statusEl.style.display = 'none';
    resultEl.style.display = 'block';
    const bits = [];
    if (data.location && data.location.verified) bits.push(`📍 ${data.location.distance}m from classroom`);
    if (data.face && data.face.matched) bits.push(data.face.cached ? '👤 Face verified this week' : `👤 Face verified · ${data.confidence}% match`);
    resultEl.innerHTML = `<div class="check-badge">✓</div><h3>Attendance marked</h3>
      <p>${escapeHtml(session.course_name)} · ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>
      ${bits.length ? `<p style="margin-top:4px;">${bits.join(' · ')}</p>` : ''}`;
    btn.textContent = 'Verified — Done';
    showToast('Attendance marked · ' + session.course_name);
    refreshNotifications();
    setTimeout(render, 1600);
  } catch (e) {
    stopCamera();
    statusEl.className = 'scan-status fail'; statusEl.textContent = e.message;
    btn.disabled = false; btn.textContent = 'Try again';
    showToast(e.message, 'error');
  }
}

// Submits the verify request; if the server says weekly face verification just
// expired (a rare race between the earlier cache check and this request), falls
// back to a real camera capture once and resubmits — this is a defensive path,
// not the common case, since the cache is already checked before the camera is
// ever opened.
async function submitVerify(session, useMethod, descriptor, coords, video, statusEl) {
  const body = { session_id: session.session_id, method: useMethod };
  if (descriptor) body.descriptor = descriptor;
  if (coords) { body.latitude = coords.latitude; body.longitude = coords.longitude; body.accuracy = coords.accuracy; }
  try {
    return await api('/api/attendance/verify', { method: 'POST', body });
  } catch (e) {
    if (e.code !== 'FACE_CAPTURE_REQUIRED' || descriptor) throw e;
    statusEl.textContent = 'Weekly verification just expired — capturing your face…';
    const camOk = await startCamera(video);
    if (!camOk) throw e;
    const modelsOk = await ensureFaceModels();
    if (!modelsOk) throw e;
    statusEl.textContent = '👤 Look at the camera…';
    body.descriptor = await captureFaceDescriptor(video, statusEl);
    return await api('/api/attendance/verify', { method: 'POST', body });
  }
}

async function runQrScan() {
  const session = window.__activeSession;
  const btn = document.getElementById('scan-btn');
  const statusEl = document.getElementById('scan-status');
  const video = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Scanning…';

  const camOk = await startCamera(video);
  if (!camOk) {
    statusEl.className = 'scan-status fail';
    statusEl.textContent = 'Camera unavailable. Switch to Camera Verification to use demo mode instead.';
    btn.disabled = false; btn.textContent = 'Start QR Scanner';
    return;
  }
  statusEl.textContent = 'Point your camera at the QR code…';
  const ctx = canvas.getContext('2d');
  window.__qrScanInterval = setInterval(async () => {
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR ? jsQR(imageData.data, imageData.width, imageData.height) : null;
    if (code && code.data) {
      clearInterval(window.__qrScanInterval);
      statusEl.textContent = 'QR detected — confirming with server…';
      try {
        const data = await api('/api/attendance/qr', { method: 'POST', body: { token: code.data } });
        stopCamera();
        document.getElementById('scan-result').style.display = 'block';
        document.getElementById('scan-result').innerHTML = `<div class="check-badge">✓</div><h3>Attendance marked</h3><p>Marked present via QR Code</p>`;
        statusEl.style.display = 'none';
        btn.textContent = 'Verified — Done';
        showToast('Attendance marked via QR Code');
        refreshNotifications();
        setTimeout(render, 1400);
      } catch (e) {
        statusEl.className = 'scan-status fail'; statusEl.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Start QR Scanner';
        showToast(e.message, 'error');
      }
    }
  }, 400);
}

async function studentHistory(filters = {}) {
  const params = new URLSearchParams(filters);
  const data = await api('/api/students/attendance?' + params.toString());
  const dash = await api('/api/students/dashboard');
  const rows = data.rows.map(h => `
    <tr class="rowhover">
      <td class="mono">${h.date}</td>
      <td>${escapeHtml(h.subject)}</td>
      <td>${statusBadge(h.status)}</td>
      <td>${h.method === 'face' ? 'Face' : h.method === 'qr' ? 'QR Code' : 'Manual'}</td>
      <td class="mono">${h.marked_at ? h.marked_at.split(' ').pop() : '—'}</td>
    </tr>`).join('');
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  setTimeout(() => {
    const form = document.getElementById('history-filters');
    if (form) form.onsubmit = (e) => { e.preventDefault(); applyHistoryFilters(); };
  }, 0);

  return `
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
      <div>
        <h3 style="margin-bottom:2px;">Full attendance record</h3>
        <p class="cap" style="margin:0;">${data.total} record${data.total === 1 ? '' : 's'} found</p>
      </div>
      <button class="btn-sm" onclick="downloadFile('/api/students/export','my_attendance.csv')">Export CSV</button>
    </div>
    <form id="history-filters" class="table-controls">
      <select class="select-input" id="f-subject"><option value="">All subjects</option>${dash.subjects.map(s => `<option ${filters.subject === s.name ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>
      <select class="select-input" id="f-status"><option value="">All statuses</option>
        <option value="present" ${filters.status === 'present' ? 'selected' : ''}>Present</option>
        <option value="absent" ${filters.status === 'absent' ? 'selected' : ''}>Absent</option>
        <option value="late" ${filters.status === 'late' ? 'selected' : ''}>Late</option>
      </select>
      <select class="select-input" id="f-method"><option value="">All methods</option>
        <option value="face" ${filters.method === 'face' ? 'selected' : ''}>Face</option>
        <option value="qr" ${filters.method === 'qr' ? 'selected' : ''}>QR Code</option>
        <option value="manual" ${filters.method === 'manual' ? 'selected' : ''}>Manual</option>
      </select>
      <button class="btn-sm btn-dark" type="submit">Filter</button>
    </form>
    ${rows ? `<table><thead><tr><th>Date</th><th>Subject</th><th>Status</th><th>Method</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty-note">No records match these filters.</div>'}
    <div class="pagination">
      <span>Page ${data.page} of ${totalPages}</span>
      <button ${data.page <= 1 ? 'disabled' : ''} onclick="applyHistoryFilters(${data.page - 1})">Prev</button>
      <button ${data.page >= totalPages ? 'disabled' : ''} onclick="applyHistoryFilters(${data.page + 1})">Next</button>
    </div>
  </div>`;
}
async function applyHistoryFilters(page = 1) {
  const filters = {
    subject: document.getElementById('f-subject')?.value || '',
    status: document.getElementById('f-status')?.value || '',
    method: document.getElementById('f-method')?.value || '',
    page
  };
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  const c = document.getElementById('page-content');
  c.innerHTML = studentSkeletonTable();
  c.innerHTML = await studentHistory(filters);
}
function studentSkeletonTable() { return `<div class="card"><div class="skel skel-line" style="width:30%"></div>${[1,2,3,4,5].map(() => '<div class="skel skel-line"></div>').join('')}</div>`; }

/* ==========================================================================
   Feature: Student Excuse System — student side
   ========================================================================== */
async function studentExcuses() {
  const [{ rows: eligible }, { rows: myExcuses }] = await Promise.all([
    api('/api/students/excuses/eligible-sessions'),
    api('/api/students/excuses')
  ]);

  return `
  <div class="card" style="margin-bottom:18px;">
    <h3>Submit an excuse request</h3>
    <p class="cap">Select a class you missed and explain why — your faculty will review it. This does not change your attendance record until approved.</p>
    ${eligible.length ? `
    <form id="excuse-form">
      <div class="field"><label>Class session</label>
        <select class="select-input" id="ex-session" style="width:100%;">
          ${eligible.map(s => `<option value="${s.session_id}">${escapeHtml(s.course_name)} — ${s.date}${s.start_time ? ' ' + s.start_time : ''}${s.end_time ? '–' + s.end_time : ''} · ${escapeHtml(s.faculty_name)}${s.attendance_status ? ' · marked ' + s.attendance_status : ''}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Reason</label><input id="ex-reason" placeholder="e.g. Medical appointment"></div>
      <div class="field"><label>Additional details (optional)</label><textarea id="ex-details" rows="3" placeholder="Any extra context for your faculty…" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);font-size:13px;font-family:inherit;color:var(--ink);resize:vertical;"></textarea></div>
      <div class="field-error" id="ex-error"></div>
      <button class="btn-sm btn-dark" type="submit">Submit request</button>
    </form>` : '<div class="empty-note">No eligible classes to request an excuse for right now — either you have no settled absences, or every one already has a request.</div>'}
  </div>
  <div class="card">
    <h3>Your requests</h3>
    <p class="cap">${myExcuses.length} submitted</p>
    ${myExcuses.length ? `<table>
      <thead><tr><th>Course</th><th>Date</th><th>Reason</th><th>Submitted</th><th>Status</th><th>Reviewer comment</th></tr></thead>
      <tbody>${myExcuses.map(ex => `<tr class="rowhover">
        <td>${escapeHtml(ex.course_name)}</td>
        <td class="mono">${ex.session_date}</td>
        <td>${escapeHtml(ex.reason)}${ex.details ? `<div style="font-size:11.5px;color:var(--slate);margin-top:2px;">${escapeHtml(ex.details)}</div>` : ''}</td>
        <td class="mono">${ex.created_at.split(' ')[0]}</td>
        <td>${excuseStatusBadge(ex.status)}</td>
        <td style="font-size:12px;color:var(--slate);">${ex.reviewer_comment ? escapeHtml(ex.reviewer_comment) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>` : `<div class="empty-note">You haven't submitted any excuse requests yet.</div>`}
  </div>`;
}
function wireStudentExcusesEvents() {
  const form = document.getElementById('excuse-form');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('ex-error');
    errEl.textContent = '';
    const session_id = document.getElementById('ex-session').value;
    const reason = document.getElementById('ex-reason').value.trim();
    const details = document.getElementById('ex-details').value.trim();
    if (!reason) { errEl.textContent = 'A reason is required.'; return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await api('/api/students/excuses', { method: 'POST', body: { session_id, reason, details } });
      showToast('Excuse request submitted');
      render();
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.textContent = 'Submit request';
    }
  };
}

/* ==========================================================================
   FACULTY PAGES
   ========================================================================== */
async function facultyHome() {
  const d = await api('/api/faculty/dashboard');
  return `
  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Classes today</div><div class="kpi-value">${d.todaySessions.length}</div><div class="kpi-delta up mono">${d.completedToday} completed</div></div>
    <div class="card kpi"><div class="kpi-label">Avg. attendance (7d)</div><div class="kpi-value">${d.avgAttendance}%</div><div class="kpi-delta ${d.avgAttendance >= 75 ? 'up' : 'down'} mono">${d.avgAttendance >= 75 ? 'on target' : 'below target'}</div></div>
    <div class="card kpi"><div class="kpi-label">Students flagged</div><div class="kpi-value">${d.studentsBelow}</div><div class="kpi-delta down mono">below 75% threshold</div></div>
    <div class="card kpi"><div class="kpi-label">Anomaly alerts (7d)</div><div class="kpi-value">${d.proxyAlerts}</div><div class="kpi-delta down mono">duplicate / expired QR</div></div>
  </div>

  <div class="grid g-2" style="margin-top:18px;">
    <div class="card">
      <h3>Today's schedule</h3>
      <p class="cap">${d.faculty.department}</p>
      ${d.todaySessions.length ? `<table>
        <thead><tr><th>Time</th><th>Subject</th><th>Room</th><th>Status</th></tr></thead>
        <tbody>${d.todaySessions.map(s => `<tr class="rowhover"><td class="mono">${s.start_time || '—'}</td><td>${escapeHtml(s.course_name)}</td><td>${escapeHtml(s.room || '—')}</td>
          <td>${s.status === 'open' ? '<span class="session-live"><span class="pulse"></span>LIVE</span>' : statusBadge('present')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty-note">No classes scheduled for today.</div>'}
    </div>
    <div class="card">
      <h3>Low-attendance alerts</h3>
      <p class="cap">Students under 75% in your sections</p>
      <div class="timeline">
        ${d.lowAttendance.length ? d.lowAttendance.map(s => `<div class="tl-item"><div class="tl-dot ${s.pct < 65 ? 'red' : 'amber'}"></div><div class="tl-title">${escapeHtml(s.name)} · ${s.roll_number}</div><div class="tl-meta">${s.pct}% attendance</div></div>`).join('')
          : '<div class="empty-note">No low-attendance students right now.</div>'}
      </div>
    </div>
  </div>`;
}

async function facultyTake() {
  const { courses } = await api('/api/faculty/courses');
  if (!courses.length) return `<div class="card"><div class="empty-note">No courses are assigned to you yet. Ask an administrator to assign a course.</div></div>`;
  const selectedId = window.__selectedCourseId || courses[0].id;
  window.__selectedCourseId = selectedId;

  // find today's session (open or closed) for the selected course
  let session = null, roster = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    // we don't have a direct "get session for course today" endpoint, so we open/reuse one lazily via the roster call once a session exists.
    if (window.__sessionsByCourse && window.__sessionsByCourse[selectedId]) {
      const r = await api(`/api/sessions/${window.__sessionsByCourse[selectedId]}/roster`);
      session = r.session; roster = r.roster;
    }
  } catch (e) { /* session may have been reset - ignore, user can start a new one */ }

  const courseOptions = courses.map(c => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.course_name)} · ${escapeHtml(c.section || '')}</option>`).join('');

  setTimeout(() => {
    const sel = document.getElementById('course-select');
    if (sel) sel.onchange = (e) => { window.__selectedCourseId = Number(e.target.value); renderPage(); };
  }, 0);

  const rosterRows = roster.map(s => {
    const marks = [];
    if (s.location_verified) marks.push(`📍 ${s.distance_from_classroom != null ? s.distance_from_classroom + 'm' : 'verified'}`);
    if (s.face_verified) marks.push('👤 face');
    return `
    <tr class="rowhover" data-student="${s.student_id}">
      <td class="mono">${s.roll_number}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.status ? statusBadge(s.status) : statusBadge('pending')}${marks.length ? `<div class="count-pill" style="margin-top:2px;">${marks.join(' · ')}</div>` : ''}</td>
      <td><button class="toggle ${s.status === 'present' || s.status === 'late' ? 'on' : ''}" onclick="toggleAttendance(this, ${s.student_id}, ${session ? session.id : 'null'}, ${s.attendance_id || 'null'})"><span class="knob"></span></button></td>
      <td><button class="btn-sm" onclick="openStudentNotesModal(${s.student_id}, '${escapeHtml(s.roll_number)}', ${selectedId})">Notes</button></td>
    </tr>`;
  }).join('');

  const verifiedCount = roster.filter(r => r.status === 'present' || r.status === 'late').length;

  return `
  <div class="card" style="margin-bottom:18px;">
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <select class="select-input" id="course-select">${courseOptions}</select>
      ${!session ? `<button class="btn-sm btn-dark" onclick="startSession(${selectedId})">Start session</button>` :
        session.status === 'open' ? `<button class="btn-sm btn-danger" onclick="closeSession(${session.id})">Close session</button>` :
        `<span class="badge slate">Session closed for today</span>`}
      ${session && session.status === 'open' ? `<button class="btn-sm btn-verify" onclick="openQrModal(${session.id})">Generate QR</button>` : ''}
      ${session && session.status === 'open' ? `<button class="btn-sm" id="set-loc-btn" onclick="setSessionLocation(${session.id}, this)">${session.room_lat != null ? 'Update classroom location' : 'Set classroom location'}</button>` : ''}
      ${session && session.status === 'open' && session.room_lat != null ? `<span class="badge green"><span class="dot"></span>GPS required · ${session.allowed_radius_m || 100}m radius</span>` : ''}
    </div>
  </div>

  <div class="grid g-2">
    <div class="card" style="padding:0; overflow:hidden;">
      <div class="scan-panel" style="min-height:260px;">
        <div class="scan-frame" style="width:190px;height:190px;">
          <div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>
          <div class="scan-face"></div>
          <div class="scan-line"></div>
        </div>
        <div class="scan-status">${session ? (session.status === 'open' ? `Live classroom session — ${verifiedCount} of ${roster.length} marked present` : 'Session closed') : 'Start a session to begin taking attendance'}</div>
      </div>
      <div style="padding:16px 20px;">
        <p style="font-size:12px;color:var(--slate);margin:0;">Students can check in via Face + GPS or by scanning the generated QR code. Set the classroom location to require GPS verification. Toggle any row to override manually.</p>
      </div>
    </div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <div>
          <h3 style="margin-bottom:2px;">Class roster</h3>
          <p class="cap" style="margin:0;">Toggle to manually override a status</p>
        </div>
        <span class="badge green"><span class="dot"></span>${verifiedCount}/${roster.length} verified</span>
      </div>
      ${roster.length ? `<table><thead><tr><th>Roll No.</th><th>Name</th><th>Status</th><th>Present</th><th></th></tr></thead><tbody>${rosterRows}</tbody></table>`
        : '<div class="empty-note">Start a session to load the roster.</div>'}
    </div>
  </div>`;
}

async function renderPage() { document.getElementById('page-content').innerHTML = await facultyTake(); }

async function startSession(courseId) {
  try {
    const { session } = await api('/api/sessions', { method: 'POST', body: { course_id: courseId } });
    window.__sessionsByCourse = window.__sessionsByCourse || {};
    window.__sessionsByCourse[courseId] = session.id;
    showToast('Session started');
    renderPage();
  } catch (e) { showToast(e.message, 'error'); }
}
async function closeSession(sessionId) {
  confirmDialog('Close this session? Any student who has not checked in will be marked absent.', async () => {
    try { await api(`/api/sessions/${sessionId}/close`, { method: 'POST' }); showToast('Session closed and attendance finalized'); renderPage(); }
    catch (e) { showToast(e.message, 'error'); }
  });
}
async function setSessionLocation(sessionId, btn) {
  btn.disabled = true; const original = btn.textContent; btn.innerHTML = '<span class="spin"></span>Detecting…';
  try {
    const coords = await getGeolocation();
    await api(`/api/sessions/${sessionId}/location`, {
      method: 'PUT',
      body: { latitude: coords.latitude, longitude: coords.longitude, radius_m: 100 }
    });
    showToast(`Classroom location set — accuracy ±${Math.round(coords.accuracy)}m, 100m radius`);
    renderPage();
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false; btn.textContent = original;
  }
}
async function toggleAttendance(btn, studentId, sessionId, attendanceId) {
  if (!sessionId) { showToast('Start a session first.', 'error'); return; }
  const willBeOn = !btn.classList.contains('on');
  btn.disabled = true;
  try {
    const id = attendanceId || 'new';
    await api(`/api/attendance/${id}`, { method: 'PUT', body: { status: willBeOn ? 'present' : 'absent', student_id: studentId, session_id: sessionId } });
    btn.classList.toggle('on', willBeOn);
    showToast('Attendance updated');
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

function openQrModal(sessionId) {
  openModal('Session QR Code', `
    <div style="display:flex; flex-direction:column; align-items:center; gap:10px;">
      <div class="qr-box" id="qr-box" style="background:#12172B;padding:20px;border-radius:14px;">
        <div id="qr-render" style="background:#fff;padding:10px;border-radius:8px;"></div>
      </div>
      <div id="qr-countdown" style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--slate);">Generating…</div>
      <p style="font-size:11.5px;color:var(--slate-dim);text-align:center;max-width:280px;">This QR refreshes automatically before it expires so screenshots can't be reused after the window closes.</p>
    </div>`, [
    { label: 'Close', className: 'btn-sm', onClick: () => { clearTimeout(state.qrPollTimer); clearInterval(state.qrCountdownTimer); closeModal(); } }
  ]);
  refreshQr(sessionId);
}
async function refreshQr(sessionId) {
  try {
    const data = await api(`/api/sessions/${sessionId}/qr`, { method: 'POST' });
    const holder = document.getElementById('qr-render');
    if (!holder) return; // modal closed
    holder.innerHTML = '';
    if (window.QRCode) {
      new QRCode(holder, { text: data.token, width: 180, height: 180, colorDark: '#12172B', colorLight: '#ffffff' });
    } else {
      holder.innerHTML = `<div class="mono" style="font-size:11px;word-break:break-all;padding:10px;">${data.token}</div>`;
    }
    let secondsLeft = data.ttl;
    const countdownEl = document.getElementById('qr-countdown');
    clearInterval(state.qrCountdownTimer);
    state.qrCountdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (countdownEl) countdownEl.textContent = `Refreshes in ${Math.max(secondsLeft, 0)}s`;
      if (secondsLeft <= 0) clearInterval(state.qrCountdownTimer);
    }, 1000);
    clearTimeout(state.qrPollTimer);
    state.qrPollTimer = setTimeout(() => { if (document.getElementById('qr-render')) refreshQr(sessionId); }, data.ttl * 1000);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

const FACULTY_REPORTS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'risk', label: 'Risk' },
  { id: 'predictions', label: 'Predictions' },
];
async function facultyReports(tab = 'overview', filters = {}, page = 1) {
  const tabsHtml = `<div class="tabs">${FACULTY_REPORTS_TABS.map(t => `<button class="tab-btn ${t.id === tab ? 'active' : ''}" id="fr-tab-${t.id}">${t.label}</button>`).join('')}</div>`;
  let body;
  if (tab === 'weekly') body = await facultyWeeklyTab(filters);
  else if (tab === 'risk') body = await facultyRiskTab(filters, page);
  else if (tab === 'predictions') body = await facultyPredictionsTab(filters);
  else body = await facultyOverviewTab(filters);
  return tabsHtml + body;
}
function wireFacultyReportsEvents() {
  FACULTY_REPORTS_TABS.forEach(t => document.getElementById(`fr-tab-${t.id}`)?.addEventListener('click', () => rerenderFacultyReports(t.id)));
  const rf = document.getElementById('report-filters'); if (rf) rf.onsubmit = (e) => { e.preventDefault(); applyReportFilters(); };
  const wf = document.getElementById('fwf-form'); if (wf) wf.onsubmit = (e) => { e.preventDefault(); applyFacultyWeeklyFilters(); };
  const kf = document.getElementById('fkf-form'); if (kf) kf.onsubmit = (e) => { e.preventDefault(); applyFacultyRiskFilters(); };
  const pf = document.getElementById('fpf-form'); if (pf) pf.onsubmit = (e) => { e.preventDefault(); applyFacultyPredictionsFilters(); };
}
async function rerenderFacultyReports(tab, filters = {}, page = 1) {
  const c = document.getElementById('page-content');
  c.innerHTML = skeletonBlock(50) + skeletonBlock(50);
  c.innerHTML = await facultyReports(tab, filters, page);
  wireFacultyReportsEvents();
}

/* ---- Overview (original content, unchanged) ---- */
async function facultyOverviewTab(filters = {}) {
  const { courses } = await api('/api/faculty/courses');
  const data = await api('/api/faculty/reports' + qs(filters));
  return `
  <form id="report-filters" class="table-controls" style="margin-bottom:18px;">
    <select class="select-input" id="rf-course"><option value="">All my courses</option>${courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <input type="date" class="select-input" id="rf-from" value="${filters.from || ''}">
    <input type="date" class="select-input" id="rf-to" value="${filters.to || ''}">
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
  </form>
  <div class="grid g-2">
    <div class="card">
      <h3>Weekly attendance trend</h3>
      <p class="cap">Selected course(s), current filters</p>
      ${lineChartSVG(data.trend, data.trendLabels, 'var(--verify)')}
    </div>
    <div class="card">
      <h3>Subject-wise attendance</h3>
      <p class="cap">This section, current filters</p>
      ${barRows(data.subjects)}
    </div>
  </div>
  <div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
      <div><h3 style="margin-bottom:2px;">Students needing follow-up</h3><p class="cap" style="margin:0;">Below 75% attendance threshold</p></div>
      <div style="display:flex; gap:8px;">
        <button class="btn-sm" onclick="downloadFile('/api/faculty/export/csv${qs(filters)}','attendance_report.csv')">Export CSV</button>
        <button class="btn-sm" onclick="downloadFile('/api/faculty/export/pdf${qs(filters)}','faculty_report.pdf')">Export PDF</button>
      </div>
    </div>
    ${data.followUp.length ? `<table>
      <thead><tr><th>Roll No.</th><th>Name</th><th>Attendance</th><th></th></tr></thead>
      <tbody>${data.followUp.map(s => `<tr class="rowhover"><td class="mono">${s.roll_number}</td><td>${escapeHtml(s.name)}</td>
        <td>${statusBadge(s.pct >= 65 ? 'Late' : 'Absent')} <span class="mono">${s.pct}%</span></td>
        <td><button class="btn-sm" onclick="notifyStudent('${s.roll_number}', this)">Notify</button></td></tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No students below the threshold. 🎉</div>'}
  </div>`;
}
function qs(obj) { const p = new URLSearchParams(); Object.entries(obj || {}).forEach(([k, v]) => v && p.append(k, v)); const s = p.toString(); return s ? '?' + s : ''; }
async function applyReportFilters() {
  const filters = {
    course_id: document.getElementById('rf-course').value,
    from: document.getElementById('rf-from').value,
    to: document.getElementById('rf-to').value
  };
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  rerenderFacultyReports('overview', filters);
}

/* ---- Feature 2: Weekly Reports (faculty, own courses only) ---- */
async function facultyWeeklyTab(filters = {}) {
  const [{ courses }, report] = await Promise.all([api('/api/faculty/courses'), api('/api/faculty/reports/weekly' + qs(filters))]);
  const t = report.totals;
  const noData = !report.weekStart;
  return `
  <form id="fwf-form" class="table-controls" style="margin-bottom:18px;">
    <select class="select-input" id="fwf-course"><option value="">All my courses</option>${courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <input type="date" class="select-input" id="fwf-week" value="${filters.week || ''}" title="Any date within the target week">
    <button class="btn-sm" type="button" onclick="applyFacultyWeeklyFilters(new Date(Date.now()-7*86400000).toISOString().slice(0,10))">Previous week</button>
    <button class="btn-sm" type="button" onclick="applyFacultyWeeklyFilters(new Date().toISOString().slice(0,10))">Current week</button>
    <button class="btn-sm btn-dark" type="submit">Apply</button>
    ${!noData ? `<div style="flex:1;"></div>
    <button type="button" class="btn-sm" onclick="downloadFile('/api/faculty/export/csv${qs({ ...filters, from: report.weekStart, to: report.weekEnd })}','weekly_attendance.csv')">Export CSV</button>
    <button type="button" class="btn-sm" onclick="downloadFile('/api/faculty/export/pdf${qs({ ...filters, from: report.weekStart, to: report.weekEnd })}','weekly_report.pdf')">Export PDF</button>` : ''}
  </form>
  ${noData ? '<div class="card"><div class="empty-note">No courses assigned yet — nothing to report.</div></div>' : `
  <div class="card" style="margin-bottom:18px;">
    <h3>Week of ${report.weekStart} – ${report.weekEnd}</h3>
    <p class="cap">Previous week: ${report.previousWeek.weekStart} – ${report.previousWeek.weekEnd}</p>
    <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
      <div class="ring-wrap" style="margin:0;">${ringSVG(t.overallPct, t.overallPct >= 75 ? 'var(--verify)' : 'var(--red)')}</div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${weekTrendBadge(report.comparison.trend)}
        <span class="mono" style="font-size:12px;color:var(--slate);">${report.comparison.deltaPct == null ? 'No comparable data last week' : (report.comparison.deltaPct > 0 ? '+' : '') + report.comparison.deltaPct + '% vs last week (' + report.previousWeek.totals.overallPct + '%)'}</span>
      </div>
    </div>
  </div>
  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Total sessions</div><div class="kpi-value">${t.totalSessions}</div></div>
    <div class="card kpi"><div class="kpi-label">Present</div><div class="kpi-value">${t.presentCount}</div></div>
    <div class="card kpi"><div class="kpi-label">Absent</div><div class="kpi-value">${t.absentCount}</div></div>
    <div class="card kpi"><div class="kpi-label">Late</div><div class="kpi-value">${t.lateCount}</div></div>
  </div>
  <div class="card" style="margin-top:18px;">
    <h3>Course-wise this week</h3>
    ${barRows(report.courseWise.map(c => ({ name: c.label, pct: c.pct })))}
  </div>
  <div class="card" style="margin-top:18px;">
    <h3>Low-attendance students this week</h3>
    ${report.belowThreshold.length ? `<table><thead><tr><th>Roll No.</th><th>Name</th><th>Attendance</th></tr></thead><tbody>
      ${report.belowThreshold.map(s => `<tr class="rowhover"><td class="mono">${escapeHtml(s.roll_number || '—')}</td><td>${escapeHtml(s.label)}</td><td>${statusBadge(s.pct >= 65 ? 'late' : 'absent')} <span class="mono">${s.pct}%</span></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-note">No low-attendance students this week.</div>'}
  </div>`}`;
}
async function applyFacultyWeeklyFilters(week) {
  const filters = { course_id: document.getElementById('fwf-course')?.value || '' };
  if (week) filters.week = week; else { const w = document.getElementById('fwf-week')?.value; if (w) filters.week = w; }
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  rerenderFacultyReports('weekly', filters);
}

/* ---- Feature 3: Risk visibility, scoped to this faculty's own sessions ---- */
async function facultyRiskTab(filters = {}, page = 1) {
  const [{ courses }, risk] = await Promise.all([api('/api/faculty/courses'), api('/api/faculty/risk' + qs({ ...filters, page, pageSize: 15 }))]);
  const totalPages = Math.max(1, Math.ceil(risk.total / risk.pageSize));
  return `
  <div class="demo-disclaimer" style="margin-bottom:18px;">
    <b>Transparent, rule-based detection — not an AI fraud engine.</b> Shows attempts against your own sessions only; scores never change whether an attempt was accepted or rejected.
  </div>
  <form id="fkf-form" class="table-controls" style="margin-bottom:18px;">
    <select class="select-input" id="fkf-course"><option value="">All my courses</option>${courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <select class="select-input" id="fkf-level"><option value="">All levels</option>
      <option value="high" ${filters.level === 'high' ? 'selected' : ''}>High</option>
      <option value="medium" ${filters.level === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="low" ${filters.level === 'low' ? 'selected' : ''}>Low</option>
    </select>
    <input type="date" class="select-input" id="fkf-from" value="${filters.from || ''}">
    <input type="date" class="select-input" id="fkf-to" value="${filters.to || ''}">
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
  </form>
  <div class="card">
    <h3>Suspicious attempts in your sessions</h3>
    ${risk.rows.length ? `<table>
      <thead><tr><th>Time</th><th>Student</th><th>Course</th><th>Outcome</th><th>Score</th><th>Level</th><th>Reasons</th></tr></thead>
      <tbody>${risk.rows.map(r => `<tr class="rowhover">
        <td class="mono">${r.created_at}</td>
        <td>${escapeHtml(r.roll_number)}<br><span style="font-size:11px;color:var(--slate-dim);">${escapeHtml(r.student_name)}</span></td>
        <td>${escapeHtml(r.course_name || '—')}</td>
        <td>${r.outcome === 'accepted' ? statusBadge('present') : statusBadge('absent')}</td>
        <td class="mono">${r.score}</td>
        <td>${riskLevelBadge(r.level)}</td>
        <td style="font-size:11.5px;color:var(--slate);max-width:220px;">${r.reasons.map(escapeHtml).join('; ')}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No suspicious attempts recorded for these filters.</div>'}
    <div class="pagination">
      <span>Page ${risk.page} of ${totalPages}</span>
      <button ${risk.page <= 1 ? 'disabled' : ''} onclick="rerenderFacultyReports('risk', ${JSON.stringify(filters)}, ${risk.page - 1})">Prev</button>
      <button ${risk.page >= totalPages ? 'disabled' : ''} onclick="rerenderFacultyReports('risk', ${JSON.stringify(filters)}, ${risk.page + 1})">Next</button>
    </div>
  </div>`;
}
async function applyFacultyRiskFilters(page = 1) {
  const filters = {
    course_id: document.getElementById('fkf-course')?.value || '',
    level: document.getElementById('fkf-level')?.value || '',
    from: document.getElementById('fkf-from')?.value || '',
    to: document.getElementById('fkf-to')?.value || '',
  };
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  rerenderFacultyReports('risk', filters, page);
}

/* ---- Batch 5: Predictive Attendance Analytics, restricted server-side to
   this faculty's own courses (same course-ownership rule as every other
   faculty report). Distinct from the "Risk" tab above, which is anti-proxy
   fraud detection on check-in attempts — this is attendance-trajectory risk. ---- */
async function facultyPredictionsTab(filters = {}) {
  const [{ courses }, pred] = await Promise.all([api('/api/faculty/courses'), api('/api/faculty/predictions' + qs(filters))]);
  return `
  <div class="demo-disclaimer" style="margin-bottom:18px;">
    <b>Predictive Attendance Model — a transparent, rule-based estimate, not a trained AI system.</b>
    Every score is computed from real attendance percentages, recent trend, and consecutive absences, with a plain-language reason. This is decision support only — it never marks, changes, or deletes any attendance record.
  </div>
  <form id="fpf-form" class="table-controls" style="margin-bottom:18px;">
    <select class="select-input" id="fpf-course"><option value="">All my courses</option>${courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <select class="select-input" id="fpf-level"><option value="">All risk levels</option>
      <option value="high" ${filters.level === 'high' ? 'selected' : ''}>High</option>
      <option value="medium" ${filters.level === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="low" ${filters.level === 'low' ? 'selected' : ''}>Low</option>
      <option value="insufficient" ${filters.level === 'insufficient' ? 'selected' : ''}>Not enough data</option>
    </select>
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
  </form>
  <div class="card">
    <h3>Attendance risk by student</h3>
    <p class="cap">${pred.rows.length} student${pred.rows.length === 1 ? '' : 's'} across your courses</p>
    ${pred.rows.length ? `<table>
      <thead><tr><th>Student</th><th>Course</th><th>Attendance</th><th>Trend</th><th>Risk</th><th>Why</th></tr></thead>
      <tbody>${pred.rows.map(r => `<tr class="rowhover">
        <td class="mono">${escapeHtml(r.rollNumber)}<br><span style="font-size:11px;color:var(--slate-dim);font-family:inherit;">${escapeHtml(r.studentName)}</span></td>
        <td>${escapeHtml(r.courseName)}</td>
        <td class="mono">${r.pct}%</td>
        <td style="font-size:12.5px;">${predictionTrendLabel(r.trend)}</td>
        <td>${predictionRiskBadge(r.level)}</td>
        <td style="font-size:11.5px;color:var(--slate);max-width:260px;">${escapeHtml(r.explanation)}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No students match these filters.</div>'}
  </div>`;
}
async function applyFacultyPredictionsFilters() {
  const filters = {
    course_id: document.getElementById('fpf-course')?.value || '',
    level: document.getElementById('fpf-level')?.value || '',
  };
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  rerenderFacultyReports('predictions', filters);
}

/* ==========================================================================
   Feature: Student Excuse System — faculty + admin review UI. Server-side
   ownership/ authorization is the real boundary (faculty.js / admin.js) —
   this UI only reflects what the API already allowed it to fetch.
   ========================================================================== */
function openExcuseReviewModal(action, onConfirm) {
  openModal(action === 'approved' ? 'Approve excuse request' : 'Reject excuse request', `
    <div class="field"><label>Reviewer comment (optional)</label><textarea id="rv-comment" rows="3" placeholder="Visible to the student…" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);font-size:13px;font-family:inherit;color:var(--ink);resize:vertical;"></textarea></div>
    <div class="field-error" id="rv-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    {
      label: action === 'approved' ? 'Approve' : 'Reject',
      className: `btn-sm ${action === 'approved' ? 'btn-verify' : 'btn-danger'}`,
      onClick: async () => {
        const errEl = document.getElementById('rv-error');
        const comment = document.getElementById('rv-comment').value.trim();
        try {
          await onConfirm(comment);
          closeModal();
          showToast(action === 'approved' ? 'Request approved' : 'Request rejected');
        } catch (e) { errEl.textContent = e.message; }
      }
    }
  ]);
}
function facultyReviewExcuse(id, action) {
  openExcuseReviewModal(action, async (comment) => {
    await api(`/api/faculty/excuses/${id}`, { method: 'PUT', body: { status: action, reviewer_comment: comment } });
    rerenderFacultyExcuses(window.__facultyExcuseFilters || {});
  });
}
function adminReviewExcuse(id, action) {
  openExcuseReviewModal(action, async (comment) => {
    await api(`/api/admin/excuses/${id}`, { method: 'PUT', body: { status: action, reviewer_comment: comment } });
    rerenderAdminExcuses(window.__adminExcuseFilters || {});
  });
}
function excuseTableHtml(rows, reviewFnName) {
  if (!rows.length) return '<div class="empty-note">No excuse requests match these filters.</div>';
  return `<table id="excuse-table">
    <thead><tr><th>Student</th><th>Course</th><th>Session date</th><th>Reason</th><th>Submitted</th><th>Status</th><th>Reviewer comment</th><th></th></tr></thead>
    <tbody>${rows.map(ex => `<tr class="rowhover" data-search="${escapeHtml((ex.roll_number + ' ' + ex.student_name).toLowerCase())}">
      <td class="mono">${escapeHtml(ex.roll_number)}<br><span style="font-size:11px;color:var(--slate-dim);">${escapeHtml(ex.student_name)}</span></td>
      <td>${escapeHtml(ex.course_name)}</td>
      <td class="mono">${ex.session_date}</td>
      <td style="max-width:220px;">${escapeHtml(ex.reason)}${ex.details ? `<div style="font-size:11px;color:var(--slate);margin-top:2px;">${escapeHtml(ex.details)}</div>` : ''}</td>
      <td class="mono">${ex.created_at.split(' ')[0]}</td>
      <td>${excuseStatusBadge(ex.status)}</td>
      <td style="font-size:12px;color:var(--slate);max-width:200px;">${ex.reviewer_comment ? escapeHtml(ex.reviewer_comment) : '—'}</td>
      <td class="inline-actions">
        ${ex.status === 'pending' ? `<button class="btn-sm btn-verify" onclick="${reviewFnName}(${ex.id},'approved')">Approve</button><button class="btn-sm btn-danger" onclick="${reviewFnName}(${ex.id},'rejected')">Reject</button>` : ''}
      </td>
    </tr>`).join('')}</tbody>
  </table>`;
}
function wireExcuseSearchBox(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('#excuse-table tbody tr').forEach(tr => {
      tr.style.display = !q || (tr.dataset.search || '').includes(q) ? '' : 'none';
    });
  };
}

async function facultyExcuses(filters = {}) {
  window.__facultyExcuseFilters = filters;
  const [{ courses }, { rows }] = await Promise.all([
    api('/api/faculty/courses'),
    api('/api/faculty/excuses' + qs(filters))
  ]);
  return `
  <form id="fex-form" class="table-controls" style="margin-bottom:18px;">
    <input class="search-input" id="fex-search" placeholder="Search by roll no. or name…">
    <select class="select-input" id="fex-course"><option value="">All my courses</option>${courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <select class="select-input" id="fex-status"><option value="">All statuses</option>
      <option value="pending" ${filters.status === 'pending' ? 'selected' : ''}>Pending</option>
      <option value="approved" ${filters.status === 'approved' ? 'selected' : ''}>Approved</option>
      <option value="rejected" ${filters.status === 'rejected' ? 'selected' : ''}>Rejected</option>
    </select>
    <input type="date" class="select-input" id="fex-from" value="${filters.from || ''}">
    <input type="date" class="select-input" id="fex-to" value="${filters.to || ''}">
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
  </form>
  <div class="card">
    <h3>Excuse requests</h3>
    <p class="cap">${rows.length} request${rows.length === 1 ? '' : 's'}${filters.status ? ' · ' + filters.status : ''}</p>
    ${excuseTableHtml(rows, 'facultyReviewExcuse')}
  </div>`;
}
function wireFacultyExcusesEvents() {
  const form = document.getElementById('fex-form');
  if (form) form.onsubmit = (e) => { e.preventDefault(); applyFacultyExcuseFilters(); };
  wireExcuseSearchBox('fex-search');
}
function applyFacultyExcuseFilters() {
  const filters = {
    course_id: document.getElementById('fex-course').value,
    status: document.getElementById('fex-status').value,
    from: document.getElementById('fex-from').value,
    to: document.getElementById('fex-to').value,
  };
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  rerenderFacultyExcuses(filters);
}
async function rerenderFacultyExcuses(filters = {}) {
  document.getElementById('page-content').innerHTML = await facultyExcuses(filters);
  wireFacultyExcusesEvents();
}

async function adminExcuses(filters = {}) {
  window.__adminExcuseFilters = filters;
  const [{ rows: courses }, { rows: departments }, { rows }] = await Promise.all([
    api('/api/admin/courses'),
    api('/api/admin/departments'),
    api('/api/admin/excuses' + qs(filters))
  ]);
  const activeCourses = courses.filter(c => c.status === 'active');
  return `
  <form id="aex-form" class="table-controls" style="margin-bottom:18px;">
    <input class="search-input" id="aex-search" placeholder="Search by roll no. or name…">
    <select class="select-input" id="aex-department"><option value="">All departments</option>${departments.map(d => `<option ${filters.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
    <select class="select-input" id="aex-course"><option value="">All courses</option>${activeCourses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <select class="select-input" id="aex-status"><option value="">All statuses</option>
      <option value="pending" ${filters.status === 'pending' ? 'selected' : ''}>Pending</option>
      <option value="approved" ${filters.status === 'approved' ? 'selected' : ''}>Approved</option>
      <option value="rejected" ${filters.status === 'rejected' ? 'selected' : ''}>Rejected</option>
    </select>
    <input type="date" class="select-input" id="aex-from" value="${filters.from || ''}">
    <input type="date" class="select-input" id="aex-to" value="${filters.to || ''}">
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
  </form>
  <div class="grid g-4" style="margin-bottom:18px;">
    <div class="card kpi"><div class="kpi-label">Total requests</div><div class="kpi-value">${rows.length}</div></div>
    <div class="card kpi"><div class="kpi-label">Pending</div><div class="kpi-value" style="color:#9c6a12;">${rows.filter(r => r.status === 'pending').length}</div></div>
    <div class="card kpi"><div class="kpi-label">Approved</div><div class="kpi-value" style="color:var(--verify);">${rows.filter(r => r.status === 'approved').length}</div></div>
    <div class="card kpi"><div class="kpi-label">Rejected</div><div class="kpi-value" style="color:var(--red);">${rows.filter(r => r.status === 'rejected').length}</div></div>
  </div>
  <div class="card">
    <h3>All excuse requests</h3>
    <p class="cap">Institution-wide, current filters</p>
    ${excuseTableHtml(rows, 'adminReviewExcuse')}
  </div>`;
}
function wireAdminExcusesEvents() {
  const form = document.getElementById('aex-form');
  if (form) form.onsubmit = (e) => { e.preventDefault(); applyAdminExcuseFilters(); };
  wireExcuseSearchBox('aex-search');
}
function applyAdminExcuseFilters() {
  const filters = {
    department: document.getElementById('aex-department').value,
    course_id: document.getElementById('aex-course').value,
    status: document.getElementById('aex-status').value,
    from: document.getElementById('aex-from').value,
    to: document.getElementById('aex-to').value,
  };
  Object.keys(filters).forEach(k => !filters[k] && delete filters[k]);
  rerenderAdminExcuses(filters);
}
async function rerenderAdminExcuses(filters = {}) {
  document.getElementById('page-content').innerHTML = await adminExcuses(filters);
  wireAdminExcusesEvents();
}

/* ==========================================================================
   Feature: Student Notes — private, staff-only (faculty + admin). Shared by
   the faculty roster (facultyTake) and the admin Users table. Server-side
   authorization (course-ownership / note-authorship) is the real boundary —
   this modal only reflects what the API already allowed it to fetch.
   ========================================================================== */
async function openStudentNotesModal(studentId, studentLabel, courseId) {
  openModal(`Notes — ${studentLabel}`, skeletonBlock(90), [
    { label: 'Close', className: 'btn-sm', onClick: closeModal }
  ]);
  await refreshStudentNotes(studentId, courseId);
}
async function refreshStudentNotes(studentId, courseId) {
  const body = document.getElementById('modal-body');
  if (!body) return; // modal was closed before this resolved
  try {
    const data = await api(`/api/notes/student/${studentId}`);
    window.__noteContents = {};
    data.rows.forEach(n => { window.__noteContents[n.id] = n.content; });
    body.innerHTML = renderStudentNotesBody(studentId, data, courseId);
    wireStudentNotesForm(studentId, courseId);
  } catch (e) {
    body.innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
}
function renderStudentNotesBody(studentId, data, courseId) {
  return `
  <div style="max-height:320px; overflow-y:auto; margin-bottom:14px;">
    ${data.rows.length ? data.rows.map(n => `
      <div class="card" id="note-card-${n.id}" style="margin-bottom:10px; padding:14px;">
        <div style="display:flex; justify-content:space-between; align-items:start; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
          <div>
            <span style="font-weight:600; font-size:13px;">${escapeHtml(n.author_name)}</span>
            <span class="badge slate" style="margin-left:6px;">${escapeHtml(n.author_role)}</span>
            ${n.course_name ? `<span class="badge slate" style="margin-left:4px;">${escapeHtml(n.course_name)}</span>` : ''}
          </div>
          <span style="font-size:11px;color:var(--slate-dim);font-family:'IBM Plex Mono',monospace;">${n.created_at}</span>
        </div>
        <p style="font-size:13px; margin:0 0 8px; white-space:pre-wrap;">${escapeHtml(n.content)}</p>
        ${n.isOwn ? `<div style="display:flex;gap:8px;">
          <button class="btn-sm" onclick="editStudentNote(${n.id}, ${studentId}, ${courseId || 'null'})">Edit</button>
          <button class="btn-sm btn-danger" onclick="confirmDeleteStudentNote(${n.id}, ${studentId}, ${courseId || 'null'})">Delete</button>
        </div>` : ''}
      </div>`).join('') : '<div class="empty-note">No notes yet for this student.</div>'}
  </div>
  <form id="note-add-form">
    <div class="field"><label>Add a note</label><textarea id="note-content" rows="3" placeholder="Write a private note about this student…" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);font-size:13px;font-family:inherit;color:var(--ink);resize:vertical;"></textarea></div>
    <div class="field-error" id="note-error"></div>
    <button class="btn-sm btn-dark" type="submit">Add note</button>
  </form>`;
}
function wireStudentNotesForm(studentId, courseId) {
  const form = document.getElementById('note-add-form');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('note-error');
    errEl.textContent = '';
    const content = document.getElementById('note-content').value.trim();
    if (!content) { errEl.textContent = 'Note content is required.'; return; }
    try {
      await api(`/api/notes/student/${studentId}`, { method: 'POST', body: { content, course_id: courseId || undefined } });
      showToast('Note added');
      refreshStudentNotes(studentId, courseId);
    } catch (e) { errEl.textContent = e.message; }
  };
}
function editStudentNote(noteId, studentId, courseId) {
  const card = document.getElementById(`note-card-${noteId}`);
  const content = (window.__noteContents && window.__noteContents[noteId]) || '';
  card.innerHTML = `
    <textarea id="note-edit-${noteId}" rows="3" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);font-size:13px;font-family:inherit;color:var(--ink);resize:vertical;">${escapeHtml(content)}</textarea>
    <div class="field-error" id="note-edit-error-${noteId}"></div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button class="btn-sm btn-dark" onclick="saveStudentNote(${noteId}, ${studentId}, ${courseId || 'null'})">Save</button>
      <button class="btn-sm" onclick="refreshStudentNotes(${studentId}, ${courseId || 'null'})">Cancel</button>
    </div>`;
}
async function saveStudentNote(noteId, studentId, courseId) {
  const val = document.getElementById(`note-edit-${noteId}`).value.trim();
  const errEl = document.getElementById(`note-edit-error-${noteId}`);
  if (!val) { errEl.textContent = 'Note cannot be empty.'; return; }
  try {
    await api(`/api/notes/${noteId}`, { method: 'PUT', body: { content: val } });
    showToast('Note updated');
    refreshStudentNotes(studentId, courseId);
  } catch (e) { errEl.textContent = e.message; }
}
function confirmDeleteStudentNote(noteId, studentId, courseId) {
  const card = document.getElementById(`note-card-${noteId}`);
  card.innerHTML = `
    <p style="font-size:13px;margin:0 0 10px;">Delete this note? This cannot be undone.</p>
    <div style="display:flex;gap:8px;">
      <button class="btn-sm btn-danger" onclick="deleteStudentNote(${noteId}, ${studentId}, ${courseId || 'null'})">Yes, delete</button>
      <button class="btn-sm" onclick="refreshStudentNotes(${studentId}, ${courseId || 'null'})">Cancel</button>
    </div>`;
}
async function deleteStudentNote(noteId, studentId, courseId) {
  try {
    await api(`/api/notes/${noteId}`, { method: 'DELETE' });
    showToast('Note deleted');
    refreshStudentNotes(studentId, courseId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function notifyStudent(roll, btn) {
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await api(`/api/faculty/notify/${roll}`, { method: 'POST' });
    showToast('Notification sent to ' + roll);
    btn.textContent = 'Notified ✓';
  } catch (e) { showToast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Notify'; }
}

/* ==========================================================================
   ADMIN PAGES
   ========================================================================== */
async function adminHome() {
  const d = await api('/api/admin/dashboard');
  return `
  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Total students</div><div class="kpi-value">${d.totalStudents}</div><div class="kpi-delta up mono">live count</div></div>
    <div class="card kpi"><div class="kpi-label">Faculty</div><div class="kpi-value">${d.totalFaculty}</div><div class="kpi-delta up mono">across departments</div></div>
    <div class="card kpi"><div class="kpi-label">Active courses</div><div class="kpi-value">${d.activeCourses}</div><div class="kpi-delta up mono">${d.deptComparison.length} depts</div></div>
    <div class="card kpi"><div class="kpi-label">Avg. attendance</div><div class="kpi-value">${d.overallAttendance}%</div><div class="kpi-delta ${d.overallAttendance >= 75 ? 'up' : 'down'} mono">${d.lowAttendanceCount} students at risk</div></div>
  </div>
  <div class="grid g-2" style="margin-top:18px;">
    <div class="card">
      <h3>Institution-wide trend</h3>
      <p class="cap">Rolling weekly average</p>
      ${lineChartSVG(d.trend, d.trendLabels, 'var(--verify)')}
    </div>
    <div class="card">
      <h3>Department comparison</h3>
      <p class="cap">Average attendance by department</p>
      ${vBarsSVG(d.deptComparison, 'var(--ink)')}
    </div>
  </div>`;
}

function wireAdminPeopleEvents() {
  document.getElementById('tab-users')?.addEventListener('click', () => rerenderPeople('users'));
  document.getElementById('tab-courses')?.addEventListener('click', () => rerenderPeople('courses'));
  document.getElementById('tab-bulk-import')?.addEventListener('click', () => rerenderPeople('bulk-import'));
  document.getElementById('tab-departments')?.addEventListener('click', () => rerenderPeople('departments'));
  const searchForm = document.getElementById('user-search-form');
  if (searchForm) searchForm.onsubmit = (e) => { e.preventDefault(); rerenderPeople('users', { search: document.getElementById('u-search').value, role: document.getElementById('u-role').value }); };
  const fileInput = document.getElementById('bi-file');
  if (fileInput) fileInput.addEventListener('change', () => handleBulkImportFileChange(fileInput));
}
const PEOPLE_TABS_HTML = (active) => `
    <div class="tabs">
      <button class="tab-btn ${active === 'users' ? 'active' : ''}" id="tab-users">Users</button>
      <button class="tab-btn ${active === 'courses' ? 'active' : ''}" id="tab-courses">Courses</button>
      <button class="tab-btn ${active === 'departments' ? 'active' : ''}" id="tab-departments">Departments</button>
      <button class="tab-btn ${active === 'bulk-import' ? 'active' : ''}" id="tab-bulk-import">Bulk Import</button>
    </div>`;
async function adminPeople(tab = 'users', usersState = {}, coursesPage = 1) {
  if (tab === 'departments') {
    return PEOPLE_TABS_HTML('departments') + await adminDepartmentsTab();
  }
  if (tab === 'bulk-import') {
    return PEOPLE_TABS_HTML('bulk-import') + adminBulkImportTab();
  }
  if (tab === 'courses') {
    const { rows } = await api('/api/admin/courses');
    return PEOPLE_TABS_HTML('courses') + `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <p class="cap" style="margin:0;">${rows.length} courses</p>
        <button class="btn-sm btn-dark" onclick="openCourseModal()">+ Add course</button>
      </div>
      <table>
        <thead><tr><th>Code</th><th>Course</th><th>Department</th><th>Academic Year</th><th>Year/Sem</th><th>Section</th><th>Faculty</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(c => `<tr class="rowhover ${c.status !== 'active' ? 'disabled-row' : ''}">
          <td class="mono">${escapeHtml(c.course_code)}</td><td>${escapeHtml(c.course_name)}</td><td>${escapeHtml(c.department || '—')}</td>
          <td>${escapeHtml(c.academic_year || '—')}</td><td>${c.semester ?? '—'}</td>
          <td>${escapeHtml(c.section || '—')}</td><td>${escapeHtml(c.faculty_name || '—')}</td>
          <td><span class="badge ${c.status === 'active' ? 'green' : 'slate'}">${c.status}</span></td>
          <td class="inline-actions">
            <button class="btn-sm" onclick="openCourseModal(${c.id})">Edit</button>
            ${c.status === 'active' ? `<button class="btn-sm btn-danger" onclick="deactivateCourse(${c.id})">Deactivate</button>` : ''}
          </td></tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  const params = new URLSearchParams(Object.assign({ page: usersState.page || 1 }, usersState));
  const data = await api('/api/admin/users?' + params.toString());
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return PEOPLE_TABS_HTML('users') + `
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
      <p class="cap" style="margin:0;">${data.total} users</p>
      <button class="btn-sm btn-dark" onclick="openUserModal()">+ Add user</button>
    </div>
    <form id="user-search-form" class="table-controls">
      <input class="search-input" id="u-search" placeholder="Search by ID, name or department…" value="${escapeHtml(usersState.search || '')}">
      <select class="select-input" id="u-role">
        <option value="">All roles</option>
        <option value="student" ${usersState.role === 'student' ? 'selected' : ''}>Student</option>
        <option value="faculty" ${usersState.role === 'faculty' ? 'selected' : ''}>Faculty</option>
        <option value="admin" ${usersState.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
      <button class="btn-sm btn-dark" type="submit">Search</button>
    </form>
    <table>
      <thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Department</th><th>Status</th><th></th></tr></thead>
      <tbody>${data.rows.map(u => `<tr class="rowhover ${u.status !== 'active' ? 'disabled-row' : ''}">
        <td class="mono">${escapeHtml(u.user_id)}</td><td>${escapeHtml(u.name)}</td>
        <td><span class="badge slate">${u.role.charAt(0).toUpperCase() + u.role.slice(1)}</span></td>
        <td>${escapeHtml(u.department || '—')}</td>
        <td><span class="badge ${u.status === 'active' ? 'green' : 'red'}"><span class="dot"></span>${u.status}</span> ${u.twofa_enabled ? '<span class="badge slate" title="Two-factor authentication enabled">🔒 2FA</span>' : ''}</td>
        <td class="inline-actions">
          <button class="btn-sm" onclick="openUserModal(${u.id}, '${u.role}')">Edit</button>
          ${u.role === 'student' && u.student_id ? `<button class="btn-sm" onclick="openStudentNotesModal(${u.student_id}, '${escapeHtml(u.user_id)}')">Notes</button>` : ''}
          <button class="btn-sm" onclick="resetPassword(${u.id})">Reset PW</button>
          ${u.twofa_enabled ? `<button class="btn-sm" onclick="adminResetTwoFa(${u.id}, '${escapeHtml(u.user_id)}')">Reset 2FA</button>` : ''}
          ${u.status === 'active' ? `<button class="btn-sm btn-danger" onclick="disableUser(${u.id})">Disable</button>` : ''}
        </td></tr>`).join('')}</tbody>
    </table>
    <div class="pagination">
      <span>Page ${data.page} of ${totalPages}</span>
      <button ${data.page <= 1 ? 'disabled' : ''} onclick="rerenderPeople('users', ${JSON.stringify(usersState)}, ${data.page - 1})">Prev</button>
      <button ${data.page >= totalPages ? 'disabled' : ''} onclick="rerenderPeople('users', ${JSON.stringify(usersState)}, ${data.page + 1})">Next</button>
    </div>
  </div>`;
}
async function rerenderPeople(tab, usersState = {}, page) {
  if (page) usersState.page = page;
  document.getElementById('page-content').innerHTML = await adminPeople(tab, usersState);
  wireAdminPeopleEvents();
}

/* ==========================================================================
   Feature: Department Management (admin-only — enforced server-side; this UI
   only reflects what /api/admin/depts already allowed it to fetch/change).
   ========================================================================== */
async function adminDepartmentsTab() {
  const { rows } = await api('/api/admin/depts');
  window.__deptCache = rows;
  return `
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
      <p class="cap" style="margin:0;">${rows.length} department${rows.length === 1 ? '' : 's'}</p>
      <button class="btn-sm btn-dark" onclick="openDepartmentModal()">+ Add department</button>
    </div>
    ${rows.length ? `<table>
      <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Students</th><th>Faculty</th><th>Courses</th><th></th></tr></thead>
      <tbody>${rows.map(d => `<tr class="rowhover ${d.status !== 'active' ? 'disabled-row' : ''}">
        <td class="mono">${escapeHtml(d.code)}</td>
        <td>${escapeHtml(d.name)}</td>
        <td><span class="badge ${d.status === 'active' ? 'green' : 'slate'}"><span class="dot"></span>${d.status}</span></td>
        <td>${d.counts.students}</td>
        <td>${d.counts.faculty}</td>
        <td>${d.counts.courses}</td>
        <td class="inline-actions">
          <button class="btn-sm" onclick="openDepartmentDetail(${d.id})">View</button>
          <button class="btn-sm" onclick="openDepartmentModal(${d.id})">Edit</button>
          <button class="btn-sm" onclick="toggleDepartmentStatus(${d.id}, '${d.status === 'active' ? 'inactive' : 'active'}')">${d.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="btn-sm btn-danger" onclick="deleteDepartment(${d.id}, '${escapeHtml(d.code)}')">Delete</button>
        </td></tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No departments registered yet.</div>'}
  </div>`;
}
function openDepartmentModal(id) {
  const isEdit = !!id;
  const existing = isEdit ? window.__deptCache?.find(d => d.id === id) : null;
  openModal(isEdit ? 'Edit department' : 'Add department', `
    <div class="field"><label>Code</label><input id="d-m-code" placeholder="e.g. CSE" ${isEdit ? 'disabled' : ''} value="${existing ? escapeHtml(existing.code) : ''}" style="text-transform:uppercase;"></div>
    <div class="field"><label>Name</label><input id="d-m-name" placeholder="e.g. Computer Science and Engineering" value="${existing ? escapeHtml(existing.name) : ''}"></div>
    <div class="field"><label>Description (optional)</label><textarea id="d-m-desc" rows="3" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card);font-size:13px;font-family:inherit;color:var(--ink);resize:vertical;">${existing ? escapeHtml(existing.description || '') : ''}</textarea></div>
    <div class="field-error" id="d-m-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: isEdit ? 'Save changes' : 'Create department', className: 'btn-sm btn-dark', onClick: () => submitDepartment(id) }
  ]);
  if (isEdit && !existing) {
    // modal opened directly (e.g. reload) without a warm cache — fetch fresh
    api('/api/admin/depts').then(({ rows }) => {
      window.__deptCache = rows;
      const d = rows.find(r => r.id === id);
      if (d) {
        document.getElementById('d-m-code').value = d.code;
        document.getElementById('d-m-name').value = d.name;
        document.getElementById('d-m-desc').value = d.description || '';
      }
    });
  }
}
async function submitDepartment(id) {
  const errEl = document.getElementById('d-m-error');
  errEl.textContent = '';
  const code = document.getElementById('d-m-code').value.trim();
  const name = document.getElementById('d-m-name').value.trim();
  const description = document.getElementById('d-m-desc').value.trim();
  if (!id && !code) { errEl.textContent = 'Department code is required.'; return; }
  if (!name) { errEl.textContent = 'Department name is required.'; return; }
  try {
    if (id) await api(`/api/admin/depts/${id}`, { method: 'PUT', body: { name, description } });
    else await api('/api/admin/depts', { method: 'POST', body: { code, name, description } });
    closeModal();
    showToast(id ? 'Department updated' : 'Department created');
    rerenderPeople('departments');
  } catch (e) { errEl.textContent = e.message; }
}
async function toggleDepartmentStatus(id, newStatus) {
  try {
    await api(`/api/admin/depts/${id}/status`, { method: 'PUT', body: { status: newStatus } });
    showToast(newStatus === 'active' ? 'Department activated' : 'Department deactivated');
    rerenderPeople('departments');
  } catch (e) { showToast(e.message, 'error'); }
}
function deleteDepartment(id, code) {
  confirmDialog(`Delete department "${escapeHtml(code)}"? This only works if no students, faculty or courses reference it.`, async () => {
    try {
      await api(`/api/admin/depts/${id}`, { method: 'DELETE' });
      showToast('Department deleted');
      rerenderPeople('departments');
    } catch (e) { showToast(e.message, 'error'); }
  });
}
async function openDepartmentDetail(id) {
  openModal('Department details', skeletonBlock(100), [{ label: 'Close', className: 'btn-sm', onClick: closeModal }]);
  try {
    const { department: d, students, faculty, courses } = await api(`/api/admin/depts/${id}`);
    document.getElementById('modal-title').textContent = `${d.code} — ${d.name}`;
    document.getElementById('modal-body').innerHTML = `
      <p style="font-size:12.5px;color:var(--slate);margin-bottom:14px;">${d.description ? escapeHtml(d.description) : 'No description.'}</p>
      <div class="tabs" id="dd-tabs" style="margin-bottom:12px;">
        <button class="tab-btn active" data-t="students">Students (${students.length})</button>
        <button class="tab-btn" data-t="faculty">Faculty (${faculty.length})</button>
        <button class="tab-btn" data-t="courses">Courses (${courses.length})</button>
      </div>
      <div id="dd-body" style="max-height:320px;overflow-y:auto;">${renderDeptStudents(students)}</div>`;
    document.getElementById('dd-tabs').querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      document.getElementById('dd-tabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      const body = document.getElementById('dd-body');
      if (btn.dataset.t === 'students') body.innerHTML = renderDeptStudents(students);
      if (btn.dataset.t === 'faculty') body.innerHTML = renderDeptFaculty(faculty);
      if (btn.dataset.t === 'courses') body.innerHTML = renderDeptCourses(courses);
    }));
  } catch (e) {
    document.getElementById('modal-body').innerHTML = `<div class="error-banner">${escapeHtml(e.message)}</div>`;
  }
}
function renderDeptStudents(rows) {
  if (!rows.length) return '<div class="empty-note">No students in this department.</div>';
  return `<table><thead><tr><th>Roll No.</th><th>Name</th><th>Year</th><th>Section</th></tr></thead><tbody>
    ${rows.map(s => `<tr class="rowhover"><td class="mono">${escapeHtml(s.roll_number)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.year_of_study || '—')}</td><td>${escapeHtml(s.section || '—')}</td></tr>`).join('')}
  </tbody></table>`;
}
function renderDeptFaculty(rows) {
  if (!rows.length) return '<div class="empty-note">No faculty in this department.</div>';
  return `<table><thead><tr><th>Staff ID</th><th>Name</th></tr></thead><tbody>
    ${rows.map(f => `<tr class="rowhover"><td class="mono">${escapeHtml(f.employee_id)}</td><td>${escapeHtml(f.name)}</td></tr>`).join('')}
  </tbody></table>`;
}
function renderDeptCourses(rows) {
  if (!rows.length) return '<div class="empty-note">No courses in this department.</div>';
  return `<table><thead><tr><th>Code</th><th>Course</th><th>Status</th></tr></thead><tbody>
    ${rows.map(c => `<tr class="rowhover"><td class="mono">${escapeHtml(c.course_code)}</td><td>${escapeHtml(c.course_name)}</td><td><span class="badge ${c.status === 'active' ? 'green' : 'slate'}">${c.status}</span></td></tr>`).join('')}
  </tbody></table>`;
}

/* ---- Feature: Bulk User Import (CSV) ---- */
function adminBulkImportTab() {
  return `
  <div class="card" style="margin-bottom:18px;">
    <h3>Bulk Import Students &amp; Faculty</h3>
    <p class="cap">Upload a CSV to create many accounts at once. Nothing is written to the database until you confirm the preview.</p>
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
      <button type="button" class="btn-sm" onclick="downloadFile('/api/admin/users/bulk-import/template','user_import_template.csv')">Download sample CSV template</button>
      <label class="btn-sm btn-dark" style="cursor:pointer;">Choose CSV file<input type="file" id="bi-file" accept=".csv,text/csv" style="display:none;"></label>
      <span id="bi-file-label" style="font-size:12.5px;color:var(--slate);"></span>
    </div>
    <p style="font-size:11.5px;color:var(--slate-dim);margin-top:10px;line-height:1.6;">
      Columns: <span class="mono">role, id, name, email, department, year_of_study, section, password</span><br>
      <span class="mono">year_of_study</span> and <span class="mono">section</span> are required for student rows only. <span class="mono">role</span> must be <span class="mono">student</span> or <span class="mono">faculty</span>.
    </p>
  </div>
  <div id="bi-preview-area"></div>`;
}
function handleBulkImportFileChange(input) {
  const file = input.files[0];
  document.getElementById('bi-preview-area').innerHTML = '';
  window.__bulkImportCsvText = null;
  window.__bulkImportPreview = null;
  const label = document.getElementById('bi-file-label');
  if (!file) { label.textContent = ''; return; }
  label.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB) — reading…`;
  const reader = new FileReader();
  reader.onload = () => {
    window.__bulkImportCsvText = reader.result;
    label.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    runBulkImportPreview();
  };
  reader.onerror = () => showToast('Could not read the selected file.', 'error');
  reader.readAsText(file);
}
async function runBulkImportPreview() {
  const area = document.getElementById('bi-preview-area');
  if (!window.__bulkImportCsvText) return;
  area.innerHTML = skeletonBlock(140);
  try {
    const result = await api('/api/admin/users/bulk-import/preview', { method: 'POST', body: { csv: window.__bulkImportCsvText } });
    window.__bulkImportPreview = result;
    area.innerHTML = renderBulkImportPreview(result);
  } catch (e) {
    area.innerHTML = `<div class="card"><div class="error-banner">${escapeHtml(e.message)}</div></div>`;
  }
}
function renderBulkImportPreview(result) {
  const s = result.summary;
  if (!s.totalRows) return '<div class="card"><div class="empty-note">No data rows found in this file.</div></div>';
  return `
  <div class="card" style="margin-bottom:18px;">
    <h3>Preview</h3>
    <p class="cap">Nothing has been imported yet — review below, then confirm.</p>
    <div class="grid g-4">
      <div class="card kpi"><div class="kpi-label">Total rows</div><div class="kpi-value">${s.totalRows}</div></div>
      <div class="card kpi"><div class="kpi-label">Valid</div><div class="kpi-value" style="color:var(--verify);">${s.validCount}</div></div>
      <div class="card kpi"><div class="kpi-label">Invalid</div><div class="kpi-value" style="color:var(--red);">${s.invalidCount}</div></div>
      <div class="card kpi"><div class="kpi-label">Students / Faculty</div><div class="kpi-value" style="font-size:22px;">${s.students} / ${s.faculty}</div></div>
    </div>
    <div style="display:flex; gap:10px; margin-top:16px;">
      <button class="btn-sm btn-verify" ${s.validCount ? '' : 'disabled'} onclick="confirmBulkImport()">Confirm import (${s.validCount} row${s.validCount === 1 ? '' : 's'})</button>
      <button class="btn-sm" onclick="resetBulkImport()">Cancel</button>
    </div>
  </div>
  <div class="card">
    <h3>Row-by-row results</h3>
    <table><thead><tr><th>Row</th><th>Role</th><th>ID</th><th>Name</th><th>Status</th><th>Errors</th></tr></thead>
    <tbody>${result.results.map(r => `<tr class="rowhover">
      <td class="mono">${r.row}</td>
      <td>${escapeHtml(r.data.role || '—')}</td>
      <td class="mono">${escapeHtml(r.data.user_id || '—')}</td>
      <td>${escapeHtml(r.data.name || '—')}</td>
      <td>${r.status === 'valid' ? statusBadge('present') : statusBadge('absent')}</td>
      <td style="font-size:11.5px;color:var(--red);max-width:320px;">${r.errors.map(escapeHtml).join('<br>')}</td>
    </tr>`).join('')}</tbody></table>
  </div>`;
}
async function confirmBulkImport() {
  if (!window.__bulkImportCsvText) return;
  const area = document.getElementById('bi-preview-area');
  area.innerHTML = skeletonBlock(140);
  try {
    const result = await api('/api/admin/users/bulk-import/confirm', { method: 'POST', body: { csv: window.__bulkImportCsvText } });
    area.innerHTML = renderBulkImportSummary(result);
    if (result.ok) showToast(`Imported ${result.imported.students} student(s) and ${result.imported.faculty} faculty member(s)`);
    else showToast(result.error, 'error');
    window.__bulkImportCsvText = null; window.__bulkImportPreview = null;
    const fi = document.getElementById('bi-file'); if (fi) fi.value = '';
    const lbl = document.getElementById('bi-file-label'); if (lbl) lbl.textContent = '';
  } catch (e) {
    area.innerHTML = `<div class="card"><div class="error-banner">${escapeHtml(e.message)}</div></div>`;
  }
}
function renderBulkImportSummary(result) {
  if (!result.ok) {
    return `<div class="card"><div class="error-banner">${escapeHtml(result.error)}</div>${result.detail ? `<p style="font-size:12.5px;color:var(--slate);margin-top:8px;">${escapeHtml(result.detail)}</p>` : ''}</div>`;
  }
  return `
  <div class="card">
    <h3>Import complete</h3>
    <p class="cap">${new Date(result.timestamp).toLocaleString()}</p>
    <div class="grid g-3">
      <div class="card kpi"><div class="kpi-label">Imported</div><div class="kpi-value" style="font-size:19px;">${result.imported.students} students<br>${result.imported.faculty} faculty</div></div>
      <div class="card kpi"><div class="kpi-label">Skipped</div><div class="kpi-value">${result.skipped}</div></div>
      <div class="card kpi"><div class="kpi-label">Errors</div><div class="kpi-value">${result.failedRows.length}</div></div>
    </div>
    ${result.failedRows.length ? `<div style="margin-top:16px;">
      <p class="cap" style="margin-bottom:8px;">Errors</p>
      ${result.failedRows.map(r => `<div style="font-size:12.5px;margin-bottom:6px;color:var(--slate);"><b style="color:var(--ink);">Row ${r.row}</b> — ${r.errors.map(escapeHtml).join('; ')}</div>`).join('')}
    </div>` : ''}
  </div>`;
}
function resetBulkImport() {
  window.__bulkImportCsvText = null; window.__bulkImportPreview = null;
  const fi = document.getElementById('bi-file'); if (fi) fi.value = '';
  const lbl = document.getElementById('bi-file-label'); if (lbl) lbl.textContent = '';
  const area = document.getElementById('bi-preview-area'); if (area) area.innerHTML = '';
}

// Student roles show Department + Academic Year + dependent Section; faculty and
// admin only need Department (faculty per spec has no Academic Year/Section; admin's
// "section" is a free-text label like "Department Incharge", not a real section,
// so it's edited elsewhere rather than through this dropdown-driven flow).
function toggleUserModalYearSectionFields(role) {
  const show = role === 'student';
  document.getElementById('m-year-field').style.display = show ? '' : 'none';
  document.getElementById('m-section-field').style.display = show ? '' : 'none';
}

function openUserModal(id, role) {
  const isEdit = !!id;
  openModal(isEdit ? 'Edit user' : 'Add user', `
    <div class="field"><label>${role === 'student' ? 'Register Number' : role === 'faculty' ? 'Staff ID' : 'ID'}</label><input id="m-userid" ${isEdit ? 'disabled' : ''} placeholder="e.g. 24UCS231"></div>
    <div class="field"><label>Full name</label><input id="m-name" placeholder="Full name"></div>
    <div class="field"><label>Email</label><input id="m-email" placeholder="name@college.edu"></div>
    ${!isEdit ? `<div class="field"><label>Role</label><select id="m-role" onchange="toggleUserModalYearSectionFields(this.value)"><option value="student">Student</option><option value="faculty">Faculty</option><option value="admin">Admin</option></select></div>` : ''}
    <div class="field"><label>Department</label><select id="m-dept"></select></div>
    <div class="field" id="m-year-field"><label>Academic Year</label><select id="m-year"></select></div>
    <div class="field" id="m-section-field"><label>Section</label><select id="m-section"></select></div>
    ${!isEdit ? `<div class="field"><label>Temporary password</label><input id="m-password" type="text" placeholder="min. 6 characters"></div>` : ''}
    <div class="field-error" id="m-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: isEdit ? 'Save changes' : 'Create user', className: 'btn-sm btn-dark', onClick: () => submitUser(id, role) }
  ]);
  toggleUserModalYearSectionFields(isEdit ? role : 'student'); // 'student' matches m-role's default selection in add-mode

  const dropdownsReady = wireAcademicDropdowns({
    deptEl: document.getElementById('m-dept'),
    yearEl: document.getElementById('m-year'),
    sectionEl: document.getElementById('m-section')
  });

  if (isEdit) {
    const userReady = api('/api/admin/users?pageSize=100').then(data => data.rows.find(r => r.id === id));
    Promise.all([dropdownsReady, userReady]).then(([, u]) => {
      if (!u) return;
      document.getElementById('m-userid').value = u.user_id;
      document.getElementById('m-name').value = u.name;
      document.getElementById('m-email').value = u.email || '';
      document.getElementById('m-dept').value = u.department || '';
      if (role === 'student') {
        document.getElementById('m-year').value = u.year_of_study || '';
        document.getElementById('m-year').dispatchEvent(new Event('change')); // repopulates Section options for this dept+year
        document.getElementById('m-section').value = u.section || '';
      }
    });
  }
}
async function submitUser(id, role) {
  const errEl = document.getElementById('m-error');
  errEl.classList.remove('show');
  const effectiveRole = id ? role : document.getElementById('m-role').value;
  const payload = {
    user_id: document.getElementById('m-userid').value.trim(),
    name: document.getElementById('m-name').value.trim(),
    email: document.getElementById('m-email').value.trim(),
    department: document.getElementById('m-dept').value.trim(),
  };
  if (effectiveRole === 'student') {
    payload.year_of_study = document.getElementById('m-year').value.trim();
    payload.section = document.getElementById('m-section').value.trim();
  }
  try {
    if (id) {
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: payload });
      showToast('User updated');
    } else {
      payload.role = effectiveRole;
      payload.password = document.getElementById('m-password').value;
      if (!payload.user_id || !payload.name || !payload.password || payload.password.length < 6) {
        errEl.textContent = 'ID, name and a password of at least 6 characters are required.';
        errEl.classList.add('show');
        return;
      }
      if (effectiveRole === 'student' && (!payload.department || !payload.year_of_study || !payload.section)) {
        errEl.textContent = 'Department, Academic Year and Section are required for a student.';
        errEl.classList.add('show');
        return;
      }
      if (effectiveRole === 'faculty' && !payload.department) {
        errEl.textContent = 'Department is required for faculty.';
        errEl.classList.add('show');
        return;
      }
      await api('/api/admin/users', { method: 'POST', body: payload });
      showToast('User created');
    }
    closeModal();
    rerenderPeople('users');
  } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
}
async function disableUser(id) {
  confirmDialog('Disable this user? They will no longer be able to log in.', async () => {
    try { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); showToast('User disabled'); rerenderPeople('users'); }
    catch (e) { showToast(e.message, 'error'); }
  });
}
async function resetPassword(id) {
  try {
    const data = await api(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
    openModal('Password reset', `<p style="font-size:13.5px;">New temporary password:</p><p class="mono" style="font-size:16px;font-weight:700;background:var(--paper);padding:10px 14px;border-radius:8px;">${data.temporaryPassword}</p><p style="font-size:12px;color:var(--slate);">Share this with the user securely — it will not be shown again.</p>`, [
      { label: 'Done', className: 'btn-sm btn-dark', onClick: closeModal }
    ]);
  } catch (e) { showToast(e.message, 'error'); }
}
function adminResetTwoFa(id, userLabel) {
  confirmDialog(`Reset 2FA for ${escapeHtml(userLabel)}? They will be able to log in with just their password again, and can re-enroll 2FA afterward.`, async () => {
    try {
      await api(`/api/admin/users/${id}/2fa/reset`, { method: 'POST' });
      showToast('2FA reset for ' + userLabel);
      rerenderPeople('users');
    } catch (e) { showToast(e.message, 'error'); }
  });
}

function openCourseModal(id) {
  openModal(id ? 'Edit course' : 'Add course', `
    <div class="field"><label>Course code</label><input id="c-code" ${id ? 'disabled' : ''} placeholder="e.g. CS306"></div>
    <div class="field"><label>Course name</label><input id="c-name" placeholder="e.g. Cloud Computing"></div>
    <div class="field"><label>Department</label><input id="c-dept" placeholder="e.g. CSE"></div>
    <div class="field"><label>Academic Year</label><input id="c-acadyear" placeholder="e.g. 2026-27"></div>
    <div class="field"><label>Year / Semester</label><input id="c-semester" type="number" min="1" max="12" placeholder="e.g. 5"></div>
    <div class="field"><label>Section</label><input id="c-section" placeholder="e.g. III CSE - B"></div>
    <div class="field"><label>Faculty</label><select id="c-faculty"><option value="">Unassigned</option></select></div>
    ${id ? `<div class="field"><label>Status</label><select id="c-status"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>` : ''}
    <div class="field-error" id="c-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: id ? 'Save changes' : 'Create course', className: 'btn-sm btn-dark', onClick: () => submitCourse(id) }
  ]);
  api('/api/admin/faculty-list').then(data => {
    const sel = document.getElementById('c-faculty');
    data.rows.forEach(f => { const o = document.createElement('option'); o.value = f.id; o.textContent = `${f.name} (${f.employee_id})`; sel.appendChild(o); });
    if (id) {
      api('/api/admin/courses').then(cd => {
        const c = cd.rows.find(r => r.id === id);
        if (c) {
          document.getElementById('c-code').value = c.course_code;
          document.getElementById('c-name').value = c.course_name;
          document.getElementById('c-dept').value = c.department || '';
          document.getElementById('c-acadyear').value = c.academic_year || '';
          document.getElementById('c-semester').value = c.semester || '';
          document.getElementById('c-section').value = c.section || '';
          sel.value = c.faculty_id || '';
          document.getElementById('c-status').value = c.status || 'active';
        }
      });
    }
  });
}
async function submitCourse(id) {
  const errEl = document.getElementById('c-error');
  errEl.classList.remove('show');
  const payload = {
    course_name: document.getElementById('c-name').value.trim(),
    department: document.getElementById('c-dept').value.trim(),
    academic_year: document.getElementById('c-acadyear').value.trim(),
    semester: document.getElementById('c-semester').value ? Number(document.getElementById('c-semester').value) : null,
    section: document.getElementById('c-section').value.trim(),
    faculty_id: document.getElementById('c-faculty').value || null,
  };
  try {
    if (id) {
      payload.status = document.getElementById('c-status').value;
      await api(`/api/admin/courses/${id}`, { method: 'PUT', body: payload });
      showToast('Course updated');
    } else {
      payload.course_code = document.getElementById('c-code').value.trim();
      if (!payload.course_code || !payload.course_name) { errEl.textContent = 'Course code and name are required.'; errEl.classList.add('show'); return; }
      await api('/api/admin/courses', { method: 'POST', body: payload });
      showToast('Course created');
    }
    closeModal();
    rerenderPeople('courses');
  } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
}
async function deactivateCourse(id) {
  confirmDialog('Deactivate this course? It will be hidden from faculty and student views.', async () => {
    try { await api(`/api/admin/courses/${id}`, { method: 'DELETE' }); showToast('Course deactivated'); rerenderPeople('courses'); }
    catch (e) { showToast(e.message, 'error'); }
  });
}

/* ================= ADMIN: TIMETABLE + SETTINGS ================= */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIOD_LABELS = { class: 'Class', break: 'Break', study: 'Study', lunch: 'Lunch' };

const ADMIN_SCHEDULE_TABS_HTML = (active) => `
  <div class="tabs">
    <button class="tab-btn ${active === 'timetable' ? 'active' : ''}" id="tab-timetable">Timetable</button>
    <button class="tab-btn ${active === 'holidays' ? 'active' : ''}" id="tab-holidays">Holidays</button>
    <button class="tab-btn ${active === 'settings' ? 'active' : ''}" id="tab-settings">Settings</button>
  </div>`;

async function adminSchedule(tab = 'timetable', scheduleFilter = {}) {
  setTimeout(() => {
    document.getElementById('tab-timetable')?.addEventListener('click', () => rerenderSchedule('timetable'));
    document.getElementById('tab-holidays')?.addEventListener('click', () => rerenderSchedule('holidays'));
    document.getElementById('tab-settings')?.addEventListener('click', () => rerenderSchedule('settings'));
    const filterForm = document.getElementById('tt-filter-form');
    if (filterForm) filterForm.onsubmit = (e) => {
      e.preventDefault();
      rerenderSchedule('timetable', { department: document.getElementById('tt-dept').value, section: document.getElementById('tt-section').value });
    };
    const locForm = document.getElementById('loc-settings-form');
    if (locForm) locForm.onsubmit = (e) => { e.preventDefault(); submitLocationSettings(); };
  }, 0);

  if (tab === 'holidays') return ADMIN_SCHEDULE_TABS_HTML('holidays') + await adminHolidaysTab();

  if (tab === 'settings') {
    const { location_config } = await api('/api/admin/settings');
    return ADMIN_SCHEDULE_TABS_HTML('settings') + `
    <div class="card">
      <h3>College / classroom location</h3>
      <p class="cap">Used as the default GPS anchor for every automatically created attendance session.</p>
      <form id="loc-settings-form">
        <div class="field"><label>Latitude</label><input id="loc-lat" type="number" step="any" value="${location_config ? location_config.lat : ''}" placeholder="e.g. 13.0827"></div>
        <div class="field"><label>Longitude</label><input id="loc-lng" type="number" step="any" value="${location_config ? location_config.lng : ''}" placeholder="e.g. 80.2707"></div>
        <div class="field"><label>Allowed radius (meters)</label><input id="loc-radius" type="number" value="${location_config ? location_config.radius_m : 100}" placeholder="100"></div>
        <div class="field-error" id="loc-error"></div>
        <button class="btn-sm btn-dark" type="submit">Save location</button>
      </form>
    </div>`;
  }

  const params = new URLSearchParams(scheduleFilter);
  const { rows } = await api('/api/admin/timetable' + (params.toString() ? '?' + params.toString() : ''));
  return ADMIN_SCHEDULE_TABS_HTML('timetable') + `
  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
      <p class="cap" style="margin:0;">${rows.length} slots</p>
      <button class="btn-sm btn-dark" onclick="openTimetableModal()">+ Add slot</button>
    </div>
    <form id="tt-filter-form" class="table-controls">
      <input class="search-input" id="tt-dept" placeholder="Department, e.g. CSE" value="${escapeHtml(scheduleFilter.department || '')}">
      <input class="search-input" id="tt-section" placeholder="Section, e.g. III CSE - B" value="${escapeHtml(scheduleFilter.section || '')}">
      <button class="btn-sm btn-dark" type="submit">Filter</button>
    </form>
    <table>
      <thead><tr><th>Day</th><th>Time</th><th>Department</th><th>Section</th><th>Period</th><th></th></tr></thead>
      <tbody>${rows.map(t => `<tr class="rowhover">
        <td>${DAY_NAMES[t.day_of_week]}</td>
        <td class="mono">${t.start_time}–${t.end_time}</td>
        <td>${escapeHtml(t.department)}</td>
        <td>${escapeHtml(t.section)}</td>
        <td>${t.period_type === 'class' ? escapeHtml(t.course_name || '—') : `${PERIOD_LABELS[t.period_type]}${t.label ? ' · ' + escapeHtml(t.label) : ''}`}</td>
        <td class="inline-actions">
          <button class="btn-sm" onclick="openTimetableModal(${t.id})">Edit</button>
          <button class="btn-sm btn-danger" onclick="deleteTimetableSlot(${t.id})">Delete</button>
        </td></tr>`).join('')}</tbody>
    </table>
  </div>`;
}
async function rerenderSchedule(tab, scheduleFilter = {}) {
  document.getElementById('page-content').innerHTML = await adminSchedule(tab, scheduleFilter);
}

/* ---- Feature: Holiday Calendar ---- */
function fmtHolidayDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
async function adminHolidaysTab() {
  const { rows } = await api('/api/holidays');
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows.filter(h => h.holiday_date >= today);
  const previous = rows.filter(h => h.holiday_date < today).reverse();
  const holidayRow = (h) => `<tr class="rowhover">
    <td class="mono">${fmtHolidayDate(h.holiday_date)}</td>
    <td>${escapeHtml(h.name)}</td>
    <td style="color:var(--slate);font-size:12.5px;">${escapeHtml(h.description || '—')}</td>
    <td class="inline-actions">
      <button class="btn-sm" onclick="openHolidayModal(${h.id})">Edit</button>
      <button class="btn-sm btn-danger" onclick="deleteHoliday(${h.id})">Delete</button>
    </td></tr>`;
  return `
  <div class="card" style="margin-bottom:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:10px;">
      <div><h3 style="margin-bottom:2px;">Upcoming holidays</h3><p class="cap" style="margin:0;">${upcoming.length} upcoming</p></div>
      <button class="btn-sm btn-dark" onclick="openHolidayModal()">+ Add holiday</button>
    </div>
    ${upcoming.length ? `<table><thead><tr><th>Date</th><th>Holiday</th><th>Description</th><th></th></tr></thead><tbody>${upcoming.map(holidayRow).join('')}</tbody></table>`
      : '<div class="empty-note">No upcoming holidays scheduled.</div>'}
  </div>
  <div class="card">
    <h3>Previous holidays</h3>
    <p class="cap">${previous.length} recorded</p>
    ${previous.length ? `<table><thead><tr><th>Date</th><th>Holiday</th><th>Description</th><th></th></tr></thead><tbody>${previous.map(holidayRow).join('')}</tbody></table>`
      : '<div class="empty-note">No past holidays recorded yet.</div>'}
  </div>`;
}
function openHolidayModal(id) {
  const isEdit = !!id;
  openModal(isEdit ? 'Edit holiday' : 'Add holiday', `
    <div class="field"><label>Date</label><input id="h-m-date" type="date"></div>
    <div class="field"><label>Holiday name</label><input id="h-m-name" placeholder="e.g. Independence Day"></div>
    <div class="field"><label>Description (optional)</label><input id="h-m-desc" placeholder="e.g. National holiday"></div>
    <div class="field-error" id="h-m-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: isEdit ? 'Save changes' : 'Add holiday', className: 'btn-sm btn-dark', onClick: () => submitHoliday(id) }
  ]);
  if (isEdit) {
    api('/api/holidays').then(({ rows }) => {
      const h = rows.find(r => r.id === id);
      if (h) {
        document.getElementById('h-m-date').value = h.holiday_date;
        document.getElementById('h-m-name').value = h.name;
        document.getElementById('h-m-desc').value = h.description || '';
      }
    });
  }
}
async function submitHoliday(id) {
  const errEl = document.getElementById('h-m-error');
  errEl.textContent = '';
  const holiday_date = document.getElementById('h-m-date').value;
  const name = document.getElementById('h-m-name').value.trim();
  const description = document.getElementById('h-m-desc').value.trim();
  if (!holiday_date || !name) { errEl.textContent = 'Date and holiday name are required.'; return; }
  try {
    if (id) await api(`/api/holidays/${id}`, { method: 'PUT', body: { holiday_date, name, description } });
    else await api('/api/holidays', { method: 'POST', body: { holiday_date, name, description } });
    closeModal();
    showToast(id ? 'Holiday updated' : 'Holiday added');
    rerenderSchedule('holidays');
  } catch (e) { errEl.textContent = e.message; }
}
function deleteHoliday(id) {
  confirmDialog('Delete this holiday? Any existing attendance sessions on that date are not affected.', async () => {
    try {
      await api(`/api/holidays/${id}`, { method: 'DELETE' });
      showToast('Holiday deleted');
      rerenderSchedule('holidays');
    } catch (e) { showToast(e.message, 'error'); }
  });
}

function openTimetableModal(id) {
  openModal(id ? 'Edit timetable slot' : 'Add timetable slot', `
    <div class="field"><label>Department</label><input id="tt-m-dept" placeholder="e.g. CSE"></div>
    <div class="field"><label>Section</label><input id="tt-m-section" placeholder="e.g. III CSE - B"></div>
    <div class="field"><label>Day of week</label><select id="tt-m-day">${DAY_NAMES.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></div>
    <div class="field"><label>Start time</label><input id="tt-m-start" type="time"></div>
    <div class="field"><label>End time</label><input id="tt-m-end" type="time"></div>
    <div class="field"><label>Period type</label><select id="tt-m-type" onchange="document.getElementById('tt-m-course-field').style.display = this.value==='class' ? '' : 'none'; document.getElementById('tt-m-label-field').style.display = this.value==='class' ? 'none' : '';">
      <option value="class">Class</option><option value="break">Break</option><option value="study">Study</option><option value="lunch">Lunch</option>
    </select></div>
    <div class="field" id="tt-m-course-field"><label>Course</label><select id="tt-m-course"></select></div>
    <div class="field" id="tt-m-label-field" style="display:none;"><label>Label</label><input id="tt-m-label" placeholder="e.g. Study, Lunch Break"></div>
    <div class="field-error" id="tt-m-error"></div>
  `, [
    { label: 'Cancel', className: 'btn-sm', onClick: closeModal },
    { label: id ? 'Save changes' : 'Create slot', className: 'btn-sm btn-dark', onClick: () => submitTimetableSlot(id) }
  ]);
  document.getElementById('tt-m-course-field').style.display = '';
  document.getElementById('tt-m-label-field').style.display = 'none';
  api('/api/admin/courses').then(cd => {
    const sel = document.getElementById('tt-m-course');
    cd.rows.filter(c => c.status === 'active').forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = `${c.course_name} (${c.course_code})`; sel.appendChild(o); });
    if (id) {
      api('/api/admin/timetable').then(td => {
        const t = td.rows.find(r => r.id === id);
        if (t) {
          document.getElementById('tt-m-dept').value = t.department;
          document.getElementById('tt-m-section').value = t.section;
          document.getElementById('tt-m-day').value = t.day_of_week;
          document.getElementById('tt-m-start').value = t.start_time;
          document.getElementById('tt-m-end').value = t.end_time;
          document.getElementById('tt-m-type').value = t.period_type;
          document.getElementById('tt-m-course-field').style.display = t.period_type === 'class' ? '' : 'none';
          document.getElementById('tt-m-label-field').style.display = t.period_type === 'class' ? 'none' : '';
          if (t.course_id) sel.value = t.course_id;
          document.getElementById('tt-m-label').value = t.label || '';
        }
      });
    }
  });
}
async function submitTimetableSlot(id) {
  const errEl = document.getElementById('tt-m-error');
  errEl.classList.remove('show');
  const period_type = document.getElementById('tt-m-type').value;
  const payload = {
    department: document.getElementById('tt-m-dept').value.trim(),
    section: document.getElementById('tt-m-section').value.trim(),
    day_of_week: Number(document.getElementById('tt-m-day').value),
    start_time: document.getElementById('tt-m-start').value,
    end_time: document.getElementById('tt-m-end').value,
    period_type,
    course_id: period_type === 'class' ? (document.getElementById('tt-m-course').value || null) : null,
    label: period_type !== 'class' ? document.getElementById('tt-m-label').value.trim() : null,
  };
  if (!payload.department || !payload.section || !payload.start_time || !payload.end_time) {
    errEl.textContent = 'Department, section, start time and end time are required.';
    errEl.classList.add('show');
    return;
  }
  if (period_type === 'class' && !payload.course_id) {
    errEl.textContent = 'A course is required for a class period.';
    errEl.classList.add('show');
    return;
  }
  try {
    if (id) await api(`/api/admin/timetable/${id}`, { method: 'PUT', body: payload });
    else await api('/api/admin/timetable', { method: 'POST', body: payload });
    showToast(id ? 'Slot updated' : 'Slot created');
    closeModal();
    rerenderSchedule('timetable');
  } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
}
async function deleteTimetableSlot(id) {
  confirmDialog('Delete this timetable slot?', async () => {
    try { await api(`/api/admin/timetable/${id}`, { method: 'DELETE' }); showToast('Slot deleted'); rerenderSchedule('timetable'); }
    catch (e) { showToast(e.message, 'error'); }
  });
}
async function submitLocationSettings() {
  const errEl = document.getElementById('loc-error');
  errEl.classList.remove('show');
  const lat = Number(document.getElementById('loc-lat').value);
  const lng = Number(document.getElementById('loc-lng').value);
  const radius_m = Number(document.getElementById('loc-radius').value) || 100;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    errEl.textContent = 'Latitude and longitude are required.';
    errEl.classList.add('show');
    return;
  }
  try {
    await api('/api/admin/settings/location', { method: 'PUT', body: { lat, lng, radius_m } });
    showToast('Location settings saved');
  } catch (e) { errEl.textContent = e.message; errEl.classList.add('show'); }
}

/* ==========================================================================
   ADMIN — Advanced Reporting / Weekly Reports / Risk (Feature 1, 2, 3)
   All three live as tabs on the existing "Analytics" page rather than new
   sidebar items. Overview tab below is the original, unchanged content.
   ========================================================================== */
function riskLevelBadge(level) {
  const lvl = (level || 'low').toLowerCase();
  return `<span class="badge risk-badge ${lvl}"><span class="dot"></span>${lvl.toUpperCase()}</span>`;
}
function weekTrendBadge(trend) {
  if (trend === 'up') return '<span class="badge green"><span class="dot"></span>▲ Up vs last week</span>';
  if (trend === 'down') return '<span class="badge red"><span class="dot"></span>▼ Down vs last week</span>';
  if (trend === 'flat') return '<span class="badge slate">— Flat vs last week</span>';
  return '<span class="badge slate">No prior-week data yet</span>';
}
function twoColTable(title, capText, rows, valueLabel) {
  return `<div class="card">
    <h3>${title}</h3>
    <p class="cap">${capText}</p>
    ${rows.length ? `<table><thead><tr><th>Name</th><th>${valueLabel}</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="rowhover"><td>${escapeHtml(r.label)}${r.roll_number ? ` <span class="mono" style="color:var(--slate-dim);font-size:11px;">${escapeHtml(r.roll_number)}</span>` : ''}</td><td>${statusBadge(r.pct >= 75 ? 'present' : r.pct >= 65 ? 'late' : 'absent')} <span class="mono">${r.pct}%</span></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-note">No data for the current filters.</div>'}
  </div>`;
}

async function loadAdminFilterMeta() {
  const [depts, courses, faculty, students] = await Promise.all([
    api('/api/admin/departments'),
    api('/api/admin/courses'),
    api('/api/admin/faculty-list'),
    api('/api/admin/students-list')
  ]);
  return { departments: depts.rows, courses: courses.rows.filter(c => c.status === 'active'), faculty: faculty.rows, students: students.rows };
}

function filterSelectsHtml(meta, filters, p) {
  return `
  <select class="select-input" id="${p}-department"><option value="">All departments</option>${meta.departments.map(d => `<option ${filters.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
  <select class="select-input" id="${p}-course"><option value="">All courses</option>${meta.courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
  <select class="select-input" id="${p}-faculty"><option value="">All faculty</option>${meta.faculty.map(f => `<option value="${f.id}" ${filters.faculty_id == f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}</select>
  <select class="select-input" id="${p}-student"><option value="">All students</option>${meta.students.map(s => `<option value="${s.id}" ${filters.student_id == s.id ? 'selected' : ''}>${escapeHtml(s.roll_number)} — ${escapeHtml(s.name)}</option>`).join('')}</select>`;
}
function readFilterSelects(p) {
  return {
    department: document.getElementById(`${p}-department`)?.value || '',
    course_id: document.getElementById(`${p}-course`)?.value || '',
    faculty_id: document.getElementById(`${p}-faculty`)?.value || '',
    student_id: document.getElementById(`${p}-student`)?.value || '',
  };
}

const ADMIN_ANALYTICS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'reports', label: 'Reports' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'risk', label: 'Risk' },
  { id: 'predictions', label: 'Predictions' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'lms', label: 'LMS Integration' },
];
async function adminAnalytics(tab = 'overview', filters = {}, page = 1) {
  const tabsHtml = `<div class="tabs">${ADMIN_ANALYTICS_TABS.map(t => `<button class="tab-btn ${t.id === tab ? 'active' : ''}" id="aa-tab-${t.id}">${t.label}</button>`).join('')}</div>`;
  let body;
  if (tab === 'reports') body = await adminReportsTab(filters);
  else if (tab === 'weekly') body = await adminWeeklyTab(filters);
  else if (tab === 'risk') body = await adminRiskTab(filters, page);
  else if (tab === 'predictions') body = await adminPredictionsTab(filters);
  else if (tab === 'compliance') body = await adminComplianceTab();
  else if (tab === 'lms') body = await adminLmsTab();
  else body = await adminAnalyticsOverview(page);
  return tabsHtml + body;
}
function wireAdminAnalyticsEvents(tab, filters) {
  ADMIN_ANALYTICS_TABS.forEach(t => document.getElementById(`aa-tab-${t.id}`)?.addEventListener('click', () => rerenderAdminAnalytics(t.id)));
  const rf = document.getElementById('rf-form'); if (rf) rf.onsubmit = (e) => { e.preventDefault(); applyAdminReportFilters(); };
  const wf = document.getElementById('wf-form'); if (wf) wf.onsubmit = (e) => { e.preventDefault(); applyAdminWeeklyFilters(); };
  const kf = document.getElementById('kf-form'); if (kf) kf.onsubmit = (e) => { e.preventDefault(); applyAdminRiskFilters(); };
  const pf = document.getElementById('apf-form'); if (pf) pf.onsubmit = (e) => { e.preventDefault(); applyAdminPredictionsFilters(); };
  wireAdminReportTrendTabs();
}
async function rerenderAdminAnalytics(tab, filters = {}, page = 1) {
  const c = document.getElementById('page-content');
  c.innerHTML = `<div class="tabs">${ADMIN_ANALYTICS_TABS.map(t => `<button class="tab-btn ${t.id === tab ? 'active' : ''}">${t.label}</button>`).join('')}</div>${skeletonBlock(50)}${skeletonBlock(50)}`;
  c.innerHTML = await adminAnalytics(tab, filters, page);
  wireAdminAnalyticsEvents(tab, filters);
}
async function applyAdminReportFilters() {
  const f = readFilterSelects('rf');
  f.from = document.getElementById('rf-from').value; f.to = document.getElementById('rf-to').value;
  f.status = document.getElementById('rf-status').value;
  Object.keys(f).forEach(k => !f[k] && delete f[k]);
  rerenderAdminAnalytics('reports', f);
}
async function applyAdminWeeklyFilters(week) {
  const f = readFilterSelects('wf');
  Object.keys(f).forEach(k => !f[k] && delete f[k]);
  if (week) f.week = week; else { const w = document.getElementById('wf-week')?.value; if (w) f.week = w; }
  rerenderAdminAnalytics('weekly', f);
}
async function applyAdminRiskFilters(page = 1) {
  const f = {
    department: document.getElementById('kf-department')?.value || '',
    course_id: document.getElementById('kf-course')?.value || '',
    student_id: document.getElementById('kf-student')?.value || '',
    level: document.getElementById('kf-level')?.value || '',
    method: document.getElementById('kf-method')?.value || '',
    from: document.getElementById('kf-from')?.value || '',
    to: document.getElementById('kf-to')?.value || '',
  };
  Object.keys(f).forEach(k => !f[k] && delete f[k]);
  rerenderAdminAnalytics('risk', f, page);
}
async function applyAdminPredictionsFilters() {
  const f = { department: document.getElementById('apf-department')?.value || '' };
  Object.keys(f).forEach(k => !f[k] && delete f[k]);
  rerenderAdminAnalytics('predictions', f);
}

/* ==========================================================================
   Feature: LMS Integration — admin-only (enforced server-side). The Mock
   provider is honestly labeled as such throughout; nothing here claims a real
   Moodle/Canvas/etc connection unless LMS_PROVIDER/LMS_BASE_URL/LMS_API_KEY
   are all configured server-side.
   ========================================================================== */
function lmsSyncStatusBadge(status) {
  if (status === 'success') return `<span class="badge green"><span class="dot"></span>Success</span>`;
  if (status === 'partial') return `<span class="badge amber"><span class="dot"></span>Partial</span>`;
  if (status === 'running') return `<span class="badge slate">Running</span>`;
  return `<span class="badge red"><span class="dot"></span>Failed</span>`;
}
function fmtLmsTime(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString();
}
async function adminLmsTab() {
  const [status, { rows: logs }] = await Promise.all([
    api('/api/admin/lms/status'),
    api('/api/admin/lms/logs?limit=15')
  ]);
  return `
  <div class="demo-disclaimer" style="margin-bottom:18px;">
    <b>${status.isMock ? 'Demo / Mock LMS' : `Provider: ${escapeHtml(status.provider)}`}</b> — ${status.isMock
      ? 'This connects to a built-in simulated course catalog for demonstration only. It is not a live Moodle, Canvas, or Blackboard connection. Configure LMS_PROVIDER, LMS_BASE_URL and LMS_API_KEY server-side to connect a real provider.'
      : 'A real LMS provider is configured. Connection attempts are real network calls to the configured base URL.'}
  </div>
  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Connection status</div><div class="kpi-value" style="font-size:20px;">${status.status === 'connected' ? '🟢 Connected' : status.status === 'error' ? '🔴 Error' : '⚪ Not tested'}</div></div>
    <div class="card kpi"><div class="kpi-label">Courses synced</div><div class="kpi-value">${status.coursesSynced}</div></div>
    <div class="card kpi"><div class="kpi-label">Students synced</div><div class="kpi-value">${status.studentsSynced}</div></div>
    <div class="card kpi"><div class="kpi-label">Attendance records synced</div><div class="kpi-value">${status.attendanceSynced}</div></div>
  </div>
  <div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:14px; margin-bottom:16px;">
      <div style="display:flex; flex-direction:column; gap:6px; font-size:12.5px; color:var(--slate);">
        <div>Last successful sync: <span class="mono">${fmtLmsTime(status.lastSyncAt)}</span></div>
        <div>Last sync attempt: <span class="mono">${fmtLmsTime(status.lastAttemptAt)}</span></div>
        <div>Last connection test: <span class="mono">${fmtLmsTime(status.lastTestAt)}</span> ${status.lastTestResult ? (status.lastTestResult === 'success' ? '<span class="badge green">✓</span>' : '<span class="badge red">✗</span>') : ''}</div>
      </div>
    </div>
    <div id="lms-action-msg" style="margin-bottom:12px;"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn-sm btn-dark" id="lms-btn-test" onclick="lmsAction('test-connection', this)">Test Connection</button>
      <button class="btn-sm" id="lms-btn-courses" onclick="lmsAction('sync/courses', this)">Sync Courses</button>
      <button class="btn-sm" id="lms-btn-enroll" onclick="lmsAction('sync/enrollments', this)">Sync Enrollments</button>
      <button class="btn-sm" id="lms-btn-attendance" onclick="lmsAction('sync/attendance', this)">Sync Attendance</button>
      <button class="btn-sm btn-verify" id="lms-btn-all" onclick="lmsAction('sync/all', this)">Sync All</button>
    </div>
  </div>
  <div class="card" style="margin-top:18px;">
    <h3>Sync history</h3>
    <p class="cap">Most recent attempts, newest first</p>
    ${logs.length ? `<table>
      <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Processed</th><th>Succeeded</th><th>Failed</th><th>Notes</th></tr></thead>
      <tbody>${logs.map(l => `<tr class="rowhover">
        <td class="mono">${l.started_at}</td>
        <td>${escapeHtml(l.sync_type)}</td>
        <td>${lmsSyncStatusBadge(l.status)}</td>
        <td>${l.records_processed}</td>
        <td>${l.records_succeeded}</td>
        <td>${l.records_failed}</td>
        <td style="font-size:11.5px;color:var(--slate);max-width:260px;">${l.error_summary ? escapeHtml(l.error_summary) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No sync attempts yet — try Test Connection.</div>'}
  </div>`;
}
async function lmsAction(path, btn) {
  const allButtons = document.querySelectorAll('#lms-btn-test,#lms-btn-courses,#lms-btn-enroll,#lms-btn-attendance,#lms-btn-all');
  allButtons.forEach(b => b.disabled = true);
  const originalText = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>Working…';
  const msgEl = document.getElementById('lms-action-msg');
  msgEl.innerHTML = '';
  try {
    const result = await api(`/api/admin/lms/${path}`, { method: 'POST' });
    if (path === 'test-connection') {
      msgEl.innerHTML = `<div class="${result.ok ? 'badge green' : 'badge red'}" style="padding:8px 12px;">${escapeHtml(result.message)}</div>`;
    } else if (path === 'sync/all') {
      const parts = ['courses', 'enrollments', 'attendance'].map(k => `${k}: ${result[k].succeeded ?? result[k].processed ?? 0} ok${result[k].failed ? ', ' + result[k].failed + ' failed' : ''}`);
      msgEl.innerHTML = `<div class="badge green" style="padding:8px 12px;">Sync all complete — ${parts.join(' · ')}</div>`;
    } else {
      msgEl.innerHTML = `<div class="badge ${result.failed ? 'amber' : 'green'}" style="padding:8px 12px;">Processed ${result.processed}, ${result.succeeded} succeeded${result.failed ? ', ' + result.failed + ' failed' : ''}.</div>`;
    }
    showToast('LMS action complete');
  } catch (e) {
    msgEl.innerHTML = `<div class="badge red" style="padding:8px 12px;">${escapeHtml(e.message)}</div>`;
    showToast(e.message, 'error');
  } finally {
    rerenderAdminAnalytics('lms');
  }
}

/* ---- Overview (original content, unchanged) ---- */
async function adminAnalyticsOverview(auditPage = 1) {
  const [proxy, dash, audit] = await Promise.all([
    api('/api/admin/analytics/proxy'),
    api('/api/admin/dashboard'),
    api('/api/admin/audit-logs?page=' + auditPage + '&pageSize=8')
  ]);
  const totalPages = Math.max(1, Math.ceil(audit.total / audit.pageSize));
  return `
  <div class="grid g-2">
    <div class="card">
      <h3>Attendance Anomaly Detection</h3>
      <p class="cap">Rule-based checks — duplicate attempts &amp; expired QR use, last 30 days</p>
      <div class="ring-wrap">
        ${ringSVG(proxy.cleanPct, 'var(--verify)')}
        <div>
          <div style="font-size:13px;color:var(--slate);margin-bottom:6px;">${proxy.flagged} attempt${proxy.flagged === 1 ? '' : 's'} flagged this month</div>
          <div class="badge ${proxy.flagged <= proxy.prevFlagged ? 'green' : 'amber'}"><span class="dot"></span>${proxy.prevFlagged ? (proxy.flagged <= proxy.prevFlagged ? '↓' : '↑') + ' vs last month (' + proxy.prevFlagged + ')' : 'baseline period'}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Department comparison</h3>
      <p class="cap">Attendance % by department</p>
      ${barRows(dash.deptComparison)}
    </div>
  </div>
  <div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
      <div><h3 style="margin-bottom:2px;">Institution trend</h3><p class="cap" style="margin:0;">Weekly average, all departments</p></div>
      <div style="display:flex; gap:8px;">
        <button class="btn-sm" onclick="downloadFile('/api/admin/export/excel','institution_attendance.xlsx')">Export Excel</button>
        <button class="btn-sm" onclick="downloadFile('/api/admin/export/pdf','institution_report.pdf')">Export PDF</button>
      </div>
    </div>
    ${lineChartSVG(dash.trend, dash.trendLabels, 'var(--ink)')}
  </div>
  <div class="card" style="margin-top:18px;">
    <h3>Audit trail</h3>
    <p class="cap">Who changed what, and when</p>
    ${audit.rows.length ? `<table>
      <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
      <tbody>${audit.rows.map(a => `<tr class="rowhover"><td class="mono">${a.timestamp}</td><td>${escapeHtml(a.user_name || 'System')}</td><td>${escapeHtml(a.action)}</td><td class="mono">${escapeHtml(a.entity || '—')}${a.entity_id ? ' #' + a.entity_id : ''}</td></tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No audit events yet.</div>'}
    <div class="pagination">
      <span>Page ${audit.page} of ${totalPages}</span>
      <button ${audit.page <= 1 ? 'disabled' : ''} onclick="rerenderAdminAnalytics('overview', {}, ${audit.page - 1})">Prev</button>
      <button ${audit.page >= totalPages ? 'disabled' : ''} onclick="rerenderAdminAnalytics('overview', {}, ${audit.page + 1})">Next</button>
    </div>
  </div>`;
}

/* ---- Feature 1: Advanced Reporting Dashboard ---- */
async function adminReportsTab(filters = {}) {
  const [meta, report] = await Promise.all([loadAdminFilterMeta(), api('/api/admin/reports/advanced' + qs(filters))]);
  window.__adminReport = report;
  const t = report.totals, e = report.entityCounts;
  return `
  <form id="rf-form" class="table-controls" style="margin-bottom:18px;">
    ${filterSelectsHtml(meta, filters, 'rf')}
    <select class="select-input" id="rf-status"><option value="">All statuses</option>
      <option value="present" ${filters.status === 'present' ? 'selected' : ''}>Present</option>
      <option value="absent" ${filters.status === 'absent' ? 'selected' : ''}>Absent</option>
      <option value="late" ${filters.status === 'late' ? 'selected' : ''}>Late</option>
    </select>
    <input type="date" class="select-input" id="rf-from" value="${filters.from || ''}">
    <input type="date" class="select-input" id="rf-to" value="${filters.to || ''}">
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
    <div style="flex:1;"></div>
    <button type="button" class="btn-sm" onclick="downloadFile('/api/admin/export/excel${qs(filters)}','institution_attendance.xlsx')">Export Excel</button>
    <button type="button" class="btn-sm" onclick="downloadFile('/api/admin/export/pdf${qs(filters)}','institution_report.pdf')">Export PDF</button>
  </form>

  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Overall attendance</div><div class="kpi-value">${t.overallPct}%</div><div class="kpi-delta ${t.overallPct >= 75 ? 'up' : 'down'} mono">${t.totalRecords} records</div></div>
    <div class="card kpi"><div class="kpi-label">Total students</div><div class="kpi-value">${e.totalStudents}</div><div class="kpi-delta up mono">${e.totalFaculty} faculty</div></div>
    <div class="card kpi"><div class="kpi-label">Total courses</div><div class="kpi-value">${e.totalCourses}</div><div class="kpi-delta up mono">${t.totalSessions} sessions</div></div>
    <div class="card kpi"><div class="kpi-label">Present / Absent / Late</div><div class="kpi-value" style="font-size:22px;">${t.presentCount} / ${t.absentCount} / ${t.lateCount}</div><div class="kpi-delta mono">excused: not tracked</div></div>
  </div>

  <div class="grid g-2" style="margin-top:18px;">
    <div class="card">
      <h3>Department-wise attendance</h3>
      <p class="cap">Current filters</p>
      ${barRows(report.departmentWise.map(d => ({ name: d.label, pct: d.pct })))}
    </div>
    <div class="card">
      <h3>Course-wise attendance</h3>
      <p class="cap">Current filters</p>
      ${barRows(report.courseWise.map(c => ({ name: c.label, pct: c.pct })))}
    </div>
  </div>

  <div class="card" style="margin-top:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:10px;">
      <div><h3 style="margin-bottom:2px;">Attendance trend</h3><p class="cap" style="margin:0;">Current filters</p></div>
      <div class="tabs" style="margin:0; border:none;" id="rf-trend-tabs">
        <button class="tab-btn active" data-g="daily">Daily</button>
        <button class="tab-btn" data-g="weekly">Weekly</button>
        <button class="tab-btn" data-g="monthly">Monthly</button>
      </div>
    </div>
    <div id="rf-trend-chart">${trendChartHtml(report.trend.daily, 'daily')}</div>
  </div>

  <div class="grid g-2" style="margin-top:18px;">
    ${twoColTable('Highest attendance students', 'Top 10, current filters', report.highestStudents, 'Attendance')}
    ${twoColTable('Lowest attendance students', 'Bottom 10, current filters', report.lowestStudents, 'Attendance')}
  </div>
  <div class="grid g-2" style="margin-top:18px;">
    ${twoColTable('Most attended courses', 'Top 10, current filters', report.mostAttendedCourses, 'Attendance')}
    ${twoColTable('Courses with poor attendance', 'Bottom 10, current filters', report.poorAttendanceCourses, 'Attendance')}
  </div>
  <div class="card" style="margin-top:18px;">
    <h3>Students below ${75}% threshold</h3>
    <p class="cap">${report.belowThreshold.length} student${report.belowThreshold.length === 1 ? '' : 's'}, current filters</p>
    ${report.belowThreshold.length ? `<table><thead><tr><th>Roll No.</th><th>Name</th><th>Attendance</th></tr></thead><tbody>
      ${report.belowThreshold.map(s => `<tr class="rowhover"><td class="mono">${escapeHtml(s.roll_number || '—')}</td><td>${escapeHtml(s.label)}</td><td>${statusBadge(s.pct >= 65 ? 'late' : 'absent')} <span class="mono">${s.pct}%</span></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-note">No students below the threshold for these filters. 🎉</div>'}
  </div>`;
}
function trendChartHtml(points, granularity) {
  if (!points.length) return '<div class="empty-note">Not enough data yet to chart a trend.</div>';
  const labels = points.map(p => granularity === 'daily' ? String(p.key).slice(-2) : granularity === 'monthly' ? String(p.key).slice(2) : String(p.key).replace(/^\d{4}-W?/, 'W'));
  return lineChartSVG(points.map(p => p.pct), labels, 'var(--verify)');
}
function wireAdminReportTrendTabs() {
  const wrap = document.getElementById('rf-trend-tabs');
  if (!wrap || !window.__adminReport) return;
  wrap.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    wrap.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    const g = btn.dataset.g;
    document.getElementById('rf-trend-chart').innerHTML = trendChartHtml(window.__adminReport.trend[g], g);
  }));
}

/* ---- Feature 2: Weekly Reports ---- */
async function adminWeeklyTab(filters = {}) {
  const [meta, report] = await Promise.all([loadAdminFilterMeta(), api('/api/admin/reports/weekly' + qs(filters))]);
  const t = report.totals;
  return `
  <form id="wf-form" class="table-controls" style="margin-bottom:18px;">
    ${filterSelectsHtml(meta, filters, 'wf')}
    <input type="date" class="select-input" id="wf-week" value="${filters.week || ''}" title="Any date within the target week">
    <button class="btn-sm" type="button" onclick="applyAdminWeeklyFilters(new Date(Date.now()-7*86400000).toISOString().slice(0,10))">Previous week</button>
    <button class="btn-sm" type="button" onclick="applyAdminWeeklyFilters(new Date().toISOString().slice(0,10))">Current week</button>
    <button class="btn-sm btn-dark" type="submit">Apply</button>
    <div style="flex:1;"></div>
    <button type="button" class="btn-sm" onclick="downloadFile('/api/admin/export/excel${qs({ ...filters, from: report.weekStart, to: report.weekEnd })}','weekly_attendance.xlsx')">Export Excel</button>
    <button type="button" class="btn-sm" onclick="downloadFile('/api/admin/export/pdf${qs({ ...filters, from: report.weekStart, to: report.weekEnd })}','weekly_report.pdf')">Export PDF</button>
  </form>

  <div class="card" style="margin-bottom:18px;">
    <h3>Week of ${report.weekStart} – ${report.weekEnd}</h3>
    <p class="cap">Previous week: ${report.previousWeek.weekStart} – ${report.previousWeek.weekEnd}</p>
    <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
      <div class="ring-wrap" style="margin:0;">${ringSVG(t.overallPct, t.overallPct >= 75 ? 'var(--verify)' : 'var(--red)')}</div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${weekTrendBadge(report.comparison.trend)}
        <span class="mono" style="font-size:12px;color:var(--slate);">${report.comparison.deltaPct == null ? 'No comparable data last week' : (report.comparison.deltaPct > 0 ? '+' : '') + report.comparison.deltaPct + '% vs last week (' + report.previousWeek.totals.overallPct + '%)'}</span>
      </div>
    </div>
  </div>

  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Total sessions</div><div class="kpi-value">${t.totalSessions}</div></div>
    <div class="card kpi"><div class="kpi-label">Present</div><div class="kpi-value">${t.presentCount}</div></div>
    <div class="card kpi"><div class="kpi-label">Absent</div><div class="kpi-value">${t.absentCount}</div></div>
    <div class="card kpi"><div class="kpi-label">Late</div><div class="kpi-value">${t.lateCount}</div></div>
  </div>

  <div class="grid g-2" style="margin-top:18px;">
    <div class="card"><h3>Department-wise</h3><p class="cap">This week, current filters</p>${barRows(report.departmentWise.map(d => ({ name: d.label, pct: d.pct })))}</div>
    <div class="card"><h3>Course-wise</h3><p class="cap">This week, current filters</p>${barRows(report.courseWise.map(c => ({ name: c.label, pct: c.pct })))}</div>
  </div>

  <div class="card" style="margin-top:18px;">
    <h3>Low-attendance students this week</h3>
    <p class="cap">Below 75%, current filters</p>
    ${report.belowThreshold.length ? `<table><thead><tr><th>Roll No.</th><th>Name</th><th>Attendance</th></tr></thead><tbody>
      ${report.belowThreshold.map(s => `<tr class="rowhover"><td class="mono">${escapeHtml(s.roll_number || '—')}</td><td>${escapeHtml(s.label)}</td><td>${statusBadge(s.pct >= 65 ? 'late' : 'absent')} <span class="mono">${s.pct}%</span></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-note">No low-attendance students this week for these filters.</div>'}
  </div>`;
}

/* ---- Feature 3: Risk & Anti-Proxy Detection ---- */
async function adminRiskTab(filters = {}, page = 1) {
  const [meta, risk] = await Promise.all([loadAdminFilterMeta(), api('/api/admin/risk' + qs({ ...filters, page, pageSize: 15 }))]);
  const totalPages = Math.max(1, Math.ceil(risk.total / risk.pageSize));
  return `
  <div class="demo-disclaimer" style="margin-bottom:18px;">
    <b>Transparent, rule-based detection — not an AI fraud engine.</b> Every score is an explainable sum of named signals (below). Risk events are recorded for visibility only; they never block or override the existing accept/reject decision for an attendance attempt.
  </div>
  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Suspicious attempts</div><div class="kpi-value">${risk.summary.total}</div></div>
    <div class="card kpi"><div class="kpi-label">High risk</div><div class="kpi-value" style="color:var(--red);">${risk.summary.high}</div></div>
    <div class="card kpi"><div class="kpi-label">Medium risk</div><div class="kpi-value" style="color:#9c6a12;">${risk.summary.medium}</div></div>
    <div class="card kpi"><div class="kpi-label">Low risk</div><div class="kpi-value" style="color:var(--verify);">${risk.summary.low}</div></div>
  </div>
  <form id="kf-form" class="table-controls" style="margin:18px 0;">
    <select class="select-input" id="kf-department"><option value="">All departments</option>${meta.departments.map(d => `<option ${filters.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
    <select class="select-input" id="kf-course"><option value="">All courses</option>${meta.courses.map(c => `<option value="${c.id}" ${filters.course_id == c.id ? 'selected' : ''}>${escapeHtml(c.course_name)}</option>`).join('')}</select>
    <select class="select-input" id="kf-student"><option value="">All students</option>${meta.students.map(s => `<option value="${s.id}" ${filters.student_id == s.id ? 'selected' : ''}>${escapeHtml(s.roll_number)} — ${escapeHtml(s.name)}</option>`).join('')}</select>
    <select class="select-input" id="kf-level"><option value="">All levels</option>
      <option value="high" ${filters.level === 'high' ? 'selected' : ''}>High</option>
      <option value="medium" ${filters.level === 'medium' ? 'selected' : ''}>Medium</option>
      <option value="low" ${filters.level === 'low' ? 'selected' : ''}>Low</option>
    </select>
    <select class="select-input" id="kf-method"><option value="">All methods</option>
      <option value="face" ${filters.method === 'face' ? 'selected' : ''}>Face</option>
      <option value="qr" ${filters.method === 'qr' ? 'selected' : ''}>QR</option>
      <option value="demo" ${filters.method === 'demo' ? 'selected' : ''}>Demo</option>
    </select>
    <input type="date" class="select-input" id="kf-from" value="${filters.from || ''}">
    <input type="date" class="select-input" id="kf-to" value="${filters.to || ''}">
    <button class="btn-sm btn-dark" type="submit">Apply filters</button>
  </form>
  <div class="card">
    <h3>Recent suspicious activity</h3>
    <p class="cap">Every recorded attendance attempt, ranked most recent first</p>
    ${risk.rows.length ? `<table>
      <thead><tr><th>Time</th><th>Student</th><th>Course / Session</th><th>Method</th><th>Outcome</th><th>Score</th><th>Level</th><th>Reasons</th></tr></thead>
      <tbody>${risk.rows.map(r => `<tr class="rowhover">
        <td class="mono">${r.created_at}</td>
        <td>${escapeHtml(r.roll_number)}<br><span style="font-size:11px;color:var(--slate-dim);">${escapeHtml(r.student_name)}</span></td>
        <td>${escapeHtml(r.course_name || '—')}</td>
        <td>${escapeHtml((r.method || '—').toUpperCase())}</td>
        <td>${r.outcome === 'accepted' ? statusBadge('present') : statusBadge('absent')}</td>
        <td class="mono">${r.score}</td>
        <td>${riskLevelBadge(r.level)}</td>
        <td style="font-size:11.5px;color:var(--slate);max-width:220px;">${r.reasons.map(escapeHtml).join('; ')}</td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="empty-note">No suspicious attempts recorded for these filters.</div>'}
    <div class="pagination">
      <span>Page ${risk.page} of ${totalPages}</span>
      <button ${risk.page <= 1 ? 'disabled' : ''} onclick="rerenderAdminAnalytics('risk', ${JSON.stringify(filters)}, ${risk.page - 1})">Prev</button>
      <button ${risk.page >= totalPages ? 'disabled' : ''} onclick="rerenderAdminAnalytics('risk', ${JSON.stringify(filters)}, ${risk.page + 1})">Next</button>
    </div>
  </div>`;
}

/* ---- Batch 5: Predictive Attendance Analytics — institution-wide aggregate.
   Distinct from the "Risk" tab above (anti-proxy/fraud detection on check-in
   attempts); this scores each student's attendance trajectory against the
   75% threshold. Counts and roll-number-level lists only — no descriptors,
   tokens, or other sensitive personal data. ---- */
async function adminPredictionsTab(filters = {}) {
  const [meta, summary] = await Promise.all([loadAdminFilterMeta(), api('/api/admin/predictions/summary' + qs({ department: filters.department }))]);
  return `
  <div class="demo-disclaimer" style="margin-bottom:18px;">
    <b>Predictive Attendance Model — a transparent, rule-based estimate, not a trained AI system.</b>
    Scores are computed from real attendance percentages, recent trend, and consecutive absences, with a plain-language reason for every result. This is decision support only — it never marks, changes, or deletes any attendance record, and never triggers automatic action against a student.
  </div>
  <form id="apf-form" class="table-controls" style="margin-bottom:18px;">
    <select class="select-input" id="apf-department"><option value="">All departments</option>${meta.departments.map(d => `<option ${filters.department === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select>
    <button class="btn-sm btn-dark" type="submit">Apply filter</button>
  </form>
  <div class="grid g-4">
    <div class="card kpi"><div class="kpi-label">Students scored</div><div class="kpi-value">${summary.totalStudents}</div></div>
    <div class="card kpi"><div class="kpi-label">High risk</div><div class="kpi-value" style="color:var(--red);">${summary.counts.high || 0}</div></div>
    <div class="card kpi"><div class="kpi-label">Medium risk</div><div class="kpi-value" style="color:#9c6a12;">${summary.counts.medium || 0}</div></div>
    <div class="card kpi"><div class="kpi-label">Low risk</div><div class="kpi-value" style="color:var(--verify);">${summary.counts.low || 0}</div></div>
  </div>
  <div class="grid g-2" style="margin-top:18px;">
    <div class="card">
      <h3>Students with a declining trend</h3>
      <p class="cap">Recent attendance trending down vs. earlier in the term</p>
      ${summary.decliningTrend.length ? `<table>
        <thead><tr><th>Roll No.</th><th>Name</th><th>Department</th><th>Attendance</th><th>Risk</th></tr></thead>
        <tbody>${summary.decliningTrend.slice(0, 30).map(s => `<tr class="rowhover">
          <td class="mono">${escapeHtml(s.rollNumber)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.department || '—')}</td>
          <td class="mono">${s.pct}%</td><td>${predictionRiskBadge(s.level)}</td>
        </tr>`).join('')}</tbody>
      </table>${summary.decliningTrend.length > 30 ? `<p class="cap" style="margin-top:8px;">+ ${summary.decliningTrend.length - 30} more</p>` : ''}` : '<div class="empty-note">No students with a declining trend for these filters.</div>'}
    </div>
    <div class="card">
      <h3>Courses of concern</h3>
      <p class="cap">Courses with the most high-risk students enrolled</p>
      ${summary.concerningCourses.length ? `<table>
        <thead><tr><th>Course</th><th>High</th><th>Medium</th><th>Low</th><th>Total</th></tr></thead>
        <tbody>${summary.concerningCourses.map(c => `<tr class="rowhover">
          <td>${escapeHtml(c.courseName)}</td><td class="mono" style="color:var(--red);">${c.high}</td>
          <td class="mono" style="color:#9c6a12;">${c.medium}</td><td class="mono" style="color:var(--verify);">${c.low}</td><td class="mono">${c.total}</td>
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty-note">No courses currently show elevated risk.</div>'}
    </div>
  </div>`;
}

/* ==========================================================================
   Batch 5 — Admin Compliance Dashboard: Security / Audit / Privacy / Data /
   LMS, built entirely from the EXISTING audit_logs, user_2fa and LMS state —
   no new security system, no new tracking. Retention cleanup always shows
   the affected row count and requires an explicit confirm before deleting.
   ========================================================================== */
async function adminComplianceTab() {
  const [summary, auditPage] = await Promise.all([
    api('/api/admin/compliance/summary'),
    api('/api/admin/audit-logs?pageSize=10')
  ]);
  window.__complianceSummary = summary;
  const sec = summary.security;
  const twoFaPct = sec.totalUsers ? Math.round((sec.usersWith2fa / sec.totalUsers) * 100) : 0;

  return `
  <div class="demo-disclaimer" style="margin-bottom:18px;">
    <b>Compliance foundation, not a legal certification.</b> This dashboard gives real, verifiable visibility into what this app actually does with security, audit, and personal data — it is not a claim of GDPR, DPDP, FERPA, or ISO certification.
  </div>

  <h3 style="margin:0 0 10px;">Security</h3>
  <div class="grid g-4" style="margin-bottom:18px;">
    <div class="card kpi"><div class="kpi-label">Active accounts</div><div class="kpi-value">${sec.totalUsers}</div></div>
    <div class="card kpi"><div class="kpi-label">2FA adoption</div><div class="kpi-value" style="color:var(--verify);">${twoFaPct}%</div></div>
    <div class="card kpi"><div class="kpi-label">With 2FA enabled</div><div class="kpi-value">${sec.usersWith2fa}</div></div>
    <div class="card kpi"><div class="kpi-label">Without 2FA</div><div class="kpi-value" style="color:${sec.usersWithout2fa ? '#9c6a12' : 'var(--verify)'};">${sec.usersWithout2fa}</div></div>
  </div>
  <div class="card" style="margin-bottom:18px;">
    <h3>Accounts without 2FA</h3>
    <p class="cap">2FA is opt-in — this is visibility for admin follow-up, not an enforcement list</p>
    ${sec.withoutTwoFa.length ? `<table><thead><tr><th>ID</th><th>Name</th><th>Role</th></tr></thead><tbody>
      ${sec.withoutTwoFa.map(u => `<tr class="rowhover"><td class="mono">${escapeHtml(u.user_id)}</td><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.role)}</td></tr>`).join('')}
    </tbody></table>${sec.usersWithout2fa > sec.withoutTwoFa.length ? `<p class="cap" style="margin-top:8px;">+ ${sec.usersWithout2fa - sec.withoutTwoFa.length} more</p>` : ''}` : '<div class="empty-note">Every active account has 2FA enabled.</div>'}
  </div>

  <h3 style="margin:0 0 10px;">Audit</h3>
  <div class="card" style="margin-bottom:18px;">
    <h3>Recent activity</h3>
    <p class="cap">Most recent ${auditPage.rows.length} of ${auditPage.total} recorded events — full history under Users &amp; Courses is not shown here</p>
    ${auditPage.rows.length ? `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead><tbody>
      ${auditPage.rows.map(r => `<tr class="rowhover"><td class="mono">${r.timestamp}</td><td>${escapeHtml(r.user_login || 'system')}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.entity || '—')}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-note">No audit events yet.</div>'}
  </div>

  <h3 style="margin:0 0 10px;">Privacy</h3>
  <div class="grid g-2" style="margin-bottom:18px;">
    <div class="card"><h3>Biometric data</h3><p style="font-size:12.5px;color:var(--slate);line-height:1.6;">${escapeHtml(summary.privacy.biometric)}</p><p class="cap" style="margin-top:8px;">${summary.data.faceEnrolledCount} student${summary.data.faceEnrolledCount === 1 ? '' : 's'} currently enrolled</p></div>
    <div class="card"><h3>Location data</h3><p style="font-size:12.5px;color:var(--slate);line-height:1.6;">${escapeHtml(summary.privacy.location)}</p></div>
  </div>
  <div class="card" style="margin-bottom:18px;">
    <h3>Data retention</h3>
    <p class="cap">Manual, admin-only cleanup. Nothing is deleted automatically, and every cleanup run is itself audited.</p>
    <table>
      <thead><tr><th>Category</th><th>Total rows</th><th>Cleanup after</th><th>Affected now</th><th>Enabled</th><th></th></tr></thead>
      <tbody>${Object.entries(summary.data.retention).map(([key, c]) => `
        <tr class="rowhover">
          <td>${escapeHtml(c.label)}${!c.deletable ? `<br><span style="font-size:11px;color:var(--slate-dim);">${escapeHtml(c.note)}</span>` : ''}</td>
          <td class="mono">${c.totalCount}</td>
          <td>${c.deletable ? `<input type="number" min="1" class="select-input" id="ret-days-${key}" value="${c.days}" style="width:80px;">` : '<span class="cap">n/a</span>'}</td>
          <td class="mono" style="${c.affectedCount ? 'color:var(--red);' : ''}">${c.deletable ? c.affectedCount : '—'}</td>
          <td>${c.deletable ? `<input type="checkbox" id="ret-enabled-${key}" ${c.enabled ? 'checked' : ''}>` : '—'}</td>
          <td>${c.deletable ? `
            <button class="btn-sm" onclick="saveRetentionConfig('${key}')">Save</button>
            <button class="btn-sm btn-danger" onclick="runRetentionCleanup('${key}')">Clean up now</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>
  </div>

  <h3 style="margin:0 0 10px;">Data</h3>
  <div class="card" style="margin-bottom:18px;">
    <h3>Recent export activity</h3>
    <p class="cap">Includes admin/faculty report exports and student self-service data exports</p>
    ${summary.data.exportActivity.length ? `<table><thead><tr><th>Time</th><th>By</th><th>Action</th></tr></thead><tbody>
      ${summary.data.exportActivity.map(e => `<tr class="rowhover"><td class="mono">${e.timestamp}</td><td>${escapeHtml(e.user_name || '—')}</td><td>${escapeHtml(e.action)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty-note">No export activity recorded yet.</div>'}
  </div>

  <h3 style="margin:0 0 10px;">LMS</h3>
  <div class="card">
    <h3>Integration status</h3>
    <p style="font-size:12.5px;color:var(--slate);">${summary.lms.isMock ? 'Demo / Mock provider — no real external LMS is connected.' : `Provider: ${escapeHtml(summary.lms.provider)}`} · Status: ${escapeHtml(summary.lms.status)} · Last sync: ${summary.lms.lastSyncAt ? new Date(summary.lms.lastSyncAt).toLocaleString() : 'Never'}</p>
    <p class="cap" style="margin-top:6px;">Full sync controls and logs are on the LMS Integration tab.</p>
  </div>`;
}
async function saveRetentionConfig(category) {
  const days = Number(document.getElementById(`ret-days-${category}`).value);
  const enabled = document.getElementById(`ret-enabled-${category}`).checked;
  if (!Number.isFinite(days) || days < 1) return showToast('Days must be a positive number.', 'error');
  try {
    await api('/api/admin/compliance/retention', { method: 'PUT', body: { category, enabled, days } });
    showToast('Retention setting saved');
    rerenderAdminAnalytics('compliance');
  } catch (e) { showToast(e.message, 'error'); }
}
async function runRetentionCleanup(category) {
  const cfg = window.__complianceSummary?.data?.retention?.[category];
  const affected = cfg ? cfg.affectedCount : 0;
  confirmDialog(`This will permanently delete ${affected} row${affected === 1 ? '' : 's'} from "${escapeHtml(cfg ? cfg.label : category)}" older than the configured cutoff. This cannot be undone. Continue?`, async () => {
    try {
      const result = await api('/api/admin/compliance/retention/cleanup', { method: 'POST', body: { category, confirm: true } });
      showToast(`Deleted ${result.deleted} row${result.deleted === 1 ? '' : 's'} from ${result.label}`);
      rerenderAdminAnalytics('compliance');
    } catch (e) { showToast(e.message, 'error'); }
  });
}

/* allow Enter key to submit login from the password field (form submit already handles this, kept for safety) */
document.getElementById('login-pw')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-form').requestSubmit(); });
