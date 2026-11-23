/**
 * The capabilities advertised by GET /api/v1 (additive; backends that predate it send no
 * `capabilities` field at all — that absence is how a client recognises one).
 *
 * Rules:
 *  - every feature names behaviour THIS build implements; a feature is never derived from a
 *    version number or from probing endpoints;
 *  - a feature behind a feature flag is listed only while the running configuration enables
 *    it, read at request time through the same check the API itself enforces (roleFlagOn);
 *  - the endpoint is public, so it lists only what a client needs to choose a code path:
 *    no environment names, flag values, hosts, counts, versions of dependencies or any
 *    other internal detail.
 *
 * Capabilities describe the BACKEND, never the caller: they are the same for every viewer and say
 * nothing about anyone's permissions or access (that is GET /api/v1/me/permissions).
 *
 * Changing the shape: adding a feature is additive; renaming or removing one, or changing
 * `roles` / `features` semantics, needs a new `schemaVersion` (the frozen V1 vocabulary in
 * capabilities.spec.ts enforces this). Clients: docs/INTEGRATION.md "Backend capabilities".
 */
import { APP_ROLES, type AppRole } from '../auth/permissions.js';
import { roleFlagOn } from '../auth/role-assignment.policy.js';

export const CAPABILITIES_SCHEMA_VERSION = 1;

