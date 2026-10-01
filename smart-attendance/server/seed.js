require('dotenv').config();
const bcrypt = require('bcryptjs');
// This script is a SQLite-only dev/demo tool (uses sqlite_sequence and
// prepared-statement objects reused across loops) — it always seeds the
// SQLite database directly via the raw better-sqlite3 connection, regardless
// of DB_ENGINE, since a Postgres target has no seed/reset concept here and
// this reset is far too destructive to ever run against a live database.
const db = require('./db/sqliteEntry').raw;

// WARNING (Batch 6): this wipes these tables with no institution filter at
// all — every institution's data, not just the demo one. This script remains
// what it always was: a full fresh-install/demo-reset tool for a database
// that has ONLY the demo institution in it. It must never be run against a
// live database that has real multi-institution data — there is no
// institution-scoped variant of this reset, by design (a destructive
// operation like this has no legitimate per-institution use case here).
function reset() {
  const tables = ['audit_logs','notifications','attendance','class_sessions','enrollments','timetable_slots','app_settings','courses','faculty','students','users'];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  for (const t of tables) db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
}

// Batch 6: every seeded row belongs to this one demo institution (reuses the
// same 'DEMO' row the live migration already created — INSERT OR IGNORE means
// this is a safe no-op if it already exists).
function ensureDemoInstitution() {
  db.prepare(`INSERT OR IGNORE INTO institutions (id, code, name, status) VALUES (1, 'DEMO', 'Demo Institution', 'active')`).run();
  return 1;
}

function hash(pw) { return bcrypt.hashSync(pw, 8); }

// Demo classroom location — CS block, a real-looking college coordinate. Every
// seeded CSE session is anchored here so the GPS attendance demo has something
// meaningful to validate against.
const DEMO_CLASSROOM = { lat: 13.0827, lng: 80.2707 }; // Chennai, TN
const DEMO_RADIUS_M = 100;

function fmtDate(d) { return d.toISOString().slice(0, 10); }

// walk backwards from "today", returning up to n weekday dates spaced every `everyNDays`
function pastWeekdays(count, everyNDays = 2) {
  const dates = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 1); // start from yesterday so "today" stays free for the live demo session
  let steps = 0;
  while (dates.length < count && steps < count * everyNDays + 40) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) dates.push(fmtDate(cursor));
    cursor.setDate(cursor.getDate() - everyNDays);
    steps++;
  }
  return dates.reverse();
}

function weightedStatus(targetPct) {
  // returns 'present' | 'late' | 'absent' biased towards targetPct attendance
  const r = Math.random() * 100;
  if (r < targetPct) {
    return Math.random() < 0.08 ? 'late' : 'present';
  }
  return 'absent';
}

function methodFor(status) {
  if (status === 'absent') return 'manual';
  const r = Math.random();
  if (r < 0.55) return 'face';
  if (r < 0.85) return 'qr';
  return 'manual';
}

function confidenceFor(method) {
  if (method === 'face') return +(93 + Math.random() * 6.9).toFixed(1);
  if (method === 'qr') return null;
  return null;
}

