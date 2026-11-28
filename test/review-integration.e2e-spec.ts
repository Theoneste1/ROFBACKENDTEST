/**
 * Independent review 2026-11-28 — cross-feature integration of BE #121-#126 (run on the combined branch).
 *  1. #124 session inactivity × #126 refresh returns the profile: the merged refresh both caps the access token at the
 *     inactivity deadline and returns the profile; an idle-expired refresh returns no profile.
 *  2. #125 Super Admin privacy × #126: a Super Administrator's OWN refresh returns their real role and name (sign-in
 *     routes are never masked), and their activity report works.
 *  3. #124 × #123 question-level marking: claim, heartbeat and save are background work — they never move the session's
 *     activity time, so a coach's marking tab cannot keep a session alive without the person.
 *  4. #125 × #123: a Super Administrator's question-marking actions (wording correction, approval) are shown to the Head
 *     Coach and Administrators as "ROF Administration" — never their username, name, e-mail or role.
 */
import { createHash, randomUUID } from 'crypto';
import { createTestApp, login, bearer, PASSWORD, PDF, type TestContext } from './helpers.js';
import { SESSION_IDLE_LIMIT_MS } from '../src/auth/token.service.js';

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Review 2026-11-28: cross-feature integration', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    ((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('rof_refresh='))!.split(';')[0];
  const signIn = async (username: string) => {
    const res = await http().post('/api/v1/auth/login').send({ username, password: PASSWORD }).expect(200);
    return { access: res.body.access_token as string, refresh: res.body.refresh_token as string, cookie: cookieOf(res) };
  };
  const row = (raw: string) => p().refreshToken.findUniqueOrThrow({ where: { tokenHash: hash(raw) } });
  const idleFor = async (raw: string, agoMs: number) => {
    const { familyId } = await row(raw);
    await p().refreshToken.updateMany({ where: { familyId }, data: { lastActivityAt: new Date(Date.now() - agoMs) } });
  };

  const T = '/api/v1/admin/tests';
  const MT = '/api/v1/marking/tasks';
  const QM = (id: string) => `${T}/${id}/question-marking`;
  let admin: string, hm: string, sa: string, sj: string;
  let maths: string, coachId: string, saId: string;

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    process.env.QUESTION_MARKING_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const pw = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'MENTOR' | 'SUPER_ADMIN', firstName = username, lastName = 'Review') =>
      (await p().user.create({ data: { username, firstName, lastName, email: `${username}@test.local`, role, passwordHash: pw, activatedAt: new Date() } })).id;
    const hmId = await mk('ri.head', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    saId = await mk('ri.super', 'SUPER_ADMIN', 'Gracieuse', 'Secretowner');
    coachId = await mk('ri.coach', 'MENTOR');
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'ri.head');
    sa = await login(ctx, 'ri.super');
    sj = await login(ctx, 'student.j');
    await http().post('/api/v1/admin/test-markers').set(bearer(admin)).send({ coachId, subjectId: maths }).expect(201);
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED; delete process.env.TEACHERS_ENABLED; delete process.env.QUESTION_MARKING_ENABLED;
    await ctx?.app.close();
  });

  it('#124 × #126: the refresh caps the access token at the inactivity deadline AND returns the profile; an expired one returns neither', async () => {
    const s = await signIn('student.j');
    await idleFor(s.refresh, 50 * 60_000);
    const r = await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).send({}).expect(200);
    expect(r.body.expires_in).toBeLessThanOrEqual(12 * 60);
    expect(r.body.user).toMatchObject({ username: 'student.j', role: 'STUDENT' });
    expect(r.body.permissions.permissions.length).toBeGreaterThan(0);
    const me = await http().get('/api/v1/me').set('Authorization', `Bearer ${r.body.access_token}`).expect(200);
    expect(r.body.user).toEqual(me.body);
    // The refresh did not count as activity.
    expect((await row(r.body.refresh_token)).lastActivityAt!.getTime()).toBeLessThan(Date.now() - 49 * 60_000);
    await idleFor(r.body.refresh_token, SESSION_IDLE_LIMIT_MS + 1000);
    const late = await http().post('/api/v1/auth/refresh').set('Cookie', cookieOf(r)).send({}).expect(401);
    expect(late.body.code).toBe('SESSION_IDLE_EXPIRED');
    expect(late.body.user).toBeUndefined();
    expect(late.body.permissions).toBeUndefined();
  });

  it('#125 × #126 × #124: a Super Administrator\'s own refresh shows their real identity; their activity report works', async () => {
    const s = await signIn('ri.super');
    const r = await http().post('/api/v1/auth/refresh').set('Cookie', s.cookie).send({}).expect(200);
    expect(r.body.user).toMatchObject({ id: saId, username: 'ri.super', role: 'SUPER_ADMIN', firstName: 'Gracieuse' });
    expect(r.body.permissions.role).toBe('SUPER_ADMIN');
    const a = await http().post('/api/v1/auth/activity').set('Authorization', `Bearer ${r.body.access_token}`).set('Cookie', cookieOf(r)).send({}).expect(200);
    expect(a.body.idleTimeoutMinutes).toBe(60);
  });

  /** A published QUESTION-mode test with one answer, deadline passed, tasks generated; the coach marks question 1. */
  const readyTest = async (title: string) => {
    const res = await http().post(T).set(bearer(admin)).send({
      title, subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10,
      questions: [{ prompt: 'Question 1', maxMarks: 5 }, { prompt: 'Question 2', maxMarks: 5 }],
    }).expect(201);
    const id = res.body.id as string;
    await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'guide.pdf').expect(200);
    await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200);
    await http().patch(`${QM(id)}/mode`).set(bearer(hm)).send({ mode: 'QUESTION' }).expect(200);
    const qs = (await p().testQuestion.findMany({ where: { testId: id }, orderBy: { order: 'asc' } })).map((q) => q.id);
    for (const q of qs) await http().put(`${QM(id)}/questions/${q}/markers`).set(bearer(hm)).send({ add: [coachId], remove: [] }).expect(200);
    await http().post(`/api/v1/me/tests/${id}/submission`).set(bearer(sj)).send({ clientKey: randomUUID(), typedAnswer: 'My answers' }).expect(201);
    await p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
    await http().post(`${QM(id)}/tasks/generate`).set(bearer(hm)).send({}).expect(200);
    const code = (await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: id, studentId: ctx.ids.studentJunior } } })).publicCode;
    return { id, qs, code };
  };

  it('#124 × #123: claiming, heartbeats and saving marks never move the session\'s activity time (background work)', async () => {
    const { code } = await readyTest('Review idle × marking');
    const s = await signIn('ri.coach');
    await idleFor(s.refresh, 30 * 60_000);
    const before = (await row(s.refresh)).lastActivityAt!.getTime();
    const auth = { Authorization: `Bearer ${s.access}` };
    await http().post(`${MT}/${code}/q1/claim`).set(auth).send({}).expect(200);
    await http().post(`${MT}/${code}/q1/heartbeat`).set(auth).send({}).expect(200);
    await http().put(`${MT}/${code}/q1/marks`).set(auth).send({ marks: 3 }).expect(200);
    await http().get(`${MT}/${code}/q1`).set(auth).expect(200);
    expect((await row(s.refresh)).lastActivityAt!.getTime()).toBe(before);
    // The person's own activity report is what moves it.
    await http().post('/api/v1/auth/activity').set(auth).set('Cookie', s.cookie).send({}).expect(200);
    expect((await row(s.refresh)).lastActivityAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
    await http().post(`${MT}/${code}/q1/release`).set(auth).send({}).expect(200);
  });

  it('#125 × #123: a Super Administrator\'s wording correction and approval appear as "ROF Administration" to the Head Coach and Administrators', async () => {
    const { id, qs, code } = await readyTest('Review privacy × marking');
    const coach = await login(ctx, 'ri.coach');
    await http().post(`${MT}/${code}/q1/claim`).set(bearer(coach)).send({}).expect(200);
    await http().post(`${MT}/${code}/q1/submit`).set(bearer(coach)).send({ marks: 4 }).expect(200);
    const t1 = (await p().testQuestionTask.findFirstOrThrow({ where: { questionId: qs[0], round: 'FIRST', cycle: 0 } })).id;
    await http().post(`${QM(id)}/tasks/${t1}/approve`).set(bearer(sa)).send({}).expect(200);
    await http().post(`${QM(id)}/questions/${qs[1]}/wording-correction`).set(bearer(sa)).send({ prompt: 'Question 2 (corrected)', reason: 'Typo' }).expect(200);

    const leaks = (body: unknown) => {
      const text = JSON.stringify(body);
      return ['ri.super', 'Gracieuse', 'Secretowner', 'ri.super@test.local', 'SUPER_ADMIN'].filter((s) => text.includes(s));
    };
    const views = [
      ['history', `${QM(id)}/history`], ['task', `${QM(id)}/tasks/${t1}`], ['tasks', `${QM(id)}/tasks`], ['overview', QM(id)],
    ] as const;
    for (const [who, token] of [['head coach', hm], ['admin', admin]] as const) {
      for (const [name, url] of views) {
        const r = await http().get(url).set(bearer(token)).expect(200);
        expect({ who, name, leaks: leaks(r.body) }).toEqual({ who, name, leaks: [] });
      }
      // The Super Administrator's approval is shown — attributed neutrally, not dropped.
      const detail = await http().get(`${QM(id)}/tasks/${t1}`).set(bearer(token)).expect(200);
      const byAdmin = JSON.stringify(detail.body).match(/"actorRole":"ADMIN"[^}]*"actor":\{[^}]*\}|"actor":\{[^}]*"firstName":"ROF","lastName":"Administration"[^}]*\}/g) ?? [];
      expect({ who, neutral: byAdmin.length > 0 }).toEqual({ who, neutral: true });
    }
    // A Super Administrator sees the real attribution.
    const own = await http().get(`${QM(id)}/tasks/${t1}`).set(bearer(sa)).expect(200);
    expect(JSON.stringify(own.body)).toMatch(/Gracieuse/);
    expect(JSON.stringify(own.body)).toContain('SUPER_ADMIN');
  });
});
