# Smart Attendance

An integrated web, mobile, and AI/ML-based attendance management system that records attendance only after validating the student's identity, location, and time.

## Overview

**Smart Attendance** solves the critical problem of proxy attendance and manual roll-call inefficiency in higher education. Rather than relying on single-factor verification, this system validates three factors for every check-in:

1. **Identity** – Face recognition using 128-dimensional descriptors (face-api.js)
2. **Location** – Server-side GPS geofence validation (Haversine formula)
3. **Time** – Open class sessions or short-lived rotating QR codes (25-second expiry)

Traditional attendance systems are slow (5-10 minutes per class), prone to clerical errors, and vulnerable to proxy attendance. Smart Attendance runs on devices students already own—smartphones and laptops—requires no special hardware, and delivers real-time analytics for early intervention.

---

## Key Features

### ✅ Attendance Marking Methods
- **Face + GPS Verification** – On-device face recognition combined with server-side geofence check
- **Rotating QR Codes** – Auto-expiring tokens that refresh every 25 seconds (screenshot-proof)
- **Manual Override** – Faculty can toggle student status directly on the live roster

### 📱 Role-Based Dashboards
- **Student** – Overall & subject-wise attendance, risk prediction, weekly reports, excuse requests
- **Faculty** – Start/close sessions, live roster, set classroom GPS, reports with CSV/PDF export
- **Admin** – Institution-wide analytics, department comparison, user & course management
- **Super Admin** – Multi-institution oversight, platform configuration

### 🤖 AI/ML & Analytics
- **Face Enrollment** – Capture 3-5 face samples; averaged into a 128-d reference descriptor
- **Risk Engine** – Transparent, rule-based scoring (0-100) for every attendance attempt
- **Attendance Prediction** – Rule-based classifier identifying students at risk of falling below 75%
- **Smart Insights** – Trend analysis, weakest/strongest subjects, consecutive absence tracking

### 🔒 Security & Compliance
- **JWT Sessions** – 12-hour token validity with role-based access control (RBAC)
- **Password Hashing** – bcrypt with salt
- **Two-Factor Authentication** – Time-based One-Time Passwords (TOTP) + recovery codes
- **Rate Limiting** – Per-IP login attempts (8/5min), per-user verification (20/5min)
- **Audit Logging** – Complete trail of logins, user changes, failed verifications, exports
- **Privacy-First** – Only numeric descriptors stored; no photographs kept

### 📊 Reports & Exports
- Real-time percentage computation
- Weekly attendance trends
- CSV, Excel, PDF exports
- E-mail notifications & automated weekly reports
- Per-student excuse handling (faculty approval/rejection)

### 🏢 Multi-Institution Support
- Tenant isolation – every table scoped to an institution
- PostgreSQL migration scripts for scalable deployments
- LMS integration framework (built-in mock provider + generic REST provider)

---

## Technology Stack

### Backend
- **Runtime** – Node.js 18+ (tested on Node.js 22)
- **Framework** – Express.js 4
- **Database** – SQLite (development) / PostgreSQL (production)
- **Auth** – JWT (jsonwebtoken), bcryptjs, otplib (TOTP)
- **PDF/Excel** – pdfkit, exceljs
- **Rate Limiting** – express-rate-limit
- **Email** – nodemailer
- **Database Drivers** – better-sqlite3, pg

### Frontend (Web)
- **HTML5, CSS3, Vanilla JavaScript (SPA)**
- **Face Recognition** – face-api.js (TensorFlow.js)
- **QR Scanning** – jsQR, qrcodejs
- **Theme Support** – Light/dark mode toggle
- **Responsive Design** – Works on desktop and mobile browsers

### Mobile App
- **Framework** – React Native with Expo & TypeScript
- **Navigation** – React Navigation
- **Camera** – expo-camera (QR scanning, face capture)
- **Location** – expo-location (GPS verification)
- **Secure Storage** – expo-secure-store (access tokens)
- **QR Display** – react-native-qrcode-svg

