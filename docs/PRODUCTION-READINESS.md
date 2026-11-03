# ROF LMS backend — production readiness report

Status on 2026-11-03, at the commit that adds this file. Every result below
comes from a test or check that was actually run; anything that could not be
run here is marked **Not tested**.

**Verdict.** The backend is **ready for frontend integration** and
**functionally ready for production**. Before go-live:

- the deployment-environment checks that could not run here must pass
  (S3, real SMTP, Docker image, load);
- the decisions listed in §8 need an answer.

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
| Foreign keys / CHECK constraints / indexes | 91 / 12 / 190 (every foreign key now indexed) |
| Audit-log triggers | installed (append-only + actor username) |
| Seed: 4 courses, 2 divisions, discipline, one current year, active admin | correct |
| Duplicate users (case-insensitive e-mail/username), schools | none |
| Student placement vs grade, enrolment vs placement, staff without student data | consistent |
| Reviews belong to mentors; published results complete; points cache matches results | consistent |
| Stored files present on disk | **4 of 4 missing** — sample rows from 2026-11-02 in the development database only (§8) |

## 4. API documentation

- **Swagger UI** at `/api/docs` (development; production when
  `SWAGGER_ENABLED=true`). Verified live: it serves all 203 operations, each
  with its roles (`x-roles`).
- **OpenAPI 3:** [api/openapi.json](api/openapi.json).
- **Postman:** [api/ROF-LMS.postman_collection.json](api/ROF-LMS.postman_collection.json),
  203 requests in 28 folders. The login request stores the token for the rest.
- **Reference:** [API.md](API.md). **Authorization matrix:** [AUTHORIZATION.md](AUTHORIZATION.md).
- **Guides:** [WORKFLOWS.md](WORKFLOWS.md), [STORAGE.md](STORAGE.md),
  [ARCHITECTURE.md](ARCHITECTURE.md).

All generated documents come from the compiled code (`npm run docs:api`), and
CI fails if they are out of date. **Limitation:** request bodies, parameters,
roles and status codes are documented, but only 11 of 203 operations describe
their **response body** in OpenAPI (§8).

## 5. Test results

Run on 2026-11-03, after the last code change:

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, app + tests) | 0 errors |
| Lint (`oxlint`) | 0 warnings, 0 errors |
| Production build (`nest build`) | succeeds |
| Unit tests | **442 / 442 passed** (34 files) |
| End-to-end tests (real PostgreSQL) | **287 / 287 passed** (19 files) |
| End-to-end code coverage | 88.0% lines, 72.9% branches, 91.2% functions |
| Routes called by e2e tests | **203 / 203** |
| Security suite | every non-public route refuses anonymous callers (401) and every role it does not allow (403); token forgery/expiry/revocation, lockout, isolation, uploads, validation, SQL-injection probes, data exposure, headers — all passing |
| `npm audit --omit=dev` (production dependencies) | 0 vulnerabilities |
| Compiled code imports only declared production dependencies | yes (`multer` now declared) |
| Live run of the built app | `/health` database + storage up; Swagger served; security headers present; scheduled reminders and e-mail outbox fired on schedule (smoke test with workers on) |
| Independent security review | no high-severity findings; all confirmed medium/low findings fixed and covered by tests |

**Not tested here** (no infrastructure available in this environment):

- S3 / R2 / MinIO storage (the S3 driver has 0% coverage; tests use local disk);
- delivery through a real SMTP server (only the dry-run);
- the Docker image and docker-compose stack (Docker isn't installed here; CI
  builds the image);
- performance under load or with production-size data. The slowest endpoint
  answered in 0.3 s on test data.

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

## 8. Outstanding issues

| # | Issue | Impact | Suggested action |
|---|---|---|---|
| 1 | OpenAPI documents response bodies for only 11 of 203 operations | The frontend can't generate typed response models from the spec | Add response DTOs/decorators module by module; meanwhile use API.md, Postman and real responses |
| 2 | **Privacy decision:** discussion posts show the author's full name and username to other students | Most users are minors | Decide; showing first name + last initial as on the leaderboard is a small change |
| 3 | Development database: 4 sample file records (1 brief, 2 submissions, 1 feedback) point to files that don't exist; `uploads/submissions/` holds 10 unreferenced files from the old upload system | Development only; downloads of those return 404. Production starts empty | With approval: add the files, or remove the sample rows and the old folder |
| 4 | The dev `.env` has no `CORS_ORIGINS` / `APP_URL` / `SMTP_HOST` | A local frontend on `localhost:5173` is blocked by CORS until `CORS_ORIGINS` is set | Add them to the dev `.env` |
| 5 | Not tested here: S3, real SMTP, Docker image, load | Unknown until run | Run on staging: upload/download via S3, receive an invitation e-mail, `docker compose up`, a basic load test |
| 6 | 5 moderate advisories in development tools (vitest and its mocker, coverage-v8, minimatch through `@nestjs/cli`) | Development machines only; nothing in production | Upgrade when non-breaking fixes are released (the only fix today is a breaking `@nestjs/cli` downgrade) |
| 7 | 11 tests wait a fixed time (300 ms for event handlers, 1.1 s for token timestamps) | Possible flakiness on a slow CI runner | Replace with polling waits if it ever flakes |
| 8 | Lower coverage areas | S3 driver 0%; error-filter database-error mapping 56%; older CSV exports 50%; academic-year rollover branches 41%; mentor-assignment branches 35% | Add focused tests |

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
| Response body schemas in OpenAPI | ⚠️ 11 / 203 (outstanding #1) |
| File uploads (multipart: `files` / `file`) and downloads (`Content-Disposition`, inline only for PDF/images) | ✅ tested |
| Dates: ISO 8601 UTC; live sessions also give `date`, `startTime`, `endTime`, `timeZone` | ✅ |
| Notifications: polling endpoints, unread counts per category, mark read/unread | ✅ (no push) |
| CORS for the frontend origin | ✅ configurable; ⚠️ set `CORS_ORIGINS` in the dev `.env` (outstanding #4) |
| Swagger UI for exploring the API | ✅ `/api/docs` in development |
| Seeded demo users for development (`SEED_DEMO=true`) | ✅ `mentor.junior`, `mentor.senior`, `student.s2`, `student.s5` / `Demo1234` |

**Result:** ready for frontend integration. Items marked ⚠️ don't block
starting; #1 mainly affects generating typed clients.
