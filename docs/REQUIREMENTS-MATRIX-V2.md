# Requirements matrix v2 — authoritative (2026-11-18)

Written for: the owner, to see in one place what is complete, what is not, and why.

Replaces `REQUIREMENTS-MATRIX.md` (2026-11-17) as the single matrix. Sources: `ROF_LMS_CONSOLIDATED_REQUIREMENTS.md` (102
IDs), ADR-001…019, the Phase 1 decisions, the owner decisions recorded in `PROGRESS.md` (including TS-1…TS-6), and the code on
the development branches listed in `PROGRESS.md` (none merged, nothing released by this work).

**Rule applied:** a requirement is "Complete and verified" only when its whole workflow works — screen, backend, permissions,
database — and has test evidence (backend e2e on PostgreSQL, frontend tests, and a browser test where the workflow is mainly a
screen). A workflow that works and has backend and frontend tests but no browser test is "Implemented, not fully tested".
Development branches are not released: "complete" here means complete in development, ready for review and release.

## Summary

| Status | Count |
|---|---|
| 1 Complete and verified | 63 |
| 2 Implemented, not fully tested | 0 |
| 3 Partially implemented | 11 |
| 4 Missing | 0 |
| 5 Awaiting design approval | 25 |
| 6 Excluded (owner) | 0 |
| 7 Deferred (owner) | 1 |
| 8 Blocked (external) | 2 |
| **Total** | **102** |

Every "Awaiting design approval" item has a proposal in `DESIGN-PROPOSALS-V2.md` (11 sections each). "Blocked" items need an
owner action outside the code: a fresh Neon branch for the restore drill (SEC-02) and staging resources (ARC-04).

Update 2026-11-18 (owner approved `DECISIONS-FOR-REVIEW.md` §1, SR-1, SR-2): ACC-12 moves from 5 to 1 (four stored states
+ two derived approved as built); REG-02, SEC-03 and TCH-01 rows record 9.2, 9.3 and SR-1 below.

Update 2026-11-18 (integration on `develop`, all 14 PRs merged): browser tests added for the ten "Implemented, not fully
tested" rows (now 1) and an automated accessibility audit for PERF-03 (now 1). The 14 "Partially implemented" rows lack only
parts that depend on the 28 "Awaiting design approval" areas (subjects, groups, support, countries, flexible levels, enrolment
control, school-administrator accounts) or on legal advice (guardian consent, 8.3). SEC-05 gained an automated scan (now 1).

Update 2026-11-19 (owner decisions on area 1, countries; branch `feat/area1-countries`): ROF LMS is a global Olympiad
platform with one common structure for every country — grades S1–S6, S1–S3 Junior and S4–S6 Senior, exactly as today; a
student's country never determines their level or division, and no restriction may prevent international registration.
Country data only identifies where a student, teacher, coach or school is. Rwanda keeps its Province → District → Sector →
School directory and registration flow; other countries record the country and a typed school name. Built: the Country
reference list (every ISO 3166-1 alpha-2 code, name, calling code; no active switch), an Administrator Countries screen
(correct name and calling code; reference.manage; audited), country lists from it in every form and on the Schools list,
and School.countryCode → Country. Not built, by decision: per-country education systems, grades, regions, P1–P6.
INT-01 (5 → 1) and INT-02 (3 → 1) are complete; INT-03 (5 → 1), REG-03 (5 → 1) and ACA-02 (3 → 1) are satisfied by the
decision of one common structure.

## Matrix

