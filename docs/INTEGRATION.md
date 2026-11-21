# How the ROF LMS frontend and backend work together

Two independent repositories, deployed separately:

| | Repository | Hosting | Production address |
|---|---|---|---|
| Frontend (Next.js 16) | `ROFFRONTENDTEST` | Netlify | `https://roflms.netlify.app` |
| Backend (NestJS, Prisma) | `ROFBACKENDTEST` | Render (+ Neon PostgreSQL, Cloudflare R2, Resend) | `https://rofbackendtest.onrender.com` |

The same text is kept in both repositories (`INTEGRATION.md` in the frontend,
`docs/INTEGRATION.md` in the backend).

## Request paths

```
Browser ──(same origin)──► Netlify site /api/*  ──CDN proxy──► Render backend /api/v1/*
Browser ──(cross-origin, uploads only)──────────────────────► Render backend /api/v1/*
Backend ──► Resend (e-mail) · Neon (database) · R2 (files)
```

- **API calls** use `/api/v1/...` on the frontend's own origin. Netlify proxies
  them to the backend (`netlify.toml` `[[redirects]]`); locally the rewrite in
  `next.config.ts` does it (`API_PROXY_TARGET`). No CORS is involved.
- **File uploads** (multipart) go straight to the backend
  (`NEXT_PUBLIC_API_UPLOAD_ORIGIN`), because Netlify's proxy limits bodies to
  about 8 MB and the backend accepts up to 50 MB. They send the bearer token
  only (no cookies). The backend allows them through `CORS_ORIGINS`, and the
  frontend's CSP allows that one origin in `connect-src`.
- **Downloads** (`/file` endpoints, CSV exports) go through the proxy with the
  bearer token and are saved from a `blob:` URL.

## Authentication

- `POST /auth/login` returns a 15-minute **access token** (kept in memory by
  the frontend, sent as `Authorization: Bearer`) and sets the **refresh
  cookie** `rof_refresh`: httpOnly, `SameSite=Strict`, path `/api/v1/auth`,
  `Secure` in production. It works because the proxy keeps everything on one
  origin.
- On a 401 the frontend calls `POST /auth/refresh` once (single-flight across
  tabs) and retries; refresh tokens rotate on every use, and reuse revokes the
  session. `POST /auth/logout` ends it; it needs no valid access token (the
  refresh cookie identifies the session), so call it directly, without a
  refresh first, and expect 200 even when there was nothing left to revoke.
- Roles: `STUDENT`, `MENTOR` (shown as "Coach"), `ADMIN`. The backend enforces
  every permission (403 `FORBIDDEN`); the frontend only hides what a role
  cannot use (`GET /me/permissions`).

## Errors

Every backend error has one shape, which the frontend's `ApiError` reads:

```json
{ "statusCode": 400, "error": "Bad Request", "code": "VALIDATION_FAILED",
  "message": "Request validation failed.", "details": ["…"], "requestId": "…" }
```

## Backend capabilities (`GET /api/v1`)

`GET /api/v1` is public and sent with `Cache-Control: no-store`. It returns the
original `name`, `version`, `docs` and `health` fields unchanged. Backends that
support it also return `capabilities`:

```json
{
  "name": "ROF LMS API", "version": "1.0.0", "docs": "/api/docs", "health": "/health",
  "capabilities": {
    "schemaVersion": 1,
    "roles": ["STUDENT", "TEACHER", "MENTOR", "HEAD_COACH", "ADMIN", "SUPER_ADMIN"],
    "features": ["permissionScopes", "schoolAdministration", "schoolAffiliations",
                 "schoolReferenceRequired"]
  }
}
```

### Detecting the backend: LEGACY, NEW or UNKNOWN

Classify every `GET /api/v1` attempt as exactly one of three results.

| Result | All of these hold |
|---|---|
| **LEGACY** | HTTP status 200 · the body is valid JSON and a JSON object · `name === "ROF LMS API"` · `version`, `docs` and `health` are strings · there is **no** `capabilities` property |
| **NEW** | The LEGACY conditions for `name`, `version`, `docs` and `health` · `capabilities` is a JSON object · `capabilities.schemaVersion === 1` (an integer) · `capabilities.roles` is an array of strings · `capabilities.features` is an array of strings |
| **UNKNOWN** | Everything else |

UNKNOWN includes:
- network errors, timeouts and aborted requests (the free-plan backend can take
  about a minute to wake);
- any status other than 200, for example 304 handled by hand, 3xx, 404, 429
  (rate limit) and 5xx;
