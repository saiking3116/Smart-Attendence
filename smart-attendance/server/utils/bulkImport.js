const db = require('../db');
const { YEARS, isValidDepartment, isValidSection } = require('./academicStructure');
const { createUserRecord, userIdTaken, emailTaken, ValidationError } = require('./userAdmin');

// CSV format: one file, mixed student/faculty rows. year_of_study and section
// are only meaningful (and required) for student rows — matches the same fields
// the existing single "Add user" form already requires for a student.
const HEADER = ['role', 'id', 'name', 'email', 'department', 'year_of_study', 'section', 'password'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ROWS = 1000;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024; // 2MB — generous for a few thousand rows of this width

const SAMPLE_CSV = [
  HEADER.join(','),
  'student,24UCS999,Sample Student,24ucs999@college.edu,CSE,III,III CSE - B,changeme123',
  'faculty,FAC-9001,Sample Faculty,sample.faculty@college.edu,CSE,,,changeme123',
].join('\n') + '\n';

// Validates one row WITHOUT writing anything. `seenIds`/`seenEmails` catch
// duplicates that only exist within this same CSV (a DB lookup alone can't see those).
// institutionId scopes every uniqueness/validity check to the importing
// admin's own institution — a bulk import can never collide with, or
// validate against, another institution's data.
async function validateRow(institutionId, row, rowNumber, seenIds, seenEmails) {
  const errors = [];
  const role = (row.role || '').trim().toLowerCase();
  const id = (row.id || '').trim();
  const name = (row.name || '').trim();
  const email = (row.email || '').trim();
  const department = (row.department || '').trim();
  const year_of_study = (row.year_of_study || '').trim().toUpperCase();
  const section = (row.section || '').trim();
  const password = row.password || '';

  if (!role) errors.push('Role is required.');
  else if (!['student', 'faculty'].includes(role)) errors.push(`Invalid role "${row.role}" — must be "student" or "faculty".`);

  if (!id) errors.push('ID is required.');
  else {
    if (await userIdTaken(institutionId, id)) errors.push(`ID "${id}" already exists in the database.`);
    if (seenIds.has(id)) errors.push(`Duplicate ID "${id}" — already used by an earlier row in this file.`);
  }

  if (!name) errors.push('Name is required.');
  if (!password) errors.push('Password is required.');

  if (email) {
    if (!EMAIL_RE.test(email)) errors.push(`Invalid email format "${email}".`);
    else {
      if (await emailTaken(email)) errors.push(`Email "${email}" already exists in the database.`);
      if (seenEmails.has(email)) errors.push(`Duplicate email "${email}" — already used by an earlier row in this file.`);
    }
  }

  if (!department) errors.push('Department is required.');
  else if ((role === 'student' || role === 'faculty') && !(await isValidDepartment(institutionId, department))) {
    errors.push(`Department "${department}" does not exist.`);
  }

  if (role === 'student') {
    if (!year_of_study) errors.push('Academic year is required for a student.');
    else if (!YEARS.includes(year_of_study)) errors.push(`Invalid academic year "${row.year_of_study}" — must be one of ${YEARS.join(', ')}.`);
    if (!section) errors.push('Section is required for a student.');
    if (department && year_of_study && section && YEARS.includes(year_of_study) && !(await isValidSection(institutionId, department, year_of_study, section))) {
      errors.push(`That department / academic year / section combination ("${department}", "${year_of_study}", "${section}") does not exist yet.`);
    }
  }

  if (id && !errors.some(e => e.includes('already exists') || e.includes('Duplicate ID'))) seenIds.add(id);
  if (email && !errors.some(e => e.includes('already exists') || e.includes('Duplicate email'))) seenEmails.add(email);

  return {
    row: rowNumber,
    status: errors.length ? 'invalid' : 'valid',
    errors,
    data: { role, user_id: id, name, email: email || null, department, year_of_study: role === 'student' ? year_of_study : null, section: role === 'student' ? section : null, password }
  };
}

// Pure validation pass — never touches the database beyond read-only duplicate
// checks. Safe to call repeatedly for a live preview. Rows are validated one at
// a time (not in parallel) — seenIds/seenEmails is shared mutable state that
// later rows depend on seeing fully updated by earlier ones.
async function validateImportRows(institutionId, rows) {
  const seenIds = new Set();
  const seenEmails = new Set();
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    results.push(await validateRow(institutionId, rows[i], i + 2, seenIds, seenEmails)); // +2: header is row 1, data starts at row 2
  }
  const valid = results.filter(r => r.status === 'valid');
  const invalid = results.filter(r => r.status === 'invalid');
  return {
    results,
    summary: {
      totalRows: results.length,
      validCount: valid.length,
      invalidCount: invalid.length,
      students: valid.filter(r => r.data.role === 'student').length,
      faculty: valid.filter(r => r.data.role === 'faculty').length,
    }
  };
}

// Re-validates fresh (guards against anything that changed between preview and
// confirm — e.g. someone else importing the same ID in the meantime), then writes
// every currently-valid row inside a single transaction. If ANY unexpected
// database error occurs partway through, the transaction rolls the whole batch
// back automatically — no partially-imported users are ever left behind.
// Rows that fail validation are simply skipped and reported, never written.
async function runImport(institutionId, rows, actorUserId, logAudit) {
  const { results } = await validateImportRows(institutionId, rows);
  const valid = results.filter(r => r.status === 'valid');
  const invalid = results.filter(r => r.status === 'invalid');

  const imported = { students: [], faculty: [] };

  try {
    await db.transaction(async () => {
      for (const r of valid) {
        const created = await createUserRecord(institutionId, r.data);
        if (created.role === 'student') imported.students.push(created.user_id);
        else imported.faculty.push(created.user_id);
      }
    });
  } catch (e) {
    // Whatever succeeded inside this transaction has already been rolled back
    // — report the whole batch as failed, nothing was written.
    return {
      ok: false,
      error: 'Import failed and was fully rolled back — no users were created.',
      detail: e.message,
      imported: { students: 0, faculty: 0 },
      skipped: rows.length,
      failedRows: invalid.map(r => ({ row: r.row, errors: r.errors }))
    };
  }

  const timestamp = new Date().toISOString();
  if (logAudit) {
    await logAudit(actorUserId, 'BULK_IMPORT_USERS', 'users', null, {
      studentsImported: imported.students.length, facultyImported: imported.faculty.length,
      skipped: invalid.length, timestamp
    });
  }

  return {
    ok: true,
    imported: { students: imported.students.length, faculty: imported.faculty.length },
    skipped: invalid.length,
    failedRows: invalid.map(r => ({ row: r.row, errors: r.errors })),
    timestamp
  };
}

module.exports = { HEADER, SAMPLE_CSV, MAX_ROWS, MAX_TEXT_LENGTH, validateRow, validateImportRows, runImport };
