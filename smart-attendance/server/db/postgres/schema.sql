-- ============================================================================
-- Smart Attendance — PostgreSQL schema (Batch 6, Feature 17)
--
-- Translated 1:1 from the LIVE post-Feature-18 SQLite schema, captured via
-- PRAGMA table_info / foreign_key_list / index_list against the running
-- database (not re-derived from server/db.js's bootstrap SQL, which still
-- describes the pre-migration shape for a brand-new file — the two diverge
-- and only the live introspection is authoritative).
--
-- Type conversions applied (see the Batch 6 Postgres migration plan):
--   INTEGER PRIMARY KEY AUTOINCREMENT  -> INTEGER GENERATED ALWAYS AS IDENTITY
--   TEXT timestamp (datetime('now'))   -> TIMESTAMP DEFAULT (now() AT TIME ZONE 'utc')
--   TEXT date ('YYYY-MM-DD')           -> DATE
--   INTEGER 0/1 flag                   -> BOOLEAN
--   TEXT JSON blob (metadata/reasons/
--     descriptor/recovery_codes/value) -> TEXT, UNCHANGED (every call site
--                                          does JSON.parse(row.x); switching
--                                          to JSONB is a real future
--                                          improvement but touches call
--                                          sites, so deliberately deferred)
--   REAL                               -> DOUBLE PRECISION
--
-- Every composite UNIQUE, CHECK, and FK (with its exact ON DELETE action) is
-- preserved unchanged from the SQLite source — this is a faithful port, not
-- a redesign. Institution-scoping (institution_id columns/constraints from
-- Feature 18) is carried through exactly as it exists today.
--
-- qr_expires_at is deliberately kept TEXT, not TIMESTAMP: it's populated with
-- a JS ISO string and only ever compared in application code via `new
-- Date(...)`, never in a SQL WHERE/date-function — converting it gains
-- nothing and risks a subtle mismatch with the 'Z'-suffixed format the app
-- already writes.
-- ============================================================================

BEGIN;

CREATE TABLE institutions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','faculty','admin','super_admin')),
  department TEXT,
  year_of_study TEXT,
  section TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (institution_id, user_id),
  CHECK ((role = 'super_admin' AND institution_id IS NULL) OR (role != 'super_admin' AND institution_id IS NOT NULL))
);

CREATE TABLE students (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roll_number TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  year_of_study TEXT,
  section TEXT,
  semester INTEGER DEFAULT 5,
  face_enrolled BOOLEAN DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (institution_id, roll_number)
);

CREATE TABLE faculty (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (institution_id, employee_id)
);

CREATE TABLE departments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (institution_id, code)
);

CREATE TABLE courses (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  course_code TEXT NOT NULL,
  course_name TEXT NOT NULL,
  department TEXT,
  academic_year TEXT,
  semester INTEGER DEFAULT 5,
  section TEXT,
  faculty_id INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (institution_id, course_code)
);

CREATE TABLE enrollments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,
  UNIQUE (student_id, course_id)
);

CREATE TABLE class_sessions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  room TEXT,
  status TEXT NOT NULL DEFAULT 'closed',
  qr_token TEXT,
  qr_expires_at TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  room_lat DOUBLE PRECISION,
  room_lng DOUBLE PRECISION,
  allowed_radius_m INTEGER DEFAULT 100,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT
);

CREATE TABLE attendance (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late')),
  method TEXT NOT NULL DEFAULT 'manual',
  confidence DOUBLE PRECISION,
  marked_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  remarks TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  location_verified BOOLEAN DEFAULT false,
  distance_from_classroom DOUBLE PRECISION,
  face_verified BOOLEAN DEFAULT false,
  face_distance DOUBLE PRECISION,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,
  UNIQUE (student_id, session_id)
);

CREATE TABLE face_enrollments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  descriptor TEXT NOT NULL,
  sample_count INTEGER DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  last_verified_at TIMESTAMP
);

CREATE TABLE timetable_slots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department TEXT NOT NULL,
  section TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  label TEXT,
  period_type TEXT NOT NULL DEFAULT 'class' CHECK (period_type IN ('class','break','study','lunch')),
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE audit_logs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  timestamp TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  metadata TEXT,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL
);

CREATE TABLE holidays (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
  holiday_date DATE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  UNIQUE (institution_id, holiday_date)
);

CREATE TABLE student_notes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL CHECK (author_role IN ('faculty','admin')),
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT
);

