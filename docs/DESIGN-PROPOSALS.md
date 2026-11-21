# Design proposals for owner approval (2026-11-17)

Each design implements an approved direction (ADR) and lists the **decisions the owner must take** (with a
recommendation). Nothing here is implemented before approval. Common rules for all: additive migrations with
rollback files and data guards; every route behind a catalogue permission; audit rows in the same transaction;
capabilities advertised in `GET /api/v1` so older frontends keep working; backend e2e on PostgreSQL, frontend unit
tests and browser e2e per workflow; existing IDs and relationships never change (ADR-015).

---

## D1 — Countries, regions, education systems and grades (Phase 2; ADR-005; INT-01…03, REG-02/03)

**Experience.** Administrators manage countries (activate, name, ISO code, phone prefix), each country's regions
and its education system with ordered grade levels (Rwanda: P1–P6, S1–S6). Registration asks the country first;
schools and grades offered follow it. Rwanda keeps its full Province → District → Sector directory.

**Data.** `Country` (ISO 3166-1 alpha-2 primary key, name, isActive, educationSystemId); `Region` (countryId, name,
parentId — one optional level, Q13); `EducationSystem` (name); `GradeLevelRef` (systemId, code, label, order,
divisionId nullable). Expand–contract: `User.gradeLevelId` added beside the `GradeLevel` enum, backfilled
(S1…S6 → Rwanda refs); responses keep `gradeLevel` and add `grade { code, label }`; the enum is dropped only in a
later, separate migration. `School.countryCode` gains an FK to `Country`. Grade → division mapping moves to data
(Junior S1–S3, Senior S4–S6 unchanged).

**API.** `GET /countries`, `/countries/:code/grades`, `/countries/:code/regions` (public, cached);
`/admin/countries…` (`reference.manage`, new; Administrators and Super Admins).

**Screens.** Admin → Reference data (countries, regions, grades); registration country picker.

**Decisions:** Q12 all ISO countries seeded inactive *(recommended)* or a curated list · Q13 one region level for
non-Rwanda countries *(recommended)* · Q15 academic years global *(recommended for now)* or per education system ·
whether P1–P6 students may register (affects divisions: a "Primary" division would be needed).

---

## D2 — Subjects, topics and programmes (Phase 3; ADR-007; SUB-01…06, programme creation)

**Experience.** Administrators create subjects (name, code, description, icon, order, status DRAFT / PUBLISHED /
INACTIVE / ARCHIVED) and topics under them (add, rename, reorder, deactivate, archive). A course optionally belongs
to a topic. Subjects can be limited to grades, countries or programmes. A new subject creates its programme, so
Head Coaches and programme membership work for it without code changes. Student registration interests come from
the published subjects (Mathematics, Computing, Physics, AI, …).

**Data.** `Discipline` stays the table (API name `subjects`, `/disciplines` kept): + `icon`, `status`,
`publishedAt`. `Topic` (subjectId, name, order, status). `Course.topicId` nullable; Mathematics: one topic per
existing course, linked. `SubjectAvailability` (subjectId × gradeLevelRef / country / programme). `OlympiadSubject`
enum on users and applications → `subjectIds` (expand–contract, backfilled by code).

**Permissions.** `subjects.manage` (Admins, Super Admins). Head Coaches read their programme's topics.

**Decisions:** Q3 a course in one topic only *(recommended)* or several · whether programme = subject one-to-one
*(recommended: yes, as today)* · which existing interests map (MATHEMATICS, COMPUTING, PHYSICS → subjects of the
same codes).

---

## D3 — Course access and enrollment (Phase 6; ADR-006; REG-04, ACA-03, ACA-05)

**Experience.** Each course shows its access policy. `DIVISION_OPEN`: every student of the division (today).
`ENROLLMENT_REQUIRED`: only enrolled students; administrators (and Head Coaches for their programme, if approved)
enroll students individually, by CSV, or by rule (grade / school); students may request enrollment (optional).
Widening access needs a confirmation that shows how many students gain access.

**Data.** `Course.accessPolicy` (existing courses set to DIVISION_OPEN by the migration; new courses default
ENROLLMENT_REQUIRED as the ADR says); the existing `CourseEnrollment` table becomes the grant record
(grantedById, source, revokedAt).

**API.** `PATCH /admin/courses/:id/access {policy, confirm}`, `/admin/courses/:id/enrollments` (list, add, bulk,
revoke), `POST /courses/:id/enrollment-requests` (if approved).

**Decisions:** new courses default ENROLLMENT_REQUIRED *(ADR text)* or DIVISION_OPEN · may Head Coaches enroll in
their programme *(recommended: yes, scoped)* · student-initiated enrollment requests *(recommended: no in the first
step)*.

---

## D4 — Publishing workflow, revisions, teacher contributions (Phase 7; ADR-010/011; PUB-01…04, ADR-003)

**Experience.** One workflow for resources and assignments: DRAFT → PENDING_APPROVAL → PUBLISHED, with
CHANGES_REQUESTED (author revises) and REJECTED (final), UNPUBLISHED, ARCHIVED. Editing published content creates
a revision; students keep seeing the published version until the revision is approved. A history lists who created,
edited, reviewed and approved each version. Coaches keep direct publishing of resources (ADR-011); teachers always
submit for approval (ADR-003), in the schools / subjects they are assigned to.

**Data.** `ContentRevision` (contentType, contentId, number, payload snapshot, files, status, authorId,
reviewerId, decidedAt, note); `CourseResource.publishedRevisionId`; assignment states mapped onto the shared set.

