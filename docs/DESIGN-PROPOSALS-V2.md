# Design proposals v2 — for owner approval (2026-11-18)

**What this is.** Ten design proposals for the parts of the approved scope that still need decisions. Every area here
is **in scope** (approved direction in `ARCHITECTURE_DECISIONS.md`); none of them is dropped because it needs a decision.
Nothing in this file is implemented, and nothing will be implemented before you approve the design.

**What changed from v1 (`docs/DESIGN-PROPOSALS.md`, 2026-11-17):**

- Every proposal now has the same 11 sections, followed by two lists: **decisions needed from you** (each with a
  recommended answer and the alternatives) and **work that can start as soon as the design is approved**.
- v1 D6 is split into **6 Groups and privacy** and **7 Targeted e-mail**; v1 D7 is split into **8 Data privacy and
  retention** and **10 Account states**.
- Each proposal states what **exists in the code today** (tables, routes, permissions, screens) and what is **new**.
- All v1 options, questions and recommendations are kept. Three v1 statements were factually wrong when checked
  against the code; they are corrected where they appear and listed in "Corrections to v1" at the end.

**Rules that apply to every proposal** (not repeated below): every route is behind a named permission from
`src/auth/permissions.ts` (default deny, checked on the server); students are minors — no contact data, dates of
birth or identities beyond what the task needs; every change is audited with previous and new values in the same
transaction (`src/audit/audit-changes.ts`); migrations are additive, named after the newest existing one
(`20261210000000_teacher_student_access`, ADR-015 rule 1), each with a rollback that **refuses to run while it would
lose data**; existing IDs and relationships never change (ADR-007, ADR-015); new features are advertised as
capabilities in `GET /api/v1` so older frontends keep working; tests = backend e2e on PostgreSQL, frontend unit tests
and Playwright browser tests per workflow; nothing destructive and nothing on production without your approval.

## Index

| # | Area | Requirement IDs | ADRs | Your decisions | Recommended first step |
|---|---|---|---|---|---|
| 1 | Countries and education systems | INT-01, INT-02, INT-03, REG-02 (grades), REG-03, ACA-02 | 005, 015 | 4 | Seed countries + Rwanda grades as reference data, no change to students yet |
| 2 | Subjects and topics | SUB-01…06, SUB-07, STU-01 | 007, 018 | 4 | Subject admin on the existing `Discipline` table + Topic table |
| 3 | Course enrollment and access | REG-04, ACA-03, ACA-05 | 006 | 3 | Access policy column (all existing courses DIVISION_OPEN) + grant table |
| 4 | Publishing and versioning (incl. teacher content submission) | PUB-01…04, NOT-01, AUD-04 | 003, 010, 011 | 5 | Shared states + revisions for resources (coaches and admins) |
| 5 | Student support portal | SUP-01…06, PERM-04 | 012 | 3 | Requests, staff queue and internal notes (no meetings yet) |
| 6 | Groups and privacy | GRP-01…04, PERM-04, SEC-03 | 013, 018 (H7) | 4 | Re-enable the study-groups module as administrator-only groups |
| 7 | Targeted e-mail | GRP-05 | 014, 018 | 3 | Audience model on the existing bulk e-mail outbox |
| 8 | Data privacy and retention | SEC-04, SEC-03, ACC-14, ACC-16 | 008, 015 | 5 | Personal data export (read-only, audited) |
| 9 | Configurable registration fields | REG-09 | 009 | 3 | Server-side enforcement of today's required fields |
| 10 | Account-state model (4 stored vs 6 in ADR-008) | ACC-12, ACC-13 | 008 | 3 | Six-state filter on the user list (no data change) |

---

## 1. Countries and education systems

*Phase 2 · ADR-005 · INT-01…03, REG-02 (grades), REG-03, ACA-02 · v1 D1*

### 1.1 Purpose and expected user experience
ROF is launching internationally. Administrators keep a list of countries (switch each on or off), each country's
regions, and its education system with ordered grades (Rwanda: P1–P6 and S1–S6). A student registering picks a country
first; the regions, schools and grades shown then belong to that country. Rwanda keeps its full Province → District →
Sector → School directory exactly as today. Existing students see no change: an S3 student is still S3 and Junior.

### 1.2 Relevant user roles
| Role | Capability |
|---|---|
| Super Admin, Administrator | manage countries, regions, education systems, grades, grade → division mapping |
| Student (registering) | choose country → region → school → grade |
| Teacher / Coach applicants | choose country (already stored as ISO code) |
| Head Coach, Coach, Teacher | read only (see grade labels) |

### 1.3 Screens and navigation
- **New:** Admin → *Reference data* with tabs Countries, Regions, Education systems & grades.
- **Changed:** `app/(auth)/register` (country picker first; grade list per country); `app/(auth)/register/teacher` and
  `app/(auth)/apply` (country list from the reference table); `app/admin/schools` (country filter and column).
- **Unchanged:** `app/admin/academic-years`, `app/admin/divisions` (divisions remain Junior / Senior).

### 1.4 Frontend functionality
Country list with search, active switch, phone prefix; region editor (one level); grade editor with drag-to-reorder
and a division per grade; registration fetches `GET /countries?active=true` and then grades and regions for the chosen
country; grade labels shown from `grade.label` (fallback to `gradeLevel` for older backends; capability `countries`).

### 1.5 Backend APIs and services
**Exists:** `School.countryCode` (ISO alpha-2, default `RW`), `User.country`, `GradeLevel` enum S1–S6,
`src/common/grade-levels.ts` (S1–S3 → JUNIOR), `EducationLevel` table (school offerings PPR, PR, OL, AL, PE).
**New:** public, cached `GET /countries`, `GET /countries/:code/grades`, `GET /countries/:code/regions`; admin
`GET|POST|PATCH /admin/countries…`, `/admin/education-systems…`, `/admin/grades…`. Responses keep `gradeLevel` and add
`grade { code, label }`. Grade → division moves from code to data (`GradeLevelRef.divisionId`).

### 1.6 Database changes and migration requirements
New `Country` (ISO alpha-2 primary key, name, isActive, phonePrefix, educationSystemId), `Region` (countryCode, name,
parentId nullable), `EducationSystem` (name), `GradeLevelRef` (systemId, code, label, order, divisionId nullable). Kept
apart from the existing `EducationLevel` table, which describes what a *school* offers, not a student's grade.
Expand–contract: add `User.gradeLevelRefId` **and** `StudentEnrollment.gradeLevelRefId` beside the enum columns,
backfill S1…S6 → Rwanda rows, switch reads, drop the enum only in a later, separately approved migration.
`School.countryCode` gets a foreign key to `Country` after a check that every code exists. Rollback refuses if any
non-Rwanda grade or region is in use.

### 1.7 Permissions and security
New `reference.manage` (Administrator, Super Admin; global; added to the frozen ADMIN list additively). Public read
routes expose reference data only. Deactivating a country hides it from registration but never touches existing users.

### 1.8 Notifications and email behavior
None. Reference-data changes are audited, not notified.

### 1.9 Dependencies
None blocking. Areas 2 (subject availability per country), 7 (country audience) and 9 (fields per country) build on it.

