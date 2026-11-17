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

## Outstanding — approved, to implement (in this order)

1. [x] INT-07 Teachers on the school page (backend list by school if missing + frontend tab; contact data restricted).
2. [x] ACC-16 / SEC-03 guardian / student phone masking for readers without users.manageStudents in scope.
3. [ ] REG-13 registration timeline on the user page (application, decision, activation, state changes, claims).
4. [ ] REG-02 profile picture during registration — AGREED: OPTIONAL, never mandatory (all roles); registration and activation
   must work without it; valid upload accepted; invalid files rejected; manage later in profile.
5. [ ] AUD-02 before / after values on the remaining audited actions (inventory first).
6. [~] W0 Playwright (infrastructure + sidebar done). NEXT: specs per role — student registration (DOB required) + profile;
   teacher application → request info → answer page → approve → activation → teacher portal; coach application → reject with
   reason; head coach programme / invitation / notification settings; admin forms, bulk preview, account history, school
   teachers tab; super admin permissions boundary. E-mails: read the EmailDelivery rows from the test DB (dry-run mail). browser e2e, seven roles, frontend + backend + PostgreSQL (no mocked API for main flows).
7. [ ] S3 tests: assess the 6 skipped (need S3-compatible server); run with a local S3 server if possible, else document.
8. [ ] ACC-02 administrator user page: show the student's date of birth, phones, home place (backend returns them to users.manage).
9. [ ] Full role/route permission and security sweep; API-without-UI and UI-without-API inventory refreshed.
10. [ ] Authoritative requirements matrix v2 (all columns the owner listed), design proposals v2 (11 sections each).

## Notes for the next session

- Local browser stack: backend `node dist/main.js` in be-apps (PORT 4100, NODE_ENV=development, DATABASE_URL rof_play,
  TEACHERS/HEAD_COACHES_ENABLED=true); frontend fe-hist `next start -p 3100` built with API_PROXY_TARGET=http://127.0.0.1:4100;
  `E2E_DATABASE_URL=postgresql://rof@127.0.0.1:55432/rof_play E2E_ADMIN_PASSWORD=E2e-Admin-2026! npx playwright test` in fe-e2e.
- The backend allows 10 sign-ins per minute per address (not weakened): one sign-in per role per test file; leave a minute between full runs.

## New feature (owner request 2026-11-17, Part B) — Teacher–student association, delegated submission, bulk access

- Status: architecture reviewed; plan `docs/TEACHER-STUDENT-ACCESS-PLAN.md` (a9eaabd). Not started in code.
- APPROVED 2026-11-18 (owner): TS-1 automatic visibility only for Administrator-VERIFIED claims; teachers see only a COUNT of
  students awaiting verification (no identities). TS-2 several teachers per student (independent records, no duplicate
  active assignment, history kept). TS-3 cross-school only by explicit Administrator action with reason, audited, no
  school-wide side effect. TS-4 three scopes (whole school / assigned only / selected students; selected rows keep
  history). TS-5 ending an assignment makes dependent selected-student delegations inactive and flagged for review; no
  deletion. TS-6 notify teachers on assignment (dedupe on retry), never students.
- Status: IN PROGRESS.
- Next: migration + scope rules + admin API (parts independent of TS-1), then UI, then Playwright scenarios 1–20.

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
