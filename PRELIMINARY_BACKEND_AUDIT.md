# Preliminary backend audit — ROF LMS

**Date:** 2026-11-08 · **Repository:** `ROFBACKENDTEST` (branch `feature/backend-completion`, commit `f624d25`)
**Scope:** the existing backend only. No code, database or configuration was changed for this audit.

This is a **preliminary** audit. It describes what exists today and how well each part is verified.
It does **not** yet compare the backend with the new requirements: those will arrive as
`ROF_LMS_CONSOLIDATED_REQUIREMENTS.md`, after which the comparison and the remaining audit documents
(`BACKEND_REQUIREMENTS_AUDIT.md`, `BACKEND_IMPLEMENTATION_PLAN.md`, `DATABASE_CHANGE_PLAN.md`,
`API_CHANGE_PLAN.md`, `BACKEND_TEST_PLAN.md`, `FRONTEND_INTEGRATION_REQUIREMENTS.md`) will be written.
`ROF_LMS_Current_Product_Documentation_Final.docx` was used only as a description of the current product.

## How to read the verification levels

Every feature below carries the highest level of evidence that exists for it:

| Level | Meaning |
|---|---|
| **P — verified in production** | Observed working on `https://rofbackendtest.onrender.com` (2026-11-07) |
| **X — verified across both apps** | Exercised locally through the frontend's `/api` proxy, as a browser would (39 general + 26 assessment journeys, 2026-11-07) |
| **E — automated end-to-end test** | Covered by the e2e suite against a real PostgreSQL database (289 tests; every one of the 202 routes is called) |
| **U — unit test only** | Logic covered by unit tests with mocks |
| **C — code only** | Exists in the code; no test exercises it |
| **— not implemented** | Mentioned in the schema or enums, or absent |

## 1. Stack and structure

| Item | Value |
|---|---|
| Runtime | Node.js 24, NestJS 12, TypeScript 6 (ES modules) |
| Database | PostgreSQL via Prisma 7 (`@prisma/adapter-pg`); production on Neon |
| Files | Local disk or any S3-compatible store; production Cloudflare R2 |
| E-mail | Resend SDK through a database outbox (`EmailDelivery`) and a background worker |
| Hosting | Docker image on Render (free plan); `render.yaml` Blueprint |
| Modules (`src/`) | academic-years, activity, analytics, app, assignments, audit, auth, common, config, courses, discussions, divisions, email, leaderboard, mentor-assignments, mentor-requests, notifications, public-site, reports, schools, settings, study-groups (disabled), submissions, users |
| API | 202 routes under `/api/v1` (plus `/health`); OpenAPI generated into `docs/api/` |

## 2. Data model

46 models and 30 enums (`prisma/schema.prisma`, 1,470 lines), grouped by domain:

| Domain | Models |
|---|---|
| Identity and access | User, RefreshToken, TokenBlacklist, PasswordResetToken, AccountActivationToken, MentorRequest |
| Academic structure | AcademicYear, StudentEnrollment, Division, School, Discipline, Course, CourseEnrollment, MentorAssignment |
| Learning content | CourseResource, ResourceAttachment, ResourceView, FileObject |
| Assessment | Assignment, AssignmentEvent, AssignmentAttachment, AssignmentView, Submission, SubmissionRevision, SubmissionAttachment, DistributionBatch, MentorReview, ReviewAttachment, ReviewEvent, ResultRelease |
| Community | DiscussionThread, Comment, CommentReaction, ContentReport, ModerationAction, StudyGroup, StudyGroupMember (disabled) |
| Communication | Notification, NotificationPreference, NotificationSetting, EmailJob, EmailDelivery, ContactMessage |
| Administration | SystemSetting, AuditLog, ActivityLog |

Fixed enumerations that constrain the current design (relevant to future change):

| Enum | Values | Note |
|---|---|---|
| `Role` | STUDENT, MENTOR, ADMIN | Three fixed roles; "Mentor" is shown as "Coach" in the UI |
| `DivisionCode` | JUNIOR, SENIOR | Divisions are a fixed enum, not data |
| `GradeLevel` | S1–S6 | Rwandan secondary grades only |
| `AuthProvider` | LOCAL, GOOGLE | GOOGLE has no implementation |
| `ResourceType` | BOOK, EBOOK, NOTE, PAST_PAPER, ATTACHMENT | |
| `NotificationCategory` | ASSIGNMENTS, SUBMISSIONS, REVIEWS, RESULTS, RESOURCES, ACCOUNT, DISCUSSIONS | |

