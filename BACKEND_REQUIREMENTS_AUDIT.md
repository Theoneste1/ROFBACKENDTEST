# Backend requirements audit — ROF LMS

**Date:** 2026-11-08 · **Baseline:** `ROF_LMS_CONSOLIDATED_REQUIREMENTS.md` (947 lines, read in full)
**Code audited:** `ROFBACKENDTEST`, branch `feature/backend-completion`, commit `f624d25`
**Companion documents:** [PRELIMINARY_BACKEND_AUDIT.md](PRELIMINARY_BACKEND_AUDIT.md) (inventory and verification levels),
[BACKEND_IMPLEMENTATION_PLAN.md](BACKEND_IMPLEMENTATION_PLAN.md), [DATABASE_CHANGE_PLAN.md](DATABASE_CHANGE_PLAN.md),
[API_CHANGE_PLAN.md](API_CHANGE_PLAN.md), [BACKEND_TEST_PLAN.md](BACKEND_TEST_PLAN.md),
[FRONTEND_INTEGRATION_REQUIREMENTS.md](FRONTEND_INTEGRATION_REQUIREMENTS.md).

No code, database or configuration was changed for this audit. Production was only read.

> **Decision update (2026-11-08):** the owner approved the design direction in
> [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) (ADR-001 – ADR-017) — *approved design direction, subject to
> the final implementation review*. Questions Q1, Q2, Q4 and Q6 are answered; entries below reflect those answers.
> Progress is tracked in [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md).

---

## How to read this document

**Status**

| Status | Meaning |
|---|---|
| **Implemented — verified** | Works and is covered by tests (level in brackets: P production, X across both apps, E end-to-end, U unit) |
| **Implemented — partly verified** | Works, but some paths have no test |
| **Partial** | Part of the requirement exists; the rest is missing |
| **Missing** | Nothing exists yet |
| **Frontend only** | No backend work beyond existing APIs |
| **Clarify** | Cannot be planned until a question is answered (section 13) |

**Priority:** Critical (foundation others depend on, or security/data integrity) · High · Medium · Low.

Each requirement lists: evidence · required changes · models · APIs · permissions · tests · dependencies.
Permission names in `code` style are the proposed names from [API_CHANGE_PLAN.md](API_CHANGE_PLAN.md) §2.

---

## Summary

| Area | Reqs | Implemented | Partial | Missing | Clarify / FE only |
|---|---|---|---|---|---|
| 2 Registration | 14 | 3 | 8 | 3 | 0 |
| 3 International structure | 9 | 0 | 4 | 5 | 0 |
| 4 Subjects and topics | 7 | 0 | 5 | 1 | 1 |
| 5 Courses, divisions, enrollment | 5 | 2 | 2 | 1 | 0 |
| 6 Accounts | 16 | 8 | 7 | 1 | 0 |
| 7 Permissions | 8 | 1 | 4 | 2 | 1 |
| 8 Publishing and versioning | 4 | 0 | 3 | 1 | 0 |
| 9 Student support | 6 | 0 | 0 | 6 | 0 |
| 10 Communication groups | 5 | 0 | 4 | 1 | 0 |
| 11 Notifications | 6 | 4 | 2 | 0 | 0 |
| 12–15 Portals and experiences | 5 | 0 | 4 | 0 | 1 |
| 16 Security and privacy | 6 | 2 | 4 | 0 | 0 |
| 17 Architecture | 4 | 2 | 2 | 0 | 0 |
| 18 Audit | 4 | 2 | 2 | 0 | 0 |
| 19 Performance | 3 | 1 | 1 | 0 | 1 |
| **Total** | **102** | **25** | **52** | **21** | **4** |

"Implemented" counts both *verified* and *partly verified*; the individual entries say which.

The existing backend covers the **assessment core** (assignments, submissions, reviews, results), authentication,
notifications, e-mail, files, audit and reporting well. The requirements add **five foundations that do not
exist**: data-driven permissions with scopes, international reference data, dynamic subjects/topics with admin
management, explicit account states with soft deletion, and content versioning — plus two **new modules**
(student support, communication groups). Most other requirements extend existing modules.

---

## 2. User types and registration

**REG-01 · Three primary user types: Student, Teacher, Coach (plus Administrator)** — **Critical** — **Partial**
- Evidence: `Role` enum = STUDENT, MENTOR (shown as "Coach"), ADMIN. No teacher type; teachers use the contact form (`lib/site/content.ts`: "Teacher accounts are not available yet").
- Changes: add a TEACHER user type (**approved, ADR-002**). Default teacher rights (ADR-003): own profile; assigned schools/subjects/courses; create resources and submit them for approval; create assignments and submit them for approval **only when granted**; take part in permitted discussions and groups; view student information only within scope. No grading, user administration, approval/publishing or global admin rights unless granted through a profile or explicit assignment.
- Models: `User.role` (enum `Role`) · APIs: registration, `/admin/users*`, `/me/permissions` · Permissions: per type defaults · Tests: role matrix for TEACHER on every route · Depends on: decision D2, PERM foundation.

**REG-02 · Student registration collects personal and academic information** — **High** — **Partial**
- Evidence: `RegisterStudentDto` has first/last name, username, email, password, grade (S1–S6), school name/location, home location. Missing: date of birth, country, student phone, **guardian phone (mandatory)**, profile picture, interested subjects, academic year selection.
- Changes: new fields (DOB, countryId, phone, guardianPhone, avatar file, subject interests); guardian data access-restricted (SEC-03).
- Models: `User` (+ `UserSubjectInterest`), `FileObject` (AVATAR purpose) · APIs: `POST /auth/register/student` (additive fields) · Permissions: public · Tests: validation per country, guardian phone required, duplicates · Depends on: INT-01/03, SUB-01.

**REG-03 · School and grade options adapt to the selected country** — **Critical** — **Missing**
- Evidence: `GradeLevel` is an enum (S1–S6); `School` has no country.
- Changes: grade levels and schools filtered by country / education system (reference data, INT-01..04).
- Models: `Country`, `EducationSystem`, `GradeLevel` (table), `School.countryId` · APIs: `GET /reference/countries`, `/reference/countries/:id/grade-levels`, `/schools/search?countryId=` · Permissions: public read · Tests: Rwanda P1–P6/S1–S6, a second country with different grades · Depends on: INT-01, INT-03.

