# ROF LMS backend — architecture

This document describes the backend as implemented. It is the reference for
anyone extending the API or building a client against it.

## 1. Overview

```
HTTP ─► Helmet · CORS · Throttler ─► JwtAuthGuard (global) ─► RolesGuard (global) ─► ValidationPipe
                                     │
          Controllers — parse input, declare roles, call one service method
                                     │
          Services — business rules, state machines, AccessService scope checks
             │              │                 │                    │
        PrismaService   StorageService    EventEmitter ──► NotificationListener
         (PostgreSQL)   (local | S3)                         │
                                                  Notification rows + EmailDelivery outbox
                                                             │
                                          EmailWorker (every 10 s, SKIP LOCKED) ─► Resend API

Cross-cutting: AllExceptionsFilter · request id · AuditService · SettingsService
```

- **Stateless API.** All state is in PostgreSQL and the storage driver, so any
  number of instances can run behind a load balancer (with `STORAGE_DRIVER=s3`).
- **Background work runs in-process** (`@nestjs/schedule`) and is safe across
  instances: the e-mail worker claims rows with `FOR UPDATE SKIP LOCKED`;
  state changes use conditional updates. `WORKERS_ENABLED=false`
  turns workers off on a given instance.

## 2. Academic model

- **Divisions** — exactly two rows: `JUNIOR` (S1–S3) and `SENIOR` (S4–S6).
  A student's `gradeLevel` determines their `divisionId`.
- **Courses** — exactly four rows (`code`: ALGEBRA, GEOMETRY, NUMBER_THEORY,
  COMBINATORICS), created by the seed. Admins edit text and publish/unpublish;
  they cannot create or delete courses.
- **Scope** — content is owned by a **(course × division)** pair. Resources,
  assignments and course discussions all carry `courseId` and
  `divisionId`. Junior and Senior Algebra share a course record but have
  separate content.
- **Mentor assignments** — admins assign mentors to scopes
  (`MentorAssignment`). A mentor can only act inside their active scopes.
- **Disciplines** — courses belong to a `Discipline` (Mathematics at launch);
  more subjects are new rows, not schema changes.
- **Academic years** — exactly one `AcademicYear` is current. Each student has
  a `StudentEnrollment` per year (grade, division, school, status); the
  current placement is mirrored on `User` for fast scoping. Assignments
  belong to a year.
- **Enrollment in courses** — a student follows all four courses of their
  division; `CourseEnrollment` tracks per-course progress (Unrolled → Rolled →
  Completed).
- **New school year** — `POST /admin/academic-years/:id/activate` closes the
  current year (archiving its assignments) and rolls every active student
  over, promoting them one grade when asked (S3 → S4 changes division; S6
  graduates). Enrolment history is kept.

## 3. Authorization

Three layers, all enforced server-side:

1. **Authentication** — global `JwtAuthGuard`; routes opt out with `@Public()`.
   The user is reloaded from the database on every request, so suspension,
   role or division changes apply immediately.
2. **Role** — global `RolesGuard`; each route lists its roles with `@Roles()`.
   There is **no implicit admin override**. Grading routes are `MENTOR` only,
   so administrators cannot score or give academic feedback.
3. **Scope / ownership** — `AccessService`:
   - students: own division, published courses, published content;
   - mentors: their assigned scopes; submissions assigned to them;
   - admins: everything.
   Out-of-scope students get `404` (existence is not revealed); mentors get
   `403 NOT_ASSIGNED_TO_SCOPE`.

**Tokens.** Access JWT (HS256, 15 min, `sub` + `jti`). Refresh token: 48 random
bytes, stored as SHA-256, rotated on every use, grouped in a family; replaying
a used token revokes the family (`REFRESH_TOKEN_REUSED`). Browsers get it as an
`httpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`; other
clients use the response body. Logout is public and authenticated by the
refresh token (cookie or body), so it works after the access token has expired:
it revokes that refresh family, blacklists the access `jti` if a still-valid
access token is sent, and always clears the cookie. Password change/reset,
"sign out everywhere", suspension and role changes end every session: refresh
tokens are revoked and `User.tokensValidAfter` makes earlier access tokens
invalid at once. Rotation, logout and "end every session" of one user are
serialised by a transaction-scoped advisory lock (namespace 4216), so a refresh
racing a sign-out cannot leave a valid token behind. Access tokens issued in
the signed-out session (other than the one sent with the logout) stay valid
until they expire (at most 15 minutes).