/** Every feature this build can advertise, with what a client may rely on when it is listed. */
export const FEATURES = {
  /** GET /api/v1/me/permissions also returns roleLabel, scopes.courseDivisions, scopes.programmes and overrides. */
  permissionScopes: 'always',
  /**
   * POST /api/v1/admin/users/invite and /admin/users/import name an EXISTING school by schoolId or
   * schoolCode (6 digits). A school name never creates or picks a school: alone it is refused
   * (SCHOOL_REFERENCE_REQUIRED); with a reference it must match (SCHOOL_NAME_MISMATCH).
   * POST and PATCH /api/v1/admin/users accept schoolCode as well as schoolId.
   */
  schoolReferenceRequired: 'always',
  /** /api/v1/admin/schools: create, edit, activate/deactivate, import, contacts, offerings, history. */
  schoolAdministration: 'always',
  /** Students claim a school (/api/v1/me/school-affiliation); staff review claims (/api/v1/admin/school-affiliations). */
  schoolAffiliations: 'always',
  /**
   * POST /api/v1/admin/academic-years/:id/activate is single-flight and safe to retry: while a start
   * runs, another is refused (409 ACTIVATION_IN_PROGRESS); a repeated start of a year already started
   * with the same choices returns the recorded outcome (`replayed: true`) without doing anything again;
   * other choices → 409 ACTIVATION_OPTIONS_DIFFER; and `expectedCurrentYearId` refuses a start whose
   * current year changed meanwhile (409 CURRENT_YEAR_CHANGED).
   */
  academicYearActivation: 'always',
  /**
   * GET /api/v1/mentor/reviews accepts `q` (student name or username), `group` (open | done | all),
   * `sort` (submitted | recent | name | score) and applies `courseId` / `divisionId`; its answer adds
   * `counts` ({ open, done, all } of the same scope without search or status). Without this feature
   * those parameters are refused (400) and the scope filter is ignored.
   */
  reviewQueueFilters: 'always',
  /**
   * The Reports CSV exports apply the Reports page filters: results.csv accepts academicYearId,
   * from/to (submitted between), courseId and divisionId besides assignmentId; enrollment.csv and
   * GET /admin/reports/enrollment accept courseId (students taking part in that course). Without this
   * feature results.csv refuses those parameters (400) and enrolment refuses courseId (400
   * FILTER_NOT_SUPPORTED).
   */
  reportExportFilters: 'always',
  /**
   * Assignment lists filter and sort in the database: GET /me/assignments accepts `progress`
   * (NOT_STARTED | SUBMITTED | PENDING_REVIEW | RESUBMISSION_REQUESTED | REVIEWED | OVERDUE) and `sort`
   * (deadline | -deadline | title); GET /assignments accepts `statuses` (comma-separated). Paging
   * and totals count the matches. Without this feature those parameters are refused (400).
   */
  studentAssignmentFilters: 'always',
  /**
   * The official-directory sync (/api/v1/admin/school-sync): dry-run runs from a source export,
   * items, changes, report.csv, review summary, categories, decisions, proposals and recompare
   * (schools.manage); approve, apply and resolve after apply (schools.syncDirectory: Super Admins
   * only). Appended 2026-11-14 (owner decision: released with school import and contacts; before
   * that it was deliberately not advertised, owner decision 2026-11-12).
   */
  schoolDirectorySync: 'always',
  /**
   * The decision-notification delivery log: GET /api/v1/admin/notification-deliveries and
   * POST /api/v1/admin/notification-deliveries/:id/retry (email.bulkSend). Not behind a flag (the log is
   * always there); teacher-registration notices are only sent while teacher self-registration is on.
   */
  notificationDeliveries: 'always',
  /**
   * Olympiad interests of students (owner decision 8): POST /api/v1/auth/register/student and PATCH /api/v1/me
   * accept `olympiadInterests` (one or more of MATHEMATICS, COMPUTING, PHYSICS; optional at registration),
   * and the profile (GET /api/v1/me, admin user detail), the students report and students.csv return them.
   * Without this feature the field is refused (400): the sign-up form must not send it.
   */
  studentOlympiadInterests: 'always',
  /**
   * Student registration details: POST /api/v1/auth/register/student accepts `dateOfBirth` (YYYY-MM-DD, age 5–30),
   * `phone` (optional) and `guardianPhone` (close-family phone; both stored in E.164), `homeCountry` (the student's own
   * country) and the official home place `homeProvince` / `homeDistrict` / `homeSector` (Rwanda only; then
   * `homeLocation` is optional). `dateOfBirth` is required (owner, 2026-11-17); the others are optional at the API for older clients; the profile (GET /api/v1/me, admin user
   * detail) returns them. Without this feature the fields are refused (400): the sign-up form must not send them.
   */
  studentRegistrationDetails: 'always',
  /**
   * Gender at sign-up (owner, 2026-11-20): POST /auth/register/student, /auth/register/teacher and /mentor-requests
   * require `gender` (FEMALE or MALE); stored on the account (copied from the application on approval) and returned
   * as `gender` by GET /api/v1/me. NULL on older accounts. Without this feature the field is refused (400).
   */
  registrationGender: 'always',
  /**
   * Home location on every registration form and profile edit (owner, 2026-11-20): the home country is required
   * (student `homeCountry`, teacher and coach `country`); with Rwanda `homeProvince`, `homeDistrict` and `homeSector` are
   * required (official directory), with another country they are not asked (400 HOME_LOCATION_RWANDA_ONLY if sent).
   * PATCH /me and PATCH /admin/users/:id accept `homeCountry` with the place. Approval copies a teacher's or coach's
   * home location to the account. Separate from the school location.
   */
  homeLocationRules: 'always',
  /**
   * "My school is not listed" with the school's official details (owner, 2026-11-22): POST /auth/register/teacher
   * accepts `proposedSchoolCode` (6 digits, required with `proposedSchoolName`; 400 INVALID_SCHOOL_CODE; 409
   * SCHOOL_CODE_LISTED naming the listed school), optional `proposedSchoolCell` / `proposedSchoolVillage`,
   * `proposedSchoolOwnership` and `proposedSchoolAccommodation`. Approving such an application adds the school to the
   * official list from them in ONE step (schools.manage; 409 POSSIBLE_DUPLICATE unless `confirmPossibleDuplicate`), or
   * uses the school listed with that code since. Applications without a code still need "Verify school" first.
   */
  teacherUnlistedSchoolDetails: 'always',
  /**
   * Gender step (owner, 2026-11-20): GET /me and the sign-in answer carry `genderRequired`, true for a STUDENT, TEACHER
   * or MENTOR without a gender (accounts from before gender was asked at sign-up); the portal then asks it once:
   * PUT /api/v1/me/gender { gender: FEMALE | MALE } (409 GENDER_ALREADY_SET). PATCH /admin/users/:id accepts `gender`
   * to correct it.
   */
  genderStep: 'always',
  /**
   * Coach application details: POST /api/v1/mentor-requests accepts `country`, `occupation`, `educationLevel`
   * (SECONDARY | DIPLOMA | BACHELOR | MASTER | DOCTORATE | OTHER) and `olympiadInterests`; the admin list returns them
   * and approval copies country and interests to the Coach account. Optional at the API for older clients, except
   * `olympiadInterests`, required since 2026-11-19 (coachOlympiadInterests). Without this feature the fields are refused (400).
   */
  coachApplicationDetails: 'always',
  /**
   * Coaches' subject interests (owner decision 2026-11-19, Option A: the existing `olympiadInterests`, no new data):
   * POST /api/v1/mentor-requests REQUIRES `olympiadInterests` (one or more of MATHEMATICS, COMPUTING, PHYSICS; no
   * duplicates) and approval copies it to the Coach account; a Coach views and edits their own on GET / PATCH /api/v1/me
   * (at least one when sent); an Administrator who may manage Coach accounts (users.manage + users.manageCoaches) edits a
   * Coach's on PATCH /api/v1/admin/users/:id (Coach accounts only: 400 INTERESTS_COACH_ONLY). Existing coaches without
   * interests stay valid; nothing is ever filled in automatically. Information only: never grants marking or any permission.
   */
  coachOlympiadInterests: 'always',
  /**
   * Application details and "request more information" (2026-11-17; ADR-009): POST /auth/register/teacher accepts
   * `position` and `yearsOfExperience`; POST /mentor-requests accepts `phone`, `affiliation`, `expertise`,
   * `relevantExperience` and `yearsOfExperience`; PATCH /mentor-requests/:id/reject takes an optional `reason`
   * (e-mailed, like a Teacher rejection's); Administrators ask a question with POST
   * /admin/teacher-applications/:id/request-info or POST /mentor-requests/:id/request-info (the application stays
   * PENDING; `infoRequests` on the application lists the questions and answers); the applicant answers through
   * POST /applications/info-requests/view and /answer, token in the body (410 INFO_REQUEST_LINK_INVALID once used,
   * expired or decided).
   * Without this feature the new fields are refused (400) and the routes do not exist (404).
   */
  applicationDetails: 'always',
  /**
   * Optional profile picture at registration (REG-02): student registration and Teacher / Coach application answers
   * carry avatarUploadToken for PUT /api/v1/auth/register/avatar (the first picture of that account / pending
   * application, 30 minutes). Never required.
   */
  registrationAvatar: 'always',
  /**
   * Teacher–student access (owner approvals TS-1…TS-6, 2026-11-18): explicit teacher–student assignments
   * (/admin/teacher-students, reassign), School Access (/admin/schools/:id/access, …/students), teacher delegations
   * with a student scope (studentScope SCHOOL | ASSIGNED | SELECTED, studentIds; …/delegations/:overrideId/students,
   * …/reviewed), bulk actions assignTeacher / unassignTeacher / grantDelegation / revokeDelegation, and for Teachers
   * GET /teacher/students/summary and `access` / `can` on each listed student. Without this feature none of these
   * exist and every delegation applies to the teacher's whole school scope.
   */
  teacherStudentAccess: 'always',
  /**
   * Primary teacher of a school (owner decision 2026-11-19): every teacher–school link has `role` PRIMARY (the school's
   * designated main contact, at most one active per school) or SECONDARY — the same rights either way. GET
   * /admin/teacher-assignments returns `role` and filters by `?role=`; POST /admin/teacher-assignments/:id/primary makes a
   * teacher the primary (the previous one becomes secondary; users.manageTeachers); School Access rows carry `role`;
   * GET /admin/users TEACHER rows carry `teacherSchoolRole` (PRIMARY | SECONDARY | null), `school` (the primary school, else
   * the earliest active one; owner 2026-11-22) and `schoolCount` (active schools); Teachers read their own schools
   * and role at GET /teacher/schools. A school can have no primary teacher (none is promoted automatically).
   */
  primaryTeacher: 'always',
  /**
   * Schools table (2026-11-19): GET /admin/schools accepts `sort` (name | verifiedStudents) and `order` (asc | desc),
   * kept with every filter and with pagination, and each row carries `primaryTeacher` ({ id, username, firstName,
   * lastName } or null). `verifiedStudents` counts students whose CURRENT school claim an Administrator verified.
   */
  schoolsTable: 'always',
  /**
   * School list filters on every field of the NESA file (owner, 2026-11-23): GET /admin/schools (and the SCHOOL bulk
   * selection) also filter by `ownership`, `cell`, `village`, `contact` (an active e-mail or phone containing the text;
   * a phone typed with or without the leading 0 or +250), `hasEmail`, `hasPhone` and `programmeCategory`. Contact values
   * are still never in the list.
   */
  schoolListFilters: 'always',
  /**
   * E-mail activation per sign-up form (owner 2026-11-23): GET /admin/forms carries `requireEmailVerification` on the
   * student, teacher and coach forms (off by default); PATCH /admin/forms/:key/availability accepts it
   * (forms.manageAvailability; 400 NOT_A_SIGN_UP_FORM for the contact form). The setting
   * registration.requireEmailVerification reads true while any sign-up form requires it and writing it sets all of them.
   */
  formEmailVerification: 'always',
  /**
   * First-sign-in date of birth (owner decision 9.3): GET /api/v1/me and the login profile carry
   * `dateOfBirthRequired`; while true (a STUDENT without a date of birth — created by an Administrator, invited or
   * imported) every route except GET /me, GET /me/permissions, PUT /me/date-of-birth and sign-out answers
   * 403 DATE_OF_BIRTH_REQUIRED. PUT /api/v1/me/date-of-birth { dateOfBirth: "YYYY-MM-DD" } ends the step.
   */
  studentDateOfBirthStep: 'always',
  /**
   * Administrators correct a student's date of birth (owner approval 2026-11-18): PUT /api/v1/admin/users/:id/date-of-birth
   * { dateOfBirth, reason } (users.manage; reason mandatory), GET /api/v1/admin/users/:id/date-of-birth-history (old and
   * new dates, reason, who, when). A student still gives it only once (PUT /me/date-of-birth).
   */
  dateOfBirthCorrection: 'always',
  /**
   * Picture moderation (owner approval 2026-11-18): an application's picture is shown only to the reviewing
   * Administrator (GET /api/v1/admin/teacher-applications/:id/avatar, GET /api/v1/mentor-requests/:id/avatar; the lists
   * carry avatarFileId) and becomes the account's picture only when the approval sends approvePicture: true.
   */
  applicationPictureReview: 'always',
  /**
   * The TEACHER role can currently be given to an account (TEACHERS_ENABLED). The caller still
   * needs users.manageTeachers (/me/permissions). Absent: no NEW Teacher role assignments — existing
   * TEACHER accounts may still exist and use their portal.
   */
  teacherAccounts: 'TEACHER',
  /**
   * Teacher self-registration is implemented: GET /api/v1/auth/register/teacher/availability says whether
   * it is open right now (also the registration.teacherSelfSignup setting); POST /api/v1/auth/register/teacher
   * submits an application; Administrators (users.manageTeachers) review it at
   * /api/v1/admin/teacher-applications. Gated like teacherAccounts (TEACHERS_ENABLED).
   */
  teacherSelfRegistration: 'TEACHER',
  /**
   * Profile pictures: PUT / DELETE /api/v1/me/avatar (multipart field `file`: JPEG, PNG or WebP, at most 2 MB;
   * 400 FILE_REQUIRED / EMPTY_FILE, 413 PAYLOAD_TOO_LARGE (over 2 MB), 415 FILE_TYPE_NOT_ALLOWED), PUT / DELETE
   * /api/v1/admin/users/:id/avatar (users.manage, accounts whose role the caller may manage), and
   * GET /api/v1/users/:id/avatar (any signed-in user; 404 without a picture). avatarUrl in the profile is that
   * versioned link (`?v=`), or null. Without this feature those routes do not exist (404).
   */
  profilePictures: 'always',
  /**
   * Account states (2026-11-16): accountStatus (ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED) on admin user records and
   * the ?accountStatus= filter of GET /api/v1/admin/users; POST /api/v1/admin/users/:id/status-changes {toStatus,
   * reason} and GET /api/v1/admin/users/:id/status-history; login refusals ACCOUNT_DEACTIVATED / ACCOUNT_SUSPENDED /
   * ACCOUNT_ARCHIVED; DELETE /api/v1/admin/users/:id answers 409 PERMANENT_DELETION_DISABLED (archive instead).
   */
  accountStates: 'always',
  /**
   * Bulk user operations (2026-11-17): POST /api/v1/admin/users/bulk/preview (count, sample, warnings, selectionToken),
   * POST /api/v1/admin/users/bulk (202; idempotent per idempotencyKey; 409 SELECTION_CHANGED), GET /api/v1/admin/users/bulk,
   * GET /api/v1/admin/users/bulk/:id, GET /api/v1/admin/users/bulk/:id/items, POST /api/v1/admin/users/bulk/:id/cancel and
   * POST /api/v1/admin/users/bulk/export (CSV). Actions: activate, deactivate, suspend, archive, restore, assignRole,
   * changeClassification (a student's grade, and so division), message; with olympiadLevels also setOlympiadLevel.
   */
  bulkUserOperations: 'always',
  /**
   * Generic bulk engine (2026-11-19; docs/operations/bulk-operations.md): GET /api/v1/admin/bulk/actions (the record
   * types and actions the caller may run, with requiresReason and consequence), POST /api/v1/admin/bulk/{entityType}/preview,
   * POST /api/v1/admin/bulk/{entityType} (202; idempotent per idempotencyKey), POST /api/v1/admin/bulk/{entityType}/export,
   * GET /api/v1/admin/bulk/operations[/{id}[/items]] (items carry entityId) and POST …/operations/{id}/cancel. Record
   * types: USER (the same actions as /admin/users/bulk, plus reassignTeacher there too). The preview's selectionToken is
   * now a signed confirmation valid 15 minutes for the administrator who previewed (confirmationExpiresAt): execute
   * answers 410 CONFIRMATION_EXPIRED, 403 CONFIRMATION_WRONG_ADMINISTRATOR or 400 CONFIRMATION_INVALID — preview again.
   */
  bulkOperationsGeneric: 'always',
  /**
   * "Other" Olympiad interest (owner, 2026-11-21): `olympiadInterestOther` (2–100 characters, e.g. "Chemistry") beside
   * `olympiadInterests` on POST /auth/register/student, POST /teacher-applications, POST /mentor-requests, PATCH /me and
   * PATCH /admin/users/:id (Coach accounts); returned on the profile, users and applications. With it, the subjects may
   * be empty ("Other" alone). null clears it, only beside at least one subject. Never a subject: grants nothing.
   */
  olympiadInterestOther: 'always',
  /**
   * Teacher self-service and locked submissions (owner, 2026-11-21):
   *  - a Teacher who registers with a LISTED school gets the account at once (POST /teacher-applications answers
   *    accountCreated: true; signed in unless e-mail verification is on); an unlisted school still needs an Administrator;
   *  - a teacher sees the students whose CURRENT school claim (PENDING or VERIFIED) is their school — no Administrator step;
   *  - a submitted test answer is locked for the student and their teachers (409 SUBMISSION_LOCKED); an Administrator
   *    unlocks it for one replacement (POST/DELETE /admin/tests/:id/submissions/:submissionId/resubmission,
   *    tests.authorizeResubmission); views carry `locked` and the open authorization;
   *  - an Administrator revokes / restores a teacher's test submission (GET/PUT /admin/teachers/:id/test-submission;
   *    `testSubmissionAllowed` on TEACHER rows of GET /admin/users);
   *  - GET /teacher/tests/:id/students filters by ?division and ?subject and returns each student's interests and level.
   */
  testSubmissionLock: 'always',
  /**
   * Olympiad levels (owner 2026-11-21): every student has an Olympiad level — JUNIOR, MIDDLE or SENIOR (`olympiadLevel`
   * on the profile, the Users list and the teachers' lists; `olympiadLevelManual` for administrators) — separate from
   * the school grade. The grade suggests it (S1–S2 Junior, S3–S4 Middle, S5–S6 Senior); a holder of
   * students.classifyLevel sets it by hand or returns it to the suggestion (GET / PUT /admin/students/:id/olympiad-level,
   * reason, history; bulk action setOlympiadLevel). Tests may be for MIDDLE; eligibility, the teachers' lists and the
   * rankings use the level (each result keeps the level it was submitted at). GET /admin/users and /teacher/students
   * filter by ?olympiadLevel. Without it: two levels from the grade (S1–S3 Junior, S4–S6 Senior).
   */
  olympiadLevels: 'always',
  /**
   * Administrator-managed divisions (owner 2026-11-22): POST /admin/divisions; PATCH with suggestedGrades and sortOrder
   * (grades given to a division are taken from the one that had them); deactivation guarded; GET / PUT
   * /admin/divisions/:id/courses (which courses a division offers; students see only those);
   * POST /admin/mentor-assignments/bulk (ALL / DIVISION / PAIRS, dryRun preview, never a duplicate).
   */
  adminDivisions: 'always',
  /**
   * The Student Profile Overview (owner 2026-11-22): GET /students/:id/overview — photo, name, username, country, school,
   * grade, Olympiad level, subjects (status for staff); the student's picture visible to whoever may view it.
   */
  studentOverview: 'always',
  /** Custom reports (owner 2026-11-22): /reports — sources, preview, save, run, CSV / Excel export, grants (view / download / edit). */
  customReports: 'always',
  /** Table layouts (owner 2026-11-22): /me/table-layouts/:table and /admin/table-layouts/:table; GET /admin/users ?sort&order. */
  tableLayouts: 'always',
  /**
   * Teachers and their assigned students in Test Management (owner 2026-11-23): a teacher submits answers for, and follows
   * the results and extensions of, the students of their schools AND the students assigned to them (another school's
   * too); /teacher/tests lists them; ?schoolId may name an assigned student's school.
   */
  teacherAssignedTestStudents: 'always',
  /**
   * Course homework by teachers, by default (owner 2026-11-23, confirmed 2026-11-24): every Teacher sees the homework
   * progress of, and hands course homework in for (POST /teacher/students/:id/submissions), the students they see — their
   * schools' students and the students assigned to them, the same students as for tests — without a delegation
   * (students.viewProgress and submissions.submitOnBehalf are Teacher defaults; `can.viewProgress` / `can.submitOnBehalf`
   * on GET /teacher/students say so per student). An Administrator switches both off or on again for one teacher with
   * GET / PUT /admin/teachers/:id/homework-submission (users.manageTeachers; reason required to switch off; audited
   * TEACHER_HOMEWORK_SUBMISSION_REVOKED / _RESTORED). Switched off, an older delegation of either no longer applies.
   * Every on-behalf submission still records the teacher as the submitter. Clients stop offering those two delegations.
   */
  teacherHomeworkDefault: 'always',
  /**
   * Registration data (owner 2026-11-23): /admin/registration-data — every eligible registration field read from the database
   * (fields, query, export, record, edit), saved filters and column layouts. Super Administrators (registrationData.manage).
   */
  registrationData: 'always',
  /**
   * A school without a code chosen at registration (owner 2026-11-23): student registration and the teacher application
   * take newSchoolCode — required for such a school (400 SCHOOL_CODE_REQUIRED / INVALID_SCHOOL_CODE, 409 SCHOOL_CODE_TAKEN);
   * the first valid code becomes the school's.
   */
  schoolCodeAtRegistration: 'always',
  /**
   * Coaches across their programmes (owner 2026-11-23): every Coach, in each programme they belong to and at every level,
   * sees its students (GET /coach/students), opens and manages its courses, marks its tests (no authorisation needed) and
   * sees its published results (GET /coach/test-results); an Administrator or the programme's Head Coach takes any part
   * away per programme (GET / PUT /admin/coaches/:id/programme-access); /admin/test-markers/candidates says who marks by default.
   */
  coachProgrammeAccess: 'always',
  /**
   * News subscribers (owner 2026-11-23): public POST /public/subscribe (always 202, no enumeration), POST /public/unsubscribe
   * ({ id, token } from the link /unsubscribe?s=&t= in every e-mail) and RFC 8058 POST /public/unsubscribe/one-click;
   * /admin/subscribers (subscribers.manage): list, summary, export, add, import, edit, unsubscribe / subscribe again, erase,
   * and mailings (preview, test to me, send, list, detail, cancel while queued).
   */
  subscribers: 'always',
  /**
   * View as, READ ONLY (owner 2026-11-23): POST /admin/users/:id/view-as (users.impersonate; lower-ranked users only) →
   * a single-use 60-second ticket; POST /auth/view-as/exchange → a 30-minute viewing token (sub = the viewed user, no
   * refresh, no cookie); every non-GET request with it answers 403 VIEW_AS_READ_ONLY; 401 VIEW_AS_ENDED when it stops
   * working; POST /auth/view-as/end; GET /me carries `viewAs` { sessionId, actor, target, expiresAt }.
   */
  viewAs: 'always',
  /**
   * Form availability: GET /api/v1/forms and /forms/:key (public: open, state OPEN | CLOSED | NOT_YET_OPEN | ENDED,
   * schedule, closed message, instructions, contact e-mail, support link, timezone Africa/Kigali, server time) and
   * /api/v1/admin/forms (forms.view; PATCH :key/availability with forms.manageAvailability, PATCH :key/messages with
   * forms.editMessages; GET :key/history). Submissions to a closed form are refused with 403: REGISTRATION_CLOSED
   * (student and teacher registration) or FORM_CLOSED (coach applications, contact form), with the form details.
   */
  formAvailability: 'always',
  /**
   * Countries (design area 1 as simplified by the owner, 2026-11-19): public GET /api/v1/countries (every ISO 3166-1
   * alpha-2 country: code, name, calling code) and GET / PATCH /api/v1/admin/countries (reference.manage: correct a name
   * or calling code; audited). No country is ever blocked: a country identifies where someone or a school is, never a
   * level or division. Without this feature: use the built-in country list.
   */
  countries: 'always',
  /**
   * Test Management, Phase 1 (WS3; owner-approved plan 2026-11-19): /api/v1/admin/tests (tests.view, tests.manage:
   * list with subjectId / division / status / q filters, create, read, update, delete a draft, publish, unpublish;
   * questions add / edit / reorder / remove with the sum rule; PUT / GET / DELETE :id/files/paper|marking-guide, private,
   * neutral names) and /api/v1/admin/test-markers (tests.manageMarkers: list, candidates, grant, revoke with a reason).
   * Administrators: every subject; Head Coaches: the subjects they head. GET /admin/tests/subjects lists the caller's
   * subjects. Students, Teachers and Coaches see nothing of it yet (later phases).
   */
  testManagement: 'always',
  /**
   * Test Management, Phase 2 (WS3; owner-approved plan 2026-11-19): deadlines from database time incl. extensions;
   * /api/v1/me/tests (tests.submit: Students — their tests, paper, page-by-page uploads, submit / replace with every
   * version kept, idempotent per clientKey); /api/v1/teacher/tests (tests.submitForStudents: Teachers — verified students
   * of their own schools, G2); /api/v1/admin/tests/:id/extensions and /extension-targets (tests.extensions) and
   * /api/v1/admin/tests/:id/submissions (tests.viewSubmissions: tracking, every version). A test with submissions keeps its
   * division, format, window and marks and can be neither unpublished nor deleted (409 TEST_LOCKED_BY_SUBMISSIONS,
   * TEST_HAS_SUBMISSIONS); GET /admin/tests/:id reports submissionCount.
   */
  testSubmissions: 'always',
  /**
   * Test Management, Phase 3 (WS3; owner-approved plan 2026-11-19): /api/v1/admin/tests/:id/marking — distribution to
   * authorised coaches (tests.distribute: even, manual, reassign; progress per coach; only after the latest applicable
   * deadline incl. extensions, G5), review (tests.review: approve and lock, return with a comment, independent second
   * marking, unlock with a reason; status history, mark-change log), choosing the first / second / adjusted mark
   * (tests.adjustMarks: the subject's Head Coach only, G4); /api/v1/marking (tests.mark: Coaches — BLIND marking of the
   * submissions assigned to them: queue, pages under neutral names, marking guide, drafts, submit for approval).
   */
  testMarking: 'always',
  /**
   * Test Management, Phase 4 (WS3; owner-approved plan 2026-11-19): /api/v1/admin/tests/:id/results: preview and
   * publish the approved results (tests.publishResults; blocked while any is unapproved), the Administrators' override
   * with a mandatory reason (tests.overridePublication), publications and withdrawals (G6: an unlock withdraws a published
   * result), results with identity, the report and CSV exports (tests.viewResults), internal rankings overall / by division
   * / by school (tests.viewRankings); /admin/test-reports, /admin/test-dashboard; /me/test-results (tests.viewOwnResults),
   * /teacher/test-results (tests.viewSchoolResults), /me/test-dashboard, /teacher/test-dashboard, /marking/dashboard.
   */
  testResults: 'always',
  /** As teacherAccounts, for the HEAD_COACH role (HEAD_COACHES_ENABLED; users.manageHeadCoaches). */
  headCoachAccounts: 'HEAD_COACH',
} as const satisfies Record<string, 'always' | AppRole>;

