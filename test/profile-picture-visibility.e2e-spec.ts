/**
 * Any signed-in user who may view a person's profile also sees that person's picture (owner 2026-11-27) — by exactly
 * the check of that profile, never a rule of the picture's own — for Students, Coaches and Head Coaches, end to end:
 *  1. For every viewer, GET /users/:id/avatar answers like the person's profile endpoint: a student's
 *     GET /students/:id/overview; a Coach's or Head Coach's GET /admin/users/:id (users.manage), or GET /me for
 *     themself (200 ↔ 200, refused ↔ 404).
 *  2. Taking users.manage away from an Administrator (a DENY override) takes away both the Coach's profile page and the
 *     Coach's picture: the same permission, overrides included.
 *  3. Never revealing whether a protected person has a picture: refused, unknown account and "no picture" are the same 404.
 * Teachers' and Administrators' pictures are not protected by a profile rule (any signed-in user, unchanged).
 */
import bcrypt from 'bcrypt';

import { bearer, completeStaffBankDetails, createTestApp, login, type TestContext } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const NO_PICTURE = 'This account has no profile picture.';

describe('Profile pictures follow the profile check (e2e)', () => {
  let ctx: TestContext;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const as = <T extends { set: (k: string, v: string) => T }>(r: T, who?: string) => (who ? r.set('Authorization', `Bearer ${tokens[who]}`) : r);
  const pic = (id: string, who?: string) => as(http().get(`/api/v1/users/${id}/avatar`), who);
  const studentProfile = (id: string, who?: string) => as(http().get(`/api/v1/students/${id}/overview`), who);
  /** A Coach's or Head Coach's profile, as the viewer can open it: their own (GET /me) or the account page. */
  const staffProfile = (id: string, who: string) => (ids[who] === id ? as(http().get('/api/v1/me'), who) : as(http().get(`/api/v1/admin/users/${id}`), who));

  const VIEWERS = ['student.j', 'student.j2', 'student.s', 'admin', 'ppv.super', 'mentor.j', 'mentor.j2', 'mentor.s', 'ppv.hc.maths', 'ppv.hc.physics', 'ppv.teacher'];

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await bcrypt.hash('Password123', 4);
    const maths = (await p().discipline.upsert({ where: { code: 'MATHEMATICS' }, create: { code: 'MATHEMATICS', name: 'Mathematics' }, update: {} })).id;
    const physics = (await p().discipline.upsert({ where: { code: 'PHYSICS' }, create: { code: 'PHYSICS', name: 'Physics' }, update: {} })).id;
    const staff = async (username: string, role: 'HEAD_COACH' | 'TEACHER' | 'SUPER_ADMIN' | 'ADMIN', programme?: string) => {
      const id = (await p().user.create({ data: { username, firstName: username, lastName: 'Staff', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
      if (programme) await p().programmeMembership.create({ data: { userId: id, disciplineId: programme, source: 'MANUAL' } });
    };
    await staff('ppv.hc.maths', 'HEAD_COACH', maths);
    await staff('ppv.hc.physics', 'HEAD_COACH', physics);
    await staff('ppv.teacher', 'TEACHER');
    await staff('ppv.super', 'SUPER_ADMIN');
    await staff('ppv.admin2', 'ADMIN');
    await completeStaffBankDetails(p());
    for (const u of ['admin', 'mentor.j', 'mentor.j2', 'mentor.s', 'student.j', 'student.j2', 'student.s']) tokens[u] = await login(ctx, u);
    for (const u of ['ppv.hc.maths', 'ppv.hc.physics', 'ppv.teacher', 'ppv.super', 'ppv.admin2']) tokens[u] = await login(ctx, u, 'Password123');
    for (const u of [...VIEWERS, 'ppv.admin2']) ids[u] = (await p().user.findUniqueOrThrow({ where: { username: u } })).id;
    // Pictures: a student, a Coach and a Head Coach have one; the second Junior coach has none.
    for (const u of ['student.j', 'mentor.j', 'ppv.hc.maths']) {
      await http().put('/api/v1/me/avatar').set(bearer(tokens[u])).attach('file', PNG, 'me.png').expect(200);
    }
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('one principle for Students, Coaches and Head Coaches: for every viewer, the picture answers like the profile', async () => {
    const targets = [['student', 'student.j'], ['coach', 'mentor.j'], ['head coach', 'ppv.hc.maths']] as const;
    const outcomes = new Set<string>();
    for (const [kind, target] of targets) {
      for (const v of VIEWERS) {
        const profile = (kind === 'student' ? await studentProfile(ids[target], v) : await staffProfile(ids[target], v)).status;
        const picture = await pic(ids[target], v);
        expect({ kind, v, picture: picture.status }).toEqual({ kind, v, picture: profile === 200 ? 200 : 404 });
        if (picture.status === 200) expect(picture.headers['cache-control']).toBe('private, no-store');
        else expect(picture.body.message).toBe(NO_PICTURE);
        outcomes.add(`${kind}:${picture.status}`);
      }
      expect((await pic(ids[target])).status).toBe(401);   // signed out
    }
    // Not vacuous: each of the three is both shown and refused.
    expect([...outcomes].sort()).toEqual(['coach:200', 'coach:404', 'head coach:200', 'head coach:404', 'student:200', 'student:404']);
  });

  it('a Coach and a Head Coach: themself and Administrators (users.manage) see it; students, coaches, Head Coaches and Teachers do not', async () => {
    for (const target of ['mentor.j', 'ppv.hc.maths']) {
      for (const v of [target, 'admin', 'ppv.super']) expect({ target, v, status: (await pic(ids[target], v)).status }).toEqual({ target, v, status: 200 });
      for (const v of VIEWERS.filter((x) => ![target, 'admin', 'ppv.super'].includes(x))) {
        expect({ target, v, status: (await pic(ids[target], v)).status }).toEqual({ target, v, status: 404 });
      }
    }
  });

  it('taking users.manage away from an Administrator takes away the Coach\'s profile page and picture together', async () => {
    expect([(await staffProfile(ids['mentor.j'], 'ppv.admin2')).status, (await pic(ids['mentor.j'], 'ppv.admin2')).status]).toEqual([200, 200]);
    const deny = await p().userPermissionOverride.create({ data: {
      userId: ids['ppv.admin2'], permission: 'users.manage', effect: 'DENY', reason: 'Test: not this term', createdById: ids['ppv.super'],
    } });
    try {
      tokens['ppv.admin2'] = await login(ctx, 'ppv.admin2', 'Password123');
      expect([(await staffProfile(ids['mentor.j'], 'ppv.admin2')).status, (await pic(ids['mentor.j'], 'ppv.admin2')).status]).toEqual([403, 404]);
    } finally {
      await p().userPermissionOverride.delete({ where: { id: deny.id } });
    }
  });

  it('never reveals whether a protected person has a picture: refused, no picture and unknown account give the same answer', async () => {
    const answers = [
      await pic(ids['mentor.j'], 'student.j'),     // has a picture, viewer refused
      await pic(ids['mentor.j2'], 'admin'),        // viewer allowed, no picture
      await pic(ids['mentor.j2'], 'student.j'),    // no picture, viewer refused
      await pic(ids['student.j'], 'ppv.teacher'),  // a student's picture, viewer refused
      await pic('00000000-0000-4000-8000-000000000000', 'student.j'),
    ];
    for (const r of answers) expect([r.status, r.body.message]).toEqual([404, NO_PICTURE]);
  });
});
