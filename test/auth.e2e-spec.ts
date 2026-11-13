import { createHash } from 'crypto';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Authentication (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  const register = (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/auth/register/student').send({
      firstName: 'Ada', lastName: 'Uwase', username: 'ada', email: 'Ada@Example.com',
      password: 'Secret123', gradeLevel: 'S4', schoolName: '  lycée de kigali ',
      schoolLocation: 'kigali', homeLocation: 'kigali', ...body,
    });

  it('registers a student into the division matching their grade', async () => {
    const res = await register({}).expect(201);
    expect(res.body).toMatchObject({
      username: 'ada', email: 'ada@example.com', role: 'STUDENT', gradeLevel: 'S4',
      division: { code: 'SENIOR' }, school: { name: 'Lycée De Kigali' },
    });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('refuses a taken username or email with one generic message', async () => {
    const res = await register({ username: 'ada2' }).expect(409);
    expect(res.body.code).toBe('IDENTITY_TAKEN');
  });

  it('respects the self-signup setting', async () => {
    const admin = await login(ctx, 'admin');
    await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin))
      .send({ 'registration.studentSelfSignup': false }).expect(200);
    const res = await register({ username: 'bob', email: 'bob@example.com' }).expect(403);
    expect(res.body.code).toBe('REGISTRATION_CLOSED');
    await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin))
      .send({ 'registration.studentSelfSignup': true }).expect(200);
  });

  it('logs in by username or e-mail, case-insensitively', async () => {
    await login(ctx, 'ADA', 'Secret123');
    await login(ctx, 'ada@example.com', 'Secret123');
    const bad = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'wrong123' }).expect(401);
    expect(bad.body.message).toBe('Invalid username or password.');
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const first = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
    expect(first.headers['set-cookie']?.[0]).toContain('HttpOnly');

    const second = await ctx.http().post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refresh_token }).expect(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);

    // Replaying the old token revokes the whole session family…
    const replay = await ctx.http().post('/api/v1/auth/refresh')
      .send({ refreshToken: first.body.refresh_token }).expect(401);
    expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

    // …including the token issued by the legitimate refresh.
    await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: second.body.refresh_token }).expect(401);
  });

  it('logout invalidates the access token immediately', async () => {
    const token = await login(ctx, 'ada', 'Secret123');
    await ctx.http().get('/api/v1/me').set(bearer(token)).expect(200);
    await ctx.http().post('/api/v1/auth/logout').set(bearer(token)).send({}).expect(200);
    await ctx.http().get('/api/v1/me').set(bearer(token)).expect(401);
  });

  describe('logout works without a valid access token (H1)', () => {
    const cookieOf = (res: { headers: Record<string, unknown> }) =>
      ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('rof_refresh='))!.split(';')[0];
    const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

    it('logout with only the refresh cookie (expired or garbage access token) revokes the session; the cookie cannot be reused', async () => {
      const session = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
      const cookie = cookieOf(session);

      const out = await ctx.http().post('/api/v1/auth/logout').set('Cookie', cookie)
        .set('Authorization', 'Bearer expired.or.garbage').send({}).expect(200);
      expect(out.body).toEqual({ message: 'Logged out successfully.' });
      // The cookie is cleared with the attributes it was set with.
      const cleared = (out.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rof_refresh='))!;
      expect(cleared).toMatch(/^rof_refresh=;/);
      expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
      expect(cleared).toMatch(/HttpOnly/);
      expect(cleared).toMatch(/SameSite=Strict/);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

      // Shared device: the next person reloads -> the old cookie is refused.
      const reuse = await ctx.http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
      expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
      expect(await ctx.prisma.refreshToken.count({ where: { tokenHash: sha256(session.body.refresh_token), revokedAt: null } })).toBe(0);
    });

    it('logout with no Authorization header at all still revokes the session and is audited', async () => {
      const session = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
      const before = await ctx.prisma.auditLog.count({ where: { action: 'LOGOUT' } });
      await ctx.http().post('/api/v1/auth/logout').set('Cookie', cookieOf(session)).send({}).expect(200);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'LOGOUT' } })).toBe(before + 1);
      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: session.body.refresh_token }).expect(401);
    });

    it('logout with a still-valid access token blacklists it as well', async () => {
      const session = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
      await ctx.http().post('/api/v1/auth/logout').set(bearer(session.body.access_token))
        .send({ refreshToken: session.body.refresh_token }).expect(200);
      await ctx.http().get('/api/v1/me').set(bearer(session.body.access_token)).expect(401);
      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: session.body.refresh_token }).expect(401);
    });

    it('logout with an already-rotated token still ends the whole session (the newer token too)', async () => {
      const first = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
      const second = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: first.body.refresh_token }).expect(200);
      await ctx.http().post('/api/v1/auth/logout').send({ refreshToken: first.body.refresh_token }).expect(200);
      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: second.body.refresh_token }).expect(401);
    });

    it('logout ends only its own session; other devices stay signed in', async () => {
      const here = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
      const there = await ctx.http().post('/api/v1/auth/login').send({ username: 'ada', password: 'Secret123' }).expect(200);
      await ctx.http().post('/api/v1/auth/logout').send({ refreshToken: here.body.refresh_token }).expect(200);
      await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: there.body.refresh_token }).expect(200);
    });

    it('logout with nothing to revoke answers 200 (idempotent) and writes no audit entry', async () => {
      const before = await ctx.prisma.auditLog.count({ where: { action: 'LOGOUT' } });
      await ctx.http().post('/api/v1/auth/logout').send({}).expect(200);
      await ctx.http().post('/api/v1/auth/logout').send({ refreshToken: 'x'.repeat(64) }).expect(200);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'LOGOUT' } })).toBe(before);
    });

    it('logout-all and password change still require a valid access token', async () => {
      await ctx.http().post('/api/v1/auth/logout-all').expect(401);
      await ctx.http().patch('/api/v1/auth/password').send({ currentPassword: 'Secret123', newPassword: 'Changed123' }).expect(401);
    });
  });

  it('suspending an account cuts off existing tokens', async () => {
    const admin = await login(ctx, 'admin');
    const token = await login(ctx, 'student.j2');
    await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}/status`).set(bearer(admin))
      .send({ isActive: false }).expect(200);
    await ctx.http().get('/api/v1/me').set(bearer(token)).expect(401);

    const res = await ctx.http().post('/api/v1/auth/login').send({ username: 'student.j2', password: PASSWORD }).expect(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');

    await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}/status`).set(bearer(admin))
      .send({ isActive: true }).expect(200);
  });

  it('password reset: generic response, single-use token, old sessions revoked', async () => {
    const generic = await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.com' }).expect(200);
    const real    = await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'ada@example.com' }).expect(200);
    expect(real.body).toEqual(generic.body);

    // The e-mail carrying the link is queued in the outbox.
    const mail = await ctx.prisma.emailDelivery.findFirstOrThrow({
      where: { recipientEmail: 'ada@example.com' }, orderBy: { createdAt: 'desc' },
    });
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.body!)![1]);
    expect(await ctx.prisma.passwordResetToken.count({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    })).toBe(1);

    await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'NewSecret456' }).expect(200);
    const again = await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Other789xyz' }).expect(400);
    expect(again.body.code).toBe('INVALID_RESET_TOKEN');

    await login(ctx, 'ada', 'NewSecret456');
  });

  it('change password requires the current password', async () => {
    const token = await login(ctx, 'ada', 'NewSecret456');
    const bad = await ctx.http().patch('/api/v1/auth/password').set(bearer(token))
      .send({ currentPassword: 'wrong', newPassword: 'Another123' }).expect(400);
    expect(bad.body.code).toBe('WRONG_PASSWORD');
    await ctx.http().patch('/api/v1/auth/password').set(bearer(token))
      .send({ currentPassword: 'NewSecret456', newPassword: 'Another123' }).expect(200);
  });

  it('only admins can create admins', async () => {
    const student = await login(ctx, 'student.j');
    await ctx.http().post('/api/v1/auth/register/admin').set(bearer(student))
      .send({ firstName: 'X', lastName: 'Y', username: 'evil', email: 'evil@x.com', password: 'Secret123' }).expect(403);
  });

  it('mentor application → approval creates a mentor who can log in', async () => {
    const apply = await ctx.http().post('/api/v1/mentor-requests')
      .send({ firstName: 'Marie', lastName: 'Ingabire', username: 'marie', email: 'marie@example.com', password: 'Mentor123' })
      .expect(201);
    expect(apply.body.passwordHash).toBeUndefined();

    const admin = await login(ctx, 'admin');
    await ctx.http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(200);
    const twice = await ctx.http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(409);
    expect(twice.body.code).toBe('INVALID_STATE_TRANSITION');

    const stored = await ctx.prisma.mentorRequest.findUniqueOrThrow({ where: { id: apply.body.id } });
    expect(stored.passwordHash).toBeNull();

    await login(ctx, 'marie', 'Mentor123');
  });
});
