const bcrypt = require('bcryptjs');
const db = require('../db');
const { YEARS, isValidDepartment, isValidSection } = require('./academicStructure');

// Thrown for any row-level problem (bad input, duplicate, invalid department/section)
// — always a 400/409-shaped user error, never a genuine server fault.
class ValidationError extends Error {}

// user_id is only unique WITHIN an institution (Batch 6) — scoped accordingly.
// email is intentionally left globally unique (unchanged) — the spec did not
// ask for per-institution email scoping, and a person having one email across
// institutions is not a scenario this app needs to support.
async function userIdTaken(institutionId, user_id) {
  return !!(await db.get('SELECT 1 FROM users WHERE user_id = ? AND institution_id = ?', [user_id, institutionId]));
}
async function emailTaken(email) {
  return !!email && !!(await db.get('SELECT 1 FROM users WHERE email = ?', [email]));
}

// The single place that creates a user + its role-specific profile row. Used by
// both the existing single-user "Add user" endpoint and bulk CSV import, so the
// two paths can never validate or write differently from one another.
async function createUserRecord(institutionId, { user_id, name, email, password, role, department, year_of_study, section }) {
  user_id = (user_id || '').trim();
  name = (name || '').trim();
  email = (email || '').trim() || null;
  role = (role || '').trim().toLowerCase();
  department = (department || '').trim() || null;
  year_of_study = (year_of_study || '').trim().toUpperCase() || null;
  section = (section || '').trim() || null;

  if (!user_id || !name || !password || !role) throw new ValidationError('user_id, name, password and role are required.');
  if (!['student', 'faculty', 'admin'].includes(role)) throw new ValidationError('Invalid role.');
  if (await userIdTaken(institutionId, user_id)) throw new ValidationError(`A user with ID ${user_id} already exists.`);
  if (await emailTaken(email)) throw new ValidationError(`A user with email ${email} already exists.`);

  if (role === 'student') {
    if (!department || !year_of_study || !section) throw new ValidationError('Department, Academic Year and Section are required for a student.');
    if (!YEARS.includes(year_of_study)) throw new ValidationError('Invalid academic year.');
    if (!(await isValidSection(institutionId, department, year_of_study, section))) throw new ValidationError('That department / academic year / section combination does not exist.');
  } else if (role === 'faculty') {
    if (!department) throw new ValidationError('Department is required for faculty.');
    if (!(await isValidDepartment(institutionId, department))) throw new ValidationError('Invalid department.');
  }

  const hash = bcrypt.hashSync(password, 8);
  const info = await db.run(
    `INSERT INTO users (institution_id,user_id,name,email,password_hash,role,department,year_of_study,section,status) VALUES (?,?,?,?,?,?,?,?,?,'active')`,
    [institutionId, user_id, name, email, hash, role, department, role === 'student' ? year_of_study : null, section]
  );
  const newUserId = info.lastInsertRowid;

  if (role === 'student') {
    await db.run(
      `INSERT INTO students (institution_id, user_id, roll_number, name, department, year_of_study, section, semester, face_enrolled) VALUES (?,?,?,?,?,?,?,5,FALSE)`,
      [institutionId, newUserId, user_id, name, department, year_of_study, section]
    );
  } else if (role === 'faculty') {
    await db.run(
      `INSERT INTO faculty (institution_id, user_id, employee_id, name, department) VALUES (?,?,?,?,?)`,
      [institutionId, newUserId, user_id, name, department]
    );
  }
  return { id: newUserId, user_id, role };
}

module.exports = { createUserRecord, userIdTaken, emailTaken, ValidationError };
