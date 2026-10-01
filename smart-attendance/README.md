# Smart Attendance Management Platform

A full-stack, identity-verified attendance system for colleges — real backend, real
database, real authentication. Built on top of the original Smart Attendance UI
concept (dark navy/green "Attendance OS" design), now wired end-to-end to a
Node/Express/SQLite API instead of mock data.

Every button in the app performs a real operation: logins are checked against
hashed passwords, attendance is written to SQLite, QR codes are generated and
expire server-side, exports produce real files, and the same database is the
single source of truth for the Student, Faculty and Admin views.

---

## 1. Features

**Student**
- Live dashboard: overall %, subject-wise breakdown, today's classes, recent activity — all computed from real attendance rows
- Mark attendance via **real GPS verification** (Haversine distance against the classroom location, validated server-side) combined with **real face verification** (face-api.js descriptor comparison against an enrolled reference, validated server-side) — or by scanning a faculty-generated QR code with the camera
- One-time **face enrollment** flow that captures live camera samples and stores a numeric descriptor (never a photo)
- Duplicate check-ins are blocked server-side
- Full attendance history with subject/status/method filters, pagination, and CSV export
- Smart insights (weakest/strongest subject, trend vs prior weeks, classes missed) and a "classes needed to reach 75%" calculator
- Notification center with unread badge