### 1.10 Test scenarios
Backfill maps every existing student and enrolment (count before = after; S1–S3 Junior, S4–S6 Senior); responses keep
`gradeLevel`; a Kenyan registration offers only Kenyan grades and regions; an inactive country is refused at
registration; `reference.manage` denied to Coach, Head Coach, Teacher, Student; rollback refuses with a non-Rwanda grade
in use; older frontend (no capability) still registers a Rwandan student.

### 1.11 Recommendation
Do it in two steps: (a) reference tables, admin screens and the registration picker with Rwanda behaviour unchanged;
(b) the expand–contract switch of grades. Seed all ISO countries inactive and switch on only where ROF operates.

**Decisions needed from the owner**
1. Q12 — Country list? **Recommended:** all ISO countries seeded, inactive by default. *Alternative:* a curated list.
2. Q13 — Geographic levels outside Rwanda? **Recommended:** one optional region level. *Alternative:* two or more levels.
3. Q15 — Academic years? **Recommended:** one global academic year for now. *Alternative:* per education system.
4. May primary pupils (P1–P6) register? **Recommended:** not in release 1 (grades seeded but inactive for registration).
   *Alternative:* yes, which needs a third "Primary" division and courses for it.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- `Country`, `EducationSystem`, `GradeLevelRef` tables with Rwanda seeded; admin screens; public read routes.
- Registration country picker (Rwanda flow unchanged); the expand step of grades (new columns + backfill + tests).

---

## 2. Subjects and topics

*Phase 3 · ADR-007, ADR-018 · SUB-01…06, SUB-07, STU-01 · v1 D2*

### 2.1 Purpose and expected user experience
Administrators add new subjects (Physics, Computing, AI…) without a developer: name, code, description, icon, order and
status (Draft, Published, Inactive, Archived). Under a subject they add topics (add, rename, reorder, deactivate,
archive), and a course can belong to a topic. A subject can be limited to certain grades, countries or programmes.
Each new subject is also a programme, so Head Coaches and programme membership work for it immediately. Students choose
their interests from the published subjects. Mathematics and its four courses keep working unchanged.

### 2.2 Relevant user roles
| Role | Capability |
|---|---|
| Super Admin, Administrator | create / edit / publish / archive subjects and topics; set availability; create courses |
| Head Coach | read topics and courses of their programme(s) |
| Coach | sees topics of courses they are assigned to |
| Student | sees published subjects → topics → courses available to them; picks interests |
| Teacher | sees subject names (for interests and, later, content submission — area 4) |

### 2.3 Screens and navigation
- **New:** Admin → *Subjects* (list, subject page with Topics tab and Availability tab); course create / edit form.
- **Changed:** `app/admin/courses` (topic column, "new course" button), `app/admin/programmes` (lists all subjects),
  `app/student/courses` (grouped by subject and topic), registration interest list (from published subjects).

### 2.4 Frontend functionality
Subject form with icon picker and status; topic list with drag-to-reorder; availability matrix (grades × countries ×
programmes); course form (subject, topic, code, title, description); student catalogue grouped by subject → topic.

### 2.5 Backend APIs and services
**Exists:** `Discipline` table (code, name, description, isActive, sortOrder; only MATHEMATICS), `GET /disciplines`,
`/programmes` and `/admin/programmes/:id/heads|members` (a programme **is** a `Discipline` row, ADR-018),
`OlympiadSubject` enum (MATHEMATICS, COMPUTING, PHYSICS) on `User.olympiadInterests` and applications,
`PATCH /admin/courses/:id` (+ publish / unpublish / archive). **There is no course-creation route today**: the four
Mathematics courses are seeded.
**New:** `GET /subjects` (alias of `/disciplines`, which stays), `/admin/subjects…` CRUD + status transitions,
`/admin/subjects/:id/topics…`, `/admin/subjects/:id/availability`, `POST /admin/courses` (create), `topicId` on course
responses.

### 2.6 Database changes and migration requirements
`Discipline` stays the table (same IDs): add `icon`, `status` (DRAFT / PUBLISHED / INACTIVE / ARCHIVED; MATHEMATICS →
PUBLISHED), `publishedAt`. New `Topic` (subjectId, name, order, status). `Course.topicId` nullable; migration creates one
topic per existing Mathematics course (Algebra, Geometry, Number Theory, Combinatorics) and links it. New
`SubjectAvailability` (subjectId × gradeLevelRef / country / programme). Interests: add `User.interestSubjectIds`
(and on applications) beside `olympiadInterests`, backfilled by code (MATHEMATICS → the Mathematics row; COMPUTING and
PHYSICS → new subject rows created by the migration, status DRAFT). Rollback refuses once a non-Mathematics course
exists. **Naming note:** the existing `Programme` table (A-Level combinations and TVET trades of schools, school
directory S1) is unrelated to ADR-018 "programmes"; the API keeps them apart (`/programmes` = subjects).

### 2.7 Permissions and security
New `subjects.manage` (Administrator, Super Admin, global). Creating courses uses existing `courses.manage`. Head Coach
scope stays programme-limited (`AccessService`); anything outside answers 404. A subject in DRAFT is invisible to
students and to public registration.

### 2.8 Notifications and email behavior
None in the first step. Optional later: "new subject available" in-app notice to students of matching grades
(not proposed now).

### 2.9 Dependencies
Area 1 for availability by country and grade (availability by programme works without it). Area 4 (teacher scope by
subject) and area 7 (subject audience) build on this.

### 2.10 Test scenarios
Mathematics IDs, courses, memberships and student access unchanged (SUB-07 regression); a new subject creates a working
programme (Head Coach appointment, membership); DRAFT subject hidden from students and registration; course in one
topic; availability by grade hides the subject from other grades; `/disciplines` and `/subjects` return the same rows;
interest backfill exact for every user; `subjects.manage` denied to every non-admin role.

### 2.11 Recommendation
Implement subjects + topics + course creation first; availability second (needs area 1 for grades and countries).
Keep one topic per course.

**Decisions needed from the owner**
1. Q3 — May a course belong to several topics? **Recommended:** one topic only. *Alternative:* several (many-to-many).
2. Is every subject also a programme (one-to-one, Head Coaches per subject)? **Recommended:** yes, as today.
   *Alternative:* programmes grouping several subjects (needs a new programme table).
3. Interest mapping: MATHEMATICS, COMPUTING, PHYSICS → subjects of the same codes? **Recommended:** yes.
   *Alternative:* keep interests as a separate fixed list.
4. (New in v2 — code fact) Administrators create courses in the portal (no course-creation route exists today)?
   **Recommended:** yes, with `courses.manage`. *Alternative:* courses created only by a developer seed.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- `subjects.manage`, subject status columns, `Topic` table, topic per Mathematics course, `/subjects` alias, admin screens.
- Course creation (if decision 4 is yes). Availability by programme; by grade / country after area 1.

---

## 3. Course enrollment and access

*Phase 6 · ADR-006 · REG-04, ACA-03, ACA-05 · v1 D3*

### 3.1 Purpose and expected user experience
Each course shows who may see it. **Open to the division** (today): every Junior (or Senior) student sees it.
**Enrollment required**: only students who were enrolled see it, its resources, assignments and discussions.
Administrators (and, if approved, Head Coaches for their programme) enroll students one by one, by CSV, or by a rule
(grade, school). Opening a closed course to a whole division asks for confirmation and shows how many students will
gain access. Registering on the platform is not the same as being enrolled in a course.

