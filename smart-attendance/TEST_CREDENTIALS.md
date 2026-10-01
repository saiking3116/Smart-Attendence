# Smart Attendance — Test Credentials Reference

This is a **human-readable reference only**. The database is the source of truth — the
application does not read this file, and nothing here needs to stay in sync for the
app to work. It reflects the seed dataset in `server/seed.js`, which is what the
current test environment is built from.

All passwords below are the actual configured values (not invented) — each is shared
by every account of that role, since `seed.js` hashes the same literal string for all
accounts of a given role. Spot-checked live against the running server on 2026-08-28
(`ADM-009`, `FAC-5025`, `24UCE908` all confirmed working).

Do not change these login IDs or passwords without updating this document to match.

---

## 1. ADMIN ACCOUNTS

| Name | Login ID | Password | Department | Section |
|---|---|---|---|---|
| Shanmugam | `ADM-009` | `admin123` | CSE | Department Incharge |

---

## 2. FACULTY ACCOUNTS

Password for every faculty account: **`faculty123`**

| Name | Login ID | Department | Assigned Course |
|---|---|---|---|
| Dr. Saravanan | `FAC-1042` | CSE | CS305 – Machine Learning |
| Prof. Meena | `FAC-1051` | CSE | CS301 – Operating Systems |
| Prof. Arvind | `FAC-1063` | CSE | CS303 – Web Technologies |
| Dr. Kavitha | `FAC-1077` | CSE | CS304 – Database Systems |
| Prof. Rajesh | `FAC-1089` | CSE | CS302 – Data Structures |
| Dr. Priyanka | `FAC-2010` | IT | IT301 – Cloud Computing |
| Prof. Elumalai | `FAC-3015` | ECE | EC301 – Digital Signal Processing |
| Dr. Bhuvaneswari | `FAC-4020` | MECH | ME301 – Thermodynamics |
| Prof. Ganesh | `FAC-5025` | CIVIL | CE301 – Structural Analysis |

---

## 3. STUDENT ACCOUNTS

Password for every student account: **`student123`**

### CSE — Section III CSE - B (30 students)
Enrolled in all 5 CSE courses: CS301 Operating Systems, CS302 Data Structures, CS303 Web Technologies, CS304 Database Systems, CS305 Machine Learning.

| Login ID | Name | Login ID | Name |
|---|---|---|---|
| `24UCS201` | Aakash R | `24UCS216` | Nithya R |
| `24UCS202` | Deepika M | `24UCS217` | Pranav M |
| `24UCS203` | Ferwin J | `24UCS218` | Ramya J |
| `24UCS204` | Harini S | `24UCS219` | Suresh S |
| `24UCS205` | Saibalaji A | `24UCS220` | Vidya A |
| `24UCS206` | Naveen K | `24UCS221` | Yogesh K |
| `24UCS207` | Sushant N | `24UCS222` | Anitha N |
| `24UCS208` | Tarun T | `24UCS223` | Bala T |
| `24UCS209` | Meera P | `24UCS224` | Chitra P |
| `24UCS210` | Kavya B | `24UCS225` | Dinesh B |
| `24UCS211` | Arjun V | `24UCS226` | Eswari V |
| `24UCS212` | Divya G | `24UCS227` | Gokul G |
| `24UCS213` | Karthik D | `24UCS228` | Hema D |
| `24UCS214` | Lavanya L | `24UCS229` | Ishaan L |
| `24UCS215` | Manoj C | `24UCS230` | Janani C |

> `24UCS205` (Saibalaji A) has completed a real face enrollment via the browser and is the recommended account for testing the weekly face-verification cache.

### IT — Section III IT - A (8 students)
Enrolled in: IT301 – Cloud Computing.

| Login ID | Name |
|---|---|
| `24UIT401` | Aakash R |
| `24UIT402` | Harini K |
| `24UIT403` | Sushant V |
| `24UIT404` | Kavya R |
| `24UIT405` | Karthik K |
| `24UIT406` | Nithya V |
| `24UIT407` | Suresh R |
| `24UIT408` | Anitha K |

### ECE — Section III ECE - A (8 students)
Enrolled in: EC301 – Digital Signal Processing.

| Login ID | Name |
|---|---|
| `24UEC601` | Aakash R |
| `24UEC602` | Harini K |
| `24UEC603` | Sushant V |
| `24UEC604` | Kavya R |
| `24UEC605` | Karthik K |
| `24UEC606` | Nithya V |
| `24UEC607` | Suresh R |
| `24UEC608` | Anitha K |

