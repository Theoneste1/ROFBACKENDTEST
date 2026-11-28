import { lastValueFrom, of } from 'rxjs';

import {
  containsUserShape, hiddenRoleFilter, isHiddenAccount, maskSuperAdminActors, maskSuperAdmins, maskedUser, NOT_SUPER_ADMIN, seesSuperAdmins, visibleUsersWhere,
} from './super-admin-privacy.js';
import { isSignInRoute, SuperAdminPrivacyInterceptor } from './super-admin-privacy.interceptor.js';

const OTHER_ROLES = ['ADMIN', 'HEAD_COACH', 'MENTOR', 'TEACHER', 'STUDENT', 'UNKNOWN_ROLE', 'super_admin', ''];

describe('Super Administrator privacy — visibility rules', () => {
  it('only a SUPER_ADMIN viewer sees Super Administrators; any other, unknown or missing viewer does not', () => {
    expect(seesSuperAdmins({ role: 'SUPER_ADMIN' })).toBe(true);
    for (const role of OTHER_ROLES) expect(seesSuperAdmins({ role })).toBe(false);
    expect(seesSuperAdmins(undefined)).toBe(false);
    expect(seesSuperAdmins(null)).toBe(false);
  });

  it('visibleUsersWhere: everything for a Super Administrator; never role SUPER_ADMIN for anyone else', () => {
    expect(visibleUsersWhere({ role: 'SUPER_ADMIN' })).toEqual({});
    for (const role of OTHER_ROLES) expect(visibleUsersWhere({ role })).toEqual({ role: { not: 'SUPER_ADMIN' } });
    expect(visibleUsersWhere(undefined)).toEqual({ role: { not: 'SUPER_ADMIN' } });
    expect(NOT_SUPER_ADMIN).toEqual({ role: { not: 'SUPER_ADMIN' } });
  });

  it('isHiddenAccount: a SUPER_ADMIN target is hidden from every other role; nothing else is hidden', () => {
    for (const role of OTHER_ROLES) {
      expect(isHiddenAccount({ role }, { role: 'SUPER_ADMIN' })).toBe(true);
      for (const t of ['ADMIN', 'HEAD_COACH', 'MENTOR', 'TEACHER', 'STUDENT']) expect(isHiddenAccount({ role }, { role: t })).toBe(false);
    }
    expect(isHiddenAccount({ role: 'SUPER_ADMIN' }, { role: 'SUPER_ADMIN' })).toBe(false);
    expect(isHiddenAccount({ role: 'ADMIN' }, null)).toBe(false);
    expect(isHiddenAccount(undefined, { role: 'SUPER_ADMIN' })).toBe(true);
  });

  it('hiddenRoleFilter: ?role=SUPER_ADMIN is a hidden filter for everyone but a Super Administrator', () => {
    expect(hiddenRoleFilter({ role: 'ADMIN' }, 'SUPER_ADMIN')).toBe(true);
    expect(hiddenRoleFilter({ role: 'SUPER_ADMIN' }, 'SUPER_ADMIN')).toBe(false);
    expect(hiddenRoleFilter({ role: 'ADMIN' }, 'ADMIN')).toBe(false);
    expect(hiddenRoleFilter({ role: 'ADMIN' }, undefined)).toBe(false);
  });
});