### 3.2 Relevant user roles
| Role | Capability |
|---|---|
| Super Admin, Administrator | set access policy; enroll / revoke individually, by CSV, by rule |
| Head Coach | enroll / revoke within their programme (decision 2) |
| Coach | sees the enrolled list of their course × division (read) |
| Student | sees only courses open to the division or where enrolled |
| Teacher | no course access (owner decision 2026-11-14) |

### 3.3 Screens and navigation
- **Changed:** `app/admin/courses` (access badge; *Access* tab on a course with policy switch and enrollment list);
  `app/mentor/programme` (enrollments for Head Coaches, if approved); `app/student/courses` (only accessible courses).
- **New:** confirmation dialog for widening; CSV enrollment upload with preview (reuses the bulk-operation pattern).

### 3.4 Frontend functionality
Policy switch with the "N students will gain access" preview; enrollment table (search, source, granted by, date,
revoke with reason); add by user search, CSV or rule; students never see a course they cannot open.

### 3.5 Backend APIs and services
**Exists:** `Course.status` (DRAFT / PUBLISHED / ARCHIVED), division-based access in `AccessService`,
`CourseEnrollment` = per-student **progress** (UNROLLED / ROLLED / COMPLETED, created on first open),
`enrollments.manage` (Admins; used for academic-year `StudentEnrollment`).
**New:** `PATCH /admin/courses/:id/access { policy, confirm }` (preview without `confirm` returns the count),
`GET|POST /admin/courses/:id/access-grants`, `POST …/access-grants/bulk` (CSV / rule, via the bulk-operation worker),
`DELETE …/access-grants/:grantId` (revoke with reason); optional `POST /courses/:id/enrollment-requests`
(decision 3). All student course, resource, assignment and discussion queries evaluate the policy in one place.

### 3.6 Database changes and migration requirements
`Course.accessPolicy` enum (DIVISION_OPEN, ENROLLMENT_REQUIRED); migration sets every existing course to DIVISION_OPEN
explicitly. **Correction to v1:** v1 proposed turning `CourseEnrollment` into the grant record. That table records
progress and is created automatically when any division student opens a course (`schema.prisma`, `CourseEnrollment`
"Per-student course progress. Created on first open."), so existing rows would wrongly look like grants. Proposed
instead: new `CourseAccessGrant` (courseId, studentId, source MANUAL / CSV / RULE / REQUEST, grantedById, reason,
createdAt, revokedAt, revokedById); progress stays in `CourseEnrollment`. Rollback refuses while any course is
ENROLLMENT_REQUIRED or any grant exists.

### 3.7 Permissions and security
New `courses.manageAccess` (ADR-006; Administrator, Super Admin global; Head Coach programme scope if decision 2 = yes).
Widening requires `confirm: true`, is audited with the newly entitled count; narrowing applies immediately and ends
access on the next request. Students outside a course get 404 (existence not revealed).

### 3.8 Notifications and email behavior
In-app notice to a student when enrolled (category ACCOUNT is not used; new category COURSES, e-mail switchable).
No notice on revocation (avoid upsetting minors; staff see the history). Bulk enrollment notifies once per student.

### 3.9 Dependencies
Area 2 (courses created in the portal) makes ENROLLMENT_REQUIRED useful; works without it for the existing four courses.

### 3.10 Test scenarios
Regression: every existing course DIVISION_OPEN and every student sees exactly what they saw before; enrollment-only
course hidden from a non-enrolled student in list, detail, resources, files, assignments, threads (404); widening
without `confirm` changes nothing and returns the count; revoking removes access immediately; Head Coach cannot enroll
outside their programme; CSV with unknown usernames reports per row; Teacher has no access either way.

### 3.11 Recommendation
Approve with a separate `CourseAccessGrant` table. Keep the ADR default for new courses (ENROLLMENT_REQUIRED) and
start without student requests.

**Decisions needed from the owner**
1. Default policy for **new** courses? **Recommended:** ENROLLMENT_REQUIRED (ADR-006 text). *Alternative:* DIVISION_OPEN.
2. May Head Coaches enroll students in their programme's courses? **Recommended:** yes, programme-scoped.
   *Alternative:* Administrators only.
3. Student-initiated enrollment requests? **Recommended:** no in the first step. *Alternative:* yes, approved by staff.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- `accessPolicy` column (existing courses DIVISION_OPEN), `CourseAccessGrant`, one access check for all student queries,
  admin enrollment screens, widening confirmation. Decision 2 only adds a scope; decision 3 is a later add-on.

---

## 4. Publishing and versioning (including teacher content submission)

*Phase 7 · ADR-010, ADR-011, ADR-003 · PUB-01…04, NOT-01, AUD-04 · v1 D4*

### 4.1 Purpose and expected user experience
One workflow for learning materials and assignments: Draft → Pending approval → Published, with Changes requested
(goes back to the author), Rejected (closed), Unpublished and Archived. Editing something already published creates a
new version; students keep seeing the published version until the new one is approved. A history shows who created,
edited, reviewed and approved each version. Coaches keep publishing their own materials directly (ADR-011); teachers
always submit for approval (ADR-003) — this is where **teacher content submission** lives (moved to Phase 7; not excluded).

### 4.2 Relevant user roles
| Role | Resources | Assignments |
|---|---|---|
| Coach | create, edit, publish directly (as today) in assigned course × division | prepare → submit for approval (as today) |
| Teacher | create → submit for approval (scope per decision 3) | only with an individual grant (ADR-003) |
| Head Coach | review in their programme (decision 4) | no approval (H5) |
| Administrator, Super Admin | approve / request changes / reject / unpublish / archive | publish (as today) |
| Student | sees the published version only | sees published only |

### 4.3 Screens and navigation
- **Changed:** `app/admin/courses/resources` (status column, *Review queue* tab, version history drawer),
  `app/mentor/courses` (draft / revision state, "submit changes"), `app/admin/assignments` (shared state labels).
- **New:** Teacher portal → *My contributions* (`app/teacher/contributions`: create, submit, see feedback);
  Admin → *Review queue* (all pending items, filter by type, subject, author).

### 4.4 Frontend functionality
State badges and allowed actions per state; side-by-side diff of a revision against the published version (text fields
and attachment list); reviewer note required for Changes requested and Rejected; history timeline.

### 4.5 Backend APIs and services
**Exists:** `AssignmentStatus` (DRAFT, PENDING_APPROVAL, PUBLISHED, REJECTED, ARCHIVED, CLOSED) with routes
`/assignments/:id/submit|recall|publish|reject|unpublish|close|reopen|archive` and `AssignmentEvent` history;
resources only `isPublished` / `archivedAt` with `/courses/:courseId/resources/:id/publish|unpublish|archive|restore`.
**New:** resource state machine routes `/courses/:courseId/resources/:id/submit|approve|request-changes|reject`;
`GET|POST /…/resources/:id/revisions`, `GET /admin/review-queue`; teacher routes `/teacher/contributions…`. Assignments
gain CHANGES_REQUESTED (decision 1); a published-assignment revision is step 2 (ADR-010 "resources first").