Notable fields: `User` holds `gradeLevel`, `divisionId`, `schoolId`, `homeLocation`, `points`, lockout and
token-cutoff fields; `School` has only `name` and `location` (no country, region or type); `Discipline`
(code, name, sort order) groups `Course`s; there is no "topic" or "lesson" level below `Course`
(content is attached to a course × division as resources).

**Migrations:** 17, from `20261103000000_baseline` to `20261120000000_email_html_body`, all applied in
production with no schema drift (**P**). CI checks that the migration history builds an empty database
and that the schema has no drift (**E**).

## 3. Authentication

| Feature | Implementation | Level |
|---|---|---|
| Login (username + password) | bcrypt (cost 12); JWT access token, 15 min | **X** |
| Refresh | httpOnly `SameSite=Strict` cookie `rof_refresh` (path `/api/v1/auth`), rotated on every use; reuse revokes the session | **X** |
| Logout / logout everywhere | Refresh revoked; access token blacklisted by `jti` | **X** (logout), **E** (logout-all) |
| Lockout | 5 failed logins → 15 min; per-route limit 10 credential attempts/min; global 120 req/min | **E** |
| Token cut-off | `tokensValidAfter` invalidates older tokens after password change or role change | **E** |
| Student self-registration | Setting-controlled; optional approval and e-mail verification; requires an active academic year | **E** |
| Admin invitation / CSV bulk invitation | Activation link (7 days) to choose a password | **E**; invitation e-mail **X** |
| E-mail verification | Activation link (48 h) | **X** (real e-mail delivered locally) |
| Password reset | Single-use link (30 min); "password changed" notice | **P** (delivered, link on the frontend), **X** (link used end to end) |
| Coach application (MentorRequest) | Public application → admin approves/rejects | **E** |
| Password policy | 8–100 characters, at least one letter and one number | **E** |
| Google sign-in | Enum value only | — |

## 4. Authorization

- Every route declares `@Roles(...)`; `RolesGuard` enforces them; a unit test checks that
  `src/auth/permissions.ts` (31 named permissions mapped to the 3 roles, exposed at
  `GET /me/permissions`) matches the route decorators (**U**).
- Scope checks (`AccessService`): coaches act only on course × division pairs assigned to them;
  students only on their own division and submissions (**E**, security suite: every non-public route
  refuses anonymous callers and every role it does not allow).
- **Permissions are code, not data.** There are no custom roles, per-user grants, or
  admin sub-roles (e.g. "content admin" vs "user admin"). Administrators never grade, by design.

## 5. Features by area

