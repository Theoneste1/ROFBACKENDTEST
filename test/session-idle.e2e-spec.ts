/**
 * Sessions end after 60 minutes without user activity (owner 2026-11-28), enforced by the server as well as the browser:
 *  - sign-in starts the session's activity clock; POST /auth/activity (the browser's report of clicks, typing, scrolling,
 *    touch) moves it forward; a refresh never does (background refreshes cannot keep a session alive);
 *  - past the limit (60 min + 2 min for reports in transit) a refresh is refused with 401 SESSION_IDLE_EXPIRED and the
 *    session is revoked; an activity report cannot revive it;
 *  - an access token never outlives the session's inactivity deadline;
 *  - activity reports only move the reporting user's own session.
 * "Time passing" is simulated by moving the stored activity time back (no clock mocking in the server).
 */
import { createHash } from 'crypto';
import { PASSWORD, createTestApp, type TestContext } from './helpers.js';
import { SESSION_IDLE_LIMIT_MS } from '../src/auth/token.service.js';

const minutes = (m: number) => m * 60_000;

describe('Session inactivity (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('rof_refresh='))!.split(';')[0];

  const signIn = async (username = 'student.j') => {
    const res = await http().post('/api/v1/auth/login').send({ username, password: PASSWORD }).expect(200);
    return { access: res.body.access_token as string, refresh: res.body.refresh_token as string, cookie: cookieOf(res), expiresIn: res.body.expires_in as number };
  };
  const row = (raw: string) => ctx.prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hash(raw) } });
  /** Pretend the person's last activity was `ago` ms ago (the whole session: every token of the family). */
  const idleFor = async (raw: string, ago: number) => {
    const { familyId } = await row(raw);
    await ctx.prisma.refreshToken.updateMany({ where: { familyId }, data: { lastActivityAt: new Date(Date.now() - ago) } });
  };
  const refresh = (cookie: string) => http().post('/api/v1/auth/refresh').set('Cookie', cookie).send({});
  const activity = (access: string, cookie: string) => http().post('/api/v1/auth/activity').set('Authorization', `Bearer ${access}`).set('Cookie', cookie).send({});
  const familyLive = async (raw: string) => ctx.prisma.refreshToken.count({ where: { familyId: (await row(raw)).familyId, revokedAt: null } });

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx?.app.close(); });

  it('sign-in starts the clock: the token row records the activity time; a normal 15-minute access token', async () => {
    const before = Date.now();
    const s = await signIn();
    const r = await row(s.refresh);
    expect(r.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(r.lastActivityAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(s.expiresIn).toBe(900);
  });

  it('a refresh is NOT activity: the new token keeps the old activity time, and its access token ends at the inactivity deadline', async () => {
    const s = await signIn();
    await idleFor(s.refresh, minutes(50));
    const lastActivity = (await row(s.refresh)).lastActivityAt!;
    const r = await refresh(s.cookie).expect(200);
    const next = await row(r.body.refresh_token);
    expect(next.lastActivityAt!.toISOString()).toBe(lastActivity.toISOString());
    // 50 of 62 minutes used: the access token lasts at most the 12 minutes left, not 15.
    expect(r.body.expires_in).toBeLessThanOrEqual(12 * 60);
    expect(r.body.expires_in).toBeGreaterThan(11 * 60);
    const claims = JSON.parse(Buffer.from(r.body.access_token.split('.')[1], 'base64url').toString());
    expect(claims.exp * 1000).toBeLessThanOrEqual(lastActivity.getTime() + SESSION_IDLE_LIMIT_MS + 1000);
  });

  it('activity moves the deadline forward (the current token of the session), and a later refresh carries it', async () => {
    const s = await signIn();
    await idleFor(s.refresh, minutes(40));
    const res = await activity(s.access, s.cookie).expect(200);
    expect(res.body.idleTimeoutMinutes).toBe(60);
    expect(new Date(res.body.idleDeadline).getTime()).toBeGreaterThan(Date.now() + minutes(61));
    expect((await row(s.refresh)).lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
    const r = await refresh(s.cookie).expect(200);
    expect(r.body.expires_in).toBe(900);
    expect((await row(r.body.refresh_token)).lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('past the limit, a refresh is refused with SESSION_IDLE_EXPIRED and the whole session is revoked', async () => {
    const s = await signIn();
    await idleFor(s.refresh, SESSION_IDLE_LIMIT_MS + 1000);
    const r = await refresh(s.cookie).expect(401);
    expect(r.body.code).toBe('SESSION_IDLE_EXPIRED');
    expect(r.body.message).toBe('You were signed out after 60 minutes without activity. Please sign in again.');
    expect(await familyLive(s.refresh)).toBe(0);
    // Nothing brings it back: the cookie again, or an activity report.
    expect((await refresh(s.cookie)).status).toBe(401);
    expect((await activity(s.access, s.cookie)).status).toBe(401);
  });

  it('just inside the limit (61.5 minutes, the 2-minute allowance for reports in transit), a refresh works but its access token ends with the session', async () => {
    const s = await signIn();
    await idleFor(s.refresh, minutes(61.5));
    const r = await refresh(s.cookie).expect(200);
    expect(r.body.expires_in).toBeLessThanOrEqual(31);
    expect(r.body.expires_in).toBeGreaterThanOrEqual(1);
  });

  it('an activity report cannot revive an expired session: 401 SESSION_IDLE_EXPIRED, the session is revoked', async () => {
    const s = await signIn();
    await idleFor(s.refresh, SESSION_IDLE_LIMIT_MS + 1000);
    const res = await activity(s.access, s.cookie).expect(401);
    expect(res.body.code).toBe('SESSION_IDLE_EXPIRED');
    expect(await familyLive(s.refresh)).toBe(0);
    expect((await refresh(s.cookie)).status).toBe(401);
  });

  it('activity only moves the reporter\'s own session: another person\'s cookie is refused and left untouched', async () => {
    const mine = await signIn('student.j');
    const theirs = await signIn('student.s');
    await idleFor(theirs.refresh, minutes(30));
    const before = (await row(theirs.refresh)).lastActivityAt!.toISOString();
    const res = await activity(mine.access, theirs.cookie).expect(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    expect((await row(theirs.refresh)).lastActivityAt!.toISOString()).toBe(before);
    // Without a session cookie at all: refused too.
    expect((await http().post('/api/v1/auth/activity').set('Authorization', `Bearer ${mine.access}`).send({})).status).toBe(401);
    // Without an access token: refused (the route is for signed-in users).
    expect((await http().post('/api/v1/auth/activity').set('Cookie', mine.cookie).send({})).status).toBe(401);
  });

  it('a tab that has not seen the new cookie yet (rotated seconds ago) still reports for its session; a long-replaced token does not', async () => {
    const s = await signIn();
    await idleFor(s.refresh, minutes(20));
    const r = await refresh(s.cookie).expect(200);
    await activity(s.access, s.cookie).expect(200);   // the OLD cookie, rotated just now
    expect((await row(r.body.refresh_token)).lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
    // The same old token, replaced two minutes ago: refused, and the session is not moved.
    await ctx.prisma.refreshToken.update({ where: { tokenHash: hash(s.refresh) }, data: { rotatedAt: new Date(Date.now() - minutes(2)) } });
    await idleFor(r.body.refresh_token, minutes(10));
    const before = (await row(r.body.refresh_token)).lastActivityAt!.toISOString();
    expect((await activity(s.access, s.cookie)).status).toBe(401);
    expect((await row(r.body.refresh_token)).lastActivityAt!.toISOString()).toBe(before);
  });

  it('tokens issued before this change (no activity time): their issue time counts', async () => {
    const fresh = await signIn();
    await ctx.prisma.refreshToken.update({ where: { tokenHash: hash(fresh.refresh) }, data: { lastActivityAt: null, createdAt: new Date(Date.now() - minutes(10)) } });
    const ok = await refresh(fresh.cookie).expect(200);
    expect((await row(ok.body.refresh_token)).lastActivityAt!.getTime()).toBeLessThan(Date.now() - minutes(9));

    const old = await signIn();
    await ctx.prisma.refreshToken.update({ where: { tokenHash: hash(old.refresh) }, data: { lastActivityAt: null, createdAt: new Date(Date.now() - SESSION_IDLE_LIMIT_MS - 1000) } });
    expect((await refresh(old.cookie).expect(401)).body.code).toBe('SESSION_IDLE_EXPIRED');
  });

  it('logout still ends the session at once (activity and refresh refused afterwards)', async () => {
    const s = await signIn();
    await http().post('/api/v1/auth/logout').set('Cookie', s.cookie).set('Authorization', `Bearer ${s.access}`).send({}).expect(200);
    expect((await refresh(s.cookie)).status).toBe(401);
    expect((await activity(s.access, s.cookie)).status).toBe(401);
  });
});