### 4.6 Database changes and migration requirements
New `ContentRevision` (contentType, contentId, number, payload snapshot JSON, attachment file IDs, status, authorId,
reviewerId, decidedAt, note). `CourseResource.status` (shared enum) backfilled from `isPublished` / `archivedAt`
(isPublished stays, kept in sync, until a later contract step); `CourseResource.publishedRevisionId`. Assignment enum
gains CHANGES_REQUESTED and UNPUBLISHED (additive enum values; own migration). Rollback refuses while any revision is
pending or any resource is in a state the old columns cannot express.

### 4.7 Permissions and security
New `resources.submit` (Teacher, scoped per decision 3; Coach implicit), `resources.approve` (Admin, Super Admin;
Head Coach programme-scoped if decision 4), `assignments.submit` (Teacher, individual grant only — not in the default
profile, ADR-003). Teachers keep **no course access** (owner decision 2026-11-14): they see only their own submissions
and course titles they may submit to, never other content or students' work. Nobody approves their own revision.

### 4.8 Notifications and email behavior
New topic PUBLISHING (NOT-01): reviewers notified of new submissions (in-app; e-mail switchable); authors notified of
approve / changes requested / reject with the note (through `NotificationOutbox`, once per decision). Students notified
of a new published resource as today (RESOURCES category), not of revisions.

### 4.9 Dependencies
Area 2 (teacher scope by subject). Teacher school scope exists (`TeacherSchoolAssignment`).

### 4.10 Test scenarios
Published version stays visible while a revision is pending; approval switches atomically; Changes requested returns
to author, Rejected is final; teacher cannot publish, approve own work, or read course content; coach direct publish
unchanged (regression); history lists every actor; existing resources keep visibility after backfill; Admin never gets
`assignments.prepare` (RS1).

### 4.11 Recommendation
Step 1: shared states and revisions for resources (coaches and admins). Step 2: teacher contributions for resources.
Step 3: published-assignment revisions.

**Decisions needed from the owner**
1. Q7 — Meaning of Changes requested vs Rejected? **Recommended:** Changes requested = back to the author to revise;
   Rejected = closed. *Alternative:* one "Returned" state only.
2. Which content needs approval? **Recommended:** teacher content always; coach assignments as today; coach resources
   direct (ADR-011). *Alternative:* coach resources also need approval.
3. Teacher contribution scope? **Recommended:** assigned school(s) + subject(s) (needs area 2). *Alternative:* any
   subject of their interests; or per-course grants by an Administrator.
4. Who approves? **Recommended:** Administrators and the programme's Head Coach. *Alternative:* Administrators only
   (note: today Head Coaches do not manage resources, ADR-018 H5 — option "Head Coach approves" changes that).
5. (New in v2) May teachers see the published content of the course they contribute to? **Recommended:** no — titles
   only, consistent with the 2026-11-14 decision. *Alternative:* read-only access to that course's resources.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- `ContentRevision`, resource states and revisions for coaches/admins, history, review queue for admins.
- Teacher contribution screens after decisions 3–5.

---

## 5. Student support portal

*Phase 8 · ADR-012 · SUP-01…06, PERM-04 · v1 D5*

### 5.1 Purpose and expected user experience
A signed-in student opens a request in a category (recommendation letter, certificate, coach meeting, academic
question, technical problem, other) with subject, description and attachments, and gets a reference like
`SUP-2026-000123`. They see a status timeline and replies, and get in-app and e-mail notices. Staff work from a queue:
filter, assign, set priority and status, ask for information, write internal notes (never shown to the student),
reply, attach, resolve, reopen. A meeting request carries purpose and preferred times; the assigned coach confirms a
time and records the outcome. The public contact form (`/support`, Admin → Messages) stays as it is.

### 5.2 Relevant user roles
| Role | Capability |
|---|---|
| Student | open, read own, reply, attach, reopen within 14 days of resolution |
| Administrator, Super Admin | full queue, assign, categories, all statuses, internal notes |
| Support handler (staff with a scoped grant) | requests of their categories / assigned to them |
| Coach | only meeting requests assigned to them: confirm time, record outcome |
| Head Coach, Teacher | none in the first step (decision 3) |

### 5.3 Screens and navigation
- **New:** Student → *Support* (`app/student/support`: list, new request, request page); Admin → *Support queue*
  (`app/admin/support`, request page with Student-visible / Internal tabs, categories settings); Coach → *Meetings*.
- **Unchanged:** `app/(auth)/support` and `app/admin/messages` (public contact form, ADR-012 "keep both").

### 5.4 Frontend functionality
Request form with category-specific fields (meeting: purpose + up to three preferred times); timeline; reply box;
staff queue with filters (status, category, assignee, priority, age) and bulk assign; internal note visually distinct.

### 5.5 Backend APIs and services
**Exists:** `ContactMessage` + `/public` and `/admin/contact-messages` (public form), `FileObject` storage,
`NotificationOutbox`, notifications. **New:** `POST|GET /support/requests`, `GET /support/requests/:ref`,
`POST /support/requests/:ref/messages|attachments|reopen`; staff `GET /admin/support/requests`,
`PATCH /admin/support/requests/:id` (assign, status, priority), `POST …/messages { visibility }`,
`/admin/support/categories…`; coach `GET /mentor/meetings`, `PATCH /mentor/meetings/:id` (confirm, outcome).

### 5.6 Database changes and migration requirements
New `SupportCategory` (data), `SupportRequest` (reference unique, studentId, categoryId, status, priority, assigneeId,
timestamps), `SupportMessage` (visibility STUDENT / INTERNAL, authorId, body), `SupportAttachment` (FilePurpose
SUPPORT, new enum value), `MeetingRequest` (preferredTimes JSON, confirmedAt, confirmedTime, outcome), reference
sequence per year. Fixed status set (decision 2) with a transition table in code. Rollback refuses while any request
exists.

### 5.7 Permissions and security
New `support.submit` (Student, own), `support.handle` (new scope kinds `supportCategory` / `supportAssigned`, granted
by override), `support.manage` (Admin, Super Admin). Internal messages are filtered out in the service **and** never
selected for student responses (e2e asserts absence). Students only see their own requests (404 otherwise).
Attachments use the existing content-type sniffing and size limits; R2 upload test before release (ADR-015 rule 6).

### 5.8 Notifications and email behavior
New category SUPPORT. Student: e-mail + in-app on staff reply, status change to WAITING_FOR_STUDENT / RESOLVED, meeting
confirmed (never on internal notes). Staff: in-app on new request in their categories and on student reply; e-mail
switchable. Each via the outbox with a dedupe key per message.

### 5.9 Dependencies
None blocking. Coach meetings use existing coach accounts.

### 5.10 Test scenarios
Reference format and uniqueness under concurrency; internal note never in any student response (list, detail,
notifications, e-mail); student A cannot read B's request; handler limited to categories; coach sees only assigned
meetings; submitting a meeting request never confirms it; reopen window enforced; every status change audited.

### 5.11 Recommendation
Step 1: requests, queue, internal notes, notifications. Step 2: meeting requests with proposed times and confirmation.

