# Test Management — the owner's 52 required scenarios, traced to automated tests

Owner spec "Test Submission, Marking, Approval and Results Publishing System" §14 (2026-11-19) and the approved plan
(section F): every scenario maps to named tests. All 52 are covered. Phase 4 also added the gap tests marked **(P4)**
where a scenario was only partly covered by Phases 1–3 (`test/test-scenarios.e2e-spec.ts`).

**Files.** Backend e2e on PostgreSQL (`test/…`): **TM** `test-management.e2e-spec.ts` (Phase 1), **TS**
`test-submissions.e2e-spec.ts` (Phase 2), **TK** `test-marking.e2e-spec.ts` (Phase 3), **TR** `test-results.e2e-spec.ts`
(Phase 4), **SC** `test-scenarios.e2e-spec.ts` (Phase 4, the scenarios beyond the phase specs), **WF**
`test-workflow.e2e-spec.ts` (the complete workflow). Backend unit (`src/…`): **uSR** `test-management/submission-rules.spec.ts`,
**uMR** `test-management/marking-rules.spec.ts`, **uTR** `test-management/test-rules.spec.ts`, **uAM**
`test-management/answer-metadata.spec.ts`, **uRR** `test-management/results-rules.spec.ts`, **uP** `auth/permissions.spec.ts`,
**uDC** `decision-notifications/decision-content.spec.ts`, **uRS** `auth/role-route-sweep.spec.ts`. Frontend Playwright
(`e2e/tests/…` in the frontend): **PW-TM** `test-management.spec.ts`, **PW-TS** `test-submissions.spec.ts`, **PW-TK**
`test-marking.spec.ts`, **PW-TR** `test-results.spec.ts`, **PW-WF** `test-workflow.spec.ts`. Test titles are quoted exactly
(the describe is shortened).

The complete workflow (creation → publication, with every role transition, an extension, second marking, adjustment,
unlock and republication) is **WF** (8 steps, API) and **PW-WF** (6 steps, browser).

## Permissions and access control

| # | Scenario | Tests |
|---|---|---|
| 1 | Coaches cannot access another subject's submissions | **SC** "scenario 1: a coach authorised and assigned in Physics cannot open, read or mark a Mathematics submission; their queue shows Physics only" (P4); **TK** "every marker request checks the assignment: another coach, an unknown code, a malformed code → 403"; **TK** "permissions per role and route: …" |
| 2 | Coaches cannot access unassigned submissions | **TK** "every marker request checks the assignment: another coach, an unknown code, a malformed code → 403"; **TK** "reassignment (reason): the new coach starts fresh and never sees the previous draft; the previous coach is refused"; **SC** "scenario 17: the marking guide — the assigned marker yes; an authorised but unassigned coach, a teacher, a student: no" |
| 3 | Coaches cannot see identifying student information or extension status | **TK** "BLIND: the marker sees the code, the test and the answer — never a name, school, submitter, extension or time; neutral file names and headers"; **WF** "4. the Head Coach distributes; coach A marks BLIND (code only) and submits for approval"; **uMR** "the forbidden field list covers identity, school, contacts, submitter, teacher, extensions, times and other markers", "assertBlind passes a marker view and refuses a leak at any depth"; **uAM** (identifying metadata removed from pages); **uDC** "test.marking.assigned / returned …"; **PW-TK** "coach A: the marking queue and a blind marking page — a code only; draft, then submit for approval" |
| 4 | Teachers cannot submit for students of another school | **TS** (G2) "a primary AND a secondary teacher submit; another school's teacher or a pending student: 403 STUDENT_NOT_IN_SCOPE", "lists tests and only their own verified students (not pending, not another school's)"; **SC** "scenario 19: …" (P4) |
| 5 | Any teacher linked to a school can submit for any eligible student of it | **TS** (G2) "a primary AND a secondary teacher submit; …"; **WF** "3. … the teacher submits for a classmate under a teacher extension"; **uP** "Test Management (WS3, Phase 2): … every Teacher submits for their school (G2), not a delegation"; **PW-TS** "Tests → the test's students → submit a typed answer for a classmate" |
| 6 | The submitting teacher's identity is recorded correctly | **TS** "a primary AND a secondary teacher submit; …" (submitterRole, submittedById, teacherId); **TS** "Administrators and Head Coaches see "extended" and the under-extension mark; the tracking counts and filters"; **WF** step 3 (submitterRole TEACHER, teacherId); **SC** "scenario 30: …" |
| 7 | Head Coaches cannot manage tests, markers or results of another subject | **SC** "scenarios 7, 41, 51: another subject's Head Coach is refused on EVERY action of a test they do not head — tests, markers, extensions, submissions, marking, review, approval, results, rankings" (P4); **TM** "another subject: 403 SCOPE_FORBIDDEN on every route, including the marking guide; nothing changes"; **TR** "permissions per role and route: …" (every results route); **PW-TM** "the coach portal lists Physics tests only, offers only Physics, and refuses the Mathematics test" |
| 8 | Administrators can manage all subjects | **TM** "Administrator: full access in every subject" (all five tests); **TM** "subjects: Administrators see every subject; a Head Coach only those they head"; **TR** "dashboards: …" (Administrator: every subject); **uTR** "subject scope …" |
| 9 | Several Head Coaches of one subject can each act | **SC** "scenario 9: two Head Coaches of the same subject may each act on the other's work; every action records exactly which one acted" (P4); **SC** "scenarios 24, 25: …" (edits by either Head Coach) |
| 10 | Removing a Head Coach or a coach authorisation stops further access | **SC** "scenario 10: a Head Coach removed from the subject loses every Test Management action at once (tests, extensions, submissions, review, publication, rankings)" (P4); **TK** "authorisation revoked mid-way: every marker request is refused at once; the queue drops that subject"; **TM** "a Head Coach who heads nothing sees nothing and creates nothing" |

