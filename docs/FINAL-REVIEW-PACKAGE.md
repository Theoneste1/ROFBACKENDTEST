# Final review package — ROF LMS completion work (2026-11-18)

Written for: the owner and the independent reviewer (ChatGPT), to review the actual implementation before any merge.

Status in one line: all 14 PRs are open and none is merged; GitHub CI is recorded per PR head below (§2). The owner's
approved decisions (§1 of `DECISIONS-FOR-REVIEW.md`, SR-1, SR-2) are implemented and tested. Nothing is merged or
deployed; production was only read (earlier the same day), never written.

Companion documents (same branch `docs/post-phase1-release-plan`): `COMPLETION-REPORT-2026-11-18.md`, `PROGRESS.md`,
`REQUIREMENTS-MATRIX-V2.md`, `DESIGN-PROPOSALS-V2.md`, `DECISIONS-FOR-REVIEW.md`, `ROLE-ROUTE-MATRIX.md`.

## 1. Pull requests

| PR | Repo | Head → base | Head commit | Contents | Depends on |
|---|---|---|---|---|---|
| [#61](https://github.com/Theoneste1/ROFBACKENDTEST/pull/61) | backend | `fix/role-notification-settings` → `develop` | `a4016d3` | Head Coach / Super Admin notification settings; discussion recipients | — |
| [#62](https://github.com/Theoneste1/ROFBACKENDTEST/pull/62) | backend | `feat/applications-complete` → `fix/role-notification-settings` | `4c0b152` | application details, request more information, DOB required, optional registration picture, registration timeline, audit previous / new values; **+ 9.2 guardian phone required by the server, 9.3 first-sign-in date of birth** | #61 |
| [#63](https://github.com/Theoneste1/ROFBACKENDTEST/pull/63) | backend | `feat/teacher-student-access` → `feat/applications-complete` | `eaccf4b` | teacher–student access TS-1…TS-6, School Access API, bulk actions, permission sweep; **+ SR-1 inactive students hidden from teachers, SR-2 test**; merges #62 | #62 |
| [#64](https://github.com/Theoneste1/ROFBACKENDTEST/pull/64) | backend | `docs/post-phase1-release-plan` → `develop` | branch head | documentation only (this package and its companions) | merge last |
| [#31](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/31) | frontend | `chore/sync-main-into-develop` → `develop` | `6af113b` | main → develop sync | — |
| [#32](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/32) | frontend | `feat/sidebar-more-menu` → `develop` | `4c8a511` | sidebar "More" menu (approved) | — |
| [#33](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/33) | frontend | `feat/admin-form-availability` → `develop` | `61c32c7` | Forms page | backend #62 |
| [#34](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/34) | frontend | `feat/account-history-head-coach-settings` → `develop` | `1dbdf89` | account history card; Head Coach notification switches | backend #61 |
| [#35](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/35) | frontend | `feat/admin-bulk-user-operations` → `develop` | `d548de3` | bulk user operations, CSV export, teacher–student bulk actions | backend #62 (+ #63) |
| [#36](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/36) | frontend | `feat/applications-complete` → `develop` | `31097e4` | application details UI, answer page, optional registration picture; **+ 9.3 date-of-birth step** | backend #62 |
| [#37](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/37) | frontend | `feat/school-teachers` → `develop` | `7c0d878` | Teachers tab on the school page | backend #62 |
| [#38](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/38) | frontend | `feat/admin-user-details` → `develop` | `6166186` | user page personal details, registration history | backend #62 |
| [#39](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/39) | frontend | `feat/teacher-student-access` → `develop` | `b115384` | School Access page, delegation scopes, My Students | backend #63 |
| [#40](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/40) | frontend | `test/e2e-playwright` → `develop` | `3359757` | Playwright browser tests; **+ date-of-birth step** | all frontend PRs |

**Merge order.** Backend #61 → #62 → #63 (stacked: each base is the previous branch, so each shows only its own changes),
then #64. Frontend: base `develop` for all, #31 … #40 in number order (a simulated merge is clean at every step). Frontend
features that need new backend behaviour check the backend's capabilities (or, for the date-of-birth step, the
`dateOfBirthRequired` flag that only the new backend sends) and do nothing on an older backend, so either side may be
deployed first. **Release note for 9.3:** once backend #62 is live, a student with no date of birth is refused everything
but the step until they give it; the frontend #36 step must therefore be live no later than the backend (deploy the
frontend first, or both together).

## 2. CI status (GitHub Actions, per exact PR head)

| PR | Head | Run | Result |
|---|---|---|---|
| #61 | `a4016d3` | [44222198685](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44222198685) | ✅ test + compose-smoke |
| #62 | `4c0b152` | [44231639311](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44231639311) | ✅ test + compose-smoke |
| #63 | `eaccf4b` | [44231947870](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44231947870) | ✅ test + compose-smoke |
| #64 | `b98719e` → this commit | [44222213980](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44222213980) (earlier head) | ✅ (re-runs on this push; documentation only) |
| #31–#35, #37–#39 | unchanged heads (§1) | runs 44222222082 … 44222258395 | ✅ all eight |
| #36 | `31097e4` | [44225947513](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44225947513) | ✅ |
| #40 | `3359757` | [44232836995](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44232836995) | ✅ |

The backend `test` job runs: lint, typecheck, unit, migrate an empty database, schema drift, **S3Mock + e2e (incl. the 6
S3 tests)**, build, generated docs unchanged, every route called by e2e, API snapshot, **Docker image build**; the
`compose-smoke` job starts the full docker-compose stack and smoke-tests it. Frontend CI: lint, route types, typecheck,
unit, Netlify-settings build, upload-origin check.

**The 6 S3 tests:** the workflow sets `S3_TEST_ENDPOINT` for the whole job and the S3 spec is skipped only when it is
missing, so they ran inside the passing e2e step. Job logs need a signed-in GitHub account (the API returns 403 to me),
so the per-test lines were not read; the owner can see them in the run's "End-to-end tests" step.

**Failures found and fixed.** #62's intermediate head `9bc7a6a` failed "API documentation is up to date" ([run
44230306284](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44230306284)): the avatar responses' documented type
changed. Fixed by regenerating (`d334cca`) and recording the approved API snapshot (`4c0b152`); the new head passes. No
other CI failure.

**Local runs (not CI) of the same code:** #62 e2e 976 passed / 6 skipped / 0 failed, unit 1150; #63 e2e 990 / 6 / 0, unit
1160 + sweep, routes 316/316, every non-Docker CI step on the exact head; frontend #36 368 unit tests.
**Browser (Playwright, not part of CI), integrated stack = merged backend #63 + all frontend PRs:** 20 tests incl. the new
date-of-birth step; one sidebar test (coach portal) timed out once on "Loading…" with no throttling in the backend log and
passed 7/7 on rerun — recorded as a flake, not hidden.

## 3. Approved decisions — implementation status

Details and evidence per item: `DECISIONS-FOR-REVIEW.md` §1.

| Decision | Status |
|---|---|
| SR-1 hide SUSPENDED / DEACTIVATED / ARCHIVED students from Teachers | **Implemented and tested** (#63 `14b9e1a`): the ACTIVE condition is on both visibility rules, so it holds on every teacher path (list with every filter, summary, profile, progress, delegation coverage, submit on behalf, new selected-student delegations, bulk grants); cross-school assignments included. Scope is kept separate from visibility — hiding a student does not end assignments, drop selected students or change how a new assignment is classified; reactivation restores access. Administrators still see and manage the accounts. e2e: 3 states × school and cross-school student × every route; the test fails without the fix. |
| 9.2 guardian phone required by the server | **Implemented and tested** (#62 `c920d92`): `POST /auth/register/student` (the only student sign-up path) refuses a missing, null, empty, blank, malformed or invalid `guardianPhone` (400 naming the field, nothing created); E.164 storage unchanged; the student's own phone stays optional. Staff-created students are unaffected (not a registration). The frontend form already required it. |
| 9.3 DOB at first sign-in for staff-created / invited / imported students | **Implemented and tested** (#62 `c920d92` + `9bc7a6a`, #36 `31097e4`, #40 `3359757`): `dateOfBirthRequired` on login, `GET /me` and the avatar responses; `DateOfBirthGuard` answers 403 `DATE_OF_BIRTH_REQUIRED` everywhere except `GET /me`, `GET /me/permissions`, `PUT /me/date-of-birth` and sign-out; registration rules (real past date, age 5–30); given once (409 afterwards; an Administrator corrects it); audited without the value; the student portal shows only the step. Tests: admin-created, invited, imported (held, then released), self-registered and seeded students and other roles (never held), invalid dates, sign-out while held, browser test. |
| 10.1–10.3 account states, Q11 phones not unique, Q17 school changes verified by an Administrator, O5 Head Coaches cannot create coaches | **Confirmed as built** (no code change); evidence in `DECISIONS-FOR-REVIEW.md` §1 |
| SR-2 pending-claim students assignable with a reason | **Confirmed as built, test added** (#63): reason required, audited, visible to that teacher only |
| 8.3 guardian consent | no build now — legal advice before student self-registration is opened (it stays off) |

**Compatibility checked:** the frontend handles the new backend responses (`dateOfBirthRequired`, `DATE_OF_BIRTH_REQUIRED`,
the guardian-phone validation the form already enforced); the teacher screens need no change for SR-1 (fewer students are
returned); the integrated browser run above used the merged backend.

## 4. Requirements reconciliation

`REQUIREMENTS-MATRIX-V2.md` (102): **46** complete and verified · **10** implemented, not fully tested (REG-02, REG-05,
REG-06, REG-08, REG-10, REG-12, ACC-09, ACC-11, NOT-03, UX-01 — each works with backend e2e and frontend unit tests; no
browser test yet) · **15** partial · **28** awaiting design approval · **1** deferred (PERM-02) · **2** blocked externally
(SEC-02 Neon restore drill, ARC-04 staging) · **0** missing. Change today: ACC-12 (account states) 5 → 1 after the owner
approved the four-stored / two-derived model, which e2e account-states verifies. REG-02 stays 2 (no browser test of the
sign-up form, although the date-of-birth step now has one). SEC-03 stays 3 (guardian consent waits for legal advice).

## 5. Production database and migrations

Unchanged by today's decisions: **no new migration** (9.2, 9.3 and SR-1 use existing columns). The eleven migrations,
their rollbacks and the rehearsal on a restored copy of production (deploy → post-check → rollback newest-first → schema
equal to the backup except the `AVATAR` enum value → re-deploy) are as recorded earlier the same day:
`docs/operations/RELEASE-POST-PHASE1.md`, `scripts/release/rehearsal.mjs`, `docs/migrations/*.rollback.sql`. The migrations
are additive; each rollback refuses to lose data unless explicitly opted in; the teacher–student rollback revokes narrowed
delegations rather than widening them. Release-kit and drill script tests: 144 pass on #63.

Read-only facts from the earlier inspection: 31 migrations applied, Phase 1 complete; 22 users (13 students);
`studentSelfSignup = false`; 0 teacher delegations (the teacher–student data step touches 0 rows); 0 verified and 12
pending school claims. **New consequence of 9.3, not measured:** production students who registered before the date of
birth was required may have none; each will be asked once at the next sign-in (intended). Counting them needs a read-only
query on production, which was not run for this change.

A separate Neon branch is **not necessary** to verify the migrations; it is recommended for Neon's own point-in-time
restore drill (SEC-02) and for staging (ARC-04).

## 6. Security review

| # | Finding | Action |
|---|---|---|
| M1 | Same-school assignment outlived the school link | **Fixed** (`teacher-scope.ts`) |
| M2 | Selected students could come back silently after leaving scope | **Fixed** (removed and flagged on school end, claim revoke / replace) |
| M3 | Race between adding and removing selected students | **Fixed** (per-teacher advisory lock) |
| M4 | Suspended / deactivated / archived students visible to teachers | **Fixed — SR-1 approved and implemented** (#63 `14b9e1a`) |
| L1 | Bulk reason minimum 3 vs 5 for cross-school | documented (items fail with REASON_REQUIRED) |
| L2 | Bulk grant for an unseen student | **Fixed** (visibility first) |
| L3 | Audit scope wording on bulk selected delegations | documented |
| L4 | Revoke between permission check and submission | by design (per request); documented |
| L5 | School Access "take back" errors shown as "nothing to do" | **Fixed** (frontend `b115384`) |
| L6 | Pending-claim student visible by name after a reasoned assignment | **Kept — SR-2 approved**; test added |

New code reviewed for this round: `DateOfBirthGuard` runs after authentication and before role checks, skips `@Public`
routes, holds only STUDENT accounts with no date of birth (read fresh on every request), and allows only four routes;
`PUT /me/date-of-birth` is STUDENT-only, conditional (`dateOfBirth IS NULL`, so it can never overwrite) and audited
without the value. Sweep: 316 routes × 7 callers; Student 92 → 93 (the new route); every other total unchanged.

## 7. Known limitations

- 9.3 holds students without a date of birth on the backend: deploy frontend #36 no later than backend #62 (§1).
- The number of production students who will see the date-of-birth step was not measured (needs a read-only query).
- No browser test yet for the sign-up forms, the bulk dialog, the Forms page and the account-history card.
- One Playwright flake (sidebar, coach) in one of two runs.
- S3 test lines not read individually (logs need sign-in); the step that runs them passed.
- 28 requirements wait for design decisions; 2 are blocked on Neon / staging resources.

## 8. Exact steps for final verification

1. **Reviewer:** review PRs #61–#64 and #31–#40 with this package (CI links in §2).
2. **Optional (you, Neon console):** a Neon branch of production for Neon's restore drill; I run the release kit's
   rehearsal on it (never on production).
3. **Release (only with your approval; `docs/operations/RELEASE-POST-PHASE1.md`):** merge in the order of §1 → fresh
   production backup → pause Render auto-deploy → `npx prisma migrate deploy` from a checkout pinned to the approved SHA
   (Render never runs migrations) → post-check (read only) → deploy the frontend (`develop` → `main`, Netlify) → deploy the
   backend (`develop` → `main`). Teacher and Head Coach flags stay off until you decide.