**Decisions needed from the owner**
1. Q8 — Meetings? **Recommended:** proposed times + confirmation only. *Alternative:* in-platform calendar scheduling.
2. Statuses? **Recommended:** fixed NEW, IN_PROGRESS, WAITING_FOR_STUDENT, RESOLVED, CLOSED. *Alternative:*
   configurable per category now (ADR-012 allows later).
3. Who may open requests? **Recommended:** students only, first. *Alternative:* also teachers (and parents later).

**Can be implemented as soon as the design is approved / independent of the open decisions**
- Requests, references, categories, staff queue, internal notes, student timeline, notifications (fixed statuses).

---

## 6. Groups and privacy

*Phase 9 · ADR-013 (approved: groups, reuse the study-groups module), ADR-018 H7 · GRP-01…04, PERM-04, SEC-03 · v1 D6 (part)*

### 6.1 Purpose and expected user experience
Administrators create communication groups that do not depend on courses or divisions (e.g. *IMO2026* for the national
team). They add, remove or invite members and appoint group administrators and moderators whose rights stop at their
group. Members see group announcements and discussions with replies, mentions, attachments, notifications, reporting
and moderation. **No private one-to-one messages** (excluded in release 1 by ADR-013). Groups are approved scope: the
old study-groups module was switched off on 2026-11-03, but ADR-013 (2026-11-08) says to **reuse** it.

### 6.2 Relevant user roles
| Role | Capability |
|---|---|
| Super Admin, Administrator | create / archive groups, manage members, appoint group admins and moderators |
| Group administrator (any staff user, appointed per group) | manage members and announcements of that group only |
| Group moderator (appointed per group) | hide / restore posts, resolve reports in that group |
| Member (student, coach, teacher, Head Coach) | read, post per decision 1, reply, report |
| Head Coach | as a member; moderation per decision 2 (H7 deferred) |

### 6.3 Screens and navigation
- **New:** Admin → *Groups* (`app/admin/groups`: list, group page with Members, Announcements, Discussions, Reports);
  *Groups* menu entry in every portal for members (`/student/groups`, `/mentor/groups`, `/teacher/groups`).
- **Changed:** `app/admin/moderation` (filter by group).

### 6.4 Frontend functionality
Group list with member counts; member picker (search, add by CSV); role badges; announcement composer (admins);
thread list and thread page (reusing the course discussion components); @mention autocomplete limited to members.

### 6.5 Backend APIs and services
**Exists (not registered):** `src/study-groups/` (controller `/study-groups` with create, update, list, members add /
role / remove / history, `my/groups`, all `@Roles('ADMIN')`; `group-member.guard.ts`) — `StudyGroupsModule` is
deliberately not in `src/app/app.module.ts` (line 109). Discussions: `DiscussionThread`, `Comment`, reactions,
`ContentReport`, `ModerationAction`, `/admin/moderation/*`. **No mention support exists.**
**New:** register the module under `/groups` (keep `/study-groups` unregistered), convert to `@RequirePermission`;
`POST /groups/:id/invitations`, `PUT /groups/:id/members/:userId/role`, `POST /groups/:id/archive`;
`GET|POST /groups/:id/threads`, announcements as pinned threads; mentions parsed on comment create.

### 6.6 Database changes and migration requirements
Reuse `StudyGroup` and `StudyGroupMember` (same tables, IDs kept; any existing rows are reviewed before switch-on and
stay inactive). Add `StudyGroup.archivedAt`; `GroupRole` gains ADMIN and MODERATOR (additive enum values);
new `StudyGroupInvitation` (groupId, userId, invitedById, status, expiresAt). `DiscussionThread.groupId` nullable,
and `divisionId` becomes nullable with a CHECK "exactly one of (course/assignment with division) or group".
New `CommentMention` (commentId, userId). Rollback refuses while any group thread exists.

