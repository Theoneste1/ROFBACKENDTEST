# Database change plan — ROF LMS

**Updated:** 2026-11-08 · **Design status:** APPROVED DESIGN DIRECTION, subject to the final implementation review ([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)) · **Nothing applied** · **Source:** [BACKEND_REQUIREMENTS_AUDIT.md](BACKEND_REQUIREMENTS_AUDIT.md)
Current schema: 46 models, 30 enums, 17 migrations (last `20261120000000_email_html_body`), all applied in production.

## 1. Principles

1. **Additive first (expand → migrate → contract).** New tables and nullable columns first; backfill; switch reads/writes in code; drop old columns/enums only in a later, separately approved migration.
2. **Never change or reuse an existing primary key.** Every course, assignment, resource, submission, review and result keeps its ID (Mathematics preservation, requirement §4.4/§20).
3. **One concern per migration**, each with a written rollback (`rollback.sql` next to `migration.sql`, kept in the repository, never run automatically).
4. **Rehearsal before production:** apply to a Neon branch created from production, run the verification queries (§6), run the e2e suite against it, then apply to production with explicit approval.
5. **Backups:** confirm Neon point-in-time restore window and perform one restore drill before the first structural migration.
6. **No data deletion** in this programme without a separately approved plan.

## 2. Mandatory migration and production safety rules (ADR-015, approved)

1. New migration names start at **`20261121000000`** and are **strictly increasing**.
2. A **CI check** rejects migrations whose names do not sort after the newest migration on `main`.
3. **Rollback instructions** for every structural migration (`rollback.sql` or documented steps).
4. **Rehearsal** against a **restored copy of production** before production deployment.
5. **Backup and restoration verified** (restore drill) before the first structural migration.
6. **Controlled R2 upload and download test** before features that add uploads.
7. **No destructive production change without explicit approval.**

### 2.1 Background of the naming rule

Existing names are sequence numbers written as dates (`20261103000000` … `20261120000000`), not creation times
(all were created 3–7 November 2026). A migration generated today by `prisma migrate dev` would be named
`20261108…` and sort **before** applied migrations, breaking replay order.

- Name new migrations manually and sequentially: `20261121000000_<name>`, `20261122000000_<name>`, …
- Generate SQL with `prisma migrate diff`, place it in the new folder, then `prisma migrate dev` to verify.
- CI check: every migration added on a branch must sort after the newest migration on `main`.

## 3. Proposed changes by workstream

Sizes: S (1 table/column), M (several tables + backfill), L (enum replacement or cross-cutting backfill).

### 3.1 Phase 1 — Permission foundation (ADR-004)

| Change | Detail | Size |
|---|---|---|
| `PermissionProfile` | id, key (unique), name, description, isSystem, isActive, createdById, timestamps | S |
| `PermissionProfilePermission` | profileId, permission (string from the code catalogue), unique (profileId, permission) | S |
| `UserPermissionAssignment` | userId, profileId, scopeType (`GLOBAL`/`COUNTRY`/`SCHOOL`/`SUBJECT`/`COURSE`/`DIVISION`/`GROUP`), scopeId (nullable for GLOBAL), grantedById, grantedAt, revokedAt; index (userId, revokedAt) | S |
| `UserPermissionOverride` | userId, permission, effect (`GRANT`/`DENY`), scopeType, scopeId, grantedById, timestamps | S |
| Backfill | seed system profiles `student`, `coach`, `super_admin` with **exactly** today's `ROLE_PERMISSIONS` (STUDENT, MENTOR, ADMIN); assign each existing user the profile of their role with GLOBAL scope (coach course × division scope stays in `MentorAssignment`). Phase 5 adds `teacher` (default rights, ADR-003) and a grantable `assignment_author` profile | M |

Rollback: drop the four tables (no existing table touched).

### 3.2 Phase 2 — Countries, education systems, grades, schools (ADR-005)

| Change | Detail | Size |
|---|---|---|
| `Country` | id, isoCode (unique, ISO 3166-1 alpha-2), name, isActive, sortOrder | S |
| `Region` | id, countryId, name, isActive; unique (countryId, name) | S |
| `EducationSystem` | id, countryId, code, name, isActive | S |
| `GradeLevel` (table) | id, educationSystemId, code (e.g. `S1`), name, sortOrder, isActive; unique (educationSystemId, code) | S |
| `DivisionGradeLevel` | divisionId, gradeLevelId (replaces hard-coded grade→division mapping in `common/grade-levels.ts`) | S |
| `School` | + `countryId`, `regionId`, `type`, `isActive`, `normalizedName`; unique index changes from (name) to (countryId, normalizedName) — **after** duplicate check | M |
| `User` | + `countryId`, `regionId`, `gradeLevelId` (nullable) | S |
| `StudentEnrollment` | + `gradeLevelId` (nullable) | S |
| Backfill | Rwanda (`RW`), education system "Rwanda (REB)", grade levels P1–P6 and S1–S6; existing users/enrollments/schools linked to Rwanda and the matching grade level; division mapping S1–S3 → JUNIOR, S4–S6 → SENIOR | L |
| Contract (later, separate approval) | drop `User.gradeLevel` / `StudentEnrollment.gradeLevel` enum columns and the `GradeLevel` enum once all reads use the table | L |

