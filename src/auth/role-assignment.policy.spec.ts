import { AppError } from '../common/errors/app-error.js';
import { PermissionService } from './permission.service.js';
import { APP_ROLES } from './permissions.js';
import { MANAGE_PERMISSION, RoleAssignmentPolicy } from './role-assignment.policy.js';

function policy(env: Record<string, string | undefined> = {}) {
  const config = { get: (k: string) => env[k] };
  return new RoleAssignmentPolicy(new PermissionService({ mentorScopes: async () => [] } as never), config as never);
}
const actor = (role: string) => ({ id: 'actor', role });

function code(fn: () => void): string | null {
  try { fn(); return null; } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).getStatus()).toBe(403);
    return (e as AppError).code;
  }
}

describe('RoleAssignmentPolicy (role allow-list, P1-05)', () => {
  it('maps every one of the six roles; SUPER_ADMIN is never manageable through the user API', () => {
    expect(Object.keys(MANAGE_PERMISSION).sort()).toEqual([...APP_ROLES].sort());
    expect(MANAGE_PERMISSION.SUPER_ADMIN).toBeNull();
  });

  describe('ADMIN, flags off (the default)', () => {
    const p = policy();
    it.each(['STUDENT', 'MENTOR', 'ADMIN'])('may assign %s', (role) => {
      expect(code(() => p.assertCanAssign(actor('ADMIN'), role))).toBeNull();
    });
    it('TEACHER → TEACHERS_DISABLED; HEAD_COACH → HEAD_COACHES_DISABLED', () => {
      expect(code(() => p.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBe('TEACHERS_DISABLED');
      expect(code(() => p.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBe('HEAD_COACHES_DISABLED');
    });
    it('SUPER_ADMIN is never assignable', () => {
      expect(code(() => p.assertCanAssign(actor('ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
    });
    it.each(['', 'admin', 'Mentor', 'COACH', 'UNKNOWN_ROLE', '__proto__', 'constructor', 'toString'])(
      'an unknown value (%j) is never assignable', (role) => {
        expect(code(() => p.assertCanAssign(actor('ADMIN'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      },
    );
    it.each(['STUDENT', 'MENTOR', 'ADMIN', 'TEACHER', 'HEAD_COACH'])(
      'may manage an existing %s account (flags do not block managing or demoting existing accounts)', (role) => {
        expect(code(() => p.assertCanManage(actor('ADMIN'), role))).toBeNull();
      },
    );
    it('may not manage a SUPER_ADMIN account or an unknown current role', () => {
      for (const role of ['SUPER_ADMIN', 'UNKNOWN_ROLE', '__proto__']) {
        expect(code(() => p.assertCanManage(actor('ADMIN'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
  });

  describe('flags', () => {
    it('TEACHERS_ENABLED=true / HEAD_COACHES_ENABLED=true allow ADMIN to assign those roles, independently', () => {
      const t = policy({ TEACHERS_ENABLED: 'true' });
      expect(code(() => t.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBeNull();
      expect(code(() => t.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBe('HEAD_COACHES_DISABLED');
      const h = policy({ HEAD_COACHES_ENABLED: 'true' });
      expect(code(() => h.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBeNull();
      expect(code(() => h.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBe('TEACHERS_DISABLED');
    });
    it.each(['false', 'TRUE', '1', 'yes', '', undefined])('any value other than "true" (%j) keeps the role off', (value) => {
      const p = policy({ TEACHERS_ENABLED: value, HEAD_COACHES_ENABLED: value });
      expect(code(() => p.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBe('TEACHERS_DISABLED');
      expect(code(() => p.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBe('HEAD_COACHES_DISABLED');
    });
    it('flags never make SUPER_ADMIN assignable', () => {
      const p = policy({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' });
      expect(code(() => p.assertCanAssign(actor('ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
    });
    it('flags do not let a non-administrator assign anything', () => {
      const p = policy({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' });
      for (const role of APP_ROLES) {
        expect(code(() => p.assertCanAssign(actor('MENTOR'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
  });

  describe('other actors', () => {
    const p = policy({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' });
    it.each(['STUDENT', 'MENTOR', 'TEACHER', 'UNKNOWN_ROLE', ''])('%s may neither assign nor manage any role', (who) => {
      for (const role of APP_ROLES) {
        expect(code(() => p.assertCanAssign(actor(who), role))).toBe('ROLE_NOT_ASSIGNABLE');
        expect(code(() => p.assertCanManage(actor(who), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
    it('HEAD_COACH (programme-scoped grants only) may not assign or manage through the user API yet (P1-10)', () => {
      for (const role of APP_ROLES) {
        expect(code(() => p.assertCanAssign(actor('HEAD_COACH'), role))).toBe('ROLE_NOT_ASSIGNABLE');
        expect(code(() => p.assertCanManage(actor('HEAD_COACH'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
    it('SUPER_ADMIN may assign every role except SUPER_ADMIN through the user API', () => {
      for (const role of ['STUDENT', 'MENTOR', 'ADMIN', 'TEACHER', 'HEAD_COACH']) {
        expect(code(() => p.assertCanAssign(actor('SUPER_ADMIN'), role))).toBeNull();
      }
      expect(code(() => p.assertCanAssign(actor('SUPER_ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
      expect(code(() => p.assertCanManage(actor('SUPER_ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
    });
  });
});