## Test eligibility and answer formats

| # | Scenario | Tests |
|---|---|---|
| 11 | Students cannot see or submit tests outside their division | **TS** "a student sees published tests of their division only; a draft or another division is not revealed"; **uSR** "divisions: Junior S1–S3, Senior S4–S6, All any student (incl. one without a grade)" |
| 12 | Teachers cannot submit for students outside the test division | **TS** "a primary AND a secondary teacher submit; …" (403 DIVISION_MISMATCH); **SC** "scenario 19: …" (a Senior student, a Junior test) |
| 13 | Upload-only tests reject typed-only answers | **TS** "answer formats are enforced (typed only / upload only / both)"; **uSR** "UPLOAD_ONLY: pages, no typed answer" |
| 14 | Typed-only tests reject upload-only answers | **TS** "answer formats are enforced (typed only / upload only / both)"; **uSR** "TYPED_ONLY: a typed answer, no pages (pages are refused before storing)" |
| 15 | Both-format tests accept the supported combinations | **TS** "answer formats are enforced …", "photos page by page: a weak connection retries one page; missing pages block the submission; then a typed + 2-page version"; **WF** step 3 (typed + page; typed only); **uSR** "BOTH: typed and/or pages, at least one"; **PW-TS** "typed answer + two photo pages; page 2 fails on a weak connection and is retried alone; submit → version 1" |
| 16 | Upload limits and file types are enforced | **SC** "scenario 16: answer pages — the 20 MB limit and the allowed types are enforced; nothing is stored for a refused page" (P4); **TS** "answer formats are enforced …" (415, 31 pages → TOO_MANY_PAGES); **TM** "files: paper and marking guide — private, PDF or images, neutral names; replace and remove"; **uSR** page-count tests |
| 17 | Only authorised users can access marking guides and answer keys | **SC** "scenario 17: the marking guide — the assigned marker yes; an authorised but unassigned coach, a teacher, a student: no" (P4); **TM** "Coaches, Teachers and Students reach no test-management route (403 PERMISSION_REQUIRED); anonymous 401"; **TS** "the paper: students and teachers read it once the test is open (neutral name); the marking guide never"; **TK** "authorisation revoked mid-way: …" |

