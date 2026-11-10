import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { legacyRolesFor, requiredPermission } from './route-access.testing.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

const reflector = new Reflector();
const proto = AuthController.prototype as unknown as Record<string, Function>;

const roles = (method: string) => legacyRolesFor(AuthController, method);
const isPublic = (method: string) =>
  reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [proto[method], AuthController]);

describe('AuthController authorization metadata', () => {
  it('has no class-level roles or public flag', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AuthController)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuthController)).toBeUndefined();
  });

  it.each(['login', 'registerStudent', 'refresh', 'forgotPassword', 'resetPassword'])(
    '%s is public and has no role restriction',
    (method) => {
      expect(isPublic(method)).toBe(true);
      expect(roles(method)).toBeUndefined();
    },
  );

  it('registerAdmin is ADMIN only and not public', () => {
    expect(roles('registerAdmin')).toEqual(['ADMIN']);
    expect(requiredPermission(AuthController, 'registerAdmin')).toBe('users.manage');   // P1-06
    expect(isPublic('registerAdmin')).toBeUndefined();
  });

  it.each(['logout', 'logoutAll', 'changePassword'])(
    '%s requires authentication but no specific role',
    (method) => {
      expect(isPublic(method)).toBeUndefined();
      expect(roles(method)).toBeUndefined();
    },
  );
});