- HTML or any other non-JSON body, for example the Netlify 404 page;
- malformed JSON, or JSON that is not an object (an array, a string, `null`);
- a missing or wrongly typed `name`, `version`, `docs` or `health`, or a
  different `name`;
- `capabilities: null`, or a `capabilities` value that is not an object;
- a missing or non-integer `schemaVersion`, or any `schemaVersion` other than 1;
- `roles` or `features` that are missing, not arrays, or contain non-strings.

**UNKNOWN never falls back to LEGACY.** Retry, or show a clear "cannot reach the
server" state. Only a response that meets every LEGACY condition is legacy.
Never infer anything from `version`: it is `1.0.0` on both backends.

### What the capabilities mean

Capabilities describe **backend-wide functionality**. They are the same for
every viewer and say nothing about the current user's permissions or access. For
those, use `GET /me/permissions`, and the API still refuses anything not permitted.

- **`roles`:** every role a stored user account may hold (the database role
  values). It is **not** the list of roles that can currently be registered or
  assigned. The frontend must show each value safely (P1-F1), including
  `SUPER_ADMIN`, which the API never assigns.
- **`features`:** sorted names of what the backend supports right now. Check
  each one on its own with `features.includes(name)`; don't rely on order.
  A feature that is not listed is not available. Ignore names you don't know.

