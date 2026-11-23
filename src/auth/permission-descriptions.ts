/**
 * Plain-language names for the permissions an Administrator or Super Admin can GRANT to an individual
 * (override-policy.ts GRANTABLE), used in the "new permissions" notification (decision notifications,
 * owner-approved). Every grantable permission must have an entry (checked by the unit test), so a
 * permission added to the GRANT list cannot be announced with its technical name.
 *
 *   label        — short name, as a person would say it;
 *   description  — ONE sentence: what the person can now do (and its limits).
 */
import { GRANTABLE } from './override-policy.js';
import type { Permission } from './permissions.js';

export interface PermissionDescription {
  label:       string;
  description: string;
}

export const GRANTED_PERMISSION_DESCRIPTIONS: Readonly<Partial<Record<Permission, PermissionDescription>>> = {
  // 'assignments.prepare' is no longer grantable (release permissions: Teacher course grants removed).
  'students.viewProfile': {
    label:       'View student profiles',
    description: 'You can open the profile of a student of your assigned schools (name, school, grade and account status, without contact details).',
  },
  'students.viewProgress': {
    label:       'View student progress',
    description: 'You can see which assignments a student of your assigned schools can do and what they have submitted (no grades or feedback).',
  },
  'submissions.submitOnBehalf': {
    label:       'Submit work for students',
    description: 'You can upload a submission on behalf of a student of your assigned schools; the work stays the student’s own.',
  },
  'users.impersonate': {
    label:       'View the platform as another user',
    description: 'You can open a read-only view of the platform exactly as a student, teacher or coach sees it, where nothing can be changed.',
  },
};

/** Every permission that can be granted to someone (any role on the GRANT list). */
export function grantablePermissions(): Permission[] {
  return [...new Set(Object.values(GRANTABLE).flatMap((list) => [...(list ?? [])]))].sort();
}

/** The plain-language entry for a granted permission (never the technical name). */
export function describeGrantedPermission(permission: string): PermissionDescription {
  const entry = GRANTED_PERMISSION_DESCRIPTIONS[permission as Permission];
  if (!entry) throw new Error(`No plain-language description for the grantable permission "${permission}".`);
  return entry;
}