### 3.3 Phase 3 — Subjects and topics (ADR-007)

| Change | Detail | Size |
|---|---|---|
| `Discipline` → subject | + `status` (DRAFT/PUBLISHED/ARCHIVED, existing rows PUBLISHED), `visibility` (PUBLIC/RESTRICTED), `iconFileId`, `createdById`, `updatedById`, `archivedAt`; table name unchanged (API calls it "subject") | S |
| `Topic` | id, disciplineId, code, name, description, sortOrder, status, archivedAt, created/updated by; unique (disciplineId, code) | S |
| `Course` | + `topicId` (nullable) | S |
| `SubjectAvailability` | disciplineId, rule type (COUNTRY/GRADE_LEVEL/DIVISION/GROUP), ruleId | S |
| `UserSubjectInterest` | userId, disciplineId (registration "interested subjects", teacher "subjects taught", coach "subjects") with a `kind` column | S |
| Backfill | one Topic per existing math course (Algebra, Geometry, Number Theory, Combinatorics) under MATHEMATICS; set `Course.topicId`; no other table changes | M |

### 3.4 Phase 4 — Account statuses and lifecycle (ADR-008)

| Change | Detail | Size |
|---|---|---|
| `AccountStatus` enum | PENDING_VERIFICATION, PENDING_APPROVAL, ACTIVE, SUSPENDED, REJECTED, ARCHIVED | S |
| `User` | + `status` (backfilled), `archivedAt`, `archivedById`, `dateOfBirth`, `phone`, `guardianPhone`, `guardianName`, `avatarFileId`, `organisationalRole`, `teachingPosition`, `yearsOfExperience`, `institution` | M |
| `AccountStatusEvent` | userId, from, to, reason, actorId, createdAt | S |
| Backfill rule | `!isActive` → SUSPENDED; else `activatedAt IS NULL` → PENDING_VERIFICATION; else `!isApproved` → PENDING_APPROVAL; else ACTIVE. Verify counts per rule before/after (§6) | M |
| Transition | code reads `status`; `isActive`/`isApproved`/`activatedAt` kept in sync until a later contract step | — |

### 3.5 Phase 5 — Registration applications (ADR-009) and TEACHER type (ADR-002/003)

| Change | Detail | Size |
|---|---|---|
| `Role` enum | + `TEACHER` (additive enum value; Postgres `ALTER TYPE … ADD VALUE`, cannot run inside the same transaction as its first use) | S |
| `MentorRequest` | + `userType` (COACH/TEACHER, default COACH), `phone`, `countryId`, `institution`, `qualifications`, `expertise`, `experience`, `decisionReason`, `infoRequestedAt`, `decidedById`, `decidedAt`; status + `INFO_REQUESTED` | M |

### 3.6 Phase 6 — Course access (ADR-006)

| Change | Detail | Size |
|---|---|---|
| `CourseAccessPolicy` enum | DIVISION_OPEN, ENROLLMENT_REQUIRED | S |
| `Course` | + `accessPolicy`. Migration: add the column with default `DIVISION_OPEN` so **every existing course keeps today's access**, then change the column default to `ENROLLMENT_REQUIRED` so **new courses require enrollment**. Verification: count of `DIVISION_OPEN` = count of courses before the migration | S |
| `CourseAccessChange` | courseId, from, to, actorId, confirmed, affectedStudentCount, createdAt (audit trail for access changes) | S |
| `CourseEnrollment` | + `accessGrantedAt`, `grantedById`, `accessRevokedAt` (separate from progress status) | S |

### 3.7 Phase 7 — Publishing and versioning (ADR-010/011)

| Change | Detail | Size |
|---|---|---|
| `ContentStatus` enum | DRAFT, PENDING_APPROVAL, CHANGES_REQUESTED, PUBLISHED, REJECTED, UNPUBLISHED, ARCHIVED | S |
| `CourseResource` | + `status` (backfilled from `isPublished`/`archivedAt`), `publishedRevisionId` | M |
| `ResourceRevision` | resourceId, revisionNumber, title, description, metadata, status, createdById, submittedAt, reviewedById, reviewedAt, reviewNote; attachments per revision | M |
| Backfill | revision 1 for every existing resource = current content; `publishedRevisionId` set for published ones | M |
| Later | `AssignmentRevision` for edits to published assignments | M |

