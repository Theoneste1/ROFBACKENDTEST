# ROF LMS completion — progress record

Owner instruction (2026-11-17): complete, integrate and test ALL approved requirements before any PR is merged;
design-dependent areas go to the owner as proposals; production untouched. This file is the running record so
work can continue across sessions without losing anything. Newest entries first in each section.

## Branches (none merged; do not merge without owner approval)

| Repo | Branch | Base | Contents | Head |
|---|---|---|---|---|
| backend | `fix/role-notification-settings` | develop | Head Coach / Super Admin notification switches; new-discussion recipients | `a4016d3` |
| backend | `feat/applications-complete` | fix/role-notification-settings | REG-05/06/10 (fields, rejection reasons, request more information); student DOB required; release kit 10 migrations | `cf964dc` |
| backend | `docs/post-phase1-release-plan` | develop | release plan, requirements matrix, final scope, design proposals, this record | latest |
| frontend | `chore/sync-main-into-develop` | develop | main→develop sync (tree = develop) | `6af113b` |
| frontend | `feat/admin-form-availability` | develop | Forms page | `61c32c7` |
| frontend | `feat/admin-bulk-user-operations` | develop | bulk operations UI, CSV export | `40cfc8e` |
| frontend | `feat/account-history-head-coach-settings` | develop | account history card; Head Coach notification switches | `1dbdf89` |
| frontend | `feat/applications-complete` | develop | REG-05/06/10 UI, answer page | `97db7d0` |
| backend (local) | `feat/applications-complete` | fix/role-notification-settings | + REG-02 4b7450f dd58aae, REG-13 117be91, AUD-02 c7b1a41 | `c7b1a41` |
| backend (local) | `feat/teacher-student-access` | feat/applications-complete | Teacher–student access TS-1…TS-6 (migration 20261210000000) | latest |
| frontend (local) | `feat/admin-user-details` | develop | ACC-02 a43563f, REG-13 card 4bad525 | `4bad525` |
| frontend (local) | `feat/teacher-student-access` | develop | School Access page, delegation scopes, My Students | `c7adf43` |
| frontend (local) | `test/e2e-playwright` | develop | + teacher–student browser spec 0787304 | `0787304` |
| frontend (local only) | `integ/frontend-rc` in `C:\rof-audit\fe-hist` | develop | all five merged; 382/382 tests, build OK | local |

**Merge order (proposed):** backend `fix/role-notification-settings` → `feat/applications-complete` → (later
backend branches stacked on it) → `docs/…`; frontend: any order (verified conflict-free), applications last.

## Local test infrastructure

- PostgreSQL 18.6 (npm `@embedded-postgres/windows-x64`, binaries in `C:\rof-audit\epg`), data `C:\rof-audit\pgdata`,
  `127.0.0.1:55432`, trust auth, synthetic data only. Start: `pg_ctl -D C:\rof-audit\pgdata -o "-p 55432 -c
  listen_addresses=127.0.0.1 -c max_connections=300" -l C:\rof-audit\pgdata.log start`.
- Backend e2e: `TEST_DATABASE_URL=postgresql://rof@127.0.0.1:55432/<db>?schema=public&application_name=e2e`,
  `JWT_SECRET=ci-only-secret-that-is-long-enough-0123456789`, unset `DATABASE_URL`; migrate the db first.
- Docs generation needs CI env: `DATABASE_URL=postgresql://rof:rof@localhost:5432/rof_ci?schema=public` + JWT_SECRET.
- Worktrees: backend `C:\rof-audit\be-apps` (applications), `be-notify`, `be-docs`; frontend `fe-apps`, `fe-hist`
  (integration, real node_modules), `fe-forms`, `fe-bulk`, `fe-sync`. Release checkout `C:\rof-release-e15813e`.

## Done (with evidence)

- 2026-11-17 W1 applications: backend e2e full suite 951 passed / 6 skipped (S3) on PostgreSQL 18; unit 1140/1140;
  10-migration deploy → rollback → re-deploy clean; frontend integration 382/382, typecheck, lint, Netlify build.
- 2026-11-17 Student DOB required at self-registration (backend `cf964dc`).
- 2026-11-17 INT-07 Teachers tab on the school page (frontend `feat/school-teachers` 7c0d878; backend e2e case 4816f0e).
- 2026-11-17 ACC-16 phones masked in user lists; e2e sweep of contact data access (backend b8f0267).
- 2026-11-17 DEFECT FIXED: bulk operation could stay RUNNING forever (finishIfDone tx expired under a concurrent worker; 4/10 → 0/10 after the fix; finishStale sweep) — backend b8f0267.
- 2026-11-17 Owner request: sidebar "More" menu in every portal (frontend `feat/sidebar-more-menu` 2c36727, 33b3a5a, 4c8a511); browser-verified (see W0).
- 2026-11-17 W0 started: frontend `test/e2e-playwright` 212dc96 (Playwright 1.59.1, real backend + PostgreSQL, local-only DB guard); sidebar specs desktop + phone: 8 passed on the integrated stack.