**REG-04 · Registration is separate from academic enrollment; no automatic access to every course** — **Critical** — **Partial (conflicts with current behaviour)**
- Evidence: registration creates a `StudentEnrollment` for the current academic year and derives the division from the grade (`academicYears.enrollInCurrentYear`, `divisions.idForGrade`). Students then see **every published course** of their division (`courses.service.ts`: student listing = published courses; `CourseEnrollment` only tracks UNROLLED/ROLLED/COMPLETED on first open).
- Changes: per-course access policy (**approved, ADR-006**): existing courses keep `DIVISION_OPEN`; **new courses default to `ENROLLMENT_REQUIRED`**; only holders of `courses.manageAccess` change it; widening access requires explicit confirmation and is audited.
- Models: `Course` (+ `accessPolicy`), `CourseEnrollment` (+ status for granted access) · APIs: `/courses*`, `/me/courses`, new enrollment admin endpoints · Permissions: `enrollments.manage` · Tests: student without enrollment cannot open a restricted course; existing division courses unchanged · Depends on: D4, ACA-05.

**REG-05 · Teacher registration (phone mandatory, school/institution, position, subjects, experience)** — **High** — **Missing**
- Evidence: no teacher registration or model.
- Changes: teacher application/registration flow, reusing the coach-application approval pattern (`MentorRequest`).
- Models: `User` (TEACHER), `UserProfile` fields, `RegistrationApplication` (generalised `MentorRequest`) · APIs: `POST /auth/register/teacher` or `POST /registration-applications` · Permissions: public submit; `registrations.approve` · Tests: approval required per setting · Depends on: REG-01, INT, SUB-01.

**REG-06 · Coach registration fields (phone, country, affiliation, qualifications, subjects, expertise, experience, picture)** — **High** — **Partial**
- Evidence: `MentorRequest` stores first/last name, username, email, password hash, status only (`POST /mentor-requests`).
- Changes: extend the application with profile fields and subjects; keep the existing endpoint working.
- Models: `MentorRequest` → generalised application (D9) · APIs: `POST /mentor-requests` (additive) · Permissions: public · Tests: new fields validated; existing payload still accepted · Depends on: INT-01, SUB-01.

**REG-07 · Coaches are verified and approved; permissions/assignments only from an administrator** — **High** — **Implemented — verified (E)**
- Evidence: `PATCH /mentor-requests/:id/approve|reject` (ADMIN); coach scope only via `MentorAssignment` created by admins (`/admin/mentor-assignments`); e2e `remaining-endpoints`, `access`.
- Changes: none now; later map to permission profiles and subject scopes (PERM-04).
- Models: `MentorRequest`, `MentorAssignment` · Permissions: `registrations.approve`, `coachAssignments.manage` · Tests: keep as regression.

**REG-08 · Enable/disable public registration overall and per user type** — **Medium** — **Partial**
- Evidence: setting `registration.studentSelfSignup` (students only); coach applications have no switch.
- Changes: settings per user type (`registration.teacher.enabled`, `registration.coach.enabled`).
- Models: `SystemSetting` (registry) · APIs: `/admin/settings` · Permissions: `settings.manage` · Tests: closed registration → 403/feature-off code · Depends on: REG-05.

**REG-09 · Configure mandatory/optional registration fields** — **Low** — **Missing**
- Evidence: field rules are fixed in DTOs.
- Changes: per-type field-requirement settings for a defined set of optional fields (not free-form schemas).
- Models: `SystemSetting` · APIs: `/admin/settings`, `GET /registration/form?userType=` · Tests: required/optional honoured · Depends on: REG-02/05/06; Q10.

**REG-10 · Review and approve registrations; reject with a reason; request more information** — **High** — **Partial**
- Evidence: students approved via `PATCH /admin/users/:id/status {isApproved}`; coaches approve/reject without a stored reason; no "request information" step.
- Changes: one registration review queue with states and reasons; notification + e-mail to the applicant.
- Models: `RegistrationApplication` (or `User.status` + `AccountStatusEvent`) · APIs: `GET /admin/registrations`, `PATCH .../approve|reject|request-info` · Permissions: `registrations.approve` · Tests: reason stored and e-mailed; transitions validated · Depends on: ACC-12 (account states).

**REG-11 · Resend activation, suspend/reactivate, bulk import** — **High** — **Implemented — verified (E)**
- Evidence: `POST /admin/users/:id/resend-invitation`, `POST /auth/resend-activation`, `PATCH /admin/users/:id/status`, `POST /admin/users/import` (CSV, dry run); e2e `user-management`.
- Changes: extend import to new fields (country, teacher type) later.

**REG-12 · Export user records** — **Medium** — **Partial**
- Evidence: `GET /admin/reports/students.csv`, `mentors.csv` (filtered; audited as `EXPORT_REPORT`).
- Changes: general user export (all types, chosen fields), excluding guardian data unless explicitly permitted.
- APIs: `GET /admin/users/export.csv` · Permissions: `users.export` (+ `users.viewSensitive` for guardian fields) · Tests: field filtering, audit entry.

**REG-13 · View registration history** — **Low** — **Partial**
- Evidence: audit log has `REGISTER`, `APPROVE_MENTOR_REQUEST`…; `MentorRequest` keeps status; no per-user timeline.
- Changes: per-user account history endpoint built from audit + status events.
- APIs: `GET /admin/users/:id/history` · Permissions: `users.view` · Depends on: ACC-12.

**REG-14 · Prevent duplicate accounts** — **High** — **Implemented — verified (E)**
- Evidence: unique `username`, `email`; `assertIdentityFree` also checks pending coach applications; e2e `auth`.
- Changes: decide whether phone numbers must be unique (Q11).

## 3. International academic structure

**INT-01 · Administrators manage countries** — **Critical** — **Missing**
- Changes: `Country` reference table (ISO code, name, active flag), admin CRUD, public read.
- Models: `Country` · APIs: `GET /reference/countries`, `/admin/countries*` · Permissions: `reference.manage` · Tests: inactive country hidden from registration · Depends on: Q12 (seed list).

**INT-02 · Region/province/district and city/locality** — **Medium** — **Missing**
- Evidence: only free-text `School.location`, `User.homeLocation`.
- Changes: optional `Region` (per country, one level) + free-text locality; avoid deep hierarchies unless required (Q13).
- Models: `Region`, `School.regionId`, `User.regionId` · APIs: `/reference/countries/:id/regions` · Depends on: INT-01.