The full role-by-route table is [AUTHORIZATION.md](AUTHORIZATION.md),
generated from the same metadata the guards enforce.

**Account lifecycle.**

| How the account is created | Activated |
|---|---|
| Admin creates it with a password (`POST /admin/users`) | immediately |
| Admin invites (`POST /admin/users/invite`) or imports CSV (`POST /admin/users/import`) | when the person opens the e-mailed link and chooses a password (`POST /auth/activate`, 7 days) |
| Student self-registers | after confirming their e-mail (48 h) when `registration.requireEmailVerification` is on — the default in production; otherwise immediately |
| Mentor applies (`POST /mentor-requests`) and an admin approves | after confirming their e-mail when verification is on (the applicant chose the password); otherwise on approval. Applications an admin rejects never become accounts |

Administrators can create (`POST /admin/users`) or invite any user with any
role — student, mentor or administrator — and change anyone's role, details,
password and status. Mentors are normally added this way; applying is optional.

Un-activated accounts cannot log in (`ACCOUNT_NOT_ACTIVATED`) and can never
hold a session. `POST /auth/resend-activation` and "forgot password" send a
fresh activation link to such accounts. Admins can re-send invitations, send a
password-reset link (`POST /admin/users/:id/send-password-reset`) — they never
see or set someone else's password after creation — and suspend/reactivate
accounts. Every one of these actions is written to the audit log.

**CSV import.** Header `firstName,lastName,email` plus optional
`role,gradeLevel,schoolName,schoolLocation,homeLocation,username`; UTF-8, ≤1 MB,
≤1000 rows. Every row is validated (same rules as an invitation), duplicates
within the file and against existing accounts are reported, valid rows are
invited, and `?dryRun=true` validates without creating anything.

**Passwords.** bcrypt cost 12; login timing is equalised for unknown users;
account state (suspended/pending) is only revealed after a correct password;
credential endpoints are rate-limited per IP. Five wrong passwords in a row
lock the account for 15 minutes whatever the source address (answered exactly
like a wrong password; audited as `LOCK_ACCOUNT`). Issuing a password-reset
link retires earlier unused ones, and one-time links are not kept in the
e-mail outbox once sent.

**HTTP.** Helmet headers; no `X-Powered-By`; CORS only for `CORS_ORIGINS`
(none when unset); `TRUST_PROXY` hops (default 1) so per-IP limits see the real
client and cannot be bypassed with a forged `X-Forwarded-For` when set
correctly; request bodies over `MAX_UPLOAD_REQUEST_MB` are refused before they
are read; unknown body/query fields are rejected; errors never include stack
traces or database details.

## 4. Workflows (state machines)

Step-by-step business workflows (accounts, academic year, assignment → result,
resubmissions, corrections, moderation) are in
[WORKFLOWS.md](WORKFLOWS.md). In short:

All transitions use `UPDATE … WHERE status IN (allowed)`; a request that loses a
race gets `409 INVALID_STATE_TRANSITION` instead of corrupting state.

**Assignment** — mentors prepare, admins publish:

```
DRAFT ─submit─► PENDING_APPROVAL ─publish─► PUBLISHED ─deadline / admin─► CLOSED
  ▲  ◄──recall──┘        │reject(note)           │unpublish (only with 0 submissions)
  └── REJECTED ◄─────────┘                       ▼ DRAFT
any state ─admin / year closes─► ARCHIVED
```

**Submission** — the eight-step review pipeline:

```
SUBMITTED ─assign/distribute─► ASSIGNED ─start─► IN_REVIEW ─mark─► MARKED ─return─► SUBMITTED_TO_ADMIN
   ▲ resubmit (unassigns)         ▲                  ▲                                │approve      │reject(reason)
   └──────── student ─────────────┘                  └──── REJECTED ◄─────────────────┼─────────────┘
                                                              ▲                        ▼
                                                              └──── reopen ◄── PUBLISHED ◄─publish── APPROVED
```

