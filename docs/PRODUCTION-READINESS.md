# ROF LMS backend — production readiness report

Status on 2026-11-03, at the commit that adds this file. Every result below
comes from a test or check that was actually run; anything that could not be
run here is marked **Not tested**.

**Verdict.** The backend is **ready for frontend integration** and
**ready for production**, once the staging checks in §8 pass in the real
hosting environment. Those are the Docker image, the docker-compose stack
(both automated in CI), S3 against the real bucket, SMTP with the real
provider, and load against managed PostgreSQL. No open code issues remain.

---

## 1. Completed functionality

Every area below is implemented and covered by end-to-end tests against a
real PostgreSQL database.

| Area | What is implemented |
|---|---|
| Authentication | Login (username or e-mail), access + rotating refresh tokens (cookie or body), logout, sign-out everywhere, password change/reset, account activation and invitations, e-mail verification (on by default in production), per-IP rate limits, per-account lockout, immediate session revocation on password/role/status change |
| Users and roles | Students, mentors, administrators; admins create or invite any role, CSV import (with dry run), edit any account, suspend/reactivate, reset passwords; student self-registration; mentor applications with admin approval (+ e-mail confirmation) |
| Academic structure | Divisions (Junior S1–S3, Senior S4–S6), schools, academic years (plan, activate with promotion/graduation, enrolments and corrections), mentor course × division assignments |
| Courses and resources | The four fixed courses; learning resources per course × division with files, metadata (author, source, year, tags), draft/publish/archive/restore; students' course progress (opened, completed) |
| Assignments | Mentor drafts with brief files → admin approval/rejection → published → closed at the deadline (unless late work is accepted) → archived; recall, unpublish, reopen; full history; settings-driven defaults |
| Submissions | Typed answers and/or files, numbered revisions, student resubmissions within limits, mentor-requested resubmissions with due dates, late flags, student-facing status labels |
| Distribution and review | Manual assignment or batch distribution (balanced / round-robin) to eligible mentors; review cycles; scoring, written feedback, feedback files; admin approve / send back; reassignment; admins cannot grade |
| Results | Publication per submission or per assignment, release history (who and when), points and division leaderboard, student result pages with feedback and files, corrections with previous versions |
| Discussions and moderation | Course and assignment threads, one level of replies, reactions, author edit/delete rules, reports with snapshots, admin hide/restore/remove/lock/archive/pin/dismiss, moderation log; no private messaging, no study groups |
| Live sessions | External meetings (Zoom, Meet, Teams …) per course × division; date/time in the programme time zone; overlap, length and academic-year validation; update/cancel; reminders |
| Notifications | In-app inbox (read/unread, counts per category, filters), e-mail through a background outbox with retries, per-category e-mail opt-outs, per-type switches for admins and mentors, deadline and live-session reminders |
| Dashboard and reports | Admin dashboard; student, mentor, enrolment, course-participation, assignment, review, results-publication and mentor-activity reports; filters (year, division, course, dates, status); CSV export |
| System settings | Registration, assignment defaults, notification rules, live-session limits, platform name, public help and support details |
| Audit trail | Who / what / which record / when for every important action, with before/after values; append-only (enforced by a database trigger); admin-only search, detail and CSV export |
| Files | Content-type detection, per-purpose limits, private storage (local disk or S3-compatible), authorized downloads with safe headers, orphan clean-up |
| Operations | Health check (database + storage), JSON logs with request ids, strict environment validation, Swagger UI, generated OpenAPI/Postman/API reference/authorization matrix, CI pipeline |

## 2. API endpoints

**203 endpoints** under `/api/v1` (plus `/health`). The full list, with
access, parameters and body fields, is in [API.md](API.md). Who may call each
one is in [AUTHORIZATION.md](AUTHORIZATION.md).

