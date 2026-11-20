/**
 * Gender step (capability genderStep; owner, 2026-11-20): accounts from before gender was asked at sign-up give it once.
 * GET /me carries genderRequired (students, teachers, coaches without a gender); PUT /me/gender records it (409 once
 * recorded); an Administrator corrects it with PATCH /admin/users/:id. Audited without the value. Nothing is blocked
 * on the server: the portal asks the question.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Gender step (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const status = async (r: PromiseLike<{ status: number; body: { code?: string } }>) => { const res = await r; return [res.status, res.body.code]; };

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx?.app.close(); });

  it('a student and a coach without a gender are asked once; administrators are not', async () => {
    expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toContain('genderStep');
    const [student, coach, admin] = await Promise.all(['student.j', 'mentor.j', 'admin'].map((u) => login(ctx, u)));
    for (const token of [student, coach]) {
      expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body).toMatchObject({ gender: null, genderRequired: true });
    }
    expect((await http().get('/api/v1/me').set(bearer(admin)).expect(200)).body.genderRequired).toBe(false);
    // Other routes keep working while the question is open (the portal asks it; the server blocks nothing).
    await http().get('/api/v1/me/permissions').set(bearer(student)).expect(200);

    for (const gender of [undefined, 'OTHER', 'male']) {
      expect(await status(http().put('/api/v1/me/gender').set(bearer(student)).send({ gender }))).toEqual([400, 'VALIDATION_FAILED']);
    }
    const done = await http().put('/api/v1/me/gender').set(bearer(student)).send({ gender: 'FEMALE' }).expect(200);
    expect(done.body).toMatchObject({ gender: 'FEMALE', genderRequired: false });
    expect(await status(http().put('/api/v1/me/gender').set(bearer(student)).send({ gender: 'MALE' }))).toEqual([409, 'GENDER_ALREADY_SET']);
    expect((await http().get('/api/v1/me').set(bearer(student)).expect(200)).body).toMatchObject({ gender: 'FEMALE', genderRequired: false });
    await http().put('/api/v1/me/gender').set(bearer(coach)).send({ gender: 'MALE' }).expect(200);
    await http().put('/api/v1/me/gender').send({ gender: 'MALE' }).expect(401);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'GENDER_ADDED', entityId: ctx.ids.studentJunior } });
    expect(audit.metadata).toEqual({ source: 'FIRST_SIGN_IN' });
  });

  it('an Administrator corrects a gender (PATCH /admin/users/:id)', async () => {
    const admin = await login(ctx, 'admin');
    await http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).send({ gender: 'MALE' }).expect(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).gender).toBe('MALE');
    expect(await status(http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).send({ gender: 'X' }))).toEqual([400, 'VALIDATION_FAILED']);
  });
});