**INT-03 · Education systems and grade levels per country** — **Critical** — **Missing**
- Evidence: `GradeLevel` enum S1–S6 used by `User`, `StudentEnrollment`, division mapping (`divisions.idForGrade`), DTOs.
- Changes: `EducationSystem` and `GradeLevel` tables; Rwanda seeded with P1–P6 and S1–S6; enum replaced through expand–contract (DATABASE_CHANGE_PLAN §4).
- Models: `EducationSystem`, `GradeLevel`, `User.gradeLevelId`, `StudentEnrollment.gradeLevelId`, `Division`↔`GradeLevel` mapping · APIs: registration, users, enrollments, reports (additive `gradeLevel` object; keep `gradeLevel` code string) · Tests: migration keeps every existing grade · Depends on: INT-01; decision D5.

**INT-04 · Schools linked to country and location, with type** — **High** — **Partial**
- Evidence: `School { name (unique), location }`; created on registration (`school.upsert` by name).
- Changes: add `countryId`, `regionId`, `type`, `isActive`; uniqueness per country (name + country), backfill Rwanda.
- Models: `School` · APIs: `/schools*` · Tests: same name allowed in two countries; duplicates prevented within one.

**INT-05 · Add, edit, activate/deactivate schools** — **Medium** — **Partial**
- Evidence: `GET /schools`, `GET /schools/:id` (ADMIN), `GET /schools/search` (public); no create/edit/deactivate.
- APIs: `POST/PATCH /admin/schools`, `PATCH /admin/schools/:id/status` · Permissions: `schools.manage` · Tests: inactive schools excluded from registration search.

**INT-06 · Assign school administrators or contacts** — **Low** — **Missing**
- Changes: `SchoolContact` (user or free-text contact); scope `school` in permission assignments (PERM-04).
- Depends on: PERM foundation; Q14.

**INT-07 · View students and teachers of a school** — **Medium** — **Partial**
- Evidence: `GET /schools/:id` (counts/students), `GET /admin/users?schoolId=`.
- Changes: include teachers once REG-01 exists; paginated member list.

**INT-08 · Bulk import schools** — **Low** — **Missing**
- Changes: CSV import with dry run, reusing `common/csv-parse` and the users-import pattern.
- APIs: `POST /admin/schools/import?dryRun=` · Permissions: `schools.manage`.

**INT-09 · Avoid duplicate schools** — **Medium** — **Partial**
- Evidence: global unique `School.name` with title-case normalisation.
- Changes: normalised name + country uniqueness; merge tool for duplicates (later).

## 4. Dynamic subjects and topics

**SUB-01 · Admins create, edit, publish, deactivate, archive subjects (name, code, description, icon, order, status, visibility, created/updated info)** — **Critical** — **Partial**
- Evidence: `Discipline { code, name, description, isActive, sortOrder }` seeded with MATHEMATICS; only `GET /disciplines`.
- Changes: evolve `Discipline` into Subject (D1): add icon (FileObject), status (DRAFT/PUBLISHED/ARCHIVED), visibility, createdBy/updatedBy; admin CRUD + transitions; audit.
- Models: `Discipline` (renamed in API as subject) · APIs: `GET /subjects`, `/admin/subjects*`; keep `GET /disciplines` as alias · Permissions: `subjects.manage` · Tests: "a new subject can be created without a source-code change" (§20) · Depends on: PERM-02 (permission names), D1.

**SUB-02 · A new subject requires no code change or deployment** — **Critical** — **Partial**
- Evidence: data model is generic, but no API creates subjects or courses (`/admin/courses` only edits/publishes seeded courses).
- Changes: SUB-01 + course creation API (ACA-03).

**SUB-03 · Topics per subject: add, rename, reorder, deactivate, archive** — **Critical** — **Partial**
- Evidence: today's math topics (Algebra, Geometry, Number Theory, Combinatorics) are **courses** (`prisma/seed.ts`).
- Changes: `Topic` table under subject (D1); backfill one topic per existing course and link the course to it.
- Models: `Topic`, `Course.topicId` · APIs: `GET /subjects/:id/topics`, `/admin/topics*` · Permissions: `topics.manage` · Tests: reorder, archive hides from students, Math backfill · Depends on: SUB-01, D1.

**SUB-04 · Hierarchy Subject → Topic → Course/Programme → Resources and Assessments; subjects may differ** — **Critical** — **Partial**
- Evidence: Discipline → Course → (Resources, Assignments) per division.
- Changes: insert Topic (optional per subject so subjects can differ); resources/assignments stay on Course — no change to the assessment core.
- Depends on: D1. **Clarify:** whether a course may span several topics (Q3).

**SUB-05 · Control which subjects are available to student levels, countries or programmes** — **High** — **Missing**
- Changes: subject availability rules (by country, grade level/division, programme/group).
- Models: `SubjectAvailability` · APIs: `/admin/subjects/:id/availability` · Tests: student outside the rule cannot see the subject · Depends on: INT-01/03, D4.

**SUB-06 · Coaches assigned to subjects, courses and academic groups by admins** — **High** — **Partial**
- Evidence: `MentorAssignment` = coach × course × division (ADMIN only).
- Changes: scoped permission assignments (subject, course, division, group) via PERM-04; keep `MentorAssignment` as the course-level teaching assignment.
- Depends on: PERM-04.

**SUB-07 · Existing Mathematics data and relationships preserved** — **Critical** — **Clarify / migration constraint**
- Changes: migration plan ensures every existing course, assignment, resource, submission and result keeps its IDs and links (DATABASE_CHANGE_PLAN §6); verification queries before/after.
- Tests: "Existing Mathematics data remains available after migration" (§20) on a copy of production.

## 5. Courses, divisions and enrollment

**ACA-01 · Manage academic years** — **High** — **Implemented — verified (E)** (no frontend page)
- Evidence: `/admin/academic-years*` (create, edit, activate with promotion, enrollments).
- Changes: link years to education systems/countries later (calendars differ by country — Q15).

**ACA-02 · Junior and Senior divisions keep working; flexible levels evaluated** — **High** — **Partial**
- Evidence: `DivisionCode` enum JUNIOR/SENIOR; grade→division mapping hard-coded (`common/grade-levels.ts`).
- Changes: keep divisions; move the grade→division mapping into data (Division↔GradeLevel); allow new divisions without an enum change (D5).

**ACA-03 · Manage course availability, assign coaches, control enrollment** — **High** — **Partial**
- Evidence: publish/unpublish/archive courses (`/admin/courses/:id/*`); coach assignments; **no course creation API**; enrollment not controllable.
- APIs: `POST /admin/courses`, enrollment endpoints (ACA-05) · Permissions: `courses.manage`, `enrollments.manage`.