| Group | Endpoints | Group | Endpoints |
|---|--:|---|--:|
| Auth | 12 | Submissions | 27 |
| Me (own profile, lists, settings) | 11 | Discussions (incl. moderation) | 23 |
| Admin · Users | 10 | Admin · Reports | 20 |
| Admin · Academic years | 6 | Notifications | 12 |
| Academic years | 2 | Admin · Email | 6 |
| Admin · Mentor assignments | 3 | Live sessions | 5 |
| Mentor requests | 4 | Admin · Audit | 4 |
| Courses (incl. resources) | 17 | Admin · Courses | 4 |
| Assignments | 17 | Leaderboard / Admin · Leaderboard | 3 / 1 |
| Divisions | 3 | Admin · Activity | 2 |
| Schools | 3 | Admin · Settings | 2 |
| Admin · Dashboard | 1 | Analytics | 1 |
| Mentor (review queue) | 1 | Support | 1 |
| Health | 2 | | |

14 endpoints are public (sign-in and registration flows, health, divisions,
school search, support details). 93 are administrator-only.

## 3. Database

Documented in [DATABASE.md](DATABASE.md): ERDs, every table, integrity rules,
deletion and retention policy, migration history and seeding.

| Check (run on the development database, read-only) | Result |
|---|---|
| Prisma models vs tables | 46 / 46 |
| Migrations applied, schema drift | 14 applied, no drift (development and test databases) |
| Foreign keys / CHECK constraints / indexes | 91 / 12 / 190 (every foreign key indexed) |
| Audit-log triggers | installed (append-only + actor username) |
| Seed: 4 courses, 2 divisions, discipline, one current year, active admin | correct |
| Duplicate users (case-insensitive e-mail/username), schools | none |
| Student placement vs grade, enrolment vs placement, staff without student data | consistent |
| Reviews belong to mentors; published results complete; points cache matches results | consistent |
| Stored files present on disk | 4 / 4 (the 4 development sample records now have their placeholder files) |

## 4. API documentation

- **Swagger UI** at `/api/docs` (development; production when
  `SWAGGER_ENABLED=true`). Verified live: it serves all 203 operations, each
  with its roles (`x-roles`).
- **OpenAPI 3:** [api/openapi.json](api/openapi.json). Every operation
  documents:
  - who may call it;
  - its parameters and request body;
  - its success response: **181 JSON response schemas**, plus 22 CSV or file
    downloads with their content types;
  - the shared `Error` schema, as the default response.
- **Postman:** [api/ROF-LMS.postman_collection.json](api/ROF-LMS.postman_collection.json),
  203 requests in 28 folders. The login request stores the token for the rest.
- **Reference:** [API.md](API.md), which lists each endpoint's access,
  parameters, body and the fields it returns. **Authorization matrix:**
  [AUTHORIZATION.md](AUTHORIZATION.md).
- **Guides:** [WORKFLOWS.md](WORKFLOWS.md), [STORAGE.md](STORAGE.md),
  [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING.md](TESTING.md).

The response schemas are **recorded from what the end-to-end tests actually
received** (`npm run docs:responses`): types, uuid and date-time formats, and
nullable and always-present fields. They are therefore accurate to the real
API, as far as the tests exercise it. Numbers come out as `integer` when
every value seen was whole, for example a percentage of 80. Everything else
is generated from the compiled code (`npm run docs:api`), and CI fails if
it's out of date.

## 5. Test results

