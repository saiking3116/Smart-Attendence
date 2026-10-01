// Demo/Mock LMS provider — the default, always-available provider. Simulates a
// small external course catalog with realistic network latency so the demo UI
// feels like it's really talking to something, but it never leaves this
// process. Course codes deliberately match REAL local course codes (from
// server/seed.js) so syncCourses() demonstrates genuine match-by-code
// behavior against the real courses table, exactly like a real integration would.
const db = require('../../db');

const NAME = 'mock';

const MOCK_COURSES = [
  { lmsCourseId: 'lms-cs301', code: 'CS301', name: 'Operating Systems (LMS)', term: 'Fall 2026' },
  { lmsCourseId: 'lms-cs302', code: 'CS302', name: 'Data Structures (LMS)', term: 'Fall 2026' },
  { lmsCourseId: 'lms-cs304', code: 'CS304', name: 'Database Systems (LMS)', term: 'Fall 2026' },
  { lmsCourseId: 'lms-it301', code: 'IT301', name: 'Cloud Computing (LMS)', term: 'Fall 2026' },
  { lmsCourseId: 'lms-unknown', code: 'ZZ999', name: 'Unmapped Demo Course (LMS)', term: 'Fall 2026' }, // deliberately has no local match — demonstrates the "skipped" sync path
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testConnection() {
  await sleep(350); // simulated latency — makes the demo feel real without being slow
  return { ok: true, message: 'Mock LMS reachable (simulated connection — no network call was made).' };
}

async function getCourses() {
  await sleep(250);
  return MOCK_COURSES;
}

// Echoes back the REAL local roster for the mapped course (so a normal sync is
// a safe, correct no-op — everyone's already enrolled), plus one synthetic
// "new" enrollment for the first course only, to demonstrate what a genuinely
// new LMS-side enrollment looks like when it reaches syncEnrollments().
async function getEnrollments(lmsCourseId) {
  await sleep(250);
  const course = MOCK_COURSES.find(c => c.lmsCourseId === lmsCourseId);
  if (!course) return [];
  const localCourse = await db.get('SELECT id FROM courses WHERE course_code = ?', [course.code]);
  const roster = localCourse
    ? await db.all(`
        SELECT s.roll_number, s.name FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = ?
      `, [localCourse.id])
    : [];
  const enrollments = roster.map(r => ({ lmsUserId: `lms-${r.roll_number}`, rollNumber: r.roll_number, name: r.name, role: 'student' }));
  if (lmsCourseId === 'lms-cs301') {
    enrollments.push({ lmsUserId: 'lms-ext-demo-1', rollNumber: '24UCS999', name: 'LMS Demo Student (not enrolled locally)', role: 'student' });
  }
  return enrollments;
}

module.exports = { name: NAME, testConnection, getCourses, getEnrollments };