- The academic review lives in `MentorReview`. Each assignment of a mentor,
  reassignment or reopen starts a new review **cycle**; earlier cycles stay as
  history (SUPERSEDED / CANCELLED) and every step is a `ReviewEvent`. Each
  distribution run is a `DistributionBatch`; each results publication a
  `ResultRelease`.
- A mentor may ask for a resubmission (`RESUBMISSION_REQUESTED`, with a due
  date); the new attempt returns to the same mentor.
- Students may resubmit while `SUBMITTED`/`ASSIGNED`, before the deadline, within
  `maxResubmissions`. Revisions are numbered 1, 2, 3 … and each keeps its files
  (several per attempt).
- `allowLateSubmission` accepts a first submission after the deadline, flagged `isLate`.
- Distribution strategies: `BALANCED` (fewest open reviews) or `ROUND_ROBIN`,
  limited to active mentors of the assignment's scope.
- Students never see score/feedback before `PUBLISHED`. `coordinationNote` is
  internal (admins only).

**Points.** On publication a result earns
`round(assignment.points × score / maximumMarks)`. `User.points` and
`problemsSolved` are a cache recomputed from published results inside the same
transaction, so they cannot drift; `POST /admin/leaderboard/recompute` rebuilds
them. Leaderboards are per division and use SQL `RANK()`.

## 5. Data model

**See [DATABASE.md](DATABASE.md)** for the ERD, every table, integrity rules,
deletion/archival/retention policies, migrations and seeding. Groups:

| Area | Models |
|---|---|
| Identity | User, RefreshToken, PasswordResetToken, TokenBlacklist, MentorRequest, School |
| Structure | Discipline, Course, Division, AcademicYear, StudentEnrollment, MentorAssignment, CourseEnrollment |
| Content | CourseResource, ResourceAttachment, ResourceView, FileObject |
| Assessment | Assignment, AssignmentAttachment, AssignmentView, Submission, SubmissionRevision, SubmissionAttachment, DistributionBatch, MentorReview, ReviewAttachment, ReviewEvent, ResultRelease |
| Community | DiscussionThread, Comment, CommentReaction, ContentReport, ModerationAction, StudyGroup, StudyGroupMember |
| Messaging | Notification, NotificationPreference, EmailJob, EmailDelivery |
| Admin | SystemSetting, AuditLog, ActivityLog |

## 6. Files

`StorageService` is the only way to store or serve files.

- **Upload**: multer keeps the file in memory (never on disk) until the service
  has authorized the request. The **type is detected from the bytes** and checked
  against a per-purpose allow-list and size limit:

  | Purpose | Allowed | Max |
  |---|---|---|
  | SUBMISSION | PDF, images (incl. HEIC), DOC/DOCX, ZIP, TXT | 20 MB |
  | FEEDBACK | PDF, images, DOC/DOCX, TXT | 10 MB |
  | ASSIGNMENT_BRIEF | PDF, images, DOC/DOCX, ZIP, TXT | 20 MB |
  | RESOURCE | + PPT/PPTX, EPUB | 50 MB |

  Files are stored under a random key; a `FileObject` row records the original
  name, detected type, size and SHA-256.
- **Download**: always through an authorized endpoint, streamed with the stored
  type, `Content-Disposition` (inline only for PDF/images), `nosniff` and a
  sandboxing CSP.
- **Drivers**: `local` (disk, single instance) or `s3` (AWS S3, Cloudflare R2,
  MinIO …). A nightly job deletes files nothing references any more.

Details: [STORAGE.md](STORAGE.md).

## 7. Notifications

Services emit domain events after their changes commit (`events.ts`).
`NotificationListener` maps them to recipients and writes:

- **in-app** `Notification` rows, each with a category, type, deep-link
  `link`, `createdAt` and `readAt`. Users list their own (filter by category,
  type or unread), read one, mark one/several/all read or one unread, and get
  unread counts per category. Every query is scoped to the caller, so another
  user's notification answers 404 (or a no-op update);
- **e-mail** rows in the `EmailDelivery` outbox, respecting per-category
  opt-outs (`ACCOUNT` e-mails cannot be disabled) and the global
  `notifications.emailEnabled` setting.

