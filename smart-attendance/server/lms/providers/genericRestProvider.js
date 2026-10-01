// Real-LMS extension point. This is a best-effort, generic REST scaffold — NOT
// verified against a real Moodle/Canvas/Blackboard instance (each has its own
// auth scheme and endpoint shape: Moodle's web-services API uses a wstoken
// query param and wsfunction dispatch, Canvas uses REST + Bearer tokens with
// paginated /api/v1 endpoints, etc). Wiring up a specific provider means
// replacing the three methods below with that provider's actual API calls;
// the surrounding integration service (lmsService.js) and its interface
// contract stay the same either way. Only ever constructed when LMS_PROVIDER,
// LMS_BASE_URL and LMS_API_KEY are ALL set — see lmsService.getProvider().
async function httpJson(baseUrl, apiKey, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`LMS request failed (${res.status})`);
  return res.json();
}

function createGenericRestProvider({ baseUrl, apiKey, providerLabel }) {
  return {
    name: providerLabel || 'generic',
    async testConnection() {
      try {
        await httpJson(baseUrl, apiKey, '/api/ping');
        return { ok: true, message: `Connected to ${baseUrl}.` };
      } catch (e) {
        // Never leak the API key in the surfaced error — only the failure reason.
        return { ok: false, message: `Could not reach the LMS: ${e.message}` };
      }
    },
    async getCourses() {
      const data = await httpJson(baseUrl, apiKey, '/api/courses');
      // Expected generic shape: [{ id, code, name, term }]. A real provider's
      // response would need mapping into this same {lmsCourseId, code, name, term} shape here.
      return (data.courses || []).map(c => ({ lmsCourseId: String(c.id), code: c.code, name: c.name, term: c.term || null }));
    },
    async getEnrollments(lmsCourseId) {
      const data = await httpJson(baseUrl, apiKey, `/api/courses/${encodeURIComponent(lmsCourseId)}/enrollments`);
      return (data.enrollments || []).map(e => ({ lmsUserId: String(e.userId), rollNumber: e.externalId, name: e.name, role: e.role || 'student' }));
    }
  };
}

module.exports = { createGenericRestProvider };
