# Requirements-to-implementation matrix (2026-11-17)

Source of the requirements: `ROF_LMS_CONSOLIDATED_REQUIREMENTS.md` and the 102 IDs of `BACKEND_REQUIREMENTS_AUDIT.md` /
`IMPLEMENTATION_TRACKER.md` (the tracker's status column is stale by the owner's instruction — this matrix replaces it),
with the owner decisions in `ARCHITECTURE_DECISIONS.md` and `docs/PHASE-1-PLAN.md`.

Evidence = backend `develop` `e15813e` + open branches, frontend `develop` `504d447` + open branches, production
read-only checks. "Released" = running on production today.

**Status:** ✅ Complete (code + tests) · 🟡 Partial · ❌ Missing · ⏸ Deferred by an owner decision · 🔒 Complete but
gated (flag / release).

## Summary

| | Count |
|---|---|
| ✅ Complete | 49 |
| 🔒 Complete, gated by flags / release | 2 |
| 🟡 Partial | 29 |
| ❌ Missing | 21 |
| ⏸ Deferred (owner decision) | 1 |
| **Total** | **102** |

The missing and partial items are concentrated in the **later phases of the approved plan** (2 countries/grades,
3 subjects/topics, 6 course access, 7 publishing/versioning, 8 student support, 9 groups/targeted e-mail,
10 privacy). Each of those phases starts with a design the owner approves (working rule since 2026-11-08); none has
been started. Phase 1 (permissions and the six roles) is complete; Phases 4–5 (account lifecycle, registration by
user type) are mostly complete.

## Teacher and Head Coach — full workflow verification

| Workflow | Backend (develop) | Frontend (develop + branches) | Tests | Production |
|---|---|---|---|---|
| **Teacher** registration (public form, school by Province → District → Sector → School or "not listed", phone, country, interests) | `/auth/register/teacher` (+ availability), `TeacherApplication`, one PENDING per username/e-mail | `/register/teacher` | e2e `teacher-registration` (20), frontend `teacher-registration.test` | 🔒 not released; needs `TEACHERS_ENABLED=true` and the form opened |
| Teacher application review: approve (creates the TEACHER account, activation e-mail), reject with reason, verify a "not listed" school | `/admin/teacher-applications/*` (users.manageTeachers) | `/admin/teacher-applications` | e2e `teacher-registration`, `decision-notifications` (24) | 🔒 |
| Teacher school assignments (Administrators), delegated permissions (view profile / progress, submit on behalf) by Administrators and Super Admins | `/admin/teacher-assignments`, `/admin/teachers/:id/delegations` | user page → TeacherAccessCard | e2e `teachers` (16), `permission-overrides` (13) | 🔒 |
| Teacher portal: students of assigned schools only (name, school, grade, division — never grades or contacts); profile / progress / submit on behalf only with a delegation | `/teacher/students*` | `/teacher/dashboard`, `/teacher/students/:id` | e2e `teachers` (school isolation, D7), frontend `on-behalf.test` | 🔒 |
| Teacher account management (suspend, archive, restore, role change, bulk) | account states, bulk operations | user page, Users bulk actions (branch) | e2e `account-states`, `bulk-operations*` | 🔒 release |
| Teacher notifications: decision e-mails (approved / school verified / permissions granted); no switchable types | NotificationOutbox | delivery log (admins) | e2e `decision-notifications`, `role-notification-settings` (branch) | 🔒 |
| **Head Coach** appointment (Administrators set programme heads) | `PUT /admin/programmes/:id/heads` (programmes.manageHeads) | user page → ProgrammeHeadsCard, `/admin/programmes` | e2e `head-coach-programme` (13) | 🔒 needs `HEAD_COACHES_ENABLED=true` |
| Head Coach programme: members (add / end students and coaches), invite coaches (Administrator approval required) | `/admin/programmes/:id/members`, `…/student-candidates`, `…/coach-invitations` | `/mentor/programme` (overview, members, invite) | e2e `head-coach-programme`, `programme-membership` (15) | 🔒 |
| Head Coach course access for coaches (course × division in the programme) | `/admin/mentor-assignments` (programme-scoped) | `/mentor/programme` → coach course access | e2e `head-coach-programme` | 🔒 |
| Head Coach monitoring: dashboard, students / coaches reports, participation, activity (no contact data, no grades beyond the programme) | `/admin/dashboard`, `/admin/reports/*`, `/admin/activity` (programme scope) | `/mentor/programme` monitor / activity / courses | e2e `head-coach-monitoring` (7) | 🔒 |
| Head Coach course work (prepare / grade only via an Administrator-created assignment, H4) | `assertMentorOf`, grading distribution over COURSE_WORK_ROLES | coach portal (assignments, reviews) | e2e `head-coach-course-work` (7) | 🔒 |
| Head Coach notifications | **fixed on `fix/role-notification-settings`**: switches for HEAD_COACH (were 403), "new discussion" notices now include assigned Head Coaches | My Profile switches (branch `feat/account-history-head-coach-settings`) | e2e `role-notification-settings` (5, new) | 🔒 |
| Separation: Teacher ≠ Coach ≠ Head Coach ≠ Admin ≠ Super Admin | permission catalogue, guard matrix for every handler, unknown-role least privilege, role allow-list, step-up for admin roles, last-Super-Admin trigger | portal per role, permission-driven menus | `route-declarations.spec` (six-role guard matrix), e2e `route-permissions`, `role-allowlist`, `unknown-role`, `super-admin` (14), `coach-role-change` | Phase 1 released |