---

## Architecture

```
┌─────────────────────────────────────────┐
│   Presentation Layer                     │
│  ┌──────────────────┬──────────────────┐ │
│  │  Web Dashboard   │  Mobile App      │ │
│  │  (HTML/CSS/JS)   │ (React Native)   │ │
│  └──────────────────┴──────────────────┘ │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   Application Layer (Node.js/Express)    │
│  REST API with Middleware                │
│  ┌────────────────────────────────────┐ │
│  │ JWT Auth · RBAC · Rate Limit       │ │
│  │ Audit Logging · Error Handling     │ │
│  └────────────────────────────────────┘ │
│                                          │
│  Service Modules:                        │
│  • Attendance & Session Management       │
│  • Face & GPS Verification               │
│  • Risk Engine & Prediction               │
│  • Reports & Notifications                │
│  • LMS Integration & Compliance           │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   Data Layer                             │
│  SQLite (dev) / PostgreSQL (prod)        │
│  • Normalized relational schema (~20TB)  │
│  • Foreign keys & constraints enforced   │
│  • Institution-scoped data (multi-tenant)│
└──────────────────────────────────────────┘
```

---

## System Requirements

### Hardware
| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **Server** | Dual-core, 4GB RAM, 2GB disk | Intel i3/Ryzen 3+, 8GB RAM |
| **Client** | Modern browser + internet | Smartphone (Android/iOS) or laptop |
| **Network** | Wi-Fi or mobile data | Campus LAN (low latency) |

### Software
| Item | Version |
|------|---------|
| **Node.js** | 18.0+ (tested on 22) |
| **Database** | SQLite 3 or PostgreSQL 12+ |
| **Browser** | Chrome, Edge, Firefox (HTTPS or localhost for camera/GPS) |
| **Mobile OS** | Android 8.0+ or iOS 12.0+ |

---

## Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/yourusername/smart-attendance.git
cd smart-attendance
```

### 2. Backend Setup
```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Configure environment variables
# FACE_MATCH_THRESHOLD=0.6
# QR_TOKEN_TTL_SECONDS=25
# DATABASE_URL=sqlite:./attendance.db (or PostgreSQL connection string)
# JWT_SECRET=your-secret-key
# SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (for email)
# TOTP_WINDOW=1 (for 2FA tolerance)

# Initialize database
npm run db:init

# (Optional) Load demo data
npm run db:seed

# Start the server
npm start
# Server runs on http://localhost:3000
```

### 3. Web Frontend
The web dashboard is served by the same Express server at `http://localhost:3000`.

### 4. Mobile App
```bash
# Install Expo CLI (if not already installed)
npm install -g expo-cli

# Navigate to mobile directory
cd mobile

# Install dependencies
npm install

# Start with Expo Go
expo start

# Scan QR code with Expo Go app (or choose Android/iOS emulator)
```

---

## Usage

### Student Workflow
1. **Login** with roll number and password (optional 2FA)
2. **Enroll Face** (one-time) – capture 3-5 samples via webcam
3. **Mark Attendance**
   - **Option A** – Allow camera & location → system validates face + GPS
   - **Option B** – Scan QR code displayed by faculty
4. **View Dashboard** – overall/subject-wise percentages, predictions, weekly reports
5. **Submit Excuses** – for absences; faculty reviews and approves/rejects

### Faculty Workflow
1. **Login** with faculty ID and password
2. **Start Class Session**
   - Select course
   - (Optional) Set classroom GPS coordinates & radius
   - Session status changes to "open"
3. **Display QR Code** – rotating token auto-refreshes every 25 seconds
4. **Monitor Live Roster** – see attendance as students mark
5. **Manual Override** – toggle any student to present/late/absent
6. **Close Session** – auto-marks absent those without attendance
7. **Generate Reports** – view trends, export CSV/PDF, notify low-attendance students
8. **Review Excuses** – approve or reject with remarks

