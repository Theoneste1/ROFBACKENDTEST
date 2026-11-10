import type { ActiveOverride, AuthUser } from '../common/auth-user.js';
import { DENIABLE_ROLES, GRANTABLE, overrideRefusal } from './override-policy.js';
import { PermissionService } from './permission.service.js';
import { APP_ROLES, NEVER_GRANTABLE, PERMISSIONS, ROLE_GRANTS } from './permissions.js';

describe('approved override list (plan §6.3)', () => {
  it('GRANT: only for TEACHER — assignments.prepare and the three P1-11 teacher delegations', () => {
    const TEACHER_GRANTS = ['assignments.prepare', 'students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf'];
    expect(GRANTABLE).toEqual({ TEACHER: TEACHER_GRANTS });
    for (const role of APP_ROLES) {
      for (const p of PERMISSIONS) {
        const ok = role === 'TEACHER' && TEACHER_GRANTS.includes(p);
        expect([role, p, overrideRefusal(role, p, 'GRANT') === null]).toEqual([role, p, ok]);
      }
    }
  });

  it('never-grantable permissions are refused for every role', () => {
    for (const role of APP_ROLES) for (const p of NEVER_GRANTABLE) expect(overrideRefusal(role, p, 'GRANT')).not.toBeNull();
  });

  it('DENY: any default permission of TEACHER, STUDENT, COACH, HEAD_COACH, ADMIN — nothing for SUPER_ADMIN', () => {
    expect([...DENIABLE_ROLES].sort()).toEqual(['ADMIN', 'HEAD_COACH', 'MENTOR', 'STUDENT', 'TEACHER']);
    for (const role of APP_ROLES) {
      for (const p of PERMISSIONS) {
        const ok = role !== 'SUPER_ADMIN' && p in ROLE_GRANTS[role];
        expect([role, p, overrideRefusal(role, p, 'DENY') === null]).toEqual([role, p, ok]);
      }
    }
  });

  it.each(['UNKNOWN_ROLE', '', '__proto__'])('an unknown role (%j) gets nothing', (role) => {
    expect(overrideRefusal(role, 'courses.view', 'DENY')).not.toBeNull();
    expect(overrideRefusal(role, 'assignments.prepare', 'GRANT')).not.toBeNull();
  });
});

describe('override evaluation in PermissionService.effective (plan §6.4)', () => {
  const service = new PermissionService({ mentorScopes: async () => [], headedProgrammes: async () => [] } as never);
  const NOW = new Date('2026-11-10T12:00:00Z');
  const o = (permission: string, effect: 'GRANT' | 'DENY', expiresAt: Date | null = null, extra: Partial<ActiveOverride> = {}): ActiveOverride =>
    ({ id: 'o', permission, effect, courseId: null, divisionId: null, expiresAt, ...extra });
  const user = (role: string, overrides: ActiveOverride[]) => ({ id: 'u', username: 'u', role, divisionId: null, gradeLevel: null, overrides }) as AuthUser;

  it('DENY removes a role default; without overrides nothing changes', () => {
    expect(service.has(user('STUDENT', []), 'submissions.submit')).toBe(true);
    expect(service.has(user('STUDENT', [o('submissions.submit', 'DENY')]), 'submissions.submit')).toBe(false);
    expect(service.has(user('STUDENT', [o('submissions.submit', 'DENY')]), 'courses.view')).toBe(true);
  });

  it('expiry is evaluated at the moment of the decision (an expired entry never applies, whatever was loaded)', () => {
    const deny = [o('submissions.submit', 'DENY', new Date(NOW.getTime() + 1000))];
    expect(service.effective(user('STUDENT', deny), NOW).has('submissions.submit')).toBe(false);
    expect(service.effective(user('STUDENT', deny), new Date(NOW.getTime() + 1000)).has('submissions.submit')).toBe(true);   // at expiresAt
    expect(service.effective(user('STUDENT', deny), new Date(NOW.getTime() + 5000)).has('submissions.submit')).toBe(true);
  });

  it('GRANT applies only where the approved list allows it, scoped to course × division', () => {
    expect(service.scopeOf(user('TEACHER', [o('assignments.prepare', 'GRANT', null, { courseId: 'c', divisionId: 'd' })]), 'assignments.prepare')).toBe('courseDivision');
    // not listed / never grantable / wrong role → ignored even if such a row existed
    expect(service.has(user('MENTOR', [o('users.manage', 'GRANT')]), 'users.manage')).toBe(false);
    expect(service.has(user('TEACHER', [o('reviews.grade', 'GRANT')]), 'reviews.grade')).toBe(false);
    expect(service.has(user('STUDENT', [o('assignments.prepare', 'GRANT')]), 'assignments.prepare')).toBe(false);
  });

  it('no override ever applies to a SUPER_ADMIN or an unknown role; RS1 still holds for administrators', () => {
    const sa = user('SUPER_ADMIN', [o('users.manage', 'DENY'), o('reviews.grade', 'GRANT')]);
    expect(service.has(sa, 'users.manage')).toBe(true);
    expect(service.has(sa, 'reviews.grade')).toBe(false);
    expect(service.effective(user('UNKNOWN_ROLE', [o('courses.view', 'GRANT')])).size).toBe(0);
    expect(service.has(user('ADMIN', [o('assignments.prepare', 'GRANT')]), 'assignments.prepare')).toBe(false);
    // ADMIN may be DENIED a default.
    expect(service.has(user('ADMIN', [o('users.manage', 'DENY')]), 'users.manage')).toBe(false);
  });

  it('GET /me/permissions: a DENY removes the permission from the list and the override is shown', async () => {
    const r = await service.describe(user('STUDENT', [o('submissions.submit', 'DENY')]));
    expect(r.permissions).not.toContain('submissions.submit');
    expect(r.permissions).toContain('courses.view');
    expect(r.overrides).toEqual([{ permission: 'submissions.submit', effect: 'DENY', courseId: null, divisionId: null, expiresAt: null }]);
  });
});
