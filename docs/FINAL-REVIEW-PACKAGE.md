# Final review package — ROF LMS completion work (2026-11-18)

Written for: the owner and the independent reviewer (ChatGPT), to review the actual implementation before any merge.

Status in one line: everything is committed and pushed to feature branches; **no pull request is open yet, so there is
no GitHub CI evidence yet** — all results below are local runs of the same steps, labelled as such. Nothing is merged
or deployed; production was only read.

Companion documents (same branch `docs/post-phase1-release-plan`): `COMPLETION-REPORT-2026-11-18.md`, `PROGRESS.md`,
`REQUIREMENTS-MATRIX-V2.md`, `DESIGN-PROPOSALS-V2.md`, `DECISIONS-FOR-REVIEW.md`, `ROLE-ROUTE-MATRIX.md`.

## 1. Pull requests

No PR exists yet in either repository (checked with the GitHub API: `GET /repos/…/pulls?state=open` → `[]` for both).
They cannot be opened from here without your GitHub credentials. Each link below opens GitHub's "new pull request" page
with base, title and description filled in; one click ("Create pull request") opens it.

PR_TABLE

**Dependencies and merge order.** Backend: #1 → #2 → #3 are stacked (each PR's base is the previous branch, so each shows
only its own changes); merge in that order, then #4 (documentation only). Frontend: base `develop` for all; a simulated
merge of each branch into `develop` in the order #5, #6, #7, #8, #9, #10, #11, #12, #13, #14 is clean at every step
(one conflict between #8 and #12 was found and removed at the source, `6166186`; both orders now merge cleanly).
Frontend PRs that use new backend features check the backend's capabilities and do nothing on an older backend, so the
frontend may be merged before or after the backend; deploying the backend first is still recommended.

**Repository state (verified):** every worktree is clean; every branch's local head equals `origin/<branch>`; the only
local-only branch is the integration branch `integ/frontend-rc` (by design, never pushed). Two stale backend refs carry
no unmerged content (`feat/registration-into-develop` = PR #54 already in develop; `main`'s extra merge commit has an
empty diff against develop).

## 2. CI status

| Check | GitHub CI | Local run of the same steps (not CI) |
|---|---|---|
| Backend #1–#3: typecheck, lint, unit, migrate empty DB, schema drift, build, generated docs unchanged, route coverage, API snapshot | **not run — no PR** | pass on each exact head (`a4016d3`, `c7b1a41`, `BE_TS_SHA`) |
| Backend e2e (PostgreSQL) | **not run** | #3 full suite: E2E_RESULT; #2: 970 passed / 6 skipped (2026-11-18) |
| Backend S3 tests (6) | **not run** | **not run** — need an S3 API; CI starts S3Mock (Docker); this machine has no Docker or Java |
| Backend Docker image build, compose smoke test | **not run** | **not run** (no Docker) |
| Frontend #5–#14: lint, route types, typecheck, unit, Netlify build, upload-origin check | **not run — no PR** | all pass on each exact head (unit counts 355–366); #12 and #13 re-verified after their last fixes |
| Playwright (not part of CI) | — | teacher–student 4/4, role journeys 7/7, sidebar 8/8 on the integrated stack |

Workflows trigger on `pull_request` (backend: any base; frontend: base `main` or `develop`) and on pushes to
`main` / `develop`, so CI will run as soon as each PR is opened. I will then read the results through the GitHub API
for the exact head commits, fix ordinary failures on the branch and push.

## 3. Requirements reconciliation

The 14 items of the execution order and the matrix entries they affect (`REQUIREMENTS-MATRIX-V2.md`):

| # | Item | Requirement(s) | Status |
|---|---|---|---|
| 1 | Review | — | done |
| 2 | ACC-02 user page details | ACC-02 | 1 Complete and verified (unit + Playwright) |
| 3 | REG-02 optional picture | REG-02 | 2 Implemented, not fully tested (no browser test of the sign-up forms) |
| 4 | REG-13 registration timeline | REG-13 | 1 Complete and verified (e2e + unit + Playwright) |
| 5 | AUD-02 previous / new values | AUD-02 | 1 Complete and verified (e2e + unit) |
| 6 | S3 tests | SEC-01 (storage) | **not verified** — runs in CI once PRs exist |
| 7–9 | Teacher–student access (DB, backend, School Access, My Students, bulk, notices, audit, delegated submission) | INT-07, ACC-07, TCH-01, NOT-04, ACC-16 → 1; ACC-09 → 2 (no browser test of the bulk dialog); PERM-04 → 3 (country / group / support scopes need later phases) | as listed |
| 10 | Playwright | evidence for REG-01, REG-13, ACC-02, ACC-07, ACC-15, TCH-01, ADM-02, INT-07 | done (19 browser tests) |
| 11 | Permission sweep | PERM-05, PERM-06, REG-01 | done |
| 12 | Matrix v2 / proposals v2 | — | done |
| 13 | Regression | — | done locally; CI pending |
| 14 | Docs and report | — | done |

Whole matrix (102): **45** complete and verified · **10** implemented, not fully tested (REG-02, REG-05, REG-06, REG-08,
REG-10, REG-12, ACC-09, ACC-11, NOT-03, UX-01 — each works and has backend e2e and frontend unit tests; none has a
browser test yet) · **15** partial · **29** awaiting design approval · **1** deferred (PERM-02) · **2** blocked externally
(SEC-02 restore drill on Neon, ARC-04 staging) · **0** missing.

Approved requirements that remain incomplete: the 10 above (browser tests) and the 15 partial ones. Of the partial ones,
13 are partial only because the rest of them belongs to a phase awaiting design approval (INT-02, SUB-06, ACA-02, ACA-03,
PERM-01, PERM-04, NOT-01, ADM-01, STU-01, AUD-04, SEC-03 guardian consent, INT-06 school-administrator accounts, PERF-02)
and 2 need work that is not a product decision: SEC-05 (no automated scan for sensitive data in logs / URLs) and
PERF-03 (no accessibility audit).

## 4. Outstanding decisions

`DECISIONS-FOR-REVIEW.md`: 9 to decide before this release (account-state model 10.1–10.3, server-side guardian phone 9.2,
DOB for staff-created students 9.3, guardian consent 8.3 before opening student self-registration, Q11, Q17, O5 — most
confirm what is built), 2 from the security review (SR-1 suspended students visible to teachers, SR-2 assigning a pending
student), 31 that can wait for their phase, and which ones carry security, data or architecture weight.

## 5. Production database and migrations

**Read-only inspection of production (2026-11-18, READ ONLY transaction, credentials never printed):** PostgreSQL 18.7 on
Neon; 31 migrations, newest `20261121001300_school_directory_sync_approval`, none failed or rolled back; the release
pre-check passes every MUST (14 Phase 1 migrations, none of the 11 new ones, nothing they create exists, guard triggers
present); 22 users (13 students, 6 coaches, 2 administrators, 1 Super Administrator); `studentSelfSignup = false`;
2 permission overrides (both DENY, not teacher delegations) → the teacher–student migration's data step touches **0 rows**;
0 teacher school assignments; 0 verified and 12 pending school claims → after release teachers see no students until
Administrators verify claims (TS-1 working as approved); database 16 MB.

**Rehearsal on a separate copy (local PostgreSQL 18.6; production never written):** the existing encrypted backup
`pre-phase1-20261116.dump` (taken after Phase 1; same 31 migrations and the same users as production today) restored
into a new local database → pre-check passes → `prisma migrate deploy` applies all 11 migrations → post-check passes every
MUST (9 tables, 11 enums, 24 columns, 2 triggers; users unchanged; forms carry the closed student registration over;
delegation scopes consistent) → no schema drift → the new backend starts on it (health OK, capabilities include
`teacherStudentAccess`, admin routes 401 without a session) → all 11 rollbacks run newest-first → history rows removed →
pre-check passes again and the schema equals a fresh restore of the backup except the `AVATAR` file-purpose value
(PostgreSQL cannot drop an enum value; documented, unused) → re-deploy passes again. The local copies were deleted after
the drill.

**Rollback procedure:** `docs/operations/RELEASE-POST-PHASE1.md` and `scripts/release/rehearsal.mjs` (rollback files in
`docs/migrations/`, newest first; each refuses to lose data unless explicitly opted in; the teacher–student rollback
revokes narrowed delegations rather than widening them).

**Is a separate Neon branch necessary?** Not for verifying the migrations: they were rehearsed end to end on a restored
copy of production, with the same PostgreSQL major version, and the backup was shown to restore. A Neon branch remains
**recommended, not required**, for two things a local copy cannot show: (1) Neon's own point-in-time restore — the real
recovery path if a release went wrong (SEC-02; a backup has now been restored, but Neon's restore has never been
drilled); (2) a staging environment (ARC-04). Both need the Neon console (your account). On release day, a fresh backup
is still taken immediately before migrating (runbook), because the drill's backup is from 2026-11-16.

## 6. Security review

An independent review of the teacher–student code (role boundaries, visibility, scopes, revocation, delegated submission,
bulk, audit, notifications, migration) found **no critical or high issues**. Findings and what was done:

| # | Finding | Action |
|---|---|---|
| M1 | A same-school assignment (no reason) outlived the school link — cross-school access without a reason | **Fixed**: such an assignment counts only while the student is a verified student of the teacher's schools (`teacher-scope.ts`) |
| M2 | Selected-student permissions stayed listed when a student left the teacher's scope other than by assignment end, and could come back silently | **Fixed**: also removed (and flagged for review) when a teacher's school assignment ends or a verified claim is revoked or replaced |
| M3 | Race between adding a selected student and removing out-of-scope students | **Fixed**: both take the per-teacher advisory lock |
| M4 | Suspended / deactivated / archived students stay visible to teachers (predates this work) | **Your decision** SR-1 |
| L1 | Bulk reason minimum 3 vs 5 for cross-school assignments (items fail with a clear REASON_REQUIRED) | documented |
| L2 | A bulk grant could create a delegation and notify the teacher for a student the teacher does not see | **Fixed**: visibility checked first |
| L3 | Audit row of a bulk-created selected delegation says scope SCHOOL (the grant kind) next to studentScope SELECTED | documented (same format as single grants) |
| L4 | A revoke landing between the permission check and the submission lets that one submission through | by design (checked per request); documented |
| L5 | School Access showed every failure of "take back" as "nothing to do" | **Fixed** (frontend `b115384`) |
| L6 | Assigning a pending student with a reason makes that one student visible by name (TS-1 vs TS-3) | **Your decision** SR-2 |

Verified correct (review + tests): every new admin route needs `users.manageTeachers` (Admins and Super Admins; no
override can grant it); Teachers and Students reach no /admin route (sweep: 315 routes × 7 callers); Teachers cannot change
their own scope; visibility needs an Administrator-verified current claim (e-mail verification never counts); pending
students only as a number; no contact data in teacher or School Access views; revoked / expired grants never apply;
permissions read fresh on every request; the cross-school reason is enforced in the DTO, the code and a database CHECK;
no duplicate assignments (unique index); reassign is all-or-nothing per student; delegated submission keeps the student
as owner, records the teacher as actor and honours the student's own DENY (DENY overrides apply to the whole permission);
bulk re-checks permissions per item, binds the confirmation to the exact selection, skips non-students, deduplicates the
teacher's notice per operation; notices carry counts only; audit rows commit with the change and record from / to; the
rollback can never widen access.

Needs a runtime test or manual review: concurrent bulk grantDelegation items producing exactly one selected delegation
(locking reviewed, not load-tested); the add / remove race of M3 (fixed by locking; not load-tested); the six S3 tests (CI).

## 7. Known defects and limitations

- No GitHub CI evidence until the PRs are opened (above).
- S3 storage tests, Docker image build and the compose smoke test have not run anywhere for these branches yet.
- No browser test yet for the sign-up forms, the bulk dialog, the Forms page and the account-history card (backend e2e and
  frontend unit tests exist).
- 29 requirements wait for design decisions; 2 are blocked on Neon / staging resources.
- Production student self-registration is off (`studentSelfSignup = false`) and stays off after the release (the Forms
  page keeps it closed until an Administrator opens it).

## 8. Exact steps for final verification

1. **You:** open the PRs with the links in §1 — backend #1, #2, #3, #4 and frontend #5–#14 (no merging).
2. **Me, after each PR opens:** read the CI result for the exact head commit through the GitHub API (including the S3,
   Docker build and compose smoke jobs), fix any ordinary failure on its branch, push, and record the run links here and in
   `PROGRESS.md`.
3. **Reviewer:** review the PRs with this package; answer `DECISIONS-FOR-REVIEW.md` §1 and SR-1 / SR-2.
4. **Optional, recommended (you, Neon console, ~5 minutes):** create a Neon branch of production and send me its endpoint
   id; I run the release kit's rehearsal and a Neon restore drill on it (never on production).
5. **Release (only with your approval; `docs/operations/RELEASE-POST-PHASE1.md`):** PRs merged into `develop` in order →
   fresh production backup → pause Render auto-deploy → `npx prisma migrate deploy` from a checkout pinned to the approved
   SHA (Render never runs migrations, `render.yaml`) → post-check (read only) → merge backend `develop` → `main` (the
   deploy) → frontend `develop` → `main` (Netlify). Teacher and Head Coach flags stay off until you decide.
