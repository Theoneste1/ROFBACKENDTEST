# Completion report — approved implementation, testing, fixes and verification (2026-11-18)

Nothing is merged or deployed. Production is untouched: no production data, settings, flags or migrations. All feature
branches are pushed for review; the frontend integration branch `integ/frontend-rc` stays local.

## A. Implementation

| Item | Backend | Frontend | Database |
|---|---|---|---|
| ACC-02 user page details | (existing `GET /admin/users/:id`) | `feat/admin-user-details` a43563f: DOB with age, phones, close-family phone, home place | — |
| REG-02 optional picture at registration | `feat/applications-complete` 4b7450f, dd58aae: one-time token, `PUT /auth/register/avatar`, carried to the account on approval | `feat/applications-complete` f6723e4: optional field on the three forms | `avatarFileId` on TeacherApplication / MentorRequest (20261209000000) |
| REG-13 registration timeline | 117be91: `GET /admin/users/:id/registration-timeline` | `feat/admin-user-details` 4bad525: Registration history card | none (built from audit, applications, claims) |
| AUD-02 previous / new values | c7b1a41: `src/audit/audit-changes.ts`; six field edits record `changes`; assignment / course / review status steps record from / to, in the transition's transaction | — | — |
| Teacher–student access (TS-1…TS-6) | `feat/teacher-student-access` 58fecb7: assignments, delegation student scope, School Access API, teacher summary, bulk actions, notices, audit, role-change hook, capability | `feat/teacher-student-access` 068d5b6, c7adf43: School Access page, teacher card scopes, My Students; `feat/admin-bulk-user-operations` d548de3: bulk actions | 20261210000000_teacher_student_access (TeacherStudentAssignment, UserPermissionOverrideStudent, studentScope / review columns, CHECKs) + guarded rollback; release kit 11 migrations |
| Permission sweep | `src/auth/role-route-sweep.spec.ts` (58fecb7) | — | — |
| Browser tests | — | `test/e2e-playwright` 0787304, e5390a4: teacher–student flow, every role's portal | local fixtures only |

## B. Defects and fixes

| Defect | Root cause | Fix | Regression check |
|---|---|---|---|
| Built server crashed at start ("Cannot access PROFILE_SELECT before initialization") | import cycle auth → registration-avatar → avatar → auth | `avatarUrlOf` moved to `src/users/avatar-url.ts` | server start; full e2e |
| Registration timeline put the school claim before the registration | both rows written in one transaction, a few ms apart | the account's creation leads events within 2 s | e2e registration-timeline |
| Scope CHECK made any delegation grant without a scope fail | constraint required a scope on every delegation | NULL allowed on delegations (= SCHOOL); duplicates treat NULL as SCHOOL; still forbidden on other overrides | e2e decision-notifications, school-affiliations, teacher-student-access (legacy row case) |
| Teacher list exact-field test, teacher route summary wording | new `access` / `can` fields; summary text lost "assigned schools" | list updated deliberately (still exact, keys of the new objects pinned); summary restored | teachers e2e |
| School Access link duplicated `useSession` / `can` when merged with the Teachers tab | both branches declared the same names | one self-contained hook `useSchoolAccessPageAvailable` | integration typecheck / build |
| Earlier this programme: bulk operation stuck RUNNING; leaked area codes in masked phones; phone drawer covering menu | see PROGRESS.md | fixed (b8f0267, sidebar commits) | 10/10 runs; tests |

## C. Testing and verification (local, PostgreSQL 18.6)

- Backend `feat/teacher-student-access`: unit 1155/1155 (+ sweep 5/5); e2e full suite on a clean database 981 passed,
  6 skipped, 0 failed; routes 315/315 called by e2e; lint 0 errors; scripts (API snapshot, release kit, drill verify)
  144/144; migration deploy → rollback refused with data → discard mode (4/4 narrowed delegations revoked, not widened) →
  redeploy, schema drift none.
- Frontend: `feat/teacher-student-access` 361/361; `feat/admin-bulk-user-operations` 366/366; integration
  `integ/frontend-rc` 408/408, typecheck clean, lint 0 errors (1 existing `<img>` warning), Next production build OK.
- Playwright on the integrated stack (real backend + PostgreSQL): teacher–student access 4/4, role journeys 7/7 (Student,
  Coach, Head Coach, Teacher portals; Admin ACC-02 + REG-13; Super Admin overrides), sidebar 8/8 (earlier).
