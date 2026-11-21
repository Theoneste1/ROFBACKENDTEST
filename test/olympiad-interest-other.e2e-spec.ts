/**
 * "Other" Olympiad interest (owner, 2026-11-21; capability olympiadInterestOther): beside MATHEMATICS, COMPUTING and
 * PHYSICS a person names another Olympiad in words. Student sign-up, coach application (copied to the Coach account on
 * approval), PATCH /me, PATCH /admin/users/:id (coaches; audited). "Other" alone counts; null clears it only beside a
 * subject; 2–100 characters. Never a subject: no marking, no membership.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('"Other" Olympiad interest (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();
  let n = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    await ctx.prisma.school.create({ data: {
      name: 'GS OTHER INTEREST', location: 'Huye', code: '310998', district: 'Huye', sector: 'Ngoma', ownership: 'PUBLIC', nameKey: 'gs other interest',
    } });
  });
  afterAll(async () => { await ctx?.app.close(); });

  const register = (body: Record<string, unknown>) => {
    n += 1;
    return http().post('/api/v1/auth/register/student').send({
      firstName: 'Olga', lastName: 'Other', username: `oo.s${n}`, email: `oo.s${n}@example.com`, password: 'Secret123',
      dateOfBirth: '2010-05-01', gender: 'FEMALE', homeCountry: 'UG', guardianPhone: '0722000111', gradeLevel: 'S3',
      schoolCode: '310998', homeLocation: 'Huye', ...body,
    });
  };
  const apply = (body: Record<string, unknown>) => {
    n += 1;
    return http().post('/api/v1/mentor-requests').send({
      firstName: 'Omar', lastName: 'Other', username: `oo.c${n}`, email: `oo.c${n}@test.local`, password: 'Mentor123', gender: 'MALE', country: 'KE', ...body,
    });
  };

  it('the capability is announced', async () => {
    expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toContain('olympiadInterestOther');
  });

  it('student sign-up: "Other" alone, or beside subjects; trimmed; returned on the profile', async () => {
    const alone = await register({ olympiadInterests: [], olympiadInterestOther: '  Chemistry ' }).expect(201);
    expect(alone.body).toMatchObject({ olympiadInterests: [], olympiadInterestOther: 'Chemistry' });
    const both = await register({ olympiadInterests: ['PHYSICS'], olympiadInterestOther: 'Astronomy' }).expect(201);
    expect(both.body).toMatchObject({ olympiadInterests: ['PHYSICS'], olympiadInterestOther: 'Astronomy' });
    const plain = await register({ olympiadInterests: ['MATHEMATICS'] }).expect(201);
    expect(plain.body.olympiadInterestOther).toBeNull();
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: alone.body.username } })).olympiadInterestOther).toBe('Chemistry');
  });

  it('refused: no subject and no other; other too short or too long; a fourth "subject"; nothing created', async () => {
    for (const bad of [
      { olympiadInterests: [] }, { olympiadInterests: [], olympiadInterestOther: ' ' }, { olympiadInterestOther: 'C' },
      { olympiadInterestOther: 'x'.repeat(101) }, { olympiadInterests: ['CHEMISTRY'] }, { olympiadInterestOther: null },
    ]) {
      const username = `oo.bad${++n}`;
      const res = await register({ username, email: `${username}@example.com`, ...bad }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await ctx.prisma.user.count({ where: { username } })).toBe(0);
    }
  });

  it('coach application: "Other" alone is accepted; approval copies it to the Coach account; it grants nothing', async () => {
    const res = await apply({ olympiadInterests: [], olympiadInterestOther: 'Biology' }).expect(201);
    const request = await ctx.prisma.mentorRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(request).toMatchObject({ olympiadInterests: [], olympiadInterestOther: 'Biology' });
    const listed = (await http().get('/api/v1/mentor-requests').query({ status: 'PENDING', limit: 100 }).set(bearer(admin)).expect(200)).body.data;
    expect(listed.find((r: { id: string }) => r.id === res.body.id).olympiadInterestOther).toBe('Biology');
    await http().patch(`/api/v1/mentor-requests/${res.body.id}/approve`).set(bearer(admin)).expect(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: `oo.c${n}` } });
    expect(user).toMatchObject({ role: 'MENTOR', olympiadInterests: [], olympiadInterestOther: 'Biology' });
    expect(await ctx.prisma.mentorAssignment.count({ where: { mentorId: user.id } })).toBe(0);
    expect(await ctx.prisma.markerAuthorization.count({ where: { coachId: user.id } })).toBe(0);
  });

  it('PATCH /me: set, change and clear it (clearing only beside a subject)', async () => {
    const res = await register({ olympiadInterests: ['COMPUTING'] }).expect(201);
    const token = await login(ctx, res.body.username, 'Secret123');
    const set = await http().patch('/api/v1/me').set(bearer(token)).send({ olympiadInterestOther: 'Informatics olympiad (IOI)' }).expect(200);
    expect(set.body).toMatchObject({ olympiadInterests: ['COMPUTING'], olympiadInterestOther: 'Informatics olympiad (IOI)' });
    const onlyOther = await http().patch('/api/v1/me').set(bearer(token)).send({ olympiadInterests: [], olympiadInterestOther: 'Chemistry' }).expect(200);
    expect(onlyOther.body).toMatchObject({ olympiadInterests: [], olympiadInterestOther: 'Chemistry' });
    const refused = await http().patch('/api/v1/me').set(bearer(token)).send({ olympiadInterestOther: null }).expect(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    const cleared = await http().patch('/api/v1/me').set(bearer(token)).send({ olympiadInterests: ['PHYSICS'], olympiadInterestOther: null }).expect(200);
    expect(cleared.body).toMatchObject({ olympiadInterests: ['PHYSICS'], olympiadInterestOther: null });
  });

  it('an Administrator edits a coach\'s other interest; audited; other roles: 400 INTERESTS_COACH_ONLY', async () => {
    const coachId = ctx.ids.mentorSenior;
    const res = await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ olympiadInterestOther: 'Chemistry' }).expect(200);
    expect(res.body.olympiadInterestOther).toBe('Chemistry');
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE_USER', entityId: coachId }, orderBy: { createdAt: 'desc' } });
    expect(audit.metadata).toMatchObject({ changes: { olympiadInterestOther: { from: null, to: 'Chemistry' } } });
    expect((await http().get(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).expect(200)).body.olympiadInterestOther).toBe('Chemistry');
    const student = await http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).send({ olympiadInterestOther: 'Chemistry' }).expect(400);
    expect(student.body.code).toBe('INTERESTS_COACH_ONLY');
  });
});
