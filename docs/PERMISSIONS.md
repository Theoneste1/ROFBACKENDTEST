# Permissions (six roles)

The permission layer added in P1-04 ([Phase 1 plan](PHASE-1-PLAN.md) v5.2 §4–§6, §8.1). Code:
`src/auth/permissions.ts` (catalogue), `src/auth/permission.service.ts`,
`src/auth/guards/permission.guard.ts`, `src/auth/decorators/require-permission.decorator.ts`.

> **Current enforcement is unchanged.** No route uses `@RequirePermission` yet. Every route is
> still protected by `@Public` / `@Roles` / `@Authenticated` (see [AUTHORIZATION.md](AUTHORIZATION.md)),
> and the services still apply their scope and record-level checks. Routes move to permissions in
> P1-06, one batch at a time, after the equivalence test passes for each batch.

## Roles

| Stored value | Label | Today | Intended permissions (summary) |
|---|---|---|---|
| `STUDENT` | Student | in use | Own division's courses, resources and assignments; completes courses, submits and sees **own** work; takes part in and reports division discussions; leaderboard. |
| `TEACHER` | Teacher | after M1 (P1-05) | Students of the teacher's assigned schools (P1-11, school scope): list by default; profile, assignment progress (no grades) and submitting on a student's behalf only by an individual delegation from an Administrator or Super Admin. No grading, no student account or password changes. No course, resource, assignment or discussion access (the unused course × division grants were removed on 2026-11-14). |
| `MENTOR` | Coach | in use | Assigned course × division: manage resources, prepare assignments, **grade**, course analytics, discussions; leaderboard. |
| `HEAD_COACH` | Head Coach | after M1 (P1-05) | Own programme(s): view, analytics, reports, scoped student and user info, manage student membership and coaches (invite → approval), assign coaches, monitor coaches, activity. Grades and prepares **only** through a course × division assignment an Administrator created (H4). No discussion moderation (H7). |
| `ADMIN` | Administrator | in use | Everything administrative: today's 25 permissions plus the new granular administrative names, including managing Head Coaches (accounts, programme heads and members, coach monitoring — owner decision D-5, 2026-11-14). **Never grades or prepares assignments** (RS1). Never gives or manages `SUPER_ADMIN`. Keeps `users.manageAdmins` until the Super Admin boundary (P1-08, A7). |
| `SUPER_ADMIN` | Super Administrator | after M1 (P1-05) | Everything an Administrator holds, written out separately (no inheritance), plus `permissions.manageOverrides` and `settings.manageSystem`. **Never grades or prepares assignments** (RS1). |

Any other stored value is an unsupported role. It has no permissions, gets `roleLabel: null`
from `/me/permissions`, and is refused by every `@RequirePermission` route (least privilege, as in P1-03).

## Matrix

Scope: **own** = own records · **division** = own division · **course × division** = assigned
course × division · **programme** = own programme(s) · **all** = global · **—** = not granted.
The scope says *where* a grant applies. The services enforce it (AccessService), not the
permission guard.

<!-- The table below is checked against ROLE_GRANTS by src/auth/permissions.spec.ts. -->