**Choosing notifications (admins and mentors).** In their profile settings
(`GET/PATCH /me/notification-settings`, `POST …/reset`) administrators and
mentors switch each notification type they receive on or off, separately for
in-app and e-mail. The switchable types, with labels and descriptions, are
listed in `notification-types.ts`; everything is on by default and only
"off" choices are stored (`NotificationSetting`). `NotificationsService.notify`
drops recipients who switched a type off before writing rows or queuing
e-mail. Students' notifications are not switchable.

`EmailWorker` sends the outbox with bounded concurrency, retries with
exponential backoff (5 attempts) and recomputes bulk-job counters from the
delivery rows. E-mails are plain text. Adding SMS or push later means adding a
channel to `NotificationsService`; no schema change is needed.

Scale: recipients are written with chunked `createMany` (1 000 rows per
statement), e-mails go through the outbox rather than inline, the inbox is
served by the (`userId`, `createdAt`) and (`userId`, `readAt`) indexes,
and read notifications are pruned after 180 days. There are no automatic
reminders: every notification is triggered by an action.

| Event | Recipients |
|---|---|
| Assignment submitted for review | Admins |
| Assignment published | Students of the division; the author |
| Assignment rejected | The author |
| Submission received | The student (in-app) |
| Submissions assigned (awaiting review) | Each mentor |
| Resubmission requested / request withdrawn | The student |
| Review returned | Admins (in-app) |
| Review sent back / result reopened | The mentor |
| Results published | Each student |
| Resource published | Students of the division (in-app) |
| New discussion thread | Mentors of that course × division (in-app) |
| New comment / reply | The thread's author / the comment's author (in-app) |
| Content reported | Admins (in-app) |
| Content hidden, removed, restored or locked | Its author |
| Report reviewed | The reporters (in-app) |
| Mentor application decided, password reset | The person |

## 7a. Dashboard and reports (administrators)

All figures are computed live from the database; nothing is cached or
hard-coded. Every endpoint is `ADMIN`-only.

| Endpoint | Content |
|---|---|
| `GET /admin/dashboard` | Students (total, active, inactive, awaiting setup, by division, by course), mentors (states, who completed reviews, most reviews), assignments, submissions, pending/completed reviews, results, reported content, accounts awaiting setup |
| `GET /admin/reports/students`, `mentors` | Paginated lists with account status, placement, scopes and per-person figures |
| `GET /admin/reports/enrollment` | Enrolments per year × division × school × grade by status |
| `GET /admin/reports/course-participation` | Per course × division: students, opened/completed, submissions, average score, discussion |
| `GET /admin/reports/assignments` | Per assignment: expected, submitted, late, missing, stage, average score |
| `GET /admin/reports/reviews` | Pending (status, age, per mentor) and completed (outcomes, send-backs, average/median turnaround) |
| `GET /admin/reports/results-publication` | Published, awaiting, releases, publishers, per assignment |
| `GET /admin/reports/mentor-activity` | Per mentor: reviews assigned/completed/open, send-backs, turnaround, assignments, comments |

Each report also has a `….csv` download with the same filters: every row,
streamed from the database in batches of 2 000 (keyset paging; no row limit, flat
memory — `src/reports/csv.ts`, `csv-stream.ts`). A failure after the download has
started aborts the connection, so a truncated file is never saved as complete.
Downloads are audited with their filters.

**Filters** (validated; unknown ids → 404): `academicYearId` (default the
current year, `all` for every year), `divisionId`, `courseId`, `from`/`to`
(ISO 8601; a plain date is the whole day in `APP_TIMEZONE`), and `status`
(`ACTIVE`, `INACTIVE`, `AWAITING_SETUP`) on user reports. A filter a report
cannot apply is rejected (`FILTER_NOT_SUPPORTED`) rather than ignored.
Snapshot figures (pending reviews, open reports, account states) describe the
present; the date range limits activity figures (registered, published,
submitted, reviewed, reported).

**Queries.** Counts and group-bys run in the database; per-row figures are
fetched for the current page with one grouped query per figure; averages and
medians are computed in SQL. Indexes support the date-range filters
(`MentorReview.returnedAt`, `Submission.submittedAt`/`publishedAt`,
`ResultRelease.publishedAt`) and users by role and state.