**ACA-04 · Coach assignments** — **High** — **Implemented — verified (E)**
- Evidence: `/admin/mentor-assignments` (create, remove, reactivate; open reviews reassigned).

**ACA-05 · Course enrollment separate from registration; restricted materials need access** — **Critical** — **Missing** — see REG-04 (decided: ADR-006).

## 6. User management and account lifecycle

**ACC-01 · Search and filter users** — **High** — **Implemented — verified (E)**: `GET /admin/users` (search, role, division, grade, school, approved, active, activated; paginated). Changes: add country, user type TEACHER, status, subject filters.

**ACC-02 · View complete user profiles** — **High** — **Implemented — verified (E)**: `GET /admin/users/:id`. Changes: new profile fields with sensitive-field gating (SEC-03).

**ACC-03 · Edit permitted user information** — **High** — **Implemented — verified (E)**: `PATCH /admin/users/:id`. Changes: field-level permissions for sensitive fields.

**ACC-04 · Approve or reject applications** — **High** — **Partial** — see REG-10.

**ACC-05 · Invite users** — **High** — **Implemented — verified (E/X)**: `POST /admin/users/invite`, CSV import; invitation e-mail delivered (X). Changes: teacher type, new fields.

**ACC-06 · Suspend and reactivate** — **High** — **Implemented — verified (E)**: `PATCH /admin/users/:id/status`; tokens revoked on suspension. Changes: map to explicit states (ACC-12).

**ACC-07 · Change user permissions where authorized** — **Critical** — **Partial**: role change only (`PATCH /admin/users/:id {role}`, audited `CHANGE_USER_ROLE`). Changes: assign profiles/overrides/scopes (PERM-02..06).

**ACC-08 · Reset accounts, resend activation** — **High** — **Implemented — verified (P/E)**: `POST /admin/users/:id/send-password-reset`, resend invitation; reset e-mail delivered in production.

**ACC-09 · Bulk operations** — **Medium** — **Partial**: bulk import only. Changes: bulk suspend/reactivate/approve/assign profile with per-row results and audit. APIs: `POST /admin/users/bulk` · Permissions: as per action.

**ACC-10 · Import and export users** — **Medium** — **Partial**: import yes; export via reports (REG-12).

**ACC-11 · View user activity and account history** — **Medium** — **Implemented — partly verified (E)**: `GET /admin/activity?userId=`, audit log filters; no combined timeline (REG-13); no frontend page.

**ACC-12 · Explicit account states: Pending Verification, Pending Approval, Active, Suspended, Rejected, Archived, with defined transitions** — **Critical** — **Partial**
- Evidence: state is implied by `activatedAt`, `isApproved`, `isActive`; no Rejected or Archived.
- Changes: explicit `User.status` (D6) backfilled from the flags; transition table; status history; login checks use the status.
- Models: `User.status`, `AccountStatusEvent` · APIs: `/admin/users*` (additive `status`), transitions endpoint · Permissions: `users.suspend`, `registrations.approve`, `users.archive` · Tests: every allowed/forbidden transition; login blocked per state; backfill matches flags exactly.

**ACC-13 · Soft deletion and restoration** — **High** — **Missing**
- Evidence: `DELETE /admin/users/:id` hard-deletes, or refuses with `USER_HAS_HISTORY`.
- Changes: delete → ARCHIVED (+ `archivedAt`, `archivedById`); restore endpoint; list excludes archived by default.
- APIs: `DELETE` semantics change → **contract change** (API_CHANGE_PLAN §4); `POST /admin/users/:id/restore` · Permissions: `users.archive`, `users.restore`.

**ACC-14 · Permanent deletion restricted by retention/privacy rules** — **Medium** — **Partial**: hard delete only without history. Changes: permanent delete (anonymisation) behind `users.purge`, only for archived accounts after a retention period (Q16).

**ACC-15 · Users update profile picture, contact details, country/location, school, academic info, interests** — **Medium** — **Partial**: `PATCH /me` allows first name, last name, home location only. Changes: additive fields; some changes may need approval (school/grade — Q17); avatar upload (FilePurpose AVATAR).

**ACC-16 · Sensitive information access restrictions** — **Critical** — **Implemented — partly verified (E)**: e-mails visible to admins only (security e2e "data exposure"); new sensitive fields (DOB, phones, guardian) need field-level gating and read auditing (SEC-03).

## 7. Role-based access control and permissions

**PERM-01 · Five concepts: user type, organisational role, permission profile, individual permissions, scope** — **Critical** — **Partial**
- Evidence: `User.role` doubles as user type; `ROLE_PERMISSIONS` maps 3 roles → 31 permissions in code (`src/auth/permissions.ts`); scope via `AccessService` (coach course × division, student own division/records).
- Changes: data-driven profiles and assignments layered on the existing guard (D3); organisational role = descriptive field or profile (Q5).

**PERM-02 · Reusable permission profiles created by administrators** — **Critical** — **Missing**
- Changes: `PermissionProfile`, `PermissionProfilePermission`; system profiles seeded (Super Administrator, Coach, Teacher, Student) reproducing today's rights exactly.
- APIs: `/admin/permission-profiles*` · Permissions: `permissions.manage` · Tests: today's role behaviour unchanged after backfill (full regression).

**PERM-03 · Granular permissions by functional area** — **Critical** — **Partial**: 31 named permissions exist but only as role constants; routes check roles (`@Roles`). Changes: permission catalogue (code-defined list, D3) + `@RequirePermission()` guard used by new routes; existing routes migrated gradually with role fallback.

**PERM-04 · Scope restrictions (country, school, subject, course, division, group, assigned support requests)** — **Critical** — **Partial**: course × division scope for coaches only. Changes: `UserPermissionAssignment { profileId, scopeType, scopeId }`; scope resolution service extending `AccessService`.

**PERM-05 · Default-deny, backend enforcement, no reliance on UI** — **Critical** — **Implemented — verified (E)**: every route declares roles; security suite checks anonymous and wrong-role access for all routes; unit test checks permission map ↔ decorators. Changes: keep the same guarantees for permission-based routes (test generator).

**PERM-06 · Prevent privilege escalation; admins cannot grant beyond their own authority** — **Critical** — **Missing** (today all admins are equal). Changes: grant check = granter must hold the permission and the scope; Super Administrator required for `permissions.manage` on system profiles.

**PERM-07 · Record sensitive permission changes in the audit log** — **High** — **Partial**: `CHANGE_USER_ROLE`, `UPDATE_USER_STATUS` audited with before/after. Changes: audit every profile/assignment/override change with previous and new values.

