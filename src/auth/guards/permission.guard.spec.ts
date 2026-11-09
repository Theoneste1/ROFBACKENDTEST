import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Public } from '../../common/decorators/public.decorator.js';
import { AppError } from '../../common/errors/app-error.js';
import { REQUIRED_PERMISSION_KEY, RequirePermission } from '../decorators/require-permission.decorator.js';
import { PermissionService } from '../permission.service.js';
import { APP_ROLES, ROLE_GRANTS, type Permission } from '../permissions.js';
import { PermissionGuard } from './permission.guard.js';

class Routes {
  open() {}

  @RequirePermission('users.manage')
  manageUsers() {}

  @RequirePermission('reviews.grade')
  grade() {}

  @RequirePermission('assignments.prepare')
  prepare() {}

  @RequirePermission('permissions.manageOverrides')
  overrides() {}

  // Contradictory (rejected by route-declarations.spec.ts); used to prove the guard fails closed.
  @Public()
  @RequirePermission('users.manage')
  publicAndPermission() {}
}

@Public()
class PublicClass {
  @RequirePermission('users.manage')
  permissionUnderPublicClass() {}
}

@RequirePermission('audit.view')
class ClassLevel {
  inherited() {}

  @RequirePermission('leaderboard.view')
  overridden() {}
}

function context(cls: Function, method: string, user?: { id?: string; role: string }): ExecutionContext {
  return {
    getHandler:   () => (cls.prototype as Record<string, Function>)[method],
    getClass:     () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: user && { id: 'u1', ...user } }) }),
  } as unknown as ExecutionContext;
}

const service = new PermissionService({ mentorScopes: async () => [] } as any);
const guard = new PermissionGuard(new Reflector(), service);

function refusal(fn: () => unknown): AppError {
  try { fn(); } catch (e) { return e as AppError; }
  throw new Error('expected a refusal');
}

