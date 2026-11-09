# ROF LMS — Phase 1 Permissions and Role Management Plan

**Version:** v5.2 (v5.1 + final owner sign-off of 2026-11-09).
**Status:** all Phase 1 decisions signed off by the owner (Theoneste) on 2026-11-09 — every item approved except H7 (changed: deferred), plus owner safeguards AS1 and AS2 (§2). Open items O1–O6 remain undecided (§2.6).
**Prepared:** 2026-11-09 from backend `develop` @ `aa01d2a` and frontend `main` @ `ea09fcc` (read-only).
**This document is planning only.** Nothing in it is implemented; every implementation PR, migration, bootstrap and flag change needs its own review and approval.
Related: [ARCHITECTURE_DECISIONS.md](../ARCHITECTURE_DECISIONS.md) (ADR-002/003/004/015/017/018/019) · [IMPLEMENTATION_TRACKER.md](../IMPLEMENTATION_TRACKER.md)

---

## 1. Summary

Six roles — **STUDENT, TEACHER, COACH (stored `MENTOR`), HEAD_COACH, ADMIN, SUPER_ADMIN** — with fixed role-based default permissions, Super-Admin-controlled individual overrides, and programme scope based on the existing `Discipline` records, all enforced in the backend.

Guarantees: existing IDs (incl. Mathematics), records, routes and response fields unchanged (additive only); STUDENT and COACH behaviour unchanged; ADMIN behaviour unchanged until a separately approved boundary switch after a verified Super Admin bootstrap; authentication and sessions unchanged.

Findings from the code that drive the order of work:

| # | Finding | Consequence |
|---|---|---|
| F1 | 54 of 211 route handlers declare neither `@Roles` nor `@Public` | every route declares access before any new role can be held |
| F2 | 111 role comparisons in 32 services (12 negative, 10 ternaries, 1 switch) | positive checks; unknown role → least privilege |
| F3 | create/invite DTOs accept any `Role`; `PATCH /admin/users/:id` can change role | one role allow-list on every create/change path |
| F4 | `MentorAssignment` feeds grading distribution (`submissions.service.ts:483`) and coach notifications; assignee must be `MENTOR` (`mentor-assignments.service.ts:53`) | separate teacher table; head coaches only by explicit assignment |
| F5 | no student/coach ↔ programme link; only Mathematics exists; no discipline create API | one link table + guarded backfill; no programme UI |
| F6 | `RolesGuard` has no override → unconverted `@Roles('ADMIN')` routes refuse `SUPER_ADMIN` | bootstrap only after all routes are converted |
| F7 | frontend hard-codes three roles | frontend tolerance before any new-role account |

---

## 2. Decision register

**Final owner sign-off: 2026-11-09.** The owner (Theoneste) has explicitly decided every item that was in categories B and C. All were approved except **H7**, which was changed (§2.3), and the owner added two safeguards (AS1, AS2, §2.4). The original categories are kept in the "Origin" column for traceability. The only items still without a decision are the open items in §2.6.

### 2.1 Confirmed before the final sign-off (originally category A)

| ID | Decision | Confirmed |
|---|---|---|
| **HC-A** | Head Coach authority is limited to the **assigned programme(s)** only (Option A) | 2026-11-09 |
| **D3** | Custom administrator-created permission profiles **deferred**; Phase 1 keeps fixed role-based defaults and individual overrides; overrides managed **only by Super Admin**, restricted to an approved permission list, audited and reversible; ADR-004 and PERM-02 amended, not deleted | 2026-11-09 |
| **S2** | Theoneste is the initial Super Admin; **deputy unassigned** (no automatic rights); creation only by the controlled one-off bootstrap, tested on non-production first; production run needs separate explicit approval; no account created or promoted during documentation | 2026-11-09 |
| **P2** | Physics/Computing programme creation deferred to Phase 3; Phase 1 uses existing `Discipline` records; no programme-management interface | 2026-11-09 |
| **P3** | `ProgrammeMembership` backfill: abort unless only one discipline exists; students → Mathematics; coaches → programmes of their assigned courses, else Mathematics; `source = BACKFILL`; verified on a Neon copy before production approval; no change to student division-based or coach assignment-based access; rollback documented | 2026-11-09 |
| **RS1** | SUPER_ADMIN must not inherit prohibited grading permissions (§8.1) | 2026-11-09 (PR 1 approval) |
| **RS2** | Expired overrides stop applying at `expiresAt`, independently of the scheduled audit job (§6.4) | 2026-11-09 (PR 1 approval) |
| **RS3** | Backfill acceptance tests: access regression, scope isolation, reconciliation, rollback (§11.5) | 2026-11-09 (PR 1 approval) |
| **PR1** | Phase 1 architecture approved in principle; PR 1 scope approved (documentation only) | 2026-11-09 |

### 2.2 Approved at the final sign-off (2026-11-09)

