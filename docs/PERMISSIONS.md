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
| `TEACHER` | Teacher | after M1 (P1-05) | Students of the teacher's assigned schools (P1-11, school scope): list by default; profile, assignment progress (no grades) and submitting on a student's behalf only by an individual delegation from an Administrator or Super Admin. No grading, no student account or password changes. |
| `MENTOR` | Coach | in use | Assigned course × division: manage resources, prepare assignments, **grade**, course analytics, discussions; leaderboard. |
| `HEAD_COACH` | Head Coach | after M1 (P1-05) | Own programme(s): view, analytics, reports, scoped student and user info, manage student membership and coaches (invite → approval), assign coaches, monitor coaches, activity. Grades and prepares **only** through a course × division assignment an Administrator created (H4). No discussion moderation (H7). |
| `ADMIN` | Administrator | in use | Everything administrative: today's 25 permissions plus the new granular administrative names. **Never grades or prepares assignments** (RS1). Keeps `users.manageAdmins` until the Super Admin boundary (P1-08, A7). |
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
| `courses.view` | division | course × division | course × division | programme | all | all |
| `courses.complete` | own | — | — | — | — | — |
| `resources.view` | division | course × division | course × division | programme | all | all |
| `resources.manage` | — | — | course × division | — | all | all |
| `assignments.view` | division | course × division | course × division | programme | all | all |
| `assignments.prepare` | — | — | course × division | course × division | — | — |
| `assignments.publish` | — | — | — | — | all | all |
| `submissions.submit` | own | — | — | — | — | — |
| `submissions.viewOwn` | own | — | — | — | — | — |
| `submissions.distribute` | — | — | — | — | all | all |
| `reviews.grade` | — | — | course × division | course × division | — | — |
| `results.approve` | — | — | — | — | all | all |
| `results.publish` | — | — | — | — | all | all |
| `discussions.participate` | division | course × division | course × division | programme | all | all |
| `discussions.report` | division | course × division | course × division | programme | all | all |
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
  - `STUDENT`, `MENTOR` and `ADMIN` get today's list, unchanged;
  - `TEACHER`, `HEAD_COACH` and `SUPER_ADMIN` have no legacy list, so they get their effective
    catalogue permissions, in catalogue order (reachable only after M1);
  - an unsupported role gets `[]`.
- **`scopes.courseDivisions`:** a Coach's active course × division assignments; every other role gets `[]`.
- **Deferred:** `scopes.programmes` (P1-07) and `overrides` (P1-09).
