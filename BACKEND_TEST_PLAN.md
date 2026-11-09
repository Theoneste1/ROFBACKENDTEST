# Backend test plan — ROF LMS

**Updated:** 2026-11-08 · **Design status:** APPROVED DESIGN DIRECTION, subject to the final implementation review ([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)) · **Nothing implemented**
Baseline (commit `f624d25`): 482 unit tests (37 files), 289 e2e tests + 3 skipped (21 files, real PostgreSQL),
202/202 routes called by e2e, lint/type-check/build/API-docs checks, CI (test job + docker-compose smoke) green on `main`.

## 1. Rules

- Every step in [BACKEND_IMPLEMENTATION_PLAN.md](BACKEND_IMPLEMENTATION_PLAN.md) ships with tests; the baseline must stay green.
- Route coverage stays at 100 % (`npm run test:routes`); every new route gets success, validation, 401 and 403 cases.
- Tests never contact real external services (e-mail runs dry or against the fake Resend API; S3 against S3Mock).
- "Verified" means a test ran and passed; record the evidence level (unit, e2e, cross-app, production).

## 2. Test levels

| Level | Tool | Used for |
|---|---|---|
| Unit | Vitest, mocks | services, transition tables, permission resolution, validators, backfill functions |
| API e2e | Vitest + supertest, disposable PostgreSQL | every endpoint, permissions, data integrity |
| Migration | Prisma migrate on empty DB + on a production copy (Neon branch) | ordering, backfills, rollback scripts |
| Cross-app | journey scripts through the frontend proxy (existing 39 + 26 journeys) | integration contracts |
| Production smoke | read-only checks + owner-run checklist | after each deploy |

## 3. Cross-cutting suites to add

### 3.1 Permission matrix (generated)
For every route × every system profile (student, teacher, coach, super admin, and each example profile created in
tests: user admin, academic admin, content admin, communication admin, support admin, subject coordinator):
expected allow/deny from the catalogue. Generated from route metadata so new routes are covered automatically.
Also: equivalence test — for system profiles, the permission guard and the legacy `@Roles` give identical results on all routes.

### 3.2 Scope tests
For each scope type: an actor scoped to A cannot read or change B (country, school, subject, course, division, group, assigned support requests).

### 3.3 Escalation tests
An admin cannot grant a permission or scope they do not hold; cannot edit system profiles without Super
Administrator; cannot change their own permissions; every grant/revoke is audited with before/after.

### 3.4 Teacher default rights (ADR-003)
A teacher with scope on school A / subject X / course C: can read C's content and students within scope; can create
resources and **submit** them but cannot publish or approve (403); cannot create assignments **unless** granted
`assignment_author`, and then only submit for approval; cannot grade (403 on `PATCH /submissions/:id/mark`), cannot
use any `/admin/users*` or global admin route; sees nothing outside scope (school B, subject Y, course D).

