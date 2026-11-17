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
   * `homeLocation` is optional). All optional at the API for older clients; the profile (GET /api/v1/me, admin user
   * detail) returns them. Without this feature the fields are refused (400): the sign-up form must not send them.
   */
  studentRegistrationDetails: 'always',
  /**
   * Coach application details: POST /api/v1/mentor-requests accepts `country`, `occupation`, `educationLevel`
   * (SECONDARY | DIPLOMA | BACHELOR | MASTER | DOCTORATE | OTHER) and `olympiadInterests`; the admin list returns them
   * and approval copies country and interests to the Coach account. Optional at the API for older clients. Without
   * this feature the fields are refused (400).
   */
  coachApplicationDetails: 'always',
  /**
   * Application details and "request more information" (2026-11-17; ADR-009): POST /auth/register/teacher accepts
   * `position` and `yearsOfExperience`; POST /mentor-requests accepts `phone`, `affiliation`, `expertise`,
   * `relevantExperience` and `yearsOfExperience`; PATCH /mentor-requests/:id/reject takes an optional `reason`
   * (e-mailed, like a Teacher rejection's); Administrators ask a question with POST
   * /admin/teacher-applications/:id/request-info or POST /mentor-requests/:id/request-info (the application stays
   * PENDING; `infoRequests` on the application lists the questions and answers); the applicant answers through
   * GET / POST /applications/info-requests/:token (410 INFO_REQUEST_LINK_INVALID once used, expired or decided).
   * Without this feature the new fields are refused (400) and the routes do not exist (404).
   */
  applicationDetails: 'always',
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
   * changeClassification (a student's grade, and so division), message.
   */
  bulkUserOperations: 'always',
  /**
   * Form availability: GET /api/v1/forms and /forms/:key (public: open, state OPEN | CLOSED | NOT_YET_OPEN | ENDED,
   * schedule, closed message, instructions, contact e-mail, support link, timezone Africa/Kigali, server time) and
   * /api/v1/admin/forms (forms.view; PATCH :key/availability with forms.manageAvailability, PATCH :key/messages with
   * forms.editMessages; GET :key/history). Submissions to a closed form are refused with 403: REGISTRATION_CLOSED
   * (student and teacher registration) or FORM_CLOSED (coach applications, contact form), with the form details.
   */
  formAvailability: 'always',
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
