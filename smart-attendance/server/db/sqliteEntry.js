require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './database/attendance.db';
const resolvedPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(__dirname, '..', '..', DB_PATH);

// make sure the database directory exists
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const db = new Database(resolvedPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,          -- roll number / staff id / admin id, used to log in
    name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student','faculty','admin')),
    department TEXT,
    year_of_study TEXT, -- 'I'|'II'|'III'|'IV' — displayed as "Academic Year"; distinct from courses.academic_year (a calendar year like '2026-27')
    section TEXT,
    status TEXT NOT NULL DEFAULT 'active', -- active | disabled
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    roll_number TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    department TEXT,
    year_of_study TEXT, -- 'I'|'II'|'III'|'IV' — displayed as "Academic Year"
    section TEXT,
    semester INTEGER DEFAULT 5,
    face_enrolled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS faculty (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    employee_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    department TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_code TEXT UNIQUE NOT NULL,
    course_name TEXT NOT NULL,
    department TEXT,
    academic_year TEXT,
    semester INTEGER DEFAULT 5,
    section TEXT,
    faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    UNIQUE(student_id, course_id)
  );

  CREATE TABLE IF NOT EXISTS class_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    room TEXT,
    status TEXT NOT NULL DEFAULT 'closed', -- open | closed
    qr_token TEXT,
    qr_expires_at TEXT,
    room_lat REAL,
    room_lng REAL,
    allowed_radius_m INTEGER DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
    method TEXT NOT NULL DEFAULT 'manual', -- face | qr | manual
    confidence REAL,
    marked_at TEXT NOT NULL DEFAULT (datetime('now')),
    remarks TEXT,
    latitude REAL,
    longitude REAL,
    accuracy REAL,
    location_verified INTEGER DEFAULT 0,
    distance_from_classroom REAL,
    face_verified INTEGER DEFAULT 0,
    face_distance REAL,
    UNIQUE(student_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS face_enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    descriptor TEXT NOT NULL, -- JSON array: 128-d face-api.js descriptor
    sample_count INTEGER DEFAULT 0,
    last_verified_at TEXT, -- last successful attendance-time face match; drives the 7-day cache
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS timetable_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    section TEXT NOT NULL,
    day_of_week INTEGER NOT NULL, -- 0=Sun..6=Sat, matches JS Date.getDay()
    start_time TEXT NOT NULL, -- 'HH:MM'
    end_time TEXT NOT NULL,   -- 'HH:MM'
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL, -- NULL for break/study/lunch periods
    label TEXT, -- free text for non-class periods, e.g. 'Study', 'Lunch Break'
    period_type TEXT NOT NULL DEFAULT 'class' CHECK(period_type IN ('class','break','study','lunch')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'info', -- info | warning | success | alert
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_date TEXT NOT NULL UNIQUE, -- 'YYYY-MM-DD' — works across any year, not tied to one academic calendar
    name TEXT NOT NULL,
    description TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS student_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_role TEXT NOT NULL CHECK(author_role IN ('faculty','admin')),
    course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- An excuse is never written into the attendance table — it lives entirely
  -- here as its own auditable record. Reporting logic (utils/reports.js,
  -- utils/analytics.js) reclassifies an 'absent' attendance row as "excused"
  -- for display/percentage purposes ONLY when a matching approved row exists
  -- here; the underlying attendance row itself is never mutated.
  CREATE TABLE IF NOT EXISTS student_excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewer_comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    UNIQUE(student_id, session_id)
  );

  CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    low_attendance_alerts INTEGER NOT NULL DEFAULT 1,
    weekly_reports INTEGER NOT NULL DEFAULT 1,
    excuse_updates INTEGER NOT NULL DEFAULT 1,
    system_notifications INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    recipient_email TEXT,
    event_type TEXT NOT NULL, -- low_attendance | weekly_report | excuse_submitted | excuse_approved | excuse_rejected
    subject TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sent','mocked','failed','skipped')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Opt-in TOTP 2FA. enabled=0 while a secret has been generated but not yet
  -- confirmed with a correct code (mid-enrollment); only becomes 1 after that
  -- verification succeeds. The secret is never returned by any API response
  -- once enrollment's initial step has completed. recovery_codes is a JSON
  -- array of bcrypt hashes, same protection level as password_hash.
  -- A proper department registry (id, code, name, description, status). The
  -- existing free-text department columns on users/students/faculty/courses
  -- are left exactly as they are — they still just store the code string
  -- (e.g. 'CSE'), matched by VALUE against departments.code, not a formal FK.
  -- That keeps this additive and risk-free: no existing column, constraint, or
  -- query anywhere else in the app has to change for this table to exist.
  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- LMS integration (Batch 4). Live connection state (provider, last test/sync
  -- timestamps, running counts) is a single mutable record — reuses the
  -- existing app_settings key/value store (see utils/lmsService.js) rather
  -- than a one-row table. These two ARE proper multi-row history/mapping
  -- tables, so they get real tables.
  CREATE TABLE IF NOT EXISTS lms_sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    sync_type TEXT NOT NULL CHECK(sync_type IN ('connection_test','courses','enrollments','attendance')),
    status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    records_processed INTEGER NOT NULL DEFAULT 0,
    records_succeeded INTEGER NOT NULL DEFAULT 0,
    records_failed INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT,
    triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  -- Maps a local course to its counterpart in the connected LMS, by provider —
  -- matched to the local courses table by course_code, never auto-creating a
  -- new local course. Re-running a sync with a different provider keeps both
  -- mappings side by side (UNIQUE is per course+provider, not just per course).
  CREATE TABLE IF NOT EXISTS lms_course_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    lms_course_id TEXT NOT NULL,
    lms_course_code TEXT,
    last_synced_at TEXT,
    UNIQUE(course_id, provider)
  );

  CREATE TABLE IF NOT EXISTS user_2fa (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL,
    attendance_id INTEGER REFERENCES attendance(id) ON DELETE SET NULL,
    method TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')),
    score INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('low','medium','high')),
    reasons TEXT NOT NULL, -- JSON array of human-readable reason strings
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id);
  CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_course ON class_sessions(course_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_faculty ON class_sessions(faculty_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE INDEX IF NOT EXISTS idx_students_section ON students(section);
  CREATE INDEX IF NOT EXISTS idx_face_enrollments_student ON face_enrollments(student_id);
  CREATE INDEX IF NOT EXISTS idx_timetable_lookup ON timetable_slots(department, section, day_of_week);
  CREATE INDEX IF NOT EXISTS idx_risk_events_student ON risk_events(student_id);
  CREATE INDEX IF NOT EXISTS idx_risk_events_session ON risk_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_risk_events_level ON risk_events(level);
  CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(holiday_date);
  CREATE INDEX IF NOT EXISTS idx_student_notes_student ON student_notes(student_id);
  CREATE INDEX IF NOT EXISTS idx_student_notes_author ON student_notes(author_id);
  CREATE INDEX IF NOT EXISTS idx_excuses_student ON student_excuses(student_id);
  CREATE INDEX IF NOT EXISTS idx_excuses_session ON student_excuses(session_id);
  CREATE INDEX IF NOT EXISTS idx_excuses_course ON student_excuses(course_id);
  CREATE INDEX IF NOT EXISTS idx_excuses_status ON student_excuses(status);
  CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_notification_log(recipient_user_id);
  CREATE INDEX IF NOT EXISTS idx_email_log_event ON email_notification_log(event_type);
  CREATE INDEX IF NOT EXISTS idx_lms_sync_logs_started ON lms_sync_logs(started_at);
  CREATE INDEX IF NOT EXISTS idx_lms_course_mappings_course ON lms_course_mappings(course_id);
  `);

  migrate();
}

// Adds any columns introduced after a database file was first created, without
// touching existing rows. Safe to run every startup — it only ALTERs columns
// that are missing.
function migrate() {
  const addColumnIfMissing = (table, column, definition) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  addColumnIfMissing('class_sessions', 'room_lat', 'REAL');
  addColumnIfMissing('class_sessions', 'room_lng', 'REAL');
  addColumnIfMissing('class_sessions', 'allowed_radius_m', 'INTEGER DEFAULT 100');
  addColumnIfMissing('attendance', 'latitude', 'REAL');
  addColumnIfMissing('attendance', 'longitude', 'REAL');
  addColumnIfMissing('attendance', 'accuracy', 'REAL');
  addColumnIfMissing('attendance', 'location_verified', 'INTEGER DEFAULT 0');
  addColumnIfMissing('attendance', 'distance_from_classroom', 'REAL');
  addColumnIfMissing('attendance', 'face_verified', 'INTEGER DEFAULT 0');
  addColumnIfMissing('attendance', 'face_distance', 'REAL');
  addColumnIfMissing('courses', 'academic_year', 'TEXT');
  addColumnIfMissing('face_enrollments', 'last_verified_at', 'TEXT');
  addColumnIfMissing('users', 'year_of_study', 'TEXT');
  addColumnIfMissing('students', 'year_of_study', 'TEXT');
  backfillYearOfStudy();
  backfillDepartments();
  migrateMultiInstitution();
  seedSuperAdmin();
}

// One-time, idempotent: creates a single demo SUPER_ADMIN account so the
// feature is actually demonstrable. Deliberately NOT the existing ADM-009
// account — that stays a regular, institution-scoped admin exactly as before,
// so no existing demo credential silently gains new global privileges.
// Guarded by an explicit existence check rather than INSERT OR IGNORE: a
// composite UNIQUE(institution_id, user_id) does not reliably dedupe rows
// where institution_id is NULL (SQL treats NULL <> NULL even in a unique
// index), so ON CONFLICT can't be trusted here.
function seedSuperAdmin() {
  const existing = db.prepare(`SELECT 1 FROM users WHERE user_id = 'SUPER-001' AND role = 'super_admin'`).get();
  if (existing) return;
  db.prepare(`
    INSERT INTO users (institution_id, user_id, name, email, password_hash, role, status)
    VALUES (NULL, 'SUPER-001', 'Platform Super Admin', 'superadmin@smartattendance.local', ?, 'super_admin', 'active')
  `).run(bcrypt.hashSync('superadmin123', 8));
}

// ============================================================================
// Batch 6 — Multi-Institution Support. One-time, idempotent structural
// migration (checked via the presence of users.institution_id — if it's
// already there, this is a pure no-op on every subsequent boot).
//
// Six tables (users, students, faculty, departments, courses, holidays) each
// had a table-wide UNIQUE constraint (user_id / roll_number / employee_id /
// code / course_code / holiday_date) that must become PER-INSTITUTION
// (composite UNIQUE(institution_id, X)) — two different institutions must be
// able to both have a course "CS101" or a student "24UCS205". SQLite cannot
// ALTER a UNIQUE/CHECK constraint in place, so these six are rebuilt
// (CREATE new-shape table -> copy rows with institution_id=1 -> drop old ->
// rename) inside a single transaction. Every other tenant-scoped table only
// gets a plain ADD COLUMN (no existing constraint conflicts there).
//
// CRITICAL, verified-the-hard-way detail: PRAGMA foreign_keys is a documented
// no-op while a transaction is open in SQLite. Setting it OFF must happen
// BEFORE the transaction starts, or DROP TABLE on a referenced parent
// (e.g. users) cascade-deletes every child row (students/faculty/...) exactly
// like a DELETE would — this was caught and fixed via a dry run against a
// throwaway copy of the real database before ever touching the live file.
function migrateMultiInstitution() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (cols.includes('institution_id')) return; // already migrated

  db.pragma('foreign_keys = OFF');
  const migrateTx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS institutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Every existing row in this database belongs to this one, pre-existing
    // institution — this is what preserves all Batch 1-5 data as-is.
    db.prepare(`INSERT OR IGNORE INTO institutions (id, code, name, status) VALUES (1, 'DEMO', 'Demo Institution', 'active')`).run();

    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('student','faculty','admin','super_admin')),
        department TEXT,
        year_of_study TEXT,
        section TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(institution_id, user_id),
        CHECK ((role = 'super_admin' AND institution_id IS NULL) OR (role != 'super_admin' AND institution_id IS NOT NULL))
      );
      INSERT INTO users_new (id, institution_id, user_id, name, email, password_hash, role, department, year_of_study, section, status, created_at)
        SELECT id, 1, user_id, name, email, password_hash, role, department, year_of_study, section, status, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX idx_users_role ON users(role);
      CREATE INDEX idx_users_institution ON users(institution_id);
    `);

    db.exec(`
      CREATE TABLE students_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        roll_number TEXT NOT NULL,
        name TEXT NOT NULL,
        department TEXT,
        year_of_study TEXT,
        section TEXT,
        semester INTEGER DEFAULT 5,
        face_enrolled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(institution_id, roll_number)
      );
      INSERT INTO students_new (id, institution_id, user_id, roll_number, name, department, year_of_study, section, semester, face_enrolled, created_at)
        SELECT id, 1, user_id, roll_number, name, department, year_of_study, section, semester, face_enrolled, created_at FROM students;
      DROP TABLE students;
      ALTER TABLE students_new RENAME TO students;
      CREATE INDEX idx_students_section ON students(section);
      CREATE INDEX idx_students_institution ON students(institution_id);
    `);

    db.exec(`
      CREATE TABLE faculty_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL,
        name TEXT NOT NULL,
        department TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(institution_id, employee_id)
      );
      INSERT INTO faculty_new (id, institution_id, user_id, employee_id, name, department, created_at)
        SELECT id, 1, user_id, employee_id, name, department, created_at FROM faculty;
      DROP TABLE faculty;
      ALTER TABLE faculty_new RENAME TO faculty;
      CREATE INDEX idx_faculty_institution ON faculty(institution_id);
    `);

    db.exec(`
      CREATE TABLE departments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(institution_id, code)
      );
      INSERT INTO departments_new (id, institution_id, code, name, description, status, created_at, updated_at)
        SELECT id, 1, code, name, description, status, created_at, updated_at FROM departments;
      DROP TABLE departments;
      ALTER TABLE departments_new RENAME TO departments;
      CREATE INDEX idx_departments_institution ON departments(institution_id);
    `);

    db.exec(`
      CREATE TABLE courses_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
        course_code TEXT NOT NULL,
        course_name TEXT NOT NULL,
        department TEXT,
        academic_year TEXT,
        semester INTEGER DEFAULT 5,
        section TEXT,
        faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(institution_id, course_code)
      );
      INSERT INTO courses_new (id, institution_id, course_code, course_name, department, academic_year, semester, section, faculty_id, status, created_at)
        SELECT id, 1, course_code, course_name, department, academic_year, semester, section, faculty_id, status, created_at FROM courses;
      DROP TABLE courses;
      ALTER TABLE courses_new RENAME TO courses;
      CREATE INDEX idx_courses_institution ON courses(institution_id);
    `);

    db.exec(`
      CREATE TABLE holidays_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
        holiday_date TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(institution_id, holiday_date)
      );
      INSERT INTO holidays_new (id, institution_id, holiday_date, name, description, created_by, created_at, updated_at)
        SELECT id, 1, holiday_date, name, description, created_by, created_at, updated_at FROM holidays;
      DROP TABLE holidays;
      ALTER TABLE holidays_new RENAME TO holidays;
      CREATE INDEX idx_holidays_date ON holidays(holiday_date);
      CREATE INDEX idx_holidays_institution ON holidays(institution_id);
    `);

    // Plain ADD COLUMN for every other tenant-scoped table — no existing
    // constraint conflicts, so no rebuild needed. Flat institution_id=1
    // backfill is exactly correct here: at migration time only one
    // institution has ever existed, so every row unambiguously belongs to it.
    const addCol = (table, col, def) => db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    for (const t of ['enrollments', 'class_sessions', 'attendance', 'timetable_slots', 'student_notes', 'student_excuses', 'lms_sync_logs', 'lms_course_mappings', 'risk_events']) {
      addCol(t, 'institution_id', 'INTEGER REFERENCES institutions(id) ON DELETE RESTRICT');
      db.exec(`UPDATE ${t} SET institution_id = 1 WHERE institution_id IS NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_institution ON ${t}(institution_id)`);
    }
    // audit_logs / email_notification_log: nullable institution_id (a system
    // action with no resolvable actor may legitimately have none).
    for (const t of ['audit_logs', 'email_notification_log']) {
      addCol(t, 'institution_id', 'INTEGER REFERENCES institutions(id) ON DELETE SET NULL');
      db.exec(`UPDATE ${t} SET institution_id = 1 WHERE institution_id IS NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_institution ON ${t}(institution_id)`);
    }
  });

  migrateTx();

  // Both of these only take effect after the transaction has committed.
  db.pragma('foreign_keys = ON');
  const fkIssues = db.pragma('foreign_key_check');
  if (fkIssues.length) {
    throw new Error('Multi-institution migration left dangling foreign keys: ' + JSON.stringify(fkIssues));
  }
}