**Faculty**
- Dashboard: classes today, weekly average attendance, students below 75%, anomaly alerts
- Take Attendance: start/close a live session, **set the classroom GPS location** (from the faculty's own device) to require location-verified check-in, generate a self-expiring rotating QR code, live roster with manual present/absent toggles and per-student 📍/👤 verification badges
- Reports: date/course-filtered weekly trend, subject breakdown, follow-up list with one-click "Notify" and CSV/PDF export

**Admin**
- Institution dashboard: totals, department comparison, weekly trend, low-attendance count, method distribution
- Full user management: search/filter/paginate, add/edit/disable, password reset
- Course management: add/edit/deactivate, assign faculty
- Rule-based Attendance Anomaly Detection (duplicate attempts, expired QR reuse) — explicitly labeled as rule-based, not AI
- Audit trail viewer (who changed what, when)
- Excel and PDF exports of institution-wide attendance

**Everywhere**
- Light and dark mode, toggled from a button on the login screen and in the app topbar. The choice is saved (`localStorage`) and applied before first paint, and defaults to the OS-level preference (`prefers-color-scheme`) the first time you open the app.

---

## 2. Tech stack

- **Backend:** Node.js, Express, better-sqlite3 (synchronous SQLite driver), JWT auth, bcrypt password hashing
- **Frontend:** Single-page vanilla JS app (no build step) served as static files by Express
- **Exports:** `exceljs` (Excel), `pdfkit` (PDF), hand-rolled CSV
- **QR:** `qrcodejs` to render, `jsQR` to decode from the live camera feed (both loaded from a CDN in the browser)
- **Face verification:** `face-api.js` (loaded from a CDN) for on-device face detection + 128-d descriptor extraction; the server does the actual match with a plain euclidean-distance comparison — no ML runs server-side
- **GPS verification:** browser `navigator.geolocation`, server-side Haversine distance check

No cloud services, no build tooling — just `npm install` and run.

---

## 3. Folder structure

```
smart-attendance/
├── client/
│   ├── index.html        # UI shell (preserves the original visual design)
│   └── app.js             # all frontend logic — calls the REST API only
├── server/
│   ├── server.js          # Express entry point, serves client/ + /api routes
│   ├── db.js               # SQLite connection + schema + auto-migration
│   ├── seed.js              # demo data generator
│   ├── middleware/auth.js    # JWT auth + role guard + audit logging helper
│   ├── routes/
│   │   ├── auth.js, students.js, faculty.js, admin.js,
│   │   └── attendance.js, sessions.js, notifications.js
│   └── utils/
│       ├── analytics.js     # attendance %, risk level, insight generation
│       ├── qr.js              # session QR token generation/expiry
│       ├── geo.js              # Haversine distance + server-side GPS validation
│       ├── face.js              # face descriptor comparison (euclidean distance)
│       └── exportUtils.js        # CSV / Excel / PDF builders
├── database/                # attendance.db is created here at runtime (gitignored)
├── package.json
├── .env.example
└── README.md
```

---

## 4. Installation & running it locally

Requirements: Node.js 18+ (tested on Node 22).

```bash
cd smart-attendance
npm install         # installs backend deps
cp .env.example .env # optional — defaults already work
npm run seed         # creates database/attendance.db and fills it with demo data
npm run dev           # starts the server
```

Then open **http://localhost:3000** in your browser.

One-liner for a fresh machine:

```bash
npm run setup && npm run dev
```

To wipe and regenerate demo data at any time (e.g. before a live demo), just run
`npm run seed` again — it resets every table and reseeds from scratch.

> The QR-code and face-verification libraries (`qrcodejs`, `jsQR`, `face-api.js`,
> plus the face-api.js model weights) are loaded from a CDN at runtime, so the
> browser needs internet access the first time the page loads (they're cached
> after that). Everything else runs fully offline against the local SQLite file.

> Face and GPS attendance both require the browser to be on **HTTPS or
> `localhost`** — browsers block camera and geolocation access on plain HTTP
> for any other host. `http://localhost:3000` works out of the box.

> If you already have a `database/attendance.db` from before this update, it
> is **not** wiped — `db.js` automatically adds the new GPS/face columns and
> the `face_enrollments` table to your existing database the next time the
> server starts, without touching existing rows. Run `npm run seed` only if
> you want fresh demo data with classroom GPS coordinates pre-configured.

---

## 5. Demo credentials

| Role    | ID         | Password    |
|---------|------------|-------------|
| Student | `24UCS205` | `student123`|
| Faculty | `FAC-1042` | `faculty123`|
| Admin   | `ADM-009`  | `admin123`  |

All other seeded students use the pattern `24UCS2xx` / `student123` (roll numbers
201–230), and other seeded faculty use `FAC-10xx` / `faculty123`. The seed script
prints the full credential summary when it runs.

---

## 6. API overview

All endpoints except `/api/auth/login` require `Authorization: Bearer <token>`.

```
POST   /api/auth/login              — returns { token, user, profile }
GET    /api/auth/me
POST   /api/auth/logout

GET    /api/students/dashboard
GET    /api/students/attendance     — ?subject=&status=&method=&from=&to=&page=
GET    /api/students/export         — CSV download
GET    /api/students/face/status     — { enrolled, sampleCount, updatedAt }
POST   /api/students/face/enroll      — { descriptors: [[128 floats], ...] } (min. 3 samples)

GET    /api/faculty/dashboard
GET    /api/faculty/courses
GET    /api/faculty/reports         — ?course_id=&from=&to=
POST   /api/faculty/notify/:roll
GET    /api/faculty/export/csv | /pdf

POST   /api/sessions                — { course_id } → opens/reuses today's session
PUT    /api/sessions/:id/location    — { latitude, longitude, radius_m } → sets the classroom GPS anchor
POST   /api/sessions/:id/qr          — rotates + returns a fresh QR token
GET    /api/sessions/:id/roster       — includes location_verified / distance_from_classroom / face_verified per student
POST   /api/sessions/:id/close        — marks unrecorded students absent

GET    /api/attendance/active         — sessions open for the logged-in student (+ faceEnrolled, location_required)
POST   /api/attendance/verify          — { session_id, method: 'face'|'demo', descriptor?, latitude?, longitude?, accuracy? }
                                            → server recomputes both the GPS distance and the face-descriptor match; never trusts client-side verdicts
POST   /api/attendance/qr               — { token } — independent of face/GPS
PUT    /api/attendance/:id               — faculty manual override

GET    /api/admin/dashboard
GET    /api/admin/users, POST, PUT /:id, DELETE /:id, POST /:id/reset-password
GET    /api/admin/courses, POST, PUT /:id, DELETE /:id
GET    /api/admin/analytics/proxy
GET    /api/admin/audit-logs
GET    /api/admin/export/excel | /pdf

GET    /api/notifications
PUT    /api/notifications/:id/read | /read-all
```

---

## 7. Architecture notes

- **Single source of truth:** every number shown in the UI is computed from the
  `attendance` / `class_sessions` tables at request time — there is no
  duplicated frontend dataset. Marking attendance from any role immediately
  changes what every other role sees on their next fetch.
- **Auth:** passwords are hashed with bcrypt; sessions use short-lived JWTs
  (12h) sent as a Bearer token. Disabling a user immediately blocks login and
  any subsequent API calls (middleware checks `status` on every request).
- **Duplicate prevention:** the `attendance` table has a `UNIQUE(student_id,
  session_id)` constraint, and the server also checks explicitly and logs a
  `DUPLICATE_ATTEMPT_BLOCKED` audit event before returning a 409.

### How attendance verification works
Marking attendance from the student side supports three real, working methods:
1. **Face + GPS Verification:** the student enrolls their face once (`Enroll
   Face` — captures 5 live samples via face-api.js in the browser, averages
   them into a 128-value descriptor, and stores only that descriptor, never a
   photo). During attendance, the browser detects exactly one face, extracts
   a live descriptor, and gets the device's GPS coordinates via
   `navigator.geolocation`. Both are sent to the server as raw data — **the
   server, not the browser, decides whether they pass**: it recomputes the
   euclidean distance between the live and enrolled descriptors (matched if
   ≤ 0.6, face-api.js's own standard threshold) and the Haversine distance to
   the session's configured classroom location (matched if within the
   configured radius, default 100m). A client never sends a "verified: true"
   flag that the server trusts. The confidence percentage shown is
   mathematically derived from the real descriptor distance — never random.
2. **Demo Verification (fallback):** if the browser has no camera, face-api.js
   fails to load, or the student hasn't enrolled yet, attendance falls back to
   a plain camera-presence check with GPS still enforced if the session
   requires it — clearly labeled as a fallback, not a face match.
3. **QR Code:** the student's camera decodes a QR (via `jsQR`) rendered by the
   faculty device, and the token is sent to `/api/attendance/qr`. This path is
   fully independent of face/GPS and continues to work on its own.

### How GPS attendance works
Faculty click "Set classroom location" on the Take Attendance page, which uses
*their* device's `navigator.geolocation.getCurrentPosition()` to anchor the
session to a real coordinate with a configurable radius (demo default 100m).
When a student then verifies, the server calculates the Haversine distance
between the student's reported coordinates and that anchor and only accepts
the check-in if it's within radius — this calculation always happens
server-side (`server/utils/geo.js`), never trusted from the client. If a
session has no classroom location configured, GPS isn't required for it (so
existing/legacy sessions keep working). Permission-denied and
location-unavailable are surfaced with distinct, honest error messages rather
than silently falling back.

