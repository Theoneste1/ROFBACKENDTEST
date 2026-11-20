/**
 * Coaches' subject interests (owner decision 2026-11-19, Option A; capability coachOlympiadInterests): the existing
 * `olympiadInterests` (MATHEMATICS, COMPUTING, PHYSICS) — no new table or relationship.
 *  - a new coach application must name at least one subject (no empty, invalid or duplicate values); approval copies them;
 *  - a Coach views and edits their own (GET / PATCH /me), at least one when sent; never another coach's;
 *  - an Administrator who may manage Coach accounts edits a Coach's (PATCH /admin/users/:id), audited; other roles refused;
 *  - existing coaches without interests stay valid (sign in, profile, admin edits) and nothing is filled in for them;
 *  - interests are information only: they never grant marking or any other permission.
 */
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Coach subject interests (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  let coach: string;          // mentor.j (seeded, no interests)
  let otherCoachId: string;   // mentor.s (seeded, no interests)
  const http = () => ctx.http();

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    otherCoachId = ctx.ids.mentorSenior;
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    for (const [username, role] of [['ci.teacher', 'TEACHER'], ['ci.head', 'HEAD_COACH']] as const) {
      await ctx.prisma.user.create({ data: { username, firstName: 'Ci', lastName: role, email: `${username}@test.local`, passwordHash: hash, role, activatedAt: new Date() } });
    }
  });
  afterAll(async () => {
    await ctx?.app.close();
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
  });

  let n = 0;
  const apply = (body: Record<string, unknown>) => {
    n += 1;
    return http().post('/api/v1/mentor-requests').send({
      firstName: 'Cora', lastName: 'Coach', username: `ci.c${n}`, email: `ci.c${n}@test.local`, password: 'Mentor123', gender: 'FEMALE', country: 'KE', ...body,
    });
  };
  const usernameOf = () => `ci.c${n}`;

  it('the capability is announced', async () => {
    const { features } = (await http().get('/api/v1').expect(200)).body.capabilities;
    expect(features).toContain('coachOlympiadInterests');
  });

  describe('coach applications', () => {
    it.each([
      [['PHYSICS'], ['PHYSICS']],
      [['PHYSICS', 'MATHEMATICS'], ['MATHEMATICS', 'PHYSICS']],
      [['COMPUTING', 'PHYSICS', 'MATHEMATICS'], ['MATHEMATICS', 'COMPUTING', 'PHYSICS']],
    ])('one, two or three subjects (%j) are stored in the fixed order', async (sent, stored) => {
      const res = await apply({ olympiadInterests: sent }).expect(201);
      expect(res.body.olympiadInterests).toEqual(stored);
      expect((await ctx.prisma.mentorRequest.findUniqueOrThrow({ where: { id: res.body.id } })).olympiadInterests).toEqual(stored);
    });

    it.each([
      ['no subject (field missing)', {}],
      ['an empty list', { olympiadInterests: [] }],
      ['an unknown subject', { olympiadInterests: ['CHEMISTRY'] }],
      ['a duplicate', { olympiadInterests: ['MATHEMATICS', 'MATHEMATICS'] }],
      ['not a list', { olympiadInterests: 'MATHEMATICS' }],
    ])('refused: %s (400, nothing stored)', async (_label, body) => {
      const res = await apply(body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect((res.body.details as string[]).some((d) => d.startsWith('olympiadInterests'))).toBe(true);
      expect(await ctx.prisma.mentorRequest.count({ where: { username: usernameOf() } })).toBe(0);
    });

    it('approval copies the subjects to the Coach account; they grant nothing', async () => {
      const res = await apply({ olympiadInterests: ['COMPUTING'] }).expect(201);
      await http().patch(`/api/v1/mentor-requests/${res.body.id}/approve`).set(bearer(admin)).expect(200);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: usernameOf() } });
      expect(user).toMatchObject({ role: 'MENTOR', olympiadInterests: ['COMPUTING'] });
      // No course × division assignment comes with an interest: the new coach can mark nothing.
      expect(await ctx.prisma.mentorAssignment.count({ where: { mentorId: user.id } })).toBe(0);
    });
  });

  describe('a coach and their own interests', () => {
    it('an existing coach without interests still signs in; the profile says none (nothing filled in)', async () => {
      const me = (await http().get('/api/v1/me').set(bearer(coach)).expect(200)).body;
      expect(me).toMatchObject({ role: 'MENTOR', olympiadInterests: [] });
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: otherCoachId } })).olympiadInterests).toEqual([]);
    });

    it('a coach edits their own: stored in the fixed order, at least one, no invalid or duplicate values', async () => {
      const ok = await http().patch('/api/v1/me').set(bearer(coach)).send({ olympiadInterests: ['PHYSICS', 'MATHEMATICS'] }).expect(200);
      expect(ok.body.olympiadInterests).toEqual(['MATHEMATICS', 'PHYSICS']);
      for (const bad of [[], ['CHEMISTRY'], ['PHYSICS', 'PHYSICS']]) {
        const res = await http().patch('/api/v1/me').set(bearer(coach)).send({ olympiadInterests: bad }).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.mentorJunior } })).olympiadInterests).toEqual(['MATHEMATICS', 'PHYSICS']);
    });

    it('they persist after signing out and in again', async () => {
      await http().post('/api/v1/auth/logout').set(bearer(coach)).send({}).expect(200);
      coach = await login(ctx, 'mentor.j');
      expect((await http().get('/api/v1/me').set(bearer(coach)).expect(200)).body.olympiadInterests).toEqual(['MATHEMATICS', 'PHYSICS']);
    });

    it('a coach cannot edit the interests of another coach', async () => {
      await http().patch(`/api/v1/admin/users/${otherCoachId}`).set(bearer(coach)).send({ olympiadInterests: ['MATHEMATICS'] }).expect(403);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: otherCoachId } })).olympiadInterests).toEqual([]);
    });

    it('interests never change what a coach may do', async () => {
      const before = (await http().get('/api/v1/me/permissions').set(bearer(coach)).expect(200)).body;
      await http().patch('/api/v1/me').set(bearer(coach)).send({ olympiadInterests: ['MATHEMATICS', 'COMPUTING', 'PHYSICS'] }).expect(200);
      const after = (await http().get('/api/v1/me/permissions').set(bearer(coach)).expect(200)).body;
      expect(after).toEqual(before);
      // mentor.j is assigned to Algebra × Junior only: still no access to the senior division's work.
      const assignments = await ctx.prisma.mentorAssignment.findMany({ where: { mentorId: ctx.ids.mentorJunior, isActive: true }, select: { courseId: true, divisionId: true } });
      expect(assignments).toEqual([{ courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }]);
    });
  });

  describe('Administrators', () => {
    it('an Administrator edits the interests of a coach; the change is audited; the list and detail show them', async () => {
      const res = await http().patch(`/api/v1/admin/users/${otherCoachId}`).set(bearer(admin)).send({ olympiadInterests: ['PHYSICS', 'COMPUTING'] }).expect(200);
      expect(res.body.olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE_USER', entityId: otherCoachId }, orderBy: { createdAt: 'desc' } });
      expect(audit.metadata).toMatchObject({ changes: { olympiadInterests: { from: [], to: ['COMPUTING', 'PHYSICS'] } } });
      expect((await http().get(`/api/v1/admin/users/${otherCoachId}`).set(bearer(admin)).expect(200)).body.olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
      const list = (await http().get('/api/v1/admin/users').query({ role: 'MENTOR', limit: 100 }).set(bearer(admin)).expect(200)).body.data;
      expect(list.find((u: { id: string }) => u.id === otherCoachId).olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
      // The coach sees the Administrator's change.
      const own = await login(ctx, 'mentor.s');
      expect((await http().get('/api/v1/me').set(bearer(own)).expect(200)).body.olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
    });

    it('at least one subject, no invalid or duplicate values', async () => {
      for (const bad of [[], ['CHEMISTRY'], ['MATHEMATICS', 'MATHEMATICS']]) {
        const res = await http().patch(`/api/v1/admin/users/${otherCoachId}`).set(bearer(admin)).send({ olympiadInterests: bad }).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: otherCoachId } })).olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
    });

    it('Coach accounts only (400 INTERESTS_COACH_ONLY); other edits never touch the interests of a coach', async () => {
      const student = await http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).send({ olympiadInterests: ['MATHEMATICS'] }).expect(400);
      expect(student.body.code).toBe('INTERESTS_COACH_ONLY');
      const change = await http().patch(`/api/v1/admin/users/${otherCoachId}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S1', olympiadInterests: ['MATHEMATICS'] }).expect(400);
      expect(change.body.code).toBe('INTERESTS_COACH_ONLY');
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: otherCoachId } })).role).toBe('MENTOR');
      // A coach without interests: a name change keeps them empty (never filled in automatically).
      const renamed = await http().patch(`/api/v1/admin/users/${ctx.ids.mentorJunior2}`).set(bearer(admin)).send({ firstName: 'Renamed' }).expect(200);
      expect(renamed.body).toMatchObject({ firstName: 'Renamed', olympiadInterests: [] });
    });

    it.each([
      ['a Student', 'student.j'],
      ['a Coach', 'mentor.j2'],
      ['a Teacher', 'ci.teacher'],
      ['a Head Coach', 'ci.head'],
    ])('%s cannot edit the interests of a coach (403)', async (_label, username) => {
      const token = await login(ctx, username, PASSWORD);
      await http().patch(`/api/v1/admin/users/${otherCoachId}`).set(bearer(token)).send({ olympiadInterests: ['MATHEMATICS'] }).expect(403);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: otherCoachId } })).olympiadInterests).toEqual(['COMPUTING', 'PHYSICS']);
    });

    it('anonymous: 401', async () => {
      await http().patch(`/api/v1/admin/users/${otherCoachId}`).send({ olympiadInterests: ['MATHEMATICS'] }).expect(401);
    });
  });
});