| Permission | Student (`STUDENT`) | Teacher (`TEACHER`) | Coach (`MENTOR`) | Head Coach (`HEAD_COACH`) | Administrator (`ADMIN`) | Super Administrator (`SUPER_ADMIN`) |
|---|---|---|---|---|---|---|
| `courses.view` | division | — | course × division | programme | all | all |
| `courses.complete` | own | — | — | — | — | — |
| `resources.view` | division | — | course × division | programme | all | all |
| `resources.manage` | — | — | course × division | — | all | all |
| `assignments.view` | division | — | course × division | programme | all | all |
| `assignments.prepare` | — | — | course × division | course × division | — | — |
| `assignments.publish` | — | — | — | — | all | all |
| `submissions.submit` | own | — | — | — | — | — |
| `submissions.viewOwn` | own | — | — | — | — | — |
| `submissions.distribute` | — | — | — | — | all | all |
| `reviews.grade` | — | — | course × division | course × division | — | — |
| `results.approve` | — | — | — | — | all | all |
| `results.publish` | — | — | — | — | all | all |
| `discussions.participate` | division | — | course × division | programme | all | all |
| `discussions.report` | division | — | course × division | programme | all | all |
| `discussions.moderate` | — | — | — | — | all | all |
| `analytics.course` | — | — | course × division | programme | all | all |
| `leaderboard.view` | all | all | all | all | all | all |
| `reports.export` | — | — | — | — | all | all |
| `users.manage` | — | — | — | — | all | all |
| `academicYears.manage` | — | — | — | — | all | all |
| `enrollments.manage` | — | — | — | — | all | all |
| `divisions.manage` | — | — | — | — | all | all |
| `courses.manage` | — | — | — | — | all | all |
| `mentorAssignments.manage` | — | — | — | programme | all | all |
| `mentorRequests.decide` | — | — | — | — | all | all |
| `settings.manage` | — | — | — | — | all | all |
| `email.bulkSend` | — | — | — | — | all | all |
| `audit.view` | — | — | — | — | all | all |
| `activity.view` | — | — | — | programme | all | all |
| `reports.view` | — | — | — | programme | all | all |
| `students.viewScoped` | — | school | — | programme | all | all |
| `users.view` | — | — | — | programme | all | all |
| `users.manageStudents` | — | — | — | programme | all | all |
| `users.manageCoaches` | — | — | — | programme | all | all |
| `users.manageTeachers` | — | — | — | — | all | all |
| `users.manageHeadCoaches` | — | — | — | — | all | all |
| `users.manageAdmins` | — | — | — | — | all | all |
| `programmes.manageHeads` | — | — | — | — | all | all |
| `programmes.manageMembers` | — | — | — | programme | all | all |
| `coaches.monitor` | — | — | — | programme | all | all |
| `settings.manageSystem` | — | — | — | — | — | all |
| `permissions.view` | — | — | — | — | all | all |
| `permissions.manageOverrides` | — | — | — | — | — | all |
| `students.viewProfile` | — | — | — | — | — | — |
| `students.viewProgress` | — | — | — | — | — | — |
| `submissions.submitOnBehalf` | — | — | — | — | — | — |
| `schools.manage` | — | — | — | — | all | all |
| `schools.syncDirectory` | — | — | — | — | — | all |
| `users.viewStatusHistory` | — | — | — | — | all | all |
| `users.changeStatus` | — | — | — | — | all | all |
| `users.suspend` | — | — | — | — | all | all |
| `users.archive` | — | — | — | — | all | all |
| `users.bulkManage` | — | — | — | — | all | all |
| `users.export` | — | — | — | — | all | all |
| `forms.view` | — | — | — | — | all | all |
| `forms.manageAvailability` | — | — | — | — | all | all |
| `forms.editMessages` | — | — | — | — | all | all |
| `reference.manage` | — | — | — | — | all | all |
| `tests.view` | — | — | — | programme | all | all |
| `tests.manage` | — | — | — | programme | all | all |
| `tests.manageMarkers` | — | — | — | programme | all | all |
| `tests.extensions` | — | — | — | programme | all | all |
| `tests.viewSubmissions` | — | — | — | programme | all | all |
| `tests.submit` | own | — | — | — | — | — |
| `tests.submitForStudents` | — | school | — | — | — | — |

## Test Management (WS3, Phase 1; owner-approved plan 2026-11-19)

`tests.view`, `tests.manage`, `tests.manageMarkers`: Administrators and Super Admins in every subject; Head Coaches only in
the subjects (programmes) they head — any Head Coach of the subject may act, and the audit log records which one did. The
service checks the subject on every request (another subject: 403 `SCOPE_FORBIDDEN`). Coaches, Teachers and Students hold
none of them (authorised markers arrive in Phase 3; marking will be a separate permission in `ADMIN_PROHIBITED`, so
Administrators never mark or adjust marks, G4). A marker authorisation is separate from a coach's Olympiad interests: an
interest never grants marking. The marking guide is served only to holders of `tests.view` for the test's subject. Every
change is audited in the TESTS category, in the same transaction. Appended to the frozen ADMIN list additively.

### Phase 2: deadlines, extensions, submissions

- `tests.extensions` (grant / edit / cancel deadline extensions) and `tests.viewSubmissions` (submission tracking, every
  version with its submitter, teacher and extension status): Administrators and Super Admins in every subject; Head
  Coaches in the subjects they head (same service check). Appended to the frozen ADMIN list additively.
- `tests.submit` (own): Students submit and replace their own answer to a published, open test of their division.
  Appended to the frozen STUDENT list additively, so the student portal shows My tests.