### 6.7 Permissions and security
New `groups.manage` (Admin, Super Admin, global), `groups.administer` and `groups.moderate` (new scope kind `group`,
from the member's group role — no global effect), `groups.participate` (members). Non-members get 404. Minors: member
lists show display names only (decision 4) — never e-mail, phone, school, date of birth; mentions only of members;
attachments use existing limits; every membership and role change audited with previous and new role.

### 6.8 Notifications and email behavior
Category DISCUSSIONS (existing): new announcement (in-app + e-mail, switchable), reply to own thread, mention (in-app).
Added to a group: in-app notice. No e-mail digests in the first step. Targeted e-mail to a group is area 7.

### 6.9 Dependencies
None blocking (reuses discussions and notifications). Area 7 uses groups as an audience.

### 6.10 Test scenarios
Module routes all permission-guarded (route-declaration matrix updated); non-member 404 on group, threads, files;
group admin cannot touch another group; no route allows a private 1:1 conversation; course threads unchanged
(regression, `divisionId` still required for them by the CHECK); report → moderator resolves within group only;
mention of a non-member refused; archived group read-only.

### 6.11 Recommendation
Reuse the existing module and discussion machinery as ADR-013 says. Step 1: groups, members, announcements.
Step 2: discussions, mentions, moderation roles.

**Decisions needed from the owner**
1. May students start discussions in groups? **Recommended:** yes, moderated. *Alternative:* only reply to staff threads.
2. H7 — Head Coach moderation inside groups (deferred 2026-11-09 until designed with communication)? **Recommended:**
   no programme-wide moderation; a Head Coach moderates a group only if an Administrator appoints them moderator of
   that group. *Alternative:* Head Coaches moderate all groups of their programme; or keep fully deferred.
3. (New in v2) May students be group administrators or moderators? **Recommended:** no (staff only).
   *Alternative:* yes, appointed per group.
4. (New in v2) What members see of each other? **Recommended:** first and last name and role only; no username,
   school or contact. *Alternative:* names hidden from students (staff see the roster).

**Can be implemented as soon as the design is approved / independent of the open decisions**
- Register and harden the module under `/groups`, admin screens, membership, announcements, archive.
- Thread posting rules follow decision 1; moderation roles follow decisions 2–3.

---

## 7. Targeted e-mail

*Phase 9 · ADR-014, ADR-018 · GRP-05 · v1 D6 (part)*

### 7.1 Purpose and expected user experience
An Administrator writes an e-mail, chooses an audience (a group, a user type, a country, a school, a subject, or a
combination), sees how many people and who will receive it, previews the message, confirms explicitly, and sends.
Every send is logged with its audience and counts, and can be followed (sent, failed, retried).

### 7.2 Relevant user roles
| Role | Capability |
|---|---|
| Administrator, Super Admin | send to any audience; see all jobs |
| Group administrator | send to their own group only (decision 1) |
| Head Coach | **no** bulk e-mail (ADR-018) |
| Coach, Teacher, Student | recipients only |

### 7.3 Screens and navigation
**Exists:** `app/admin/email` (jobs), `app/admin/email/new` (composer), `app/admin/email/jobs/[id]`,
`app/admin/email/failed`, `app/admin/notification-deliveries`; bulk *message* action in `app/admin/users/bulk`.
**Changed:** the composer gets an audience builder, a recipient preview (paged, names and roles only) and a
confirmation step showing the exact count.

### 7.4 Frontend functionality
Audience builder (OR within a dimension, AND across dimensions); live count; sample recipient list; message preview
with the branded template; confirm checkbox "Send to N people"; job page shows the audience description.

### 7.5 Backend APIs and services
**Exists:** `POST /admin/email/send` with `recipientMode` EXPLICIT (≤500 IDs) / ROLE / DIVISION / SCHOOL / ALL and an
idempotency key; `GET /admin/email/users|jobs|jobs/:id|jobs/:id/deliveries|deliveries`, retries; worker with
`FOR UPDATE SKIP LOCKED`; bulk `message` action (`src/users/bulk/bulk-rules.ts`, active accounts only). **Gap found:**
ROLE accepts only STUDENT, MENTOR, ADMIN (`src/email/dto/send-email.dto.ts:60`) — Teachers and Head Coaches cannot be
targeted by role today. **New:** `POST /admin/email/audience/preview` (count + first page), `recipientMode: AUDIENCE`
with an `audience` object (groupIds, roles incl. TEACHER / HEAD_COACH, countryCodes, schoolIds, subjectIds);
`confirmCount` must equal the resolved count at send time or the send is refused (audience changed).

### 7.6 Database changes and migration requirements
`EmailJob.audience` JSON (nullable; old jobs keep null) and `EmailJob.resolvedCount`. Recipients are resolved and
snapshotted into `EmailDelivery` rows at send time (as today). No new tables. Rollback refuses while any job has an
audience.

### 7.7 Permissions and security
Existing `email.bulkSend` (Admin, Super Admin). New scope rule: a group administrator's sends are limited to
`groupIds` they administer (scope `group`, via `groups.administer`) — audience outside scope → 403. Only active
accounts are e-mailed; preview never shows e-mail addresses of students; body never in audit (as today); audit row
holds audience, count and subject.

### 7.8 Notifications and email behavior
Sent through the existing outbox and Resend; failures retried and visible in deliveries. Optional in-app copy
(decision 3). Bulk messages are not subject to the per-category opt-out today; ACCOUNT-type messages never are.

### 7.9 Dependencies
Area 6 (group audience), area 1 (country), area 2 (subject). Role and school audiences work now.

### 7.10 Test scenarios
Preview count = delivered count; changed audience between preview and send refused; group admin cannot target another
group or a role; Head Coach 403; suspended / archived skipped; idempotent re-submit; TEACHER role audience works; no
student e-mail address in preview response.

### 7.11 Recommendation
Build the audience model on the existing outbox now with role and school; add group, country and subject as their
areas land. Keep Head Coaches excluded.

**Decisions needed from the owner**
1. Who may send besides Administrators? **Recommended:** group administrators, to their own group only.
   *Alternative:* Administrators and Super Admins only.
2. (New in v2) Saved audiences ("segments") for reuse? **Recommended:** no — choose the audience per send.
   *Alternative:* saved, named audiences.
3. (New in v2) Also show the message in recipients' in-app notifications? **Recommended:** yes. *Alternative:* e-mail only.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- Audience preview + confirmation on the existing composer; TEACHER / HEAD_COACH role audiences; audience logging.

---

## 8. Data privacy and retention

*Phase 10 · ADR-008, ADR-015 · SEC-04, SEC-03, ACC-14, ACC-16 · v1 D7 (part)*

### 8.1 Purpose and expected user experience
People can ask what data ROF holds about them, get it corrected, and — after a retention period — have an archived
account anonymised. The Super Admin can export a person's data (a downloadable file with their profile, enrolments,
submissions, results, messages and files), and can anonymise an archived account once its retention period has
passed. Results, discussions and the audit trail stay, under a pseudonym. Students are minors: contact data and dates
of birth are shown only to those who need them.

### 8.2 Relevant user roles
| Role | Capability |
|---|---|
| Super Admin | export a person's data; anonymise an archived account after retention (decision 2) |
| Administrator | correct data; archive / restore (exists); request export from the Super Admin |
| Student, staff | correct own profile (exists); request export through support (area 5) |

### 8.3 Screens and navigation
- **Changed:** `app/admin/users/[id]` — *Privacy* card: "Export personal data", "Anonymise" (only when archived and past
  retention; typed confirmation), retention due date.
- **New:** Admin → Settings → *Retention* (read-only list of periods).

### 8.4 Frontend functionality
Export job with progress and a one-time download link (expires in 24 h); anonymise dialog listing exactly what changes
and what is kept; refusal messages when not yet eligible.

### 8.5 Backend APIs and services
**Exists:** archive / restore (`/admin/users/:id/status-changes`, `users.archive`), `DELETE /admin/users/:id` archives;
nightly `RetentionService` (ActivityLog 400 days, read notifications 180 days, sent e-mail bodies cleared after 90
days); list masking `maskPhone` (`src/users/contact-masking.ts`) — full phone numbers only on `GET /admin/users/:id`
(`users.manage`) and to the account holder (`GET /me`). **New:** `POST /admin/users/:id/data-export` (job),
`GET /admin/data-exports/:id/download`, `POST /admin/users/:id/anonymise { confirm, reason }`, a nightly report of
accounts past retention (no automatic erasure).

### 8.6 Database changes and migration requirements
New `DataExport` (userId, requestedById, status, fileId, expiresAt) and `User.anonymisedAt`. Anonymisation overwrites
names, username, e-mail, phones, date of birth, home place, avatar; keeps IDs, results and audit rows (actor shown as
"Former user #…"). This is irreversible: separate permission, typed confirmation, reason, Super Admin only, and the
first production run only after your explicit approval (ADR-015 rule 7). Migration itself is additive.

### 8.7 Permissions and security
New `users.exportPersonalData`, `users.anonymise` (Super Admin only; added to `NEVER_GRANTABLE`). Export files use a
new FilePurpose DATA_EXPORT, private, deleted at expiry. Audit records who exported / anonymised whom and why (no data
content).

### 8.8 Notifications and email behavior
The person is e-mailed when an export was produced for them (security notice, not switchable). No e-mail on
anonymisation (the address no longer exists). Super Admin gets an in-app notice when an export is ready.

### 8.9 Dependencies
Area 10 (account states) for eligibility; area 5 optional (requests through support).

### 8.10 Test scenarios
Export contains every personal field and nothing of other people (no other students' names in threads beyond what
the person could see); download link single-use and expiring; anonymise refused before retention or for a non-archived
account; after anonymisation results and leaderboard totals are unchanged and login impossible; Administrator 403 on
both routes; audit row has no personal data.

### 8.11 Recommendation
Build export first (low risk, read-only). Anonymisation second, manual only, never automatic.

**Decisions needed from the owner**
1. Q16 — Retention period for archived accounts? **Recommended:** 3 years after archive. *Alternative:* 1, 2 or 5 years.
2. Q16 — Who may export / erase? **Recommended:** Super Admin only. *Alternative:* Administrators export, Super Admin erases.
3. SEC-03 — Guardian consent at registration for under-16s? **Recommended (new in v2; v1 left it open):** take legal
   advice on Rwanda's data protection law first; if required, add a recorded guardian confirmation (who, when, guardian
   phone) at registration. *Alternative:* not required; or consent collected offline by schools.
