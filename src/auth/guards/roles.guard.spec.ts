import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { Roles } from '../decorators/roles.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';

class OpenController {
  anyone() {}

  @Roles('MENTOR')
  mentorOnly() {}

  @Roles('ADMIN', 'MENTOR')
  staff() {}

  @Public()
  publicRoute() {}

  @Roles()
  emptyRoles() {}
}

@Roles('ADMIN')
class AdminController {
  inherited() {}

  @Roles('STUDENT')
  overridden() {}

  @Public()
  publicOverride() {}
}

function context(cls: Function, method: string, user?: { role: string }): ExecutionContext {
  return {
    getHandler:   () => (cls.prototype as Record<string, Function>)[method],
    getClass:     () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows any authenticated user when no roles are declared', () => {
    expect(guard.canActivate(context(OpenController, 'anyone', { role: 'STUDENT' }))).toBe(true);
  });

  it('treats an empty @Roles() as unrestricted', () => {
    expect(guard.canActivate(context(OpenController, 'emptyRoles', { role: 'STUDENT' }))).toBe(true);
  });

  it('allows a listed role', () => {
    expect(guard.canActivate(context(OpenController, 'mentorOnly', { role: 'MENTOR' }))).toBe(true);
    expect(guard.canActivate(context(OpenController, 'staff', { role: 'ADMIN' }))).toBe(true);
  });

  it('does NOT auto-allow ADMIN on a MENTOR-only route', () => {
    expect(guard.canActivate(context(OpenController, 'mentorOnly', { role: 'ADMIN' }))).toBe(false);
  });

  it('refuses an unlisted role', () => {
    expect(guard.canActivate(context(OpenController, 'mentorOnly', { role: 'STUDENT' }))).toBe(false);
  });

  it('refuses when there is no user on a role-restricted route', () => {
    expect(guard.canActivate(context(OpenController, 'mentorOnly', undefined))).toBe(false);
  });

  it('lets public routes through without a user', () => {
    expect(guard.canActivate(context(OpenController, 'publicRoute', undefined))).toBe(true);
  });

  it('applies class-level roles to handlers without their own', () => {
    expect(guard.canActivate(context(AdminController, 'inherited', { role: 'ADMIN' }))).toBe(true);
    expect(guard.canActivate(context(AdminController, 'inherited', { role: 'MENTOR' }))).toBe(false);
  });

  it('lets handler roles override class roles', () => {
    expect(guard.canActivate(context(AdminController, 'overridden', { role: 'STUDENT' }))).toBe(true);
    expect(guard.canActivate(context(AdminController, 'overridden', { role: 'ADMIN' }))).toBe(false);
  });

  it('public handlers bypass class-level roles', () => {
    expect(guard.canActivate(context(AdminController, 'publicOverride', undefined))).toBe(true);
  });
});
