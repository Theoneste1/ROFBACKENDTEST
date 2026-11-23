/**
 * Test Management, Phase 4 (WS3; owner spec and plan approved 2026-11-19): publication with the Administrators' override,
 * notifications (once), results for students and teachers, internal rankings, reports, G6 withdrawal on unlock,
 * dashboards — and who may do what, on PostgreSQL.
 *
 * Fixtures: Mathematics (seed) and Physics; Head Coach HM heads Mathematics, HP heads Physics. Coaches mentor.j (C1) and
 * mentor.j2 (C2) are AUTHORISED to mark Mathematics. "Test School": student.j (S2) and student.j2 (S3), VERIFIED, with
 * teacher.a. "Other School": student.s (S5), VERIFIED, with teacher.o. "Third School": teacher.x (no students).
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Test Management Phase 4 — publication, results, rankings, dashboards (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, c1: string, sj: string, sj2: string, ss: string, ta: string, to: string, tx: string;
  let maths: string, school: string, other: string;
  let stJ: string, stJ2: string, stS: string, tA: string, tO: string, tX: string, c1Id: string, c2Id: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  const ME = '/api/v1/me/tests';
  const MK = '/api/v1/marking';
  const M = (id: string) => `${T}/${id}/marking`;
  const R = (id: string) => `${T}/${id}/results`;
  const MR = '/api/v1/me/test-results';
  const TR = '/api/v1/teacher/test-results';

  /** A published Mathematics test for every division, open since an hour: questions of 5 and 15 marks (20). */
  const publishedTest = async (title = 'Results round') => {
    const res = await http().post(T).set(bearer(admin)).send({
      title, subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(120),
      maxMarks: 20, questions: [{ prompt: 'Q one', maxMarks: 5 }, { prompt: 'Q two', maxMarks: 15 }],
    }).expect(201);
    await http().post(`${T}/${res.body.id}/publish`).set(bearer(admin)).expect(200);
    return res.body.id as string;
  };
  const closeNow = (id: string) => p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
  const submitTyped = (token: string, id: string, text: string) =>
    http().post(`${ME}/${id}/submission`).set(bearer(token)).send({ clientKey: randomUUID(), typedAnswer: text }).expect(201);
  const subOf = (testId: string, studentId: string) => p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId } } });
  const questionsOf = async (testId: string) => (await p().testQuestion.findMany({ where: { testId }, orderBy: { order: 'asc' } })).map((q) => q.id);
  const marks = (q: string[], a: number, b: number, c1Comment: string | null = null, overall: string | null = null) =>
    ({ scores: [{ questionId: q[0], marks: a, comment: c1Comment }, { questionId: q[1], marks: b }], comment: overall });
  /** The coach marks and submits one submission (blind: by its code). */
  const markAndSubmit = async (token: string, testId: string, studentId: string, body: object) => {
    const code = (await subOf(testId, studentId)).publicCode;
    await http().put(`${MK}/submissions/${code}/marking`).set(bearer(token)).send(body).expect(200);
    await http().post(`${MK}/submissions/${code}/marking/submit`).set(bearer(token)).send(body).expect(200);
  };
  const approve = async (token: string, testId: string, studentId: string) =>
    http().post(`${M(testId)}/submissions/${(await subOf(testId, studentId)).id}/approve`).set(bearer(token)).send({}).expect(200);
  const outbox = (type: string, testId?: string) => p().notificationOutbox.findMany({
    where: { type, ...(testId && { entityId: testId }) }, orderBy: { createdAt: 'asc' },
    select: { recipientUserId: true, dedupeKey: true, payload: true, inAppNotificationId: true },
  });
  const auditOf = (action: string, entityId?: string) => p().auditLog.findMany({ where: { action, ...(entityId && { entityId }) }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    process.env.PRISMA_QUERY_EVENTS = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics', sortOrder: 1 } })).id;
    school = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    other = (await p().school.create({ data: { name: 'Other School', location: 'Huye' } })).id;
    const third = (await p().school.create({ data: { name: 'Third School', location: 'Musanze' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'TEACHER', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const verify = (studentId: string, schoolId: string) => p().studentSchoolAffiliation.create({ data: {
      studentId, schoolId, source: 'ADMIN', createdById: ctx.ids.admin, status: 'VERIFIED', decidedById: ctx.ids.admin, decidedAt: new Date() } });
    const hmId = await mk('hc.maths', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    const hpId = await mk('hc.phys', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hpId, disciplineId: physics, source: 'MANUAL' } });
    stJ = ctx.ids.studentJunior; stJ2 = ctx.ids.studentJunior2; stS = ctx.ids.studentSenior;
    c1Id = ctx.ids.mentorJunior; c2Id = ctx.ids.mentorJunior2;
    await verify(stJ, school);
    await verify(stJ2, school);
    await p().user.update({ where: { id: stS }, data: { schoolId: other } });
    await verify(stS, other);
    tA = await mk('teacher.a', 'TEACHER');
    tO = await mk('teacher.o', 'TEACHER');
    tX = await mk('teacher.x', 'TEACHER');
    await p().teacherSchoolAssignment.createMany({ data: [
      { teacherId: tA, schoolId: school, role: 'PRIMARY' }, { teacherId: tO, schoolId: other, role: 'PRIMARY' }, { teacherId: tX, schoolId: third, role: 'PRIMARY' },
    ] });
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'hc.maths');
    hp = await login(ctx, 'hc.phys');
    c1 = await login(ctx, 'mentor.j');
    sj = await login(ctx, 'student.j');
    sj2 = await login(ctx, 'student.j2');
    ss = await login(ctx, 'student.s');
    ta = await login(ctx, 'teacher.a');
    to = await login(ctx, 'teacher.o');
    tx = await login(ctx, 'teacher.x');
    for (const coachId of [c1Id, c2Id]) {
      await http().post('/api/v1/admin/test-markers').set(bearer(hm)).send({ coachId, subjectId: maths }).expect(201);
    }
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    delete process.env.PRISMA_QUERY_EVENTS;
    await ctx?.app.close();
  });

  it('permissions per role and route: publication and results for Administrators and Head Coaches, the override for Administrators only; own results for Students, school results for Teachers; Coaches none', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const staff = [['get', R(id)], ['get', `${R(id)}/preview`], ['post', `${R(id)}/publish`], ['get', `${R(id)}/publications`],
      ['get', `${R(id)}/rankings`], ['get', `${R(id)}/report`], ['get', `${R(id)}/export.csv`],
      ['get', '/api/v1/admin/test-reports'], ['get', '/api/v1/admin/test-dashboard']] as const;
    const override = [['post', `${R(id)}/publish/override`]] as const;
    const student = [['get', MR], ['get', `${MR}/${id}`], ['get', '/api/v1/me/test-dashboard']] as const;
    const teacher = [['get', TR], ['get', `${TR}/${id}`], ['get', `${TR}/${id}/students/${id}`], ['get', '/api/v1/teacher/test-dashboard']] as const;
    const coach = [['get', `${MK}/dashboard`]] as const;
    const check = async (tokens: string[], routes: readonly (readonly [string, string])[]) => {
      for (const token of tokens) for (const [method, path] of routes) {
        expect([method, path, await status((http() as any)[method](path).set(bearer(token)).send({}))]).toEqual([method, path, [403, 'PERMISSION_REQUIRED']]);
      }
    };
    await check([sj, ta, c1], staff);
    await check([sj, ta, c1, hm, hp], override);   // a Head Coach can never override (owner spec 10.1)
    await check([ta, c1, admin, hm], student);
    await check([sj, c1, admin, hm], teacher);
    await check([sj, ta, admin, hm], coach);       // Administrators never mark
    for (const [method, path] of [...staff, ...override, ...student, ...teacher, ...coach]) expect((await (http() as any)[method](path)).status).toBe(401);
    // A Head Coach of another subject: the test is not theirs, on every staff route.
    const t = await publishedTest('Scope check');
    for (const [method, path] of [['get', R(t)], ['get', `${R(t)}/preview`], ['post', `${R(t)}/publish`], ['get', `${R(t)}/publications`],
      ['get', `${R(t)}/rankings`], ['get', `${R(t)}/report`], ['get', `${R(t)}/export.csv`]] as const) {
      expect([path, await status((http() as any)[method](path).set(bearer(hp)).send({}))]).toEqual([path, [403, 'SCOPE_FORBIDDEN']]);
    }
    // GET /me/permissions: what each role's portal may show.
    const perms = async (token: string) => (await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.permissions as string[];
    expect(await perms(sj)).toContain('tests.viewOwnResults');
    expect(await perms(ta)).toContain('tests.viewSchoolResults');
    expect(await perms(admin)).toEqual(expect.arrayContaining(['tests.publishResults', 'tests.overridePublication', 'tests.viewResults', 'tests.viewRankings']));
    const hmPerms = await perms(hm);
    expect(hmPerms).toEqual(expect.arrayContaining(['tests.publishResults', 'tests.viewResults', 'tests.viewRankings']));
    expect(hmPerms).not.toContain('tests.overridePublication');
    const coachPerms = await perms(c1);
    for (const x of ['tests.publishResults', 'tests.overridePublication', 'tests.viewResults', 'tests.viewRankings', 'tests.viewOwnResults', 'tests.viewSchoolResults']) {
      expect(coachPerms).not.toContain(x);
    }
    expect(await perms(sj)).not.toContain('tests.viewRankings');
    expect(await perms(ta)).not.toContain('tests.viewRankings');
    // The capability is advertised.
    expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toContain('testResults');
  });

  describe('one test from approval to publication, withdrawal and republication', () => {
    let id: string;
    let q: string[];
    let leaderboardBefore: unknown;
    let names: Record<string, { firstName: string; lastName: string }>;

    beforeAll(async () => {
      id = await publishedTest();
      q = await questionsOf(id);
      await submitTyped(sj, id, 'Answer of j');
      await submitTyped(sj2, id, 'Answer of j2');
      await submitTyped(ss, id, 'Answer of s');
      // An extension still running for a teacher unrelated to these students: a warning at publication, never a block.
      await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'TEACHER', teacherId: tX, newDeadline: minutes(240), reason: 'Exam clash at school' }).expect(201);
      await closeNow(id);
      await http().post(`${M(id)}/distribute`).set(bearer(hm)).send({ coachIds: [c1Id] }).expect(200);
      await markAndSubmit(c1, id, stJ, marks(q, 4, 13, 'Sign error in line 2', 'Well argued'));
      await markAndSubmit(c1, id, stJ2, marks(q, 5, 10));
      await markAndSubmit(c1, id, stS, marks(q, 5, 12));
      await approve(hm, id, stJ);
      await approve(admin, id, stJ2);
      // student.s stays MARKED (awaiting approval).
      leaderboardBefore = (await http().get('/api/v1/leaderboard').set(bearer(sj)).expect(200)).body;
      names = Object.fromEntries((await p().user.findMany({ where: { id: { in: [stJ, stJ2, stS] } }, select: { id: true, firstName: true, lastName: true } }))
        .map((u) => [u.id, { firstName: u.firstName, lastName: u.lastName }]));
    });

    it('results stay hidden from students and teachers until published — an APPROVED result is not a published one', async () => {
      expect((await http().get(MR).set(bearer(sj)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get(`${MR}/${id}`).set(bearer(sj)))).toEqual([404, 'RESULT_NOT_FOUND']);
      expect(await status(http().get(`${MR}/${id}`).set(bearer(ss)))).toEqual([404, 'RESULT_NOT_FOUND']);
      expect((await http().get(TR).set(bearer(ta)).expect(200)).body.meta.total).toBe(0);
      expect((await http().get(`${TR}/${id}`).set(bearer(ta)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get(`${TR}/${id}/students/${stJ}`).set(bearer(ta)))).toEqual([404, 'RESULT_NOT_FOUND']);
      // The staff list has them, not published.
      const list = (await http().get(R(id)).set(bearer(admin)).expect(200)).body;
      expect(list.data.map((r: any) => [r.student.id, r.status, r.published, r.totalMarks])).toEqual(expect.arrayContaining([
        [stJ, 'APPROVED', false, 17], [stJ2, 'APPROVED', false, 15],
      ]));
      expect(list.meta.total).toBe(2);
      // No marks appear in the student's own test view either (the submission shows its status, never marks).
      expect(JSON.stringify((await http().get(`${ME}/${id}`).set(bearer(sj)).expect(200)).body)).not.toMatch(/totalMarks|"marks"|Sign error|Well argued/);
    });

    it('preview: counts, the unapproved results with identity, the running extension (warning); Head Coach: blocked, no override; Administrator: override offered', async () => {
      const pv = (await http().get(`${R(id)}/preview`).set(bearer(hm)).expect(200)).body;
      expect(pv.counts).toMatchObject({ total: 3, approved: 2, published: 0, unapproved: 1, byStatus: { APPROVED: 2, MARKED: 1 } });
      expect(pv.unapproved.meta.total).toBe(1);
      expect(pv.unapproved.data[0]).toMatchObject({ status: 'MARKED', student: { id: stS } });
      expect(pv.activeExtensions.map((e: any) => [e.kind, e.teacher?.id])).toEqual([['TEACHER', tX]]);
      expect(pv.warnings).toEqual(expect.arrayContaining(['UNAPPROVED_RESULTS', 'ACTIVE_INDIVIDUAL_EXTENSIONS']));
      expect(pv.deadlinePassed).toBe(true);
      expect(pv.actions).toEqual({ publish: false, blocked: true, override: false });
      expect((await http().get(`${R(id)}/preview`).set(bearer(admin)).expect(200)).body.actions).toEqual({ publish: false, blocked: false, override: true });
    });

    it('a Head Coach is BLOCKED while any result is unapproved and can never override (route and service); nothing changes', async () => {
      const blocked = await http().post(`${R(id)}/publish`).set(bearer(hm)).send({});
      expect([blocked.status, blocked.body.code, blocked.body.details]).toEqual([409, 'PUBLICATION_BLOCKED', { unapproved: 1, approved: 2, overrideAvailable: false }]);
      expect(await status(http().post(`${R(id)}/publish/override`).set(bearer(hm)).send({ reason: 'Ceremony is tomorrow morning' }))).toEqual([403, 'PERMISSION_REQUIRED']);
      // Even an Administrator is blocked without the override.
      expect(await status(http().post(`${R(id)}/publish`).set(bearer(admin)).send({}))).toEqual([409, 'PUBLICATION_BLOCKED']);
      expect(await p().testPublication.count({ where: { testId: id } })).toBe(0);
      expect((await p().testSubmission.findMany({ where: { testId: id }, select: { status: true } })).map((s) => s.status).sort()).toEqual(['APPROVED', 'APPROVED', 'MARKED']);
      expect(await outbox('test.results.published', id)).toEqual([]);
    });

    it('Administrator override: the reason is mandatory; only the approved results are published; audited (published + overridden, with the reason); status history kept', async () => {
      expect(await status(http().post(`${R(id)}/publish/override`).set(bearer(admin)).send({}))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(`${R(id)}/publish/override`).set(bearer(admin)).send({ reason: 'too short' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await p().testPublication.count({ where: { testId: id } })).toBe(0);
      const res = (await http().post(`${R(id)}/publish/override`).set(bearer(admin)).send({ reason: 'Prize ceremony on Friday; one script still in review' }).expect(200)).body;
      expect(res).toMatchObject({ replayed: false, published: 2, publication: { number: 1, override: true, overrideReason: 'Prize ceremony on Friday; one script still in review', publishedCount: 2, actorRole: 'ADMIN' } });
      expect(res.publication.counts).toMatchObject({ total: 3, approved: 2, unapproved: 1, activeExtensions: { teacher: 1 } });
      const subs = await p().testSubmission.findMany({ where: { testId: id }, select: { studentId: true, status: true, publicationId: true, publishedAt: true } });
      const byStudent = Object.fromEntries(subs.map((s) => [s.studentId, s]));
      expect([byStudent[stJ].status, byStudent[stJ2].status, byStudent[stS].status]).toEqual(['PUBLISHED', 'PUBLISHED', 'MARKED']);
      expect(byStudent[stJ].publicationId).toBe(res.publication.id);
      expect(byStudent[stS].publicationId).toBeNull();
      const audit = await auditOf('TEST_RESULTS_PUBLISHED', id);
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ override: true, reason: 'Prize ceremony on Friday; one script still in review', published: 2 });
      const over = await auditOf('TEST_PUBLICATION_OVERRIDDEN', id);
      expect(over.map((a) => [a.actorRole, (a.metadata as any).reason, (a.metadata as any).unapproved])).toEqual([['ADMIN', 'Prize ceremony on Friday; one script still in review', 1]]);
      const history = await p().testSubmissionStatusChange.findMany({ where: { submissionId: (await subOf(id, stJ)).id }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => h.toStatus)).toEqual(['SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'APPROVED', 'PUBLISHED']);
      expect(history.at(-1)).toMatchObject({ fromStatus: 'APPROVED', actorRole: 'ADMIN', reason: 'Prize ceremony on Friday; one script still in review' });
      // The unapproved one stays hidden.
      expect(await status(http().get(`${MR}/${id}`).set(bearer(ss)))).toEqual([404, 'RESULT_NOT_FOUND']);
    });

    it('notifications: each student once, their school\'s teacher once (not once per student), written with the publication; no other student\'s data', async () => {
      await waitForEvents();
      const rows = await outbox('test.results.published', id);
      expect(rows.map((r) => r.recipientUserId).sort()).toEqual([stJ, stJ2, tA].sort());
      for (const r of rows) {
        expect(r.inAppNotificationId).not.toBeNull();
        const text = JSON.stringify(r.payload);
        // The test only — never a mark, a name or another student.
        for (const n of Object.values(names)) expect(text).not.toContain(n.lastName === 'Test' ? `"${n.firstName}"` : n.lastName);
        expect(text).not.toMatch(/totalMarks|marks|rank|Sign error/);
        expect(r.payload).toMatchObject({ testId: id, testTitle: 'Results round', subjectName: 'Mathematics' });
      }
      expect(rows.find((r) => r.recipientUserId === tA)!.payload).toMatchObject({ audience: 'TEACHER', count: 2 });
      expect(rows.find((r) => r.recipientUserId === stJ)!.payload).toMatchObject({ audience: 'STUDENT' });
      const inApp = await p().notification.findMany({ where: { type: 'test.results.published', userId: stJ } });
      expect(inApp.map((n) => n.link)).toEqual([`/student/results/${id}`]);
      expect((await p().notification.findFirstOrThrow({ where: { type: 'test.results.published', userId: tA } })).link).toBe(`/teacher/results/${id}`);
      // Nobody else: not the unapproved student, not another school's teacher, not the coach.
      expect(await p().notification.count({ where: { type: 'test.results.published', userId: { in: [stS, tO, tX, c1Id] } } })).toBe(0);
    });

    it('students see only their own published result: marks per question, total, comments — never the marker, never a rank', async () => {
      const mine = (await http().get(`${MR}/${id}`).set(bearer(sj)).expect(200)).body;
      expect(mine.result).toEqual({
        totalMarks: 17, maxMarks: 20, comment: 'Well argued',
        questions: [
          { order: 1, prompt: 'Q one', maxMarks: 5, marks: 4, comment: 'Sign error in line 2' },
          { order: 2, prompt: 'Q two', maxMarks: 15, marks: 13, comment: null },
        ],
      });
      expect(mine).not.toHaveProperty('rankingsVisible');   // the design-only option is never exposed to students
      const text = JSON.stringify(mine);
      expect(text).not.toMatch(/mentor\.j|"rank"|ranking|position|marker|publicCode/);
      const list = (await http().get(MR).set(bearer(sj)).expect(200)).body;
      expect(list.data.map((r: any) => [r.test.id, r.totalMarks, r.maxMarks])).toEqual([[id, 17, 20]]);
      // student.j2's own is theirs only; student.s (not published) sees nothing.
      expect((await http().get(`${MR}/${id}`).set(bearer(sj2)).expect(200)).body.result.totalMarks).toBe(15);
      expect((await http().get(MR).set(bearer(ss)).expect(200)).body.data).toEqual([]);
    });

    it('teachers see only the published results of their own school\'s students, by name, never ranked; another school\'s student is not found', async () => {
      const tests = (await http().get(TR).set(bearer(ta)).expect(200)).body;
      expect(tests.data.map((t: any) => [t.test.id, t.publishedResults])).toEqual([[id, 2]]);
      const res = (await http().get(`${TR}/${id}`).set(bearer(ta)).expect(200)).body;
      const expected = [stJ, stJ2].sort((a, b) => (names[a].lastName + names[a].firstName).localeCompare(names[b].lastName + names[b].firstName));
      expect(res.data.map((r: any) => r.student.id)).toEqual(expected);
      expect(res.data.map((r: any) => r.totalMarks).sort()).toEqual([15, 17]);
      expect(JSON.stringify(res)).not.toMatch(/"rank"|ranking|position|marker/);
      const one = (await http().get(`${TR}/${id}/students/${stJ}`).set(bearer(ta)).expect(200)).body;
      expect(one).toMatchObject({ student: { id: stJ }, result: { totalMarks: 17, comment: 'Well argued' } });
      expect(await status(http().get(`${TR}/${id}/students/${stS}`).set(bearer(ta)))).toEqual([404, 'RESULT_NOT_FOUND']);
      // Another school's teacher sees none of them; a teacher without students sees nothing.
      expect((await http().get(`${TR}/${id}`).set(bearer(to)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get(`${TR}/${id}/students/${stJ}`).set(bearer(to)))).toEqual([404, 'RESULT_NOT_FOUND']);
      expect((await http().get(TR).set(bearer(tx)).expect(200)).body.meta.total).toBe(0);
      // A school that is not the teacher's: refused.
      expect(await status(http().get(`${TR}/${id}?schoolId=${other}`).set(bearer(ta)))).toEqual([404, 'SCHOOL_NOT_FOUND']);
    });

    it('five simultaneous publications: exactly one publishes, the others replay it; repeating publishes nothing; every recipient told exactly once', async () => {
      await approve(hm, id, stS);
      const before = (await p().notificationOutbox.count({ where: { type: 'test.results.published' } }));
      const burst = await Promise.all([admin, hm, admin, hm, admin].map((token) => http().post(`${R(id)}/publish`).set(bearer(token)).send({ clientKey: randomUUID() })));
      expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const fresh = burst.filter((r) => r.body.replayed === false);
      expect(fresh).toHaveLength(1);
      expect(fresh[0].body).toMatchObject({ published: 1, publication: { number: 2, override: false, overrideReason: null } });
      for (const r of burst) expect(r.body.publication.id).toBe(fresh[0].body.publication.id);
      expect(await p().testPublication.count({ where: { testId: id } })).toBe(2);
      // Again, sequentially, with or without a key: replays.
      const again = (await http().post(`${R(id)}/publish`).set(bearer(hm)).send({}).expect(200)).body;
      expect(again).toMatchObject({ replayed: true, published: 0, publication: { number: 2 } });
      const key = randomUUID();
      expect((await http().post(`${R(id)}/publish`).set(bearer(admin)).send({ clientKey: key }).expect(200)).body.replayed).toBe(true);
      expect(await p().testPublication.count({ where: { testId: id } })).toBe(2);
      await waitForEvents();
      const rows = await outbox('test.results.published', id);
      expect(rows).toHaveLength(before + 2);
      expect(rows.filter((r) => r.recipientUserId === stS)).toHaveLength(1);
      expect(rows.filter((r) => r.recipientUserId === tO)).toHaveLength(1);
      for (const u of [stJ, stJ2, tA]) expect(rows.filter((r) => r.recipientUserId === u)).toHaveLength(1);
      expect(await p().notification.count({ where: { type: 'test.results.published', userId: stS } })).toBe(1);
      // The publications list: newest first, with who and whether it overrode.
      const pubs = (await http().get(`${R(id)}/publications`).set(bearer(hm)).expect(200)).body;
      expect(pubs.data.map((x: any) => [x.number, x.override, x.publishedCount])).toEqual([[2, false, 1], [1, true, 2]]);
      expect((await http().get(`${R(id)}/preview`).set(bearer(hm)).expect(200)).body.counts).toMatchObject({ published: 3, approved: 0, unapproved: 0 });
    });

    it('rankings for Administrators and the subject\'s Head Coaches: overall, by division, by school (competition rank, deterministic ties)', async () => {
      // Totals: student.j 17, student.s 17 (tie), student.j2 15.
      const tie = [stJ, stS].sort((a, b) => names[a].lastName.localeCompare(names[b].lastName) || names[a].firstName.localeCompare(names[b].firstName) || a.localeCompare(b));
      const overall = (await http().get(`${R(id)}/rankings`).set(bearer(hm)).expect(200)).body;
      expect(overall.method).toBe('COMPETITION');
      expect(overall.data.map((r: any) => [r.student.id, r.rank, r.totalMarks])).toEqual([[tie[0], 1, 17], [tie[1], 1, 17], [stJ2, 3, 15]]);
      const byDivision = (await http().get(`${R(id)}/rankings?by=division`).set(bearer(admin)).expect(200)).body;
      expect(byDivision.data.map((r: any) => [r.group.division, r.student.id, r.rank])).toEqual([['JUNIOR', stJ, 1], ['JUNIOR', stJ2, 2], ['SENIOR', stS, 1]]);
      const bySchool = (await http().get(`${R(id)}/rankings?by=school`).set(bearer(admin)).expect(200)).body;
      expect(bySchool.data.map((r: any) => [r.group.schoolName, r.student.id, r.rank])).toEqual([['Other School', stS, 1], ['Test School', stJ, 1], ['Test School', stJ2, 2]]);
      const oneSchool = (await http().get(`${R(id)}/rankings?by=school&schoolId=${school}&limit=1`).set(bearer(admin)).expect(200)).body;
      expect([oneSchool.meta.total, oneSchool.data.map((r: any) => r.student.id)]).toEqual([2, [stJ]]);
      expect((await http().get(`${R(id)}/rankings?by=division&division=SENIOR`).set(bearer(admin)).expect(200)).body.data.map((r: any) => r.student.id)).toEqual([stS]);
      // The same request twice: the same order.
      expect((await http().get(`${R(id)}/rankings`).set(bearer(admin)).expect(200)).body.data).toEqual(overall.data);
      expect(await status(http().get(`${R(id)}/rankings`).set(bearer(hp)))).toEqual([403, 'SCOPE_FORBIDDEN']);
      for (const token of [sj, ta, c1]) expect(await status(http().get(`${R(id)}/rankings`).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
    });

    it('report and CSV exports: counts, average / median, distribution, per question, per school, per division; the export is audited', async () => {
      const rep = (await http().get(`${R(id)}/report`).set(bearer(hm)).expect(200)).body;
      expect(rep.counts).toMatchObject({ total: 3, published: 3 });
      expect(rep.summary).toEqual({ results: 3, average: 16.33, median: 17, min: 15, max: 17, maxMarks: 20 });
      expect(rep.distribution.find((b: any) => b.from === 70).count).toBe(1);   // 15 / 20 = 75 %
      expect(rep.distribution.find((b: any) => b.from === 80).count).toBe(2);   // 17 / 20 = 85 %
      expect(rep.questions.map((x: any) => [x.order, x.results, x.average, x.min, x.max])).toEqual([[1, 3, 4.67, 4, 5], [2, 3, 11.67, 10, 13]]);
      expect(rep.bySchool.map((x: any) => [x.schoolName, x.results, x.average])).toEqual([['Other School', 1, 17], ['Test School', 2, 16]]);
      expect(rep.byDivision.map((x: any) => [x.division, x.results, x.average])).toEqual([['JUNIOR', 2, 16], ['SENIOR', 1, 17]]);
      const csv = await http().get(`${R(id)}/export.csv`).set(bearer(admin)).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('Rank,Submission code,Last name,First name,Username,Grade,Division,School,Status,Q1,Q2,Total,Maximum,Published at');
      expect(lines).toHaveLength(4);
      expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['1', '1', '3']);
      const schools = (await http().get(`${R(id)}/export.csv?type=schools`).set(bearer(hm)).expect(200)).text;
      expect(schools).toContain('Test School,2,16,16,15,17');
      expect((await http().get(`${R(id)}/export.csv?type=questions`).set(bearer(hm)).expect(200)).text).toContain('1,5,3,4.67,4,5');
      expect((await http().get(`${R(id)}/export.csv?type=divisions`).set(bearer(hm)).expect(200)).text).toContain('SENIOR,1,17,17,17,17');
      expect((await auditOf('TEST_RESULTS_EXPORTED', id)).map((a) => (a.metadata as any).type)).toEqual(['results', 'schools', 'questions', 'divisions']);
      // The reporting overview lists the test with its counts.
      const overview = (await http().get('/api/v1/admin/test-reports').set(bearer(hm)).expect(200)).body;
      expect(overview.data.find((t: any) => t.id === id)).toMatchObject({ results: 3, average: 16.33, publications: 2 });
      expect((await http().get('/api/v1/admin/test-reports').set(bearer(hp)).expect(200)).body.data.find((t: any) => t.id === id)).toBeUndefined();
    });

    it('G6: unlocking a published result withdraws it from the student and the teacher, told once (a retry adds nothing); re-approval alone does not show it; republishing restores it', async () => {
      const sid = (await subOf(id, stJ)).id;
      const key = randomUUID();
      const unlock = (await http().post(`${M(id)}/submissions/${sid}/unlock`).set(bearer(hm)).send({ reason: 'Question 2 re-check requested', clientKey: key, expectedStatus: 'PUBLISHED' }).expect(200)).body;
      expect(unlock).toMatchObject({ status: 'MARKED', replayed: false });
      expect(await p().testSubmission.findUniqueOrThrow({ where: { id: sid }, select: { status: true, publicationId: true, publishedAt: true } })).toEqual({ status: 'MARKED', publicationId: null, publishedAt: null });
      const w = await p().testResultWithdrawal.findMany({ where: { submissionId: sid } });
      expect(w.map((x) => [x.reason, x.actorRole])).toEqual([['Question 2 re-check requested', 'HEAD_COACH']]);
      expect((await auditOf('TEST_RESULT_WITHDRAWN', sid)).length).toBe(1);
      // Gone from the student's and the teacher's views; the other results stay.
      expect(await status(http().get(`${MR}/${id}`).set(bearer(sj)))).toEqual([404, 'RESULT_NOT_FOUND']);
      expect((await http().get(MR).set(bearer(sj)).expect(200)).body.meta.total).toBe(0);
      expect((await http().get(`${TR}/${id}`).set(bearer(ta)).expect(200)).body.data.map((r: any) => r.student.id)).toEqual([stJ2]);
      expect(await status(http().get(`${TR}/${id}/students/${stJ}`).set(bearer(ta)))).toEqual([404, 'RESULT_NOT_FOUND']);
      expect((await http().get(`${MR}/${id}`).set(bearer(sj2)).expect(200)).body.result.totalMarks).toBe(15);
      // Told once: the student and their school's teacher.
      await waitForEvents();
      const notices = async () => (await outbox('test.result.withdrawn', id)).map((r) => r.recipientUserId).sort();
      expect(await notices()).toEqual([stJ, tA].sort());
      // The same request again (retry): a replay — no second withdrawal, no second notice. Another unlock: 409.
      expect((await http().post(`${M(id)}/submissions/${sid}/unlock`).set(bearer(hm)).send({ reason: 'Question 2 re-check requested', clientKey: key }).expect(200)).body.replayed).toBe(true);
      expect(await status(http().post(`${M(id)}/submissions/${sid}/unlock`).set(bearer(admin)).send({ reason: 'Again please' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(await p().testResultWithdrawal.count({ where: { submissionId: sid } })).toBe(1);
      expect(await notices()).toEqual([stJ, tA].sort());
      // Re-approved: still hidden until published again.
      await http().post(`${M(id)}/submissions/${sid}/approve`).set(bearer(hm)).send({}).expect(200);
      expect(await status(http().get(`${MR}/${id}`).set(bearer(sj)))).toEqual([404, 'RESULT_NOT_FOUND']);
      expect((await http().get(`${R(id)}/preview`).set(bearer(hm)).expect(200)).body.actions).toEqual({ publish: true, blocked: false, override: false });
      const again = (await http().post(`${R(id)}/publish`).set(bearer(hm)).send({}).expect(200)).body;
      expect(again).toMatchObject({ replayed: false, published: 1, publication: { number: 3, actorRole: 'HEAD_COACH' } });
      expect((await http().get(`${MR}/${id}`).set(bearer(sj)).expect(200)).body.result.totalMarks).toBe(17);
      expect((await http().get(`${TR}/${id}`).set(bearer(ta)).expect(200)).body.meta.total).toBe(2);
      // The publications list shows the withdrawal against the first publication.
      const pubs = (await http().get(`${R(id)}/publications`).set(bearer(admin)).expect(200)).body;
      expect(pubs.data.map((x: any) => [x.number, x.withdrawn])).toEqual([[3, 0], [2, 0], [1, 1]]);
      expect(pubs.withdrawals.map((x: any) => [x.submission.id, x.reason])).toEqual([[sid, 'Question 2 re-check requested']]);
      // The student was told the result is available again (the new publication), once.
      await waitForEvents();
      expect((await outbox('test.results.published', id)).filter((r) => r.recipientUserId === stJ)).toHaveLength(2);
      const history = await p().testSubmissionStatusChange.findMany({ where: { submissionId: sid }, orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => h.toStatus).slice(-4)).toEqual(['PUBLISHED', 'MARKED', 'APPROVED', 'PUBLISHED']);
    });

    it("owner 2026-11-23: a coach sees the PUBLISHED results of their programme's tests, every level, by name — never a rank, code, marker or unpublished result; removable per programme", async () => {
      const CR = '/api/v1/coach/test-results';
      // mentor.j belongs to the Mathematics programme: the test is listed with ALL its published results — every school and
      // level (unlike a teacher, who sees their school's) — and only published ones.
      const published = await p().testSubmission.findMany({ where: { testId: id, status: 'PUBLISHED' }, select: { studentId: true } });
      expect(published.length).toBeGreaterThan(0);
      const tests = (await http().get(CR).set(bearer(c1)).expect(200)).body;
      expect(tests.data.map((t: any) => [t.test.id, t.publishedResults])).toEqual([[id, published.length]]);
      const res = (await http().get(`${CR}/${id}`).set(bearer(c1)).expect(200)).body;
      expect(res.data.map((r: any) => r.student.id).sort()).toEqual(published.map((x) => x.studentId).sort());
      expect(res.data.map((r: any) => r.student.school.id)).toEqual(expect.arrayContaining([school, other]));
      expect(JSON.stringify(res)).not.toMatch(/"rank"|ranking|publicCode|marker/);
      expect((await http().get(`${CR}/${id}/students/${stJ}`).set(bearer(c1)).expect(200)).body).toMatchObject({ result: { totalMarks: 17 } });
      // No published result for that student (here: no submission at all): not found.
      expect(await status(http().get(`${CR}/${id}/students/${ctx.ids.admin}`).set(bearer(c1)))).toEqual([404, 'RESULT_NOT_FOUND']);
      // A Physics coach sees none of the Mathematics results.
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const physicsId = (await p().discipline.findUniqueOrThrow({ where: { code: 'PHYSICS' } })).id;
      const phy = await p().user.create({ data: { username: 'coach.phy', firstName: 'Phy', lastName: 'Coach', email: 'coach.phy@test.local', role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } });
      await p().programmeMembership.create({ data: { userId: phy.id, disciplineId: physicsId, source: 'MANUAL' } });
      const cp = await login(ctx, 'coach.phy');
      expect((await http().get(CR).set(bearer(cp)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get(`${CR}/${id}`).set(bearer(cp)))).toEqual([404, 'RESULT_NOT_FOUND']);
      // The Mathematics Head Coach takes it away from mentor.j (a reason is required); the Physics Head Coach cannot.
      const PA = `/api/v1/admin/coaches/${c1Id}/programme-access`;
      expect(await status(http().put(PA).set(bearer(hm)).send({ programmeId: maths, capability: 'RESULTS', allowed: false }))).toEqual([400, 'REASON_REQUIRED']);
      expect((await http().put(PA).set(bearer(hp)).send({ programmeId: maths, capability: 'RESULTS', allowed: false, reason: 'x y z' })).status).toBe(404);
      await http().put(PA).set(bearer(hm)).send({ programmeId: maths, capability: 'RESULTS', allowed: false, reason: 'Marks the next round' }).expect(200);
      expect((await http().get(CR).set(bearer(c1)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get(`${CR}/${id}`).set(bearer(c1)))).toEqual([404, 'RESULT_NOT_FOUND']);
      const back = (await http().put(PA).set(bearer(admin)).send({ programmeId: maths, capability: 'RESULTS', allowed: true }).expect(200)).body;
      expect(back.programmes[0].access.find((a: any) => a.capability === 'RESULTS')).toMatchObject({ allowed: true, removed: null });
      expect((await http().get(CR).set(bearer(c1)).expect(200)).body.meta.total).toBe(1);
      expect((await auditOf('COACH_PROGRAMME_ACCESS_REMOVED', c1Id)).map((a) => (a.metadata as any).reason)).toEqual(['Marks the next round']);
      expect(await auditOf('COACH_PROGRAMME_ACCESS_RESTORED', c1Id)).toHaveLength(1);
    });

    it('coaches get nothing beyond marking; tests never feed the student leaderboard', async () => {
      for (const path of [MR, `${MR}/${id}`, TR, `${TR}/${id}`, R(id), `${R(id)}/rankings`]) {
        expect([path, await status(http().get(path).set(bearer(c1)))]).toEqual([path, [403, 'PERMISSION_REQUIRED']]);
      }
      const queue = (await http().get(`${MK}/queue`).set(bearer(c1)).expect(200)).body;
      expect(JSON.stringify(queue)).not.toMatch(/student\.|"rank"|publishedAt|publication/);
      expect((await http().get('/api/v1/leaderboard').set(bearer(sj)).expect(200)).body).toEqual(leaderboardBefore);
    });

    it('dashboards: student, teacher, coach (own work only), Head Coach (own subject only) and Administrator', async () => {
      const st = (await http().get('/api/v1/me/test-dashboard').set(bearer(sj)).expect(200)).body;
      expect(st.counts).toMatchObject({ publishedResults: 1, submitted: 1, awaitingResults: 0 });
      expect(st.results.map((r: any) => [r.test.id, r.totalMarks])).toEqual([[id, 17]]);
      expect(JSON.stringify(st)).not.toMatch(/"rank"/);
      const te = (await http().get('/api/v1/teacher/test-dashboard').set(bearer(ta)).expect(200)).body;
      expect(te.results.map((r: any) => [r.test.id, r.publishedResults])).toEqual([[id, 2]]);
      const txd = (await http().get('/api/v1/teacher/test-dashboard').set(bearer(tx)).expect(200)).body;
      expect(txd.extensions.map((e: any) => e.kind)).toEqual(['TEACHER']);   // their own extension on the open test list
      const co = (await http().get(`${MK}/dashboard`).set(bearer(c1)).expect(200)).body;
      expect(co.counts).toMatchObject({ total: 3, marked: 3, notStarted: 0, inProgress: 0, needsAction: 0 });
      expect(JSON.stringify(co)).not.toMatch(/student|school|firstName/);
      expect((await http().get(`${MK}/dashboard`).set(bearer(await login(ctx, 'mentor.j2'))).expect(200)).body.counts.total).toBe(0);
      const hd = (await http().get('/api/v1/admin/test-dashboard').set(bearer(hm)).expect(200)).body;
      expect(hd.subjects.map((s: any) => s.subject.code)).toEqual(['MATHEMATICS']);
      // The two authorised coaches (the seeded coaches' programme-wide marking is taken away in the fixture, test/helpers.ts).
      expect(hd.subjects[0]).toMatchObject({ authorisedMarkers: 2, headCoaches: 1, submissions: { published: 3 } });
      expect(hd.tests.find((t: any) => t.id === id)).toMatchObject({ publications: 3, counts: { published: 3 } });
      expect(hd.coaches.map((c: any) => [c.coach.id, c.marked])).toEqual([[c1Id, 3]]);
      expect(hd.rankings.test.id).toBe(id);
      expect(hd.rankings.top.map((r: any) => r.rank)).toEqual([1, 1, 3]);
      const pd = (await http().get('/api/v1/admin/test-dashboard').set(bearer(hp)).expect(200)).body;
      expect(pd.subjects.map((s: any) => s.subject.code)).toEqual(['PHYSICS']);
      expect([pd.tests, pd.rankings]).toEqual([[], null]);
      const ad = (await http().get('/api/v1/admin/test-dashboard').set(bearer(admin)).expect(200)).body;
      expect(ad.scope).toBe('all');
      expect(ad.subjects.map((s: any) => s.subject.code)).toEqual(expect.arrayContaining(['MATHEMATICS', 'PHYSICS']));
    });

    it('the database keeps the rules: publications and withdrawals are append-only; PUBLISHED only with its publication; an override needs its reason; rankings for students cannot be turned on', async () => {
      const pub = await p().testPublication.findFirstOrThrow({ where: { testId: id } });
      await expect(p().$executeRaw`UPDATE "TestPublication" SET "publishedCount" = 99 WHERE "id" = ${pub.id}`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`DELETE FROM "TestPublication" WHERE "id" = ${pub.id}`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`UPDATE "TestResultWithdrawal" SET "reason" = 'x' WHERE TRUE`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`DELETE FROM "TestResultWithdrawal"`).rejects.toThrow(/append-only/);
      const sid = (await subOf(id, stJ2)).id;
      await expect(p().$executeRaw`UPDATE "TestSubmission" SET "publicationId" = NULL, "publishedAt" = NULL WHERE "id" = ${sid}`).rejects.toThrow(/TestSubmission_published_state/);
      await expect(p().$executeRaw`UPDATE "Test" SET "studentRankingsVisible" = true WHERE "id" = ${id}`).rejects.toThrow(/Test_student_rankings_design_only/);
      await expect(p().$executeRaw`INSERT INTO "TestPublication" ("id", "testId", "number", "actorRole", "override", "publishedCount", "counts", "createdAt") VALUES (gen_random_uuid()::text, ${id}, 9, 'ADMIN', true, 0, '{}'::jsonb, now())`)
        .rejects.toThrow(/TestPublication_override_reason/);
    });
  });

  it('performance sanity: publishing 5,000 approved results — one publication, quick, constant statements; result pages and rankings read a constant number of queries', async () => {
    const id = await publishedTest('Large results round');
    const [q1, q2] = await questionsOf(id);
    // 5,000 students of Test School (verified) with an APPROVED final marking each (set-based inserts).
    await p().$executeRawUnsafe(`
      INSERT INTO "User" ("id", "username", "firstName", "lastName", "email", "role", "gradeLevel", "divisionId", "schoolId", "activatedAt", "isApproved", "updatedAt")
      SELECT 'pr-s-' || g, 'pr.s' || g, 'Perf' || g, 'Student', 'pr.s' || g || '@test.local', 'STUDENT', (CASE WHEN g % 2 = 0 THEN 'S2' ELSE 'S5' END)::"GradeLevel",
             '${ctx.ids.junior}', '${school}', now(), true, now()
        FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "source", "createdById", "status", "decidedById", "decidedAt", "createdAt")
      SELECT gen_random_uuid()::text, 'pr-s-' || g, '${school}', 'ADMIN', '${ctx.ids.admin}', 'VERIFIED', '${ctx.ids.admin}', now(), now() FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestSubmission" ("id", "testId", "studentId", "publicCode", "status", "versionCount", "createdAt", "updatedAt")
      SELECT 'pr-sub-' || g, '${id}', 'pr-s-' || g, 'R' || lpad(g::text, 4, '0') || '-' || upper(substr(md5(g::text), 1, 4)), 'APPROVED', 1, now(), now()
        FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestSubmissionVersion" ("id", "submissionId", "number", "clientKey", "submittedById", "submitterRole", "submittedAt", "applicableDeadline", "underExtension", "typedAnswer", "pageCount")
      SELECT 'pr-v-' || g, 'pr-sub-' || g, 1, 'k' || g, 'pr-s-' || g, 'STUDENT', now(), now(), false, 'x', 0 FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestMarkerAssignment" ("id", "submissionId", "kind", "coachId", "assignedAt", "method")
      SELECT 'pr-a-' || g, 'pr-sub-' || g, 'FIRST', '${c1Id}', now(), 'DISTRIBUTION' FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestMarking" ("id", "submissionId", "kind", "assignmentId", "markerId", "versionId", "status", "totalMarks", "submittedAt", "approvedAt", "createdAt", "updatedAt")
      SELECT 'pr-m-' || g, 'pr-sub-' || g, 'FIRST', 'pr-a-' || g, '${c1Id}', 'pr-v-' || g, 'DRAFT', NULL, NULL, NULL, now(), now() FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestMarkingScore" ("id", "markingId", "questionId", "marks", "updatedAt")
      SELECT gen_random_uuid()::text, 'pr-m-' || g, '${q1}', g % 6, now() FROM generate_series(1, 5000) g
      UNION ALL SELECT gen_random_uuid()::text, 'pr-m-' || g, '${q2}', g % 16, now() FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`UPDATE "TestMarking" SET "totalMarks" = (g % 6) + (g % 16), "status" = 'APPROVED', "submittedAt" = now(), "approvedAt" = now()
      FROM generate_series(1, 5000) g WHERE "id" = 'pr-m-' || g`);
    await p().$executeRawUnsafe(`UPDATE "TestSubmission" SET "currentVersionId" = 'pr-v-' || substr("id", 8), "finalMarkingId" = 'pr-m-' || substr("id", 8) WHERE "id" LIKE 'pr-sub-%'`);
    await closeNow(id);
    // Planner statistics for the bulk-inserted rows (a real database has them: autovacuum analyses new rows within a
    // minute; without them PostgreSQL plans these tables as if they were empty).
    await p().$executeRawUnsafe('ANALYZE "User", "StudentSchoolAffiliation", "TestSubmission", "TestSubmissionVersion", "TestMarkerAssignment", "TestMarking", "TestMarkingScore"');

    let queries = 0;
    (ctx.prisma as any).$on('query', () => { queries++; });
    await waitForEvents();
    queries = 0;
    const started = Date.now();
    const res = (await http().post(`${R(id)}/publish`).set(bearer(admin)).send({}).expect(200)).body;
    const elapsed = Date.now() - started;
    const publishQueries = queries;
    expect(res).toMatchObject({ replayed: false, published: 5000, publication: { number: 1, publishedCount: 5000 } });
    expect(elapsed).toBeLessThan(60_000);
    // A fixed number of statements whatever the number of results (the notices are 3 statements per 1,000).
    expect(publishQueries).toBeLessThan(80);
    expect(await p().testSubmission.count({ where: { testId: id, status: 'PUBLISHED' } })).toBe(5000);
    expect(await p().notificationOutbox.count({ where: { type: 'test.results.published', entityId: id } })).toBe(5001);   // 5,000 students + teacher.a once
    expect((await p().notificationOutbox.findFirstOrThrow({ where: { type: 'test.results.published', entityId: id, recipientUserId: tA } })).payload).toMatchObject({ count: 5000 });
    // Again: nothing new.
    expect((await http().post(`${R(id)}/publish`).set(bearer(admin)).send({}).expect(200)).body.replayed).toBe(true);
    expect(await p().notificationOutbox.count({ where: { type: 'test.results.published', entityId: id } })).toBe(5001);

    // While the 5,000 e-mails are being sent (one background worker, one at a time), the API keeps answering.
    const during = Date.now();
    await http().get(`${TR}/${id}?limit=5`).set(bearer(ta)).expect(200);
    await http().get(`${R(id)}/preview`).set(bearer(hm)).expect(200);
    expect(Date.now() - during).toBeLessThan(5_000);
    const sendStarted = Date.now();
    await waitForEvents();
    const sendElapsed = Date.now() - sendStarted;
    expect(await p().notificationOutbox.count({ where: { type: 'test.results.published', entityId: id, status: 'SENT' } })).toBe(5001);
    expect(sendElapsed).toBeLessThan(180_000);
    const count = async (fn: () => Promise<unknown>) => { await waitForEvents(); queries = 0; await fn(); return queries; };
    for (const path of [`${R(id)}?limit=1`, `${R(id)}/rankings?limit=1`, `${TR}/${id}?limit=1`]) {
      const token = path.startsWith(TR) ? ta : admin;
      await http().get(path).set(bearer(token)).expect(200);   // warm-up
      const small = await count(() => http().get(path.replace('limit=1', 'limit=5')).set(bearer(token)).expect(200));
      const large = await count(() => http().get(path.replace('limit=1', 'limit=100')).set(bearer(token)).expect(200));
      expect([path, small, large]).toEqual([path, small, small]);
    }
    for (const by of ['division', 'school']) {
      const ranked = (await http().get(`${R(id)}/rankings?by=${by}&limit=100`).set(bearer(admin)).expect(200)).body;
      expect(ranked.meta.total).toBe(5000);
      expect(ranked.data[0].rank).toBe(1);
    }
    const reportQ = await count(() => http().get(`${R(id)}/report`).set(bearer(admin)).expect(200));
    expect(reportQ).toBeLessThan(20);
    const rep = (await http().get(`${R(id)}/report`).set(bearer(admin)).expect(200)).body;
    expect(rep.summary.results).toBe(5000);
    expect(rep.distribution.reduce((a: number, b: any) => a + b.count, 0)).toBe(5000);
    const dash = await count(() => http().get('/api/v1/admin/test-dashboard').set(bearer(admin)).expect(200));
    expect(dash).toBeLessThan(30);
    const sd = await count(() => http().get('/api/v1/teacher/test-dashboard').set(bearer(ta)).expect(200));
    expect(sd).toBeLessThan(30);
  }, 240_000);
});