4. Q18 — E-mail read receipts? **Recommended:** no (minors). *Alternative:* yes, for staff only.
5. (New in v2) Confirm the existing technical retention: activity log 400 days, read notifications 180 days, sent
   e-mail bodies 90 days? **Recommended:** keep. *Alternative:* other periods.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- Personal data export (Super Admin), the "past retention" report (period from decision 1), Privacy card.

---

## 9. Configurable registration fields

*REG-09 · Q10 · ADR-009 · v1 D8*

### 9.1 Purpose and expected user experience
On the Forms page, administrators can mark certain optional fields as required, optional or hidden, separately for the
student, teacher and coach forms. Fields that matter for security or safeguarding (name, username, e-mail, password,
date of birth and guardian phone for students) are always required and cannot be changed.

### 9.2 Relevant user roles
| Role | Capability |
|---|---|
| Administrator, Super Admin | set field rules per form |
| Applicants (student, teacher, coach) | see the form shaped by the rules |

### 9.3 Screens and navigation
**Exists:** `app/admin/forms` (availability, schedule, messages). **Changed:** a *Fields* tab per form;
`app/(auth)/register`, `app/(auth)/register/teacher`, `app/(auth)/apply` read the rules.

### 9.4 Frontend functionality
Per field: Required / Optional / Hidden (locked fields shown greyed); preview of the form; registration pages render
from `fieldRules` and fall back to today's form when the backend has no capability.

### 9.5 Backend APIs and services
**Exists:** `GET /forms`, `GET /forms/:key`, `/admin/forms/:key` (+ `/history`, `PATCH …/availability`,
`PATCH …/messages`); `FormKey` STUDENT_REGISTRATION, TEACHER_REGISTRATION, COACH_APPLICATION, CONTACT. Student DTO
fields include phone, guardianPhone, homeCountry / Province / District / Sector, olympiadInterests; teacher: position,
yearsOfExperience; coach: occupation, educationLevel, affiliation, expertise, relevantExperience, yearsOfExperience.
**Correction to v1:** guardian phone is listed in v1 as always required, but only the frontend form requires it — the
backend accepts a registration without it (`src/auth/dto/register-student.dto.ts:158-162`, `@IsOptional`).
**New:** `PATCH /admin/forms/:key/fields`; `GET /forms/:key` returns `fieldRules`; each registration service validates
against the rules (hidden field sent → ignored; required missing → 400).