- 2026-11-18 ACC-02 IMPLEMENTED + unit-tested: user page shows DOB (age), phone, close-family phone, home country / place
  (frontend `feat/admin-user-details` a43563f, local). Browser test pending (W0).
- 2026-11-18 REG-02 IMPLEMENTED + TESTED: optional picture at registration for students / teachers / coaches via a one-time
  30-min token (PUT /auth/register/avatar); carried to the account on approval; orphan cleanup keeps application pictures.
  Backend `feat/applications-complete` 4b7450f (e2e 6 cases, unit token 3; DEFECT FIXED: import cycle crashed the built
  server). Frontend `feat/applications-complete` f6723e4 (unit 4). Capability `registrationAvatar` added (dd58aae).
- 2026-11-18 REG-13 TESTED: registration timeline GET /admin/users/:id/registration-timeline (users.manage): stages + events
  oldest first from AuditLog / application / claims, safe details only (backend `feat/applications-complete` 117be91: e2e 3,
  unit 1146/1146, routes 305/305, snapshot 1 additive). Frontend "Registration history" card (`feat/admin-user-details` 4bad525,
  unit 3, 360/360). Browser test pending (W0).
- 2026-11-18 AUD-02 TESTED: previous / new values on the remaining audited changes (inventory: 6 field edits recorded field names
  only; assignment, course and review status steps had no from / to). Shared helper src/audit/audit-changes.ts; assignment
  transitions now write their audit row in the transition transaction with the locked status (refused step writes nothing).
  Backend `feat/applications-complete` c7b1a41: e2e 4 + unit 4; full e2e 970 passed / 6 skipped; unit 1150/1150.
- 2026-11-18 S3 tests (6 skipped): BLOCKED locally — they need an S3 API; CI starts Adobe S3Mock in Docker and runs them
  (S3_TEST_ENDPOINT). This machine has neither Docker nor Java; installing either was not done without approval. They run
  in CI when the backend PRs are opened. Not weakened, not removed.
- 2026-11-18 Teacher–student access (TS-1…TS-6) TESTED (see the section below).
- 2026-11-18 Playwright role journeys VERIFIED (`test/e2e-playwright` e5390a4): every role lands on its portal, its pages load,
  another portal is refused; Student profile DOB; Admin user page DOB / close-family phone (ACC-02) and Registration history
  (REG-13); Super Admin permission overrides card — 7 passed. Teacher–student browser flow 4 passed; sidebar 8 passed.
- 2026-11-18 Permission sweep VERIFIED: `src/auth/role-route-sweep.spec.ts` (backend `feat/teacher-student-access`) — real guard
  chain × 7 callers × 315 registered routes; invariants hold; reviewed lists: 15 Head Coach /admin routes (programme-scoped),
  2 teacher routes Head Coaches pass the guard for (service refuses). Matrix: `docs/ROLE-ROUTE-MATRIX.md` (cd8f9e9).
- 2026-11-18 Requirements matrix v2 (`docs/REQUIREMENTS-MATRIX-V2.md`, dd8a606): 102 requirements — 45 complete and verified,
  10 implemented not fully tested, 15 partial, 0 missing, 29 awaiting design approval, 1 deferred, 2 blocked (external).
- 2026-11-18 REVIEW STAGE: FINAL-REVIEW-PACKAGE.md — PR links (none open yet; no GitHub CI yet), local CI replica passes on
  every branch head, production read-only inspection, local rehearsal of the eleven migrations on a restored production
  backup (deploy → rollback → re-deploy), independent security review: M1–M3 + L2 fixed (backend b5a9369, e2e 982/6/0),
  L5 fixed (frontend b115384), SR-1 / SR-2 to the owner; frontend merge conflict removed (6166186); DECISIONS-FOR-REVIEW.md.
- 2026-11-18 Frontend bulk page: teacher–student bulk actions (`feat/admin-bulk-user-operations` d548de3; unit 366/366).

## Outstanding — approved, to implement (in this order)

1. [x] INT-07 Teachers on the school page (backend list by school if missing + frontend tab; contact data restricted).
2. [x] ACC-16 / SEC-03 guardian / student phone masking for readers without users.manageStudents in scope.
3. [x] REG-13 registration timeline on the user page (application, decision, activation, state changes, claims).
4. [x] REG-02 profile picture during registration — AGREED: OPTIONAL, never mandatory (all roles); registration and activation
   must work without it; valid upload accepted; invalid files rejected; manage later in profile.
5. [x] AUD-02 before / after values on the remaining audited actions (inventory first).
6. [~] W0 Playwright (infrastructure + sidebar done). NEXT: specs per role — student registration (DOB required) + profile;
   teacher application → request info → answer page → approve → activation → teacher portal; coach application → reject with
   reason; head coach programme / invitation / notification settings; admin forms, bulk preview, account history, school
   teachers tab; super admin permissions boundary. E-mails: read the EmailDelivery rows from the test DB (dry-run mail). browser e2e, seven roles, frontend + backend + PostgreSQL (no mocked API for main flows).
