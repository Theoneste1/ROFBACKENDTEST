# Final review package — ROF LMS post-Phase-1 release (2026-11-18, final review round)

Written for: the owner and the independent reviewer, to review the actual implementation before any merge.

Nothing is merged or deployed. Production was not accessed in this round (no queries, no migrations, no data or
configuration changes). Every test below ran locally on disposable databases or in GitHub CI on the exact PR heads.

## 1. Pull requests — latest heads and CI

| PR | Branch → base | Head (full SHA) | GitHub CI on that head |
|---|---|---|---|
| [#61](https://github.com/Theoneste1/ROFBACKENDTEST/pull/61) | `fix/role-notification-settings` → `develop` | `a4016d3c8ac3c346ccf41368930e3c1260c6411a` | ✅ success — [run 44222198685](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44222198685) |
| [#62](https://github.com/Theoneste1/ROFBACKENDTEST/pull/62) | `feat/applications-complete` → `fix/role-notification-settings` | `5bd224c9095d48cabc1b03cfef5446de8ada7fbf` | ✅ success — [run 44262985942](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44262985942) |
| [#63](https://github.com/Theoneste1/ROFBACKENDTEST/pull/63) | `feat/teacher-student-access` → `feat/applications-complete` | `34509ee292627219ec292180792fdcaf6abc1f0f` | ✅ success — [run 44262998876](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44262998876) |
| [#64](https://github.com/Theoneste1/ROFBACKENDTEST/pull/64) | `docs/post-phase1-release-plan` → `develop` | this commit (branch head) | runs on push (documentation only) |
| [#31](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/31) | `chore/sync-main-into-develop` → `develop` | `6af113b82fec1ccb554027a2094e0f18d5783df6` | ✅ success — [run 44222222082](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222222082) |
| [#32](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/32) | `feat/sidebar-more-menu` → `develop` | `8edeb12e68f55990eefb06097cc0cc74453cbd6a` | ✅ success — [run 44253230742](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44253230742) |
| [#33](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/33) | `feat/admin-form-availability` → `develop` | `61c32c761e12a828a77802d956209e415932cd44` | ✅ success — [run 44222231220](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222231220) |
| [#34](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/34) | `feat/account-history-head-coach-settings` → `develop` | `1dbdf89d18e80ccff3d43517ba4a8560edef2592` | ✅ success — [run 44222235709](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222235709) |
| [#35](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/35) | `feat/admin-bulk-user-operations` → `develop` | `966c50477c672572d47894f20601cafafc0cbc24` | ✅ success — [run 44253239164](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44253239164) |
| [#36](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/36) | `feat/applications-complete` → `develop` | `a369bb16c816f5a8573d183c35deff559625e946` | ✅ success — [run 44263019501](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44263019501) |
| [#37](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/37) | `feat/school-teachers` → `develop` | `7c0d8789759c524c7f0b0cf9a58ff811b275b1cb` | ✅ success — [run 44222249182](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44222249182) |
| [#38](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/38) | `feat/admin-user-details` → `develop` | `674958f8afa739ebeaedbf2653cfc484c53931c9` | ✅ success — [run 44263006798](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44263006798) |
| [#39](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/39) | `feat/teacher-student-access` → `develop` | `a05b34d3adc671a83d661d8ae4eac2ed41806e3a` | ✅ success — [run 44253299618](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44253299618) |
| [#40](https://github.com/Theoneste1/ROFFRONTENDTEST/pull/40) | `test/e2e-playwright` → `develop` | `c46d943b1f21218b0bc2c3a8f5c53e80118f4d40` | ✅ success — [run 44264848042](https://github.com/Theoneste1/ROFFRONTENDTEST/actions/runs/44264848042) |

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
| Refresh / rate limits for shared school connections (owner approval) | #62 | **Implemented and tested.** Signed-in requests count against the user (verified access token), refresh against the refresh token presented (hashed); a per-address ceiling (`THROTTLE_IP_LIMIT` 3000/min; refresh 300/min) still bounds one address. Sign-in and other credential routes unchanged (10/min per address). e2e `rate-limit` with throttling ON (40 students on one address browse and refresh; one user still limited; forged tokens limited per address; per-token and per-address refresh limits), unit `rate-limit.spec`. |
| Rollback order (from the previous round) | #63, #64 | pre-switch step for 1210, table lock, audit; runbook and plan updated (§5). |
| Defects found and fixed this round | #62, #38, #63, #64 | 1209 rollback refusal could not compile (RAISE with a missing parameter) — found by the drill, fixed; a Windows-1252 byte in `lib/api/admin.ts` broke the production build — fixed; two frontend PRs appended to the same capabilities list (merge conflict) — entries moved; release plan steps listed old PR subsets and deployed the backend before the frontend — corrected; pre/post-check headers said "ten". |

## 3. Tests executed (final heads)

- Backend #62: unit 1154/1154; e2e 988 passed, 6 skipped (S3; they run in CI), 0 failed; release / drill / snapshot scripts 145/145; every non-Docker CI step locally.
- Backend #63: unit 1164/1164 (role × route sweep: Student 93, Administrator 284, Super Administrator 290 — +4 Administrator routes, no other role changes); full local e2e before the last fix: 1004 passed, 2 failed (two pinned field lists), both fixed and re-run 29/29; GitHub CI ran the full e2e (incl. S3) green on the final head; scripts 148/148.
- Frontend: each changed PR — typecheck, lint 0 errors, unit tests; combined (#31→#40 simulated merge) 430 unit tests; production build of the integrated frontend.
- Integrated stack (backend #63 + all frontend PRs, fresh database): API journeys 88/88 over real HTTP (registration and pictures, teacher registration and approval with picture review, teacher visibility and authorisation, cross-school and pending-claim assignments, delegated submission, SR-1 inactive students, ending assignments, bulk operations, first-sign-in date of birth, Administrator correction, coach reapplication isolation, account history, notifications, audit). Playwright 21/21 in one full run (incl. the first-sign-in date-of-birth step and the Administrator correction).
- Migrations (isolated databases, synthetic data): baseline of the 31 production migrations → the eleven applied → post-check every MUST holds, no drift → 1210 rollback refuses without the discard setting → pre-switch leaves 0 active narrowed delegations → all eleven rollbacks newest-first succeed (narrowed delegation revoked, never widened; school-wide one kept; suspended account stays inactive; only the older rejected coach attempt removed) → schema equal to the baseline except the kept `AVATAR` enum value → re-apply, no drift.

## 4. Decisions and risks for the owner

1. **Client addresses behind Netlify (configuration, before go-live).** Browsers reach the API through Netlify's `/api` proxy; with `TRUST_PROXY=1` on Render the backend may see Netlify's address for everyone (render.yaml already says to check). Then every per-address limit is shared by all users — including sign-in (10/min for the whole platform). This round moved signed-in traffic to per-user limits, which removes most of the effect, but sign-in, registration and other public routes remain per address. Recommendation: after deploy, check the logged client addresses; if they are Netlify's, set `TRUST_PROXY=2` (Render setting — your approval).
2. **Sign-in limit for school labs.** 10 sign-ins a minute per address (unchanged, as you required) means a class signing in together on one connection waits. Recommendation: count sign-in attempts per username + address (brute force stays limited per account) with a higher per-address ceiling (e.g. 60/min) — needs your approval.
3. **Pictures uploaded after approval.** Application pictures are now reviewed first. Pictures a user uploads later (My Profile) go live immediately and are visible to every signed-in user; Administrators can remove any picture. Recommendation for minors: keep self-upload for staff; for students either (a) Administrator approval before a picture is shown to others, or (b) show students' pictures only to themselves and staff. Product decision.
4. **Neon restore drill / staging (SEC-02, ARC-04).** Still not done; recommended before or soon after release.

## 5. Release sequence (each production step separately approved)

Merge backend #61 → #62 → #63 → #64 and frontend #31 → #40 into `develop` → fresh production backup → pause Render
auto-deploy → pre-check (read only) → `npx prisma migrate deploy` from the approved backend SHA (eleven migrations) →
post-check → **deploy the frontend first** (`develop` → `main`, Netlify) → deploy the backend (`develop` → `main`) →
smoke tests → check client addresses (§4.1). Rollback: run `20261210000000_teacher_student_access.pre-switch.sql`
while the new backend still serves, then deploy the previous backend, then the eleven rollbacks newest-first
(`docs/operations/RELEASE-POST-PHASE1.md` §4).
