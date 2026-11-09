# Implementation tracker — ROF LMS backend

**Created:** 2026-11-08 · **Design status:** approved design direction, subject to the final implementation review
([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)) · **Implementation status:** nothing started — documentation only.

Requirement IDs, titles and priorities come from [BACKEND_REQUIREMENTS_AUDIT.md](BACKEND_REQUIREMENTS_AUDIT.md).
Phases follow the approved sequence (0 stabilise · 1 permissions · 2 countries/grades/schools · 3 subjects/topics ·
4 account lifecycle · 5 registration by user type · 6 course access · 7 publishing/versioning · 8 student support ·
9 groups/targeted e-mail · 10 notifications/audit/privacy). "—" in the phase column = already implemented; kept as
regression. "FE" = frontend only.

**Status values:** Not started · Partial (existing) — not started · In progress · Implemented — awaiting review ·
Verified · Done (existing) — regression · Needs decision · Frontend only · Blocked · Deferred (approved scope change).
A requirement is **Verified** only when its verification criteria pass in automated tests (and, where stated, on a
production-copy rehearsal) — never because an endpoint or table exists.

## Phase 0 — stabilise existing work

| ID | Task | Priority | Depends on | Status | Verification |
|---|---|---|---|---|---|
| P0-01 | Review pending backend commits (`cc27c8d`, `962e1f0`, `f624d25`) and prepare the PR `feature/backend-completion → main` | Critical | owner go-ahead to push | **Done 2026-11-08** | PR [#3](https://github.com/Theoneste1/ROFBACKENDTEST/pull/3) (4 commits incl. docs `6f2e3a6`) CI green, merged by owner → `main` `a8df186` |
| P0-02 | Fix and deploy the frontend Netlify 404 (frontend branch `feature/production-readiness`) | Critical | owner merge | Not started | `roflms.netlify.app` serves the app; reset link opens the reset page |
| P0-03 | Regression baseline (tag, test counts, OpenAPI snapshot) | High | P0-01 | **Done 2026-11-08** | tag `rof-backend-baseline-2026-11-08` → `a8df186`; unit 482/482, e2e 289 passed + 3 skipped (S3, pass in CI), lint 0 errors / 1 warning (unused `emptyToUndefined`), type-check/build clean, 202/202 routes, CI run 42473170005 green; re-verified 2026-11-08 (BASELINE §9: one intermittent e2e timeout, not reproduced; CI green on `develop` 97131c2 and frontend `main` ea09fcc); [docs/baseline/BASELINE-2026-11-08.md](docs/baseline/BASELINE-2026-11-08.md), API snapshot + test inventory |
| P0-04 | Verify database backup and restore (Neon restore drill) | Critical | — | Part A done (2026-11-09); Part B pending approval | restore documented with time and checks — [drill report](docs/operations/BACKUP-RESTORE-DRILL-2026-11-09.md) |
| P0-05 | Controlled Cloudflare R2 upload and download test | Critical | P0-01 deployed | **Pending** — tooling and S3Mock tests ready; live R2 run awaits approval ([procedure](docs/operations/R2-VERIFICATION.md)) | object in `rof-files`, download byte-identical, start-up log names R2 |
| P0-06 | CI check: migration names strictly after the newest on `main` | Critical | — | Not started | check fails on a deliberately mis-named test migration |
| P0-07 | Align `develop` with `main` after P0-01 is merged (Q22 decided: keep `develop`) | Medium | P0-01 merged | **Done 2026-11-08** | merge commit `2528587` on `develop` (parents `46129e2`, `a8df186`); file tree identical to `main` (`d6945d6`); normal push |
| P0-08 | Staging environment (ADR-016) | High | P0-04 | Not started | staging URL with rehearsed migrations |

## Phase 1 — Permissions and role management

Plan: [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) (v5.2) · decisions: [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) ADR-002/003/004/015/017/018/019 and the Phase 1 decision register. Every PR targets `develop`; every migration, the Super Admin bootstrap and every feature-flag change needs separate approval.

| ID | Task | Priority | Depends on | Status | Verification |
|---|---|---|---|---|---|
| P1-01 | Record Phase 1 decisions (documentation only) | Critical | owner approval of PR 1 scope | **Done 2026-11-09** — PR #10, merge commit `0be9fe9` (CI green on `develop`) | only approved Markdown files changed; statuses match the register |
| P1-01b | Record the final owner sign-off of all Phase 1 decisions (documentation only) | Critical | P1-01 | In progress — PR open | register shows every B/C decision with the owner's outcome; H7 changed; AS1, AS2 added; Markdown only |
| P1-02 | Every route declares access (`@Authenticated` on 54 routes) + declaration test | Critical | P1-01b; owner approval to implement (given 2026-11-09, plan v2) | Implemented — awaiting review | 211 handlers = 16 @Public + 141 @Roles + 54 @Authenticated, 0 undeclared (`src/common/decorators/route-declarations.spec.ts`); guard decisions for anonymous/STUDENT/MENTOR/ADMIN/unknown role identical to the baseline captured before the change (`route-access-baseline.json`); generated docs and API snapshot unchanged |
| P1-03 | Positive role checks; unknown role → least privilege | Critical | P1-02 | Not started | unknown-role tests; suites green |
| P1-04 | Six-role catalogue, PermissionService, permission guard, equivalence framework, extended `/me/permissions` | Critical | P1-03 | Not started | equivalence for STUDENT/COACH/ADMIN; old `/me/permissions` fields unchanged |
| P1-05 | Role allow-list on all paths + feature flags; migration M1 (role values) | Critical | P1-04 | Not started | new roles not creatable with flags off; rehearsal clean |
| P1-F1 | Frontend tolerates six and unknown roles | Critical | P1-01 | Not started | deployed before any new-role account exists |
| P1-06 | Route conversion to permission checks (batches) | Critical | P1-04 | Not started | equivalence + area e2e per batch |
| P1-07 | Programme membership: M2 + M3 backfill, scope helpers, heads/members API | Critical | P1-04 | Not started | plan §11.5 (precondition, reconciliation, access regression, scope isolation, rollback) on test DB and Neon copy |
| P1-08 | Super Admin: authority (no grading), role rules, step-up, M4 trigger, bootstrap command (not run), runbook, audit interceptor, boundary flag (off) | Critical | P1-05, P1-06 | Not started | plan §11.2, §11.4; bootstrap rehearsed on non-production only |
| P1-09 | Individual overrides: M5, Super-Admin-only API, approved list, expiry at `expiresAt` | Critical | P1-04 | Not started | plan §11.3 |
| P1-10 | Head Coach (programme-scoped) | High | P1-05, P1-06, P1-07, P1-09 | Not started | programme-boundary and escalation suites |
| P1-11 | Teacher: M6 TeacherAssignment, scoped view, override path | High | P1-05, P1-06, P1-07, P1-09 | Not started | teacher suite; never in grading distribution |
| P1-F2 | Frontend: permission-driven navigation; Head Coach, Super Admin, Teacher views | High | matching backend tasks | Not started | API refuses every hidden action |
| P1-12 | Phase exit: full matrix, combined M1–M6 rehearsal, docs | Critical | all above | Not started | plan §11 complete; owner sign-off |

## Requirements

| ID | Requirement | Priority | Phase | Depends on | Affected components | Status | Verification criteria |
|---|---|---|---|---|---|---|---|
| REG-01 | Three primary user types: Student, Teacher, Coach (plus Administrator) | Critical | 5 | PERM-02, ADR-002/003 | Role enum, auth, permissions, all role switches | Partial (existing) — not started | TEACHER registered, approved, logs in; matrix shows default teacher rights only |
| REG-02 | Student registration collects personal and academic information | High | 5 | INT-01, INT-03, SUB-01, ACC-16 | register-student DTO, User, FileObject | Partial (existing) — not started | All fields stored and validated; guardian phone mandatory when enabled; masked for non-permitted readers |
| REG-03 | School and grade options adapt to the selected country | Critical | 2 | INT-01, INT-03 | reference module, schools search, registration | Not started | Grades/schools offered match the selected country (Rwanda + one test country) |
| REG-04 | Registration is separate from academic enrollment; no automatic access to every course | Critical | 6 | ADR-006, ACA-05 | courses service, enrollments | Partial (existing) — not started | New student sees DIVISION_OPEN courses only; restricted course blocked until enrolled |
| REG-05 | Teacher registration (phone mandatory, school/institution, position, subjects, experience) | High | 5 | REG-01, REG-10, ADR-009 | registration applications, mentor-requests | Not started | Teacher application submitted, reviewed, approved → TEACHER account |
| REG-06 | Coach registration fields (phone, country, affiliation, qualifications, subjects, expertise, experience, picture) | High | 5 | INT-01, SUB-01, ADR-009 | mentor-requests (extended) | Partial (existing) — not started | New fields accepted; old payload still accepted (compat test) |
| REG-07 | Coaches are verified and approved; permissions/assignments only from an administrator | High | — | — | mentor-requests, mentor-assignments | Done (existing) — regression | Regression: existing e2e (remaining-endpoints, access) stays green |
| REG-08 | Enable/disable public registration overall and per user type | Medium | 5 | REG-05 | settings registry, registration | Partial (existing) — not started | Disabled type → REGISTRATION_CLOSED; other types unaffected |
| REG-09 | Configure mandatory/optional registration fields | Low | 5 | REG-02/05/06, Q10 | settings, /registration/form | Not started | Optional/mandatory switch honoured by API and form endpoint |
| REG-10 | Review and approve registrations; reject with a reason; request more information | High | 5 | ACC-12, ADR-009 | registration applications, notifications, e-mail | Partial (existing) — not started | Reject stores reason and e-mails applicant; request-info loop works; transitions validated |
| REG-11 | Resend activation, suspend/reactivate, bulk import | High | — | — | users, activation | Done (existing) — regression | Regression: user-management e2e green; import extended to new fields in Phase 5 |
| REG-12 | Export user records | Medium | 4 | PERM-03, ACC-16 | users export | Partial (existing) — not started | CSV columns per permission; sensitive columns only with users.viewSensitive; audited |
| REG-13 | View registration history | Low | 4 | ACC-12 | users history endpoint | Partial (existing) — not started | Timeline shows registration, approvals, status changes in order |
| REG-14 | Prevent duplicate accounts | High | — | Q11 | auth registration | Done (existing) — regression | Regression: duplicate username/email refused (auth e2e) |
| INT-01 | Administrators manage countries | Critical | 2 | ADR-005, Q12 | reference module, Country | Not started | Admin CRUD; inactive countries hidden from public lists |
| INT-02 | Region/province/district and city/locality | Medium | 2 | INT-01, Q13 | Region | Not started | Regions listed per country; schools/users link to a region |
| INT-03 | Education systems and grade levels per country | Critical | 2 | INT-01, ADR-005 | EducationSystem, GradeLevel, users, enrollments, divisions | Not started | Rwanda P1–P6/S1–S6 seeded; every existing user/enrollment mapped to the same grade as before |
| INT-04 | Schools linked to country and location, with type | High | 2 | INT-01 | School | Partial (existing) — not started | Schools linked to country; same name allowed in two countries, refused twice in one |
| INT-05 | Add, edit, activate/deactivate schools | Medium | 2 | INT-04, PERM-03 | schools admin API | Partial (existing) — not started | Create/edit/deactivate; inactive schools hidden in registration search |
| INT-06 | Assign school administrators or contacts | Low | 2 | PERM-04, Q14 | SchoolContact / school scope | Not started | Contacts stored; school-scoped admin limited to own school |
| INT-07 | View students and teachers of a school | Medium | 2 | INT-04, REG-01 | schools API | Partial (existing) — not started | School detail lists students and teachers (paginated, permission-checked) |
| INT-08 | Bulk import schools | Low | 2 | INT-04 | schools import | Not started | CSV dry run reports errors; import creates schools without duplicates |
| INT-09 | Avoid duplicate schools | Medium | 2 | INT-04 | School normalisation | Partial (existing) — not started | Duplicate report before index change; normalised duplicates refused |
| SUB-01 | Admins create, edit, publish, deactivate, archive subjects (name, code, description, icon, order, status, visibility, created/updated info) | Critical | 3 | PERM-03, ADR-007 | Discipline/subjects module, storage | Partial (existing) — not started | Admin creates, edits, publishes, archives a subject with icon; /disciplines alias unchanged |
| SUB-02 | A new subject requires no code change or deployment | Critical | 3 | SUB-01, ACA-03 | subjects, courses | Partial (existing) — not started | Scenario §20: new subject → topic → course → resource visible to an entitled student, no code change |
| SUB-03 | Topics per subject: add, rename, reorder, deactivate, archive | Critical | 3 | SUB-01 | Topic | Partial (existing) — not started | Topics added, renamed, reordered, archived; Math topics backfilled |
| SUB-04 | Hierarchy Subject → Topic → Course/Programme → Resources and Assessments; subjects may differ | Critical | 3 | SUB-03, Q3 | Course.topicId | Partial (existing) — not started | Hierarchy returned by API; subjects without topics still work |
| SUB-05 | Control which subjects are available to student levels, countries or programmes | High | 3 | INT-01/03, ADR-006 | SubjectAvailability | Not started | Student outside availability rules cannot list or open the subject |
| SUB-06 | Coaches assigned to subjects, courses and academic groups by admins | High | 3 | PERM-04 | permission scopes, mentor-assignments | Partial (existing) — not started | Coach scoped to a subject sees only that subject |
| SUB-07 | Existing Mathematics data and relationships preserved | Critical | 3 | DATABASE_CHANGE_PLAN §6 | migrations | Needs decision | Scenario §20: all Math courses/assignments/resources/submissions/results keep IDs and counts after migration (rehearsed on production copy) |
| ACA-01 | Manage academic years | High | — | Q15 | academic-years | Done (existing) — regression | Regression: academic-years e2e green (frontend page later) |
| ACA-02 | Junior and Senior divisions keep working; flexible levels evaluated | High | 2 | INT-03, ADR-005 | Division, DivisionGradeLevel | Partial (existing) — not started | JUNIOR/SENIOR behave as before; mapping comes from data |
| ACA-03 | Manage course availability, assign coaches, control enrollment | High | 3 | SUB-01, ADR-006 | admin courses API | Partial (existing) — not started | Admin creates a course (default ENROLLMENT_REQUIRED) and manages availability |
| ACA-04 | Coach assignments | High | — | — | mentor-assignments | Done (existing) — regression | Regression: mentor assignment e2e green |
| ACA-05 | Course enrollment separate from registration; restricted materials need access | Critical | 6 | ADR-006 | courses, enrollments | Not started | Existing courses unchanged; new courses need enrollment; widening access needs confirmation and is audited |
| ACC-01 | Search and filter users | High | 4 | ACC-12, REG-01, INT-01 | users list | Done (existing) — regression | New filters (status, TEACHER, country, subject) return correct rows |
| ACC-02 | View complete user profiles | High | 4 | ACC-16 | users detail | Done (existing) — regression | New fields present; sensitive fields masked without permission |
| ACC-03 | Edit permitted user information | High | 4 | ACC-16 | users update | Done (existing) — regression | Field-level permission checks; audit diff |
| ACC-04 | Approve or reject applications | High | 5 | REG-10 | registration review | Partial (existing) — not started | See REG-10 |
| ACC-05 | Invite users | High | 5 | REG-01 | invite, import | Done (existing) — regression | Teacher invitations; new fields in import |
| ACC-06 | Suspend and reactivate | High | 4 | ACC-12 | users status | Done (existing) — regression | Suspend/reactivate map to SUSPENDED/ACTIVE; tokens revoked |
| ACC-07 | Change user permissions where authorized | Critical | 1 | PERM-03..06, ADR-004 (amended) | role changes, permission overrides | Partial (existing) — not started | Role changes follow the per-actor allow-list; Super Admin grants/revokes individual overrides within the approved list; escalation refused; audited (assigning custom profiles deferred with PERM-02) |
| ACC-08 | Reset accounts, resend activation | High | — | — | auth, users | Done (existing) — regression | Regression: reset/resend e2e green |
| ACC-09 | Bulk operations | Medium | 4 | ACC-12 | users bulk | Partial (existing) — not started | Per-row results; partial failures reported; each change audited |
| ACC-10 | Import and export users | Medium | 4 | REG-12 | users import/export | Partial (existing) — not started | Round trip export → import dry run passes |
| ACC-11 | View user activity and account history | Medium | 4 | REG-13 | activity, audit | Done (existing) — regression | History endpoint combines audit and activity for one user |
| ACC-12 | Explicit account states: Pending Verification, Pending Approval, Active, Suspended, Rejected, Archived, with defined transitions | Critical | 4 | ADR-008 | User.status, transitions, login | Partial (existing) — not started | Backfill counts equal old-flag counts; every allowed/forbidden transition tested; login blocked per state |
| ACC-13 | Soft deletion and restoration | High | 4 | ACC-12 | users delete/restore | Not started | DELETE archives; restore returns to previous state; archived hidden from lists by default |
| ACC-14 | Permanent deletion restricted by retention/privacy rules | Medium | 4/10 | ACC-13, Q16 | users purge, retention | Partial (existing) — not started | Purge only for archived accounts after retention, with users.purge; anonymises personal data |
| ACC-15 | Users update profile picture, contact details, country/location, school, academic info, interests | Medium | 4 | INT-01, SUB-01, Q17 | PATCH /me, avatar | Partial (existing) — not started | User updates allowed fields; restricted ones follow approval rule |
| ACC-16 | Sensitive information access restrictions | Critical | 4 | PERM-03 | serialisers, audit | Done (existing) — regression | Sensitive fields masked by default; reads with users.viewSensitive audited |
| PERM-01 | Five concepts: user type, organisational role, permission profile, individual permissions, scope | Critical | 1 | ADR-004 (amended), Q5 | permissions module | Partial (existing) — not started | User type, role-based defaults, overrides and scope resolvable for any user; organisational role deferred (Q5/D5, approved); custom profiles deferred (PERM-02) |
| PERM-02 | Reusable permission profiles created by administrators | Critical | later (was 1) | ADR-004 (amended) | PermissionProfile tables, seed | **Deferred (approved scope change 2026-11-09, D3)** — Phase 1 delivers fixed role-based defaults + Super-Admin overrides instead ([ADR-004 amendment](ARCHITECTURE_DECISIONS.md), [Phase 1 plan](docs/PHASE-1-PLAN.md) §6) | When implemented: profiles reproduce the role defaults exactly (unit + e2e equivalence). Phase 1 meanwhile: role defaults equal today's ROLE_PERMISSIONS for STUDENT, COACH, ADMIN |
| PERM-03 | Granular permissions by functional area | Critical | 1 | ADR-004 (amended) | @RequirePermission guard | Partial (existing) — not started | Every route declares its access; permission guard and @Roles agree on every route for STUDENT, COACH and ADMIN (generated equivalence) |
| PERM-04 | Scope restrictions (country, school, subject, course, division, group, assigned support requests) | Critical | 1 | ADR-004, ADR-018 | scope resolution, AccessService | Partial (existing) — not started | Phase 1: tests for own, division, course × division and programme scopes (Head Coach isolation, plan §11.5); country, school, group and support scopes tested in their phases |
| PERM-05 | Default-deny, backend enforcement, no reliance on UI | Critical | — | — | guards, security suite | Done (existing) — regression | Regression: security e2e green; new routes covered by generated matrix |
| PERM-06 | Prevent privilege escalation; admins cannot grant beyond their own authority | Critical | 1 | ADR-004, ADR-019 | role allow-list, override service | Not started | Role assignment outside the allow-list → ROLE_NOT_ASSIGNABLE; override outside the approved list → OVERRIDE_NOT_ALLOWED; no self-changes; last Super Admin protected; Head Coach cannot cross programmes |
| PERM-07 | Record sensitive permission changes in the audit log | High | 1 | AUD-02 | audit | Partial (existing) — not started | Every override and role change audited with previous and new values in the same transaction; override expiry recorded; every state-changing ADMIN/SUPER_ADMIN request audited without request bodies |
| PERM-08 | Compatible with the existing authentication | Critical | 1 | ADR-004 | auth (unchanged) | Needs decision | Login/refresh/logout e2e unchanged; permission change effective without re-login |
| PUB-01 | Consistent workflow Draft → Pending Approval → Published, plus Changes Requested, Rejected, Archived, Unpublished | High | 7 | ADR-011, Q7 | resources status, approvals queue | Partial (existing) — not started | Teacher cannot publish; coach behaviour as seeded; states and transitions enforced |
| PUB-02 | Transitions depend on permissions | High | 7 | PERM-03 | workflow transitions | Partial (existing) — not started | Each transition denied without its permission |
| PUB-03 | Editing published content creates a revision; published version stays until the revision is approved | High | 7 | ADR-010 | ResourceRevision | Not started | Scenario §20: pending revision never replaces the published version |
| PUB-04 | Version history with who created, edited, reviewed and approved each version | High | 7 | PUB-03 | revision events | Partial (existing) — not started | History shows creator, editor, reviewer, approver per version |
| SUP-01 | Students submit requests in categories (recommendation letters, certificates, coach meetings, academic, technical, general, admin-configured) | High | 8 | ADR-012 | support module, categories | Not started | Student submits in an active category; contact form unchanged |
| SUP-02 | Subject, description, attachments, unique reference number, status tracking, responses, notifications | High | 8 | SUP-01, storage | requests, messages, attachments | Not started | Reference number unique and returned; student tracks status and sees responses; notified on change |
| SUP-03 | Staff: filter, assign, priority, status, request info, internal notes, respond, attach, close/reopen | High | 8 | PERM-04 | admin support API | Not started | Assign, priority, status, info request, respond, close/reopen; scoped staff see only assigned |
| SUP-04 | Suggested statuses; workflow configurable where practical | Medium | 8 | ADR-012 | transition table | Not started | Invalid transitions → INVALID_STATUS_TRANSITION |
| SUP-05 | Internal staff notes separated from student-visible messages | Critical | 8 | SUP-02 | message visibility | Not started | Scenario §20: internal notes absent from every student-facing response and notification |
| SUP-06 | Coach meeting requests: purpose, preferred times, assigned coach, confirmation, status, outcome | Medium | 8 | SUP-02, Q8 | SupportMeeting | Not started | Meeting never auto-confirmed; confirmation and outcome recorded |
| GRP-01 | Independent groups (e.g. IMO2026), membership independent of courses and divisions | High | 9 | ADR-013 | study-groups → groups | Partial (existing) — not started | Group membership independent of courses/divisions |
| GRP-02 | Create, edit, archive, add/remove/invite members, assign group admins/moderators, membership visibility, messaging permissions | High | 9 | GRP-01 | groups admin | Partial (existing) — not started | Create/edit/archive, members, invitations, moderators, visibility, posting policy |
| GRP-03 | Announcements, discussions, messages, replies, mentions, notifications, attachments, moderation/reporting | Medium | 9 | GRP-01, discussions | threads (groupId), announcements, mentions | Partial (existing) — not started | Announcements, discussions, replies, mentions, moderation work; no private messaging endpoint exists |
| GRP-04 | Group administrators manage only their groups | Critical | 9 | PERM-04 | group scope | Not started | Scenario §20: group admin cannot manage another group |
| GRP-05 | Targeted e-mails to groups, students, teachers, coaches, countries, schools, subjects; preview and confirmation; logged | High | 9 | ADR-014 | email service | Partial (existing) — not started | Preview required before send; new audiences; sender limited to scope; audited |
| NOT-01 | Topics: registration, resets, assignments, submissions, reviews/results, resources, publishing decisions, support, groups, announcements, mentions | High | 10 | SUP, GRP, PUB | notification types | Partial (existing) — not started | Each new event creates the right in-app notification and respects preferences |
| NOT-02 | In-app and e-mail | High | — | — | notifications, mailer | Done (existing) — regression | Regression: notifications + email-delivery e2e green |
| NOT-03 | User preferences | Medium | — | — | notification settings | Done (existing) — regression | Regression: notification-settings e2e green |
| NOT-04 | Prevent duplicate notifications | Medium | 10 | NOT-01 | Notification.dedupeKey | Partial (existing) — not started | Retried events do not create duplicates |
| NOT-05 | Handle delivery failures | High | — | — | email worker | Done (existing) — regression | Regression: retries, permanent failure, admin retry e2e green |
| NOT-06 | Delivery is not proof of reading | Low | — | Q18 | notifications | Done (existing) — regression | No read receipts for e-mail; in-app read state separate |
| ADM-01 | Admin Portal covers 20 areas | High | 1–10 | all phases | admin APIs | Partial (existing) — not started | Each of the 20 admin areas has verified APIs (tracked per phase) |
| ADM-02 | Admins see only permitted functions | Critical | 1 | PERM-03 | /me/permissions | Partial (existing) — not started | Response lists effective permissions and scopes for all six user types; old fields kept |
| UX-01 | Modern login/registration visuals; preserve authentication | Medium | FE | frontend | frontend only | Frontend only | Auth endpoints unchanged (regression) |
| STU-01 | Student experience: subjects, authorized courses, topics, assignments, results, leaderboards, groups, notifications, support | High | 3–9 | SUB, ADR-006, SUP, GRP | student APIs | Partial (existing) — not started | Student journeys extended per phase pass end to end |
| TCH-01 | Teacher and coach dashboards scoped to assignments | High | 1 (D1, approved) / 5 | ADR-003 (amended), REG-01, PERM-04 | teacher/coach scopes | Partial (existing) — not started | Teacher sees only assigned course × division content (school scope deferred); no grading or approval rights by default; coach dashboards unchanged |
| SEC-01 | Secure passwords, sessions, backend authorization, validation, rate limiting, file access, upload validation, common web protections, env handling | Critical | — | Q19 | auth, guards, uploads | Done (existing) — regression | Regression: security e2e green |
| SEC-02 | Backup and recovery procedures | High | 0 | ADR-015 | Neon, docs | Partial (existing) — not started | Restore drill completed and documented |
| SEC-03 | Protection of minors: restrict student/guardian contact data, restrict private communication, moderation, record access to sensitive data, data minimisation | Critical | 4/5 | ACC-16, REG-02 | masking, audit | Partial (existing) — not started | Guardian data masked; sensitive reads audited; no private messaging |
| SEC-04 | Data retention, correction, export, deletion | High | 10 | ACC-13/14, Q16 | data export, retention | Partial (existing) — not started | Per-user export complete; retention jobs cover new data |
| SEC-05 | No sensitive data in URLs, public responses, e-mail logs or audit records | High | all | — | serialisers, audit, mailer | Done (existing) — regression | No sensitive data in URLs, public responses, e-mail logs or audit (tests per phase) |
| SEC-06 | Safe migrations | Critical | 0 | ADR-015 | CI, migrations | Partial (existing) — not started | Naming CI check active; rollback per migration; rehearsal done |
| ARC-01 | Separate apps, documented contracts, consistent errors | High | — | — | OpenAPI, errors | Done (existing) — regression | Regression: API docs check in CI |
| ARC-02 | Validation, pagination, transactions | High | — | — | validation, pagination | Done (existing) — regression | Regression |
| ARC-03 | Safe, reversible migrations preserving records | Critical | 0 | ADR-015 | migrations | Partial (existing) — not started | Expand–contract followed; rollback scripts present |
| ARC-04 | Environment separation dev/staging/prod; no unnecessary paid services | Medium | 0 | ADR-016 | staging | Partial (existing) — not started | Staging environment reachable with rehearsed migrations |
| AUD-01 | Important actions logged with actor, action, resource, timestamp | High | — | — | audit | Done (existing) — regression | Regression: settings-audit e2e green |
| AUD-02 | Previous and new values without secrets | Medium | 10 | — | audit diff helper | Partial (existing) — not started | Updates in all modules record previous/new values without secrets |
| AUD-03 | Not editable by ordinary users | High | — | — | audit trigger | Done (existing) — regression | Regression: append-only trigger test |
| AUD-04 | Coverage for new areas (subjects, permissions, support, groups, exports) | High | 1–10 | per phase | audit categories | Partial (existing) — not started | Each new action audited (tests per phase) |
| PERF-01 | Large datasets, efficient queries, pagination | High | — | — | queries, indexes | Done (existing) — regression | Regression; new lists paginated and indexed |
| PERF-02 | Large file uploads handled safely | Medium | 10 | R2 verified | upload pipeline | Partial (existing) — not started | Concurrent large uploads stay within memory limits (load test) |
| PERF-03 | Responsive, accessible UI | Medium | FE | frontend | frontend only | Frontend only | Frontend checklist |

## Totals

| Status | Count |
|---|---|
| Partial (existing) — not started | 52 |
| Done (existing) — regression | 25 |
| Not started | 20 |
| Needs decision | 2 |
| Frontend only | 2 |
| Deferred (approved scope change) | 1 |
| **Total** | **102** |

## Update rules

- Update a row in the same pull request that changes its implementation; link the PR.
- Move to **Verified** only with the test evidence named in the criteria (test file and run).
- Re-run every "Done (existing) — regression" check at the end of each phase.