### How QR attendance works
Faculty click "Generate QR" for an open session. The server creates a random
24-character token tied to that session, stores it with an expiry
(`QR_TOKEN_TTL_SECONDS`, default 25s), and the client auto-requests a fresh
token right before the old one expires — so a screenshotted QR stops working
within seconds. Scanning validates: token exists, session is open, token not
expired, student is enrolled, and no duplicate attendance already exists.

### Attendance Anomaly Detection
A **rule-based** (not AI) system flags: duplicate attendance attempts for the
same session, QR tokens used after expiry, and failed GPS/face verification
attempts. All are written to `audit_logs` and surfaced on the Admin →
Analytics page and in Faculty dashboard alerts.

---

## 8. Known limitations

- Face verification runs face-api.js entirely in the browser (detection +
  descriptor extraction); the server only compares two numeric vectors. This
  is a genuine, working browser-based prototype — explicitly **not**
  enterprise-grade biometric security, and the UI says so.
- GPS accuracy depends entirely on the device (a laptop's IP-based location
  can be off by kilometers; a phone's GPS chip is much tighter) — the 100m
  demo radius is generous specifically to accommodate that.
- Face and GPS both require **HTTPS or `localhost`** — browsers block camera
  and geolocation on plain HTTP for any other origin.
- QR/face-api.js libraries and model weights load from a CDN, so first load
  needs internet.
- The "edit user" modal fetches up to 100 users to find the one being edited
  (fine for a demo-sized dataset; would need a dedicated `GET /users/:id`
  endpoint at real scale).
- Single SQLite file — fine for a local demo, not meant for concurrent
  production traffic.
- No email/SMS delivery for notifications — they're in-app only.

## 9. Future improvements

- Liveness detection (blink/head-turn challenge) to harden face verification
  against a printed photo or a video replay
- A background job to re-average a student's face descriptor over time as
  enrollment samples accumulate
- Push/email delivery for low-attendance notifications
- Per-endpoint rate limiting middleware
- Multi-section / multi-semester course rollover tooling for admins

---

## 10. Five-minute demo flow

1. **Login as Faculty** (`FAC-1042` / `faculty123`) → **Take Attendance**,
   select Machine Learning, **Start session**, then **Set classroom
   location** (grant location permission when prompted) — point out this uses
   the faculty device's real GPS, not a hardcoded number.
2. **Login as Student** (`24UCS205` / `student123`) → show the dashboard (real
   %, subject bars, today's live Machine Learning session). Go to **Mark
   Attendance**. If not yet enrolled, click **Enroll Face** and walk through
   the 5-sample capture (grant camera permission). Then click **Start
   Verification** and narrate the sequence out loud as it happens: 📍
   location detected → 👤 face detected & matched → ✓ attendance marked —
   note the confidence shown is the real computed similarity, not a canned
   number. Watch the dashboard update immediately after.
3. Try it again from a location far from the classroom (or use the QR
   fallback instead) to show a **rejected** GPS or face check — the error
   message is specific ("outside the 100m allowed radius", "does not match
   your enrolled identity").
4. **Back to Faculty** → the roster now shows 📍/👤 badges next to the
   student who just checked in. Click **Generate QR** and show the
   countdown/auto-refresh, toggle a student manually, then **Close session**
   and show absentees get auto-marked.
5. Go to **Reports**, filter by date, click **Notify** on a low-attendance
   student, then **Export PDF** to show a real downloaded file.
6. **Login as Admin** (`ADM-009` / `admin123`) → **Overview** for
   institution-wide KPIs and department comparison, **Users & Courses** to add
   a user live, and **Analytics** to show the Attendance Anomaly Detection
   ring (now including failed GPS/face attempts), audit trail, and Excel
   export.
7. Log back in as the same student from step 2 and show the notification they
   received from the faculty's "Notify" click in step 5 — proving every role
   shares one live database.

---

## 11. Files changed in this update (GPS + face verification)

**New files**
- `server/utils/geo.js` — Haversine distance + server-side GPS validation
- `server/utils/face.js` — face descriptor comparison (euclidean distance)

**Modified**
- `server/db.js` — added `room_lat`/`room_lng`/`allowed_radius_m` to
  `class_sessions`; added `latitude`/`longitude`/`accuracy`/
  `location_verified`/`distance_from_classroom`/`face_verified`/
  `face_distance` to `attendance`; added the `face_enrollments` table; added
  an automatic migration step so existing databases gain the new columns
  without losing data
- `server/seed.js` — anchors seeded CSE sessions to a demo classroom GPS
  coordinate with a 100m radius
- `server/routes/attendance.js` — `/verify` now requires and server-validates
  a real face descriptor + GPS coordinates for the `face` method (no more
  `Math.random()` confidence); `/active` now reports `faceEnrolled` and
  `location_required`
- `server/routes/students.js` — added `GET /face/status` and
  `POST /face/enroll`
- `server/routes/sessions.js` — added `PUT /:id/location`; `/roster` now
  returns each student's `location_verified`/`distance_from_classroom`/
  `face_verified`
- `client/index.html` — fixed a duplicate `<style>` tag that broke the login
  page's CSS; added the face-api.js `<script>` tag
- `client/app.js` — rebuilt the student scan flow into the 3-step
  Location → Face → Marked sequence, added the face enrollment modal, added
  `getGeolocation()`/`ensureFaceModels()`/`captureFaceDescriptor()` helpers,
  added the faculty "Set classroom location" button and roster verification
  badges

## 12. How to test the new face + GPS functionality locally

1. `npm run seed && npm run dev`, open `http://localhost:3000`.
2. Log in as faculty (`FAC-1042`/`faculty123`) → **Take Attendance** → Machine
   Learning already has an open session from the seed data → click **Set
   classroom location** and allow the browser's location prompt (on a laptop
   this uses IP/Wi-Fi geolocation, which is imprecise but sufficient for the
   100m demo radius since the seeded session is pre-anchored near the same
   coordinate).
3. Log in as a student (`24UCS205`/`student123` or any other `24UCS2xx`/
   `student123`) → **Mark Attendance** → **Enroll Face** → allow camera
   access and hold still through the 5 samples.
4. Click **Start Verification** → allow location access → watch the
   real-time status text move through the location and face steps → confirm
   the result panel shows a genuine distance-in-meters and a confidence
   percentage that is never a round/suspicious number like exactly 95.0 or
   97.4.
5. To see a **rejection**, either deny the location prompt (expect "Location
   permission is required for GPS attendance"), or open the browser dev tools
   and edit the request in-flight / use a VPN to change your reported
   location (expect "...outside the 100m allowed radius"), or log in as a
   student who hasn't enrolled and try Face + GPS anyway (it will show the
   enrollment prompt instead of the verify button).
6. Confirm QR still works independently: faculty **Generate QR**, scan it
   with a second student's session (or a second browser tab logged in as a
   different student) — no camera/GPS prompts are required for that path.
7. As admin, open **Analytics → Audit trail** and see the new
   `SESSION_LOCATION_SET`, `FACE_ENROLLED`, `LOCATION_VERIFICATION_FAILED`,
   and `FACE_VERIFICATION_FAILED` events alongside the existing ones.