7. [!] S3 tests (BLOCKED locally — runs in CI): assess the 6 skipped (need S3-compatible server); run with a local S3 server if possible, else document.
8. [x] ACC-02 administrator user page: show the student's date of birth, phones, home place (backend returns them to users.manage).
9. [x] Full role/route permission and security sweep; API-without-UI and UI-without-API inventory refreshed.
10. [x] Authoritative requirements matrix v2 (REQUIREMENTS-MATRIX-V2.md); design proposals v2 (DESIGN-PROPOSALS-V2.md, 10 areas × 11 sections, 37 owner decisions) (all columns the owner listed), design proposals v2 (11 sections each).

## Notes for the next session

- Local browser stack: backend `node dist/main.js` in be-apps (PORT 4100, NODE_ENV=development, DATABASE_URL rof_play,
  TEACHERS/HEAD_COACHES_ENABLED=true); frontend fe-hist `next start -p 3100` built with API_PROXY_TARGET=http://127.0.0.1:4100;
  `E2E_DATABASE_URL=postgresql://rof@127.0.0.1:55432/rof_play E2E_ADMIN_PASSWORD=E2e-Admin-2026! npx playwright test` in fe-e2e.
- The backend allows 10 sign-ins per minute per address (not weakened): one sign-in per role per test file; leave a minute between full runs.

## New feature (owner request 2026-11-17, Part B) — Teacher–student association, delegated submission, bulk access

- Plan `docs/TEACHER-STUDENT-ACCESS-PLAN.md` (a9eaabd).
- APPROVED 2026-11-18 (owner): TS-1 automatic visibility only for Administrator-VERIFIED claims; teachers see only a COUNT of
  students awaiting verification (no identities). TS-2 several teachers per student (independent records, no duplicate
  active assignment, history kept). TS-3 cross-school only by explicit Administrator action with reason, audited, no
  school-wide side effect. TS-4 three scopes (whole school / assigned only / selected students; selected rows keep
  history). TS-5 ending an assignment makes dependent selected-student delegations inactive and flagged for review; no
  deletion. TS-6 notify teachers on assignment (dedupe on retry), never students.
- Status: TESTED (2026-11-18), local commits, not pushed, not merged.
  - Backend `feat/teacher-student-access`: migration 20261210000000 (TeacherStudentAssignment, UserPermissionOverrideStudent,
    studentScope / reviewNeededAt / reviewReason; existing delegations → SCHOOL; CHECKs: no self-assignment, cross-school
    needs a reason, scope only on delegations — NULL there = SCHOOL so a previous release writing during the deploy works);
    rollback refuses while data exists and, in discard mode, REVOKES narrowed delegations (never widens them) — drill run
    locally: refused, 4/4 narrowed revoked, dropped, re-deployed, no drift. Scope rules src/teachers/teacher-scope.ts; admin
    API /admin/teacher-students (list, assign ≤200, reassign, end), /admin/schools/:id/access (+ /students),
    delegation students add / remove / reviewed; teacher GET /teacher/students/summary, `access` / `can` per student;
    bulk actions assignTeacher / unassignTeacher / grantDelegation / revokeDelegation; notice teacher.students.assigned
    (once per request / bulk operation; never students); audit TEACHER_STUDENT_ASSIGNED / _UNASSIGNED,
    DELEGATION_STUDENT_ADDED / _REMOVED, DELEGATION_REVIEWED; role change ends assignments; capability teacherStudentAccess;
    release kit now 11 migrations. Tests: e2e test/teacher-student-access.e2e-spec.ts 11, unit 5; frozen lists updated
    deliberately (routes 315, snapshot 22 additive). Regressions found and fixed: the teacher list exact-fields test
    (access / can added, still exact), the route summary wording, and the scope CHECK (relaxed as above).
  - Frontend `feat/teacher-student-access`: School Access page, teacher card scopes / selected students / review / assigned
    students, My Students badges / abilities / pending count. Unit 6; integration 406/406, typecheck, lint, Next build.
  - Browser: `test/e2e-playwright` 0787304 — 4 passed on the integrated stack.
  - Not yet: the four bulk actions in the frontend bulk page (that page is on `feat/admin-bulk-user-operations`; add there
    during integration); Playwright scenarios beyond the core flow.

## Owner decisions recorded

- 2026-11-17 Sidebar "More" menu APPROVED as implemented (`feat/sidebar-more-menu` 2c36727, 33b3a5a, 4c8a511): desktop opens a
  panel beside the sidebar (must NOT expand inside the desktop sidebar — it would bring back sidebar scrolling); tablets and
  phones expand inline. No further changes. Keep the branch and commits intact; include it in the final integration,
  regression testing and release; never merge or deploy it on its own.

## Awaiting owner decision (do not implement)

- D1–D8 in `docs/DESIGN-PROPOSALS.md`; ADR-008 states; DOB for administrator-created / invited / imported students.
- Fresh Neon branch for the rehearsal and restore drill; staging resources (ADR-016).

## Excluded / deferred by the owner (not missing)

Custom permission profiles; organisational role; Head Coach moderation (H7); MFA; coach–student supervision links;
private 1:1 messaging (release 1); teacher course access (2026-11-14); passport / national ID on coach applications
(owner decision recorded in the coach DTO: "No passport or national ID").