CREATE TABLE student_excuses (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewer_comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  reviewed_at TIMESTAMP,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,
  UNIQUE (student_id, session_id)
);

CREATE TABLE notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  low_attendance_alerts BOOLEAN NOT NULL DEFAULT true,
  weekly_reports BOOLEAN NOT NULL DEFAULT true,
  excuse_updates BOOLEAN NOT NULL DEFAULT true,
  system_notifications BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE email_notification_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_email TEXT,
  event_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','mocked','failed','skipped')),
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL
);

CREATE TABLE lms_sync_logs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  sync_type TEXT NOT NULL CHECK (sync_type IN ('connection_test','courses','enrollments','attendance')),
  status TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
  started_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  completed_at TIMESTAMP,
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_succeeded INTEGER NOT NULL DEFAULT 0,
  records_failed INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  triggered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT
);

CREATE TABLE lms_course_mappings (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  lms_course_id TEXT NOT NULL,
  lms_course_code TEXT,
  last_synced_at TIMESTAMP,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,
  UNIQUE (course_id, provider)
);

CREATE TABLE user_2fa (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  recovery_codes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  enabled_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE risk_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES class_sessions(id) ON DELETE SET NULL,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE SET NULL,
  method TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
  score INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('low','medium','high')),
  reasons TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  institution_id INTEGER REFERENCES institutions(id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- Indexes — every one ported unchanged from the SQLite source (30 total,
-- including the composite institution_id ones added by Feature 18).
-- ---------------------------------------------------------------------------
CREATE INDEX idx_attendance_student ON attendance(student_id);
CREATE INDEX idx_attendance_session ON attendance(session_id);
CREATE INDEX idx_attendance_institution ON attendance(institution_id);
CREATE INDEX idx_sessions_course ON class_sessions(course_id);
CREATE INDEX idx_sessions_faculty ON class_sessions(faculty_id);
CREATE INDEX idx_class_sessions_institution ON class_sessions(institution_id);
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_institution ON users(institution_id);
CREATE INDEX idx_students_section ON students(section);
CREATE INDEX idx_students_institution ON students(institution_id);
CREATE INDEX idx_faculty_institution ON faculty(institution_id);
CREATE INDEX idx_departments_institution ON departments(institution_id);
CREATE INDEX idx_courses_institution ON courses(institution_id);
CREATE INDEX idx_enrollments_institution ON enrollments(institution_id);
CREATE INDEX idx_face_enrollments_student ON face_enrollments(student_id);
CREATE INDEX idx_timetable_lookup ON timetable_slots(department, section, day_of_week);
CREATE INDEX idx_timetable_slots_institution ON timetable_slots(institution_id);
CREATE INDEX idx_risk_events_student ON risk_events(student_id);
CREATE INDEX idx_risk_events_session ON risk_events(session_id);
CREATE INDEX idx_risk_events_level ON risk_events(level);
CREATE INDEX idx_risk_events_created ON risk_events(created_at);
CREATE INDEX idx_risk_events_institution ON risk_events(institution_id);
CREATE INDEX idx_holidays_date ON holidays(holiday_date);
CREATE INDEX idx_holidays_institution ON holidays(institution_id);
CREATE INDEX idx_student_notes_student ON student_notes(student_id);
CREATE INDEX idx_student_notes_author ON student_notes(author_id);
CREATE INDEX idx_student_notes_institution ON student_notes(institution_id);
CREATE INDEX idx_excuses_student ON student_excuses(student_id);
CREATE INDEX idx_excuses_session ON student_excuses(session_id);
CREATE INDEX idx_excuses_course ON student_excuses(course_id);
CREATE INDEX idx_excuses_status ON student_excuses(status);
CREATE INDEX idx_student_excuses_institution ON student_excuses(institution_id);
CREATE INDEX idx_email_log_recipient ON email_notification_log(recipient_user_id);
CREATE INDEX idx_email_log_event ON email_notification_log(event_type);
CREATE INDEX idx_email_notification_log_institution ON email_notification_log(institution_id);
CREATE INDEX idx_lms_sync_logs_started ON lms_sync_logs(started_at);
CREATE INDEX idx_lms_sync_logs_institution ON lms_sync_logs(institution_id);
CREATE INDEX idx_lms_course_mappings_course ON lms_course_mappings(course_id);
CREATE INDEX idx_lms_course_mappings_institution ON lms_course_mappings(institution_id);

COMMIT;