**Permissions.** `resources.submit`, `resources.approve`, `assignments.submit`; teacher grants by decision.

**Decisions:** Q7 difference CHANGES_REQUESTED vs REJECTED *(recommended: changes requested = returns to author;
rejected = closed)* · which content types need approval *(recommended: teacher content always; coach assignments
as today)* · teacher scope for contributions: school + subject (needs D2) · who approves *(recommended: Admins and
the programme's Head Coach)*.

---

## D5 — Student Support and Services portal (Phase 8; ADR-012; SUP-01…06)

**Experience.** Signed-in students open requests in categories (recommendation letter, certificate, coach meeting,
academic question, technical problem, other): subject, description, attachments → reference `SUP-2026-000123`,
status timeline, replies, e-mail / in-app notices. Staff see a queue: filter, assign, priority, status, ask for
information, internal notes (never shown to students), reply, attach, resolve, reopen. Coach meeting requests carry
purpose and preferred times; the assigned coach confirms a time; the outcome is recorded. The public contact form
stays as it is.

**Data.** `SupportCategory` (data), `SupportRequest` (reference, studentId, categoryId, status, priority,
assigneeId), `SupportMessage` (visibility STUDENT / INTERNAL), `SupportAttachment`, `MeetingRequest`
(preferredTimes, confirmedAt, outcome).

**Permissions.** `support.submit` (students), `support.handle` (scoped: SUPPORT_ASSIGNED / category),
`support.manage` (Admins). Coaches see only meeting requests assigned to them.

**Decisions:** Q8 meetings = proposed times + confirmation only *(recommended)* or in-platform scheduling ·
statuses fixed (NEW, IN_PROGRESS, WAITING_FOR_STUDENT, RESOLVED, CLOSED) *(recommended)* · may teachers / parents
open requests *(recommended: students only, first)*.

---

## D6 — Communication groups and targeted e-mail (Phase 9; ADR-013/014; GRP-01…05)

**Experience.** Administrators create groups (e.g. IMO2026) independent of courses; add / remove / invite
members; appoint group administrators and moderators whose rights stop at their groups. Groups have announcements
and discussions with replies, mentions, attachments, notifications, reporting and moderation (existing discussion
machinery). No private one-to-one messages. Targeted e-mail chooses an audience (group, user type, country, school,
subject), previews the recipients and the message, requires explicit confirmation, and is logged.

**Data.** Re-enable the kept `StudyGroup` / `StudyGroupMember` tables (renamed in the API to `groups`), add
`archivedAt`, invitations; `DiscussionThread.groupId`; e-mail `Audience` JSON on `EmailJob` with the resolved
recipient count.

**Permissions.** `groups.manage` (Admins), `groups.administer` (GROUP scope), `groups.participate`;
`email.bulkSend` scoped to audiences within the sender's scope.

**Decisions:** may students start discussions in groups *(recommended: yes, moderated)* or only reply · who may
send targeted e-mail besides Administrators *(recommended: group administrators to their group only)* · Head
Coach moderation (H7) inside groups.

---

## D7 — Privacy, retention and account states (Phase 10 / ADR-008; SEC-04, ACC-12, ACC-14, SEC-03)

**Account states.** ADR-008 named six explicit states; the implemented model (PR #58) stores four (ACTIVE,
DEACTIVATED, SUSPENDED, ARCHIVED) and derives "pending verification" (not activated) and "pending approval"
(not approved); REJECTED exists for applications. **Decision:** accept the four stored + two derived states
*(recommended: no data change; the admin list shows all six as filters)* or add PENDING_VERIFICATION /
PENDING_APPROVAL / REJECTED as stored states (migration + transition rules).

**Retention and rights.** Personal data export for a user (JSON + files, by Admins on request, audited);
correction through the profile; erasure = anonymisation of an archived account after the retention period (keeps
results and audit with a pseudonym). **Decisions (Q16):** retention period for archived accounts
*(recommended: 3 years after archive)*; who may export / erase *(recommended: Super Admin only)*.

**Minors (SEC-03).** Guardian phone visible only to `users.manageStudents` in scope (implemented in W4); parental
consent at registration for under-16s: **decision** whether required.

---

## D8 — Configurable registration fields (REG-09; Q10)

**Experience.** On the Forms page, administrators mark optional fields as required or hidden per form (student,
teacher, coach). Security-relevant fields (name, username, e-mail, password, guardian phone for students) are always
required.

**Data.** `FormAvailability.fieldRules` JSON validated against a code list of configurable fields; the public
`GET /forms/:key` returns the rules; the backend validates submissions against them.

**Decision (Q10):** which fields are configurable *(recommended: phone for students, date of birth, home place,
interests, position, years of experience, affiliation, expertise)*.

---

## Other decisions to confirm

| # | Question | Recommendation |
|---|---|---|
| Q9/O6 | One person with several user types? | no (one type per account) for release 1 |
| Q11 | Phone numbers unique? | no uniqueness; E.164 format (as implemented) |
| Q14 | School administrators: user accounts with school scope, or contact records? | contact records (implemented) for release 1 |
| Q17 | May students change school / grade themselves? | school: by a claim verified by an Administrator (implemented); grade: by request |
| Q19 | Password policy for the international launch | keep current policy (length + complexity), add breached-password check later |
| O5 | Head Coaches create coaches without approval? | no (as today) |
| Q18 | E-mail read receipts | no |
| PERF-02 | Resumable uploads for large files | not needed at current limits |
| ARC-04 | Staging environment (ADR-016) | yes: Neon branch + second free Render service + Netlify branch deploy — owner creates the accounts' resources |