**PERM-08 · Compatible with the existing authentication** — **Critical** — **Clarify / constraint**: JWT payload carries role; permissions should be resolved server-side per request (cached) rather than embedded in tokens, so changes take effect without re-login (D3).

## 8. Learning content and publishing workflows

**PUB-01 · Consistent workflow Draft → Pending Approval → Published, plus Changes Requested, Rejected, Archived, Unpublished** — **High** — **Partial**
- Evidence: assignments: DRAFT, PENDING_APPROVAL, PUBLISHED, REJECTED, ARCHIVED, CLOSED, recall/unpublish (`AssignmentStatus`, `AssignmentEvent`). Resources: `isPublished` flag set directly by coaches (`PATCH .../publish`, MENTOR/ADMIN) — no approval. Courses: DRAFT/PUBLISHED/ARCHIVED, admin only.
- Changes: shared workflow states for resources (and subjects/topics where needed); "Changes Requested" distinct from "Rejected" (Q7); per-type "approval required" setting.
- Models: `CourseResource.status` (replacing `isPublished` via expand–contract) · APIs: `PATCH .../submit|approve|request-changes|reject` · Permissions: `resources.publish`, `assignments.approve` · Tests: coach cannot publish when approval is required.

**PUB-02 · Transitions depend on permissions** — **High** — **Partial**: role-based today. Changes: permission checks per transition (PERM-03).

**PUB-03 · Editing published content creates a revision; published version stays until the revision is approved** — **High** — **Missing**
- Evidence: resource edits overwrite in place (`course-resources.service.ts` `update`), audit stores changed field names only; published assignments cannot be edited at all (`EDITABLE_STATUSES` = DRAFT/REJECTED).
- Changes: `ResourceRevision` (and later `AssignmentRevision`) with a pointer to the published revision; students always read the published revision.
- Tests: "A pending content revision does not replace an already published version" (§20).

**PUB-04 · Version history with who created, edited, reviewed and approved each version** — **High** — **Partial**: `AssignmentEvent` history for assignments (`GET /assignments/:id/history`); none for resources. Changes: revision events for resources.

## 9. Student support and services

The requirement says "replace or expand the existing Requests functionality". No student request feature exists today.
**Decided (Q1, ADR-012):** the public contact form stays for general enquiries from anyone; Student Support and Services is a
separate, authenticated portal for registered students, with reference numbers, assigned staff, status tracking, internal notes
and student-visible responses.

**SUP-01 · Students submit requests in categories (recommendation letters, certificates, coach meetings, academic, technical, general, admin-configured)** — **High** — **Missing**
- Changes: new `support` module. Models: `SupportCategory`, `SupportRequest` · APIs: `GET /support/categories`, `POST /support/requests` · Permissions: student `support.submit` · Depends on: storage, notifications.

**SUP-02 · Subject, description, attachments, unique reference number, status tracking, responses, notifications** — **High** — **Missing**
- Changes: reference numbers (e.g. `SR-2026-000123`, sequence per year), attachments via `FileObject` (new purpose SUPPORT), message thread.
- Models: `SupportRequest`, `SupportMessage`, `SupportAttachment` · APIs: `GET /me/support/requests`, `GET/POST /support/requests/:id/messages` · Tests: a student sees only own requests.

**SUP-03 · Staff: filter, assign, priority, status, request info, internal notes, respond, attach, close/reopen** — **High** — **Missing**
- APIs: `/admin/support/requests*` · Permissions: `support.manage` (all) or scope "assigned requests" · Tests: staff without scope cannot see unassigned requests.

**SUP-04 · Suggested statuses; workflow configurable where practical** — **Medium** — **Missing**: fixed status set first (D8), per-category enabled statuses later.

**SUP-05 · Internal staff notes separated from student-visible messages** — **Critical (safeguarding)** — **Missing**: `SupportMessage.visibility` INTERNAL/STUDENT, filtered server-side. Test (§20): "A student can track a support request but cannot access internal staff notes".

**SUP-06 · Coach meeting requests: purpose, preferred times, assigned coach, confirmation, status, outcome** — **Medium** — **Missing**: `SupportMeeting` linked to a request; submission never auto-confirms. Q8.

## 10. Communication groups and community

**GRP-01 · Independent groups (e.g. IMO2026), membership independent of courses and divisions** — **High** — **Partial**
- Evidence: `StudyGroup`, `StudyGroupMember` (roles STUDENT/MENTOR, membership history) and a full module (9 endpoints, `study-groups.service.ts` 317 lines) — **not registered** in `app.module.ts`, no tests.
- Changes: revive and extend as communication groups (D7): types, visibility, archive, group roles (owner/moderator/member).
- Models: `StudyGroup` (+ fields) or renamed · APIs: `/groups*` · Permissions: `groups.manage`, group-scoped roles.

**GRP-02 · Create, edit, archive, add/remove/invite members, assign group admins/moderators, membership visibility, messaging permissions** — **High** — **Partial** (create, edit, add/remove, role change, history exist in disabled code; invite, moderators, visibility and messaging settings missing).

**GRP-03 · Announcements, discussions, messages, replies, mentions, notifications, attachments, moderation/reporting** — **Medium** — **Partial**
- Evidence: discussion threads/comments/replies/reactions/reports/moderation exist for course and assignment scopes (`DiscussionThread`).
- Changes: add `groupId` scope to threads (reuse moderation), announcements (thread type), replies, mentions, notifications, comment attachments. **Decided (Q6, ADR-013): no private one-to-one messaging in the first release**; safeguarding and moderation rules apply to all group content.

**GRP-04 · Group administrators manage only their groups** — **Critical** — **Missing**: group-scoped permissions (PERM-04, scope type GROUP). Test (§20): "A group administrator cannot manage unrelated groups".

**GRP-05 · Targeted e-mails to groups, students, teachers, coaches, countries, schools, subjects; preview and confirmation; logged** — **High** — **Partial**
- Evidence: `POST /admin/email/send` with modes EXPLICIT/ROLE/DIVISION/SCHOOL/ALL, idempotency key, jobs and deliveries, retry, audit `CREATE_EMAIL_JOB` (E).
- Changes: audiences GROUP, COUNTRY, SUBJECT, TEACHER; preview endpoint (count + sample, no send); explicit confirmation token; scoped senders (group admins to their group only).
- APIs: `POST /admin/email/preview`, `POST /admin/email/send` (additive modes) · Permissions: `email.send` + scope.