### 9.6 Database changes and migration requirements
`FormAvailability.fieldRules` JSON (nullable = today's behaviour), validated against a code list of configurable
fields per form. History through the existing form history (audit). Rollback refuses while any rule is set.

### 9.7 Permissions and security
New `forms.editFields` (Admin, Super Admin) beside `forms.view` / `forms.manageAvailability` / `forms.editMessages`.
Locked fields cannot be made optional or hidden (server-enforced). Changes audited with previous and new rules.

### 9.8 Notifications and email behavior
None.

### 9.9 Dependencies
None blocking. Area 1 may later add per-country rules (not proposed now).

### 9.10 Test scenarios
Required field missing → 400 per form; hidden field ignored and not stored; locked field change refused; no rules =
identical behaviour to today (regression); older frontend still registers; guardian phone required server-side.

### 9.11 Recommendation
First make the backend enforce today's required fields (guardian phone), then add the rules.

**Decisions needed from the owner**
1. Q10 — Which fields are configurable? **Recommended:** student phone, home place, interests; teacher position, years
   of experience; coach affiliation, expertise, years of experience. Date of birth is **not** configurable since your
   2026-11-17 decision made it required (v1 listed it as configurable — superseded by that decision). *Alternative:* a
   shorter or longer list.
2. (New in v2) Enforce guardian phone as required on the server for student self-registration? **Recommended:** yes.
   *Alternative:* keep it required by the form only.
3. Date of birth for administrator-created, invited or imported students (awaiting decision in PROGRESS.md)?
   **Recommended:** optional for staff-created accounts, asked from the student at first sign-in. *Alternative:*
   required in create / invite / CSV import.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- `fieldRules` column, validation engine, Fields tab; locked-field list. The field list itself follows decision 1.

---

## 10. Account-state model: four stored states vs six in ADR-008

*ADR-008 · ACC-12, ACC-13 · v1 D7 (part)*

### 10.1 Purpose and expected user experience
Administrators need to see at a glance where every account stands. ADR-008 named six states; the system (built
2026-11-16) stores four and works out the other two. This proposal shows all six (plus Deactivated) as filters and
badges on the user list without changing data, unless you prefer stored states.

| ADR-008 state | Today | How it is known |
|---|---|---|
| PENDING_VERIFICATION | derived | `User.activatedAt` is null (invited / not verified) |
| PENDING_APPROVAL | derived | `User.isApproved` false (coach invited by a Head Coach; students when `registration.studentRequiresApproval`) |
| ACTIVE | stored | `AccountStatus.ACTIVE` |
| SUSPENDED | stored | `AccountStatus.SUSPENDED` |
| REJECTED | on applications only | `TeacherApplicationStatus` / `MentorRequestStatus` REJECTED — a rejected applicant never gets an account |
| ARCHIVED | stored | `AccountStatus.ARCHIVED` (reversible; restore exists) |
| *(not in ADR-008)* DEACTIVATED | stored | `AccountStatus.DEACTIVATED` (reversible switch-off) |

### 10.2 Relevant user roles
Administrator and Super Admin (filter, change states, see history); Head Coach (programme users, read badges).

### 10.3 Screens and navigation
**Exists:** `app/admin/users` (status filter), `app/admin/users/[id]` (account history card, status actions),
`app/admin/users/bulk`. **Changed:** a combined *State* filter and badge with the six (seven) values.

### 10.4 Frontend functionality
Badge shows the main state plus blocking conditions ("Active · not activated"); filter by any combination.

### 10.5 Backend APIs and services
**Exists:** `src/users/account-status.ts` (transition table ACTIVE ↔ DEACTIVATED / SUSPENDED / ARCHIVED, reasons,
`stillBlockedBy` → NOT_ACTIVATED, PENDING_APPROVAL, LOCKED, ROLE_DISABLED), `PATCH /admin/users/:id/status`,
`POST /admin/users/:id/status-changes`, `GET /admin/users/:id/status-history`, `UserStatusChange` table.
**New (recommended option):** `GET /admin/users?state=PENDING_VERIFICATION|PENDING_APPROVAL|…` computed in the query;
`displayState` on user responses. **New (alternative):** stored states with a new transition table.

### 10.6 Database changes and migration requirements
Recommended option: none. Alternative: add PENDING_VERIFICATION, PENDING_APPROVAL (and REJECTED) to `AccountStatus`,
backfill from `activatedAt` / `isApproved`, every activation / approval path writes the state and a `UserStatusChange`;
rollback refuses while any account is in a new state.

### 10.7 Permissions and security
Unchanged: `users.viewStatusHistory`, `users.changeStatus`, `users.suspend`, `users.archive`; role-management rules
for the target account; Super Admin boundary.

### 10.8 Notifications and email behavior
Unchanged (activation, approval and decision e-mails already exist).

### 10.9 Dependencies
Area 8 uses ARCHIVED + time as the anonymisation trigger.

### 10.10 Test scenarios
Filter counts equal the underlying flags; an invited, never-activated account appears only under Pending verification;
restoring an archived account that was never activated shows both conditions; no state change writes anything except
through the existing routes (regression).

### 10.11 Recommendation
Keep four stored + two derived states (no data change, no risk); show all of them in the list; keep REJECTED on
applications; keep DEACTIVATED.

**Decisions needed from the owner**
1. Accept four stored + two derived states? **Recommended:** yes, with the admin list showing all six as filters.
   *Alternative:* store PENDING_VERIFICATION / PENDING_APPROVAL (migration + transition rules).
2. (New in v2) REJECTED as an account state? **Recommended:** no — rejection stays on the application, because a
   rejected applicant never receives an account. *Alternative:* store REJECTED on accounts (only meaningful for
   students under `studentRequiresApproval`).
3. (New in v2) Keep DEACTIVATED, which ADR-008 does not list? **Recommended:** yes (a reversible switch-off distinct
   from a disciplinary suspension). *Alternative:* merge it into SUSPENDED.

**Can be implemented as soon as the design is approved / independent of the open decisions**
- Combined state filter and badges (works with either answer to decision 1).

---

## Corrections to v1

| v1 statement | Fact in the code | Evidence | Effect |
|---|---|---|---|
| D3: "the existing `CourseEnrollment` table becomes the grant record" | It is per-student progress, created on first open by any division student | `prisma/schema.prisma` model `CourseEnrollment` ("Per-student course progress. Created on first open.") | New `CourseAccessGrant` table instead (area 3); recommendation otherwise unchanged |
| D8: guardian phone for students is always required | Only the frontend form requires it; the API accepts it missing | `src/auth/dto/register-student.dto.ts:158-162` | Area 9 decision 2: enforce on the server |
| D7: "Guardian phone visible only to `users.manageStudents` in scope (W4)" | Lists are masked for everyone; the full number is returned on `GET /admin/users/:id` under `users.manage` (Admins, Super Admins) and to the holder | `src/users/contact-masking.ts:1-4` | Area 8 states the actual rule; no change proposed |
| D8: date of birth in the configurable list | Owner made it required on 2026-11-17 | `docs/PROGRESS.md` (Done, 2026-11-17) | Removed from the configurable list |

Also noted (not v1 errors): no course-creation route exists (area 2 decision 4); bulk e-mail ROLE mode excludes
TEACHER and HEAD_COACH (`src/email/dto/send-email.dto.ts:60`); `DiscussionThread.divisionId` is required, so group
threads need it nullable with a CHECK (area 6); the `Programme` table is school A-Level / TVET data, not ADR-018
programmes (area 2).

---

## All decisions needed from the owner

| Area | # | Question | Recommendation |
|---|---|---|---|
| 1 Countries | 1.1 | Q12 Country list | All ISO countries, inactive by default |
| 1 Countries | 1.2 | Q13 Geographic levels outside Rwanda | One optional region level |
| 1 Countries | 1.3 | Q15 Academic years | One global year for now |
| 1 Countries | 1.4 | Primary pupils (P1–P6) register? | Not in release 1 |
| 2 Subjects | 2.1 | Q3 Course in several topics? | One topic only |
| 2 Subjects | 2.2 | Subject = programme one-to-one? | Yes, as today |
| 2 Subjects | 2.3 | Interests map to subjects of the same code? | Yes |
| 2 Subjects | 2.4 | Administrators create courses in the portal? | Yes (`courses.manage`) |
| 3 Course access | 3.1 | Default policy for new courses | ENROLLMENT_REQUIRED (ADR-006) |
| 3 Course access | 3.2 | Head Coaches enroll in their programme? | Yes, programme-scoped |
| 3 Course access | 3.3 | Student enrollment requests? | Not in the first step |
| 4 Publishing | 4.1 | Q7 Changes requested vs Rejected | Back to author vs closed |
| 4 Publishing | 4.2 | Which content needs approval | Teacher content always; coach assignments as today; coach resources direct |
| 4 Publishing | 4.3 | Teacher contribution scope | Assigned school(s) + subject(s) |
| 4 Publishing | 4.4 | Who approves | Administrators and the programme's Head Coach |
| 4 Publishing | 4.5 | Teachers see the course's published content? | No — titles only |
| 5 Support | 5.1 | Q8 Meetings | Proposed times + confirmation |
| 5 Support | 5.2 | Statuses | Fixed: NEW, IN_PROGRESS, WAITING_FOR_STUDENT, RESOLVED, CLOSED |
| 5 Support | 5.3 | Who opens requests | Students only, first |
| 6 Groups | 6.1 | Students start discussions? | Yes, moderated |
| 6 Groups | 6.2 | H7 Head Coach moderation in groups | Only when appointed moderator of a specific group |
| 6 Groups | 6.3 | Students as group admins / moderators? | No |
| 6 Groups | 6.4 | What members see of each other | Name and role only |
| 7 Targeted e-mail | 7.1 | Senders besides Administrators | Group administrators, own group only |
| 7 Targeted e-mail | 7.2 | Saved audiences | No |
| 7 Targeted e-mail | 7.3 | In-app copy of the message | Yes |
| 8 Privacy | 8.1 | Q16 Retention for archived accounts | 3 years after archive |
| 8 Privacy | 8.2 | Q16 Who exports / erases | Super Admin only |
| 8 Privacy | 8.3 | Guardian consent for under-16s | Legal advice first; if required, recorded guardian confirmation |
| 8 Privacy | 8.4 | Q18 E-mail read receipts | No |
| 8 Privacy | 8.5 | Keep technical retention (400 / 180 / 90 days) | Keep |
| 9 Registration fields | 9.1 | Q10 Configurable fields | Student phone, home place, interests; teacher position, years; coach affiliation, expertise, years |
| 9 Registration fields | 9.2 | Guardian phone required on the server | Yes |
| 9 Registration fields | 9.3 | DOB for staff-created / invited / imported students | Optional; asked at first sign-in |
| 10 Account states | 10.1 | Four stored + two derived states | Accept; show all six as filters |
| 10 Account states | 10.2 | REJECTED as an account state | No (stays on applications) |
| 10 Account states | 10.3 | Keep DEACTIVATED | Yes |

**Carried over from v1 "Other decisions to confirm"** (cross-cutting, unchanged):

| # | Question | Recommendation |
|---|---|---|
| Q9/O6 | One person with several user types? | No (one type per account) for release 1 |
| Q11 | Phone numbers unique? | No uniqueness; E.164 format (as implemented) |
| Q14 | School administrators: accounts with school scope, or contact records? | Contact records (implemented) for release 1 |
| Q17 | May students change school / grade themselves? | School by a claim verified by an Administrator (implemented); grade by request |
| Q19 | Password policy for the international launch | Keep current policy; add breached-password check later |
| O5 | Head Coaches create coaches without approval? | No (as today) |
| PERF-02 | Resumable uploads for large files | Not needed at current limits |
| ARC-04 | Staging environment (ADR-016) | Yes: Neon branch + second free Render service + Netlify branch deploy (owner creates the resources) |

Not proposed anywhere in this document (excluded or deferred by you): private 1:1 messaging (release 1), MFA, custom
permission profiles, organisational role, coach–student supervision links, teacher course access, passport / national
ID on coach applications.