| ID | Requirement | Original decision | Roles | Frontend | Backend | Database | Permissions / security | Tests / evidence | Status |
|---|---|---|---|---|---|---|---|---|---|
| REG-01 | Student, Teacher, Coach user types (+ Head Coach, Admin, Super Admin) | Phase 1 / ADR-001; six roles | all | portal per role (`app/student`, `teacher`, `mentor`, `admin`) | role enum, permission catalogue (`src/auth/permissions.ts`) | Role enum (M1) | least privilege per role; Teacher / Head Coach behind TEACHERS_ENABLED / HEAD_COACHES_ENABLED (off in production) | route-declarations, role-route sweep (7 callers × 315 routes), e2e role-allowlist / unknown-role; Playwright role-journeys (every portal) | 1 Complete and verified |
| REG-02 | Student registration fields | consolidated req.; DOB required (owner 2026-11-17); picture OPTIONAL (owner 2026-11-18) | Student | `/register` (DOB, phones, home place, school cascade, interests, optional picture) | `POST /auth/register/student`, `PUT /auth/register/avatar` (one-time token) | `dateOfBirth`, phones, home place (M-registration_details); application `avatarFileId` (20261209000000) | public, throttled; picture token HMAC 30 min; contact data never in lists | e2e registration-avatar (6), student registration; frontend tests registration-avatar (4). **9.2 (2026-11-18):** guardian phone required by the server — e2e registration-details (missing / null / empty / blank / malformed / invalid refused). **9.3:** staff-created, invited and imported students give their DOB at first sign-in (`PUT /me/date-of-birth`, DateOfBirthGuard) — e2e date-of-birth-step, frontend unit, Playwright date-of-birth-step. No browser test of the sign-up form yet **Browser (2026-11-18, develop):** Playwright registration-forms — student sign-up without and with the optional picture (account stored with DOB, guardian phone, interests; picture attached only when given). | 1 Complete and verified |
| REG-03 | School / grade options adapt to country | ADR-005; owner decision 2026-11-19: one common Olympiad structure for every country | Student, Teacher | school entry follows the country: Rwanda → Province / District / Sector / School (unchanged); any other country → country + typed school name (unchanged); country lists from the reference table | grades S1–S6 and divisions common to every country (unchanged); no country blocked | School.countryCode → Country | — | existing registration e2e (auth, registration-details, school-claims); backend e2e countries-reference (17 with app: public list, admin list / search / correction audited with previous and new values, reference.manage refused to Coach, Head Coach, Teacher, Student and anonymous, registration from any country unchanged, School → Country foreign key, rollback refusal); unit reference-data, release kit areas-2026; frontend tests countries; **Browser:** Playwright countries (Administrator corrects a country; students register with a school in Rwanda and abroad), accessibility audit of /admin/countries | 1 Complete and verified |
| REG-04 | Registration ≠ enrollment | ADR-006 (Phase 6) | Student, Admin | division courses only | division-based access | none yet | — | — | 5 Awaiting design approval |
| REG-05 | Teacher registration fields | consolidated req.; ADR-009 | Teacher applicant | `/register/teacher` (+ position, years of experience, optional picture) | `POST /auth/register/teacher` | TeacherApplication (+ position, yearsOfExperience, avatarFileId) | public, throttled; one PENDING per username / e-mail | e2e teacher-registration, application-info-requests; frontend teacher-registration tests **Browser:** Playwright registration-forms — teacher application submitted through the form (PENDING; no account before approval). | 1 Complete and verified |
| REG-06 | Coach registration fields | consolidated req.; ADR-009 | Coach applicant | `/apply` (country, occupation, education, interests, phone, affiliation, expertise, experience, optional picture) | `POST /mentor-requests` | MentorRequest (+ fields, avatarFileId) | public, throttled | e2e mentor requests, application-info-requests; frontend coach-application tests **Browser:** Playwright registration-forms — coach application through /apply (PENDING). | 1 Complete and verified |
| REG-07 | Coaches verified and approved | ADR-001; P1-10 invitations need Admin approval | Admin, Head Coach | Coach applications page | approve / reject (reason e-mailed) | MentorRequest | users.manageCoaches | e2e mentor requests, head-coach-programme (invitations) | 1 Complete and verified |
| REG-08 | Enable / disable registration per type | owner (form availability) | Admin | Forms page (branch `feat/admin-form-availability`) | `/admin/forms/*`, public availability | FormAvailability (20261208000000) | forms.manage | e2e form-availability; frontend closed-form tests. No browser test **Browser:** Playwright registration-forms — form closed by an Administrator shows the closed message, reopens. | 1 Complete and verified |
| REG-09 | Configure mandatory / optional fields | Q10 (open) | Admin | — | — | — | — | — | 5 Awaiting design approval |
| REG-10 | Review, approve, reject with reason, request more information | ADR-009 | Admin | application pages: request info, answer page `/applications/respond` | `…/request-info`, `POST /applications/info-requests/view` and `/answer` (token in the body, SEC-05) | ApplicationInfoRequest | users.manageTeachers / manageCoaches; one-time link | e2e application-info-requests (8), INT-07 case; frontend applications tests **Browser:** Playwright application-review — ask for information (stored, stays PENDING), reject with required reason, approve (coach account created). | 1 Complete and verified |
| REG-11 | Resend activation, suspend / reactivate, bulk import | Phase 4 | Admin | user page, import dialog | users / account-states / import routes | User, UserStatusChange | users.manage*, step-up for admin roles | e2e account-states, import, activation | 1 Complete and verified |
| REG-12 | Export user records | Phase 4 | Admin | bulk export CSV (branch), report CSVs | `POST /admin/users/bulk/export`, report exports | — | users.export; no DOB / phones in exports | e2e bulk-operations (export), reports **Browser:** Playwright admin-users — CSV export of a selection (only the selected account; no password hash). | 1 Complete and verified |
| REG-13 | Registration history (timeline) | consolidated req. | Admin | user page "Registration history" card (branch `feat/admin-user-details` 4bad525) | `GET /admin/users/:id/registration-timeline` (117be91) | none (from AuditLog / applications / claims) | users.manage; safe details only (no contact data) | e2e registration-timeline (3); frontend tests (3); Playwright role-journeys (card) | 1 Complete and verified |
| REG-14 | Prevent duplicate accounts | Phase 4 | all | form errors | unique username / e-mail; one PENDING application | unique indexes | — | e2e registration, teacher-registration | 1 Complete and verified |
| INT-01 | Manage countries | ADR-005; owner decision 2026-11-19: one common Olympiad structure for every country | Admin | Countries screen (search; correct name and calling code); country lists in student registration, teacher and coach applications and the Schools list (column and filter) | `GET /countries`, `GET` / `PATCH /admin/countries…` | Country (all 249 ISO 3166-1 alpha-2 codes, name, calling code; no active switch — no country is ever blocked); School.countryCode → Country foreign key | reference.manage (Administrator, Super Admin); audited (COUNTRY_UPDATED) | backend e2e countries-reference (17 with app: public list, admin list / search / correction audited with previous and new values, reference.manage refused to Coach, Head Coach, Teacher, Student and anonymous, registration from any country unchanged, School → Country foreign key, rollback refusal); unit reference-data, release kit areas-2026; frontend tests countries; **Browser:** Playwright countries (Administrator corrects a country; students register with a school in Rwanda and abroad), accessibility audit of /admin/countries | 1 Complete and verified |
| INT-02 | Region / province / district / locality | ADR-005; owner decision 2026-11-19: one common Olympiad structure for every country — only Rwanda needs a geographic hierarchy; other countries record the country and the school's name | Admin | Rwanda cascade | Rwanda hierarchy (school directory); other countries: country + school name (as before) | Place tables (Rwanda) | — | e2e school-directory, registration-details (school abroad); Playwright countries | 1 Complete and verified |
| INT-03 | Education systems and grades per country | ADR-005; owner decision 2026-11-19: one common Olympiad structure for every country — no per-country education systems: S1–S6 for everyone | Admin | grade S1–S6 at registration and in administration (unchanged) | S1–S6 enum (unchanged) | GradeLevel | — | existing registration and division e2e | 1 Complete and verified |
| INT-04 | Schools with country, location, type | Phase 1 (M8/M11/M12) | Admin | school directory | `/admin/schools` | School | schools.manage | e2e school-admin, school-directory | 1 Complete and verified |
| INT-05 | Add, edit, activate / deactivate schools | PR B | Admin | school page | `/admin/schools/*` | School | schools.manage; audit with previous / new values | e2e school-admin | 1 Complete and verified |
| INT-06 | School administrators or contacts | consolidated req. | Admin | contacts tab | contacts ✅; school-administrator accounts ✗ | SchoolContact | contacts masked in history | e2e school contacts | 3 Partially implemented |
| INT-07 | Students and teachers of a school | consolidated req. | Admin | Students tab; Teachers tab (branch `feat/school-teachers`); School Access page (branch `feat/teacher-student-access`) | school students; `/admin/schools/:id/access(+/students)` | TeacherSchoolAssignment, TeacherStudentAssignment | schools.view / users.manageTeachers; no contact data | e2e INT-07 case, teacher-student-access (11); Playwright teacher-student-access (4) | 1 Complete and verified |
| INT-08 | Bulk import schools | S1/S2 | Admin, Super Admin | import, sync runs | import + directory sync (Super Admin approve / apply) | sync tables | Super Admin for apply | e2e school-import, school-sync-* | 1 Complete and verified |
| INT-09 | Avoid duplicate schools | PR B | Admin | possible-duplicate confirm | 409 possible duplicate | nameKey | — | e2e school-admin | 1 Complete and verified |
| SUB-01 | Admins manage subjects | ADR-007 (Phase 3) | Admin | — | `Discipline` = Mathematics only | — | — | — | 5 Awaiting design approval |
| SUB-02 | New subject without code change | ADR-007 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUB-03 | Topics per subject | ADR-007 | Admin, Coach | — | — | — | — | — | 5 Awaiting design approval |
| SUB-04 | Subject → Topic → Course hierarchy | ADR-007 | all | — | — | — | — | — | 5 Awaiting design approval |
| SUB-05 | Subject availability per level / country / programme | ADR-007 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUB-06 | Coaches assigned to subjects / courses / groups | ADR-007 | Admin, Head Coach | course × division assignments | mentor assignments ✅; subjects / groups ✗ | MentorAssignment | mentorAssignments.manage | e2e mentor-assignments, head-coach-programme | 3 Partially implemented |
| SUB-07 | Existing Mathematics data preserved | Phase 1 (M3) | — | — | membership backfill | ProgrammeMembership | — | migration tests, Phase 1 release | 1 Complete and verified |
| ACA-01 | Academic years | Phase 4 | Admin | academic years pages | years, activation (single-flight) | AcademicYear | academicYears.manage | e2e academic-year-* | 1 Complete and verified |
| ACA-02 | Junior / Senior divisions; flexible levels | ADR-005; owner decision 2026-11-19: one common Olympiad structure for every country — S1–S3 Junior, S4–S6 Senior for every country; a country never sets a level or division | Admin | divisions | divisions ✅ (common to all countries; no flexible levels by owner decision) | Division | — | e2e divisions | 1 Complete and verified |
| ACA-03 | Course availability, coaches, enrollment control | ADR-006 (Phase 6) | Admin | courses pages | publish / archive ✅; enrollment control ✗ | Course | courses.manage | e2e courses | 3 Partially implemented |
| ACA-04 | Coach assignments | Phase 1 | Admin, Head Coach | assignments | `/admin/mentor-assignments` | MentorAssignment | mentorAssignments.manage (programme scope for Head Coaches) | e2e mentor-assignments, head-coach-programme | 1 Complete and verified |
| ACA-05 | Course enrollment separate; restricted materials | ADR-006 | Student, Admin | — | — | — | — | — | 5 Awaiting design approval |
| ACC-01 | Search and filter users | Phase 4 | Admin | Users list | `GET /admin/users` | — | users.view; phones masked in lists (ACC-16) | e2e users, contact-data-access | 1 Complete and verified |
| ACC-02 | Complete user profiles | consolidated req. | Admin | user page shows DOB with age, phones, close-family phone, home place (branch `feat/admin-user-details` a43563f) | `GET /admin/users/:id` | — | users.manage only (single account) | frontend admin-user-details (2); Playwright role-journeys (DOB, close-family phone) | 1 Complete and verified |
| ACC-03 | Edit permitted information | Phase 4 | Admin | edit dialog | `PATCH /admin/users/:id` | — | role policy, step-up for admin roles; audit changes | e2e users | 1 Complete and verified |
| ACC-04 | Approve / reject applications | Phase 4 | Admin | application pages | teacher / coach review | applications | users.manageTeachers / manageCoaches | e2e teacher-registration, mentor requests | 1 Complete and verified |
| ACC-05 | Invite users | Phase 4 | Admin | invite dialog | invitations | — | users.manage* | e2e invitations | 1 Complete and verified |
| ACC-06 | Suspend and reactivate | Phase 4 / account states | Admin | user page | account-status service | UserStatusChange | users.suspend / changeStatus | e2e account-states | 1 Complete and verified |
| ACC-07 | Change permissions where authorized | P1-09; TS-4 | Super Admin, Admin (teacher delegations) | Permission overrides card; teacher card scopes | overrides; delegation scopes SCHOOL / ASSIGNED / SELECTED | UserPermissionOverride(+Student) | permissions.manageOverrides / users.manageTeachers; no self, never SUPER_ADMIN | e2e permission-overrides, teacher-student-access; Playwright role-journeys (Super Admin card) | 1 Complete and verified |
| ACC-08 | Reset accounts, resend activation | Phase 4 | Admin | user page | reset / resend | — | users.manage | e2e activation, password reset | 1 Complete and verified |
| ACC-09 | Bulk operations | owner 2026-11-16 | Admin | Users bulk actions (branch `feat/admin-bulk-user-operations`, + teacher–student actions d548de3) | `/admin/users/bulk*` (+ assignTeacher / unassignTeacher / grantDelegation / revokeDelegation) | BulkOperation(+Item) | users.bulkManage + each action's permission; selection token; step-up | e2e bulk-operations* (incl. concurrency, notices), teacher-student-access (bulk); frontend bulk-users tests. No browser test of the bulk dialog **Browser:** Playwright admin-users — bulk suspend of two accounts with preview, reason and acknowledgement; operation COMPLETED. | 1 Complete and verified |
| ACC-10 | Import and export users | Phase 4 | Admin | import dialog, export | import, bulk export | — | users.import / users.export | e2e import, bulk export | 1 Complete and verified |
| ACC-11 | Activity and account history | Phase 4 | Admin | activity log; account history card (branch) | activity, status history | UserStatusChange | audit.view / users.manage | e2e account-states, activity. No browser test of the history card **Browser:** Playwright admin-users — account history card shows the suspension and its reason. | 1 Complete and verified |
| ACC-12 | Explicit account states incl. Pending Verification / Approval / Rejected | ADR-008 (six states) vs four stored — open | Admin | states shown | ACTIVE / DEACTIVATED / SUSPENDED / ARCHIVED stored; pending derived; REJECTED stays on applications (owner approved 2026-11-18, decisions 10.1–10.3) | AccountStatus | — | e2e account-states | 1 Complete and verified |
| ACC-13 | Soft deletion and restoration | Phase 4 | Admin | archive / restore | account states | — | users.archive | e2e account-states | 1 Complete and verified |
| ACC-14 | Permanent deletion restricted | Phase 10 | Admin | — | permanent deletion disabled; retention deletion ✗ | — | — | e2e (delete refused with history) | 5 Awaiting design approval |
| ACC-15 | Users update picture, contact, location, school, interests | Phase 4 | all | My Profile, avatar, school claim | `/me*`, avatar | User | own account only | e2e me, avatar, school claims; Playwright role-journeys (profile) | 1 Complete and verified |
| ACC-16 | Sensitive information restrictions | owner 2026-11-17 (masking) | Admin, Teacher, Head Coach | lists show masked phones | `maskContacts` in lists; teachers / Head Coaches never get contacts | — | users.manageStudents for full single-account view | e2e contact-data-access; teacher-student-access (no contact data in School Access) | 1 Complete and verified |
| PERM-01 | Type, organisational role, profile, permissions, scope | Phase 1; org role (D5) / profiles deferred | all | — | type, defaults, overrides, scopes | — | — | route sweep | 3 Partially implemented |
| PERM-02 | Reusable permission profiles | deferred (owner) | — | — | — | — | — | — | 7 Deferred (owner) |
| PERM-03 | Granular permissions | Phase 1 | all | permission-driven menus | catalogue | — | default deny | permission-equivalence, route-declarations | 1 Complete and verified |
| PERM-04 | Scope restrictions | Phase 1; TS-1…TS-6 | all | — | school, programme, course × division, teacher–student (assigned / selected) ✅; country / group / support ✗ (features not built) | — | checked per request | e2e scopes, teacher-student-access | 3 Partially implemented |
| PERM-05 | Default deny, backend enforcement | Phase 1 | all | — | guards | — | — | role-route sweep (anonymous only on @Public) | 1 Complete and verified |
| PERM-06 | No privilege escalation | Phase 1 | all | — | role allow-list, step-up, no self overrides | — | — | e2e role-allowlist, super-admin, permission-overrides | 1 Complete and verified |
| PERM-07 | Audit sensitive permission changes | Phase 1 | Admin | audit log | override / delegation audit (previous / new) | AuditLog | — | e2e permission-overrides, teacher-student-access | 1 Complete and verified |
| PERM-08 | Compatible with existing auth | Phase 1 | — | — | JWT + refresh | — | — | e2e auth | 1 Complete and verified |
| PUB-01 | Draft → Pending → Published (+ changes requested, rejected, archived) | ADR-010/011 (Phase 7) | Coach, Admin | assignment workflow | assignments full; courses / resources publish / archive only | Assignment status | assignments.publish | e2e assignments | 5 Awaiting design approval |
| PUB-02 | Transitions by permission | ADR-010 | Coach, Admin | — | per permission | — | — | e2e assignments | 5 Awaiting design approval |
| PUB-03 | Revisions of published content | ADR-011 | Coach, Admin | — | — | — | — | — | 5 Awaiting design approval |
| PUB-04 | Version history | ADR-011 | Coach, Admin | assignment history | assignment events only | AssignmentEvent | — | e2e assignments (history) | 5 Awaiting design approval |
| SUP-01 | Student support requests | ADR-012 (Phase 8) | Student, Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUP-02 | Reference, status tracking, responses | ADR-012 | Student, Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUP-03 | Staff handling | ADR-012 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUP-04 | Configurable statuses | ADR-012 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUP-05 | Internal notes | ADR-012 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| SUP-06 | Coach meeting requests | ADR-012 | Student, Coach | — | — | — | — | — | 5 Awaiting design approval |
| GRP-01 | Independent groups (e.g. IMO2026) | ADR-013 approved; reuse study-groups module | Admin, Student, Coach | — | study-groups code present, module not registered | StudyGroup tables exist | — | — | 5 Awaiting design approval |
| GRP-02 | Group management | ADR-013 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| GRP-03 | Group communication | ADR-013 | Admin, Coach, Student | — | — | — | no private 1:1 messaging (excluded, release 1) | — | 5 Awaiting design approval |
| GRP-04 | Group administrators | ADR-013 | Admin | — | — | — | — | — | 5 Awaiting design approval |
| GRP-05 | Targeted e-mails (groups, roles, countries, schools, subjects) | ADR-014 | Admin | bulk e-mail (filters, chosen users) | bulk `message` action; no saved segments | EmailJob | email.bulkSend | e2e bulk-operations-notices, email jobs | 5 Awaiting design approval |
| NOT-01 | Notification topics | Phase 4; TS-6 | all | notification centre, settings | topics incl. decisions, teacher.students.assigned | Notification, NotificationOutbox | — | e2e notifications, decision-notifications, teacher-student-access | 3 Partially implemented |
| NOT-02 | In-app and e-mail | Phase 4 | all | notification centre | outbox + Resend | NotificationOutbox | — | e2e decision-notifications, email | 1 Complete and verified |
| NOT-03 | User preferences | Phase 4 | all | My Profile switches (Head Coach fix on branch) | settings incl. Head Coach / Super Admin | — | — | e2e role-notification-settings **Browser:** Playwright admin-users — a student changes an e-mail preference; persists after reload. | 1 Complete and verified |
| NOT-04 | No duplicate notifications | Phase 4; TS-6 dedupe | all | — | outbox dedupe key | unique dedupeKey | — | e2e decision-notifications, teacher-student-access (one notice per action / operation) | 1 Complete and verified |
| NOT-05 | Delivery failures | Phase 4 | Admin | delivery log | retries, backoff | NotificationOutbox | notifications.deliveries | e2e decision-notifications | 1 Complete and verified |
| NOT-06 | Delivery ≠ read | Phase 4 | all | read state | read flags | Notification | — | e2e notifications | 1 Complete and verified |
| ADM-01 | Admin portal covers the 20 areas | consolidated req. | Admin | areas of approved phases | — | — | — | Playwright sidebar, role-journeys | 3 Partially implemented |
| ADM-02 | Admins see only permitted functions | Phase 1 | Admin | permission-driven menus | /me/permissions | — | — | frontend nav tests; Playwright sidebar | 1 Complete and verified |
| UX-01 | Modern login / registration | owner | all | auth redesign (frontend develop, not released) | — | — | — | frontend tests; Playwright sign-in in every spec **Browser:** Playwright registration-forms (every sign-up form) and sign-in in every spec. | 1 Complete and verified |
| STU-01 | Student experience | consolidated req. | Student | courses, assignments, results, leaderboard | — | — | — | e2e student flows; Playwright role-journeys | 3 Partially implemented |
| TCH-01 | Teacher and coach dashboards scoped | P1-10 / P1-11; TS-1…TS-6 | Teacher, Coach, Head Coach | teacher My Students (badges, pending count), coach and Head Coach portals | scoped services | — | school / assignment / programme scope | e2e teachers, teacher-student-access (incl. SR-1: suspended / deactivated / archived students hidden on every teacher path; SR-2 pending-claim assignment), head-coach-*; Playwright teacher-student-access, role-journeys | 1 Complete and verified |
| SEC-01 | Passwords, sessions, authorization, validation, rate limits, files | Phase 1 | all | — | guards, throttles (10 sign-ins / min), upload limits | — | — | e2e auth, uploads; role-route sweep | 1 Complete and verified |
| SEC-02 | Backup and recovery | release plan | operations | — | backups; restore drill kit | — | — | drill kit tests; a real restore drill needs a fresh Neon branch (owner) | 8 Blocked (external) |
| SEC-03 | Protection of minors | owner; ADR-013 | Student | no 1:1 messaging; pending students never named to teachers; blocked (suspended / deactivated / archived) students hidden from teachers (SR-1); guardian phone required by the server (9.2) | contact data restricted; guardian consent ✗ (8.3: legal advice before opening student self-registration, which stays off) | — | — | e2e contact-data-access, teacher-student-access | 3 Partially implemented |
| SEC-04 | Retention, correction, export, deletion | Phase 10 | all | — | activity-log retention only | — | — | — | 5 Awaiting design approval |
| SEC-05 | No sensitive data in URLs / public responses / logs | Phase 1 | — | — | by design; sanitised errors | — | — | reviews; error sanitiser unit tests; no automated scan **Automated scan (2026-11-18):** e2e sensitive-data — no route takes a token, password or secret in its URL (OpenAPI contract; the applicant info-request token moved from the path to the body); sign-in, password reset, refresh and an expired link leave no password or token in any log level or response, no password hash in any response (proven to fail on a planted leak). | 1 Complete and verified |
| SEC-06 | Safe migrations | release plan | operations | — | rehearsal kit, rollbacks with data guards | — | — | rehearsal tests; local deploy → rollback → redeploy (11 migrations) | 1 Complete and verified |
| ARC-01 | Separate apps, contracts, errors | ADR | — | capabilities contract | API snapshot tests | — | — | api-snapshot tests | 1 Complete and verified |
| ARC-02 | Validation, pagination, transactions | ADR | — | — | DTO validation, pagination | — | — | unit / e2e | 1 Complete and verified |
| ARC-03 | Reversible migrations | ADR | — | — | rollback files | — | — | rehearsal tests, rollback drills | 1 Complete and verified |
| ARC-04 | Dev / staging / prod separation | ADR-016 | operations | — | — | — | — | no staging environment yet (owner: resources) | 8 Blocked (external) |
| AUD-01 | Important actions logged | Phase 1 | Admin | audit log | AuditLog in the same transaction | AuditLog | audit.view | e2e audit | 1 Complete and verified |
| AUD-02 | Previous and new values | consolidated req. | Admin | audit log details | `auditChanges` helper; status steps from / to (c7b1a41) | — | never secrets / contact values | e2e audit-changes (4), unit (4) | 1 Complete and verified |
| AUD-03 | Not editable | Phase 1 | — | — | append-only trigger | trigger | — | e2e audit append-only | 1 Complete and verified |
| AUD-04 | Coverage for new areas | consolidated req. | Admin | — | permissions, exports, teacher–student ✅; subjects / support / groups do not exist | — | — | audit-categories spec | 3 Partially implemented |
| PERF-01 | Large datasets, pagination | ADR | — | paginated tables | pagination, bulk worker batches | — | — | e2e bulk 5 000-school sync | 1 Complete and verified |
| PERF-02 | Large uploads | ADR | all | — | size limits; no resumable upload | — | — | e2e uploads | 3 Partially implemented |
| PERF-03 | Responsive, accessible UI | owner | all | responsive; sidebar "More" menu (approved) | — | — | — | Playwright sidebar desktop + phone; no accessibility audit **Accessibility (2026-11-18):** automated axe-core WCAG 2.0/2.1 A+AA audit of 27 key pages of every portal and the public pages — 0 serious or critical violations (colour contrast raised to AA across the frontend). No manual screen-reader audit. | 1 Complete and verified |