### MECH — Section III MECH - A (8 students)
Enrolled in: ME301 – Thermodynamics.

| Login ID | Name |
|---|---|
| `24UME801` | Aakash R |
| `24UME802` | Harini K |
| `24UME803` | Sushant V |
| `24UME804` | Kavya R |
| `24UME805` | Karthik K |
| `24UME806` | Nithya V |
| `24UME807` | Suresh R |
| `24UME808` | Anitha K |

### CIVIL — Section III CIVIL - A (8 students)
Enrolled in: CE301 – Structural Analysis.

| Login ID | Name |
|---|---|
| `24UCE901` | Aakash R |
| `24UCE902` | Harini K |
| `24UCE903` | Sushant V |
| `24UCE904` | Kavya R |
| `24UCE905` | Karthik K |
| `24UCE906` | Nithya V |
| `24UCE907` | Suresh R |
| `24UCE908` | Anitha K |

---

## 4. SUBJECT TESTING MATRIX

One row per course, so any subject can be tested end-to-end without hunting for the right accounts. The test student listed is the recommended representative for that department — every other student in the same department/section works identically (see Section 3).

| Department | Section | Subject | Faculty | Faculty Login | Faculty Password | Test Student | Student Login | Student Password |
|---|---|---|---|---|---|---|---|---|
| CSE | III CSE - B | CS301 – Operating Systems | Prof. Meena | `FAC-1051` | `faculty123` | Saibalaji A | `24UCS205` | `student123` |
| CSE | III CSE - B | CS302 – Data Structures | Prof. Rajesh | `FAC-1089` | `faculty123` | Saibalaji A | `24UCS205` | `student123` |
| CSE | III CSE - B | CS303 – Web Technologies | Prof. Arvind | `FAC-1063` | `faculty123` | Saibalaji A | `24UCS205` | `student123` |
| CSE | III CSE - B | CS304 – Database Systems | Dr. Kavitha | `FAC-1077` | `faculty123` | Saibalaji A | `24UCS205` | `student123` |
| CSE | III CSE - B | CS305 – Machine Learning | Dr. Saravanan | `FAC-1042` | `faculty123` | Saibalaji A | `24UCS205` | `student123` |
| IT | III IT - A | IT301 – Cloud Computing | Dr. Priyanka | `FAC-2010` | `faculty123` | Aakash R | `24UIT401` | `student123` |
| ECE | III ECE - A | EC301 – Digital Signal Processing | Prof. Elumalai | `FAC-3015` | `faculty123` | Aakash R | `24UEC601` | `student123` |
| MECH | III MECH - A | ME301 – Thermodynamics | Dr. Bhuvaneswari | `FAC-4020` | `faculty123` | Aakash R | `24UME801` | `student123` |
| CIVIL | III CIVIL - A | CE301 – Structural Analysis | Prof. Ganesh | `FAC-5025` | `faculty123` | Aakash R | `24UCE901` | `student123` |

> `24UCS205` is used as the CSE representative (rather than a different name per row) because it's the one account with a real face enrollment already completed — useful for testing beyond just GPS/QR.

---

## Timetable coverage (as of 2026-08-28)

All 5 department/section combinations now have identical-shape weekly timetables (Mon–Fri, 08:00–17:30 — Study / 4 class periods / 2 breaks / lunch / Study-Lab):

| Department / Section | Class-period course | Slots |
|---|---|---|
| CSE / III CSE - B | CS301, CS302, CS303, CS304 (4 distinct courses, across the day) | 45 (pre-existing, unchanged) |
| IT / III IT - A | IT301 – Cloud Computing (repeated across all 4 class periods — it's the department's only course) | 45 (added) |
| ECE / III ECE - A | EC301 – Digital Signal Processing (repeated) | 45 (added) |
| MECH / III MECH - A | ME301 – Thermodynamics (repeated) | 45 (added) |
| CIVIL / III CIVIL - A | CE301 – Structural Analysis (repeated) | 45 (added) |

Verified live on 2026-08-28 ~11:56 IST: a student from each of the 5 departments correctly saw their department's course/faculty as the current class via `GET /api/attendance/active`, with no duplicate slots and the CSE timetable unchanged (`created_at` timestamps confirmed unchanged).

## College GPS location (shared by all departments)

Configured in Admin → Timetable → Settings: **13.0827, 80.2707** (Chennai), 100m radius. A device testing from outside this radius will correctly receive `GPS_OUT_OF_RANGE` / `LOCATION_VERIFICATION_FAILED` — update this via the Settings panel if testing from elsewhere.