### 3.8 Phase 8 — Student Support and Services (ADR-012; contact form unchanged)

| Change | Detail | Size |
|---|---|---|
| `SupportCategory` | id, code, name, description, isActive, sortOrder, requiresMeeting | S |
| `SupportRequest` | id, reference (unique, `SR-YYYY-NNNNNN`), studentId, categoryId, subject, description, status, priority, assigneeId, timestamps, closedAt | S |
| `SupportMessage` | requestId, authorId, body, `visibility` (STUDENT/INTERNAL), createdAt | S |
| `SupportAttachment` | messageId or requestId, fileId (`FilePurpose` + SUPPORT) | S |
| `SupportStatusEvent` | requestId, from, to, actorId, note | S |
| `SupportMeeting` | requestId, coachId, proposedTimes (JSON), confirmedAt, scheduledFor, status, outcome | S |
| Sequence | `support_reference_seq` per year (or counter table) | S |

### 3.9 Phase 9 — Communication groups and targeted e-mail (ADR-013/014; no private-message tables)

| Change | Detail | Size |
|---|---|---|
| `StudyGroup` | + `code` (unique, e.g. IMO2026), `type`, `visibility`, `membershipVisibility`, `postingPolicy`, `archivedAt` (tables reused; API name "groups") | S |
| `GroupRole` enum | + OWNER, MODERATOR (existing STUDENT/MENTOR kept) | S |
| `DiscussionThread` | + `groupId` (nullable), `type` (DISCUSSION/ANNOUNCEMENT) | S |
| `Comment` | + mentions (`CommentMention` table), attachments (`CommentAttachment`) | S |
| `EmailJob` | recipient modes + GROUP/COUNTRY/SUBJECT/USER_TYPE; `previewedAt`, `confirmedById` | S |

### 3.10 Phase 10 — Notifications, audit, privacy

| Change | Detail | Size |
|---|---|---|
| `NotificationCategory` | + SUPPORT, GROUPS, PUBLISHING | S |
| `Notification` | + `dedupeKey` (nullable) with unique (userId, dedupeKey) | S |
| `FilePurpose` | + AVATAR, SUPPORT, SUBJECT_ICON | S |
| Audit | new action names only (no schema change); `metadata` stores before/after diffs without secrets or guardian data | — |

## 4. Enum strategy

- **Adding values** (`Role.TEACHER`, `FilePurpose`, `NotificationCategory`, `GroupRole`): additive; deploy code that tolerates the value before data uses it.
- **Replacing enums by tables** (`GradeLevel`, possibly `DivisionCode`): expand–contract over at least two releases; responses keep the old string field (`gradeLevel: "S4"`) alongside the new object until the frontend migrates.

## 5. Order and dependencies (phases 1–10)

```
3.1 permissions ─┬─ 3.2 reference data ─┬─ 3.3 subjects/topics ── 3.6 course access
                 │                      └─ 3.5 applications/teacher
                 ├─ 3.4 account lifecycle
                 ├─ 3.7 publishing/versioning
                 ├─ 3.8 support
                 └─ 3.9 groups ── 3.10 notifications/audit
```

## 6. Verification queries (before and after each backfill)

- Row counts per table touched; must be equal unless rows are intentionally added.
- Mathematics: `Discipline MATHEMATICS` exists; its 4 courses keep IDs, codes, assignment/resource/submission/review/result counts.
- Every user has exactly one system profile assignment matching their role; effective permissions = `ROLE_PERMISSIONS[role]`.
- Account status distribution equals the counts computed from the old flags.
- Every existing user/enrollment/school links to Rwanda and a grade level equal to its old enum value.
- No orphaned foreign keys (`LEFT JOIN … WHERE … IS NULL`).
- Published resources: `publishedRevisionId` set and equal to revision 1.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Migration ordering (naming) | §2 rule + CI check |
| Status backfill locks users out or re-activates suspended users | rule in §3.4, count verification, rehearsal on a Neon branch |
| School uniqueness change fails on duplicates | duplicate report before the index; merge tool |
| Enum replacement breaks reports/filters | expand–contract; keep string fields; e2e on the rehearsal branch |
| `ALTER TYPE … ADD VALUE` in a transaction | separate migration for enum additions |
| No staging / untested restore | Neon branch rehearsal + restore drill (Phase 0) |
| Small production dataset today (1 user, 4 courses, 0 assignments) | low risk now — do structural changes before real users arrive |