- `tests.submitForStudents` (school; owner decision G2): every Teacher of a school, primary or secondary, by default —
  only for the VERIFIED students of their own ACTIVE schools whose account is active (another student: 403
  `STUDENT_NOT_IN_SCOPE`). The course-assignment delegation `submissions.submitOnBehalf` is separate and unchanged
  (individual GRANT only).
- Deadlines come from one service, in database time; a student or teacher sees the deadline that applies to them, never
  an "extended" mark (Administrators and Head Coaches only — never markers). All new; none is in `ADMIN_PROHIBITED` or
  `NEVER_GRANTABLE`; like every default, each can be denied to an individual.

## Countries (owner decision 2026-11-19)

`reference.manage` (Administrators and Super Admins, global; appended to the frozen ADMIN list additively): correct a
country's name or calling code (`GET`, `PATCH /admin/countries…`). Never granted by an individual override. Everyone reads
the public list (`GET /countries`). No country is blocked from registration; a country never sets a level or division.
Every change is audited (REFERENCE_DATA, `COUNTRY_UPDATED`).

## Administrators and Head Coaches (D-5, 2026-11-14)

Administrators manage Head Coaches within their administrative responsibilities — nothing here is a new
power; `ADMIN_GRANTS` already held each permission, and `/me/permissions` now reports them:

| What | Route(s) | Permission |
|---|---|---|
| Create, invite, import, edit and change the role of accounts to and from `HEAD_COACH` (only while `HEAD_COACHES_ENABLED` = `true`, capability `headCoachAccounts`) | `/admin/users`, `/admin/users/invite`, `/admin/users/import`, `PATCH /admin/users/:id` | `users.manageHeadCoaches` (role allow-list) |
| Set the Head Coaches heading a programme | `GET/PUT /admin/programmes/:id/heads` | `programmes.manageHeads` |
| Manage programme members (students and coaches) | `/admin/programmes/:id/members`, `/admin/programmes/:id/student-candidates` | `programmes.manageMembers` |
| Monitor coaches | `/admin/reports/mentors`, `/admin/reports/mentor-activity` | `coaches.monitor` |
| Scoped dashboards and reports | `/admin/dashboard`, `/admin/reports/students`, `/admin/reports/course-participation` | `reports.view` |