describe('PermissionGuard', () => {
  it('does nothing on a route without @RequirePermission — for any caller, even none', () => {
    for (const role of [...APP_ROLES, 'UNKNOWN_ROLE']) {
      expect(guard.canActivate(context(Routes, 'open', { role }))).toBe(true);
    }
    expect(guard.canActivate(context(Routes, 'open'))).toBe(true);
  });

  it('allows a caller holding the permission', () => {
    expect(guard.canActivate(context(Routes, 'manageUsers', { role: 'ADMIN' }))).toBe(true);
    expect(guard.canActivate(context(Routes, 'grade', { role: 'MENTOR' }))).toBe(true);
    expect(guard.canActivate(context(Routes, 'overrides', { role: 'SUPER_ADMIN' }))).toBe(true);
  });

  it('fails closed: 403 PERMISSION_REQUIRED when the caller lacks the permission', () => {
    const e = refusal(() => guard.canActivate(context(Routes, 'manageUsers', { role: 'STUDENT' })));
    expect(e).toBeInstanceOf(AppError);
    expect(e.getStatus()).toBe(403);
    expect(e.code).toBe('PERMISSION_REQUIRED');
    expect(e.details).toEqual({ permission: 'users.manage' });
  });

  it('fails closed without a user', () => {
    expect(refusal(() => guard.canActivate(context(Routes, 'manageUsers'))).code).toBe('PERMISSION_REQUIRED');
  });

  it('fails closed for an unsupported role', () => {
    for (const m of ['manageUsers', 'grade', 'prepare', 'overrides']) {
      expect(refusal(() => guard.canActivate(context(Routes, m, { role: 'UNKNOWN_ROLE' }))).code)
        .toBe('PERMISSION_REQUIRED');
    }
  });

  it('applies class-level metadata, and a method-level declaration overrides it', () => {
    expect(guard.canActivate(context(ClassLevel, 'inherited', { role: 'ADMIN' }))).toBe(true);
    expect(refusal(() => guard.canActivate(context(ClassLevel, 'inherited', { role: 'MENTOR' }))).code)
      .toBe('PERMISSION_REQUIRED');
    expect(guard.canActivate(context(ClassLevel, 'overridden', { role: 'STUDENT' }))).toBe(true);
  });

  it('decides exactly as the catalogue says, for every role and every declared permission', () => {
    for (const role of APP_ROLES) {
      for (const [method, permission] of [
        ['manageUsers', 'users.manage'], ['grade', 'reviews.grade'],
        ['prepare', 'assignments.prepare'], ['overrides', 'permissions.manageOverrides'],
      ] as Array<[string, Permission]>) {
        const holds = permission in ROLE_GRANTS[role];
        const run = () => guard.canActivate(context(Routes, method, { role }));
        if (holds) expect(run()).toBe(true);
        else expect(refusal(run).code).toBe('PERMISSION_REQUIRED');
      }
    }
  });

  describe('present but invalid metadata fails closed (only undefined is a no-op)', () => {
    const INVALID: Array<[string, unknown]> = [
      ['empty string', ''], ['null', null], ['false', false], ['zero', 0],
      ['unknown name', 'no.such'], ['prototype key', 'constructor'], ['__proto__', '__proto__'],
      ['wrong case', 'Users.Manage'], ['array', ['users.manage']], ['object', { permission: 'users.manage' }],
    ];

    function withMetadata(value: unknown, level: 'method' | 'class') {
      class Target { route() {} }
      const target = level === 'method' ? Target.prototype.route : Target;
      SetMetadata(REQUIRED_PERMISSION_KEY, value)(target as never, undefined as never, undefined as never);
      return Target;
    }

    it.each(INVALID)('%s on the method → 403 for every caller, including SUPER_ADMIN, and without a user', (_, value) => {
      const cls = withMetadata(value, 'method');
      for (const role of [...APP_ROLES, 'UNKNOWN_ROLE']) {
        const e = refusal(() => guard.canActivate(context(cls, 'route', { role })));
        expect([role, e.getStatus(), e.code]).toEqual([role, 403, 'PERMISSION_REQUIRED']);
      }
      expect(refusal(() => guard.canActivate(context(cls, 'route'))).code).toBe('PERMISSION_REQUIRED');
    });

    it.each(INVALID)('%s on the class → 403 for every caller', (_, value) => {
      const cls = withMetadata(value, 'class');
      for (const role of APP_ROLES) {
        expect(refusal(() => guard.canActivate(context(cls, 'route', { role }))).code).toBe('PERMISSION_REQUIRED');
      }
    });

    it('an empty method-level value does not fall back to a valid class-level one', () => {
      @RequirePermission('leaderboard.view')
      class Mixed { route() {} }
      SetMetadata(REQUIRED_PERMISSION_KEY, '')(Mixed.prototype.route as never, undefined as never, undefined as never);
      expect(refusal(() => guard.canActivate(context(Mixed, 'route', { role: 'STUDENT' }))).code).toBe('PERMISSION_REQUIRED');
    });

    it('even a service that reports every permission as held cannot open an invalid requirement', () => {
      const leaky = new PermissionService({ mentorScopes: async () => [] } as any);
      leaky.has = () => true;
      const g = new PermissionGuard(new Reflector(), leaky);
      for (const [, value] of INVALID) {
        const cls = withMetadata(value, 'method');
        expect(refusal(() => g.canActivate(context(cls, 'route', { role: 'ADMIN' }))).code).toBe('PERMISSION_REQUIRED');
      }
    });

    it('absent metadata (undefined) stays a no-op', () => {
      class Bare { route() {} }
      expect(guard.canActivate(context(Bare, 'route', { role: 'STUDENT' }))).toBe(true);
      expect(guard.canActivate(context(Bare, 'route'))).toBe(true);
    });
  });

  describe('@Public is not a bypass (fails closed on a contradictory declaration)', () => {
    it('refuses an anonymous caller (JwtAuthGuard leaves no user on a @Public route)', () => {
      for (const [cls, m] of [[Routes, 'publicAndPermission'], [PublicClass, 'permissionUnderPublicClass']] as const) {
        const e = refusal(() => guard.canActivate(context(cls, m)));
        expect([m, e.getStatus(), e.code]).toEqual([m, 403, 'PERMISSION_REQUIRED']);
      }
    });

    // In the running app a @Public route is never authenticated, so the case above is
    // what every caller gets. If a user were attached anyway, the permission still decides.
    it('still requires the permission if a user is attached', () => {
      expect(refusal(() => guard.canActivate(context(Routes, 'publicAndPermission', { role: 'STUDENT' }))).code)
        .toBe('PERMISSION_REQUIRED');
      expect(guard.canActivate(context(Routes, 'publicAndPermission', { role: 'ADMIN' }))).toBe(true);
    });
  });

  describe('RS1: grading and assignment authoring are refused to ADMIN and SUPER_ADMIN', () => {
    it('with the real catalogue', () => {
      for (const role of ['ADMIN', 'SUPER_ADMIN']) {
        for (const m of ['grade', 'prepare']) {
          expect(refusal(() => guard.canActivate(context(Routes, m, { role }))).code).toBe('PERMISSION_REQUIRED');
        }
      }
    });

    it('even if some future source (override, aggregation) reported the grant as held', () => {
      const leaky = new PermissionService({ mentorScopes: async () => [] } as any);
      leaky.has = () => true;   // simulate a source that wrongly adds every permission
      const g = new PermissionGuard(new Reflector(), leaky);
      for (const role of ['ADMIN', 'SUPER_ADMIN']) {
        for (const m of ['grade', 'prepare']) {
          expect(refusal(() => g.canActivate(context(Routes, m, { role }))).code).toBe('PERMISSION_REQUIRED');
        }
      }
      // Not a blanket refusal: coaches still pass, and admins pass non-grading routes.
      expect(g.canActivate(context(Routes, 'grade', { role: 'MENTOR' }))).toBe(true);
      expect(g.canActivate(context(Routes, 'manageUsers', { role: 'ADMIN' }))).toBe(true);
    });
  });
});