| Feature | When listed, the frontend may rely on |
|---|---|
| `permissionScopes` | `GET /me/permissions` also returns `roleLabel`, `scopes.courseDivisions`, `scopes.programmes` and `overrides` |
| `schoolReferenceRequired` | Invitations and CSV imports name an **existing** school by `schoolId` or `schoolCode`. A name alone is refused (`SCHOOL_REFERENCE_REQUIRED`) and never creates a school. A name sent with a reference must match it (`SCHOOL_NAME_MISMATCH`). Creating and editing users also accepts `schoolCode` |
| `schoolAdministration` | `/admin/schools`: create, edit, activate/deactivate, import, contacts, offerings, history |
| `schoolAffiliations` | Students claim a school (`/me/school-affiliation`); staff review claims (`/admin/school-affiliations`) |
| `academicYearActivation` | `POST /admin/academic-years/:id/activate` is single-flight and safe to retry. `expectedCurrentYearId` (the current year's id, or `null`) is **required**. While a start runs, another is refused (409 `ACTIVATION_IN_PROGRESS`); a repeat of a recorded start with the same choices returns its outcome with `replayed: true`; other choices → 409 `ACTIVATION_OPTIONS_DIFFER`; a changed current year → 409 `CURRENT_YEAR_CHANGED`. Without this feature (the original backend) a start is not safe to repeat: clients must not offer it |
| `reviewQueueFilters` | `GET /mentor/reviews` (the coach's own reviews) accepts `q` (student name or username), `group` (`open`, `done` or `all`; ignored when `status` is given), `sort` (`submitted` oldest first, the default; `recent`; `name`; `score`) and applies `courseId` / `divisionId`; the answer adds `counts: { open, done, all }` (same scope, without search or status). Without this feature these parameters are refused (400 `VALIDATION_FAILED`) and the scope filter is ignored: load the default queue and filter in the browser |
| `reportExportFilters` | The Reports CSV exports apply the Reports page filters. `results.csv` accepts `academicYearId` (default: the current year; with `assignmentId` only when given), `from`/`to` (**submitted** between), `courseId` and `divisionId` besides `assignmentId`; it still needs `assignmentId`, or `courseId` **and** `divisionId` (400 `FILTER_REQUIRED`). `GET /admin/reports/enrollment` and `enrollment.csv` accept `courseId` (students taking part in that course, as in the Students report). Without this feature `results.csv` refuses `from`/`to`/`academicYearId` (400) and enrolment refuses `courseId` (400 `FILTER_NOT_SUPPORTED`): clients must not send them |
| `studentAssignmentFilters` | Assignment lists filter and sort in the database. `GET /me/assignments` accepts `progress` (`NOT_STARTED`, `SUBMITTED`, `PENDING_REVIEW`, `RESUBMISSION_REQUESTED`, `REVIEWED` — the `displayStatus` labels — and `OVERDUE`: not started and no longer submittable, i.e. closed or past the deadline without late work) and `sort` (`deadline` soonest first, the default; `-deadline`; `title`). `GET /assignments` accepts `statuses` (comma-separated, e.g. `DRAFT,REJECTED`; not together with `status`). Paging and `meta.total` count only the matches. Without this feature these parameters are refused (400 `VALIDATION_FAILED`): filter the loaded page in the browser |
| `schoolDirectorySync` | The official-directory sync, `/admin/school-sync`. With `schools.manage`: upload a source export as a dry run (`POST /runs?dataset=NESA:ACCREDITED_SCHOOLS`, multipart `file`, .xlsx or .csv; nothing is written to the directory), list runs, a run's items, proposed changes and `report.csv` (contact values masked or absent), the review summary (`/review`: counts and what still blocks an apply), `/categories` (with the `listDigest` a category approval sends back), `/decisions`, item `/proposal` and `/recompare`. Only with `schools.syncDirectory` (Super Admins; never grantable): `/approve` (returns the apply token), `/apply` and item `/resolve`; deciding a `RESOLVE_CONFLICT` change also needs it. Show approve / apply only when `/me/permissions` lists `schools.syncDirectory` |
| `notificationDeliveries` | The decision-notification delivery log: `GET /admin/notification-deliveries` (status / type filters, paged) and `POST /admin/notification-deliveries/:id/retry` for a `FAILED` row. The caller also needs `email.bulkSend` in `/me/permissions`. Not behind a flag. Absent: the backend has no delivery log (hide the menu item) |
| `studentOlympiadInterests` | Students' Olympiad interests (owner decision 8): `POST /auth/register/student` and `PATCH /me` accept `olympiadInterests` — an array of one or more of `MATHEMATICS`, `COMPUTING`, `PHYSICS` without duplicates (400 `VALIDATION_FAILED` otherwise); optional at registration (older clients: the account has none). Stored in that fixed order and returned as `olympiadInterests` by the profile (`GET /me`, login, registration), the admin user list/detail, `GET /admin/reports/students` and (labels) `students.csv` (last column "Olympiad interests"). Information only: no programme membership, no permissions. Without this feature the field is refused (400): do not send it |
| `studentRegistrationDetails` | Student registration details: `POST /auth/register/student` accepts `dateOfBirth` (`YYYY-MM-DD`, a real past date, age 5–30 on the day in Rwanda), `phone` (the student's own, optional) and `guardianPhone` (a close-family phone) — both stored in E.164 with the teacher-application phone rules — `homeCountry` (the student's own country, ISO alpha-2; `country` stays the school's) and the official home place `homeProvince` + `homeDistrict` + `homeSector` (all three; a place of `GET /schools/locations`, else 400 `UNKNOWN_HOME_LOCATION`; with a non-RW `homeCountry` 400 `HOME_LOCATION_RWANDA_ONLY`). With the home place, `homeLocation` is optional and stored as "Sector, District"; without it, `homeLocation` stays required. Invalid values: 400 `VALIDATION_FAILED`, each message starting with the field name. All optional at the API for older clients; the sign-up form requires date of birth, close-family phone and home place. Returned by the profile (`GET /me`, login, registration) and the admin user detail (`dateOfBirth` as an ISO instant at 00:00 UTC). Phone numbers and dates of birth are never written to the audit log. Without this feature the fields are refused (400): do not send them |
| `formAvailability` | Form availability (docs/operations/forms.md): `GET /forms` and `GET /forms/:key` (public) give each form's `open`, `state` (`OPEN`, `CLOSED`, `NOT_YET_OPEN`, `ENDED`), `opensAt` / `closesAt` (UTC; show in `timezone` Africa/Kigali), `closedMessage`, `instructions`, `contactEmail`, `supportUrl` and `serverTime`. Forms: `STUDENT_REGISTRATION`, `TEACHER_REGISTRATION`, `COACH_APPLICATION`, `CONTACT`. Administrators: `GET /admin/forms`, `/admin/forms/:key`, `/admin/forms/:key/history` (`forms.view`), `PATCH /admin/forms/:key/availability` (`forms.manageAvailability`), `PATCH /admin/forms/:key/messages` (`forms.editMessages`). A submission to a closed form is refused with 403 `REGISTRATION_CLOSED` (student and teacher registration) or `FORM_CLOSED` (coach applications, contact form); `message` is the closed message and `details` is `{ form, state, opensAt, closesAt, closedMessage, contactEmail, supportUrl }`. |
| `coachApplicationDetails` | Coach application details: `POST /mentor-requests` accepts `country` (ISO alpha-2), `occupation` (2–200 characters), `educationLevel` (`SECONDARY` | `DIPLOMA` | `BACHELOR` | `MASTER` | `DOCTORATE` | `OTHER`) and `olympiadInterests` (one or more, no duplicates). Optional at the API for older clients, except `olympiadInterests`: required since 2026-11-19 (see `coachOlympiadInterests`). The admin list (`GET /mentor-requests`) returns them (NULL / empty on older applications); approval copies `country` and `olympiadInterests` to the Coach account. No passport or national ID is collected. Without this feature the fields are refused (400): do not send them |
| `coachOlympiadInterests` | Coaches' subject interests (owner decision 2026-11-19, Option A — the existing `olympiadInterests`, no new data): `POST /mentor-requests` **requires** `olympiadInterests` (one or more of `MATHEMATICS`, `COMPUTING`, `PHYSICS`; no duplicates; else 400 `VALIDATION_FAILED`). A Coach views and edits their own on `GET` / `PATCH /me` (at least one when sent). An Administrator who may manage Coach accounts (`users.manage` + `users.manageCoaches`) edits a Coach's with `olympiadInterests` on `PATCH /admin/users/:id` (at least one; Coach accounts only, else 400 `INTERESTS_COACH_ONLY`; audited in `UPDATE_USER`). `GET /admin/users` and `GET /admin/users/:id` return them. Existing Coaches without interests stay valid (shown as not set); nothing is filled in automatically. Information only: interests never grant marking or any other permission |
| `teacherAccounts` | The `TEACHER` role can currently be **assigned** to an account (create, invite, import, role change). The caller also needs `users.manageTeachers` in `/me/permissions` |
| `teacherSelfRegistration` | Teacher self-registration is implemented: `GET /auth/register/teacher/availability` returns `{ open }` (open only while the `registration.teacherSelfSignup` setting is on as well), `POST /auth/register/teacher` submits an application (201, `status: "PENDING"`; no account until approved), and Administrators with `users.manageTeachers` review applications at `/admin/teacher-applications` (list, get, approve, reject). Listed only while `TEACHERS_ENABLED` is on, like `teacherAccounts`. Use `availability` — not this feature — to decide whether to show the form as open |
| `headCoachAccounts` | The `HEAD_COACH` role can currently be **assigned** to an account. The caller also needs `users.manageHeadCoaches` in `/me/permissions` (an `ADMIN`'s list reports it since 2026-11-14) |

### `/me/permissions` contract changes (2026-11-14)

- **`ADMIN` (additive):** the list now also ends with `users.manageHeadCoaches`, `programmes.manageHeads`,
  `programmes.manageMembers`, `coaches.monitor`, `reports.view` (owner decision D-5: Administrators manage
  Head Coaches, programme heads and members, and monitor coaches). Administrators already held them and the
  routes already admitted them. Nothing was removed or reordered; `SUPER_ADMIN`-only permissions are still
  never listed.
- **`TEACHER` (removal):** `courses.view`, `resources.view`, `assignments.view`, `discussions.participate`
  and `discussions.report` are no longer listed or granted, and `assignments.prepare` is no longer on the
  override catalogue's `grantable.TEACHER` list. They were course × division grants with no teacher course
  assignment behind them (always refused by the services). A Teacher's list is `leaderboard.view`,
  `students.viewScoped` plus the delegations granted to them. `TEACHERS_ENABLED` is off in production.
- **New route:** `GET /admin/programmes/:id/student-candidates?search=` (`programmes.manageMembers`): students
  who can be added to the programme; for a Head Coach only students in no programme. `POST
  /admin/programmes/:id/members` by a Head Coach refuses a student in another programme (409
  `STUDENT_IN_OTHER_PROGRAMME`). See [PERMISSIONS.md](PERMISSIONS.md).

When `teacherAccounts` or `headCoachAccounts` is **absent**, the role can't be
newly assigned. Existing `TEACHER` or `HEAD_COACH` accounts may still exist and
use their portals. Show a portal by the signed-in user's `role`, never by these
features.

The official-directory sync (`/admin/school-sync`) was not advertised before
2026-11-14; it is now (`schoolDirectorySync`, owner decision). Its routes and
permissions did not change.

- **`schemaVersion`:** adding a feature does not change it. Renaming or
  removing a feature, or changing what `roles` or a feature means, raises it.
  Clients treat any value other than 1 as UNKNOWN.

The definitions live in `src/app/capabilities.ts`. The frozen V1 feature list is
in `src/app/capabilities.spec.ts`. The response lists only role and feature
names, never configuration values or other internal details.

## Schools without an official code

Owner decision 2026-11-14. `GET /api/v1/schools/search` returns **active Rwandan**
schools with an official code and those without one that an administrator entered
(official name and place), by name, code prefix or place (province, district, sector
or location text). Free-text schools typed in before the directory existed (source
`LEGACY`, no code) are never offered publicly; administrators still match claims to them.

**Schools for Teachers** (owner decision 2026-11-14): `teacherEligible=true` limits the
search to schools a Teacher may name: an official code, or created by an administrator
**and verified** (`POST /api/v1/admin/schools/{id}/verify`, `schools.manage`, audited
`VERIFY_SCHOOL`; the admin school detail returns `lastVerifiedAt` and `lastVerifiedBy`).
Editing a verified school's name or place clears the verification. The response shape is unchanged;
a school without a code has `code: null` (a code is never invented).

Registration (`POST /auth/register/student`) and the student's claim
(`POST /me/school-affiliation`) accept `schoolId` (the result's `id`) as well as
`schoolCode`. The claim is PENDING until an Administrator verifies it, exactly as
with a code. Refused: an unknown id, one outside the Rwandan list or a `LEGACY` school without a
code (400 `UNKNOWN_SCHOOL`), an inactive school (409 `SCHOOL_INACTIVE`), `schoolId` with
`schoolCode`, a name or a place (400 `VALIDATION_FAILED`), `schoolId` with another
country (400 `SCHOOL_DIRECTORY_RWANDA_ONLY`).

No capability is needed: the frontend sends `schoolCode` whenever the chosen
school has one, and `schoolId` only for a result with `code: null` — which older
backends never return.

## E-mail links

The backend builds links from its `APP_URL` (the frontend's address):
`/reset-password?token=…`, `/activate?token=…`, `/login`, and deep links such
as `/assignments/:id`. The frontend serves each of these routes.

## Settings that must match

| Backend (Render) | Frontend (Netlify, `netlify.toml`) |
|---|---|
| `APP_URL` = the Netlify site address | — |
| `CORS_ORIGINS` = the Netlify site address (exact, no trailing slash) | `NEXT_PUBLIC_API_UPLOAD_ORIGIN` = backend address |
| service address `https://rofbackendtest.onrender.com` | `API_PROXY_TARGET` and the `/api/*` redirect target = backend address |

## Test results (2026-11-07)

**Local, both apps running, browser-equivalent requests through the frontend's `/api` proxy, uploads cross-origin as in production:**

- 39/39 general journeys: public pages, error shape, student login → refresh cookie (httpOnly, Strict, `/api/v1/auth`) → silent refresh with rotation → logout, 403 for other roles, coach upload → publish → student download byte-for-byte, disguised executable refused (`FILE_TYPE_NOT_ALLOWED`), admin dashboard/reports/CSV.
- 26/26 assessment workflow: coach drafts an assignment with a brief → admin publishes → student downloads the brief and uploads a solution (re-upload = revision 2) → admin assigns a coach → coach downloads the solution, marks 16/20 with written feedback and a feedback file (score above maximum refused) → admin approves and publishes → student sees score, percentage, feedback, downloads the feedback file; internal notes hidden; notifications and unread counter; students cannot mark, coaches cannot publish.
- 12 MB direct upload with CORS preflight; foreign origins refused.

**Production (read-only or approved):**

- Backend `/health`: database up, storage up; health is ~300 ms slower than a database-only call, consistent with a live R2 bucket check.
- CORS: `https://roflms.netlify.app` allowed, with credentials.
- E-mail: an approved password-reset e-mail to the admin was **delivered** by Resend from `Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>`; its link points to `https://roflms.netlify.app/reset-password?token=…`.
- **Frontend: `https://roflms.netlify.app` serves Netlify's "Page not found" on every path.** A clean build of frontend `main` stops with "API_PROXY_TARGET must be set…" (reproduced); the `feature/production-readiness` branch sets it in `netlify.toml` and builds cleanly from a fresh clone.

Not yet possible: browser tests on the live site (needs the fixed frontend deployed), and a live upload to R2 (needs a production coach or admin login).

## Busy database: 503 DATABASE_BUSY

When every pooled database connection stays busy for longer than a transaction may wait
(`DATABASE_TX_MAX_WAIT_MS`, default 10 s), the API answers **503** with code `DATABASE_BUSY` and
`Retry-After: 2`. Nothing was changed; the request can be repeated. (Before 2026-11-14 this case
answered 500 `INTERNAL_ERROR`.) The frontend retries reads that fail with a 5xx automatically.