### 3.4a Phase 1 update (2026-11-09) — six user types, programme scope, overrides, Super Admin
Custom profiles are deferred (D3), so §3.1's "example profiles" and §3.3's "system profile editing" apply to the later phase. The authoritative Phase 1 test list is [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §11. It covers:
- **Route declaration:** every non-public route declares `@Roles`, `@RequirePermission` or `@Authenticated`.
- **Equivalence:** for STUDENT, COACH (`MENTOR`) and ADMIN, the permission decision equals the old `@Roles` decision on every route; the only exceptions are reviewed boundary routes, and only while the boundary is on.
- **Matrix e2e:** every route × {anonymous, STUDENT, TEACHER, TEACHER with override, COACH, HEAD_COACH, ADMIN, SUPER_ADMIN}.
- **Programme boundaries:** Mathematics plus a test-only Physics discipline, with a coach shared between them. A Head Coach gets 404 on everything outside their programme, cannot see ADMIN, SUPER_ADMIN or other Head Coach accounts, and cannot add programmes to themselves.
- **Override safeguards:**
  - no scope widening;
  - nothing granted outside the approved list (`OVERRIDE_NOT_ALLOWED`);
  - record-level rules still apply;
  - no override on a SUPER_ADMIN;
  - revocation effective on the next request;
  - **expiry effective at `expiresAt` even with the expiry job not run**;
  - exactly one audit row per change, written in the same transaction.
- **Super Admin:** **never holds or inherits `reviews.grade` / `assignments.prepare`**, refused on every grading route; the last Super Admin is protected, both through the API and through the database trigger; step-up confirmation; one audit row per state-changing request, without bodies.
- **`SUPER_ADMIN_BOUNDARY_ENABLED`:** off; on with no active Super Admin (fail-safe, today's behaviour); on with an active Super Admin (ADMIN refused on ADMIN/SUPER_ADMIN management); Super Admin passes every intended administrative route; rollback by switching it off.
- **Programme backfill (M2 + M3):**
  - precondition abort;
  - reconciliation (counts and per-user memberships);
  - access regression (student/coach decisions and responses unchanged; access paths do not read memberships; existing tables' fingerprints unchanged);
  - scope isolation;
  - rollback and re-apply.

  Run on the test database and on a Neon copy of production.
- **Owner sign-off additions (2026-11-09):** Head Coach assigns Coaches (programme members) to course × division in their programme, but creating an assignment for themselves or another Head Coach is refused (403), and a Head Coach prepares or grades only with an Administrator-created assignment and the normal distribution (H3, H4); Head Coach discussion moderation refused (H7 deferred); Head Coach student views return participation and learning activity only, never grades, marks, feedback or contact details (D7 clarification); Super Admin transfer is atomic and never leaves zero Super Admins, including under concurrent changes (AS2); emergency recovery refuses without reason and approval reference and writes its audit row in the same transaction (AS1) — plan §11.4a.
- **Teacher (§3.4 as amended):** course × division scope only (school scope deferred); no resource submission until Phase 7; assignment preparation only with a Super-Admin override; never part of grading distribution.

### 3.5 Course access safety (ADR-006)
- Migration: every course existing before Phase 6 is `DIVISION_OPEN`; students' visible courses are identical before and after (snapshot comparison).
- `POST /admin/courses` creates `ENROLLMENT_REQUIRED` by default; an unenrolled student cannot list, open, or download from it (courses, resources, assignments, files).
- Widening access without `confirm: true` → 409 `CONFIRMATION_REQUIRED` with the affected-student count; nothing changes.
- Only `courses.manageAccess` (in scope) can change access; every change audited.

### 3.6 Communication safeguarding (ADR-013)
- No private one-to-one messaging route exists (route-list assertion).
- Students cannot post announcements; moderators can hide/restore; reports reach moderators; mentions notify only group members.

### 3.7 Migration suite (§6)
Runs in CI on an empty database and, before production, on a Neon branch of production.

## 4. Required scenarios (requirements §20)

| # | Scenario | Test |
|---|---|---|
| 1 | A student cannot access another student's restricted records | e2e: submissions, results, support requests, profile sensitive fields → 403/404 |
| 2 | A coach cannot access an unassigned course | e2e: resources, assignments, submissions, analytics of an unassigned course → 403 (exists today in `access`; extend to subject scopes) |
| 3 | A group administrator cannot manage unrelated groups | e2e: members/roles/threads/e-mail of another group → 403 `SCOPE_FORBIDDEN` |
| 4 | A user cannot approve content without permission | e2e: revision approve / assignment publish without `resources.approve`/`assignments.publish` → 403 |
| 5 | A pending revision does not replace the published version | e2e: publish v1, submit v2, student reads v1 until approval, then v2 |
| 6 | A student tracks a support request but cannot see internal notes | e2e: INTERNAL messages absent from student responses, list counts, notifications and e-mails |
| 7 | A new subject can be created without a source-code change | e2e: create subject → topic → course → resource → student sees it |
| 8 | Existing Mathematics data remains available after migration | migration test on fixture DB with Math courses/assignments/submissions/results + production rehearsal queries |

## 5. Tests per workstream

| Phase | Unit | E2E |
|---|---|---|
| 1 Permissions | resolution (profiles + overrides + scopes), cache invalidation, DENY wins | matrix, scopes, escalation, `/me/permissions` shape (old fields kept) |
| 2 Countries, grades, schools | grade mapping, school name normalisation | inactive country hidden; schools per country; duplicate school refused; import dry run |
| 3 Subjects/topics | status transitions | CRUD, reorder, archive hides from students, availability rules, `/disciplines` alias unchanged |
| 4 Account lifecycle | transition table, backfill function | every allowed/forbidden transition; login per state; archive/restore; purge rules; bulk per-row results; export column filtering |
| 5 Registration by type | validators per country, guardian rules | teacher default rights (§3.4); teacher/coach/student flows, closed registration, review queue, reject reason e-mailed, request-info loop, masking of sensitive fields |
| 6 Course access | policy evaluation | §3.5 in full |
| 7 Publishing/versioning | revision state machine | scenario 5; history; approval queue; coach publish blocked when approval required |
| 8 Student support | reference numbers, transitions | public contact form unchanged (regression); scenario 6; assignment scope; attachments (type/size, private download); meetings never auto-confirmed; notifications |
| 9 Groups, targeted e-mail | posting policy | §3.6; scenario 3; announcements moderators-only; mentions notify; membership history; e-mail preview required before send |
| 10 Notifications, audit, privacy | dedupe key | no duplicate notification on retried events; audit diffs without secrets/guardian data |

## 6. Migration tests

1. **Order check (CI, ADR-015 — Phase 0):** new migration names start at `20261121000000` and sort strictly after the newest on `main`.
2. **Empty database:** `prisma migrate deploy` from zero + drift check (exists in CI).
3. **Fixture upgrade:** load a fixture at the previous schema (Math discipline, 4 courses, assignments, submissions, reviews, results, resources, users in every state), apply new migrations, run the verification queries in [DATABASE_CHANGE_PLAN.md](DATABASE_CHANGE_PLAN.md) §6.
4. **Rollback script:** apply migration, run `rollback.sql`, re-apply — on a disposable database.
5. **Production rehearsal:** Neon branch of production → migrate → verification queries → e2e smoke → discard.

## 7. Regression

- Full unit + e2e suites on every pull request (CI).
- Cross-app journeys (39 general + 26 assessment) rerun after each phase; extended with new journeys (registration by type, support request, group announcement, revision approval).
- OpenAPI diff reviewed: additive changes only, except those listed in [API_CHANGE_PLAN.md](API_CHANGE_PLAN.md) §4.

## 8. Not testable automatically (owner checklist)

Real e-mail delivery to an inbox, R2 uploads in production, mobile layouts, and accessibility in real browsers —
covered by the post-deploy checklist in `docs/FINALIZATION-REPORT.md` and its frontend counterpart.