describe('Super Administrator privacy — masking embedded users', () => {
  const sa = { id: 'sa-1', firstName: 'Grace', lastName: 'Owner', username: 'grace.owner', email: 'grace@rof.rw', phone: '+250788', avatarUrl: '/x', role: 'SUPER_ADMIN' };

  it('the masked form keeps the id and shows the neutral "ROF Administration" identity, only for the fields present', () => {
    expect(maskedUser(sa)).toEqual({
      id: 'sa-1', firstName: 'ROF', lastName: 'Administration', username: 'rof.administration', email: null, phone: null, avatarUrl: null, role: 'ADMIN',
    });
    expect(maskedUser({ id: 'sa-1', username: 'grace.owner' })).toEqual({ id: 'sa-1', username: 'rof.administration' });
    expect(maskedUser({ id: 'sa-1', firstName: 'Grace', name: 'Grace Owner' })).toEqual({ id: 'sa-1', firstName: 'ROF', name: 'ROF Administration' });
  });

  it('masks every user-shaped object with a hidden id, at any depth; leaves everything else as it is', () => {
    const when = new Date('2026-11-28T10:00:00Z');
    const body = {
      data: [
        { id: 'post-1', body: 'Hello', createdAt: when, author: { ...sa } },
        { id: 'post-2', body: 'Hi', author: { id: 'stu-1', firstName: 'Aline', lastName: 'U', username: 'aline' } },
      ],
      createdBy: { id: 'sa-1', username: 'grace.owner' },
      meta: { total: 2 },
      // Not a user (no user field), even with a hidden id: untouched.
      ref: { id: 'sa-1', kind: 'User' },
    };
    const out = maskSuperAdmins(body, new Set(['sa-1']));
    expect(out.data[0].author).toMatchObject({ id: 'sa-1', firstName: 'ROF', lastName: 'Administration', username: 'rof.administration', email: null, avatarUrl: null, role: 'ADMIN' });
    expect(out.data[0].createdAt).toBe(when);
    expect(out.data[1]).toBe(body.data[1]);
    expect(out.createdBy).toEqual({ id: 'sa-1', username: 'rof.administration' });
    expect(out.ref).toBe(body.ref);
    expect(out.meta).toBe(body.meta);
    expect(JSON.stringify(out)).not.toMatch(/grace|Owner/i);
    // The input is never changed.
    expect(body.data[0].author.username).toBe('grace.owner');
  });

  it('nothing hidden → the very same body; non-plain values are never walked', () => {
    const body = { a: [{ id: 'x', username: 'y' }] };
    expect(maskSuperAdmins(body, new Set())).toBe(body);
    const buf = Buffer.from('id');
    expect(maskSuperAdmins(buf, new Set(['sa-1']))).toBe(buf);
  });

  it('containsUserShape finds a user-shaped object at any depth; a body too large to inspect counts as holding one', () => {
    expect(containsUserShape({ a: [{ b: { id: '1', username: 'u' } }] })).toBe(true);
    expect(containsUserShape({ a: [{ id: '3', title: 't' }], c: 'x' })).toBe(false);
    expect(containsUserShape(Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: 't' })), 10)).toBe(true);
  });
});

