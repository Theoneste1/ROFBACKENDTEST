import { Reflector } from '@nestjs/core';
import { AuthController, REFRESH_COOKIE, bearerToken } from './auth.controller.js';
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

  it.each(['login', 'registerStudent', 'refresh', 'logout', 'forgotPassword', 'resetPassword'])(
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

  // logout is public since H1 (authenticated by the refresh token, so it works after the access
  // token expired); ending every session and changing the password still need a valid access token.
  it.each(['logoutAll', 'changePassword'])(
    '%s requires authentication but no specific role',
    (method) => {
      expect(isPublic(method)).toBeUndefined();
      expect(roles(method)).toBeUndefined();
    },
  );
});

describe('AuthController.logout (H1)', () => {
  const make = () => {
    const authService = { logout: vi.fn().mockResolvedValue(undefined) };
    const config = { get: vi.fn().mockReturnValue('production') };
    const controller = new AuthController(authService as never, config as never, {} as never);
    const res = { clearCookie: vi.fn() };
    const req = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
      ({ cookies, get: (h: string) => headers[h.toLowerCase()] }) as never;
    return { controller, authService, res, req };
  };

  it('passes the refresh cookie and the bearer token, then clears the cookie with its attributes', async () => {
    const { controller, authService, res, req } = make();
    await expect(controller.logout({} as never, req({ authorization: 'Bearer abc.def.ghi' }, { [REFRESH_COOKIE]: 'cookie-token' }), res as never))
      .resolves.toEqual({ message: 'Logged out successfully.' });
    expect(authService.logout).toHaveBeenCalledWith({ refreshToken: 'cookie-token', accessToken: 'abc.def.ghi' });
    expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/v1/auth' });
  });

  it('a refresh token in the body (non-browser clients) wins over the cookie', async () => {
    const { controller, authService, res, req } = make();
    await controller.logout({ refreshToken: 'body-token' } as never, req({}, { [REFRESH_COOKIE]: 'cookie-token' }), res as never);
    expect(authService.logout).toHaveBeenCalledWith({ refreshToken: 'body-token', accessToken: undefined });
  });

  it('with no token at all it still answers 200 and clears the cookie', async () => {
    const { controller, res, req } = make();
    await expect(controller.logout({} as never, req(), res as never)).resolves.toEqual({ message: 'Logged out successfully.' });
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
  });

  it('bearerToken reads only a well-formed Bearer header', () => {
    const r = (v?: string) => ({ get: () => v }) as never;
    expect(bearerToken(r('Bearer a.b.c'))).toBe('a.b.c');
    expect(bearerToken(r('bearer   a.b.c '))).toBe('a.b.c');
    expect(bearerToken(r('Basic xyz'))).toBeUndefined();
    expect(bearerToken(r('Bearer'))).toBeUndefined();
    expect(bearerToken(r(undefined))).toBeUndefined();
  });
});