### Admin Workflow
1. **User Management** – bulk import from CSV, reset passwords, manage 2FA
2. **Academic Structure** – define departments, courses, timetables, holidays
3. **Analytics Dashboard** – institution totals, department comparison, risk heatmap
4. **Audit Trail** – view all access logs, changes, and exports
5. **Compliance** – export personal data, configure data retention

---

## Database Schema

### Principal Tables

| Table | Purpose |
|-------|---------|
| `institutions` | Colleges/organizations using the platform |
| `users` | Login credentials, role, status |
| `students`, `faculty` | Profile data (roll no., department, year) |
| `courses`, `departments` | Academic structure |
| `enrollments` | Student enrollment in courses |
| `class_sessions` | One row per class session (date, time, QR token, GPS) |
| `attendance` | Attendance records (status, method, confidence, GPS distance) |
| `face_enrollments` | 128-d face descriptor, sample count, last verification |
| `risk_events` | Risk score & reasons for every attempt |
| `audit_logs` | Complete trail of logins, user changes, exports |
| `notifications` | In-app & email notifications |
| `student_excuses` | Excuse requests with approval status |

**Constraints enforced:**
- Unique constraint on (student, session) – prevents duplicate attendance
- Foreign keys – referential integrity across all tables
- Check constraints – valid enum values (role, status, method)

---

## REST API Overview

All endpoints (except `/api/auth/login` and `/api/auth/register`) require a valid Bearer token.

### Authentication
- `POST /api/auth/login` – User login (returns JWT)
- `POST /api/auth/2fa/verify-login` – Verify TOTP code
- `POST /api/auth/2fa/enroll` – Enable 2FA (returns recovery codes)
- `GET /api/auth/me` – Get current user info
- `POST /api/auth/logout` – Revoke token

### Student Endpoints
- `GET /api/students/dashboard` – Overall & subject-wise attendance
- `POST /api/attendance/verify` – Submit face + GPS for verification
- `GET /api/attendance/active` – List active sessions for student's courses
- `POST /api/students/face/enroll` – Enroll face descriptor
- `GET /api/students/excuses` – List student's excuses
- `POST /api/students/excuses` – Submit new excuse

### Faculty Endpoints
- `POST /api/sessions/create` – Start a new class session
- `POST /api/sessions/location` – Set classroom GPS & radius
- `GET /api/sessions/qr` – Get rotating QR token
- `GET /api/sessions/roster` – Live roster with attendance status
- `POST /api/sessions/close` – End class session
- `GET /api/faculty/reports` – Attendance reports with filters
- `GET /api/faculty/risk` – Risk events & anomalies
- `POST /api/faculty/export` – Export to CSV/PDF
- `POST /api/faculty/notify` – Notify a student

### Admin Endpoints
- `GET /api/admin/users` – List users
- `POST /api/admin/users` – Create or bulk import users (CSV)
- `POST /api/admin/courses` – Manage courses
- `GET /api/admin/audit-logs` – Audit trail
- `GET /api/admin/analytics` – Institution-wide analytics
- `POST /api/admin/lms/sync` – Sync with LMS

### Super Admin Endpoints
- `POST /api/super-admin/institutions` – Create institutions
- `PATCH /api/super-admin/institutions/:id` – Activate/deactivate

---

## Testing

### Test Cases Covered

| Scenario | Expected Result |
|----------|-----------------|
| Login with wrong password 8+ times in 5 min | Rejected with "too many requests" |
| Student inside radius with matching face | Attendance recorded as present |
| Student outside allowed radius | Rejected with distance message |
| Different person's face shown | Rejected; risk event stored |
| QR code scanned after 25s expiry | Rejected as expired |
| Same student marks twice for session | Second rejected (HTTP 409) |
| Faculty closes session | Students without record marked absent |
| Student below 75% opens dashboard | Warning & "classes needed" calculator shown |
| Disabled user presents valid token | Request blocked by auth middleware |
| Invalid CSV row imported | Preview shows error; invalid rows skipped |