describe('SuperAdminPrivacyInterceptor', () => {
  function make(superAdminIds: string[]) {
    const prisma = { user: { findMany: vi.fn().mockResolvedValue(superAdminIds.map((id) => ({ id }))) } };
    return { interceptor: new SuperAdminPrivacyInterceptor(prisma as never), prisma };
  }
  const ctx = (user: unknown, originalUrl = '/api/v1/threads/t-1') =>
    ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user, originalUrl }) }) }) as never;
  const body = () => ({ author: { id: 'sa-1', firstName: 'Grace', lastName: 'Owner', username: 'grace.owner', email: 'g@rof.rw' } });

  it.each(['ADMIN', 'HEAD_COACH', 'MENTOR', 'TEACHER', 'STUDENT'])('masks a Super Administrator for a %s viewer', async (role) => {
    const { interceptor } = make(['sa-1']);
    const out = await lastValueFrom(interceptor.intercept(ctx({ id: 'v', role }), { handle: () => of(body()) }));
    expect(out).toEqual({ author: { id: 'sa-1', firstName: 'ROF', lastName: 'Administration', username: 'rof.administration', email: null } });
  });

  it('masks for an anonymous caller too', async () => {
    const { interceptor } = make(['sa-1']);
    const out = await lastValueFrom(interceptor.intercept(ctx(undefined), { handle: () => of(body()) }));
    expect((out as ReturnType<typeof body>).author.username).toBe('rof.administration');
  });

  it('never masks the account that signs in (anonymous /auth/ routes: login, refresh, activation, view-as exchange)', async () => {
    const { interceptor, prisma } = make(['sa-1']);
    const login = { access_token: 't', user: { id: 'sa-1', username: 'grace.owner', firstName: 'Grace', role: 'SUPER_ADMIN' } };
    expect(await lastValueFrom(interceptor.intercept(ctx(undefined, '/api/v1/auth/login'), { handle: () => of(login) }))).toBe(login);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(isSignInRoute('/api/v1/auth/refresh?x=1')).toBe(true);
    expect(isSignInRoute('/api/v1/auth/view-as/exchange')).toBe(true);
    expect(isSignInRoute('/api/v1/public/statistics')).toBe(false);
    expect(isSignInRoute('/api/v1/threads/auth/x')).toBe(false);
    // An authenticated caller on an /auth/ route is masked as anywhere else.
    const out = await lastValueFrom(interceptor.intercept(ctx({ id: 'v', role: 'ADMIN' }, '/api/v1/auth/register/admin'), { handle: () => of(body()) }));
    expect((out as ReturnType<typeof body>).author.username).toBe('rof.administration');
  });

  it('a Super Administrator viewer sees the real identity, without any query', async () => {
    const { interceptor, prisma } = make(['sa-1']);
    const out = await lastValueFrom(interceptor.intercept(ctx({ id: 'sa-2', role: 'SUPER_ADMIN' }), { handle: () => of(body()) }));
    expect(out).toEqual(body());
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('no user-shaped object (or not JSON) → no query, body unchanged', async () => {
    const { interceptor, prisma } = make(['sa-1']);
    const plain = { total: 3 };
    expect(await lastValueFrom(interceptor.intercept(ctx({ id: 'v', role: 'ADMIN' }), { handle: () => of(plain) }))).toBe(plain);
    expect(await lastValueFrom(interceptor.intercept(ctx({ id: 'v', role: 'ADMIN' }), { handle: () => of(undefined) }))).toBeUndefined();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('users who are not Super Administrators are never masked', async () => {
    const { interceptor } = make([]);
    const out = await lastValueFrom(interceptor.intercept(ctx({ id: 'v', role: 'ADMIN' }), { handle: () => of(body()) }));
    expect(out).toEqual(body());
  });
});

describe('Super Administrator privacy — audit-style actor rows (review 2026-11-28)', () => {
  const make = () => ({ interceptor: new SuperAdminPrivacyInterceptor({ user: { findMany: vi.fn().mockResolvedValue([]) } } as never) });
  const ctx = (user: unknown) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user, originalUrl: '/api/v1/admin/forms/X/history' }) }) }) as never;
  it('registration timeline / forms / school history rows: the role and the username of a Super Administrator actor are neutral', () => {
    const rows = [
      { id: 'a1', action: 'CREATE_ADMIN_ACCOUNT', actor: 'SUPER_ADMIN', actorUsername: 'sa.one', at: '2026-11-28' },
      { id: 'a2', action: 'FORM_OPENED', actorId: 'sa-id', actorUsername: 'sa.one', actorRole: 'SUPER_ADMIN' },
      { id: 'a3', action: 'SCHOOL_EDITED', actorUsername: 'ad.min', actorRole: 'ADMIN' },
      { id: 'a4', by: 'Gracious Owner', byRole: 'SUPER_ADMIN', byName: 'Gracious Owner', byEmail: 'sa@x' },
    ];
    expect(maskSuperAdminActors({ events: rows })).toEqual({ events: [
      { id: 'a1', action: 'CREATE_ADMIN_ACCOUNT', actor: 'ADMIN', actorUsername: 'rof.administration', at: '2026-11-28' },
      { id: 'a2', action: 'FORM_OPENED', actorId: 'sa-id', actorUsername: 'rof.administration', actorRole: 'ADMIN' },
      { id: 'a3', action: 'SCHOOL_EDITED', actorUsername: 'ad.min', actorRole: 'ADMIN' },
      { id: 'a4', by: 'ROF Administration', byRole: 'ADMIN', byName: 'ROF Administration', byEmail: null },
    ] });
  });

  it('leaves everything else alone (the user role field, other values; nothing to mask gives the same object)', () => {
    const body = { user: { id: 'u', role: 'ADMIN' }, roles: ['SUPER_ADMIN'], actorRole: 'ADMIN', note: 'SUPER_ADMIN' };
    expect(maskSuperAdminActors(body)).toBe(body);
  });

  it('the interceptor applies it for every non-Super-Administrator viewer, never for a Super Administrator', async () => {
    const row = () => ({ actorUsername: 'sa.one', actorRole: 'SUPER_ADMIN' });
    for (const role of ['ADMIN', 'HEAD_COACH', 'MENTOR', 'TEACHER', 'STUDENT']) {
      const { interceptor } = make();
      const out = await lastValueFrom(interceptor.intercept(ctx({ id: 'v', role }), { handle: () => of(row()) }));
      expect(out).toEqual({ actorUsername: 'rof.administration', actorRole: 'ADMIN' });
    }
    const { interceptor } = make();
    const out = await lastValueFrom(interceptor.intercept(ctx({ id: 'sa', role: 'SUPER_ADMIN' }), { handle: () => of(row()) }));
    expect(out).toEqual(row());
  });
});
