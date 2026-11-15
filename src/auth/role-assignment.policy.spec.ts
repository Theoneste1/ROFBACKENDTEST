import { AppError } from '../common/errors/app-error.js';
import { PermissionService } from './permission.service.js';
import { APP_ROLES } from './permissions.js';
import { MANAGE_PERMISSION, RoleAssignmentPolicy } from './role-assignment.policy.js';

function policy(env: Record<string, string | undefined> = {}, activeSuperAdmins = 0) {
  const config = { get: (k: string) => env[k] };
  const prisma = { user: { count: vi.fn().mockResolvedValue(activeSuperAdmins) } };
  return new RoleAssignmentPolicy(new PermissionService({ mentorScopes: async () => [] } as never), config as never, prisma as never);
}
const actor = (role: string) => ({ id: 'actor', role });

async function code(fn: () => Promise<void>): Promise<string | null> {
  try { await fn(); return null; } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).getStatus()).toBe(403);
    return (e as AppError).code;
  }
}

describe('RoleAssignmentPolicy (role allow-list, P1-05 / P1-08)', () => {
  it('maps every one of the six roles; SUPER_ADMIN has no permission entry (Super Admin actors only)', () => {
    expect(Object.keys(MANAGE_PERMISSION).sort()).toEqual([...APP_ROLES].sort());
    expect(MANAGE_PERMISSION.SUPER_ADMIN).toBeNull();
  });

  describe('ADMIN, flags off (the default)', () => {
    const p = policy();
    it.each(['STUDENT', 'MENTOR', 'ADMIN'])('may assign %s', async (role) => {
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), role))).toBeNull();
    });
    it('TEACHER → TEACHERS_DISABLED; HEAD_COACH → HEAD_COACHES_DISABLED', async () => {
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBe('TEACHERS_DISABLED');
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBe('HEAD_COACHES_DISABLED');
    });
    it('SUPER_ADMIN is never assignable by an ADMIN, on creation or by role change', async () => {
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'SUPER_ADMIN', 'roleChange'))).toBe('ROLE_NOT_ASSIGNABLE');
    });
    it.each(['', 'admin', 'Mentor', 'COACH', 'UNKNOWN_ROLE', '__proto__', 'constructor', 'toString'])(
      'an unknown value (%j) is never assignable', async (role) => {
        expect(await code(() => p.assertCanAssign(actor('ADMIN'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      },
    );
    it.each(['STUDENT', 'MENTOR', 'ADMIN', 'TEACHER', 'HEAD_COACH'])(
      'may manage an existing %s account (flags do not block managing or demoting existing accounts)', async (role) => {
        expect(await code(() => p.assertCanManage(actor('ADMIN'), role))).toBeNull();
      },
    );
    it('may not manage a SUPER_ADMIN account or an unknown current role', async () => {
      for (const role of ['SUPER_ADMIN', 'UNKNOWN_ROLE', '__proto__']) {
        expect(await code(() => p.assertCanManage(actor('ADMIN'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
  });

  describe('flags', () => {
    it('TEACHERS_ENABLED=true / HEAD_COACHES_ENABLED=true allow ADMIN to assign those roles, independently', async () => {
      const t = policy({ TEACHERS_ENABLED: 'true' });
      expect(await code(() => t.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBeNull();
      expect(await code(() => t.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBe('HEAD_COACHES_DISABLED');
      const h = policy({ HEAD_COACHES_ENABLED: 'true' });
      expect(await code(() => h.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBeNull();
      expect(await code(() => h.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBe('TEACHERS_DISABLED');
    });
    it.each(['false', 'TRUE', '1', 'yes', '', undefined])('any value other than "true" (%j) keeps the role off', async (value) => {
      const p = policy({ TEACHERS_ENABLED: value, HEAD_COACHES_ENABLED: value });
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'TEACHER'))).toBe('TEACHERS_DISABLED');
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'HEAD_COACH'))).toBe('HEAD_COACHES_DISABLED');
    });
    it('flags never make SUPER_ADMIN assignable', async () => {
      const p = policy({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' });
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
    });
  });

  describe('other actors', () => {
    const p = policy({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' });
    it.each(['STUDENT', 'MENTOR', 'TEACHER', 'UNKNOWN_ROLE', ''])('%s may neither assign nor manage any role', async (who) => {
      for (const role of APP_ROLES) {
        expect(await code(() => p.assertCanAssign(actor(who), role, 'roleChange'))).toBe('ROLE_NOT_ASSIGNABLE');
        expect(await code(() => p.assertCanManage(actor(who), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
    it('HEAD_COACH (programme-scoped grants only) may not assign or manage through the user API yet (P1-10)', async () => {
      for (const role of APP_ROLES) {
        expect(await code(() => p.assertCanAssign(actor('HEAD_COACH'), role, 'roleChange'))).toBe('ROLE_NOT_ASSIGNABLE');
        expect(await code(() => p.assertCanManage(actor('HEAD_COACH'), role))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
  });

  describe('SUPER_ADMIN (P1-08)', () => {
    const p = policy({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' });
    it('may assign every other role, and manage every role including SUPER_ADMIN accounts', async () => {
      for (const role of ['STUDENT', 'MENTOR', 'ADMIN', 'TEACHER', 'HEAD_COACH']) {
        expect(await code(() => p.assertCanAssign(actor('SUPER_ADMIN'), role))).toBeNull();
      }
      for (const role of APP_ROLES) expect(await code(() => p.assertCanManage(actor('SUPER_ADMIN'), role))).toBeNull();
    });
    it('gives SUPER_ADMIN only by role change (promotion), never on account creation', async () => {
      expect(await code(() => p.assertCanAssign(actor('SUPER_ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
      expect(await code(() => p.assertCanAssign(actor('SUPER_ADMIN'), 'SUPER_ADMIN', 'roleChange'))).toBeNull();
    });
  });

  describe('SUPER_ADMIN_BOUNDARY_ENABLED (plan §8.3)', () => {
    it('off (default): ADMIN manages ADMIN accounts as before', async () => {
      const p = policy({}, 1);
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'ADMIN'))).toBeNull();
      expect(await code(() => p.assertCanManage(actor('ADMIN'), 'ADMIN'))).toBeNull();
    });
    it('on, with an active Super Admin: ADMIN may no longer create, promote to or manage ADMIN; everything else unchanged', async () => {
      const p = policy({ SUPER_ADMIN_BOUNDARY_ENABLED: 'true' }, 1);
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'ADMIN', 'roleChange'))).toBe('ROLE_NOT_ASSIGNABLE');
      expect(await code(() => p.assertCanManage(actor('ADMIN'), 'ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
      for (const role of ['STUDENT', 'MENTOR']) {
        expect(await code(() => p.assertCanAssign(actor('ADMIN'), role))).toBeNull();
        expect(await code(() => p.assertCanManage(actor('ADMIN'), role))).toBeNull();
      }
      // A Super Admin is unaffected.
      expect(await code(() => p.assertCanAssign(actor('SUPER_ADMIN'), 'ADMIN'))).toBeNull();
      expect(await code(() => p.assertCanManage(actor('SUPER_ADMIN'), 'ADMIN'))).toBeNull();
    });
    it('on, with NO active Super Admin: not enforced (fail-safe — ADMIN keeps today\'s behaviour)', async () => {
      const p = policy({ SUPER_ADMIN_BOUNDARY_ENABLED: 'true' }, 0);
      expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'ADMIN'))).toBeNull();
      expect(await code(() => p.assertCanManage(actor('ADMIN'), 'ADMIN'))).toBeNull();
    });
    it.each(['false', 'TRUE', '1', undefined])('any value other than "true" (%j) leaves it off', async (value) => {
      const p = policy({ SUPER_ADMIN_BOUNDARY_ENABLED: value }, 1);
      expect(await code(() => p.assertCanManage(actor('ADMIN'), 'ADMIN'))).toBeNull();
    });
    it('in no state can an ADMIN assign or manage SUPER_ADMIN', async () => {
      for (const [env, n] of [[{}, 0], [{ SUPER_ADMIN_BOUNDARY_ENABLED: 'true' }, 0], [{ SUPER_ADMIN_BOUNDARY_ENABLED: 'true' }, 1]] as const) {
        const p = policy(env, n);
        expect(await code(() => p.assertCanAssign(actor('ADMIN'), 'SUPER_ADMIN', 'roleChange'))).toBe('ROLE_NOT_ASSIGNABLE');
        expect(await code(() => p.assertCanManage(actor('ADMIN'), 'SUPER_ADMIN'))).toBe('ROLE_NOT_ASSIGNABLE');
      }
    });
  });
});
