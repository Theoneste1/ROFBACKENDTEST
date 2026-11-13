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
  // The official-directory sync (/api/v1/admin/school-sync) is deliberately NOT advertised in V1
  // (owner decision 2026-11-12): its production use is not yet approved.
  /**
   * The TEACHER role can currently be given to an account (TEACHERS_ENABLED). The caller still
   * needs users.manageTeachers (/me/permissions). Absent: no NEW Teacher role assignments — existing
   * TEACHER accounts may still exist and use their portal.
   */
  teacherAccounts: 'TEACHER',
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