| ID | Decision | Origin | Outcome |
|---|---|---|---|
| C1 (R1) | COACH stays stored as `MENTOR`; label "Coach" | B | **Approved** |
| C2 (A1) | ADMIN cannot manage ADMIN or SUPER_ADMIN accounts (activation staged, §8.3) | B | **Approved** |
| C3 (A2, A3) | ADMIN appoints Head Coaches and runs ordinary programme operations | B | **Approved** |
| C4 | Head Coaches manage Students and Coaches within their programme, by explicit permissions | B | **Approved** |
| C5 (H1) | Head-Coach-created Coach accounts need ADMIN approval initially | B | **Approved** |
| C6 | Head Coaches: no automatic grading, no self-approval, no system-wide administration | B | **Approved** |
| C7 (S1) | SUPER_ADMIN system-wide; no automatic grading | B | **Approved** |
| C8 (T1) | Teacher assignments separate from Coach grading assignments | B | **Approved** |
| C9 | Mathematics IDs and existing data unchanged | B | **Approved** |
| C10 (D8) | Phase 0 paused; P0-06 not a prerequisite (manual migration-order check per PR) | B | **Approved** |
| BR | Backend PRs target `develop`; releases `develop → main`; Render deploys `main` (repository evidence: default branch, PRs #4–#10, AI protocol) | B | **Approved** |
| D1 | Teacher permission work in Phase 1 (earlier than the original Phase 5); teacher registration stays Phase 5 | C | **Approved** |
| D2 | Teachers: scoped view; assignment preparation only by override; resource submission in Phase 7 | C | **Approved** |
| D5 | Organisational role deferred to Phase 4/5 | C | **Approved** |
| D6 | Scopes: own, division, course × division, programme, global; school scope deferred | C | **Approved** |
| D7 | Student-information limits (§5) — **with clarification:** "progress" means **participation and learning activity only** (e.g. courses opened/completed, resources viewed, whether work was submitted and when); **never grades, marks, feedback or contact details** | C | **Approved with clarification** |
| D9 | Routes switch to permission-only checks after equivalence and matrix tests | C | **Approved** |
| PERM | Permission catalogue additions and six-role matrix (§5) | C | **Approved** |
| OV | Override approved list (§6.3) and override safeguards (§6.4) | C | **Approved** |
| H2 | Head Coach student actions: view, participation/learning activity, programme membership only | C | **Approved** |
| H3 | "Assign coaches to students" = the Head Coach assigns **Coaches** to course × division responsibilities within their assigned programme (through `MentorAssignment`, subject to the approved permissions); no coach–student table | C | **Approved** |
| H4 | A Head Coach **personally** teaches or grades only through an explicit assignment **created by an Administrator** and the normal grading distribution; a Head Coach cannot assign themselves (or another Head Coach) | C | **Approved** |
| H5 | Head Coach does not approve assignments or results | C | **Approved** |
| H6 | Head Coach: no resource management | C | **Approved** |
| H8 | Head Coach: no data export | C | **Approved** |
| H9 | Head Coach: no bulk e-mail | C | **Approved** |
| D4 | Super Admin safeguards (§8.2) | C | **Approved** (plus AS1, AS2) |
| S3 | MFA deferred; step-up password confirmation in Phase 1 | C | **Approved** |
| S4 | Database trigger protecting the last Super Admin (in addition to the service rule) | C | **Approved** |
| S5 | `settings.manageSystem` (SUPER_ADMIN): registration settings and integrations; existing settings stay ADMIN | C | **Approved** |
| BD | `SUPER_ADMIN_BOUNDARY_ENABLED` staged activation (§8.3) | C | **Approved** |

### 2.3 Changed at the final sign-off

| ID | Recommendation | Owner decision |
|---|---|---|
| **H7** | Head Coach moderates their programme's discussions | **Changed — deferred.** Head Coaches get **no** discussion-moderation permission in Phase 1. Moderation rights for Head Coaches will be designed separately, together with the discussion/communication features they apply to (the existing course and assignment discussions are moderated by ADMIN as today; communication groups come in Phase 9). |

### 2.4 Additional safeguards required by the owner (2026-11-09)

| ID | Safeguard | Where |
|---|---|---|
| **AS1** | Emergency (break-glass) recovery is **restricted, documented and audited** | §8.2 |
| **AS2** | Super Admin transfer is **atomic** and can **never** leave the system without an active Super Admin | §8.2 |

### 2.5 Deliberately deferred

| Item | To |
|---|---|
| Custom permission profiles (PERM-02) | later phase (D3) |
| Programme creation/editing (Physics, Computing) | Phase 3 (P2) |
| Organisational role | Phase 4/5 (D5) |
| Head Coach discussion moderation | separate design with the discussion/communication features (H7) |
| School and country scope | Phase 2/5 (Q21) |
| Teacher resource submission | Phase 7 |
| Teacher self-registration | Phase 5 |
| MFA | later phase (S3) |
| Individual coach–student supervision link | only if later required (visibility-only) |
| Direct coach creation by Head Coaches (O5) | later, separate decision |
| Several roles per person (O6, Q9) | Phase 5 |

### 2.6 Open items (not decided; nothing selected or created)

| ID | Item | Needed before |
|---|---|---|
| O1 | **Bootstrap target account** — must be an existing, active, activated ADMIN account belonging to Theoneste. **No account is selected in this stage.** If only the shared seeded `admin` account exists, a personal ADMIN account must be created first (possible while the boundary is off) | bootstrap approval request |
| O2 | **Deputy** — remains **unassigned**; any future Super Admin promotion is a separate approved action | — |
| O3 | Rotation of the seeded production `admin` password (outstanding since the production report) | bootstrap approval request (recommended) |
| O4 | ~~Base branch~~ — **resolved by repository evidence** (category B, BR); recorded for traceability | — |
| O5 | Whether Head Coaches may later create coaches without approval | later phase |
| O6 | Several roles per person (Q9) | Phase 5 |

---

## 3. Document updates made in PR 1 (documentation only)

*Historical: statuses below are as recorded by PR 1 (#10). The final statuses are in §2 (owner sign-off 2026-11-09).*

| Document | Update |
|---|---|
| ARCHITECTURE_DECISIONS.md — ADR-002 | role list becomes six roles (C1 storage note); one role per user (O6) — **status: proposed** (D1/D-series pending) except storage of COACH (B) |
| ADR-003 | teacher scope in Phase 1 = course × division + programme membership; school scope deferred — **proposed** (D1, D2, D6) |
| ADR-004 | **Amendment 2026-11-09 (confirmed scope change, D3):** fixed role-based defaults in code; individual overrides (Super Admin only, approved list, audited, reversible); custom profiles **deferred** (original text kept, marked *deferred*); "Super Administrator profile" becomes the `SUPER_ADMIN` role; transitional "either" guard replaced by permission-only after equivalence tests (D9 — proposed) |
| ADR-015 | exception recorded: CI migration-name check (rule 2, P0-06) not a Phase 1 prerequisite; manual order check per migration PR (C10) |
| ADR-017 | corrected: feature branches from `develop`; PRs into `develop`; releases by PR `develop → main`; Render deploys `main` (BR) |
| New ADR-018 — Programme scope | programme = `Discipline`; `ProgrammeMembership`; Head Coach authority (HC-A confirmed; C3–C6 agreed; H2–H9 proposed); backfill (P3 confirmed) |
| New ADR-019 — Super Admin | authority (C7), bootstrap and S2 (confirmed), safeguards (D4, S3, S4 proposed), staged boundary (BD proposed) |
| Unresolved-decisions table | Q20 → decided (S2); Q5 → deferral proposed (D5); add O1–O6 |
| IMPLEMENTATION_TRACKER.md | PERM-02 → "**Deferred — approved scope change 2026-11-09 (D3)**"; PERM-01/03/04/06/07/08, TCH-01 → Phase 1 acceptance (§11); Phase 1 task rows for §12 |
| BACKEND_IMPLEMENTATION_PLAN.md | Phase 1 section replaced by a summary of this plan; Phase 5 note (teacher registration remains) |
| DATABASE_CHANGE_PLAN.md §3.1 | profile tables marked deferred; M1–M6 (§9) |
| API_CHANGE_PLAN.md §2–3 | profile endpoints deferred; override, membership, teacher-assignment and role endpoints (§10) |
| BACKEND_TEST_PLAN.md §3 | six-role matrix, programme boundaries, override and boundary tests (§11) |
| FRONTEND_INTEGRATION_REQUIREMENTS.md | six roles; Head Coach, Teacher, Super Admin views (§10.2) |
| New `docs/PHASE-1-PLAN.md` | this document (v5), as the reference for Phase 1 PRs |

---

## 4. Roles

| Role | Stored | Existing accounts | Added by |
|---|---|---|---|
| STUDENT | `STUDENT` | unchanged | — |
| TEACHER | `TEACHER` | none | M1 |
| COACH | `MENTOR` (label "Coach") | unchanged | — |
| HEAD_COACH | `HEAD_COACH` | none | M1 |
| ADMIN | `ADMIN` | unchanged until the boundary is switched on | — |
| SUPER_ADMIN | `SUPER_ADMIN` | none until the approved bootstrap | M1 |

**Safety rules:** (1) declaration test — every non-public route declares access; (2) positive role checks; (3) one role allow-list for create, invite, `PATCH /admin/users/:id` and role change, with `TEACHERS_ENABLED` / `HEAD_COACHES_ENABLED` off by default and `SUPER_ADMIN` never assignable through the normal user API; (4) new roles gain access only through permission-checked routes; (5) frontend role tolerance (F1) deployed before any account can hold a new role (i.e. before any flag is switched on or the bootstrap runs); (6) role change ends sessions and is audited.

**Who may assign which role:**

| Target | SUPER_ADMIN | ADMIN | HEAD_COACH |
|---|:-:|:-:|:-:|
| STUDENT | ✓ | ✓ | programme membership of existing students (own programme) |
| TEACHER | ✓ | ✓ (flag on) | ✗ |
| COACH | ✓ | ✓ | invite into own programme → pending ADMIN approval |
| HEAD_COACH | ✓ | ✓ (incl. programmes) | ✗ |
| ADMIN | ✓ | ✓ while boundary off; ✗ when on | ✗ |
| SUPER_ADMIN | ✓ (safeguards §8) | ✗ | ✗ |

Actor must be allowed to manage both the current and the new role; nobody changes their own role, programmes or permissions.

---

## 5. Role–permission matrix (role-based defaults)

● global · ◐ scoped — **O** own · **D** own division · **A** assigned course × division · **P** own programme(s) · — none.

| Permission | STUDENT | TEACHER | COACH | HEAD_COACH | ADMIN | SUPER_ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `courses.view`, `resources.view`, `assignments.view` | ◐ D | ◐ A | ◐ A | ◐ P | ● | ● |
| `courses.complete` | ◐ O | — | — | — | — | — |
| `resources.manage` (incl. today's direct publish) | — | — | ◐ A | — | ● | ● |
| `assignments.prepare` | — | override only | ◐ A | ◐ A only via an **Administrator-created** assignment (H4) | — | — |
| `assignments.publish` | — | — | — | — | ● | ● |
| `submissions.submit`, `submissions.viewOwn` | ◐ O | — | — | — | — | — |
| `submissions.distribute` | — | — | — | — | ● | ● |
| `reviews.grade` | — | — | ◐ A | ◐ A only via an **Administrator-created** assignment **and** the normal distribution (H4) | — | — |
| `results.approve`, `results.publish` | — | — | — | — | ● | ● |
| `discussions.participate`, `discussions.report` | ◐ D | ◐ A | ◐ A | ◐ P | ● | ● |
| `discussions.moderate` | — | — | — | — (deferred, H7) | ● | ● |
| `analytics.course` | — | — | ◐ A | ◐ P | ● | ● |
| `leaderboard.view` | ● | ● | ● | ● | ● | ● |
| `reports.view` *(new)* | — | — | — | ◐ P | ● | ● |
| `reports.export` | — | — | — | — | ● | ● |
| `students.viewScoped` *(new)* — name, school, grade, division; HEAD_COACH also participation and learning activity (courses opened/completed, resources viewed, whether/when work was submitted); **never grades, marks, feedback or contact details** (D7) | — | ◐ A | — | ◐ P | ● | ● |
| `users.manage` (kept for compatibility) | — | — | — | — | ● | ● |
| `users.view` *(new)* | — | — | — | ◐ P | ● | ● |
| `users.manageStudents` *(new)* | — | — | — | ◐ P membership only | ● | ● |
| `users.manageCoaches` *(new)* | — | — | — | ◐ P invite → approval | ● | ● |
| `users.manageTeachers`, `users.manageHeadCoaches` *(new)* | — | — | — | — | ● | ● |
| `users.manageAdmins` *(new)* | — | — | — | — | ● boundary off / — on | ● |
| `programmes.manageHeads` *(new)* | — | — | — | — | ● | ● |
| `programmes.manageMembers` *(new)* | — | — | — | ◐ P | ● | ● |
| `mentorAssignments.manage` — HEAD_COACH: assign **Coaches** (`MENTOR`) who are programme members to course × division in their programme; never themselves or another Head Coach (H3, H4) | — | — | — | ◐ P (Coaches only) | ● | ● |
| `mentorRequests.decide` / account approval | — | — | — | — | ● | ● |
| `coaches.monitor` *(new)* | — | — | — | ◐ P | ● | ● |
| `academicYears.manage`, `enrollments.manage`, `divisions.manage`, `courses.manage` | — | — | — | — | ● | ● |
| `settings.manage` | — | — | — | — | ● | ● |
| `settings.manageSystem` *(new)* | — | — | — | — | — | ● |
| `email.bulkSend`, `audit.view` | — | — | — | — | ● | ● |
| `activity.view` | — | — | — | ◐ P | ● | ● |
| `permissions.view` *(new)* | — | — | — | — | ● read-only | ● |
| `permissions.manageOverrides` *(new)* | — | — | — | — | — | ● |

---

## 6. Existing roles, overrides and their safeguards

### 6.1 Existing roles keep their permissions
| Role | Today | After Phase 1 |
|---|---|---|
| STUDENT (9) | courses.view, courses.complete, resources.view, assignments.view, submissions.submit, submissions.viewOwn, discussions.participate, discussions.report, leaderboard.view | identical |
| COACH / `MENTOR` (10) | courses.view, resources.view, resources.manage, assignments.view, assignments.prepare, reviews.grade, discussions.participate, discussions.report, analytics.course, leaderboard.view | identical; same `MentorAssignment` scope |
| ADMIN (25) | all current administrative permissions incl. `users.manage` | all 25 kept by name + granular names it already effectively holds; ADMIN/SUPER_ADMIN account management removed **only when the boundary is switched on** |

Proven by: unit tests (STUDENT/MENTOR sets equal today's; ADMIN ⊇ today's); generated route equivalence for every handler with a reviewed exception list (boundary routes, only when on); unchanged suites; `/me/permissions` existing fields identical.

### 6.2 Concepts (D3, confirmed)
| Concept | Stored | Changed by | Phase 1 |
|---|---|---|---|
| Role-based default permissions | code | reviewed PR | yes |
| Scope | existing data + `ProgrammeMembership`, `TeacherAssignment` | ADMIN; HEAD_COACH within programme | yes |
| Individual override (GRANT/DENY) | `UserPermissionOverride` | SUPER_ADMIN only | yes |
| Custom permission profile | — | — | deferred |

### 6.3 Approved override list (OV — approved 2026-11-09)
| Target role | GRANT allowed | DENY allowed |
|---|---|---|
| TEACHER | `assignments.prepare`, only for a course × division where the teacher already has an active `TeacherAssignment` | any default permission |
| STUDENT, COACH, HEAD_COACH | none | any default permission |
| ADMIN | none | any default permission |
| SUPER_ADMIN | none | none |

Never grantable: `reviews.grade`, `results.*`, `submissions.distribute`, `users.manageAdmins`, `permissions.*`, `settings.manageSystem`. The list lives in code and changes only by reviewed PR.

### 6.4 Override safeguards (each documented in ADR-004 amendment and tested, §11.3)
| Safeguard | How |
|---|---|
| **Cannot bypass programme scope** | an override carries no scope of its own beyond what the user already holds: a GRANT applies only inside the target user's existing scope (e.g. the teacher's own `TeacherAssignment`); the scope check runs after the permission check and is never skipped |
| **Cannot grant outside approved policy** | create request validated against §6.3 → 400 `OVERRIDE_NOT_ALLOWED`; never-grantable list enforced even if the allow-list were edited |
| **Cannot bypass resource-level authorization** | evaluation order is fixed: authentication → permission (role defaults ± overrides) → scope → resource rules (ownership, assignment state, published/hidden status, 404-not-403 policy). Overrides only affect step 2 |
| **Cannot bypass last-Super-Admin protection** | no override applies to SUPER_ADMIN; overrides never change roles; the protection is a service rule **and** a database trigger, independent of permissions |
| **Stop applying immediately when revoked or expired** | **Expiry is evaluated against `expiresAt` at the moment of every authorization decision** (`expiresAt > now()`), independently of any job and of any cache: cached override entries carry their `expiresAt` and are re-checked on each use, so a cached entry can never outlive its expiry. Revocation sets `revokedAt` and invalidates the user's permission cache in the same request; with one API instance revocation is effective on the next request (any future multi-instance setup bounds revocation staleness by the cache TTL ≤ 60 s; expiry is never stale because it is time-based) |
| **Always audited** | create and revoke write the audit row in the **same database transaction** as the change (both succeed or both fail), with actor, target, permission, effect, scope, reason, expiry, previous/new state. A scheduled job writes an `override.expired` audit row after an override lapses — **for the record only**: the override has already stopped applying at `expiresAt`, whether or not the job has run (workers may be off). Self-overrides and SUPER_ADMIN targets are refused |
| **Reversible** | soft revocation (`revokedAt`, `revokedById`); history kept |

---

## 7. Programme scope

### 7.1 Model
- **Programme = existing `Discipline` row** (Mathematics; same ID). No programme table or programme-management UI (P2).
- **`ProgrammeMembership`** (link table): `id`, `userId` → User (cascade), `disciplineId` → Discipline (restrict), `source` (`BACKFILL` / `MANUAL`), `isActive`, `addedById`, `createdAt`, `endedAt`, `endedById`; **unique (`userId`, `disciplineId`)** — one row per pair, ended/re-activated by update (same pattern as `MentorAssignment`; no partial index). HEAD_COACH members head that programme; set only by ADMIN/SUPER_ADMIN.

### 7.2 Enforcement (single place: `AccessService`)
| Head Coach action | Rule — otherwise **404** |
|---|---|
| View students/coaches | active membership in one of the head coach's programmes; ADMIN, SUPER_ADMIN and other HEAD_COACH accounts never visible |
| Shared coach | only data for the shared programme's courses |
| Assign coach to course × division | course's discipline ∈ programmes; assignee is a **Coach (`MENTOR`)** with an active membership in that programme; **never the Head Coach themselves or another Head Coach** (that is an Administrator action, H4) |
| Student membership | add/end in own programmes; no change to division, grade, school, account status |
| Reports, analytics, activity, coach monitoring | forced programme filter; foreign `courseId` → 404 |
| Invite coach | `isApproved = false` + membership in own programme; ADMIN approves through the existing `PATCH /admin/users/:id/status` (pending list `GET /admin/users?isApproved=false`) |
| Own programmes, role, permissions | not editable |

### 7.3 Backfill (P3, confirmed)
| Step | Detail |
|---|---|
| Precondition | exactly one discipline, code `MATHEMATICS`; otherwise abort, nothing written |
| Students | every `STUDENT` → Mathematics |
| Coaches | every `MENTOR` → disciplines of their `MentorAssignment` courses; none → Mathematics |
| Marking | `source = 'BACKFILL'`, `addedById = NULL`; idempotent |
| Access unchanged | membership is read only by head-coach and teacher scope; student access stays division-based, coach access stays `MentorAssignment`-based (tested) |
| Verification on a Neon copy | the acceptance tests in §11.5 (precondition, reconciliation, access regression, scope isolation, rollback) |
| Rollback | `DELETE FROM "ProgrammeMembership" WHERE "source" = 'BACKFILL';` then drop table if required |
| New users afterwards | while Mathematics is the only discipline, new students and approved coaches get a `MANUAL` Mathematics membership |

### 7.4 One mechanism per purpose
| Purpose | Mechanism | Managed by |
|---|---|---|
| Coach teaching scope ("assign coaches to students", H3) | `MentorAssignment` | ADMIN; HEAD_COACH for Coaches within their programme |
| Head Coach personally teaching/grading (H4) | `MentorAssignment` for the Head Coach, created explicitly by an **Administrator only**; grading work still comes only through the normal distribution | ADMIN only |
| Grading allocation | existing submission distribution | ADMIN |
| Teacher scope | `TeacherAssignment` (never read by distribution or coach notifications) | ADMIN |

---

## 8. SUPER_ADMIN

### 8.1 Authority (C7)
All ADMIN permissions + `users.manageAdmins`, `permissions.manageOverrides`, `settings.manageSystem`; no grading. Environment-level integrations (Render variables) stay outside the application.

**No inheritance of prohibited grading permissions (review safeguard):** the SUPER_ADMIN permission set is defined **explicitly** in the catalogue, not by "everything" or by inheriting another role's set. It must never contain `reviews.grade` or `assignments.prepare` (the grading/authoring rights reserved for assigned coaches), and no override may grant them (§6.3). Enforced by: a catalogue unit test (SUPER_ADMIN ∌ `reviews.grade`, `assignments.prepare`); the generated route test (SUPER_ADMIN refused on every grading and review route); a guard rule that refuses grading routes to ADMIN and SUPER_ADMIN regardless of the permission set (defence in depth, mirroring today's "admins never grade").

### 8.2 Safeguards (D4 approved; S2 confirmed; AS1, AS2 owner-required — 2026-11-09)
| Area | Safeguard |
|---|---|
| Bootstrap | one-off CLI **planned for a future implementation PR** (rollout Step 11, task P1-08) — **not yet written and not run**; refuses if any active SUPER_ADMIN exists; target must be an existing active, activated ADMIN (O1, not selected); requires `--confirm-username`, `--reason`; ends target's sessions; audit `superAdmin.bootstrap`; e-mail to target; no migration or environment back door |
| Testing (S2) | local disposable database (automated tests) → Neon point-in-time branch of production (rehearsal, then deleted) → production only after **separate explicit approval** |
| Deputy (S2) | unassigned; no automatic rights; any promotion separately approved |
| Last account (S4) | service rule + DB trigger → 409 `LAST_SUPER_ADMIN` |
| Promotion / transfer (**AS2**) | SUPER_ADMIN only; step-up password; e-mail to all Super Admins; target sessions end; no self-promotion. **A transfer is one atomic database transaction**: it locks the Super Admin rows, promotes the new holder, demotes the old holder only if at least one other active SUPER_ADMIN remains after the change, and writes the audit rows — if any step fails, nothing changes. The last-Super-Admin trigger (M4) re-checks inside the same transaction, so concurrent demotions, suspensions or deletions can never reach zero active Super Admins. Recommended sequence: promote B (transaction 1) → B signs in → A steps down (transaction 2), each step atomic. |
| Recovery (**AS1**) | Lost password → normal reset. Lost e-mail access or compromise → **break-glass procedure, restricted, documented and audited**: (1) **restricted** — a CLI only (no HTTP endpoint), runnable only with production database access held by the owner, and only with a recorded approval reference; it refuses to run without `--reason` and `--approval-ref`, and can only (a) reset the credentials and end the sessions of an existing SUPER_ADMIN, or (b) promote one named, existing, active ADMIN when no active SUPER_ADMIN exists; (2) **documented** — a runbook in `docs/operations/` (who may run it, prerequisites, exact steps, verification, follow-up such as password rotation); (3) **audited** — the audit row (`superAdmin.breakGlass`, operator note, reason, approval reference, before/after) is written in the same transaction as the change, and every Super Admin is e-mailed. Tested on a disposable database and a Neon copy only. |
| Audit | one append-only `AuditLog` row per state-changing ADMIN/SUPER_ADMIN request (method, route template, target IDs, outcome, request ID; no bodies) + domain audits with previous/new values |

### 8.3 `SUPER_ADMIN_BOUNDARY_ENABLED` — closing the ADMIN-creation gap (BD — approved 2026-11-09)
| State | Behaviour |
|---|---|
| **off** (default) | ADMIN manages ADMIN accounts as today — an ADMIN creation path always exists |
| **on, no active SUPER_ADMIN** | boundary **not enforced** (fail-safe), error logged; ADMIN keeps today's behaviour |
| **on, ≥ 1 active SUPER_ADMIN** | ADMIN cannot manage ADMIN/SUPER_ADMIN accounts; SUPER_ADMIN can |
| Rollback | switch off — no data change |

Activation sequence: all routes converted (F6) → bootstrap rehearsed on non-production → **approval** → production bootstrap → verification (owner signs in as SUPER_ADMIN; `/me/permissions` shows `SUPER_ADMIN` with `users.manageAdmins`; administrator-management screens load read-only; `superAdmin.bootstrap` audit row exists; trigger verified on the rehearsal copy) → **separate approval** → flag on.

---

## 9. Database and migrations

Rules: names from `20261121000000`, strictly increasing and numbered in rollout order (renamed before merge if the order changes); one migration per PR; rollback file `docs/migrations/<name>.rollback.sql`; Neon rehearsal before requesting production approval; no existing table, column, constraint, ID or relationship changed; manual order check per PR (C10); triggers in SQL like the existing audit-log triggers.

| # | Migration | Depends on | Content | Rollback | Limitation |
|---|---|---|---|---|---|
| M1 | `20261121000000_roles_teacher_head_coach_super_admin` | Steps 2–4 deployed; shipped **in Step 5** together with the role allow-list and flags | `ALTER TYPE "Role" ADD VALUE` ×3 | none by SQL; inert while unused; full revert (recreate type) only while unused | **forward-only** |
| M2 | `20261121000100_programme_membership` | Step 4 | table, `MembershipSource`, unique pair, FKs | drop table + enum | none |
| M3 | `20261121000200_backfill_programme_membership` | M2 | data (§7.3) | delete `BACKFILL` rows | aborts unless only Mathematics |
| M4 | `20261121000300_last_super_admin_guard` | M1 | trigger on `User` | drop trigger + function | none |
| M5 | `20261121000400_permission_overrides` | Step 4 | `UserPermissionOverride` (+ `expiresAt`, `revokedAt`, `revokedById`, reason), enums | drop table + enums | overrides lost (audit keeps history) |
| M6 | `20261121000500_teacher_assignment` | M1, M2 | `TeacherAssignment` (unique teacher × course × division) | drop table | data lost if teachers assigned |

Dependencies (each arrow = "must be deployed/applied before"):
- `Steps 2–4 → Step 5 (allow-list + flags + M1)`
- `M1 → M4` (Step 11) · `M1 + M2 → M6` (Step 14)
- `Step 4 → M2 → M3` (Step 10)
- `Step 4 → M5` (Step 12)

Order inside Step 5: migrations are applied manually with approval (`render.yaml`: `prisma migrate deploy` is not run by the service), so the allow-list code and M1 may land in either order without exposure:
- **code first:** the new code knows the values, but the database rejects them until M1, and the allow-list refuses them anyway;
- **M1 first:** the running old code's generated `Role` enum does not contain the new values, so `@IsEnum(Role)` still rejects them.

Either way, no account can hold a new role until a flag is switched on (Steps 13/14) or the approved bootstrap runs (after Step 11, with separate approval).

Not migrations (each separately approved): bootstrap, flag changes, appointments.

---

## 10. API and frontend

### 10.1 Backend API (additive)
| Area | Endpoint(s) | Access |
|---|---|---|
| Me | GET `/me/permissions` → `{ role, roleLabel, permissions[], scopes{ programmes[], courseDivisions[] }, overrides[] }` (existing fields unchanged) | authenticated |
| Users | existing `/admin/users*` incl. PATCH — allow-list on every path; HEAD_COACH sees own-programme members | `users.view` / `users.manage*` |
| Role change | PATCH `/admin/users/:id/role` | §4; step-up for ADMIN/SUPER_ADMIN targets |
| Programmes | GET `/programmes` (read-only, existing disciplines); GET/PUT `/admin/programmes/:id/heads` | authenticated / `programmes.manageHeads` |
| Members | GET/POST/DELETE `/admin/programmes/:id/members[/:userId]` | `programmes.manageMembers` |
| Coach assignments | existing `/admin/mentor-assignments` | `mentorAssignments.manage` |
| Coach invitation | existing invite (`role: MENTOR`, `programmeId`) | `users.manageCoaches` → pending |
| Teacher assignments | GET/POST/DELETE `/admin/teacher-assignments` | `users.manageTeachers` |
| Monitoring | existing dashboard/reports/analytics/activity | programme filter for HEAD_COACH |
| Overrides | GET/POST/DELETE `/admin/users/:id/permission-overrides[/:id]`; GET `/admin/users/:id/permissions`; GET `/admin/permissions/catalogue` | `permissions.manageOverrides` / `permissions.view` |

Error codes: `SCOPE_FORBIDDEN`, `ROLE_NOT_ASSIGNABLE`, `OVERRIDE_NOT_ALLOWED`, `LAST_SUPER_ADMIN`, `STEP_UP_REQUIRED`, `TEACHERS_DISABLED`, `HEAD_COACHES_DISABLED`.

### 10.2 Frontend
F1 six roles + unknown role safe (before any new-role account) · F2 navigation from `/me/permissions` · F3 Head Coach portal (programme students, coaches, assignments, invite → pending, reports) · F4 Super Admin sections (admin management with step-up, overrides, system settings, super-admin audit trail) · F5 Admin: head coaches, members, teachers, pending approvals · F6 Teacher portal · F7 student/coach labels and menus. No programme-creation screens. The API refuses everything not permitted.

---

## 11. Acceptance criteria and tests

### 11.1 Fixtures
Mathematics (existing seed ID) + test-only Physics discipline (test database only); coaches A (Maths), B (Maths + Physics); head coaches HM, HP; teacher T (one Maths course × division); students in each; ADMIN; two SUPER_ADMINs.

### 11.2 Per role
| Role | Must be able to | Must be refused |
|---|---|---|
| STUDENT | everything today | other students' records (404), staff routes (403), other divisions/unpublished (404) |
| TEACHER | assigned content; limited student list; discussions in scope; with override: draft + submit | out of scope (403/404); grades/reviews/contacts; publish/approve; grading; admin routes; drafting without override; distribution and coach notifications |
| COACH | everything today | unchanged refusals |
| HEAD_COACH | own-programme students (view, participation and learning activity, membership), coaches (view, monitor, assign **Coaches** to course × division in the programme, invite → pending), reports/analytics/activity; with an Administrator-created assignment: prepare and grade through the normal distribution | other programme (404); ADMIN/SUPER_ADMIN/other head coaches (404); self-adding programmes; assigning HEAD_COACH/ADMIN (403); **creating a course × division assignment for themselves or another Head Coach (403)**; grading or preparing without an Administrator-created assignment (403); approvals; grading without explicit assignment + distribution; **discussion moderation (403, H7 deferred)**; student grades, marks, feedback or contact details (not returned, D7); export, bulk e-mail, settings, audit |
| ADMIN | all 25 current abilities; head coaches; membership; approvals; teachers | boundary on: ADMIN/SUPER_ADMIN management (403); always: overrides, system settings, grading |
| SUPER_ADMIN | all intended administrative routes; ADMIN/SUPER_ADMIN management with step-up; overrides; system settings | grading; self-promotion/self-override; removing the last SUPER_ADMIN (409; direct SQL → trigger error) |

### 11.3 Override safeguards
| Test | Expected |
|---|---|
| GRANT `assignments.prepare` to a teacher for a course × division outside their `TeacherAssignment` | 400 `OVERRIDE_NOT_ALLOWED` |
| Teacher with a valid GRANT acts on another course/programme | 403/404 (scope still enforced) |
| GRANT of any never-grantable or non-listed permission, or to a non-listed role | 400 `OVERRIDE_NOT_ALLOWED` |
| Overridden teacher reads a hidden/unpublished/other-owner record | 404 (resource rules unchanged) |
| Any override on a SUPER_ADMIN; demoting/suspending the last SUPER_ADMIN while overrides exist | refused / 409 `LAST_SUPER_ADMIN` |
| Revoke → next request | access refused immediately, no re-login |
| Expiry passes with the expiry job **not run** (workers off) and the override cached | access refused on the first request after `expiresAt` (clock-controlled test) |
| Create, revoke, expiry | exactly one audit row each; create/revoke rolled back together with a failing audit write |
| Self-override; ADMIN creating an override | 403 |
| DENY vs role default | denied |

### 11.4 `SUPER_ADMIN_BOUNDARY_ENABLED`
| Test | Expected |
|---|---|
| Boundary **off** | ADMIN can create/edit/suspend ADMIN accounts exactly as today; cannot create SUPER_ADMIN |
| Boundary **on, no active SUPER_ADMIN** | identical to off; error logged; no lockout |
| Boundary **on, active SUPER_ADMIN** | ADMIN refused (403) on create/edit/suspend/promote/demote of ADMIN/SUPER_ADMIN; all other ADMIN routes unchanged |
| SUPER_ADMIN route coverage | generated test over all handlers: SUPER_ADMIN passes every route ADMIN passes, plus the SUPER_ADMIN-only routes; refused on grading routes |
| SUPER_ADMIN no grading inheritance | catalogue test: SUPER_ADMIN ∌ `reviews.grade`, `assignments.prepare`; every review/mark/grading route → 403 for SUPER_ADMIN; override granting either to a SUPER_ADMIN → refused |
| ADMIN restrictions | ADMIN never: overrides, `settings.manageSystem`, SUPER_ADMIN assignment (any boundary state) |
| Rollback | switching the flag off restores ADMIN behaviour on the next request; no data changed |

### 11.4a Super Admin transfer and recovery (AS1, AS2)
| Test | Expected |
|---|---|
| Transfer with a failure injected after the promotion step | whole transaction rolled back: roles, sessions and audit unchanged |
| Concurrent demotion/suspension of the last two Super Admins | at most one succeeds; at least one active SUPER_ADMIN remains (API and direct SQL) |
| Old holder steps down while no other active SUPER_ADMIN exists | 409 `LAST_SUPER_ADMIN`; nothing changes |
| Break-glass without `--reason` or `--approval-ref`, or against a non-ADMIN target, or (b) while an active SUPER_ADMIN exists | refused; nothing changes |
| Break-glass success | exactly one `superAdmin.breakGlass` audit row in the same transaction; target sessions ended; all Super Admins e-mailed |

### 11.5 Programme backfill (M2 + M3) — acceptance tests
Run on the disposable test database (automated) **and** on a Neon point-in-time copy of production (rehearsal report) before any production approval is requested.

| Category | Test | Pass condition |
|---|---|---|
| **Precondition** | two disciplines present / discipline code not `MATHEMATICS` | migration aborts with its explicit error; zero rows written; transaction rolled back |
| **Reconciliation** | count `BACKFILL` rows by role | = number of `STUDENT` users + sum over `MENTOR` users of distinct disciplines of their assignments (or 1 if none) |
| | every `STUDENT` | exactly one active membership, in Mathematics |
| | every `MENTOR` | memberships = set of disciplines of their `MentorAssignment` courses (Mathematics if none) |
| | `ADMIN` users | no membership |
| | integrity | no orphaned `userId`/`disciplineId`; unique pairs hold; all rows `source = 'BACKFILL'`, `addedById IS NULL` |
| | idempotency | running M3 twice changes nothing (same counts and IDs) |
| **Access regression** | route equivalence for every existing STUDENT and MENTOR fixture user, before vs after M2 + M3 | identical decisions and response bodies on every route (memberships are not read by student or coach access paths) |
| | code guard | unit test: student and coach access helpers do not query `ProgrammeMembership` |
| | existing data | row counts and id fingerprints of every pre-existing table unchanged (drill-verify script) |
| **Scope isolation** | HEAD_COACH (Maths) with test-only Physics data | sees only Maths members; Physics students/coaches/courses/reports → 404; shared coach shows Maths data only |
| | ADMIN/SUPER_ADMIN/other HEAD_COACH | never returned to a HEAD_COACH |
| | TEACHER | membership alone gives no content access (requires `TeacherAssignment`) |
| **Rollback** | apply M2 + M3 → run `M3` rollback (`DELETE … WHERE source = 'BACKFILL'`) | zero `BACKFILL` rows; `MANUAL` rows (if any) untouched; existing tables' fingerprints unchanged |
| | then M2 rollback (drop table, enum) | schema equals pre-M2 (`prisma migrate diff` against the previous schema: no difference) |
| | re-apply M2 + M3 after rollback | same reconciliation results as the first run |

### 11.6 Cross-cutting
Declaration test (0 undeclared routes); route equivalence STUDENT/COACH/ADMIN (only reviewed boundary exceptions); matrix e2e (route × anonymous + six roles + overridden teacher); backfill precondition abort, idempotency and access-unchanged tests; audit rows without body data; regression at every PR (518 unit, 289 e2e + 6 S3 in CI, 202/202 routes, 70 script tests; login/refresh/logout; `/me/permissions` existing fields).

**Phase 1 done when:** all of §11 green in CI; combined M1–M6 rehearsal report; bootstrap rehearsed on non-production; `AUTHORIZATION.md` regenerated for six roles; ChatGPT review; Theoneste's approval before any production migration, bootstrap or flag change.

---

## 12. Rollout order and step sequence (every PR targets `develop`)

**Step numbers are the plan's own sequence, not GitHub pull-request numbers.** Each step is delivered as one (or, for Step 6–9, several) GitHub pull request, numbered by GitHub when opened. Step 1 was delivered as GitHub PR #10; the owner sign-off was recorded by GitHub PR #11.

| Stage | Step | Content | Production effect | Approval |
|---|---|---|---|---|
| 0 | 1 | **Documentation only** (§16) | none | merge |
| 1 | 2 | `@Authenticated()` on 54 routes + declaration test | none | merge |
| 1 | 3 | positive role helpers | none | merge |
| 1 | 4 | six-role catalogue, `PermissionService`, guard, equivalence framework, extended `/me/permissions` | additive fields | merge |
| 2 | 5 | role allow-list on all paths, flags off; **M1** | enum values, unusable | migration |
| 2 | F1 | frontend role tolerance | none visible | Netlify deploy |
| 3 | 6–9 | route conversion batches | none (equivalence) | per batch |
| 4 | 10 | **M2 + M3**, scope helpers, heads/members API | membership rows only | rehearsal report + migration |
| 5 | 11 | Super Admin: authority, step-up, role rules, **M4** trigger, bootstrap CLI (not run), runbook, audit interceptor, boundary flag (off) | none until approved steps | migration; separate bootstrap; separate flag |
| 6 | 12 | **M5** overrides, approved list, safeguards | none until used | migration |
| 7 | 13 | Head Coach (`HEAD_COACHES_ENABLED` off until F3) | none until flag | flag |
| 8 | 14 | Teacher: **M6**, assignments, scoped view, override path (`TEACHERS_ENABLED` off until F6) | none until flag | migration + flag |
| 8 | F2–F7 | frontend features | UI | per deploy |
| 9 | 15 | phase exit | — | sign-off |

Releases to production follow the existing practice: PR `develop → main`, Render deploys `main`.

---

## 13. Consistency check
| Source | Result |
|---|---|
| ADR-001, 005–014 | consistent (coach invitations use the existing account approval, not `MentorRequest`) |
| ADR-002, 003, 004 | amended in PR 1; statuses finalised by the owner sign-off of 2026-11-09 (all approved; H7 changed) |
| ADR-007 | memberships reference discipline IDs that ADR-007 keeps |
| ADR-011 | coach direct publishing preserved |
| ADR-015 | rules 1, 3, 4, 7, 8 followed; rule 5 met by P0-04 Part A for additive migrations; rule 6 n/a; rule 2 exception recorded (C10) |
| ADR-017 | corrected to `develop` (repository evidence) |
| API contracts | additive; `role` value set grows (frontend first); `PATCH /admin/users/:id` only refuses role changes not allowed by §4 |
| DB constraints | existing untouched; new uniques mirror `MentorAssignment`; enum additive; triggers like existing ones |

## 14. Unchanged
Existing IDs, records, routes, response fields, authentication and sessions; STUDENT and COACH behaviour; ADMIN behaviour until the boundary flag is approved; Phase 0 paused.

## 15. Out of scope
Category D items · any production action without approval · selecting the bootstrap account or deputy · unfinished Phase 0 tasks.

---

## 16. PR 1 — documentation-only scope

*Historical: PR 1 was merged as #10 (merge commit `0be9fe9`). The statuses it recorded were finalised by the owner sign-off of 2026-11-09 (§2), recorded by a second documentation-only PR.*

| Item | Detail |
|---|---|
| Branch / target | `docs/phase-1-decisions` from `develop` → PR into `develop` |
| Files | `ARCHITECTURE_DECISIONS.md` (ADR-002, -003, -004 amendment, -015 exception, -017 correction, new ADR-018, ADR-019, decision register with categories A–E, unresolved table); `IMPLEMENTATION_TRACKER.md` (PERM-02 deferred, Phase 1 rows and acceptance); `BACKEND_IMPLEMENTATION_PLAN.md`, `DATABASE_CHANGE_PLAN.md`, `API_CHANGE_PLAN.md`, `BACKEND_TEST_PLAN.md`, `FRONTEND_INTEGRATION_REQUIREMENTS.md` (Phase 1 sections); new `docs/PHASE-1-PLAN.md` (this plan) |
| Statuses | recorded exactly as §2: A confirmed, B agreed, C **proposed**, D deferred, E open |
| Not included | any `.ts`, `.prisma`, migration, script, CI, package or environment file; no data; no bootstrap |
| Checks | `git diff --name-only` shows only the listed `.md` files; docs-generation check unchanged; full CI green; secret scan clean |
| Review | ChatGPT review → Theoneste approval → merge; no deploy needed (documentation) |