## 11. Notifications

**NOT-01 · Topics: registration, resets, assignments, submissions, reviews/results, resources, publishing decisions, support, groups, announcements, mentions** — **High** — **Partial**: all except support, groups, mentions, publishing decisions for resources. Changes: new event types and categories (SUPPORT, GROUPS).
**NOT-02 · In-app and e-mail** — **High** — **Implemented — verified (P/X)**.
**NOT-03 · User preferences** — **Medium** — **Implemented — verified (E)**: per-category opt-out, per-type settings; account e-mails cannot be disabled.
**NOT-04 · Prevent duplicate notifications** — **Medium** — **Partial**: no uniqueness on notifications; e-mail sends are idempotent (job key, delivery idempotency key at Resend). Changes: optional `dedupeKey` with a unique index for event-driven notifications.
**NOT-05 · Handle delivery failures** — **High** — **Implemented — verified (E)**: retries with backoff, permanent failures, admin retry, failure counts in reports.
**NOT-06 · Delivery is not proof of reading** — **Low** — **Implemented (by design)**: in-app read state is separate; e-mail status is SENT/FAILED only. Clarify if read receipts are wanted (Q18).

## 12–15. Portals and role experiences

**ADM-01 · Admin Portal covers 20 areas** — **High** — **Partial**: backend APIs exist for 12 of 20 (dashboard, users, registration (partly), academic years, courses/divisions, coach assignments, content, assignments, e-mail, notifications, reports, audit, settings); missing for countries, schools management, subjects/topics, publishing approvals for resources, support, groups, permission profiles.
**ADM-02 · Admins see only permitted functions** — **Critical** — **Partial**: `GET /me/permissions` exists; must return the effective permissions and scopes from PERM-02..04.
**UX-01 · Modern login/registration visuals; preserve authentication** — **Medium** — **Frontend only**; backend: no change to auth endpoints (constraint respected).
**STU-01 · Student experience: subjects, authorized courses, topics, assignments, results, leaderboards, groups, notifications, support** — **High** — **Partial**: everything except subjects/topics browsing, enrollment-based access, groups, support.
**TCH-01 · Teacher and coach dashboards scoped to assignments** — **High** — **Partial**: coach scope exists (course × division); teacher capabilities defined by ADR-003 (to implement).

## 16. Security, privacy and safeguarding

**SEC-01 · Secure passwords, sessions, backend authorization, validation, rate limiting, file access, upload validation, common web protections, env handling** — **Critical** — **Implemented — verified (E/P)**: bcrypt cost 12; rotating refresh cookie; lockout; throttling; whitelist validation; content-type detection; private streamed downloads; helmet/CSP; env validation at start-up. Gap: password policy minimal (8 chars, letter+number) — Q19.
**SEC-02 · Backup and recovery procedures** — **High** — **Partial**: documented (`docs/DEPLOYMENT.md`, Neon point-in-time restore, `deploy/free-tier` backup script); **restore never tested**. Changes: tested restore drill before schema migrations.
**SEC-03 · Protection of minors: restrict student/guardian contact data, restrict private communication, moderation, record access to sensitive data, data minimisation** — **Critical** — **Partial**: moderation/reporting exist; no private messaging exists; no sensitive-read auditing; guardian data not yet stored. Changes: `users.viewSensitive` permission, field masking by default, `VIEW_SENSITIVE_PROFILE` audit entries.
**SEC-04 · Data retention, correction, export, deletion** — **High** — **Partial**: retention job (activity, notifications, sent e-mail bodies); correction limited; **no per-user data export**; deletion = ACC-13/14. Changes: `GET /admin/users/:id/data-export` (JSON), self-service request via support (Q16).
**SEC-05 · No sensitive data in URLs, public responses, e-mail logs or audit records** — **High** — **Implemented — partly verified (E)**: tokens hashed at rest; e-mail bodies erased after sending; audit never stores passwords/tokens; reset/activation tokens necessarily appear in e-mailed links (single-use, short-lived). Changes: keep guardian/DOB out of audit metadata and URLs.
**SEC-06 · Safe migrations** — **Critical** — **Partial**: CI builds an empty DB from migrations and checks drift; no down-migrations; **migration naming hazard** (section 12.1).

## 17. Technical architecture

**ARC-01 · Separate apps, documented contracts, consistent errors** — **High** — **Implemented — verified (E/X)**: OpenAPI generated and CI-checked; single error shape.
**ARC-02 · Validation, pagination, transactions** — **High** — **Implemented — verified (E)**.
**ARC-03 · Safe, reversible migrations preserving records** — **Critical** — **Partial**: forward-only Prisma migrations; adopt expand–contract and per-migration rollback SQL (DATABASE_CHANGE_PLAN §3).
**ARC-04 · Environment separation dev/staging/prod; no unnecessary paid services** — **Medium** — **Partial**: dev and prod exist; **no staging**. A staging stack on free tiers is recommended before large migrations (Neon branch + second Render service).

## 18. Audit logging

**AUD-01 · Important actions logged with actor, action, resource, timestamp** — **High** — **Implemented — verified (E)**: 92 actions, 15 categories; append-only trigger.
**AUD-02 · Previous and new values without secrets** — **Medium** — **Partial**: before/after diffs only in user updates/status; other updates record field names. Changes: shared `diff()` helper for all updates in new modules and resource/course edits.
**AUD-03 · Not editable by ordinary users** — **High** — **Implemented — verified (E)**: database trigger rejects UPDATE/DELETE.
**AUD-04 · Coverage for new areas (subjects, permissions, support, groups, exports)** — **High** — **Partial**: add categories PERMISSIONS, REFERENCE_DATA, SUBJECTS, SUPPORT, GROUPS.

## 19. Performance and accessibility

**PERF-01 · Large datasets, efficient queries, pagination** — **High** — **Implemented — verified (E)**: paginated lists, reporting indexes, FK indexes.
**PERF-02 · Large file uploads handled safely** — **Medium** — **Partial**: limits per purpose (10–50 MB) but uploads are buffered in memory (`multer.memoryStorage`) on a 512 MB Render instance; concurrent large uploads risk memory exhaustion. Changes: stream to storage or lower concurrency (later).
**PERF-03 · Responsive, accessible UI** — **Medium** — **Frontend only**.

---

## 12. Investigation of audit observations

### 12.1 Migration `20261120000000_email_html_body` has a "future" timestamp

