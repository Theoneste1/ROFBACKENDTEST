# API change plan — ROF LMS

**Updated:** 2026-11-08 · **Design status:** APPROVED DESIGN DIRECTION, subject to the final implementation review ([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)) · **Nothing implemented** · **Base path:** `/api/v1` (unchanged)
Current API: 202 routes, OpenAPI in `docs/api/openapi.json`, generated and checked in CI.
Sources: [BACKEND_REQUIREMENTS_AUDIT.md](BACKEND_REQUIREMENTS_AUDIT.md), [DATABASE_CHANGE_PLAN.md](DATABASE_CHANGE_PLAN.md).

## 1. Compatibility rules

1. **No silent breaking changes** (development rule 9). Existing paths, fields and status codes keep working.
2. **Additive by default:** new fields are added to responses; old fields stay (e.g. `gradeLevel: "S4"` next to `gradeLevelRef`).
3. **Renames keep aliases:** `/disciplines` → `/subjects`, `/mentor-requests` → `/registration-applications`; old paths remain documented as deprecated.
4. **New required inputs behind settings:** new mandatory registration fields (guardian phone, country, date of birth) become required only when a setting is switched on after the frontend sends them.
5. **Semantics changes are documented and versioned in the changelog** (only one planned: `DELETE /admin/users/:id` → archive, §4).
6. Every new route: explicit permission (or public), DTO validation, pagination for lists, the standard error shape, OpenAPI docs, e2e test (route-coverage check stays 100 %).

## 2. Permission catalogue (proposed)

Permissions stay **defined in code** (a fixed catalogue); profiles and assignments are data. Existing names are kept.

| Area | Permissions (new in **bold**) |
|---|---|
| Users | `users.manage` (kept) → split into **`users.view`**, **`users.create`**, **`users.edit`**, **`users.suspend`**, **`users.archive`**, **`users.restore`**, **`users.purge`**, **`users.export`**, **`users.viewSensitive`** |
| Registration | **`registrations.view`**, **`registrations.approve`**, `mentorRequests.decide` (kept as alias) |
| Permissions | **`permissions.view`**, **`permissions.manage`**, **`permissions.assign`** |
| Reference data | **`reference.manage`** (countries, regions, education systems, grades), **`schools.manage`** |
| Academic | `academicYears.manage`, `enrollments.manage`, `divisions.manage`, `courses.manage`, `mentorAssignments.manage` (kept); **`subjects.manage`**, **`topics.manage`**, **`courses.manageAccess`** (ADR-006) |
| Students (scoped) | **`students.viewScoped`** — view student information only within the holder's scope (teachers, ADR-003) |
| Content | `resources.view`, `resources.manage` (kept); **`resources.publish`**, **`resources.approve`** |
| Assessment | existing (`assignments.prepare`, `assignments.publish`, `submissions.*`, `reviews.grade`, `results.*`); **`assignments.approve`** = alias of `assignments.publish` |
| Support | **`support.submit`**, **`support.view`**, **`support.manage`**, **`support.respond`** |
| Groups | **`groups.view`**, **`groups.manage`**, **`groups.moderate`**, **`groups.post`** |
| Communication | `email.bulkSend` (kept) → scoped by audience; **`email.preview`** |
| Insight | `analytics.course`, `leaderboard.view`, `reports.export`, `audit.view`, `activity.view` (kept) |
| Settings | `settings.manage` (kept) |

Scope types: `GLOBAL`, `COUNTRY`, `SCHOOL`, `SUBJECT`, `COURSE`, `DIVISION`, `GROUP`, `SUPPORT_ASSIGNED`.