// One-time, idempotent: registers a department row for every department code
// that ALREADY appears among real students/faculty — never invents departments
// that don't actually exist in this data. Known codes get a real display name;
// anything unrecognized just uses the code as its name (safe default, still
// fully usable — an admin can rename it via the UI). INSERT OR IGNORE means
// this is a no-op on every boot after the first, and never touches a
// department an admin has since edited.
function backfillDepartments() {
  const KNOWN_NAMES = {
    CSE: 'Computer Science and Engineering',
    IT: 'Information Technology',
    ECE: 'Electronics and Communication Engineering',
    MECH: 'Mechanical Engineering',
    CIVIL: 'Civil Engineering',
  };
  const codes = db.prepare(`
    SELECT DISTINCT department FROM (
      SELECT department FROM students WHERE department IS NOT NULL AND department != ''
      UNION SELECT department FROM faculty WHERE department IS NOT NULL AND department != ''
    )
  `).all().map(r => r.department);
  const insert = db.prepare(`INSERT OR IGNORE INTO departments (code, name, status) VALUES (?, ?, 'active')`);
  for (const code of codes) insert.run(code, KNOWN_NAMES[code] || code);
}

// One-time, idempotent backfill: existing section values already encode the year
// of study as their leading token (e.g. "III CSE - B" -> "III"). Only ever touches
// rows where year_of_study is still NULL, so it never overwrites a value an admin
// has since set, and re-running it on every boot is a safe no-op once populated.
function backfillYearOfStudy() {
  const VALID_YEARS = ['I', 'II', 'III', 'IV'];
  for (const table of ['users', 'students']) {
    const rows = db.prepare(`SELECT id, section FROM ${table} WHERE year_of_study IS NULL AND section IS NOT NULL`).all();
    const update = db.prepare(`UPDATE ${table} SET year_of_study = ? WHERE id = ?`);
    for (const r of rows) {
      const firstToken = r.section.trim().split(/\s+/)[0];
      if (VALID_YEARS.includes(firstToken)) update.run(firstToken, r.id);
    }
  }
}

init();

// Wrap the raw better-sqlite3 connection in the shared async adapter
// interface so route/util files call db.get/all/run/exec/transaction(...)
// identically regardless of which engine (DB_ENGINE) is active. All the
// schema/migrate/backfill logic above is completely unchanged from the
// original server/db.js — only the final export changed.
const { createSqliteAdapter } = require('./adapters/sqliteAdapter');
module.exports = createSqliteAdapter(db);
