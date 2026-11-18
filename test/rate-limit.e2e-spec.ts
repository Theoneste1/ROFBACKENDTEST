/**
 * Rate limits for schools that share one internet connection (owner approval 2026-11-18), with throttling ON.
 *
 * Every request in this file comes from the same address (127.0.0.1) — a school computer lab. Before: 120 API
 * requests and 30 session refreshes a minute for the whole address. Now: a signed-in user has their own budget, a
 * refresh counts against its token, and a per-address ceiling still bounds the address. Tokens are issued directly
 * (TokenService) so the sign-in limits are not involved there; sign-in has its own block at the end.
 */
process.env.THROTTLE_DISABLED = 'false';   // this file only: the limits are what is tested

import { TokenService } from '../src/auth/token.service.js';
import { REFRESH_IP_LIMIT } from '../src/auth/auth.controller.js';
import { LOGIN_PER_ADDRESS_PER_MINUTE } from '../src/auth/login-limiter.js';
import { createTestApp, PASSWORD, type TestContext } from './helpers.js';

describe('Rate limits for a shared school connection (e2e, throttling on)', () => {
  let ctx: TestContext;
  let students: string[] = [];
  const tokensOf: Record<string, { access_token: string; refresh_token: string }> = {};
  const http = () => ctx.http();

  beforeAll(async () => {
    ctx = await createTestApp();
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const created = await ctx.prisma.user.createManyAndReturn({
      data: Array.from({ length: 40 }, (_, i) => ({
        username: `lab.s${i}`, firstName: 'Lab', lastName: `S${i}`, email: `lab.s${i}@test.local`, role: 'STUDENT' as const,
        passwordHash: hash, activatedAt: new Date(), gradeLevel: 'S2' as const, divisionId: ctx.ids.junior, dateOfBirth: new Date('2011-01-01T00:00:00Z'),
      })),
      select: { id: true },
    });
    students = created.map((u) => u.id);
    const tokens = ctx.app.get(TokenService);
    for (const id of students) tokensOf[id] = await tokens.issue(id, { ip: '127.0.0.1' });
  });
  afterAll(async () => { process.env.THROTTLE_DISABLED = 'true'; await ctx?.app.close(); });

  it('throttling is really on in this file (an unauthenticated address is still limited to 120 a minute)', async () => {
    // Public, unauthenticated: counted per address, as before.
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await http().get('/api/v1/me').set('Authorization', 'Bearer forged.token.value')).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('a class of 40 students on one address: each browses (4 requests) and refreshes once — nobody is refused', async () => {
    const statuses: number[] = [];
    for (const id of students) {
      for (let i = 0; i < 4; i++) statuses.push((await http().get('/api/v1/me').set('Authorization', `Bearer ${tokensOf[id].access_token}`)).status);
    }
    expect(statuses.filter((s) => s !== 200)).toEqual([]);   // 160 requests > the old 120 per address
    const refreshes: number[] = [];
    for (const id of students) {
      const r = await http().post('/api/v1/auth/refresh').send({ refreshToken: tokensOf[id].refresh_token });
      refreshes.push(r.status);
      if (r.status === 200) tokensOf[id] = { access_token: r.body.access_token, refresh_token: r.body.refresh_token };
    }
    expect(refreshes.filter((s) => s !== 200)).toEqual([]);  // 40 refreshes > the old 30 per address
  });

  it('one user is still limited to their own budget (120 a minute)', async () => {
    const id = students[0];
    let first429 = -1;
    for (let i = 0; i < 125 && first429 < 0; i++) {
      if ((await http().get('/api/v1/me').set('Authorization', `Bearer ${tokensOf[id].access_token}`)).status === 429) first429 = i;
    }
    expect(first429).toBeGreaterThan(100);   // 4 used above, + 1 refresh does not count here
    // Another student on the same address is not affected.
    await http().get('/api/v1/me').set('Authorization', `Bearer ${tokensOf[students[1]].access_token}`).expect(200);
  });

  it('refresh: hammering one token is limited per token; invented tokens are bounded by the per-address ceiling', async () => {
    let sameToken429 = 0;
    for (let i = 0; i < 32; i++) if ((await http().post('/api/v1/auth/refresh').send({ refreshToken: 'the-same-invalid-token-value' })).status === 429) sameToken429++;
    expect(sameToken429).toBeGreaterThanOrEqual(2);            // the 31st and 32nd
    const statuses: number[] = [];
    for (let i = 0; i < REFRESH_IP_LIMIT + 5; i++) {
      statuses.push((await http().post('/api/v1/auth/refresh').send({ refreshToken: `invented-${i}-${Math.random()}` })).status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);   // the address ceiling
    expect(statuses.filter((s) => s === 200)).toEqual([]);                  // never a session
  });

  describe('sign-in (owner approval 2026-11-18): 5/min and 20/h per username, 60/min per address, lock per username + address', () => {
    // As production (TRUST_PROXY=1): X-Forwarded-For stands for the client address. Requests above send none (127.0.0.1).
    beforeAll(() => { ctx.app.getHttpAdapter().getInstance().set('trust proxy', 1); });
    const LAB = '192.0.2.40';
    const login = (username: string, password: string, from: string) =>
      http().post('/api/v1/auth/login').set('X-Forwarded-For', from).send({ username, password });

    it('a class of 40 signs in from one school address: nobody is refused (the old limit was 10 a minute)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 40; i++) statuses.push((await login(`lab.s${i}`, PASSWORD, LAB)).status);
      expect(statuses.filter((s) => s !== 200)).toEqual([]);
    });

    it('guesses for one student from several addresses: the 6th attempt in the minute is refused; the school address the student used before is not held (only where client addresses are verified)', async () => {
      // Every attempt counts, successful ones included: lab.s1 signed in once above, so 4 guesses fill the minute.
      for (let i = 1; i <= 4; i++) {
        const r = await login('lab.s1', `guess-${i}`, `198.51.100.${i}`);
        expect(r.status).toBe(401);
        expect(r.body.message).toBe('Invalid username or password.');
      }
      const sixth = await login('lab.s1', 'guess-5', '198.51.100.5');
      expect(sixth.status).toBe(429);
      expect(sixth.body.code).toBe('TOO_MANY_REQUESTS');
      // The right password from an address the student never used waits too (the username window is full)…
      expect((await login('lab.s1', PASSWORD, '198.51.100.99')).status).toBe(429);
      // By default (SIGNIN_TRUSTED_CLIENT_ADDRESS unset) no address is exempt: the school address waits too…
      expect((await login('lab.s1', PASSWORD, LAB)).status).toBe(429);
      // …and where client addresses are verified, the school address the student signed in from earlier is not held.
      process.env.SIGNIN_TRUSTED_CLIENT_ADDRESS = 'true';
      try {
        await login('lab.s1', PASSWORD, LAB).expect(200);
      } finally {
        delete process.env.SIGNIN_TRUSTED_CLIENT_ADDRESS;
      }
    });

    it('an unknown username gets exactly the same answers as a real one', async () => {
      const bodies: { status: number; code?: string; message: string }[] = [];
      for (let i = 1; i <= 6; i++) {
        const r = await login('nobody.at.all', `guess-${i}`, `198.51.101.${i}`);
        bodies.push({ status: r.status, code: r.body.code, message: r.body.message });
      }
      const real: typeof bodies = [];
      for (let i = 1; i <= 6; i++) {
        const r = await login('mentor.j2', `guess-${i}`, `198.51.102.${i}`);   // a real account not used above
        real.push({ status: r.status, code: r.body.code, message: r.body.message });
      }
      expect(bodies).toEqual(real);
      expect(bodies.map((b) => b.status)).toEqual([401, 401, 401, 401, 401, 429]);
    });

    it(`one address trying many accounts: refused after ${LOGIN_PER_ADDRESS_PER_MINUTE} attempts in a minute`, async () => {
      const statuses: number[] = [];
      for (let i = 0; i <= LOGIN_PER_ADDRESS_PER_MINUTE; i++) statuses.push((await login(`sprayed.${i}`, 'Spring2026!', '203.0.113.61')).status);
      expect(statuses.slice(0, LOGIN_PER_ADDRESS_PER_MINUTE).filter((s) => s !== 401)).toEqual([]);
      expect(statuses[LOGIN_PER_ADDRESS_PER_MINUTE]).toBe(429);
      // Another address is unaffected.
      await login('lab.s3', PASSWORD, '203.0.113.62').expect(200);
    });
  });
});