**Updated 2026-11-09 (Phase 1):** the Phase 1 catalogue and the six-role matrix are in [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §5 (*proposed*, PERM).
- **Existing permission names are kept**, so the frontend keeps working.
- New in Phase 1: `reports.view`, `students.viewScoped`, `users.view`, `users.manageStudents`, `users.manageCoaches`, `users.manageTeachers`, `users.manageHeadCoaches`, `users.manageAdmins`, `programmes.manageHeads`, `programmes.manageMembers`, `coaches.monitor`, `settings.manageSystem`, `permissions.view`, `permissions.manageOverrides`.
- The finer `users.*` split (create/edit/suspend/archive/…) and the other areas above belong to their later phases.
- Phase 1 scopes: own, division, course × division, programme, global.

### 2.1 Seeded system profiles (approved, ADR-003/004)

> **Deferred 2026-11-09 (D3):** custom/seeded profile *records* are deferred. In Phase 1 the same role defaults are fixed in code per user type (STUDENT, TEACHER, COACH (`MENTOR`), HEAD_COACH, ADMIN, SUPER_ADMIN). Teacher assignment authoring is an individual **override** of `assignments.prepare` granted by the Super Admin, not a grantable profile.

| Profile | Permissions |
|---|---|
| `student` | exactly today's STUDENT permissions |
| `coach` | exactly today's MENTOR permissions (including today's direct resource publishing) |
| `super_admin` | exactly today's ADMIN permissions + all new administrative permissions |
| `teacher` (Phase 5) | own profile; `courses.view`, `resources.view` (scoped: SCHOOL/SUBJECT/COURSE); **`resources.manage` = create and submit for approval only** (no `resources.publish`/`resources.approve`); `discussions.participate`, `discussions.report`, `groups.view`/`groups.post` where a member; `students.viewScoped`. **Not included:** `reviews.grade`, `users.*`, `resources.approve`, `assignments.publish`, any global admin permission |
| `assignment_author` (grantable, Phase 5) | `assignments.prepare` (create and submit assignments for approval), scoped — granted to teachers only where authorized |

## 3. New endpoints

### 3.1 Permissions
| Method | Path | Permission |
|---|---|---|
| GET | `/admin/permissions/catalogue` | `permissions.view` |
| GET/POST | `/admin/permission-profiles` | `permissions.view` / `permissions.manage` |
| GET/PATCH/DELETE | `/admin/permission-profiles/:id` | `permissions.view` / `permissions.manage` (system profiles: Super Administrator only) |
| GET | `/admin/users/:id/permissions` | `permissions.view` |
| POST | `/admin/users/:id/permission-assignments` | `permissions.assign` (cannot grant beyond own permissions/scope) |
| DELETE | `/admin/users/:id/permission-assignments/:assignmentId` | `permissions.assign` |
| POST/DELETE | `/admin/users/:id/permission-overrides[/:id]` | `permissions.assign` |
| GET | `/me/permissions` | authenticated — **extended**: `{ role, permissions[], scopes[], profiles[] }` |

