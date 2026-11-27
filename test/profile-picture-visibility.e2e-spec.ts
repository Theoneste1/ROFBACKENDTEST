/**
 * A user's profile picture is visible to everyone who may view that user's profile (owner 2026-11-27), end to end:
 *  1. A STUDENT: for every kind of viewer, GET /users/:id/avatar answers exactly like GET /students/:id/overview
 *     (200 ↔ 200, 404 ↔ 404, 401 ↔ 401) — the two endpoints share one rule (StudentOverviewService.mayView).
 *  2. A COACH (CoachProfileService.mayView): the coach, Administrators, the Head Coaches of the coach's programme and the
 *     people of a course discussion the coach takes part in (students of that division, coaches working there) see it;
 *     students of another division, coaches elsewhere, a Head Coach of another programme and Teachers get 404. Losing the
 *     shared course takes the picture away at once (no browser caching).
 *  3. Never revealing whether a protected user has a picture: refused, unknown account and "no picture" are the same 404.
 */
import bcrypt from 'bcrypt';

import { bearer, completeStaffBankDetails, createTestApp, login, type TestContext } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

describe('Profile pictures follow profile visibility (e2e)', () => {
  let ctx: TestContext;
  const tokens: Record<string, string> = {};
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const pic = (id: string, who?: string) => {
    const r = http().get(`/api/v1/users/${id}/avatar`);
    return who ? r.set(bearer(tokens[who])) : r;
  };
  const overview = (id: string, who?: string) => {
    const r = http().get(`/api/v1/students/${id}/overview`);
    return who ? r.set(bearer(tokens[who])) : r;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = await bcrypt.hash('Password123', 4);
    const maths = (await p().discipline.upsert({ where: { code: 'MATHEMATICS' }, create: { code: 'MATHEMATICS', name: 'Mathematics' }, update: {} })).id;
    const physics = (await p().discipline.upsert({ where: { code: 'PHYSICS' }, create: { code: 'PHYSICS', name: 'Physics' }, update: {} })).id;
    const staff = async (username: string, role: 'HEAD_COACH' | 'TEACHER', programme?: string) => {
      const id = (await p().user.create({ data: { username, firstName: username, lastName: 'Staff', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
      if (programme) await p().programmeMembership.create({ data: { userId: id, disciplineId: programme, source: 'MANUAL' } });
    };
    await staff('ppv.hc.maths', 'HEAD_COACH', maths);
    await staff('ppv.hc.physics', 'HEAD_COACH', physics);
    await staff('ppv.teacher', 'TEACHER');
    await completeStaffBankDetails(p());
    for (const u of ['admin', 'mentor.j', 'mentor.j2', 'mentor.s', 'student.j', 'student.j2', 'student.s']) tokens[u] = await login(ctx, u);
    for (const u of ['ppv.hc.maths', 'ppv.hc.physics', 'ppv.teacher']) tokens[u] = await login(ctx, u, 'Password123');
    // Pictures: the Junior student and the Junior coach have one; the second Junior coach has none.
    for (const u of ['student.j', 'mentor.j']) {
      await http().put('/api/v1/me/avatar').set(bearer(tokens[u])).attach('file', PNG, 'me.png').expect(200);
    }
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('a student: the picture answers exactly like the student\'s profile, for every kind of viewer', async () => {
    const id = ctx.ids.studentJunior;
    const viewers = ['student.j', 'student.j2', 'student.s', 'admin', 'mentor.j', 'mentor.s', 'ppv.hc.maths', 'ppv.hc.physics', 'ppv.teacher'];
    const seen: Record<string, [number, number]> = {};
    for (const v of viewers) seen[v] = [(await overview(id, v)).status, (await pic(id, v)).status];
    for (const v of viewers) expect({ v, profile: seen[v][0] }).toEqual({ v, profile: seen[v][1] });
    // Both kinds of answer occur (the comparison is not vacuous): the student, other students and staff of the student's
    // programme see both; a Head Coach of another programme and an unrelated Teacher see neither.
    expect(seen['student.j']).toEqual([200, 200]);
    expect(seen['admin']).toEqual([200, 200]);
    expect(seen['mentor.j']).toEqual([200, 200]);
    expect(seen['ppv.hc.physics']).toEqual([404, 404]);
    expect(seen['ppv.teacher']).toEqual([404, 404]);
    expect([(await overview(id)).status, (await pic(id)).status]).toEqual([401, 401]);
  });

  it('a coach: the coach, Administrators, the Head Coach of the coach\'s programme and the people of the coach\'s course discussion see it', async () => {
    const id = ctx.ids.mentorJunior;
    for (const v of ['mentor.j', 'admin', 'ppv.hc.maths', 'student.j', 'student.j2', 'mentor.j2']) {
      const r = await pic(id, v);
      expect({ v, status: r.status }).toEqual({ v, status: 200 });
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('a coach: students of another division, a coach elsewhere, a Head Coach of another programme and a Teacher get 404; anonymous 401', async () => {
    const id = ctx.ids.mentorJunior;
    for (const v of ['student.s', 'mentor.s', 'ppv.hc.physics', 'ppv.teacher']) {
      const r = await pic(id, v);
      expect({ v, status: r.status }).toEqual({ v, status: 404 });
      expect(r.headers['content-type']).not.toBe('image/png');
    }
    expect((await pic(id)).status).toBe(401);
  });

  it('never reveals whether a protected user has a picture: refused, no picture and unknown account give the same answer', async () => {
    const refused = await pic(ctx.ids.mentorJunior, 'student.s');            // has a picture, viewer refused
    const noPicture = await pic(ctx.ids.mentorJunior2, 'student.j');         // viewer allowed, no picture
    const refusedNoPicture = await pic(ctx.ids.mentorJunior2, 'student.s');  // no picture, viewer refused
    const unknown = await pic('00000000-0000-4000-8000-000000000000', 'student.s');
    const studentRefused = await pic(ctx.ids.studentJunior, 'ppv.teacher');  // a student's picture, viewer refused
    for (const r of [refused, noPicture, refusedNoPicture, unknown, studentRefused]) {
      expect([r.status, r.body.message]).toEqual([404, 'This account has no profile picture.']);
    }
  });

  it('losing the shared course takes the coach\'s picture away at once', async () => {
    expect((await pic(ctx.ids.mentorJunior, 'mentor.j2')).status).toBe(200);
    await p().mentorAssignment.updateMany({ where: { mentorId: ctx.ids.mentorJunior2 }, data: { isActive: false } });
    try {
      expect((await pic(ctx.ids.mentorJunior, 'mentor.j2')).status).toBe(404);
    } finally {
      await p().mentorAssignment.updateMany({ where: { mentorId: ctx.ids.mentorJunior2 }, data: { isActive: true } });
    }
  });
});
