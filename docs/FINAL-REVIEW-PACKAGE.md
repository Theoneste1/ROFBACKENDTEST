# Final review package — ROF LMS post-Phase-1 release (2026-11-18, final review round)

Written for: the owner and the independent reviewer, to review the actual implementation before any merge.

Nothing is merged or deployed. Production was not accessed in this round (no queries, no migrations, no data or
configuration changes). Every test below ran locally on disposable databases or in GitHub CI on the exact PR heads.

## 1. Pull requests — latest heads and CI

| PR | Branch → base | Head (full SHA) | GitHub CI on that head |
|---|---|---|---|
| [#61](https://github.com/Theoneste1/ROFBACKENDTEST/pull/61) | `fix/role-notification-settings` → `develop` | `a4016d3c8ac3c346ccf41368930e3c1260c6411a` | ✅ success — [run 44222198685](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44222198685) |
| [#62](https://github.com/Theoneste1/ROFBACKENDTEST/pull/62) | `feat/applications-complete` → `fix/role-notification-settings` | `4051eb9b2a676be1200c6f7d656922636e642179` | ✅ success — [run 44291454440](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44291454440) |
| [#63](https://github.com/Theoneste1/ROFBACKENDTEST/pull/63) | `feat/teacher-student-access` → `feat/applications-complete` | `2ac7032b747a2ef0dcac2b366a7b671d47327337` | ✅ success — [run 44295773947](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44295773947) |
| [#64](https://github.com/Theoneste1/ROFBACKENDTEST/pull/64) | `docs/post-phase1-release-plan` → `develop` | this commit (branch head) | runs on push (documentation only) |
| [#31](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/31) | `chore/sync-main-into-develop` → `develop` | `6af113b82fec1ccb554027a2094e0f18d5783df6` | ✅ success — [run 44222222082](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222222082) |
| [#32](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/32) | `feat/sidebar-more-menu` → `develop` | `8edeb12e68f55990eefb06097cc0cc74453cbd6a` | ✅ success — [run 44253230742](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44253230742) |
| [#33](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/33) | `feat/admin-form-availability` → `develop` | `61c32c761e12a828a77802d956209e415932cd44` | ✅ success — [run 44222231220](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222231220) |
| [#34](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/34) | `feat/account-history-head-coach-settings` → `develop` | `1dbdf89d18e80ccff3d43517ba4a8560edef2592` | ✅ success — [run 44222235709](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222235709) |
| [#35](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/35) | `feat/admin-bulk-user-operations` → `develop` | `966c50477c672572d47894f20601cafafc0cbc24` | ✅ success — [run 44253239164](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44253239164) |
| [#36](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/36) | `feat/applications-complete` → `develop` | `a369bb16c816f5a8573d183c35deff559625e946` | ✅ success — [run 44263019501](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44263019501) |
| [#37](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/37) | `feat/school-teachers` → `develop` | `7c0d8789759c524c7f0b0cf9a58ff811b275b1cb` | ✅ success — [run 44222249182](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222249182) |
| [#38](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/38) | `feat/admin-user-details` → `develop` | `674958f8afa739ebeaedbf2653cfc484c53931c9` | ✅ success — [run 44263006798](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44263006798) |
| [#39](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/39) | `feat/teacher-student-access` → `develop` | `adff6089c01717cd1b5f16a390f72f0f4a6d68eb` | ✅ success — [run 44276453563](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44276453563) |
| [#40](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/40) | `test/e2e-playwright` → `develop` | `87cfcdde3bc07d14663824135ed7e61120fb6965` | ✅ success — [run 44276469190](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44276469190) |

Backend CI (`test` job): lint, typecheck, unit, migrate an empty database, schema drift, S3Mock + e2e (incl. the 6 S3
tests), build, generated docs unchanged, every route called by e2e, API snapshot, Docker image; plus `compose-smoke`.
Frontend CI: lint, route types, typecheck, unit, Netlify-settings production build, upload-origin check.

**Dependencies and order.** Backend #61 → #62 → #63 are stacked (each base is the previous branch); #64 last. Frontend
#31 → #40 into `develop`; a simulated sequential merge of the ten heads is clean at every step and the result passes
typecheck, lint (0 errors) and 430 unit tests. Overlapping files keep both sides: admin Sidebar (#32 More menu + #33
Forms link), UserDetail (#34 account history + #38 personal details, registration history, date-of-birth card),
SchoolDirectoryDetail (#37 Teachers tab + #39 School Access link). Frontend #36 must be live no later than backend #62
(the backend holds students without a date of birth; only #36 shows the step) — deploy the frontend first.

## 2. What this round changed

| Item | PR | Status and evidence |
|---|---|---|
| Coach reapplication privacy | #62 | **Fixed and tested.** One `MentorRequest` row per attempt (partial unique indexes `WHERE status <> 'REJECTED'` in `20261209000000_application_details`, which has never run outside tests). A reapplication by the same username, the same e-mail or both is a new application; the earlier attempt keeps its details, questions and answers. e2e `application-info-requests` (username-only, e-mail-only, both; public response, Administrator list, Administrator request-info answer; history preserved; identity taken while pending); journey J14. |
| Date-of-birth corrections (owner approval) | #62 backend, #38 frontend | **Implemented and tested.** `PUT /admin/users/:id/date-of-birth` (`users.manage`, students only, registration date rules, reason 5–500 mandatory, row locked) writes `DATE_OF_BIRTH_CORRECTED` with old date, new date, reason, Administrator and time in the same transaction; `GET …/date-of-birth-history`. Students still set it only once (409). Frontend: correction form and history on the user page. e2e `date-of-birth-step` (validation, reason, non-students, coach / student / teacher refused, audit old → new, history, release of the first-sign-in hold), journey J15, Playwright role-journeys (correction in the browser). |
| Picture moderation (owner approval) | #62 backend, #36 frontend | **Implemented and tested** for application pictures: visible only to the reviewing Administrator (`GET /admin/teacher-applications/:id/avatar`, `GET /mentor-requests/:id/avatar`, private, no-store); kept on approval only with `approvePicture: true` after the Administrator saw it; otherwise discarded and cleaned up; decision audited. Frontend: picture and an unticked "use this picture" box in both review dialogs. e2e `registration-avatar`, journeys J3 / J16. See §4 for the remaining policy decision. |
| Refresh / rate limits for shared school connections (owner approval) | #62 | **Implemented and tested.** Signed-in requests count against the user (verified access token), refresh against the refresh token presented (hashed); a per-address ceiling (`THROTTLE_IP_LIMIT` 3000/min; refresh 300/min) still bounds one address. Activation, password reset and resend stay at 10/min per address; sign-in has its own limits (row below). e2e `rate-limit` with throttling ON (40 students on one address browse and refresh; one user still limited; forged tokens limited per address; per-token and per-address refresh limits), unit `rate-limit.spec`. |
| Student profile pictures (owner decision, second round) | #63 backend, #39 frontend, #40 browser | **Implemented and tested.** `GET /users/:id/avatar` for a student: the student, Administrators / Super Administrators, and a Teacher only while the student is visible to them and an active `students.viewProfile` delegation covers the student (same rule as `GET /teacher/students/:id`, incl. SR-1). Everyone else (classmates, Coaches, Head Coaches — who have no student-profile permission —, other teachers) gets the same 404 as "no picture"; student pictures are never cached (`private, no-store`). Staff pictures unchanged. Frontend shows the generated avatar on a refusal and never retries (unit test). e2e access matrix incl. suspension and revocation on the same token; Playwright direct URL access (signed out 401, a classmate's browser 401, a classmate's token 404, student and Administrator 200). |
| Coach application detail view | #62, #36, #40 | The Administrator's detail is the expanded row of Coaches → Applications → "Details" (`ApplicationsPanel` / `InfoRequestHistory`), fed by `GET /mentor-requests` — there is no separate detail endpoint. Tested directly in the browser: the new attempt's details show no earlier question or answer; the original rejected attempt still shows its own. |
| Client addresses behind Netlify | #63 (probe), #64 | **Evidence, no change:** a local reproduction with the real Next.js rewrite shows it neither adds the client's address nor strips a forged `X-Forwarded-For` — so `TRUST_PROXY=2` would be forgeable unless Netlify's hosted proxy appends the real address. Keep `TRUST_PROXY=1`; staging test with `scripts/ops/client-ip-probe.mjs` (`operations/CLIENT-IP-VERIFICATION.md`). |
| Sign-in rate limiting (owner approval, round 5) | #62 (merged into #63), #64 | **Implemented and tested** (`SIGN-IN-RATE-LIMIT-PROPOSAL.md`, now marked approved and implemented). The limits are 5 attempts a minute and 20 an hour per normalised username, using an HMAC key and decided before any lookup; 60 a minute per address on `POST /auth/login`, where it was 10. Five wrong passwords lock that username **for that address only** for 15 minutes (`LOCK_ACCOUNT` with `scope: ADDRESS`, `ip`). Unknown usernames get identical answers. A password reset clears every lock. **Two refinements to confirm:** (1) an address from which the account signed in successfully in the last 30 days is not held by the username windows, so an attacker cannot keep a student out everywhere for up to an hour; (2) an unexpired `User.lockedUntil` from the current release is honoured until it expires (found by the `account-states` e2e test). Correction to the proposal: no Administrator "clear lock" control exists; password reset is the remedy. **Evidence:** unit `auth.service.spec`; e2e `security` (scoped lock, audit, 20 parallel guesses produce one lock); e2e `rate-limit` with throttling **on** (40 sign-ins from one address, the 6th attempt in a minute refused, the known address not held, unknown and real usernames compared response by response, the 61st account from one address refused). The counters are in memory: one backend instance. |
| Staging and restore drill | #64 | **Procedure ready** (`operations/STAGING-AND-RESTORE.md`): isolated Neon branch (point-in-time), Render and Netlify staging, local storage, dry-run e-mail; owner actions listed; restore + application test is a release gate. |
| Rollback order (from the previous round) | #63, #64 | pre-switch step for 1210, table lock, audit; runbook and plan updated (§5). |
| Defects found and fixed this round | #62, #38, #63, #64 | 1209 rollback refusal could not compile (RAISE with a missing parameter) — found by the drill, fixed; a Windows-1252 byte in `lib/api/admin.ts` broke the production build — fixed; two frontend PRs appended to the same capabilities list (merge conflict) — entries moved; release plan steps listed old PR subsets and deployed the backend before the frontend — corrected; pre/post-check headers said "ten". |

## 3. Tests executed (final heads)

- **Round 5 (sign-in limits), on the heads above:**
  - Backend #62 `4051eb9`: unit 1152/1152; full local e2e 992 passed, 6 skipped (S3), 0 failed; typecheck, lint (0 errors), build, generated docs unchanged, 310/310 routes covered, API snapshot 87/87; GitHub CI green.
  - Backend #63 `2ac7032` (#62 merged, no conflicts): local CI replica (every non-Docker step) all ok; full local e2e 1014 passed, 6 skipped, 0 failed.
  - Integrated stack (backend #63 `2ac7032` on a fresh database, frontend PRs unchanged): API journeys 88/88; Playwright 24/24. The frontend shows its own "Too many requests" text for any 429, so no frontend change is needed.
  - Not rerun: the migration and release scripts, because this round changed no migrations.
- **Earlier rounds:**

- Backend #62: unit 1154/1154; e2e 988 passed, 6 skipped (S3; they run in CI), 0 failed; release / drill / snapshot scripts 145/145; every non-Docker CI step locally.
- Backend #63: unit 1164/1164 (role × route sweep: Student 93, Administrator 284, Super Administrator 290 — +4 Administrator routes, no other role changes); full local e2e before the last fix: 1004 passed, 2 failed (two pinned field lists), both fixed and re-run 29/29; GitHub CI ran the full e2e (incl. S3) green on the final head; scripts 148/148.
- Frontend: each changed PR — typecheck, lint 0 errors, unit tests; combined (#31→#40 simulated merge) 430 unit tests; production build of the integrated frontend.
- Second round (student pictures): backend #63 local CI replica (every non-Docker step) on `3a35ac7`; e2e picture matrix and profile-picture / unknown-role specs; frontend #39 366 unit tests; integration 431 unit tests; Playwright 24/24 in one full run (incl. coach application detail view and picture direct-URL tests).
- Integrated stack (backend #63 + all frontend PRs, fresh database): API journeys 88/88 over real HTTP (registration and pictures, teacher registration and approval with picture review, teacher visibility and authorisation, cross-school and pending-claim assignments, delegated submission, SR-1 inactive students, ending assignments, bulk operations, first-sign-in date of birth, Administrator correction, coach reapplication isolation, account history, notifications, audit). Playwright 21/21 in one full run (incl. the first-sign-in date-of-birth step and the Administrator correction).
- Migrations (isolated databases, synthetic data): baseline of the 31 production migrations → the eleven applied → post-check every MUST holds, no drift → 1210 rollback refuses without the discard setting → pre-switch leaves 0 active narrowed delegations → all eleven rollbacks newest-first succeed (narrowed delegation revoked, never widened; school-wide one kept; suspended account stays inactive; only the older rejected coach attempt removed) → schema equal to the baseline except the kept `AVATAR` enum value → re-apply, no drift.

## 4. Decisions and risks for the owner

1. **Client addresses behind Netlify.** Do **not** set `TRUST_PROXY=2` on assumption: locally, the Next.js rewrite passes a forged `X-Forwarded-For` through, which `2` would trust. Run the staging probe (`operations/CLIENT-IP-VERIFICATION.md`); keep `1` until then (it cannot be forged; signed-in traffic is per user anyway).
2. **Sign-in limits.** Implemented as approved. Please confirm the two refinements in §2. Both the address-scoped lock and the known-address exemption depend on the real client address. If staging shows that Netlify presents a few shared proxy addresses, the 60-a-minute per-address limit and the address locks apply to everyone behind each one. Guessing would still be capped at about 20 an hour per username and address. The staging client-IP test is therefore part of the release gate.
3. **Student pictures** — decided and implemented (student, Administrators, teachers with profile access). Coaches and Head Coaches see the generated avatar (initials) for students; **the owner confirmed this is acceptable (round 5)**.
4. **Neon restore drill and staging — release gate.** Needs the owner's Neon / Render / Netlify actions (`operations/STAGING-AND-RESTORE.md` §2); not done yet, so the release is **not ready** until it is. The client-IP probe (`operations/CLIENT-IP-VERIFICATION.md` §3) runs in the same staging session.

## 5. Release sequence (each production step separately approved)

Merge backend #61 → #62 → #63 → #64 and frontend #31 → #40 into `develop` → fresh production backup → pause Render
auto-deploy → pre-check (read only) → `npx prisma migrate deploy` from the approved backend SHA (eleven migrations) →
post-check → **deploy the frontend first** (`develop` → `main`, Netlify) → deploy the backend (`develop` → `main`) →
smoke tests → check client addresses (§4.1). Rollback: run `20261210000000_teacher_student_access.pre-switch.sql`
while the new backend still serves, then deploy the previous backend, then the eleven rollbacks newest-first
(`docs/operations/RELEASE-POST-PHASE1.md` §4).