Unchanged limits: an Administrator never gives `SUPER_ADMIN` (never on creation; a role change to it
is a Super Admin's, with step-up), never manages a `SUPER_ADMIN` account, cannot remove the last
Super Admin, never sets overrides (`permissions.manageOverrides`) and, with
`SUPER_ADMIN_BOUNDARY_ENABLED` on, no longer manages `ADMIN` accounts.

## Head Coaches adding students (2026-11-14)

`GET /admin/programmes/:id/student-candidates?search=` (`programmes.manageMembers`) finds students to add
to a programme by first name, last name or username (2–100 characters; e-mail addresses are never searched).
It returns active `STUDENT` accounts that are not active members of that programme, with name, username,
grade, division and school only — never contact details, grades or feedback (D7). For a Head Coach:

- only programmes they head (any other programme → 404);
- only students who are **not active members of any programme** — a student in another programme is never
  returned; moving a student between programmes stays an Administrator responsibility;
- `POST /admin/programmes/:id/members` refuses such a student with 409 `STUDENT_IN_OTHER_PROGRAMME`
  (checked under a per-student lock, so two Head Coaches cannot both add the same student).

Administrators may use the same route (students not in this programme, whatever their other memberships)
and keep their wider account search (`GET /admin/users`).

## Grading restriction for administrators (RS1)

`ADMIN` and `SUPER_ADMIN` can never hold `reviews.grade` or `assignments.prepare`. Three
independent layers enforce this:

1. **Catalogue.** Neither role has the grant (`ROLE_GRANTS`; Super Admin is written out, not derived from Admin).
2. **`PermissionService.effective()`.** It removes both permissions from any administrative role's
   effective set, whatever the source. Future sources such as individual overrides (P1-09) join
   through this method, so neither inheritance nor aggregation can add them.
3. **`PermissionGuard`.** A route requiring either permission refuses `ADMIN` and `SUPER_ADMIN`,
   even if the service reported the grant.

## `@RequirePermission` and the permission guard

- The guard is registered globally after `JwtAuthGuard` and `RolesGuard`.
- **No `@RequirePermission` on the route → the guard does nothing.** The P1-02 guard-decision
  baseline (`src/common/decorators/route-access-baseline.json`) is unchanged with the guard in the chain.
- **`@RequirePermission('x.y')`:**
  - the caller must hold the permission, or the request gets `403 PERMISSION_REQUIRED`
    (`details.permission` names it);
  - it **fails closed**: no user, an unsupported role, or a missing grant all mean 403.
  - only genuinely absent metadata (`undefined`) is a no-op; metadata that is present but not a known
    permission (empty string, `null`, an unknown name, a non-string) means 403 for every caller.
- **It checks the permission only.** Record-level rules (own submission, own notification)
  and scope rules (division, course × division, programme) stay in the services.
- **Declaration rules** (`route-declarations.spec.ts`):
  - `@RequirePermission` is the fourth declaration kind, at method level only, with one known permission;
  - combining it with `@Public`, `@Roles` or `@Authenticated` is rejected as contradictory.
- **`@Public` is not a bypass.** Plan §4.3 listed "`@Public` → allow" as a guard step. It was
  dropped (agreed in P1-04 review) so that an explicit requirement always fails closed. A route
  carrying both would never be authenticated (`JwtAuthGuard` skips `@Public` routes), so the
  guard would see no user and refuse it with 403. It would never be open. Tested in
  `permission.guard.spec.ts` and `route-declarations.spec.ts`.

## Equivalence (A4)

`src/auth/permission-equivalence.spec.ts`:

- **Catalogue.**
  - `STUDENT` and `MENTOR` hold exactly today's permissions.
  - `ADMIN` holds all of today's 25, plus only the listed granular names.
  - `SUPER_ADMIN` holds Admin's set plus its two own permissions, and nothing prohibited.
  - Every one of the six roles is covered.
- **Routes.**
  - For each handler with `@RequirePermission`, the decision for `STUDENT`, `MENTOR` and `ADMIN`
    must equal its P1-02 baseline decision, unless it is listed in
    `src/auth/permission-equivalence.exceptions.ts`.
  - Unlisted differences and stale exceptions fail.
  - The mapping is read from the decorator metadata, and is empty in P1-04.
  - The harness is proven on synthetic controllers: equivalent, widened, narrowed, listed
    exception, stale exception and RS1 cases.

## `GET /api/v1/me/permissions`

```jsonc
{
  "role": "MENTOR",
  "roleLabel": "Coach",                       // new (P1-04)
  "permissions": [ "courses.view", "…" ],     // unchanged for STUDENT, MENTOR, ADMIN (A1)
  "scopes": { "courseDivisions": [ { "courseId": "…", "divisionId": "…" } ] }   // new (P1-04)
}
```

- **`permissions`:**
  - `STUDENT`, `MENTOR` and `ADMIN` get today's list, unchanged, except that the `ADMIN` list
    also ends with `schools.manage` (2026-11-12), `users.manageTeachers` (2026-11-13) and, in this
    order, `users.manageHeadCoaches`, `programmes.manageHeads`, `programmes.manageMembers`,
    `coaches.monitor`, `reports.view` (2026-11-14, owner decision D-5: Administrators manage Head
    Coaches within their administrative responsibilities). Administrators already held all of them
    (global) and the routes already admitted them; the list now reports them. Changes to the ADMIN
    list are **additive only**. Still not listed for `ADMIN`: `users.manageAdmins`,
    `users.manageStudents`, `users.manageCoaches`, `users.view`, `students.viewScoped`,
    `permissions.view` (held, not reported) and never `permissions.manageOverrides`,
    `settings.manageSystem`, `schools.syncDirectory` (not held);
  - `TEACHER`, `HEAD_COACH` and `SUPER_ADMIN` have no legacy list, so they get their effective
    catalogue permissions, in catalogue order (reachable only after M1). **Contract change
    (2026-11-14):** a `TEACHER` no longer gets `courses.view`, `resources.view`, `assignments.view`,
    `discussions.participate` or `discussions.report` — the list is now `leaderboard.view`,
    `students.viewScoped` plus any delegation granted to that teacher. Those grants were course × division
    scoped, and no teacher course × division assignment exists, so no service ever let a Teacher through
    on them. `TEACHERS_ENABLED` is off in production; no live client depended on them;
  - an unsupported role gets `[]`.
- **`scopes.courseDivisions`:** a Coach's active course × division assignments; every other role gets `[]`.
- **Deferred:** `scopes.programmes` (P1-07) and `overrides` (P1-09).
