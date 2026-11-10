/**
 * The approved individual-override list (plan §6.3, approved 2026-11-09).
 * Lives in code and changes only by reviewed PR.
 *
 *   TEACHER                       GRANT assignments.prepare (only inside an active
 *                                 TeacherAssignment for that course × division);
 *                                 GRANT students.viewProfile, students.viewProgress,
 *                                 submissions.submitOnBehalf (P1-11, school scope:
 *                                 only with an active school assignment; also
 *                                 manageable by Administrators — TEACHER_DELEGATIONS);
 *                                 DENY any default permission
 *   STUDENT, MENTOR, HEAD_COACH   DENY any default permission
 *   ADMIN                         DENY any default permission
 *   SUPER_ADMIN                   nothing
 *
 * Never grantable to anyone, even if this list were edited: NEVER_GRANTABLE
 * (reviews.grade, results.*, submissions.distribute, users.manageAdmins,
 * permissions.*, settings.manageSystem).
 */
import { NEVER_GRANTABLE, ROLE_GRANTS, grantsForRole, type AppRole, type Permission, type ScopeKind } from './permissions.js';

export type OverrideEffectValue = 'GRANT' | 'DENY';

export const GRANTABLE: Readonly<Partial<Record<AppRole, readonly Permission[]>>> = {
  TEACHER: ['assignments.prepare', 'students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf'],
};

/**
 * Teacher delegations (P1-11): the GRANTs an Administrator may also give or revoke
 * (users.manageTeachers), besides the Super Admin. School scope — the teacher's
 * active school assignments, checked by the service on every request.
 */
export const TEACHER_DELEGATIONS: readonly Permission[] = ['students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf'];

/** The scope a GRANT override applies at: school for teacher delegations, course × division otherwise. */
export function grantScopeOf(permission: string): ScopeKind {
  return (TEACHER_DELEGATIONS as readonly string[]).includes(permission) ? 'school' : 'courseDivision';
}
export const DENIABLE_ROLES: readonly AppRole[] = ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN'];

/** Why this override is not allowed for a role, or null when the policy allows it (scope is checked separately). */
export function overrideRefusal(role: string, permission: string, effect: OverrideEffectValue): string | null {
  if (grantsForRole(role) === undefined) return 'unknown role';
  if (role === 'SUPER_ADMIN') return 'no override applies to a Super Administrator';
  if (effect === 'GRANT') {
    if ((NEVER_GRANTABLE as readonly string[]).includes(permission)) return 'never grantable';
    const allowed = GRANTABLE[role as AppRole] ?? [];
    return (allowed as readonly string[]).includes(permission) ? null : 'not on the approved GRANT list for this role';
  }
  if (effect === 'DENY') {
    if (!DENIABLE_ROLES.includes(role as AppRole)) return 'DENY not allowed for this role';
    return permission in ROLE_GRANTS[role as AppRole] ? null : 'not a default permission of this role';
  }
  return 'unknown effect';
}