## Deadlines and extensions

| # | Scenario | Tests |
|---|---|---|
| 18 | Individual student extensions apply only to that student | **TS** "extensions: validated; a student extension reopens that student only; the original deadline never changes"; **SC** "scenarios 24, 25: …"; **uSR** "a student extension applies to that student only (submitted by them or by a teacher)"; **PW-TS** "the deadline shown is the extension's; nothing says Extended" |
| 19 | Teacher extensions apply only to that teacher and eligible students of their school | **TS** "a teacher extension: only that teacher's submissions; student + teacher extensions → the later one"; **SC** "scenario 19: a teacher extension never lets that teacher submit for another school's student, another division or a pending student" (P4); **uSR** "a teacher extension applies only to THAT teacher's submissions — never the student's own, never another teacher's" |
| 20 | Whole-test extensions apply to everyone | **SC** "scenario 20: a whole-test extension applies to everyone — several students and teachers of different schools" (P4); **TS** "edit and cancel before expiry, with reasons; a cancelled extension is ignored; an expired one cannot change"; **uSR** "a whole-test extension applies to every student, whoever submits" |
| 21 | The correct deadline when several extensions apply | **TS** "a teacher extension: …; student + teacher extensions → the later one"; **uSR** "student AND teacher extensions both applying → the later of the two (either order)", "whole-test, student and teacher together: the latest wins", "a tie keeps the whole-test extension first, then the student's, then the teacher's"; **uMR** "whole-test, student and relevant teacher extensions all count; the latest wins" |
| 22 | No submission after the applicable deadline | **TS** "after the deadline every submission and upload is refused (late: blocked)"; **WF** step 3 (the classmate's own late attempt: 409); **uSR** "exactly at the deadline: on time; one millisecond later: late (409 DEADLINE_PASSED)" |
| 23 | No replacement after the applicable deadline | **TS** "edit and cancel before expiry, …"; **TS** "a teacher extension: …"; **TK** "once marking began, nothing can arrive for that student: submit refused; …"; **SC** "scenarios 24, 25: …" |
| 24 | Editing or cancelling extensions updates eligibility | **SC** "scenarios 24, 25: editing an extension moves exactly that student's deadline (later, then earlier — enforced); creation, edit and cancellation are audited with actor, reason and deadlines" (P4); **TS** "edit and cancel before expiry, …"; **uSR** "cancelled extensions are ignored" |
| 25 | Extension creation, editing and cancellation are audited | **SC** "scenarios 24, 25: …" (actor, kind, student, reason, before / after deadlines) (P4); **TS** "every extension write is audited (TESTS); the individual recipients are told once (dedupe), whole-test extensions notify nobody"; **PW-TS** "gives the student an extension with a reason (audited)" |
| 26 | Markers never receive extension information through any API | **SC** "scenario 26: NO marker response carries extension information — queue, detail, save, submit, errors, file headers, notices" (P4); **TK** "BLIND: …"; **TK** "second marking: …"; **uMR** forbidden-field tests |

## Submissions and history

| # | Scenario | Tests |
|---|---|---|
| 27 | Only existing student accounts can have submissions | **SC** "scenario 27: only existing student accounts can have submissions — an unknown id, a teacher, a coach or an Administrator is refused; nothing is created" (P4); **TS** "a primary AND a secondary teacher submit; …" (pending, suspended); **TS** "permissions per role: …" |
| 28 | Submission records identify the student and the actual submitter | **TS** "a primary AND a secondary teacher submit; …"; **TS** "Administrators and Head Coaches see "extended" …"; **WF** step 3; **PW-TS** "Submissions: the student submitted (2 versions), marked Extended; the versions show the submitter" |
| 29 | Replacements preserve previous versions | **TS** "replace before the deadline: a new version; every version is kept and readable"; **PW-TS** "replace before the deadline → version 2; version 1 is kept" |
| 30 | Timestamps and version histories are accurate | **SC** "scenario 30: submission times are the database's, versions are numbered in order and each keeps its own time and deadline" (P4); **TS** "replace before the deadline: …"; **TK** "approve locks; …" (status history); **TR** / **WF** (status history to PUBLISHED and back) |
| 31 | Concurrent replacements cannot corrupt the history | **TS** "10 parallel replacements: 10 new versions numbered without gap or duplicate; the current one is the last"; **TS** "idempotent: the same clientKey again (also in parallel) returns the same version, never a second one" |

## Marking

| # | Scenario | Tests |
|---|---|---|
| 32 | Coaches cannot mark beyond question or test maxima | **TK** "marks: whole numbers, never above the maxima; drafts; 10 parallel draft saves apply one after another; every change logged"; **TK** "a test without questions is marked as one total, never above the test maximum"; **TK** "the database keeps the history: …"; **uMR** "refuses fractions, negatives, marks above a question's maximum, …" |
| 33 | Question maxima sum to the test maximum | **TM** "validation: division mandatory, opensAt < closesAt, whole positive marks, answer format enum, question sum"; **TM** "questions: add, edit, reorder, remove — never above the total; the sum is shown against the maximum"; **uTR** "question sum rule"; **PW-TM** "questions: the sum against the maximum, reordering; files under neutral names" |
| 34 | A draft does not submit marks for approval | **TK** "marks: … drafts; …"; **PW-TK** "coach A: … draft, then submit for approval" |
| 35 | Submitted marks enter the approval process | **TK** "submit for approval: every question marked; the same submission again is a replay; then the marks are locked"; **uMR** "no step can be skipped: …" |
| 36 | Returned submissions can be corrected and resubmitted | **TK** "return for correction needs a comment; the marker sees it, corrects, resubmits"; **SC** "scenario 9: …", "scenario 40: …" |
| 37 | Second marking is independent and blind | **TK** "second marking: another authorised coach only; independent and blind (no first marks); then a choice is required"; **WF** step 5; **PW-WF** "3. … a second marking by the other coach" |
| 38 | The second marker cannot see the first marker's marks or comments | **TK** "second marking: …"; **WF** step 5; **PW-TK** "coach B marks independently: the first marks and comments are nowhere on the page" |
| 39 | The Head Coach's final decision is recorded correctly | **TK** "G4: an Administrator never chooses or adjusts; the Head Coach chooses with a mandatory reason, or adjusts (logged old → new)"; **WF** step 5 (final ADJUSTMENT approved); **SC** "scenario 9: …" (TestReview rows and actors); **PW-TK** "side by side; the Head Coach adjusts the mark (reason), approves (locked), unlocks (reason); History shows the change" |
| 40 | Every mark change is audited | **SC** "scenario 40: every marking step is audited — draft, submit, return, correction, choice, approval, unlock — and every mark change is logged" (P4); **TK** "marks: … every change logged"; **TK** "G4: …"; **uMR** "markDiff lists exactly the marks that changed (old → new, null = not given)" |

## Approval and publishing

| # | Scenario | Tests |
|---|---|---|
| 41 | Only authorised Head Coaches or Administrators can approve | **TK** "permissions per role and route: …"; **TK** "two reviewers approve at the same moment: one succeeds, the other gets 409; a repeated clientKey is a replay"; **SC** "scenarios 7, 41, 51: …" (another subject's Head Coach) and "scenario 10: …" (a former Head Coach) (P4); **uRS** (role × route sweep) |
| 42 | Approved marks cannot change without an authorised unlock | **SC** "scenario 42: approved marks are locked — the marker cannot save or resubmit, no second marking, no choice, the database refuses a change; only an authorised unlock reopens" (P4); **TK** "approve locks; …"; **uMR** "every (from, to) pair of the 8 statuses: exactly the approved ones are allowed" |
| 43 | Unlocking requires a reason and is audited | **TK** "approve locks; unlock needs a reason (Administrator or subject Head Coach), audited; approve again"; **TR** "G6: unlocking a published result withdraws it …"; **PW-TK** "side by side; … unlocks (reason); …" |
| 44 | Unapproved marks cannot be published without the Administrator's override | **TR** "a Head Coach is BLOCKED while any result is unapproved and can never override (route and service); nothing changes"; **TR** "Administrator override: the reason is mandatory; only the approved results are published; …"; **uRR** "a Head Coach is BLOCKED while any result is unapproved …", "an Administrator is blocked too without an override; …"; **uMR** "PUBLISHED (Phase 4): reached only by PUBLISH from APPROVED; …"; **PW-TR** "Head Coach: one result not approved → publishing is blocked, and no override is offered" |
| 45 | Head Coaches cannot use the Administrator override | **TR** "a Head Coach is BLOCKED … and can never override (route and service); …"; **TR** "permissions per role and route: …" (override route 403 for Head Coaches); **uRR** "a Head Coach can NEVER override — whatever the request says, with or without a reason (403 OVERRIDE_NOT_ALLOWED)"; **uP** "Test Management (WS3, Phase 4): … the override for Administrators only (never a Head Coach, never by individual grant) …"; **PW-TR** "Head Coach: … no override is offered" |
| 46 | An override requires a reason and creates an audit entry | **TR** "Administrator override: the reason is mandatory; only the approved results are published; audited (published + overridden, with the reason); status history kept"; **uRR** "… the override needs a reason of at least 10 characters"; **PW-TR** "Administrator: override with a mandatory reason publishes the approved results only (audited)" |
| 47 | Students and teachers cannot see unpublished marks | **TR** "results stay hidden from students and teachers until published — an APPROVED result is not a published one"; **TR** "G6: … re-approval alone does not show it …"; **WF** step 6; **PW-TR** "the unapproved student sees nothing published; …" |
| 48 | Students and teachers cannot see rankings | **TR** "rankings for Administrators and the subject's Head Coaches: …" (403 for student, teacher, coach); **TR** "students see only their own published result: … never a rank", "teachers see only the published results of their own school's students, by name, never ranked; …"; **uRR** "rankings for students: designed (a per-test option exists) but OFF — …", "assertResultSafe refuses a rank, …"; **uP** (Phase 4 test); **PW-TR** "the student sees their own result — … and never a rank" |
| 49 | Students only see their own published results | **TR** "students see only their own published result: marks per question, total, comments — never the marker, never a rank"; **WF** step 7; **PW-TR** "the student sees their own result …"; **PW-TR** mobile "student on a phone: …" |
| 50 | Teachers only see published results of their own school's students | **TR** "teachers see only the published results of their own school's students, by name, never ranked; another school's student is not found"; **WF** step 7; **PW-TR** "… the teacher sees the school's published results by name, never ranked"; **PW-TR** mobile "teacher on a phone: …" |
| 51 | Head Coaches only access results and rankings of their subjects | **SC** "scenarios 7, 41, 51: …" (results, preview, publish, rankings, report, export) (P4); **TR** "permissions per role and route: …" (another subject's Head Coach: 403 SCOPE_FORBIDDEN on every results route); **TR** "rankings for Administrators and the subject's Head Coaches: …"; **TR** "dashboards: …" (a Head Coach's dashboard: their subject only); **TR** "report and CSV exports: …" (the reporting overview omits another subject) |
| 52 | Publishing notifications are not duplicated on retries | **TR** "five simultaneous publications: exactly one publishes, the others replay it; repeating publishes nothing; every recipient told exactly once"; **TR** "notifications: each student once, their school's teacher once (not once per student), …"; **TR** "G6: … told once (a retry adds nothing) …"; **TR** "performance sanity: publishing 5,000 approved results — …" (5,001 notices, none on the repeat); **uDC** "test.results.published / test.result.withdrawn (Test Management Phase 4): the test and a link to the results page — never a mark, a rank or another student" |

## Summary

52 of 52 scenarios are covered by named automated tests; scenarios 1, 7, 9, 10, 16, 17, 19, 20, 24, 25, 26, 27, 30, 40,
41, 42 and 51 gained explicit tests in Phase 4 (`test/test-scenarios.e2e-spec.ts`) where the earlier phases covered them
only in part. The complete workflow is covered end to end in the API (**WF**) and in the browser (**PW-WF**).
