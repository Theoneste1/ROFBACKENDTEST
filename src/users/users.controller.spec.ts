import { Reflector } from '@nestjs/core';
import { MeController, UsersController } from './users.controller.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

const reflector = new Reflector();

function effective(cls: Function, method: string, key: string) {
  const handler = (cls.prototype as Record<string, Function>)[method];
  return reflector.getAllAndOverride(key, [handler, cls]);
}

describe('UsersController authorization metadata', () => {
  it('is ADMIN only at class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, UsersController)).toEqual(['ADMIN']);
  });

  it.each(['findAll', 'create', 'invite', 'import', 'findOne', 'update', 'resendInvitation', 'sendPasswordReset', 'updateStatus', 'delete'])(
    '%s resolves to ADMIN and is not public',
    (method) => {
      expect(effective(UsersController, method, ROLES_KEY)).toEqual(['ADMIN']);
      expect(effective(UsersController, method, IS_PUBLIC_KEY)).toBeUndefined();
    },
  );
});

describe('MeController authorization metadata', () => {
  it('has no class-level roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MeController)).toBeUndefined();
  });

  it.each(['getMe', 'updateMe', 'permissions'])('%s is open to any authenticated user', (method) => {
    expect(effective(MeController, method, ROLES_KEY)).toBeUndefined();
    expect(effective(MeController, method, IS_PUBLIC_KEY)).toBeUndefined();
  });

  it('enrollments is STUDENT only and not public', () => {
    expect(effective(MeController, 'enrollments', ROLES_KEY)).toEqual(['STUDENT']);
    expect(effective(MeController, 'enrollments', IS_PUBLIC_KEY)).toBeUndefined();
  });

  it('no longer exposes the removed promote route', () => {
    expect((UsersController.prototype as unknown as Record<string, unknown>).promote).toBeUndefined();
  });

  it('permissions returns the caller role and its permission list', () => {
    const controller = new MeController({} as any);
    const result = controller.permissions({ id: 's1', role: 'STUDENT' } as any);
    expect(result.role).toBe('STUDENT');
    expect(result.permissions).toContain('submissions.submit');
  });
});