**Not covered end to end:** no browser (UI) end-to-end suite exists in the frontend (its 376 tests are unit tests of
the pages' rules). The API workflows above are covered end to end by the backend e2e suites against PostgreSQL in CI.

## Matrix

| ID | Requirement | Status | Evidence / what is missing |
|---|---|---|---|
| REG-01 | Student, Teacher, Coach user types (+ Admin) | 🔒 | six roles (M1); Teacher/Head Coach behind flags |
| REG-02 | Student registration fields | 🟡 | done: DOB (**required at registration**, owner 2026-11-17, backend cf964dc), phone, guardian phone, home country/place, school, grade, interests; missing: profile picture **at sign-up** (available after), country-specific grades (P1–P6), current academic year field, subjects from a dynamic list |
| REG-03 | School / grade options adapt to country | 🟡 | schools carry `countryCode`; directory and grades are Rwanda / S1–S6 only |
| REG-04 | Registration ≠ enrollment | 🟡 | students get their division's courses; per-course enrollment (ENROLLMENT_REQUIRED) is Phase 6 |
| REG-05 | Teacher registration fields | ✅ | names, username, e-mail, phone, country, school, interests, **position and years of experience** (backend `feat/applications-complete` 9364827, frontend ef9bfe5; e2e application-info-requests) |
| REG-06 | Coach registration fields | ✅ | country, occupation, education, interests, **phone, affiliation, expertise, relevant experience, years** (same branches) |
| REG-07 | Coaches verified and approved | ✅ | mentor requests; Head-Coach-invited coaches need Administrator approval |
| REG-08 | Enable/disable registration per type | ✅ | form availability (backend #57); Forms page (frontend branch) |
| REG-09 | Configure mandatory/optional fields | ❌ | not started |
| REG-10 | Review, approve, reject with reason, request more information | ✅ | approve / reject with an e-mailed reason (Teacher and Coach); **request more information** with a one-time answer link, corrections, history (same branches; e2e 8 cases on PostgreSQL) |
| REG-11 | Resend activation, suspend/reactivate, bulk import | ✅ | |
| REG-12 | Export user records | ✅ | bulk export CSV (branch), report CSVs |
| REG-13 | Registration history | 🟡 | account history (branch), audit log; no per-user registration timeline |
| REG-14 | Prevent duplicate accounts | ✅ | unique username / e-mail; one PENDING application |
| INT-01 | Manage countries | ❌ | ISO codes only |
| INT-02 | Region / province / district / locality | 🟡 | Rwanda hierarchy only |
| INT-03 | Education systems and grades per country | ❌ | fixed S1–S6 |
| INT-04 | Schools with country, location, type | ✅ | M8/M11/M12 |
| INT-05 | Add, edit, activate/deactivate schools | ✅ | PR B |
| INT-06 | School administrators or contacts | 🟡 | contacts ✅; school administrator accounts ❌ |
| INT-07 | Students and teachers of a school | 🟡 | students ✅; teachers per school not listed on the school page |
| INT-08 | Bulk import schools | ✅ | |
| INT-09 | Avoid duplicate schools | ✅ | 409 possible duplicate |
| SUB-01 | Admins manage subjects | ❌ | `Discipline` has MATHEMATICS only; no admin CRUD (Phase 3) |
| SUB-02 | New subject without code change | ❌ | Phase 3 |
| SUB-03 | Topics per subject | ❌ | Phase 3 |
| SUB-04 | Subject → Topic → Course hierarchy | ❌ | Phase 3 |
| SUB-05 | Subject availability per level / country / programme | ❌ | Phase 3 |
| SUB-06 | Coaches assigned to subjects / courses / groups | 🟡 | course × division assignments ✅; subjects / groups ❌ |
| SUB-07 | Existing Mathematics data preserved | ✅ | membership backfill (M3) |
| ACA-01 | Academic years | ✅ | |
| ACA-02 | Junior / Senior divisions; flexible levels | 🟡 | divisions ✅; flexible levels not evaluated |
| ACA-03 | Course availability, coaches, enrollment control | 🟡 | publish/unpublish/archive ✅, coaches ✅; enrollment control (Phase 6) ❌ |
| ACA-04 | Coach assignments | ✅ | |
| ACA-05 | Course enrollment separate; restricted materials | ❌ | Phase 6 |
| ACC-01 | Search and filter users | ✅ | |
| ACC-02 | Complete user profiles | ✅ | |
| ACC-03 | Edit permitted information | ✅ | |
| ACC-04 | Approve / reject applications | ✅ | |
| ACC-05 | Invite users | ✅ | |
| ACC-06 | Suspend and reactivate | ✅ | |
| ACC-07 | Change permissions where authorized | ✅ | Super Admin overrides (P1-09) |
| ACC-08 | Reset accounts, resend activation | ✅ | |
| ACC-09 | Bulk operations | ✅ | backend #59; frontend branch |
| ACC-10 | Import and export users | ✅ | |
| ACC-11 | Activity and account history | ✅ | activity log; account history card (branch) |
| ACC-12 | Explicit account states incl. Pending Verification / Approval / Rejected | 🟡 | ACTIVE / DEACTIVATED / SUSPENDED / ARCHIVED stored; pending verification / approval derived (activatedAt, isApproved); "Rejected" exists for applications only |
| ACC-13 | Soft deletion and restoration | ✅ | archive / restore |
| ACC-14 | Permanent deletion restricted | 🟡 | permanent deletion disabled; retention-rule deletion (Phase 10) ❌ |
| ACC-15 | Users update picture, contact, location, school, interests | ✅ | profile, avatar, school claim |
| ACC-16 | Sensitive information restrictions | 🟡 | teachers / Head Coaches never get contact data; a field-level masking policy for guardian phones is not specified |
| PERM-01 | Type, organisational role, profile, permissions, scope | 🟡 | type, role defaults, overrides, scopes ✅; organisational role (D5) and profiles ⏸ |
| PERM-02 | Reusable permission profiles | ⏸ | deferred (owner, ADR) |
| PERM-03 | Granular permissions | ✅ | catalogue |
| PERM-04 | Scope restrictions | 🟡 | school, programme, course × division ✅; country, group, support request ❌ (their features do not exist) |
| PERM-05 | Default deny, backend enforcement | ✅ | |
| PERM-06 | No privilege escalation | ✅ | |
| PERM-07 | Audit sensitive permission changes | ✅ | |
| PERM-08 | Compatible with existing auth | ✅ | |
| PUB-01 | Draft → Pending → Published (+ changes requested, rejected, archived) | 🟡 | assignments have DRAFT / PENDING_APPROVAL / PUBLISHED / REJECTED; courses and resources only publish / unpublish / archive |
| PUB-02 | Transitions by permission | 🟡 | assignments.publish, courses.manage, resources.manage |
| PUB-03 | Revisions of published content | ❌ | Phase 7 |
| PUB-04 | Version history | 🟡 | assignment events only |
| SUP-01 | Student support requests | ❌ | Phase 8 (only the public contact form and support page exist) |
| SUP-02 | Reference, status tracking, responses | ❌ | Phase 8 |
| SUP-03 | Staff handling | ❌ | Phase 8 |
| SUP-04 | Configurable statuses | ❌ | Phase 8 |
| SUP-05 | Internal notes | ❌ | Phase 8 |
| SUP-06 | Coach meeting requests | ❌ | Phase 8 |
| GRP-01 | Independent groups (e.g. IMO2026) | ❌ | the old study-groups module was switched off on 2026-11-03 ("no separate study groups"); Phase 9 |
| GRP-02 | Group management | ❌ | Phase 9 |
| GRP-03 | Group communication | ❌ | Phase 9 |
| GRP-04 | Group administrators | ❌ | Phase 9 |
| GRP-05 | Targeted e-mails (groups, roles, countries, schools, subjects) | 🟡 | bulk e-mail to chosen users / filters and the bulk "message" action; no saved segments by country / school / subject |
| NOT-01 | Notification topics | 🟡 | accounts, assignments, submissions, reviews, results, discussions, decisions ✅; support and publishing topics ❌ (features missing) |
| NOT-02 | In-app and e-mail | ✅ | |
| NOT-03 | User preferences | ✅ | Head Coach / Super Admin switches fixed on branch |
| NOT-04 | No duplicate notifications | ✅ | outbox dedupe key |
| NOT-05 | Delivery failures | ✅ | retries, delivery log |
| NOT-06 | Delivery ≠ read | ✅ | |
| ADM-01 | Admin portal covers 20 areas | 🟡 | areas of the missing phases absent |
| ADM-02 | Admins see only permitted functions | ✅ | permission-driven menus |
| UX-01 | Modern login / registration | ✅ | auth redesign (frontend develop, not released) |
| STU-01 | Student experience | 🟡 | courses, assignments, results, leaderboard ✅; subjects / topics / groups / support ❌ |
| TCH-01 | Teacher and coach dashboards scoped | 🔒 | teacher portal, coach and Head Coach portals |
| SEC-01 | Passwords, sessions, authorization, validation, rate limits, files | ✅ | |
| SEC-02 | Backup and recovery | 🟡 | backups exist; **a restore has never been drilled** (plan §2–3) |
| SEC-03 | Protection of minors | 🟡 | no private 1:1 messaging; contact data restricted; guardian consent not implemented |
| SEC-04 | Retention, correction, export, deletion | ❌ | only activity-log retention (400 days); no personal data export / erasure (Phase 10) |
| SEC-05 | No sensitive data in URLs / public responses / logs | ✅ | by design and review; no automated scan |
| SEC-06 | Safe migrations | ✅ | rehearsal kits, rollbacks with data guards |
| ARC-01 | Separate apps, contracts, errors | ✅ | |
| ARC-02 | Validation, pagination, transactions | ✅ | |
| ARC-03 | Reversible migrations | ✅ | |
| ARC-04 | Dev / staging / prod separation | 🟡 | no staging environment (P0-08) |
| AUD-01 | Important actions logged | ✅ | |
| AUD-02 | Previous and new values | 🟡 | many actions record from/to; not all |
| AUD-03 | Not editable | ✅ | append-only trigger |
| AUD-04 | Coverage for new areas | 🟡 | permissions, exports ✅; subjects / support / groups do not exist |
| PERF-01 | Large datasets, pagination | ✅ | |
| PERF-02 | Large uploads | 🟡 | size limits, direct-to-origin uploads; no resumable upload |
| PERF-03 | Responsive, accessible UI | 🟡 | responsive; no accessibility audit |

## Fixed in this review (open branches)

| Gap | Branch | Commit |
|---|---|---|
| Form availability had no administrator screen | frontend `feat/admin-form-availability` | `61c32c7` |
| Bulk user operations had no screen; the frontend did not know `bulkUserOperations` | frontend `feat/admin-bulk-user-operations` | `0e1bcef`, `40cfc8e` |
| Account status history had no screen | frontend `feat/account-history-head-coach-settings` | `1dbdf89` |
| Head Coaches could not open notification settings (403); Super Admins saw no switches; "new discussion" skipped Head Coaches | backend `fix/role-notification-settings`; frontend `feat/account-history-head-coach-settings` | `a4016d3`, `1dbdf89` |
| Frontend `develop` → `main` conflicted (backport only on main) | frontend `chore/sync-main-into-develop` | `6af113b` |

## Proposed order for the remaining agreed scope (each starts with an owner-approved design)

1. **Registration completeness (Phase 5 remainder, small):** teacher position and years of experience; coach phone,
   affiliation, expertise, experience; "request more information" for applications; profile picture at sign-up.
2. **Phase 6 course access:** ENROLLMENT_REQUIRED courses, enrollment management (REG-04, ACA-03, ACA-05).
3. **Phase 3 subjects and topics:** dynamic subjects, topics, hierarchy, availability, coach assignment (SUB-01…06).
4. **Phase 2 countries and education systems** (INT-01…03, REG-03).
5. **Phase 8 student support portal** (SUP-01…06).
6. **Phase 9 groups and targeted e-mail** (GRP-01…05).
7. **Phase 7 publishing and versioning** (PUB-01…04).
8. **Phase 10 privacy:** retention, personal data export / erasure (SEC-04, ACC-14).
9. Cross-cutting: a staging environment (ARC-04) and a browser end-to-end suite for the frontend.
