/**
 * Test Management, Phase 2 (WS3; owner spec and plan approved 2026-11-19): the deadline service (database time),
 * extensions, student and teacher submissions with every version kept, tracking — and who may do what.
 *
 * Fixtures: Mathematics (seed) and Physics; Head Coach HM heads Mathematics, HP heads Physics. "Test School" (the seed's
 * school): student.j (S2) and student.j2 (S3) — VERIFIED; student.s (S5) — VERIFIED; student.p (S2) — claim PENDING.
 * "Other School": student.o (S2) — VERIFIED. Teachers: teacher.a (primary) and teacher.b (secondary) at Test School,
 * teacher.o at Other School. Coach mentor.j (seed).
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, PDF, EXE, waitForEvents, type TestContext } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4aa0000000049454e44ae426082', 'hex');
const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Test Management Phase 2 — deadlines, extensions, submissions (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, coach: string, sj: string, sj2: string, ss: string, so: string, ta: string, tb: string, to: string;
  let maths: string, physics: string, school: string, other: string;
  let stJ: string, stJ2: string, stS: string, stP: string, stO: string, tA: string, tB: string, tO: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  const ME = '/api/v1/me/tests';
  const TT = '/api/v1/teacher/tests';

  /** A published Mathematics test, open since an hour, closing in `closeIn` minutes. */
  const publishedTest = async (extra: Record<string, unknown> = {}, closeIn = 120, token = admin) => {
    const res = await http().post(T).set(bearer(token)).send({
      title: 'Round', subjectId: maths, division: 'JUNIOR', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(closeIn), maxMarks: 20,
      questions: [{ prompt: 'Prove it', maxMarks: 20 }], ...extra,
    }).expect(201);
    await http().post(`${T}/${res.body.id}/publish`).set(bearer(token)).expect(200);
    return res.body.id as string;
  };
  /** Move the test's own deadline into the past (database time), as if time had passed. */
  const closeNow = (id: string) => p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
  const uploadAs = (token: string, base: string, key: string, page: number, file: Buffer = PNG, name = 'IMG_0042 Aline.png') =>
    http().post(`${base}/uploads/${key}/pages/${page}`).set(bearer(token)).attach('file', file, name);
  const commit = (token: string, base: string, body: object) => http().post(`${base}/submission`).set(bearer(token)).send(body);
  const flags = /underExtension|"extended"|extensionId|extensionKind|applicableDeadline/;

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics', sortOrder: 1 } })).id;
    school = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    other = (await p().school.create({ data: { name: 'Other School', location: 'Huye' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'TEACHER' | 'STUDENT', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const claim = (studentId: string, schoolId: string, verified: boolean) => p().studentSchoolAffiliation.create({ data: {
      studentId, schoolId, source: 'ADMIN', createdById: ctx.ids.admin,
      ...(verified ? { status: 'VERIFIED', decidedById: ctx.ids.admin, decidedAt: new Date() } : { status: 'PENDING' }),
    } });
    const hmId = await mk('hc.maths', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    const hpId = await mk('hc.phys', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hpId, disciplineId: physics, source: 'MANUAL' } });
    stJ = ctx.ids.studentJunior; stJ2 = ctx.ids.studentJunior2; stS = ctx.ids.studentSenior;
    for (const s of [stJ, stJ2, stS]) await claim(s, school, true);
    stP = await mk('student.p', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: school, dateOfBirth: new Date('2011-01-01') });
    await claim(stP, school, false);
    stO = await mk('student.o', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: other, dateOfBirth: new Date('2011-01-01') });
    await claim(stO, other, true);
    tA = await mk('teacher.a', 'TEACHER');
    tB = await mk('teacher.b', 'TEACHER');
    tO = await mk('teacher.o', 'TEACHER');
    await p().teacherSchoolAssignment.createMany({ data: [
      { teacherId: tA, schoolId: school, role: 'PRIMARY' }, { teacherId: tB, schoolId: school, role: 'SECONDARY' }, { teacherId: tO, schoolId: other },
    ] });
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'hc.maths');
    hp = await login(ctx, 'hc.phys');
    coach = await login(ctx, 'mentor.j');
    sj = await login(ctx, 'student.j');
    sj2 = await login(ctx, 'student.j2');
    ss = await login(ctx, 'student.s');
    so = await login(ctx, 'student.o');
    ta = await login(ctx, 'teacher.a');
    tb = await login(ctx, 'teacher.b');
    to = await login(ctx, 'teacher.o');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('permissions per role: students only on /me/tests, teachers only on /teacher/tests, staff routes for Administrators and Head Coaches', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const k = randomUUID();
    const studentRoutes = [['get', ME], ['get', `${ME}/${id}`], ['get', `${ME}/${id}/paper`], ['get', `${ME}/${id}/uploads/${k}`],
      ['post', `${ME}/${id}/uploads/${k}/pages/1`], ['delete', `${ME}/${id}/uploads/${k}/pages/1`], ['post', `${ME}/${id}/submission`],
      ['get', `${ME}/${id}/versions/${id}/pages/1`]] as const;
    const teacherRoutes = [['get', TT], ['get', `${TT}/${id}/paper`], ['get', `${TT}/${id}/students`], ['get', `${TT}/${id}/students/${id}`],
      ['get', `${TT}/${id}/students/${id}/uploads/${k}`], ['post', `${TT}/${id}/students/${id}/uploads/${k}/pages/1`],
      ['delete', `${TT}/${id}/students/${id}/uploads/${k}/pages/1`], ['post', `${TT}/${id}/students/${id}/submission`],
      ['get', `${TT}/${id}/students/${id}/versions/${id}/pages/1`]] as const;
    const staffRoutes = [['get', `${T}/${id}/extensions`], ['get', `${T}/${id}/extension-targets?kind=STUDENT`], ['post', `${T}/${id}/extensions`],
      ['patch', `${T}/${id}/extensions/${id}`], ['post', `${T}/${id}/extensions/${id}/cancel`], ['get', `${T}/${id}/submissions`],
      ['get', `${T}/${id}/submissions/${id}`], ['get', `${T}/${id}/submissions/${id}/versions/${id}/pages/1`]] as const;
    const check = async (tokens: string[], routes: readonly (readonly [string, string])[]) => {
      for (const token of tokens) for (const [method, path] of routes) {
        expect([method, path, await status((http() as any)[method](path).set(bearer(token)).send({}))]).toEqual([method, path, [403, 'PERMISSION_REQUIRED']]);
      }
    };
    await check([ta, coach, admin, hm], studentRoutes);
    await check([sj, coach, admin, hm], teacherRoutes);
    await check([sj, ta, coach], staffRoutes);
    for (const [method, path] of [...studentRoutes, ...teacherRoutes, ...staffRoutes]) expect((await (http() as any)[method](path)).status).toBe(401);
  });

  describe('eligibility, formats, versions, idempotency, concurrency', () => {
    let id: string;
    const base = () => `${ME}/${id}`;

    beforeAll(async () => { id = await publishedTest({ title: 'Algebra round' }); });

    it('a student sees published tests of their division only; a draft or another division is not revealed', async () => {
      const draft = (await http().post(T).set(bearer(admin)).send({
        title: 'Draft', subjectId: maths, division: 'JUNIOR', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(60), maxMarks: 5,
      }).expect(201)).body.id;
      const senior = await publishedTest({ title: 'Senior only', division: 'SENIOR' });
      const mine = (await http().get(ME).set(bearer(sj)).expect(200)).body;
      expect(mine.data.map((t: any) => t.title)).toEqual(['Algebra round']);
      expect(mine.data[0]).toMatchObject({ window: 'OPEN', canSubmit: true, submission: null, answerFormat: 'BOTH' });
      expect((await http().get(ME).set(bearer(ss)).expect(200)).body.data.map((t: any) => t.title)).toEqual(['Senior only']);
      expect(await status(http().get(`${ME}/${draft}`).set(bearer(sj)))).toEqual([404, 'TEST_NOT_FOUND']);
      expect(await status(http().get(`${ME}/${senior}`).set(bearer(sj)))).toEqual([404, 'TEST_NOT_FOUND']);
      expect(await status(commit(ss, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([404, 'TEST_NOT_FOUND']);
      const detail = (await http().get(base()).set(bearer(sj)).expect(200)).body;
      expect(detail.test).toMatchObject({ title: 'Algebra round', window: 'OPEN', questions: [{ order: 1, prompt: 'Prove it', maxMarks: 20 }] });
      expect(detail.submission).toBeNull();
      await p().test.delete({ where: { id: draft } });
    });

    it('a test that has not opened yet: listed as UPCOMING, no questions, uploads and submissions refused (409 TEST_NOT_OPEN)', async () => {
      const later = (await http().post(T).set(bearer(admin)).send({
        title: 'Next week', subjectId: maths, division: 'ALL', answerFormat: 'TYPED_ONLY', opensAt: minutes(60), closesAt: minutes(120), maxMarks: 5,
        questions: [{ prompt: 'Secret', maxMarks: 5 }],
      }).expect(201)).body.id;
      await http().post(`${T}/${later}/publish`).set(bearer(admin)).expect(200);
      const view = (await http().get(`${ME}/${later}`).set(bearer(sj)).expect(200)).body;
      expect([view.test.window, view.test.questions, view.canSubmit]).toEqual(['UPCOMING', [], false]);
      expect(await status(commit(sj, `${ME}/${later}`, { clientKey: randomUUID(), typedAnswer: 'early' }))).toEqual([409, 'TEST_NOT_OPEN']);
      expect(await status(http().get(`${ME}/${later}/paper`).set(bearer(sj)))).toEqual([409, 'TEST_NOT_OPEN']);
      expect((await http().get(`${ME}?window=UPCOMING`).set(bearer(sj)).expect(200)).body.data.map((t: any) => t.title)).toEqual(['Next week']);
    });

    it('answer formats are enforced (typed only / upload only / both)', async () => {
      const typed = await publishedTest({ title: 'Typed', answerFormat: 'TYPED_ONLY' });
      const upload = await publishedTest({ title: 'Upload', answerFormat: 'UPLOAD_ONLY' });
      expect(await status(uploadAs(sj, `${ME}/${typed}`, randomUUID(), 1))).toEqual([400, 'UPLOAD_NOT_ALLOWED']);
      expect(await status(commit(sj, `${ME}/${typed}`, { clientKey: randomUUID(), typedAnswer: '   ' }))).toEqual([400, 'TYPED_ANSWER_REQUIRED']);
      expect(await status(commit(sj, `${ME}/${upload}`, { clientKey: randomUUID(), typedAnswer: 'text' }))).toEqual([400, 'TYPED_ANSWER_NOT_ALLOWED']);
      expect(await status(commit(sj, `${ME}/${upload}`, { clientKey: randomUUID() }))).toEqual([400, 'PAGES_REQUIRED']);
      expect(await status(commit(sj, base(), { clientKey: randomUUID() }))).toEqual([400, 'ANSWER_REQUIRED']);
      expect(await status(commit(sj, base(), { clientKey: 'not-a-uuid', typedAnswer: 'x' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(uploadAs(sj, `${ME}/${upload}`, randomUUID(), 1, EXE, 'virus.png'))).toEqual([415, 'FILE_TYPE_NOT_ALLOWED']);
      expect(await status(uploadAs(sj, `${ME}/${upload}`, randomUUID(), 31))).toEqual([400, 'TOO_MANY_PAGES']);
      // Nothing was created by any refusal.
      expect(await p().testSubmission.count()).toBe(0);
      const ok = (await commit(sj, `${ME}/${typed}`, { clientKey: randomUUID(), typedAnswer: 'x = 2' }).expect(201)).body;
      expect(ok.submission.versions[0]).toMatchObject({ number: 1, typedAnswer: 'x = 2', pageCount: 0, submitterRole: 'STUDENT' });
    });

    it('photos page by page: a weak connection retries one page; missing pages block the submission; then a typed + 2-page version', async () => {
      const key = randomUUID();
      let pending = (await uploadAs(sj, base(), key, 1).expect(201)).body;
      expect(pending.pages.map((x: any) => [x.page, x.name])).toEqual([[1, 'page-1.png']]);
      // Page 2 "fails" on the phone, then the retry of that one page succeeds (the same number replaces it).
      await uploadAs(sj, base(), key, 2, PNG).expect(201);
      pending = (await uploadAs(sj, base(), key, 2, PDF, 'scan.pdf').expect(201)).body;
      expect(pending.pages.map((x: any) => [x.page, x.mimeType])).toEqual([[1, 'image/png'], [2, 'application/pdf']]);
      expect((await http().get(`${base()}/uploads/${key}`).set(bearer(sj)).expect(200)).body.pages).toHaveLength(2);
      expect(await p().testAnswerPage.count({ where: { uploadKey: key } })).toBe(2);
      // The client says it sent 3 pages: page 3 is missing.
      const short = await commit(sj, base(), { clientKey: key, typedAnswer: 'See my pages', pageCount: 3 }).expect(409);
      expect([short.body.code, short.body.details.missing]).toEqual(['PAGES_INCOMPLETE', [3]]);
      const res = (await commit(sj, base(), { clientKey: key, typedAnswer: 'See my pages', pageCount: 2 }).expect(201)).body;
      expect(res.replayed).toBe(false);
      expect(res.submission).toMatchObject({ status: 'SUBMITTED', versionCount: 1, currentVersion: 1 });
      expect(res.submission.versions[0].pages.map((x: any) => x.name)).toEqual(['page-1.png', 'page-2.pdf']);
      // The committed key can no longer receive pages; a committed page is never removed.
      expect(await status(uploadAs(sj, base(), key, 3))).toEqual([409, 'UPLOAD_ALREADY_SUBMITTED']);
      expect(await status(http().delete(`${base()}/uploads/${key}/pages/1`).set(bearer(sj)))).toEqual([404, 'PAGE_NOT_FOUND']);
      // Pages are served under neutral names; no student name in the headers.
      const v1 = res.submission.versions[0].id;
      const dl = await http().get(`${base()}/versions/${v1}/pages/1?download=1`).set(bearer(sj)).expect(200);
      expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="page-1\.png"/);
      expect(JSON.stringify(dl.headers)).not.toMatch(/Aline|student\.j/);
      expect(Buffer.compare(dl.body, PNG)).toBe(0);
      // Another student cannot read it.
      expect(await status(http().get(`${base()}/versions/${v1}/pages/1`).set(bearer(sj2)))).toEqual([404, 'PAGE_NOT_FOUND']);
    });

    it('replace before the deadline: a new version; every version is kept and readable', async () => {
      const res = (await commit(sj, base(), { clientKey: randomUUID(), typedAnswer: 'Second thoughts' }).expect(201)).body;
      expect(res.submission.versions.map((v: any) => [v.number, v.typedAnswer, v.pageCount])).toEqual([[2, 'Second thoughts', 0], [1, 'See my pages', 2]]);
      expect(res.submission.currentVersion).toBe(2);
      const v1 = res.submission.versions[1].id;
      await http().get(`${base()}/versions/${v1}/pages/2`).set(bearer(sj)).expect(200);
      // Versions are append-only in the database itself.
      await expect(p().testSubmissionVersion.update({ where: { id: v1 }, data: { typedAnswer: 'forged' } })).rejects.toThrow(/append-only/);
      await expect(p().testSubmissionVersion.deleteMany({ where: { id: v1 } })).rejects.toThrow(/append-only/);
      await expect(p().testAnswerPage.updateMany({ where: { versionId: v1 }, data: { pageNumber: 9 } })).rejects.toThrow(/submitted version/);
      const history = await p().testSubmissionStatusChange.findMany({ where: { submission: { testId: id, studentId: stJ } } });
      expect(history.map((h) => [h.fromStatus, h.toStatus, h.actorRole])).toEqual([[null, 'SUBMITTED', 'STUDENT']]);
      await expect(p().testSubmissionStatusChange.deleteMany({ where: { id: history[0].id } })).rejects.toThrow(/append-only/);
    });

    it('idempotent: the same clientKey again (also in parallel) returns the same version, never a second one', async () => {
      const key = randomUUID();
      const first = (await commit(sj, base(), { clientKey: key, typedAnswer: 'Third' }).expect(201)).body;
      const again = (await commit(sj, base(), { clientKey: key, typedAnswer: 'Third (resent)' }).expect(201)).body;
      expect([first.replayed, again.replayed, again.submission.versionCount]).toEqual([false, true, 3]);
      expect(again.submission.versions[0].typedAnswer).toBe('Third');
      const key2 = randomUUID();
      const results = await Promise.all([1, 2, 3, 4].map(() => commit(sj, base(), { clientKey: key2, typedAnswer: 'Fourth' })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(results.filter((r) => r.body.replayed === false)).toHaveLength(1);
      expect(await p().testSubmissionVersion.count({ where: { clientKey: key2 } })).toBe(1);
    });

    it('10 parallel replacements: 10 new versions numbered without gap or duplicate; the current one is the last', async () => {
      const before = (await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: id, studentId: stJ } } })).versionCount;
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => commit(sj, base(), { clientKey: randomUUID(), typedAnswer: `parallel ${i}` })));
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
      const sub = await p().testSubmission.findUniqueOrThrow({
        where: { testId_studentId: { testId: id, studentId: stJ } }, include: { versions: { select: { id: true, number: true } }, currentVersion: { select: { number: true } } },
      });
      const numbers = sub.versions.map((v) => v.number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: before + 10 }, (_, i) => i + 1));
      expect([sub.versionCount, sub.currentVersion?.number]).toEqual([before + 10, before + 10]);
      expect(await p().testSubmission.count({ where: { testId: id, studentId: stJ } })).toBe(1);
    });
  });

  describe('teachers submit for verified students of their own schools (G2)', () => {
    let id: string;
    beforeAll(async () => { id = await publishedTest({ title: 'Teacher round' }); });

    it('lists tests and only their own verified students (not pending, not another school\'s)', async () => {
      const tests = (await http().get(TT).set(bearer(ta)).expect(200)).body;
      const row = tests.data.find((t: any) => t.id === id);
      expect(row).toMatchObject({ students: 2, submitted: 0, window: 'OPEN' });   // student.j, student.j2 (Junior); not student.s (Senior), not student.p (pending)
      const list = (await http().get(`${TT}/${id}/students`).set(bearer(ta)).expect(200)).body;
      expect(list.data.map((r: any) => r.student.username).sort()).toEqual(['student.j', 'student.j2']);
      expect(list.counts).toEqual({ students: 2, submitted: 0, notSubmitted: 2, lateBlocked: 0 });
      expect((await http().get(`${TT}/${id}/students`).set(bearer(to)).expect(200)).body.data.map((r: any) => r.student.username)).toEqual(['student.o']);
    });

    it('a primary AND a secondary teacher submit; another school\'s teacher or a pending student: 403 STUDENT_NOT_IN_SCOPE', async () => {
      const a = (await commit(ta, `${TT}/${id}/students/${stJ2}`, { clientKey: randomUUID(), typedAnswer: 'Typed by the teacher' }).expect(201)).body;
      expect(a.submission.versions[0]).toMatchObject({ number: 1, submitterRole: 'TEACHER', submittedBy: { firstName: 'teacher.a' } });
      const key = randomUUID();
      await uploadAs(tb, `${TT}/${id}/students/${stJ2}`, key, 1).expect(201);
      const b = (await commit(tb, `${TT}/${id}/students/${stJ2}`, { clientKey: key, pageCount: 1 }).expect(201)).body;
      expect(b.submission.versions.map((v: any) => [v.number, v.submittedBy.firstName])).toEqual([[2, 'teacher.b'], [1, 'teacher.a']]);
      expect(await status(commit(to, `${TT}/${id}/students/${stJ}`, { clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);
      expect(await status(http().get(`${TT}/${id}/students/${stJ}`).set(bearer(to)))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);
      expect(await status(uploadAs(to, `${TT}/${id}/students/${stJ}`, randomUUID(), 1))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);
      expect(await status(commit(ta, `${TT}/${id}/students/${stP}`, { clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);
      expect(await status(commit(ta, `${TT}/${id}/students/${stS}`, { clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([403, 'DIVISION_MISMATCH']);
      // Stored: the student owns it; the teacher is the submitter and the named teacher.
      const v = await p().testSubmissionVersion.findMany({ where: { submission: { testId: id, studentId: stJ2 } }, orderBy: { number: 'asc' } });
      expect(v.map((x) => [x.submitterRole, x.submittedById, x.teacherId])).toEqual([['TEACHER', tA, tA], ['TEACHER', tB, tB]]);
      // The student sees both versions (and who submitted them) on their own page.
      const mine = (await http().get(`${ME}/${id}`).set(bearer(sj2)).expect(200)).body;
      expect(mine.submission.versions.map((x: any) => x.submitterRole)).toEqual(['TEACHER', 'TEACHER']);
      // A suspended student disappears from the teacher's scope.
      await p().user.update({ where: { id: stJ2 }, data: { accountStatus: 'SUSPENDED' } });
      try {
        expect(await status(commit(ta, `${TT}/${id}/students/${stJ2}`, { clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);
      } finally {
        await p().user.update({ where: { id: stJ2 }, data: { accountStatus: 'ACTIVE' } });
      }
    });

    it('the course-assignment delegation is unchanged: teachers still cannot submit course work without it', async () => {
      expect(await status(http().post(`/api/v1/teacher/students/${stJ}/submissions`).set(bearer(ta)).send({}))).toEqual([403, 'PERMISSION_REQUIRED']);
    });
  });

  describe('deadlines (database time) and extensions', () => {
    let id: string;
    let studentExt: string, teacherExt: string;
    beforeAll(async () => { id = await publishedTest({ title: 'Deadline round' }); });

    it('after the deadline every submission and upload is refused (late: blocked)', async () => {
      await closeNow(id);
      expect(await status(commit(sj, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'late' }))).toEqual([409, 'DEADLINE_PASSED']);
      expect(await status(uploadAs(sj, `${ME}/${id}`, randomUUID(), 1))).toEqual([409, 'DEADLINE_PASSED']);
      expect(await status(commit(ta, `${TT}/${id}/students/${stJ}`, { clientKey: randomUUID(), typedAnswer: 'late' }))).toEqual([409, 'DEADLINE_PASSED']);
      expect((await http().get(`${ME}/${id}`).set(bearer(sj)).expect(200)).body).toMatchObject({ canSubmit: false, test: { window: 'CLOSED' } });
    });

    it('extensions: validated; a student extension reopens that student only; the original deadline never changes', async () => {
      const before = await p().test.findUniqueOrThrow({ where: { id } });
      const E = `${T}/${id}/extensions`;
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'STUDENT', studentId: stJ, newDeadline: minutes(60) }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'STUDENT', newDeadline: minutes(60), reason: 'Ill' }))).toEqual([400, 'EXTENSION_TARGET_REQUIRED']);
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'TEST', studentId: stJ, newDeadline: minutes(60), reason: 'Ill' }))).toEqual([400, 'EXTENSION_TARGET_NOT_ALLOWED']);
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'STUDENT', studentId: stJ, newDeadline: before.closesAt.toISOString(), reason: 'Ill' }))).toEqual([400, 'EXTENSION_NOT_LATER']);
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'STUDENT', studentId: stS, newDeadline: minutes(60), reason: 'Ill' }))).toEqual([400, 'STUDENT_NOT_IN_DIVISION']);
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'TEACHER', teacherId: stJ, newDeadline: minutes(60), reason: 'Ill' }))).toEqual([404, 'TEACHER_NOT_FOUND']);
      // The subject's Head Coach grants; another subject's Head Coach cannot.
      expect(await status(http().post(E).set(bearer(hp)).send({ kind: 'STUDENT', studentId: stJ, newDeadline: minutes(60), reason: 'Ill' }))).toEqual([403, 'SCOPE_FORBIDDEN']);
      const ext = (await http().post(E).set(bearer(hm)).send({ kind: 'STUDENT', studentId: stJ, newDeadline: minutes(30), reason: 'Power cut at home' }).expect(201)).body;
      studentExt = ext.id;
      expect(ext).toMatchObject({ kind: 'STUDENT', state: 'ACTIVE', reason: 'Power cut at home', student: { id: stJ }, grantedBy: { username: 'hc.maths' } });
      expect(await status(http().post(E).set(bearer(admin)).send({ kind: 'STUDENT', studentId: stJ, newDeadline: minutes(90), reason: 'Again' }))).toEqual([409, 'EXTENSION_ALREADY_ACTIVE']);
      // The student sees the new deadline before submitting — but no "extended" mark — and submits under the extension.
      const view = (await http().get(`${ME}/${id}`).set(bearer(sj)).expect(200)).body;
      expect([view.canSubmit, view.test.window, new Date(view.test.deadline).getTime()]).toEqual([true, 'OPEN', new Date(ext.newDeadline).getTime()]);
      expect(JSON.stringify(view)).not.toMatch(flags);
      const sub = (await commit(sj, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'On time thanks to the extension' }).expect(201)).body;
      expect(JSON.stringify(sub)).not.toMatch(flags);
      const stored = await p().testSubmissionVersion.findFirstOrThrow({ where: { submission: { testId: id, studentId: stJ } } });
      expect([stored.underExtension, stored.extensionId, stored.applicableDeadline.toISOString()]).toEqual([true, studentExt, ext.newDeadline]);
      // Another student is still blocked; the test's own deadline did not move.
      expect(await status(commit(sj2, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([409, 'DEADLINE_PASSED']);
      const after = await p().test.findUniqueOrThrow({ where: { id } });
      expect([after.closesAt, after.originalClosesAt]).toEqual([before.closesAt, before.originalClosesAt]);
    });

    it('a teacher extension: only that teacher\'s submissions; student + teacher extensions → the later one', async () => {
      const ext = (await http().post(`${T}/${id}/extensions`).set(bearer(admin)).send({ kind: 'TEACHER', teacherId: tA, newDeadline: minutes(45), reason: 'School exam week' }).expect(201)).body;
      teacherExt = ext.id;
      await commit(ta, `${TT}/${id}/students/${stJ2}`, { clientKey: randomUUID(), typedAnswer: 'by teacher A' }).expect(201);
      expect(await status(commit(tb, `${TT}/${id}/students/${stJ2}`, { clientKey: randomUUID(), typedAnswer: 'by teacher B' }))).toEqual([409, 'DEADLINE_PASSED']);
      expect(await status(commit(sj2, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'by the student' }))).toEqual([409, 'DEADLINE_PASSED']);
      // student.j has the student extension (30 min) and teacher A has 45 min: teacher A gets the later, 45 min.
      const forJ = (await http().get(`${TT}/${id}/students/${stJ}`).set(bearer(ta)).expect(200)).body;
      expect(new Date(forJ.test.deadline).getTime()).toBe(new Date(ext.newDeadline).getTime());
      expect(JSON.stringify(forJ)).not.toMatch(flags);
      const list = (await http().get(`${TT}/${id}/students`).set(bearer(tb)).expect(200)).body;
      expect(Object.fromEntries(list.data.map((r: any) => [r.student.username, r.state]))).toEqual({ 'student.j': 'SUBMITTED', 'student.j2': 'SUBMITTED' });
      expect(JSON.stringify(list)).not.toMatch(flags);
    });

    it('Administrators and Head Coaches see "extended" and the under-extension mark; the tracking counts and filters', async () => {
      const track = (await http().get(`${T}/${id}/submissions`).set(bearer(hm)).expect(200)).body;
      expect(track.counts).toMatchObject({ students: 4, submitted: 2, notSubmitted: 0, lateBlocked: 2, underExtension: 1, submittedUnderExtension: 2, submittedByTeacher: 1 });
      const row = (u: string) => track.data.find((r: any) => r.student.username === u);
      expect(row('student.j')).toMatchObject({ state: 'SUBMITTED', extended: true, extensionKind: 'STUDENT', submission: { current: { underExtension: true, submitterRole: 'STUDENT' } } });
      expect(row('student.j2')).toMatchObject({ state: 'SUBMITTED', extended: false, submission: { current: { submitterRole: 'TEACHER', teacher: { id: tA } } } });
      expect(row('student.p')).toMatchObject({ state: 'LATE_BLOCKED', submission: null });
      expect(row('student.j').submission.publicCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const only = async (query: string) => (await http().get(`${T}/${id}/submissions?${query}`).set(bearer(admin)).expect(200)).body.data.map((r: any) => r.student.username).sort();
      expect(await only('status=LATE_BLOCKED')).toEqual(['student.o', 'student.p']);
      expect(await only('status=UNDER_EXTENSION')).toEqual(['student.j']);
      expect(await only('status=SUBMITTED')).toEqual(['student.j', 'student.j2']);
      expect(await only(`schoolId=${other}`)).toEqual(['student.o']);
      expect(await only('division=SENIOR')).toEqual([]);
      expect(await only('q=j2')).toEqual(['student.j2']);
      const page2 = (await http().get(`${T}/${id}/submissions?limit=3&page=2`).set(bearer(admin)).expect(200)).body;
      expect([page2.data.length, page2.meta.total]).toEqual([1, 4]);
      expect(await status(http().get(`${T}/${id}/submissions`).set(bearer(hp)))).toEqual([403, 'SCOPE_FORBIDDEN']);
      // One submission: every version with submitter, teacher, applicable deadline, under-extension mark; status history.
      const detail = (await http().get(`${T}/${id}/submissions/${row('student.j2').submission.id}`).set(bearer(admin)).expect(200)).body;
      expect(detail.versions.map((v: any) => [v.number, v.submittedBy.username, v.teacher?.username ?? null, v.underExtension, v.extensionId])).toEqual([
        [1, 'teacher.a', 'teacher.a', true, teacherExt],
      ]);
      expect(detail.statusHistory.map((h: any) => h.toStatus)).toEqual(['SUBMITTED']);
      expect(detail.student).toMatchObject({ username: 'student.j2', school: { name: 'Test School' } });
    });

    it('edit and cancel before expiry, with reasons; a cancelled extension is ignored; an expired one cannot change', async () => {
      const E = `${T}/${id}/extensions`;
      expect(await status(http().patch(`${E}/${studentExt}`).set(bearer(admin)).send({ newDeadline: minutes(50) }))).toEqual([400, 'VALIDATION_FAILED']);
      const edited = (await http().patch(`${E}/${studentExt}`).set(bearer(admin)).send({ newDeadline: minutes(50), reason: 'Still no power' }).expect(200)).body;
      expect(edited).toMatchObject({ reason: 'Still no power', editedBy: { username: 'admin' }, state: 'ACTIVE' });
      const cancelled = (await http().post(`${E}/${studentExt}/cancel`).set(bearer(hm)).send({ reason: 'Granted by mistake' }).expect(200)).body;
      expect(cancelled).toMatchObject({ state: 'CANCELLED', cancelReason: 'Granted by mistake', cancelledBy: { username: 'hc.maths' } });
      expect(await status(http().post(`${E}/${studentExt}/cancel`).set(bearer(admin)).send({ reason: 'Again' }))).toEqual([409, 'EXTENSION_CANCELLED']);
      expect(await status(commit(sj, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'after the cancellation' }))).toEqual([409, 'DEADLINE_PASSED']);
      // Expired: its deadline has passed (database time).
      await p().testExtension.update({ where: { id: teacherExt }, data: { newDeadline: new Date(Date.now() - 1000) } });
      expect(await status(http().patch(`${E}/${teacherExt}`).set(bearer(admin)).send({ newDeadline: minutes(60), reason: 'More' }))).toEqual([409, 'EXTENSION_EXPIRED']);
      expect(await status(http().post(`${E}/${teacherExt}/cancel`).set(bearer(admin)).send({ reason: 'Late' }))).toEqual([409, 'EXTENSION_EXPIRED']);
      const list = (await http().get(`${E}?state=all`).set(bearer(admin)).expect(200)).body;
      expect(list.data.map((e: any) => [e.kind, e.state]).sort()).toEqual([['STUDENT', 'CANCELLED'], ['TEACHER', 'EXPIRED']]);
      expect((await http().get(E).set(bearer(admin)).expect(200)).body.meta.total).toBe(1);   // active = not cancelled
      // A whole-test extension reopens the test for everyone.
      await http().post(E).set(bearer(admin)).send({ kind: 'TEST', newDeadline: minutes(20), reason: 'Platform outage' }).expect(201);
      await commit(so, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'thanks to the outage extension' }).expect(201);
      const targets = (await http().get(`${T}/${id}/extension-targets?kind=STUDENT&q=student.j`).set(bearer(admin)).expect(200)).body;
      expect(targets.data.map((t: any) => t.username).sort()).toEqual(['student.j', 'student.j2']);
    });

    it('every extension write is audited (TESTS); the individual recipients are told once (dedupe), whole-test extensions notify nobody', async () => {
      const actions = (await p().auditLog.findMany({ where: { entity: 'TestExtension' }, select: { action: true } })).map((a) => a.action);
      expect(actions.sort()).toEqual(['TEST_EXTENSION_CANCELLED', 'TEST_EXTENSION_GRANTED', 'TEST_EXTENSION_GRANTED', 'TEST_EXTENSION_GRANTED', 'TEST_EXTENSION_UPDATED']);
      await waitForEvents();
      const outbox = await p().notificationOutbox.findMany({ where: { type: 'test.extension.granted' }, orderBy: { createdAt: 'asc' } });
      expect(outbox.map((o) => [o.recipientUserId, o.dedupeKey])).toEqual([[stJ, `test.extension.granted:${studentExt}`], [tA, `test.extension.granted:${teacherExt}`]]);
      const inApp = await p().notification.findMany({ where: { type: 'test.extension.granted' } });
      expect(inApp.map((n) => [n.userId, n.link]).sort()).toEqual([[stJ, '/student/tests'], [tA, '/teacher/tests']].sort());
      expect(inApp.find((n) => n.userId === stJ)?.body).toContain('Deadline round');
    });
  });

  describe('a test with submissions keeps its essentials (Phase 1 gaps closed)', () => {
    let id: string;
    beforeAll(async () => {
      id = await publishedTest({ title: 'Locked round' });
      await commit(sj, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'answer' }).expect(201);
    });

    it('unpublish and delete: 409 TEST_HAS_SUBMISSIONS', async () => {
      expect(await status(http().post(`${T}/${id}/unpublish`).set(bearer(admin)))).toEqual([409, 'TEST_HAS_SUBMISSIONS']);
      expect(await status(http().delete(`${T}/${id}`).set(bearer(admin)))).toEqual([409, 'TEST_HAS_SUBMISSIONS']);
      expect((await http().get(`${T}/${id}`).set(bearer(admin)).expect(200)).body).toMatchObject({ status: 'PUBLISHED', submissionCount: 1 });
    });

    it('deadline, format, division, window, marks, questions and paper are locked; title, wording and marking guide are not', async () => {
      const locked = await http().patch(`${T}/${id}`).set(bearer(admin)).send({ closesAt: minutes(600), answerFormat: 'TYPED_ONLY' }).expect(409);
      expect([locked.body.code, locked.body.details.fields]).toEqual(['TEST_LOCKED_BY_SUBMISSIONS', ['answerFormat', 'closesAt']]);
      expect(locked.body.message).toMatch(/extension/);
      for (const change of [{ division: 'ALL' }, { maxMarks: 25 }, { opensAt: minutes(-30) }]) {
        expect(await status(http().patch(`${T}/${id}`).set(bearer(admin)).send(change))).toEqual([409, 'TEST_LOCKED_BY_SUBMISSIONS']);
      }
      const t = (await http().get(`${T}/${id}`).set(bearer(admin)).expect(200)).body;
      // An unchanged value is not a change.
      await http().patch(`${T}/${id}`).set(bearer(admin)).send({ title: 'Locked round (renamed)', answerFormat: t.answerFormat, closesAt: t.closesAt }).expect(200);
      const q = t.questions[0].id;
      expect(await status(http().post(`${T}/${id}/questions`).set(bearer(admin)).send({ prompt: 'More', maxMarks: 1 }))).toEqual([409, 'TEST_LOCKED_BY_SUBMISSIONS']);
      expect(await status(http().delete(`${T}/${id}/questions/${q}`).set(bearer(admin)))).toEqual([409, 'TEST_LOCKED_BY_SUBMISSIONS']);
      expect(await status(http().put(`${T}/${id}/questions/order`).set(bearer(admin)).send({ questionIds: [q] }))).toEqual([409, 'TEST_LOCKED_BY_SUBMISSIONS']);
      expect(await status(http().patch(`${T}/${id}/questions/${q}`).set(bearer(admin)).send({ maxMarks: 19 }))).toEqual([409, 'TEST_LOCKED_BY_SUBMISSIONS']);
      await http().patch(`${T}/${id}/questions/${q}`).set(bearer(admin)).send({ prompt: 'Prove it (typo fixed)' }).expect(200);
      expect(await status(http().put(`${T}/${id}/files/paper`).set(bearer(admin)).attach('file', PDF, 'p.pdf'))).toEqual([409, 'TEST_LOCKED_BY_SUBMISSIONS']);
      await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'g.pdf').expect(200);
    });

    it('the paper: students and teachers read it once the test is open (neutral name); the marking guide never', async () => {
      const id2 = await publishedTest({ title: 'With paper' });
      await http().put(`${T}/${id2}/files/paper`).set(bearer(admin)).attach('file', PDF, 'Round 3 secret.pdf').expect(200);
      const dl = await http().get(`${ME}/${id2}/paper?download=1`).set(bearer(sj)).expect(200);
      expect(dl.headers['content-disposition']).toMatch(/filename="test-paper\.pdf"/);
      await http().get(`${TT}/${id2}/paper`).set(bearer(ta)).expect(200);
      expect((await http().get(`${ME}/${id2}`).set(bearer(sj)).expect(200)).body.test.hasPaper).toBe(true);
      expect((await http().get(`${ME}/${id2}/marking-guide`).set(bearer(sj))).status).toBe(404);
    });

    it('every submission write is audited (TESTS) with its actor; the TESTS category lists them', async () => {
      const rows = await p().auditLog.findMany({ where: { action: { in: ['TEST_SUBMITTED', 'TEST_SUBMISSION_REPLACED', 'TEST_ANSWER_PAGE_UPLOADED'] } }, select: { action: true, actorRole: true, metadata: true } });
      expect(new Set(rows.map((r) => r.actorRole))).toEqual(new Set(['STUDENT', 'TEACHER']));
      expect(rows.some((r) => r.action === 'TEST_SUBMISSION_REPLACED')).toBe(true);
      expect(JSON.stringify(rows)).not.toMatch(/See my pages|Second thoughts/);   // the answer itself is not copied into the audit log
      const res = await http().get('/api/v1/admin/audit-logs?category=TESTS&limit=100').set(bearer(admin)).expect(200);
      expect(res.body.data.some((a: any) => a.action === 'TEST_SUBMITTED')).toBe(true);
    });
  });

  it('existing course assignments are unaffected: their routes answer as before and no assignment row changed', async () => {
    const counts = async () => Promise.all([p().assignment.count(), p().submission.count(), p().mentorReview.count(), p().resultRelease.count(), p().course.count()]);
    const before = await counts();
    await http().get('/api/v1/assignments').set(bearer(admin)).expect(200);
    await http().get('/api/v1/me/assignments').set(bearer(sj)).expect(200);
    const id = await publishedTest({ title: 'Isolation round' });
    await commit(sj, `${ME}/${id}`, { clientKey: randomUUID(), typedAnswer: 'isolated' }).expect(201);
    expect(await counts()).toEqual(before);
  });
});
