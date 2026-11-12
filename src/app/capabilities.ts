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
 * Changing the shape: adding a feature is additive; renaming or removing one, or changing
 * `roles` / `features` semantics, needs a new `schemaVersion`.
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
  /** /api/v1/admin/school-sync: official-directory dry run, review, approval and apply. */
  schoolDirectorySync: 'always',
  /** TEACHER accounts can be created and assigned (the Teacher role is enabled). */
  teacherAccounts: 'TEACHER',
  /** HEAD_COACH accounts can be created and assigned (the Head Coach role is enabled). */
  headCoachAccounts: 'HEAD_COACH',
} as const satisfies Record<string, 'always' | AppRole>;

export type Feature = keyof typeof FEATURES;

export interface Capabilities {
  /** Version of this structure (see the rules above). */
  schemaVersion: number;
  /** Every value the `role` field of a user may hold in this API's responses. */
  roles: AppRole[];
  /** The features available right now, sorted. A feature not listed is not available. */
  features: Feature[];
}

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