**Verified status:** applied in production on 2026-11-07 14:54 UTC, 1 step, not rolled back; all 17 migrations applied, no drift.

**Explanation:** migration folder names in this repository are **sequence numbers written as dates**, not creation
times. All 17 were created between 2026-11-03 and 2026-11-07 (git history) and numbered one "day" apart:
`20261103…` to `20261120…`. Prisma only uses the name to **order** migrations, so production is correct.

**Risk:** `prisma migrate dev` names new migrations with the **current** time. Any migration created before
2026-11-21 (e.g. `20261108…`) would sort **before** already-applied migrations; Prisma's shadow database replays
in name order, so a new migration that alters tables created by `20261109…`–`20261120…` would fail or apply in
the wrong order.
**Rule:** name every new migration manually after the last one — `20261121000000_…`, `20261122000000_…` — or
use real timestamps only once the calendar is past the last name. Add a CI check that new migration names
sort after the latest one on `main` (BACKEND_TEST_PLAN §6).

### 12.2 Unmerged backend commits

| Branch | State |
|---|---|
| `origin/main` | `5eec460` — deployed on Render |
| `origin/develop` | `main` + two pull-request merge commits (#1, #2); same content as `main`, does **not** contain `cc27c8d` |
| `origin/feature/backend-completion` | `cc27c8d` (quoted e-mail settings) |
| local `feature/backend-completion` | + `962e1f0` (docs), `f624d25` (storage start-up log, finalization report); untracked: `PRELIMINARY_BACKEND_AUDIT.md`, `ROF_LMS_CONSOLIDATED_REQUIREMENTS.md`, these audit documents |

**Recommended integration strategy:** (1) commit the requirements and audit documents on the feature branch;
(2) push and open one pull request `feature/backend-completion → main` (3 small, tested commits); merge when CI
is green; Render deploys; (3) **keep `develop`** (Q22, decided 2026-11-08) and align it with `main` once the pull request is merged; (4) start each workstream on its own branch from `main`
(`feature/permissions-foundation`, …), one pull request per approved step, CI required, deploy only after
review. Database migrations ship in their own pull requests and are applied to production only after explicit
approval.

### 12.3 Frontend production URL returns a Netlify 404

`https://roflms.netlify.app` serves Netlify's "Page not found" on every path. Cause reproduced: a clean build of
frontend `main` stops at `API_PROXY_TARGET must be set…`; the fix is on frontend branch
`feature/production-readiness` (not deployed). **Impact:** no user can use the platform in production today; all
password-reset/activation links (which correctly point to the Netlify site) lead to a 404; no browser testing
of the live system is possible; new backend features cannot be validated end to end in production until the
frontend is deployed. Not fixed in this audit, as instructed.

### 12.4 Production R2 uploads not verified

`/health` reports storage up and is ~300 ms slower than a database-only call, consistent with a live R2
bucket check — evidence of connectivity, **not** of write permission. No object has been written or read in
production. New features add more uploads (avatars, support attachments, subject icons), so a controlled
production upload/download test (DEPLOYMENT checklist) should precede them. The start-up log added in `f624d25`
names the active storage once deployed.

---

## 13. Questions that need answers before implementation

| # | Question | Blocks |
|---|---|---|
| Q1 | **Answered:** keep both; Support is a separate authenticated portal (ADR-012). ~~"Existing Requests functionality": none exists for students. Should Support replace the public contact form, sit alongside it, or absorb coach-meeting and resubmission requests?~~ | SUP-* |
| Q2 | **Answered:** ADR-003 (teacher default rights; more only by grant). ~~What may **teachers** do: view content only, upload resources, create assignments, grade, manage groups? Are they tied to schools?~~ | REG-01/05, TCH-01, permissions |
| Q3 | Hierarchy: should today's math courses become **topics** (with courses inside), or stay courses with a topic above them (recommended, D1)? May a course belong to several topics? | SUB-03/04 |
| Q4 | **Answered:** per-course setting; existing courses keep division access; new courses require enrollment by default (ADR-006). ~~Course access: should restricted courses require admin-granted enrollment, student self-enrollment with approval, or both? Should existing division-wide courses stay open?~~ | REG-04, ACA-05 |
| Q5 | "Organisational role": free-text title, or a managed list with meaning in permissions? | PERM-01 |
| Q6 | **Answered:** no private one-to-one messaging in the first release (ADR-013). ~~Group "messages": announcements and threaded discussions only, or member-to-member private messages (safeguarding for minors)?~~ | GRP-03 |
| Q7 | Difference between "Changes Requested" and "Rejected" for content; which content types require approval? | PUB-01 |
| Q8 | Meeting requests: scheduling inside the platform (time slots, calendar) or coordination only (proposed times + confirmation)? | SUP-06 |
| Q9 | Should one person be able to hold several user types (e.g. teacher and coach)? | REG-01, D2 |
| Q10 | Which registration fields may admins make optional/mandatory? | REG-09 |
| Q11 | Must phone numbers (student/guardian) be unique? Format (E.164)? | REG-02, REG-14 |
| Q12 | Countries: seed all ISO countries (inactive by default) or only countries ROF works with? | INT-01 |
| Q13 | How many geographic levels are needed (region only, or region + district + city)? | INT-02 |
| Q14 | School administrators: platform users with school-scoped permissions, or contact records only? | INT-06 |
| Q15 | Do academic years differ by country/education system? | ACA-01 |
| Q16 | Retention periods and who may permanently delete or export personal data? | ACC-14, SEC-04 |
| Q17 | Can students change school/grade themselves, or does it need approval? | ACC-15 |
| Q18 | Are e-mail open/read receipts wanted? (Not recommended for minors.) | NOT-06 |
| Q19 | Password policy for the international launch (length, breached-password checks)? | SEC-01 |

---

## A–H. Overall assessment

### A. Overall readiness

The backend is **production-grade for its current scope** (assessment workflow, authentication, notifications,
e-mail, files, audit, reports; 482 unit + 289 e2e tests, all 202 routes covered). Against the consolidated
requirements it is **about a quarter complete**: 25 of 102 requirements are implemented (most verified), 52 are partial (mostly extensions of existing modules), 21 are missing, and 4 are frontend-only or need clarification. The missing parts are
foundational (permissions with scopes, reference data, subjects/topics, account states, versioning) plus two
new modules (support, groups). It is **ready to start Phase 2 (architectural foundation)** once the decisions in
B are approved; it is **not ready to implement features** before those decisions, because each foundation
changes tables and contracts that later work depends on.

### B. Architectural decisions — approved design direction (2026-11-08, subject to final implementation review)

Full records: [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md). D-numbers below map to ADRs there.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Subject/topic hierarchy | Evolve `Discipline` into **Subject** (same table, new fields, API name `subjects`, `/disciplines` kept as alias); add **Topic** under Subject; keep **Course** as the container for resources and assessments with an optional `topicId`; backfill one topic per existing math course. No change to assignment/submission/result tables. |
| D2 | Teacher as a user type | Add `TEACHER` to the user type (`Role`) — one type per user (unless Q9 says otherwise); fine-grained powers come from profiles, not new types. |
| D3 | Permission model | Keep the code-defined **permission catalogue**; add data-driven **profiles**, **per-user assignments with scope** and **overrides**; resolve effective permissions server-side per request (cached), not in the JWT; seed system profiles that reproduce today's three roles exactly; existing `@Roles` routes keep working and migrate gradually. |
| D4 | Course access | **Approved:** `Course.accessPolicy`; existing courses `DIVISION_OPEN`; **new courses `ENROLLMENT_REQUIRED` by default**; changes only by permitted admins, audited, with confirmation when access widens. |
| D5 | International structure | Reference tables `Country`, `EducationSystem`, `GradeLevel` (+ optional `Region`); replace the `GradeLevel` enum by expand–contract; Rwanda seeded with P1–P6, S1–S6; divisions mapped to grade levels in data. |
| D6 | Account states | Explicit `User.status` with a transition table and history, backfilled from `activatedAt/isApproved/isActive`; delete becomes archive (soft delete); permanent delete restricted. |
| D7 | Communication groups | Revive the existing study-groups module as communication groups; reuse discussion threads (new `groupId` scope) and moderation; announcements as a thread type; **no private messaging** in the first release. |
| D8 | Support workflow | Fixed status set with allowed transitions; categories configurable as data; per-category settings later. |
| D9 | Registration applications | Generalise `MentorRequest` into a registration application for coaches **and** teachers (keep `/mentor-requests` working). |
| D10 | Content versioning | Revision tables per content type, starting with resources; published pointer stays until a revision is approved. |
| D11 | Migration practice | Expand–contract migrations, manual sequential names after `20261120000000`, rollback SQL per migration, rehearsal on a Neon branch with production data before applying. |
| D12 | Staging | A free-tier staging environment (Neon branch + second Render service + Netlify preview) before Phase 3 migrations reach production. |

### C. Implementation sequence (approved)

0. **Stabilise existing work:** review pending backend commits and prepare their pull request; fix and deploy the frontend Netlify 404; regression baseline; verify database backup and restore; verify a Cloudflare R2 upload and download; add the migration-naming CI check.
1. **Permission foundation.**
2. **Countries, education systems, grades and schools.**
3. **Dynamic subjects and topics.**
4. **Account statuses and lifecycle.**
5. **Registration by user type** (including TEACHER).
6. **Course access and enrollment.**
7. **Content publishing and versioning.**
8. **Student Support and Services.**
9. **Communication groups and targeted e-mail.**
10. **Notifications, audit and privacy improvements.**

Frontend work follows each phase once its backend APIs are verified.

### D. Database migration risks

- **Enum replacement** (`GradeLevel`, possibly `DivisionCode`, `Role` addition): touches `User`, `StudentEnrollment`, division mapping, reports — must be expand–contract with backfill verification.
- **Account status backfill**: an error would lock users out or re-activate suspended accounts; verify counts per derived state before and after.
- **School uniqueness change** (global → per country): existing duplicates must be checked before the new index.
- **Topic backfill and Discipline evolution**: must keep every course/assignment/resource/submission ID and link (Mathematics preservation, §20).
- **Migration naming hazard** (12.1).
- **Production is the only real dataset** (1 user, 4 courses, 0 assignments today) — low data volume now, so the best time for structural changes is **before** real users arrive.
- **No tested restore** yet; no staging.

### E. API compatibility risks

- `DELETE /admin/users/:id` would change from hard delete to archive — semantics change (document, keep response shape).
- `gradeLevel` (enum string) → object/ID: keep the string field in responses; add `gradeLevelId`/object additively.
- `role` gains `TEACHER`: frontend switch statements and role guards must handle it.
- `/me/permissions` shape: extend (add `scopes`, `profiles`) without removing the current list.
- `isPublished` on resources → `status`: keep `isPublished` derived in responses during transition.
- New required registration fields (guardian phone, country) would break old clients: make them required only once the frontend sends them (feature flag via settings).
- Endpoint renames (`disciplines` → `subjects`, `mentor-requests` → applications): keep old paths as aliases.

### F. Can reuse existing functionality

| New need | Reuse |
|---|---|
| Subjects | `Discipline` table and `GET /disciplines` |
| Communication groups | disabled `study-groups` module (membership, roles, history), discussions + moderation + reports |
| Targeted e-mail | `EmailJob`/`EmailDelivery` outbox, worker, idempotency, retry, audit |
| Support attachments, avatars, subject icons | `StorageService` (type detection, size rules, private streaming, R2) |
| Support/group notifications | `NotificationsService` (in-app + e-mail, categories, preferences) |
| Registration review | `MentorRequest` approval flow, activation tokens, invitation e-mails |
| Publishing workflow | assignment workflow pattern (`AssignmentStatus`, `AssignmentEvent`, history endpoint) |
| Scope checks | `AccessService` (coach course × division) |
| Imports/exports | users CSV import (dry run), CSV report helpers, `EXPORT_REPORT` audit |
| Audit of everything new | `AuditService`, categories, append-only trigger, CSV export |
| Account history | audit log + activity log filters |

### G. Genuinely new implementation

Permission profiles, scoped assignments and grant-escalation checks; country/education-system/grade/region
reference data; topic level; explicit account states and soft delete; content revisions; the student support
module (requests, messages with internal/student visibility, reference numbers, meetings); group-scoped
permissions and announcements; recipient preview for bulk e-mail; per-user data export; sensitive-read auditing.

### H. First actions

**Phase 0, first action (needs the owner's go-ahead to push):** commit the requirements and audit documents on
`feature/backend-completion`, push the branch and open the pull request `feature/backend-completion → main`
for review (three tested commits + documents). Nothing is merged or deployed without approval.

**First implementation task (Phase 1, after Phase 0):** permission foundation step 1, with no behaviour change —
see [BACKEND_IMPLEMENTATION_PLAN.md](BACKEND_IMPLEMENTATION_PLAN.md) §6.