## 7b. System settings and audit trail

**Settings** (`GET/PATCH /admin/settings`, admins only) are declared in
`settings.registry.ts` — only declared keys exist, each validated by type and
limits — and grouped by category:

| Category | Settings |
|---|---|
| Registration | self sign-up, approval, e-mail verification |
| Assignments | default resubmission rules (allow, limit), default late submissions, default resubmission-request window, distribution strategy |
| Notifications | e-mail copies of notifications on/off |
| Platform | name, leaderboard visibility |
| Support | e-mail, phone, hours, help link (https), message — public at `GET /support` |

Academic years (dates, which one is current) are managed under
`/admin/academic-years`. Every changed setting is written to the audit log
(`UPDATE_SETTING`, record = the key, `{ from, to }`) in the same transaction.

**Audit trail.** `AuditService.log` records who acted (`actorId`,
`actorRole`, and `actorUsername`, filled in by the database), the action, the
affected record (`entity`, `entityId`), details (`metadata`, never passwords)
and the time. Important changes are written in the same transaction as the
change itself. Recorded among others: user creation (including each imported
account), updates with before/after values, role changes
(`CHANGE_USER_ROLE`), placement/enrolment changes (`CHANGE_STUDENT_ENROLLMENT`,
`UPDATE_ENROLLMENT`), activation/deactivation (`UPDATE_USER_STATUS`), mentor
scopes, assignment creation and publication, distribution, every review step
and grade, results publication, moderation, settings and academic years.

The table is append-only: a database trigger rejects UPDATE and DELETE (the
only allowed change is the foreign key clearing `actorId` when an account is
deleted; the username stays). There are no API routes that write audit
records. Administrators read it at `GET /admin/audit-logs` (filters:
`category`, `action`, `actorId`, `actorRole`, `entity`, `entityId`, `from`,
`to`), `GET /admin/audit-logs/:id`, `GET /admin/audit-logs/actions` and
`GET /admin/audit-logs/export.csv` (the export itself is audited).

## 8. Errors and logging

`AllExceptionsFilter` returns one JSON shape for every error with a stable
`code` (e.g. `DEADLINE_PASSED`, `NOT_ASSIGNED_MENTOR`, `FILE_TYPE_NOT_ALLOWED`).
Prisma errors map to 409/404; unexpected errors become a generic 500 and are
logged with the request id. Every response carries `X-Request-Id`. Logs are
JSON in production. Audit entries are written in the same transaction where
atomicity matters; otherwise a failed audit write is logged and never fails a
successful request.

## 9. Testing

| Layer | Where | What |
|---|---|---|
| Unit | `src/**/*.spec.ts` | Pure rules, guards, filter, storage, authorization metadata |
| End-to-end | `test/*.e2e-spec.ts` | Real app + real PostgreSQL: the full 8-step workflow, auth flows, role and scope boundaries, uploads, discussions, notifications, e-mail outbox, admin tools |
| Security | `test/security.e2e-spec.ts` | Every route against every role, token forgery/expiry/revocation, lockout, isolation, uploads, injection, data exposure, headers |
| Route coverage | `npm run test:routes` | Fails if any API route has no e2e test |
| CI | `.github/workflows/ci.yml` | lint → typecheck → unit → migrate empty DB → drift check → e2e → build → API docs up to date → route coverage → Docker image |

How to run them, and what each suite covers: [TESTING.md](TESTING.md).

## 10. Decisions taken

| Question | Decision |
|---|---|
| Student data | Grade/division/school stored on `User` (nullable for staff), enforced by a CHECK constraint |
| Points | Proportional to the score; per-division leaderboards; students see first name + initial |
| Registration | Open self-signup; admin can close it or require approval (settings) |
| Score corrections | Admin "reopen" returns the result to the mentor; admins never edit scores |
| Study groups | Switched off: the module is not registered, so `/study-groups` does not exist. Code and tables are kept (re-register `StudyGroupsModule` in `AppModule` to restore). |
| Storage | Abstracted; local for dev, S3-compatible for production |
| Job queue | PostgreSQL outbox + in-process workers (no Redis) |
| Academic years | Bulk promotion endpoint; no per-year history model yet |