| Area | What exists | Level |
|---|---|---|
| User management | List/filter, view, edit, suspend/reactivate, approve, change role, delete (with safeguards), resend invitation, send reset link, CSV import with dry run | **E**; admin list **X** |
| Profile (`/me`) | View/edit own profile, enrollments, courses, permissions, results | **E**/**X** |
| Academic years and enrollments | Years (planned/active/closed, one current), per-year student enrollment, promotion | **E** (no frontend page) |
| Divisions, schools, disciplines | Divisions (fixed codes) editable; schools listed/created at registration; disciplines read-only API | **E** |
| Courses | Admin create/edit/publish/unpublish/archive; course completion by students | **E**/**X** |
| Resources | Coach upload (books, e-books, notes, past papers, attachments), metadata, publish/unpublish/archive/restore, attachments, views | **X** |
| Assignments | Coach draft → submit for approval → admin publish/reject; recall, unpublish, close (automatic at deadline), reopen, archive; brief + attachments; history | **X** |
| Submissions | Student upload (multiple files), resubmission as revisions, late rules | **X** |
| Review and results | Distribution (balanced/round-robin/manual) or direct assignment; coach start → mark (score ≤ maximum, written feedback, feedback files) → submit to admin; admin approve / send back; publish results per assignment; resubmission requests; reopen; full review history | **X** |
| Leaderboard | Points from published results; per division; visibility setting | **E** |
| Analytics and reports | Course analytics (coach/admin); 9 admin report views and 11 CSV exports; dashboard | **E**; dashboard/CSV **X** |
| Discussions and moderation | Course and assignment threads, comments, replies, reactions, reports, hide/restore/lock/pin/archive, moderation log | **E** |
| Study groups | Full module and tables; **not registered** in the app (programme decision) | **C** (disabled) |
| Notifications | In-app notifications with categories, read/unread, counters, deep links; per-category e-mail opt-out and per-type settings for admins/coaches | **X** |
| E-mail | Resend; branded HTML + text templates; outbox with retries, idempotency, rate pacing; bulk e-mail jobs to roles/divisions/schools/users | **P** (transactional), **E** (bulk) |
| Contact form / public site | Public statistics, contact messages (stored, admin list), support info | **P** (statistics), **E** |
| Files | Type detected from content, per-purpose size limits (10–50 MB), random keys, private streaming downloads, nightly orphan clean-up | **X** (local), **E** (S3Mock in CI); R2 upload in production not yet performed |
| Settings | 16 runtime settings (registration, assignment defaults, notifications, leaderboard, platform/support) | **E** |
| Audit log | 92 action types in 15 categories, append-only (database trigger), filters, CSV export | **E** |
| Activity log | Logins, views, submissions, posts; retention job | **E** (no frontend page) |
| Background jobs | E-mail outbox (10 s), deadline closer (5 min), token clean-up (hourly), data retention (02:00), storage orphan clean-up (03:00) | **E**/**U** |

## 6. Automated tests

| Suite | Size | Result (2026-11-07, commit `f624d25`) |
|---|---|---|
| Unit (`src/**/*.spec.ts`) | 37 files | 482 passed |
| End-to-end (`test/*.e2e-spec.ts`, real PostgreSQL) | 21 files | 289 passed, 3 skipped (S3 driver; runs in CI against S3Mock) |
| Route coverage | — | 202/202 routes called by e2e tests |
| Lint, type-check, build, API docs up to date | — | clean |
| CI (GitHub Actions) | test job + docker-compose smoke job | green on `main` (`5eec460`); later commits are not yet in a pull request |

Largest e2e suites: security (22), remaining-endpoints (22), dashboard-reports (18), submissions (18),
access (17), user-management (16), features (16), workflow (15), public-site (15), settings-audit (14),
discussions (14).

## 7. Implemented but not fully verified

| Item | What is missing |
|---|---|
| R2 storage in production | Health indicates a live bucket check; no production upload/download yet (needs a production coach/admin) |
| Frontend in production | `https://roflms.netlify.app` serves Netlify's 404; the fix is on the frontend branch, not deployed |
| Bulk e-mail, academic years, activity log | API tested; no frontend pages |
| Study groups | Code present, module disabled, no tests |
| Google sign-in | Not implemented despite the enum value |
| Production admin password strength | Not checked (should be rotated) |

## 8. Observations for the coming requirements (facts, not a comparison)

These are points where the current design is fixed or narrow, listed against the areas named for the
next phase. Whether each is a gap depends on the consolidated requirements.

| Area | Current state |
|---|---|
| Dynamic subjects and topics | `Discipline` → `Course` exists; disciplines are seeded and read-only through the API (`GET /disciplines` only); no topic/lesson level; content hangs off course × division |
| International registration | Grade levels S1–S6 and divisions JUNIOR/SENIOR are enums; `School` has no country; `User` has `homeLocation` only; no phone, date of birth, guardian or nationality fields |
| Granular permissions | 3 fixed roles; permissions defined in code; no custom roles or per-user grants |
| Account management | Strong admin tooling (invite, approve, suspend, role change, reset, delete); users can edit only first name, last name and home location (`PATCH /me`); no avatar upload; no account self-deletion/export |
| Publishing workflows | Assignments and results have full approval workflows with history; resources and courses have publish states without approval steps |
| Student support services | Public support info and a contact form only; no tickets, counselling or request tracking |
| Communication groups | Study groups exist but are disabled; bulk e-mail reaches roles, divisions, schools or chosen users; no in-app messaging between users |
| Notifications | In-app + e-mail with per-category and per-type settings; no push or SMS; the frontend polls every 60 s |
| Audit logs | Append-only, broad coverage, CSV export; activity log separate with retention |

## 9. Risks and technical debt

- **Enum-based structure** (roles, divisions, grade levels): changing them needs migrations and touches
  many services; plan carefully if structures must become dynamic.
- **Permissions in code**: adding configurable roles would change the guard, `permissions.ts`,
  `/me/permissions` and every scope check.
- **Render free plan**: the service sleeps after ~15 idle minutes; scheduled jobs (02:00, 03:00) only
  run if it is awake; first requests after sleep are slow.
- **Unmerged work**: backend commits `cc27c8d`, `962e1f0`, `f624d25` and the frontend branch are not
  yet in `main`.
- **Disabled code** (study groups) carries maintenance cost; decide to revive or remove when the
  communication-group requirements are known.
- **Password policy** is minimal (8 chars, letter + number).

## 10. Next step

Waiting for `ROF_LMS_CONSOLIDATED_REQUIREMENTS.md`. Then: map each requirement to this inventory, and
write the six audit documents. No implementation before approval.