export type Feature = keyof typeof FEATURES;

export interface Capabilities {
  /** Version of this structure (see the rules above). */
  schemaVersion: number;
  /**
   * Every role a stored user account may hold (the database Role enum) — NOT the roles that can
   * currently be registered or assigned (see teacherAccounts / headCoachAccounts).
   */
  roles: AppRole[];
  /** The features available right now, sorted. A feature not listed is not available. */
  features: Feature[];
}

/** The OpenAPI description of the GET /api/v1 200 response (the docs show it with the recorded schema). */
export const API_INFO_RESPONSE_DESCRIPTION = [
  'API information. `name` ("ROF LMS API"), `version`, `docs` and `health` are the original fields, unchanged.',
  '`capabilities` is absent on the legacy backend. When present: `schemaVersion` (integer; this contract is 1 —',
  'treat any other value as an unknown backend); `roles` (every role a stored user account may hold, not the',
  'roles that can currently be assigned); `features` (sorted names of backend-wide functionality available now —',
  'never the caller\'s permissions; ignore names you do not know). Never cached (Cache-Control: no-store).',
  'Detection contract (LEGACY / NEW / UNKNOWN) and the meaning of every feature: docs/INTEGRATION.md,',
  'section "Backend capabilities (GET /api/v1)".',
].join(' ');

/** The capabilities of the running backend under `config`. */
export function capabilitiesOf(config: { get(key: string): unknown }): Capabilities {
  const features = (Object.keys(FEATURES) as Feature[])
    .filter((f) => {
      const gate: 'always' | AppRole = FEATURES[f];
      return gate === 'always' || roleFlagOn(gate, config);
    })
    .sort();
  return { schemaVersion: CAPABILITIES_SCHEMA_VERSION, roles: [...APP_ROLES], features };
}
