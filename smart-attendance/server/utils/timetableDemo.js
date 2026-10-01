// Static, presentation-only weekly timetable content for departments that don't
// have a fully seeded timetable_slots grid in the database (only CSE / "III CSE - B"
// does, wired to the real automatic-session attendance demo). This is illustrative
// content for the Timetable workspace only — it never creates a class_sessions row
// or an attendance record, and carries no course_id, so "Mark Attendance" on one of
// these periods simply lands on the normal Attendance page with its existing
// empty-state handling.
//
// Room lookup for the *real* CSE courses (used because timetable_slots itself has
// no room column — adding one wasn't worth a schema change for a demo timetable).
const CSE_ROOM_BY_COURSE_CODE = {
  CS301: 'CS-201', // Operating Systems
  CS302: 'CS-202', // Data Structures
  CS303: 'CS-203', // Web Technologies
  CS304: 'CS-204', // Database Systems
  CS305: 'CS-204', // Machine Learning
};

const DEMO_SUBJECTS = {
  IT: [
    { code: 'IT302', name: 'Data Structures', faculty: 'Dr. Priyanka', room: 'IT Lab 1' },
    { code: 'IT303', name: 'Database Management Systems', faculty: 'Prof. Karthik Raja', room: 'IT-201' },
    { code: 'IT304', name: 'Operating Systems', faculty: 'Prof. Meenakshi', room: 'IT-202' },
    { code: 'IT301', name: 'Cloud Computing', faculty: 'Dr. Priyanka', room: 'IT Lab 2' },
    { code: 'IT305', name: 'Computer Networks', faculty: 'Prof. Raghavan', room: 'IT-203' },
  ],
  ECE: [
    { code: 'EC301', name: 'Digital Signal Processing', faculty: 'Prof. Elumalai', room: 'ECE-101' },
    { code: 'EC302', name: 'Electronic Devices & Circuits', faculty: 'Dr. Lakshmi', room: 'ECE Lab 1' },
    { code: 'EC303', name: 'Communication Systems', faculty: 'Prof. Sundaram', room: 'ECE-102' },
    { code: 'EC304', name: 'Microprocessors & Microcontrollers', faculty: 'Dr. Vijayan', room: 'ECE Lab 2' },
    { code: 'EC305', name: 'Control Systems', faculty: 'Prof. Elumalai', room: 'ECE-103' },
  ],
  MECH: [
    { code: 'ME301', name: 'Thermodynamics', faculty: 'Dr. Bhuvaneswari', room: 'MECH-101' },
    { code: 'ME302', name: 'Fluid Mechanics', faculty: 'Prof. Sivakumar', room: 'MECH-102' },
    { code: 'ME303', name: 'Manufacturing Technology', faculty: 'Dr. Bhuvaneswari', room: 'MECH Workshop' },
    { code: 'ME304', name: 'Machine Design', faculty: 'Prof. Anand', room: 'MECH-103' },
    { code: 'ME305', name: 'Strength of Materials', faculty: 'Prof. Sivakumar', room: 'MECH Lab 1' },
  ],
  CIVIL: [
    { code: 'CE301', name: 'Structural Analysis', faculty: 'Prof. Ganesh', room: 'CIVIL-101' },
    { code: 'CE302', name: 'Surveying', faculty: 'Dr. Revathi', room: 'CIVIL Lab 1' },
    { code: 'CE303', name: 'Concrete Technology', faculty: 'Prof. Ganesh', room: 'CIVIL-102' },
    { code: 'CE304', name: 'Geotechnical Engineering', faculty: 'Prof. Mahalingam', room: 'CIVIL-103' },
    { code: 'CE305', name: 'Environmental Engineering', faculty: 'Dr. Revathi', room: 'CIVIL Lab 2' },
  ],
};

const DAY_TEMPLATE = [
  { start: '09:00', end: '10:00', type: 'class' },
  { start: '10:00', end: '11:00', type: 'class' },
  { start: '11:15', end: '12:15', type: 'class' },
  { start: '12:15', end: '13:00', type: 'lunch', label: 'Lunch Break' },
  { start: '13:00', end: '14:00', type: 'class' },
  { start: '14:00', end: '15:00', type: 'class' },
];

// Saturdays run a shorter, class-only half day — a common pattern at Indian
// colleges — rather than repeating the full Mon-Fri template.
const SATURDAY_TEMPLATE = [
  { start: '09:00', end: '10:00', type: 'class' },
  { start: '10:00', end: '11:00', type: 'class' },
  { start: '11:15', end: '12:15', type: 'class' },
];

// Builds a Mon-Sat (1-6) grid for a department with no real timetable_slots data.
// Subjects rotate across the week so the grid doesn't look identical every day.
function buildDemoWeekGrid(department) {
  const subjects = DEMO_SUBJECTS[department];
  if (!subjects) return [];
  const rows = [];
  let classSlot = 0;
  for (let day = 1; day <= 6; day++) {
    classSlot = 0;
    const template = day === 6 ? SATURDAY_TEMPLATE : DAY_TEMPLATE;
    for (const period of template) {
      if (period.type !== 'class') {
        rows.push({
          day_of_week: day, start_time: period.start, end_time: period.end,
          period_type: period.type, label: period.label || null,
          course_name: null, course_code: null, faculty_name: null, room: null
        });
        continue;
      }
      const subj = subjects[(day - 1 + classSlot) % subjects.length];
      rows.push({
        day_of_week: day, start_time: period.start, end_time: period.end,
        period_type: 'class', label: null,
        course_name: subj.name, course_code: subj.code, faculty_name: subj.faculty, room: subj.room
      });
      classSlot++;
    }
  }
  return rows;
}

module.exports = { CSE_ROOM_BY_COURSE_CODE, buildDemoWeekGrid };