Run on 2026-11-03, after the last code change:

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, app + tests) | 0 errors |
| Lint (`oxlint`) | 0 warnings, 0 errors |
| Production build (`nest build`) | succeeds |
| Unit tests | **454 / 454 passed** (36 files) |
| End-to-end tests (real PostgreSQL) | **300 / 300 passed** (20 files). 3 S3 tests are skipped locally because no S3 endpoint is configured; see the S3 row |
| Combined code coverage (unit + e2e) | **92.7% lines, 80.4% branches**, 94.5% functions |
| Routes called by e2e tests | **203 / 203**; every route's success path exercised |
| Security suite | every non-public route refuses anonymous callers (401) and every role it doesn't allow (403). Token forgery, expiry and revocation, lockout, isolation, uploads, validation, SQL-injection probes, data exposure and headers all pass |
| Real SMTP delivery | **passed**: e-mails received by an SMTP server, the reset link works, all bulk modes, retries, giving up after 5 attempts, administrator retry, nothing sent twice |
| S3 driver over the S3 API | **passed** against an S3-compatible emulator (s3rver): upload, byte-for-byte download, access rules, health, clean-up deleting objects. CI runs the same test against **MinIO** |
| `npm audit` (all dependencies, including development) | **0 vulnerabilities** |
| Compiled code imports only declared production dependencies | yes |
| Live run of the built app | `/health` reports database and storage up; Swagger served; security headers present; CORS allows the configured frontend and refuses others; scheduled jobs fired on time |
| Load baseline, 20 concurrent clients | 0 errors on 5 endpoints. Per-request time with 1 client: 7–26 ms for student pages, 65 ms for the dashboard ([TESTING.md](TESTING.md#load-baseline)) |
| Independent security review | no high-severity findings; all confirmed findings fixed and covered by tests |

**Automated in CI but not run on this machine** (Docker isn't installed
here): the Docker image build, and the `compose-smoke` job. That job starts
the full docker-compose stack and checks health, login, the dashboard and the
OpenAPI document.

## 6. Deployment

Step-by-step in [DEPLOYMENT.md](DEPLOYMENT.md):

- the production architecture;
- environment configuration (template: [.env.production.example](../.env.production.example));
- database setup and migrations;
- authentication and file-storage configuration;
- reverse proxy and TLS;
- first deployment and releases, including migration failure handling;
- backup and recovery, including restore drills;
- monitoring, logging and alert thresholds;
- scaling;
- data protection;
- a go-live checklist.

## 7. Known limitations

| Limitation | Effect |
|---|---|
| No real-time push (WebSocket/SSE) | The frontend polls `GET /notifications/unread-count` |
| E-mails are plain text | Simple, safe; no HTML templates |
| Rate limits are counted per instance, in memory | With N instances, up to N × the limit; add limits at the proxy if needed. The login lockout is in the database and applies everywhere |
| Uploads are checked in memory | Memory per in-flight upload ≈ request size (capped at `MAX_UPLOAD_REQUEST_MB`) |
| Course resources list is not paginated | Fine for curated lists; every other open-ended list is paginated |
| Registration says when a username or e-mail is already taken | Rate-limited; a CAPTCHA would stop enumeration |
| A mentor removed from a course keeps the reviews already assigned to them | An admin reassigns them |
| Admins cannot author assignments or grade | By decision (mentors only) |
| Admins can set any user's password | By decision; every change is audited |
| Scheduled daily jobs use the server clock | Retention 02:00 and file clean-up 03:00 in the container's time zone (UTC by default) |
| Messages are in English | No translations |
| Mathematics only | The data model has a discipline, but the four courses are fixed |
| Dead code kept | `src/common/file.utils.ts` (deprecated) and the switched-off `src/study-groups/` are kept because existing files are not deleted without approval |
| Discussions show students to each other as first name + last initial | Same as the leaderboard; staff appear in full; administrators see everything |

## 8. Outstanding issues

All eight issues from the previous report have been dealt with:

| # | Issue | Resolution |
|---|---|---|
| 1 | OpenAPI documented response bodies for 11 of 203 operations | **Fixed:** all 203 operations now document their success response: 181 JSON schemas recorded from real responses, plus 22 CSV or file downloads. A shared `Error` schema covers errors, and `API.md` lists the fields each endpoint returns |
| 2 | Discussions showed students' full names and usernames to other students | **Fixed:** other students appear as first name + last initial, with no username, as on the leaderboard. Tested from each viewpoint |
| 3 | Development database: 4 file records pointed to missing files | **Fixed** without touching the database: the 4 placeholder files were created at their recorded keys and sizes. The integrity check passes 4/4 |
| 4 | The dev `.env` had no `CORS_ORIGINS` / `APP_URL` | **Fixed:** set to `http://localhost:5173`; verified that the built app accepts that origin and refuses others |
| 5 | Not tested: S3, real SMTP, Docker image, load | **SMTP:** tested against a real SMTP server. **S3:** tested against an S3-compatible emulator here and MinIO in CI. **Docker:** image build and full compose smoke test now run in CI. **Load:** baseline measured (§5). The final check against the real bucket, SMTP provider and managed PostgreSQL belongs on staging (below) |
| 6 | 5 moderate advisories in development tools | **Fixed:** vitest 4.1.12, and minimatch 11 for the Nest CLI (override, build verified). `npm audit`: 0 |
| 7 | Tests waiting a fixed 300 ms for background work | **Fixed:** `waitForEvents()` now waits for the actual event handlers, and is stable over repeated runs. The remaining 1.1 s waits are deterministic (whole-second token timestamps) |
| 8 | Lower-coverage areas | **Improved** from 90.4% to 92.7% lines (combined). New tests cover the older CSV exports, mentor-assignment rules, the health check's failure path, the reminder job and its schedule, storage clean-up, real e-mail delivery and the S3 driver |

**Remaining items:**

| Item | Why it is open | Action |
|---|---|---|
| Staging checks | They need the real environment | On staging: upload and download through the real bucket; receive an invitation through the real SMTP provider; repeat the load baseline against managed PostgreSQL (`DATABASE_POOL_MAX=10`); run the go-live checklist in [DEPLOYMENT.md](DEPLOYMENT.md#13-go-live-checklist) |
| `uploads/submissions/` (10 files from the old upload system) | Nothing references them; they may contain student work, and deleting them can't be undone | Your decision: delete, or archive outside the project. They're excluded from git and never served |
| CI jobs not yet run | The new MinIO step and `compose-smoke` job are written and the workflow validates, but they can only run on GitHub | Push and check the first run |

## 9. Frontend integration checklist

| Item | Status |
|---|---|
| Every endpoint implemented and called by an e2e test | ✅ 203 / 203 |
| Base URL, versioning (`/api/v1`) and auth header documented | ✅ |
| Login, refresh (httpOnly cookie for browsers, or body), logout, sign-out everywhere | ✅ tested |
| Account activation, invitations, e-mail verification, password reset flows (links point to `APP_URL` + `/activate?token=…`, `/reset-password?token=…`) | ✅ tested; the frontend must provide those two pages |
| One error format with stable `code`s and a `requestId` | ✅ tested |
| One pagination format `{ data, meta }` for lists (`?page=&limit=`, max 100) | ✅ verified across all list endpoints |
| Roles and permissions for UI decisions (`GET /me`, `GET /me/permissions`) | ✅ |
| Who may call what | ✅ [AUTHORIZATION.md](AUTHORIZATION.md), generated from the guards |
| Request bodies, parameters and validation rules | ✅ OpenAPI / API.md / Postman |
| Response body schemas in OpenAPI | ✅ 203 / 203 (181 JSON schemas recorded from real responses; 22 CSV or file downloads) |
| File uploads (multipart: `files` / `file`) and downloads (`Content-Disposition`, inline only for PDF/images) | ✅ tested |
| Dates: ISO 8601 UTC; live sessions also give `date`, `startTime`, `endTime`, `timeZone` | ✅ |
| Notifications: polling endpoints, unread counts per category, mark read/unread | ✅ (no push) |
| CORS for the frontend origin | ✅ configurable; dev `.env` set to `http://localhost:5173` and verified |
| Swagger UI for exploring the API | ✅ `/api/docs` in development |
| Seeded demo users for development (`SEED_DEMO=true`) | ✅ `mentor.junior`, `mentor.senior`, `student.s2`, `student.s5` / `Demo1234` |

**Result:** ready for frontend integration. Typed clients can be generated
from `docs/api/openapi.json`.
