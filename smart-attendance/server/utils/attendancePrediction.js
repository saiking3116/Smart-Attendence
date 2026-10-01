// Batch 5 — Predictive Attendance Analytics.
//
// This is NOT a trained machine-learning model. The dataset behind this app
// (per-student attendance rows for one term, with no historical labeled
// outcomes such as "did this student actually end the term below 75%") is
// far too small to train or validate a real classifier, and fabricating an
// "AI accuracy" number for it would be dishonest. Instead this is a
// transparent, explainable, rule-based statistical model: every input is a
// real, already-computed attendance statistic, every output comes with a
// plain-language reason, and the same rules run every time for the same
// data — nothing here is a black box.
//
// IMPORTANT: this module only ever READS attendance rows (via
// analytics.getStudentAttendanceRows). It never marks, modifies, or deletes
// an attendance record — predictions are decision support only. Attendance
// records remain fully authoritative regardless of what this module returns.
//
// Also distinct from server/utils/riskEngine.js: riskEngine.js scores a
// single check-in ATTEMPT for proxy/fraud likelihood (device/location/speed
// signals). This module scores a student's attendance TRAJECTORY over time
// for the risk of falling below the attendance threshold. Different question,
// different inputs — do not conflate the two "risk" concepts in the UI.
const { THRESHOLD, classesNeededFor75, getStudentAttendanceRows } = require('./analytics');

const MIN_CLASSES_FOR_PREDICTION = 3;
const MIN_CLASSES_FOR_TREND = 6;
const CONSECUTIVE_ABSENCE_ESCALATION = 3;

// improving / declining / stable / insufficient, comparing the earlier half
// of the counted classes to the more recent half — the exact comparison
// analytics.js's studentInsights() already does for its own trend sentence,
// reused here rather than re-derived.
function classifyTrend(rows) {
  if (rows.length < MIN_CLASSES_FOR_TREND) return 'insufficient';
  const mid = Math.floor(rows.length / 2);
  const pct = (arr) => arr.length ? Math.round((arr.filter(r => r.status !== 'absent').length / arr.length) * 100) : 0;
  const delta = pct(rows.slice(mid)) - pct(rows.slice(0, mid));
  if (delta >= 5) return 'improving';
  if (delta <= -5) return 'declining';
  return 'stable';
}

// length of the current run of consecutive absences at the end of the
// (oldest->newest) sequence — a student who just missed several classes in a
// row is a stronger emerging risk than the overall percentage alone shows.
function consecutiveRecentAbsences(rows) {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].status === 'absent') streak++;
    else break;
  }
  return streak;
}

// Core scoring function: rows must already be the excuse-aware counted
// sequence (oldest->newest), e.g. from analytics.getStudentAttendanceRows.
function predictRisk(rows) {
  const total = rows.length;
  const present = rows.filter(r => r.status !== 'absent').length;

  if (total < MIN_CLASSES_FOR_PREDICTION) {
    return {
      level: 'insufficient',
      pct: total ? Math.round((present / total) * 100) : 0,
      totalClasses: total, present,
      trend: 'insufficient',
      consecutiveAbsences: 0,
      classesNeededFor75: null,
      explanation: `Not enough attendance data yet (${total} class${total === 1 ? '' : 'es'} recorded) to make a reliable prediction.`,
      recommendation: 'A prediction will appear once more classes have been recorded.'
    };
  }

  const pct = Math.round((present / total) * 100);
  const trend = classifyTrend(rows);
  const streak = consecutiveRecentAbsences(rows);

  // 1. base level from the current percentage — same thresholds analytics.js
  //    already uses for attendanceStatusLabel(), so the two never disagree.
  let level = pct >= THRESHOLD ? 'low' : pct >= THRESHOLD - 10 ? 'medium' : 'high';

  // 2. trend/streak can each move the level, but only by ONE step total — a
  //    comfortably-above-threshold student (e.g. 81%) who has a declining
  //    trend AND a live absence streak should read as Medium, not be pushed
  //    all the way to High by two escalations stacking on top of each other.
  //    De-escalation (improving trend) only applies when there is no
  //    concurrent absence streak still in progress.
  const declining = trend === 'declining';
  const streaking = streak >= CONSECUTIVE_ABSENCE_ESCALATION;
  const improving = trend === 'improving';
  // a declining trend only escalates an otherwise-safe (low) student when
  // they are already close to the threshold — a lone recent absence inside a
  // large safety cushion (e.g. 95%) isn't a meaningful escalation on its own.
  // A live absence streak is a more concrete, immediate signal and escalates
  // regardless of cushion.
  const nearThreshold = pct < THRESHOLD + 5;
  if (improving && level === 'medium' && pct >= THRESHOLD - 5 && !streaking) {
    level = 'low';
  } else if (level === 'low' && ((declining && nearThreshold) || streaking)) {
    level = 'medium';
  } else if (level === 'medium' && (declining || streaking)) {
    level = 'high';
  }

  const reasons = [];
  reasons.push(pct >= THRESHOLD
    ? `attendance is ${pct}%, at or above the ${THRESHOLD}% requirement`
    : `attendance is ${pct}%, below the ${THRESHOLD}% requirement`);
  if (trend === 'declining') reasons.push('a declining recent trend');
  else if (trend === 'improving') reasons.push('an improving recent trend');
  else if (trend === 'stable') reasons.push('a stable recent trend');
  if (streak >= CONSECUTIVE_ABSENCE_ESCALATION) reasons.push(`${streak} consecutive recent classes missed`);

  const first = reasons[0];
  const explanation = reasons.length > 1
    ? `${first.charAt(0).toUpperCase()}${first.slice(1)}, with ${reasons.slice(1).join(' and ')}.`
    : `${first.charAt(0).toUpperCase()}${first.slice(1)}.`;

  const need = classesNeededFor75(present, total);
  let recommendation;
  if (level === 'low') {
    recommendation = pct >= THRESHOLD ? "You're on track — keep attending consistently." : 'Continue attending regularly to stay above the requirement.';
  } else if (level === 'medium') {
    recommendation = need.reachable
      ? `Attend the next ${need.needed} class${need.needed === 1 ? '' : 'es'} to reach ${THRESHOLD}%.`
      : 'Attend upcoming classes consistently and consider speaking with your faculty advisor.';
  } else {
    recommendation = need.reachable
      ? `Attendance needs immediate attention — attend the next ${need.needed} consecutive class${need.needed === 1 ? '' : 'es'} to reach ${THRESHOLD}%, and consider speaking with your faculty advisor.`
      : 'Reaching the required attendance is not achievable within the next 30 classes at this rate — please speak with your faculty advisor as soon as possible.';
  }

  return {
    level, pct, totalClasses: total, present, trend, consecutiveAbsences: streak,
    classesNeededFor75: need, explanation, recommendation
  };
}

// Convenience wrapper: fetch + score a student's overall (or single-course)
// prediction in one call.
async function predictForStudent(studentId, courseId) {
  const rows = await getStudentAttendanceRows(studentId, courseId);
  return predictRisk(rows);
}

module.exports = {
  MIN_CLASSES_FOR_PREDICTION, MIN_CLASSES_FOR_TREND, CONSECUTIVE_ABSENCE_ESCALATION,
  classifyTrend, consecutiveRecentAbsences, predictRisk, predictForStudent
};