### Run Tests
```bash
npm test
```

---

## Configuration

Create a `.env` file in the root directory:

```env
# Server
NODE_ENV=development
PORT=3000
JWT_SECRET=your-super-secret-key-change-this

# Database
DATABASE_URL=sqlite:./attendance.db
# or for PostgreSQL:
# DATABASE_URL=postgresql://user:password@localhost:5432/attendance

# Face Recognition
FACE_MATCH_THRESHOLD=0.6

# QR Code
QR_TOKEN_TTL_SECONDS=25

# GPS Geofence
DEFAULT_CAMPUS_LAT=11.9416
DEFAULT_CAMPUS_LNG=79.8405
DEFAULT_GEOFENCE_RADIUS_M=100

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM_EMAIL=noreply@smartattendance.edu

# 2FA (TOTP)
TOTP_WINDOW=1

# Rate Limiting
LOGIN_RATE_LIMIT_WINDOW_MS=300000
LOGIN_RATE_LIMIT_MAX_REQUESTS=8
VERIFY_RATE_LIMIT_MAX_REQUESTS=20

# CORS
CORS_ORIGIN=http://localhost:3000

# Logging
LOG_LEVEL=info
```

---

## Performance Notes

- **Check-in request processing:** < 1 second on typical campus network
- **Face verification:** Cached for 7 days (camera only needed once/week)
- **Location verification:** Re-checked at every attempt
- **Database queries:** Indexed on (student_id, session_id), (course_id, user_id)
- **Scalability:** SQLite suitable for prototypes; switch to PostgreSQL for large deployments

---

## Limitations & Future Work

### Current Limitations
- Face verification is prototype-level (no liveness detection / anti-spoofing yet)
- GPS accuracy weaker indoors; vulnerable to mock-location apps
- Prediction module is rule-based, not ML (data set too small for training)
- Face enrollment/verification available only in web client
- Default SQLite not suitable for 10k+ concurrent users

### Planned Enhancements
- [ ] Liveness detection (blink/head-turn challenge)
- [ ] Anti-spoofing models (photo/video detection)
- [ ] Face verification in mobile app + push notifications
- [ ] Integration with biometric fingerprint devices
- [ ] Trained ML model for at-risk student prediction (when historical data available)
- [ ] Multi-language support
- [ ] Cloud deployment with scheduled background jobs
- [ ] Blockchain audit trail (optional)

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Authors

**Team Members:**
- **Saibalaji A** (24UCS205)
- **Sushant S** (24UCS256)
- **Tarun N** (24UCS262)

**Project Guide:** Dr. Saravanan

**Institution:** Sri Manakula Vinayagar Engineering College, Puducherry

---

## License

This project is licensed under the MIT License – see the `LICENSE` file for details.

---

## Acknowledgments

- Dr. Saravanan (Project Guide)
- Dr. N. Danapaquiame (Head of Department)
- Sri Manakula Vinayagar Engineering College for providing research and development facilities
- Open-source libraries: face-api.js, Express, React Native, Expo, TensorFlow.js

---

## Support & Documentation

- **API Documentation** – See `docs/api-reference.md`
- **Database Schema** – See `docs/database-schema.md`
- **Setup Guide** – See `docs/setup-guide.md`
- **Issues** – Report bugs or feature requests on [GitHub Issues](https://github.com/yourusername/smart-attendance/issues)

---

## Disclaimer

This system is a working prototype for educational purposes. For enterprise deployments, additional security hardening, compliance audits, and testing are recommended. The biometric security (face recognition) is prototype-level and does not claim to be an enterprise-grade biometric solution.

---

**Last Updated:** October 2026  
**Project Status:** Active (College Micro Project – Oct 2026 submission)