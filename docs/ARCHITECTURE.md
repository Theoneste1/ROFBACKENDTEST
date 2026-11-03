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
                                          EmailWorker (every 10 s, SKIP LOCKED) ─► SMTP

Cross-cutting: AllExceptionsFilter · request id · AuditService · SettingsService
```

- **Stateless API.** All state is in PostgreSQL and the storage driver, so any
  number of instances can run behind a load balancer (with `STORAGE_DRIVER=s3`).
- **Background work runs in-process** (`@nestjs/schedule`) and is safe across
  instances: the e-mail worker claims rows with `FOR UPDATE SKIP LOCKED`;
  reminders and state changes use conditional updates. `WORKERS_ENABLED=false`
  turns workers off on a given instance.

## 2. Academic model

- **Divisions** — exactly two rows: `JUNIOR` (S1–S3) and `SENIOR` (S4–S6).
  A student's `gradeLevel` determines their `divisionId`.
- **Courses** — exactly four rows (`code`: ALGEBRA, GEOMETRY, NUMBER_THEORY,
  COMBINATORICS), created by the seed. Admins edit text and publish/unpublish;
  they cannot create or delete courses.
- **Scope** — content is owned by a **(course × division)** pair. Resources,
  assignments, live sessions and course discussions all carry `courseId` and
  `divisionId`. Junior and Senior Algebra share a course record but have
  separate content.
- **Mentor assignments** — admins assign mentors to scopes
  (`MentorAssignment`). A mentor can only act inside their active scopes.
- **Disciplines** — courses belong to a `Discipline` (Mathematics at launch);
  more subjects are new rows, not schema changes.
- **Academic years** — exactly one `AcademicYear` is current. Each student has
  a `StudentEnrollment` per year (grade, division, school, status); the
  current placement is mirrored on `User` for fast scoping. Assignments and
  live sessions belong to a year.
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
clients use the response body. Logout blacklists the access `jti` and revokes
the refresh family. Password change/reset revokes all sessions.

**Account lifecycle.**

| How the account is created | Activated |
|---|---|
| Admin creates it with a password (`POST /admin/users`) | immediately |
| Admin invites (`POST /admin/users/invite`) or imports CSV (`POST /admin/users/import`) | when the person opens the e-mailed link and chooses a password (`POST /auth/activate`, 7 days) |
| Student self-registers | immediately, or after confirming their e-mail when `registration.requireEmailVerification` is on (48 h) |
| Mentor application approved | immediately (the applicant chose the password) |

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
credential endpoints are rate-limited per IP.

## 4. Workflows (state machines)

All transitions use `UPDATE … WHERE status IN (allowed)`; a request that loses a
race gets `409 INVALID_STATE_TRANSITION` instead of corrupting state.

**Assignment** — mentors prepare, admins publish:

```
DRAFT ─submit─► PENDING_APPROVAL ─publish─► PUBLISHED
  ▲  ◄──recall──┘        │reject(note)           │unpublish (only with 0 submissions)
  └── REJECTED ◄─────────┘                       ▼ DRAFT
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

**Live session** — `SCHEDULED → CANCELLED` (host/admin) or `→ COMPLETED`
(worker, after `endsAt`). Reminders are sent once, ~1 hour before start.

## 5. Data model

**See [DATABASE.md](DATABASE.md)** for the ERD, every table, integrity rules,
deletion/archival/retention policies, migrations and seeding. Groups:

| Area | Models |
|---|---|
| Identity | User, RefreshToken, PasswordResetToken, TokenBlacklist, MentorRequest, School |
| Structure | Discipline, Course, Division, AcademicYear, StudentEnrollment, MentorAssignment, CourseEnrollment |
| Content | CourseResource, ResourceAttachment, ResourceView, LiveSession, FileObject |
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
served by the (`userId`, `createdAt`) and (`userId`, `readAt`) indexes, read
notifications are pruned after 180 days, and reminder jobs claim their work
with a single conditional UPDATE so several instances never double-send.

| Event | Recipients |
|---|---|
| Assignment submitted for review | Admins |
| Assignment published | Students of the division; the author |
| Assignment rejected | The author |
| Assignment due within 24 h (once per deadline; a moved deadline is reminded again) | Students of the division who have not submitted |
| Submission received | The student (in-app) |
| Submissions assigned (awaiting review) | Each mentor |
| Resubmission requested / request withdrawn | The student |
| Review returned | Admins (in-app) |
| Review sent back / result reopened | The mentor |
| Results published | Each student |
| Resource published | Students of the division (in-app) |
| Live session scheduled / changed (time or link) / cancelled / starting within the hour | Students of the division |
| New discussion thread | Mentors of that course × division (in-app) |
| New comment / reply | The thread's author / the comment's author (in-app) |
| Content reported | Admins (in-app) |
| Content hidden, removed, restored or locked | Its author |
| Report reviewed | The reporters (in-app) |
| Mentor application decided, password reset | The person |

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
| End-to-end | `test/*.e2e-spec.ts` | Real app + real PostgreSQL: the full 8-step workflow, auth flows, role and scope boundaries, uploads, discussions, live sessions, notifications, e-mail outbox, admin tools |
| CI | `.github/workflows/ci.yml` | lint → typecheck → unit → migrate empty DB → drift check → e2e → build → Docker image |

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
