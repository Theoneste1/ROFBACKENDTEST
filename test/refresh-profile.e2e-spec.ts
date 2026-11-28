/**
 * A refresh returns the signed-in user's profile with the tokens (performance, 2026-11-28): a page load restores the
 * session and knows the user in ONE round trip instead of two (refresh, then GET /me). The profile is exactly GET /me's
 * — same fields, same steps (dateOfBirthRequired, genderRequired, bankingRequired), never the bank details or any secret.
 */
import { randomBytes } from 'crypto';
import { PASSWORD, createTestApp, completeStaffBankDetails, type TestContext } from './helpers.js';

describe('Refresh returns the profile (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('rof_refresh='))!.split(';')[0];

  beforeAll(async () => { ctx = await createTestApp(); await completeStaffBankDetails(ctx.prisma); });
  afterAll(async () => { await ctx?.app.close(); });

  for (const username of ['student.j', 'mentor.j', 'admin']) {
    it(`${username}: the refreshed profile equals GET /me; no secret, no bank detail`, async () => {
      const login = await http().post('/api/v1/auth/login').send({ username, password: PASSWORD }).expect(200);
      const r = await http().post('/api/v1/auth/refresh').set('Cookie', cookieOf(login)).send({}).expect(200);
      expect(Object.keys(r.body).sort()).toEqual(['access_token', 'expires_in', 'refresh_expires_at', 'refresh_token', 'token_type', 'user']);
      const me = await http().get('/api/v1/me').set('Authorization', `Bearer ${r.body.access_token}`).expect(200);
      expect(r.body.user).toEqual(me.body);
      expect(r.body.user).toMatchObject({ username, dateOfBirthRequired: expect.any(Boolean), genderRequired: expect.any(Boolean), bankingRequired: expect.any(Boolean) });
      const text = JSON.stringify(r.body.user);
      for (const secret of ['passwordHash', 'bankDetails', 'personalAccountNumber', 'tokensValidAfter', 'failedLoginCount']) expect(text).not.toContain(secret);
    });
  }

  it('a refused refresh still answers 401 without any profile', async () => {
    const r = await http().post('/api/v1/auth/refresh').send({ refreshToken: randomBytes(48).toString('base64url') }).expect(401);
    expect(r.body.user).toBeUndefined();
  });
});
