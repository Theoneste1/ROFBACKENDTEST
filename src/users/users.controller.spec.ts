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

  it.each(['findAll', 'create', 'promote', 'findOne', 'update', 'updateStatus', 'delete'])(
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

  it.each(['getMe', 'updateMe'])('%s is open to any authenticated user', (method) => {
    expect(effective(MeController, method, ROLES_KEY)).toBeUndefined();
    expect(effective(MeController, method, IS_PUBLIC_KEY)).toBeUndefined();
  });
});
