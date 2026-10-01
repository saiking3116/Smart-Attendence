const db = require('../db');

// Fixed, per product requirement — not a free-form field, and not derived from
// the database (unlike departments/sections, which reflect real existing data).
const YEARS = ['I', 'II', 'III', 'IV'];

// Batch 6: every function here now takes institutionId as its first argument
// and scopes its query to it — Institution B's departments/sections must
// never appear in Institution A's dropdowns or validation.

// Union of departments that already have real students/faculty AND any
// admin-defined active department (Batch 4's departments table) — the latter
// clause is what lets a brand-new, still-empty department immediately be
// assignable to a user, rather than only appearing here once someone is
// already in it.
async function getDepartments(institutionId) {
  const rows = await db.all(`
    SELECT DISTINCT department FROM (
      SELECT department FROM students WHERE department IS NOT NULL AND institution_id = ?
      UNION SELECT department FROM faculty WHERE department IS NOT NULL AND institution_id = ?
      UNION SELECT code as department FROM departments WHERE status = 'active' AND institution_id = ?
    ) t ORDER BY department
  `, [institutionId, institutionId, institutionId]);
  return rows.map(r => r.department);
}

// Distinct (department, year_of_study, section) triples that already exist among
// real students — this is what "existing section values already present in the
// database" resolves to for the dependent Section dropdown.
async function getSections(institutionId) {
  return db.all(`
    SELECT DISTINCT department, year_of_study, section
    FROM students
    WHERE department IS NOT NULL AND year_of_study IS NOT NULL AND section IS NOT NULL AND institution_id = ?
    ORDER BY department, year_of_study, section
  `, [institutionId]);
}

async function isValidDepartment(institutionId, department) {
  const departments = await getDepartments(institutionId);
  return departments.includes(department);
}

async function isValidSection(institutionId, department, year_of_study, section) {
  const sections = await getSections(institutionId);
  return sections.some(s => s.department === department && s.year_of_study === year_of_study && s.section === section);
}

module.exports = { YEARS, getDepartments, getSections, isValidDepartment, isValidSection };