- Permission sweep: real guard chain × 7 callers × 315 registered routes. Anonymous only on @Public; no Student or
  Teacher on /admin; /teacher closed to Students and Coaches (Head Coach passes the guard on 2 routes, refused by the
  service); Head Coach on exactly 15 programme-scoped /admin routes; Super Admin ⊇ Admin (+6); no administrator on a
  grading route. Matrix: `docs/ROLE-ROUTE-MATRIX.md`.
- S3: the 6 tests were NOT run — they need an S3 API; CI starts S3Mock in Docker and runs them. This machine has neither
  Docker nor Java and nothing was installed. They will run in CI when the backend PRs are opened.

## D. Documentation

`docs/PROGRESS.md` (updated after each task), `docs/REQUIREMENTS-MATRIX-V2.md` (dd8a606), `docs/DESIGN-PROPOSALS-V2.md`
(4c1cc8a), `docs/ROLE-ROUTE-MATRIX.md` (cd8f9e9), this report; backend API docs regenerated on each branch; migration
rollback `docs/migrations/20261210000000_teacher_student_access.rollback.sql`.

Branches: backend `feat/applications-complete` c7b1a41, `feat/teacher-student-access` 58fecb7, `docs/post-phase1-release-plan`;
frontend `feat/applications-complete` f6723e4, `feat/admin-user-details` 4bad525, `feat/teacher-student-access` c7adf43,
`feat/admin-bulk-user-operations` d548de3, `test/e2e-playwright` e5390a4 (+ earlier branches in PROGRESS.md).

## E. Outstanding matters

- Owner decisions: 37 questions in `DESIGN-PROPOSALS-V2.md` (countries, subjects, course access, publishing, support,
  groups, targeted e-mail, privacy, registration fields, account states) — 29 requirements wait on them; DOB for
  Administrator-created / invited / imported students; whether the server should require the guardian phone (today only
  the form does).
- External: a fresh Neon branch for the rehearsal and restore drill (SEC-02); staging resources (ARC-04).
- Not yet covered by a browser test: the sign-up forms, the bulk dialog, account history card (backend e2e and unit tests
  exist).
- Merge order (proposed): backend `fix/role-notification-settings` → `feat/applications-complete` →
  `feat/teacher-student-access` → docs; frontend branches in any order (verified together in `integ/frontend-rc`).
- Security notes for review: the teacher–student rollback revokes narrowed delegations rather than widening them; Head
  Coaches pass the guard on the teacher list / summary and are refused by the service (defence in depth).

## F. Release readiness

Ready for final review: every approved item in the execution order is implemented and tested, and all required local
checks pass. Not yet release-ready until (1) CI runs on the PRs (including the 6 S3 tests), (2) the owner answers the open
design decisions or confirms they stay out of this release, and (3) the Neon rehearsal and restore drill are done on a
fresh branch. Teacher and Head Coach production flags remain off.

## Review stage (2026-11-18, after this report)

See `FINAL-REVIEW-PACKAGE.md`. In short: no PR is open yet, so there is no GitHub CI evidence; the same CI steps were run
locally on every branch head and pass. An independent security review found no critical or high issue; M1–M3 and L2 were
fixed in backend `feat/teacher-student-access` b5a9369 (full e2e 982 passed / 6 skipped / 0 failed) and L5 in frontend
b115384; SR-1 and SR-2 went to the owner (`DECISIONS-FOR-REVIEW.md`). A merge conflict between two frontend branches was
removed at the source (`feat/admin-user-details` 6166186). Production was inspected read-only, and the eleven migrations
were rehearsed (deploy, rollback, re-deploy) on a restored copy of the production backup — never on production. The
release runbook and plan now list eleven migrations.

## Approved decisions (2026-11-18, after the review stage)

The owner approved `DECISIONS-FOR-REVIEW.md` §1, SR-1 and SR-2. Implemented and tested on the open PRs: SR-1 teachers never
see suspended, deactivated or archived students (backend #63); 9.2 guardian phone required by the server and 9.3
first-sign-in date of birth for staff-created, invited and imported students (backend #62, frontend #36, Playwright #40).
The other approved items confirm what was built (SR-2 test added). No new migration. GitHub CI per PR head and local
results: `FINAL-REVIEW-PACKAGE.md` §2.
