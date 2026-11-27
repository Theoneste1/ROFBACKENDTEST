/**
 * A user's profile picture is visible to everyone who may view that user's profile (owner 2026-11-27), end to end:
 *  1. A STUDENT: for every kind of viewer, GET /users/:id/avatar answers exactly like GET /students/:id/overview
 *     (200 ↔ 200, 404 ↔ 404, 401 ↔ 401) — the two endpoints share one rule (StudentOverviewService.mayView).
 *  2. A COACH (CoachProfileService.mayView): the coach, Administrators, the Head Coaches of the coach's programme and the
 *     people of a course discussion the coach takes part in (students of that division, coaches working there) see it;
 *     students of another division, coaches elsewhere, a Head Coach of another programme and Teachers get 404. Losing the
 *     shared course takes the picture away at once (no browser caching).
 *  3. A HEAD COACH (CoachProfileService.mayView, the same rule without the "managing Head Coach" part — only
 *     Administrators manage Head Coaches): the Head Coach, Administrators and the people of a course discussion the Head
 *     Coach takes part in see it; everyone else gets 404.
 *  4. Never revealing whether a protected user has a picture: refused, unknown account and "no picture" are the same 404.
 *  5. One principle for all three: for every viewer, the picture endpoint agrees with the profile rule itself — the
 *     student profile endpoint for a student, the profile rule (CoachProfileService) for a Coach and a Head Coach.
 */
import bcrypt from 'bcrypt';

import type { AuthUser } from '../src/common/auth-user.js';
import { CoachProfileService } from '../src/users/coach-profile.service.js';
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
    // The Mathematics Head Coach works in Algebra × Junior (a course assignment, as an Administrator gives one), so they
    // take part in that course's discussions; the Physics Head Coach has no course.
    const hcMaths = (await p().user.findUniqueOrThrow({ where: { username: 'ppv.hc.maths' } })).id;
    await p().mentorAssignment.create({ data: { mentorId: hcMaths, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior } });
    for (const u of ['admin', 'mentor.j', 'mentor.j2', 'mentor.s', 'student.j', 'student.j2', 'student.s']) tokens[u] = await login(ctx, u);
    for (const u of ['ppv.hc.maths', 'ppv.hc.physics', 'ppv.teacher']) tokens[u] = await login(ctx, u, 'Password123');
    // Pictures: the Junior student, the Junior coach and both Head Coaches have one; the second Junior coach has none.
    for (const u of ['student.j', 'mentor.j', 'ppv.hc.maths', 'ppv.hc.physics']) {
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

  it("a Head Coach: the Head Coach, Administrators and the people of the Head Coach's course discussion see it (never cached)", async () => {
    const id = (await p().user.findUniqueOrThrow({ where: { username: 'ppv.hc.maths' } })).id;
    for (const v of ['ppv.hc.maths', 'admin', 'student.j', 'student.j2', 'mentor.j', 'mentor.j2']) {
      const r = await pic(id, v);
      expect({ v, status: r.status }).toEqual({ v, status: 200 });
      expect(r.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('a Head Coach: students of another division, a coach elsewhere, another Head Coach and a Teacher get 404; anonymous 401', async () => {
    const id = (await p().user.findUniqueOrThrow({ where: { username: 'ppv.hc.maths' } })).id;
    for (const v of ['student.s', 'mentor.s', 'ppv.hc.physics', 'ppv.teacher']) {
      const r = await pic(id, v);
      expect({ v, status: r.status, message: r.body.message }).toEqual({ v, status: 404, message: 'This account has no profile picture.' });
    }
    expect((await pic(id)).status).toBe(401);
    // A Head Coach with no course: only themself and Administrators.
    const solo = (await p().user.findUniqueOrThrow({ where: { username: 'ppv.hc.physics' } })).id;
    for (const v of ['ppv.hc.physics', 'admin']) expect({ v, status: (await pic(solo, v)).status }).toEqual({ v, status: 200 });
    for (const v of ['student.j', 'mentor.j', 'ppv.hc.maths', 'ppv.teacher']) expect({ v, status: (await pic(solo, v)).status }).toEqual({ v, status: 404 });
  });

  it('one principle for all three: for every viewer, the picture agrees with the profile rule (student, Coach, Head Coach)', async () => {
    const rule = ctx.app.get(CoachProfileService);
    const viewers = ['student.j', 'student.j2', 'student.s', 'admin', 'mentor.j', 'mentor.j2', 'mentor.s', 'ppv.hc.maths', 'ppv.hc.physics', 'ppv.teacher'];
    const asUser = async (username: string) =>
      (await p().user.findUniqueOrThrow({ where: { username }, select: { id: true, username: true, role: true, divisionId: true } })) as unknown as AuthUser;
    const student = ctx.ids.studentJunior;
    const coach = ctx.ids.mentorJunior;
    const head = (await p().user.findUniqueOrThrow({ where: { username: 'ppv.hc.maths' } })).id;
    const outcomes = new Set<string>();
    for (const v of viewers) {
      // Student: the picture endpoint and the student profile endpoint give the same answer.
      const [profile, picture] = [(await overview(student, v)).status, (await pic(student, v)).status];
      expect({ v, target: 'student', picture }).toEqual({ v, target: 'student', picture: profile });
      outcomes.add(`STUDENT:${picture}`);
      // Coach and Head Coach: the picture endpoint follows the profile rule.
      const viewer = await asUser(v);
      for (const [target, role] of [[coach, 'MENTOR'], [head, 'HEAD_COACH']] as const) {
        const allowed = await rule.mayView(viewer, { id: target, role });
        const status = (await pic(target, v)).status;
        expect({ v, role, status }).toEqual({ v, role, status: allowed ? 200 : 404 });
        outcomes.add(`${role}:${status}`);
      }
    }
    // Not vacuous: both answers occur for each of the three.
    expect([...outcomes].sort()).toEqual(['HEAD_COACH:200', 'HEAD_COACH:404', 'MENTOR:200', 'MENTOR:404', 'STUDENT:200', 'STUDENT:404']);
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