function run() {
  console.log('Resetting database...');
  reset();
  const institutionId = ensureDemoInstitution();

  const insertUser = db.prepare(`INSERT INTO users (institution_id,user_id,name,email,password_hash,role,department,section,status)
    VALUES (@institution_id,@user_id,@name,@email,@password_hash,@role,@department,@section,@status)`);
  const insertStudent = db.prepare(`INSERT INTO students (institution_id,user_id,roll_number,name,department,section,semester,face_enrolled)
    VALUES (@institution_id,@user_id,@roll_number,@name,@department,@section,@semester,@face_enrolled)`);
  const insertFaculty = db.prepare(`INSERT INTO faculty (institution_id,user_id,employee_id,name,department) VALUES (@institution_id,@user_id,@employee_id,@name,@department)`);
  const insertCourse = db.prepare(`INSERT INTO courses (institution_id,course_code,course_name,department,semester,section,faculty_id,status)
    VALUES (@institution_id,@course_code,@course_name,@department,@semester,@section,@faculty_id,'active')`);
  const insertEnroll = db.prepare(`INSERT OR IGNORE INTO enrollments (institution_id, student_id, course_id) VALUES (?,?,?)`);
  const insertSession = db.prepare(`INSERT INTO class_sessions (institution_id,course_id,faculty_id,date,start_time,end_time,room,status,room_lat,room_lng,allowed_radius_m)
    VALUES (?,?,?,?,?,?,?,'closed',?,?,?)`);
  const insertAttendance = db.prepare(`INSERT OR IGNORE INTO attendance (institution_id,student_id,session_id,status,method,confidence,marked_at,remarks)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insertNotif = db.prepare(`INSERT INTO notifications (recipient_id,title,message,type,read,created_at) VALUES (?,?,?,?,?,?)`);
  const insertAudit = db.prepare(`INSERT INTO audit_logs (user_id,action,entity,entity_id,metadata,institution_id) VALUES (?,?,?,?,?,?)`);

  console.log('Creating admin...');
  const adminUserId = insertUser.run({
    institution_id: institutionId,
    user_id: 'ADM-009', name: 'Shanmugam', email: 'shanmugam.admin@college.edu',
    password_hash: hash('admin123'), role: 'admin', department: 'CSE', section: 'Department Incharge', status: 'active'
  }).lastInsertRowid;

  console.log('Creating faculty...');
  const facultyDefs = [
    { code: 'FAC-1042', name: 'Dr. Saravanan', dept: 'CSE' },
    { code: 'FAC-1051', name: 'Prof. Meena', dept: 'CSE' },
    { code: 'FAC-1063', name: 'Prof. Arvind', dept: 'CSE' },
    { code: 'FAC-1077', name: 'Dr. Kavitha', dept: 'CSE' },
    { code: 'FAC-1089', name: 'Prof. Rajesh', dept: 'CSE' },
    { code: 'FAC-2010', name: 'Dr. Priyanka', dept: 'IT' },
    { code: 'FAC-3015', name: 'Prof. Elumalai', dept: 'ECE' },
    { code: 'FAC-4020', name: 'Dr. Bhuvaneswari', dept: 'MECH' },
    { code: 'FAC-5025', name: 'Prof. Ganesh', dept: 'CIVIL' },
  ];
  const facultyIds = {};
  for (const f of facultyDefs) {
    const uid = insertUser.run({
      institution_id: institutionId,
      user_id: f.code, name: f.name, email: f.name.toLowerCase().replace(/[^a-z]+/g, '.') + '@college.edu',
      password_hash: hash('faculty123'), role: 'faculty', department: f.dept, section: null, status: 'active'
    }).lastInsertRowid;
    const fid = insertFaculty.run({ institution_id: institutionId, user_id: uid, employee_id: f.code, name: f.name, department: f.dept }).lastInsertRowid;
    facultyIds[f.code] = fid;
  }

  console.log('Creating CSE courses...');
  const cseSection = 'III CSE - B';
  const cseCourseDefs = [
    { code: 'CS301', name: 'Operating Systems', fac: 'FAC-1051' },
    { code: 'CS302', name: 'Data Structures', fac: 'FAC-1089' },
    { code: 'CS303', name: 'Web Technologies', fac: 'FAC-1063' },
    { code: 'CS304', name: 'Database Systems', fac: 'FAC-1077' },
    { code: 'CS305', name: 'Machine Learning', fac: 'FAC-1042' },
  ];
  const cseCourseIds = {};
  for (const c of cseCourseDefs) {
    const id = insertCourse.run({
      institution_id: institutionId,
      course_code: c.code, course_name: c.name, department: 'CSE', semester: 5, section: cseSection,
      faculty_id: facultyIds[c.fac]
    }).lastInsertRowid;
    cseCourseIds[c.code] = id;
  }

  console.log('Creating CSE students...');
  const firstNames = ['Aakash','Deepika','Ferwin','Harini','Saibalaji','Naveen','Sushant','Tarun','Meera','Kavya',
    'Arjun','Divya','Karthik','Lavanya','Manoj','Nithya','Pranav','Ramya','Suresh','Vidya',
    'Yogesh','Anitha','Bala','Chitra','Dinesh','Eswari','Gokul','Hema','Ishaan','Janani'];
  const lastInitials = ['R','M','J','S','A','K','N','T','P','B','V','G','D','L','C'];
  const students = [];
  for (let i = 0; i < 30; i++) {
    const roll = `24UCS${201 + i}`;
    const name = `${firstNames[i]} ${lastInitials[i % lastInitials.length]}`;
    let tier;
    if (i < 8) tier = { min: 85, max: 95 };
    else if (i < 18) tier = { min: 75, max: 84 };
    else if (i < 25) tier = { min: 65, max: 74 };
    else tier = { min: 45, max: 64 };
    const target = tier.min + Math.random() * (tier.max - tier.min);
    students.push({ roll, name, target });
  }
  const studentIds = {};
  for (const s of students) {
    const uid = insertUser.run({
      institution_id: institutionId,
      user_id: s.roll, name: s.name, email: s.roll.toLowerCase() + '@college.edu',
      password_hash: hash('student123'), role: 'student', department: 'CSE', section: cseSection, status: 'active'
    }).lastInsertRowid;
    const sid = insertStudent.run({
      institution_id: institutionId,
      user_id: uid, roll_number: s.roll, name: s.name, department: 'CSE', section: cseSection,
      semester: 5, face_enrolled: 1
    }).lastInsertRowid;
    studentIds[s.roll] = { id: sid, target: s.target, name: s.name, uid };
    for (const cid of Object.values(cseCourseIds)) insertEnroll.run(institutionId, sid, cid);
  }

  console.log('Generating CSE class sessions and attendance (6 weeks)...');
  const timesByCode = {
    CS301: ['11:00', '11:50'], CS302: ['10:00', '10:50'], CS303: ['14:00', '14:50'],
    CS304: ['12:00', '12:50'], CS305: ['09:00', '09:50']
  };
  const roomsByCode = { CS301: 'CS-201', CS302: 'CS-202', CS303: 'CS-203', CS304: 'CS-204', CS305: 'CS-204' };

  const cseLastSessionId = {};
  for (const c of cseCourseDefs) {
    const dates = pastWeekdays(16, 2); // 16 sessions over ~ last weeks, every 2 weekdays
    const facId = facultyIds[c.fac];
    const courseId = cseCourseIds[c.code];
    for (const date of dates) {
      const [st, et] = timesByCode[c.code];
      const sessionId = insertSession.run(institutionId, courseId, facId, date, st, et, roomsByCode[c.code], DEMO_CLASSROOM.lat, DEMO_CLASSROOM.lng, DEMO_RADIUS_M).lastInsertRowid;
      cseLastSessionId[c.code] = sessionId;
      for (const s of students) {
        const rec = studentIds[s.roll];
        // Machine Learning target is intentionally rougher for some students to mirror the original demo narrative
        let effTarget = rec.target;
        if (c.code === 'CS305') effTarget = Math.max(35, rec.target - 12);
        const status = weightedStatus(effTarget);
        const method = methodFor(status);
        const confidence = confidenceFor(method);
        const markedAt = status === 'absent' ? null : `${date} ${st}:${String(Math.floor(Math.random()*9)).padStart(2,'0')}`;
        insertAttendance.run(institutionId, rec.id, sessionId, status, method, confidence, markedAt || `${date} ${st}`, null);
      }
    }
  }

  console.log('Seeding other departments for institution-wide analytics...');
  const otherDepts = [
    { dept: 'IT', fac: 'FAC-2010', courseCode: 'IT301', courseName: 'Cloud Computing', avg: 81, section: 'III IT - A' },
    { dept: 'ECE', fac: 'FAC-3015', courseCode: 'EC301', courseName: 'Digital Signal Processing', avg: 78, section: 'III ECE - A' },
    { dept: 'MECH', fac: 'FAC-4020', courseCode: 'ME301', courseName: 'Thermodynamics', avg: 73, section: 'III MECH - A' },
    { dept: 'CIVIL', fac: 'FAC-5025', courseCode: 'CE301', courseName: 'Structural Analysis', avg: 76, section: 'III CIVIL - A' },
  ];
  let rollCounter = { IT: 401, ECE: 601, MECH: 801, CIVIL: 901 };
  const deptPrefix = { IT: '24UIT', ECE: '24UEC', MECH: '24UME', CIVIL: '24UCE' };
  for (const od of otherDepts) {
    const courseId = insertCourse.run({
      institution_id: institutionId,
      course_code: od.courseCode, course_name: od.courseName, department: od.dept, semester: 5,
      section: od.section, faculty_id: facultyIds[od.fac]
    }).lastInsertRowid;
    const deptStudents = [];
    for (let i = 0; i < 8; i++) {
      const roll = `${deptPrefix[od.dept]}${rollCounter[od.dept] + i}`;
      const name = `${firstNames[(i * 3) % firstNames.length]} ${lastInitials[(i * 5) % lastInitials.length]}`;
      const target = Math.max(45, Math.min(96, od.avg + (Math.random() * 16 - 8)));
      const uid = insertUser.run({
        institution_id: institutionId,
        user_id: roll, name, email: roll.toLowerCase() + '@college.edu', password_hash: hash('student123'),
        role: 'student', department: od.dept, section: od.section, status: 'active'
      }).lastInsertRowid;
      const sid = insertStudent.run({
        institution_id: institutionId,
        user_id: uid, roll_number: roll, name, department: od.dept, section: od.section, semester: 5, face_enrolled: 1
      }).lastInsertRowid;
      insertEnroll.run(institutionId, sid, courseId);
      deptStudents.push({ id: sid, target });
    }
    const dates = pastWeekdays(12, 3);
    for (const date of dates) {
      const sessionId = insertSession.run(institutionId, courseId, facultyIds[od.fac], date, '10:00', '10:50', `${od.dept}-101`, null, null, DEMO_RADIUS_M).lastInsertRowid;
      for (const s of deptStudents) {
        const status = weightedStatus(s.target);
        const method = methodFor(status);
        insertAttendance.run(institutionId, s.id, sessionId, status, method, confidenceFor(method), `${date} 10:0${Math.floor(Math.random()*9)}`, null);
      }
    }
  }

  const cseRolls = students.map(s => s.roll);
  // one flagged (anomaly) example - duplicate attempt recorded in audit
  insertAudit.run(studentIds['24UCS230'].uid, 'DUPLICATE_ATTEMPT_BLOCKED', 'attendance', cseLastSessionId['CS305'], JSON.stringify({ reason: 'Attendance already marked for this session', roll: '24UCS230' }), institutionId);

  console.log('Seeding college location + attendance timetable for III CSE - B...');
  const { setSetting } = require('./utils/sessionAuto');
  setSetting(institutionId, 'location_config', { lat: DEMO_CLASSROOM.lat, lng: DEMO_CLASSROOM.lng, radius_m: DEMO_RADIUS_M });

  // Sample grid from the spec, with the 4 real, non-lab CSE courses substituted in
  // for the sample's placeholder subject names (DBMS/DAA/Programming/Software
  // Engineering) since a class-type slot must reference a real course row for
  // automatic session creation to work. Machine Learning (CS305) is deliberately
  // left out of the fixed weekly grid — it stays available via its own 6-week
  // history above and is the natural course to use for ad-hoc "insert a slot
  // covering right now" manual testing of the automatic attendance flow.
  const insertSlot = db.prepare(`
    INSERT INTO timetable_slots (institution_id, department, section, day_of_week, start_time, end_time, course_id, label, period_type)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const timetableGrid = [
    { start: '08:00', end: '09:00', label: 'Study', type: 'study' },
    { start: '09:00', end: '10:00', course: 'CS301', type: 'class' },
    { start: '10:00', end: '11:00', course: 'CS302', type: 'class' },
    { start: '11:00', end: '11:15', label: 'Break', type: 'break' },
    { start: '11:15', end: '13:00', course: 'CS303', type: 'class' },
    { start: '13:00', end: '14:00', label: 'Lunch Break', type: 'lunch' },
    { start: '14:00', end: '16:00', course: 'CS304', type: 'class' },
    { start: '16:00', end: '16:15', label: 'Break', type: 'break' },
    { start: '16:15', end: '17:30', label: 'Study/Lab', type: 'study' },
  ];
  for (let dayOfWeek = 1; dayOfWeek <= 5; dayOfWeek++) { // Mon-Fri
    for (const slot of timetableGrid) {
      insertSlot.run(
        institutionId, 'CSE', cseSection, dayOfWeek, slot.start, slot.end,
        slot.course ? cseCourseIds[slot.course] : null,
        slot.label || null, slot.type
      );
    }
  }

  console.log('Seeding notifications...');
  const demoStudentRoll = '24UCS205';
  const demoRec = studentIds[demoStudentRoll];
  insertNotif.run(demoRec.uid, 'Welcome to Smart Attendance', 'Your account is set up. Enroll your face for faster check-ins.', 'info', 1, new Date(Date.now() - 6*86400000).toISOString());
  insertNotif.run(demoRec.uid, 'Attendance marked successfully', 'You were marked Present for Machine Learning via Face ID.', 'success', 0, new Date(Date.now() - 3600000).toISOString());
  insertNotif.run(demoRec.uid, 'Attendance below threshold', 'Your attendance in Machine Learning has fallen below 75%.', 'warning', 0, new Date(Date.now() - 86400000).toISOString());
  // low attendance students get a warning notification
  for (const roll of cseRolls) {
    const rec = studentIds[roll];
    if (rec.target < 75) {
      insertNotif.run(rec.uid, 'Attendance below threshold', `Your overall attendance has fallen below the 75% requirement. Please attend upcoming classes.`, 'warning', 0, new Date(Date.now() - 2*86400000).toISOString());
    }
  }
  insertNotif.run(adminUserId, 'Weekly analytics ready', 'Institution-wide attendance analytics for this week are ready to review.', 'info', 0, new Date().toISOString());

  console.log('Seeding audit trail...');
  insertAudit.run(adminUserId, 'SEED_DATABASE', 'system', null, JSON.stringify({ note: 'Initial demo data generated' }), institutionId);
  insertAudit.run(adminUserId, 'CREATE_USER', 'users', demoRec.uid, JSON.stringify({ roll: demoStudentRoll }), institutionId);

  console.log('\nSeed complete.');
  console.log('Demo credentials:');
  console.log('  Student : 24UCS205 / student123');
  console.log('  Faculty : FAC-1042 / faculty123');
  console.log('  Admin   : ADM-009 / admin123');
}

run();