## Not implemented here because they need the owner

- Designs (status 5): Phase 3 subjects / topics, Phase 6 course access, Phase 7 publishing
  and versioning, Phase 8 student support, Phase 9 groups and targeted e-mail, Phase 10 privacy / retention, REG-09 configurable
  fields, ADR-008 account states — see `DESIGN-PROPOSALS-V2.md`.
- External (status 8): fresh Neon branch (restore drill), staging environment.

## Test evidence (2026-11-18, local, PostgreSQL 18)

- Backend `feat/teacher-student-access` b5a9369: unit 1155 + 5 sweep; e2e full suite on a clean database 982 passed /
  6 skipped (S3) / 0 failed; routes 315/315 called by e2e; API snapshot history additive only; release kit 144 script tests; migration
  deploy → rollback (refusal, discard mode) → redeploy with no drift.
- Frontend integration (`integ/frontend-rc`): 408 unit tests, typecheck, lint, Next build.
- Browser (Playwright, real backend + PostgreSQL): sidebar (8), teacher–student access (4), role journeys (7).
- Not run locally: 6 S3 tests (need an S3 API; they run in CI with S3Mock).

Later the same day (SR-1, 9.2, 9.3; local runs, then GitHub CI — see `FINAL-REVIEW-PACKAGE.md` §2):

- Backend `feat/applications-complete` 4c0b152: unit 1150; e2e 976 passed / 6 skipped / 0 failed; API snapshot (one
  approved breaking change: guardianPhone required; additive otherwise); release kit and drill scripts 144.
- Backend `feat/teacher-student-access` eaccf4b: unit 1160 (+ sweep 5, Student 93 routes); e2e 990 passed / 6 skipped /
  0 failed; routes 316/316; docs unchanged; migrate + no drift.
- Frontend `feat/applications-complete` 31097e4: 368 unit tests; GitHub CI green.
- Browser (integrated stack, merged backend): 20 tests incl. the new date-of-birth step; one sidebar test timed out once
  (coach portal stuck on "Loading…", no throttling in the backend log) and passed 7/7 on rerun — recorded as a flake.