**Updated 2026-11-09 (Phase 1).** The endpoints above for profiles and profile assignments are **deferred** with custom profiles (D3). The Phase 1 endpoints are below, all additive; the full table is in [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §10.

| Method | Path | Access |
|---|---|---|
| GET | `/me/permissions` | authenticated — extended to `{ role, roleLabel, permissions[], scopes{ programmes[], courseDivisions[] }, overrides[] }`; existing fields unchanged |
| PATCH | `/admin/users/:id/role` | per-actor role allow-list; step-up confirmation when the target is ADMIN/SUPER_ADMIN (the same allow-list applies to `POST /admin/users`, `/admin/users/invite` and `PATCH /admin/users/:id`) |
| GET | `/programmes` | authenticated (existing disciplines, read-only) |
| GET/PUT | `/admin/programmes/:id/heads` | `programmes.manageHeads` |
| GET/POST/DELETE | `/admin/programmes/:id/members[/:userId]` | `programmes.manageMembers` (HEAD_COACH: own programme, students and coaches only) |
| GET/POST/DELETE | `/admin/teacher-assignments[/:id]` | `users.manageTeachers` |
| GET | `/admin/permissions/catalogue` | `permissions.view` |
| GET | `/admin/users/:id/permissions` | `permissions.view` (effective permissions with their source) |
| GET/POST/DELETE | `/admin/users/:id/permission-overrides[/:id]` | `permissions.manageOverrides` (**SUPER_ADMIN only**; approved list; never for themselves or for a SUPER_ADMIN) |

Existing endpoints that Head Coaches use with a forced programme filter: `/admin/users*`, `/admin/mentor-assignments`, the user invitation, dashboard/reports/analytics/activity. Programme creation and editing are **not** in Phase 1 (P2: Phase 3).

### 3.2 Reference data and schools
| Method | Path | Permission |
|---|---|---|
| GET | `/reference/countries`, `/reference/countries/:id/regions`, `/reference/countries/:id/education-systems`, `/reference/education-systems/:id/grade-levels` | public (active items only) |
| GET/POST/PATCH | `/admin/countries[/:id]`, `/admin/regions[/:id]`, `/admin/education-systems[/:id]`, `/admin/grade-levels[/:id]` | `reference.manage` |
| POST/PATCH | `/admin/schools`, `/admin/schools/:id`, `/admin/schools/:id/status` | `schools.manage` |
| POST | `/admin/schools/import?dryRun=` | `schools.manage` |
| GET | `/schools/search?countryId=&q=` | public — **extended** with country filter |

### 3.3 Subjects, topics, courses
| Method | Path | Permission |
|---|---|---|
| GET | `/subjects`, `/subjects/:id`, `/subjects/:id/topics` | authenticated (filtered by availability) |
| GET/POST/PATCH | `/admin/subjects[/:id]`, `PATCH /admin/subjects/:id/{publish,archive,restore}` | `subjects.manage` |
| PUT | `/admin/subjects/:id/availability` | `subjects.manage` |
| GET/POST/PATCH | `/admin/topics[/:id]`, `PATCH /admin/topics/reorder`, `/admin/topics/:id/{archive,restore}` | `topics.manage` |
| POST | `/admin/courses` | `courses.manage` — new courses default to `accessPolicy: ENROLLMENT_REQUIRED` (today courses can only be seeded) |
| PATCH | `/admin/courses/:id/access` `{ accessPolicy, confirm }` | `courses.manageAccess` (scoped). Widening to `DIVISION_OPEN` requires `confirm: true` and returns the number of newly entitled students; without it → 409 `CONFIRMATION_REQUIRED` with that number. Audited |
| GET/POST/DELETE | `/admin/courses/:id/enrollments[/:userId]` | `enrollments.manage` (scoped) |
| GET | `/disciplines` | kept (alias of `/subjects`, deprecated) |

### 3.4 Accounts and registration
| Method | Path | Permission |
|---|---|---|
| POST | `/admin/users/:id/transition` `{ to, reason }` | per target state (`users.suspend`, `users.archive`, `registrations.approve`) |
| POST | `/admin/users/:id/restore` | `users.restore` |
| GET | `/admin/users/:id/history` | `users.view` |
| POST | `/admin/users/bulk` `{ action, userIds[], reason }` | per action |
| GET | `/admin/users/export.csv` | `users.export` (+ `users.viewSensitive` for sensitive columns) |
| GET | `/admin/users/:id/data-export` | `users.export` + `users.viewSensitive` |
| GET | `/registration/form?userType=` | public (fields, required flags, enabled types) |
| POST | `/auth/register/teacher` | public (if enabled) |
| GET | `/admin/registrations` (students pending approval + applications) | `registrations.view` |
| PATCH | `/registration-applications/:id/{approve,reject,request-info}` | `registrations.approve` |
| POST | `/registration-applications/:id/info` (applicant reply, token link) | public with token |
| POST | `/me/avatar`, `DELETE /me/avatar` | authenticated |

### 3.5 Publishing and versioning
| Method | Path | Permission |
|---|---|---|
| POST | `/courses/:courseId/resources/:id/revisions` | `resources.manage` (scoped) |
| GET | `/courses/:courseId/resources/:id/revisions[/:n]` | `resources.manage` / `resources.approve` |
| PATCH | `/courses/:courseId/resources/:id/revisions/:n/{submit,approve,request-changes,reject}` | submit: `resources.manage`; others: `resources.approve` |
| GET | `/admin/approvals?type=&status=` (resources + assignments queue) | `resources.approve` or `assignments.publish` |

### 3.6 Student Support and Services (authenticated portal; the public contact form `/public/contact` is unchanged — ADR-012)
| Method | Path | Permission |
|---|---|---|
| GET | `/support/categories` | authenticated |
| POST | `/support/requests` (multipart, attachments) | `support.submit` |
| GET | `/me/support/requests`, `/support/requests/:id` | owner (student-visible messages only) |
| POST | `/support/requests/:id/messages` | owner or staff (staff may set `visibility: INTERNAL`) |
| GET | `/admin/support/requests?status=&categoryId=&assigneeId=&priority=` | `support.view` (scope `SUPPORT_ASSIGNED` = own only) |
| PATCH | `/admin/support/requests/:id` `{ status, priority, assigneeId }` | `support.manage` |
| POST/PATCH | `/admin/support/requests/:id/meeting` | `support.manage` / assigned coach |
| GET/POST/PATCH | `/admin/support/categories[/:id]` | `support.manage` |

### 3.7 Groups and targeted e-mail (ADR-013/014 — **no private one-to-one messaging endpoints** in release 1)
| Method | Path | Permission |
|---|---|---|
| GET | `/groups`, `/me/groups`, `/groups/:id` | member or `groups.view` |
| POST/PATCH | `/admin/groups[/:id]`, `/admin/groups/:id/{archive,restore}` | `groups.manage` (GLOBAL) |
| POST/DELETE/PATCH | `/groups/:id/members[/:userId][/role]` | `groups.manage` scoped GROUP, or group OWNER/MODERATOR |
| POST | `/groups/:id/invitations` | as above |
| GET/POST | `/groups/:id/threads` (type DISCUSSION/ANNOUNCEMENT) | member per posting policy; announcements: moderators |
| POST | `/admin/email/preview` `{ audience… }` → `{ count, sample[] }` | `email.bulkSend` (+ audience scope) |
| POST | `/admin/email/send` — **extended** modes GROUP, COUNTRY, SUBJECT, USER_TYPE; requires `previewToken` | `email.bulkSend` |

## 4. Changed endpoints

| Endpoint | Change | Compatibility |
|---|---|---|
| `DELETE /admin/users/:id` | archives instead of hard delete; `USER_HAS_HISTORY` no longer returned | **semantics change** — same 200 response shape; announce in changelog; permanent delete moves to `POST /admin/users/:id/purge` |
| `POST /auth/register/student` | + dateOfBirth, countryId, phone, guardianPhone, guardianName, interestedSubjectIds, gradeLevelId | additive; required only when setting `registration.student.extendedFieldsRequired` is on |
| `POST /mentor-requests` | + userType, phone, countryId, institution, qualifications, expertise, experience, subjectIds | additive |
| `GET/PATCH /admin/users[/:id]`, `GET/PATCH /me` | + status, country, phones (masked without `users.viewSensitive`), avatar, interests, permissions summary | additive; sensitive fields masked by default |
| `GET /admin/users` | + filters status, userType TEACHER, countryId, subjectId | additive |
| Course resources | + `status`, `publishedRevision`; `isPublished` kept (derived) | additive |
| `PATCH .../resources/:id/publish` | when approval is required for the caller: 403 `APPROVAL_REQUIRED` → use revisions submit | behaviour change only when the setting is on |
| `/courses`, `/me/courses` | honours `accessPolicy`; + `topic`, `subject` objects | additive; DIVISION_OPEN courses unchanged |
| Discussions | threads accept `groupId`; `type` field | additive |
| Notifications | new categories/types | additive (frontend must ignore unknown types gracefully) |
| Role enum in all responses | may contain `TEACHER` (**2026-11-09:** also `HEAD_COACH` and `SUPER_ADMIN`; COACH stays `MENTOR`) | **frontend must handle** — before any account holds a new role |

## 5. Guard migration

- Add `@RequirePermission('x.y', { scope? })` alongside `@Roles()`. New routes use permissions only.
- Existing routes migrate area by area; during migration the guard accepts **either** the legacy role **or** the permission, and a unit test asserts both give the same result for system profiles.
- Effective permissions resolved per request from the database with a short-lived cache keyed by user and invalidated on assignment changes (no JWT change, refresh flow untouched).
- **Updated 2026-11-09:**
  - First, every route declares its access (`@Roles`, `@RequirePermission` or `@Authenticated`); a test enforces this.
  - *Proposed* (D9): each route then switches to the permission check **alone**, once a generated equivalence test proves identical decisions for STUDENT, COACH and ADMIN. This replaces the "either role or permission" transition.
  - Override expiry is evaluated against `expiresAt` on every request; a cached entry never outlives its expiry.

**New error codes (2026-11-09, Phase 1):** `ROLE_NOT_ASSIGNABLE`, `OVERRIDE_NOT_ALLOWED`, `LAST_SUPER_ADMIN`, `STEP_UP_REQUIRED`, `TEACHERS_DISABLED`, `HEAD_COACHES_DISABLED` (plus `SCOPE_FORBIDDEN` below).

## 6. Error codes (new)

`APPROVAL_REQUIRED`, `PERMISSION_ESCALATION`, `SCOPE_FORBIDDEN`, `INVALID_STATUS_TRANSITION`, `REGISTRATION_CLOSED`,
`REFERENCE_INACTIVE`, `DUPLICATE_SCHOOL`, `SUPPORT_REQUEST_CLOSED`, `GROUP_ARCHIVED`, `PREVIEW_REQUIRED`, `CONFIRMATION_REQUIRED`.
