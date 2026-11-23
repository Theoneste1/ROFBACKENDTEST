/**
 * Test Management, Phase 3 (WS3; owner spec and plan approved 2026-11-19): distribution (G5), blind marking, second
 * marking, review, approval, locking / unlocking, the mark-change log — and who may do what, on PostgreSQL.
 *
 * Fixtures: Mathematics (seed) and Physics; Head Coach HM heads Mathematics, HP heads Physics. Coaches mentor.j (C1) and
 * mentor.j2 (C2) are AUTHORISED to mark Mathematics; mentor.s (C3) is a Mathematics coach WITHOUT an authorisation.
 * "Test School": student.j (S2, VERIFIED) with teacher.a; student.j2 (S3) and student.s (S5) answer too.
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, PDF, waitForEvents, type TestContext } from './helpers.js';

/** The same photo carrying a PNG text chunk that names the student (as phone and scanner apps write). */
const textChunk = (() => {
  const data = Buffer.from(`Author${String.fromCharCode(0)}Aline Uwase, Test School`, 'latin1');
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write('tEXt', 4, 'latin1'); data.copy(b, 8);
  return b;
})();
/** A complete 1×1 PNG (signature, IHDR, IDAT, IEND), and the same with the naming text chunk after IHDR. */
const PNG_OK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PNG_NAMED = Buffer.concat([PNG_OK.subarray(0, 33), textChunk, PNG_OK.subarray(33)]);
const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Test Management Phase 3 — distribution, blind marking, review (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, c1: string, c2: string, c3: string, sj: string, sj2: string, ss: string, ta: string;
  let maths: string, school: string;
  let stJ: string, stJ2: string, stS: string, tA: string, tO: string, c1Id: string, c2Id: string, c3Id: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  const ME = '/api/v1/me/tests';
  const MK = '/api/v1/marking';
  const M = (id: string) => `${T}/${id}/marking`;

  /** A published test for every division, open since an hour: questions of 5 and 15 marks (20), or one total. */
  const publishedTest = async (opts: { questions?: boolean; closeIn?: number; title?: string } = {}) => {
    const res = await http().post(T).set(bearer(admin)).send({
      title: opts.title ?? 'Marking round', subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(opts.closeIn ?? 120),
      maxMarks: 20, ...(opts.questions !== false && { questions: [{ prompt: 'Q one', maxMarks: 5 }, { prompt: 'Q two', maxMarks: 15 }] }),
    }).expect(201);
    await http().put(`${T}/${res.body.id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'Guide by Mr Kamali.pdf').expect(200);
    if (opts.questions === false) await http().put(`${T}/${res.body.id}/files/paper`).set(bearer(admin)).attach('file', PDF, 'paper.pdf').expect(200);
    await http().post(`${T}/${res.body.id}/publish`).set(bearer(admin)).expect(200);
    return res.body.id as string;
  };
  /** The test's own deadline moves into the past (database time), as if time had passed. */
  const closeNow = (id: string) => p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
  const submitTyped = (token: string, id: string, text = 'My answer') =>
    http().post(`${ME}/${id}/submission`).set(bearer(token)).send({ clientKey: randomUUID(), typedAnswer: text }).expect(201);
  const submitWithPage = async (token: string, id: string) => {
    const key = randomUUID();
    await http().post(`${ME}/${id}/uploads/${key}/pages/1`).set(bearer(token)).attach('file', PNG_NAMED, 'IMG_0042 Aline Uwase Test School.png').expect(201);
    await http().post(`${ME}/${id}/submission`).set(bearer(token)).send({ clientKey: key, typedAnswer: 'see page', pageCount: 1 }).expect(201);
  };
  const subOf = (testId: string, studentId: string) => p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId } } });
  const questionsOf = async (testId: string) => (await p().testQuestion.findMany({ where: { testId }, orderBy: { order: 'asc' } })).map((q) => q.id);
  const marks = (q: string[], a: number | null, b: number | null, comment?: string) => ({
    scores: [{ questionId: q[0], marks: a, comment: comment ?? null }, { questionId: q[1], marks: b }],
  });

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    process.env.PRISMA_QUERY_EVENTS = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics', sortOrder: 1 } })).id;
    school = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    const other = (await p().school.create({ data: { name: 'Other School', location: 'Huye' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'TEACHER', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const hmId = await mk('hc.maths', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    const hpId = await mk('hc.phys', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hpId, disciplineId: physics, source: 'MANUAL' } });
    stJ = ctx.ids.studentJunior; stJ2 = ctx.ids.studentJunior2; stS = ctx.ids.studentSenior;
    c1Id = ctx.ids.mentorJunior; c2Id = ctx.ids.mentorJunior2; c3Id = ctx.ids.mentorSenior;
    await p().studentSchoolAffiliation.create({ data: { studentId: stJ, schoolId: school, source: 'ADMIN', createdById: ctx.ids.admin, status: 'VERIFIED', decidedById: ctx.ids.admin, decidedAt: new Date() } });
    tA = await mk('teacher.a', 'TEACHER');
    tO = await mk('teacher.o', 'TEACHER');
    await p().teacherSchoolAssignment.createMany({ data: [{ teacherId: tA, schoolId: school, role: 'PRIMARY' }, { teacherId: tO, schoolId: other }] });
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'hc.maths');
    hp = await login(ctx, 'hc.phys');
    c1 = await login(ctx, 'mentor.j');
    c2 = await login(ctx, 'mentor.j2');
    c3 = await login(ctx, 'mentor.s');
    sj = await login(ctx, 'student.j');
    sj2 = await login(ctx, 'student.j2');
    ss = await login(ctx, 'student.s');
    ta = await login(ctx, 'teacher.a');
    // C1 and C2 are authorised to mark Mathematics (by the subject's Head Coach); C3 is not.
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

  it('permissions per role and route: staff routes for Administrators and Head Coaches, choose for Head Coaches only (G4), /marking for Coaches only', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const code = 'ABCD-EFGH';
    const staff = [['get', M(id)], ['post', `${M(id)}/distribute`], ['post', `${M(id)}/assign`], ['get', `${M(id)}/submissions`],
      ['get', `${M(id)}/submissions/${id}`], ['post', `${M(id)}/submissions/${id}/reassign`], ['post', `${M(id)}/submissions/${id}/approve`],
      ['post', `${M(id)}/submissions/${id}/return`], ['post', `${M(id)}/submissions/${id}/second-marking`], ['post', `${M(id)}/submissions/${id}/unlock`],
      ['get', `${M(id)}/history`]] as const;
    const choose = [['post', `${M(id)}/submissions/${id}/choose`]] as const;
    const marker = [['get', `${MK}/queue`], ['get', `${MK}/submissions/${code}`], ['get', `${MK}/submissions/${code}/pages/1`],
      ['get', `${MK}/submissions/${code}/paper`], ['get', `${MK}/submissions/${code}/marking-guide`], ['put', `${MK}/submissions/${code}/marking`],
      ['post', `${MK}/submissions/${code}/marking/submit`]] as const;
    const check = async (tokens: string[], routes: readonly (readonly [string, string])[]) => {
      for (const token of tokens) for (const [method, path] of routes) {
        expect([method, path, await status((http() as any)[method](path).set(bearer(token)).send({}))]).toEqual([method, path, [403, 'PERMISSION_REQUIRED']]);
      }
    };
    await check([sj, ta, c1], staff);
    await check([sj, ta, c1, admin], choose);            // G4: Administrators never choose or adjust marks
    await check([sj, ta, admin, hm], marker);            // Administrators and Head Coaches never mark
    for (const [method, path] of [...staff, ...choose, ...marker]) expect((await (http() as any)[method](path)).status).toBe(401);
    // A Head Coach of another subject: the test is not theirs.
    const t = await publishedTest({ title: 'Scope check' });
    expect(await status(http().get(M(t)).set(bearer(hp)))).toEqual([403, 'SCOPE_FORBIDDEN']);
    expect(await status(http().get(`${M(t)}/submissions`).set(bearer(hp)))).toEqual([403, 'SCOPE_FORBIDDEN']);
    expect(await status(http().post(`${M(t)}/distribute`).set(bearer(hp)).send({ coachIds: [c1Id] }))).toEqual([403, 'SCOPE_FORBIDDEN']);
    expect((await http().get(M(t)).set(bearer(hm))).status).toBe(200);
    expect((await http().get(M(t)).set(bearer(admin))).status).toBe(200);
    // The coach's /me/permissions lists tests.mark; the Administrator's lists distribution and review, never marking.
    expect((await http().get('/api/v1/me/permissions').set(bearer(c1))).body.permissions).toContain('tests.mark');
    const adminPerms = (await http().get('/api/v1/me/permissions').set(bearer(admin))).body.permissions as string[];
    expect(adminPerms).toEqual(expect.arrayContaining(['tests.distribute', 'tests.review']));
    expect(adminPerms).not.toContain('tests.mark');
    expect(adminPerms).not.toContain('tests.adjustMarks');
    expect((await http().get('/api/v1/me/permissions').set(bearer(hm))).body.permissions).toEqual(expect.arrayContaining(['tests.distribute', 'tests.review', 'tests.adjustMarks']));
  });

  describe('one test from distribution to approval', () => {
    let id: string;
    let q: string[];
    let codeS: string, subS: string;
    const courseBefore: Record<string, number> = {};

    beforeAll(async () => {
      for (const [k, n] of Object.entries({ assignment: await p().assignment.count(), submission: await p().submission.count(), review: await p().mentorReview.count() })) courseBefore[k] = n;
      id = await publishedTest();
      q = await questionsOf(id);
      await submitWithPage(ss, id);
      await submitTyped(sj, id, 'Answer of j');
      await submitTyped(sj2, id, 'Answer of j2');
      // A student extension for j2 and a teacher extension for the teacher of j's school, while the test is open.
      await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'STUDENT', studentId: stJ2, newDeadline: minutes(240), reason: 'Illness' }).expect(201);
      await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'TEACHER', teacherId: tA, newDeadline: minutes(240), reason: 'Network down at school' }).expect(201);
    });

    it('G5: nothing is markable before the deadline; then only submissions whose latest deadline (extensions included) has passed', async () => {
      let o = (await http().get(M(id)).set(bearer(hm)).expect(200)).body;
      expect(o.distribution).toMatchObject({ readyToAssign: 0, waitingForDeadline: 3 });
      expect((await http().post(`${M(id)}/distribute`).set(bearer(hm)).send({ coachIds: [c1Id, c2Id] }).expect(200)).body).toMatchObject({ assigned: 0, waitingForDeadline: 3 });
      await closeNow(id);
      o = (await http().get(M(id)).set(bearer(hm)).expect(200)).body;
      // s: ready; j2: own extension; j: the extension of a teacher of j's verified school (a replacement could still come).
      expect(o.distribution).toMatchObject({ readyToAssign: 1, waitingForDeadline: 2 });
      expect(o.distribution.nextEligibleAt).not.toBeNull();
      subS = (await subOf(id, stS)).id;
      const subJ2 = (await subOf(id, stJ2)).id;
      const early = await http().post(`${M(id)}/assign`).set(bearer(hm)).send({ submissionIds: [subJ2], coachId: c1Id });
      expect([early.status, early.body.code]).toEqual([409, 'NOT_YET_MARKABLE']);
      // Manual assignment of the markable one; an unauthorised coach is refused with the reason.
      const bad = await http().post(`${M(id)}/assign`).set(bearer(hm)).send({ submissionIds: [subS], coachId: c3Id });
      expect([bad.status, bad.body.code, bad.body.details.coaches]).toEqual([400, 'COACH_NOT_AUTHORIZED', [{ coachId: c3Id, problem: 'NOT_AUTHORIZED' }]]);
      expect((await http().post(`${M(id)}/assign`).set(bearer(hm)).send({ submissionIds: [subS], coachId: c1Id, reason: 'Page photo' }).expect(200)).body).toEqual({ assigned: 1, alreadyAssigned: 0 });
      // Idempotent: the same assignment again changes nothing.
      expect((await http().post(`${M(id)}/assign`).set(bearer(hm)).send({ submissionIds: [subS], coachId: c1Id }).expect(200)).body).toEqual({ assigned: 0, alreadyAssigned: 1 });
      expect(await status(http().post(`${M(id)}/assign`).set(bearer(hm)).send({ submissionIds: [subS], coachId: c2Id }))).toEqual([409, 'ALREADY_ASSIGNED']);
      expect((await subOf(id, stS)).status).toBe('ASSIGNED');
    });

    it('once marking began, nothing can arrive for that student: submit refused; a later deadline for them refused (MARKING_STARTED); an unrelated teacher\'s extension still allowed', async () => {
      expect((await http().post(`${ME}/${id}/submission`).set(bearer(ss)).send({ clientKey: randomUUID(), typedAnswer: 'late' })).status).toBe(409);
      expect(await status(http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'STUDENT', studentId: stS, newDeadline: minutes(300), reason: 'Please' })))
        .toEqual([409, 'MARKING_STARTED']);
      expect(await status(http().post(`${T}/${id}/extensions`).set(bearer(admin)).send({ kind: 'TEST', newDeadline: minutes(300), reason: 'Everyone' })))
        .toEqual([409, 'MARKING_STARTED']);
      await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'TEACHER', teacherId: tO, newDeadline: minutes(300), reason: 'Other school' }).expect(201);
    });

    it('distribution: evenly between the chosen coaches (existing load included), audited, each coach told once', async () => {
      // The extensions expire (as if time had passed).
      await p().$executeRaw`UPDATE "TestExtension" SET "newDeadline" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "testId" = ${id}`;
      const key = randomUUID();
      const res = (await http().post(`${M(id)}/distribute`).set(bearer(hm)).send({ coachIds: [c1Id, c2Id], clientKey: key }).expect(200)).body;
      expect(res.assigned).toBe(2);
      const totals = Object.fromEntries(res.coaches.map((c: any) => [c.coachId, c.total]));
      expect([totals[c1Id], totals[c2Id]].sort()).toEqual([1, 2]);   // 3 submissions, 2 coaches: within one
      // A retry with the same key: nothing left, nobody told twice.
      expect((await http().post(`${M(id)}/distribute`).set(bearer(hm)).send({ coachIds: [c1Id, c2Id], clientKey: key }).expect(200)).body.assigned).toBe(0);
      await waitForEvents();
      const outbox = await p().notificationOutbox.findMany({ where: { type: 'test.marking.assigned' } });
      expect(outbox.filter((o) => o.dedupeKey.startsWith(`test.marking.assigned:${key}:`)).length).toBe(2);
      const notes = await p().notification.findMany({ where: { type: 'test.marking.assigned' } });
      for (const n of notes) expect(`${n.title} ${n.body}`).not.toMatch(/student\.|Test School|Uwase/);
      const audit = await p().auditLog.findFirst({ where: { action: 'TEST_MARKING_DISTRIBUTED', entityId: id }, orderBy: { createdAt: 'desc' } });
      expect(audit).not.toBeNull();
      const o = (await http().get(M(id)).set(bearer(admin)).expect(200)).body;
      expect(o.counts.byStatus).toEqual({ ASSIGNED: 3 });
      expect(o.coaches.filter((c: any) => c.assigned > 0).map((c: any) => c.notStarted).reduce((a: number, b: number) => a + b, 0)).toBe(3);
      expect(o.coaches.find((c: any) => c.coach.id === c3Id)).toBeUndefined();   // not authorised, no assignment
    });

    it('BLIND: the marker sees the code, the test and the answer — never a name, school, submitter, extension or time; neutral file names and headers', async () => {
      const queue = (await http().get(`${MK}/queue`).set(bearer(c1)).expect(200)).body;
      expect(queue.counts.notStarted).toBeGreaterThanOrEqual(1);
      codeS = (await subOf(id, stS)).publicCode;
      expect(queue.data.map((r: any) => r.code)).toContain(codeS);
      const detail = (await http().get(`${MK}/submissions/${codeS}`).set(bearer(c1)).expect(200)).body;
      expect(detail).toMatchObject({ code: codeS, state: 'NOT_STARTED', canEdit: true, myMarking: null });
      expect(detail.test.questions.map((x: any) => x.maxMarks)).toEqual([5, 15]);
      expect(detail.test.markingGuide).toMatchObject({ name: `${detail.test.title} - marking guide.pdf` });
      expect(detail.answer.pages).toEqual([{ page: 1, name: 'page-1.png', mimeType: 'image/png', size: PNG_NAMED.length }]);
      const json = JSON.stringify([queue, detail]);
      for (const leak of ['student.s', 'student.j', stS, stJ, 'Test School', school, 'Uwase', 'IMG_0042', 'underExtension', '"extended"', 'submittedBy',
        'submitterRole', 'teacher', 'Guide by', 'email', 'lastName', 'submittedAt', 'deadline']) {
        expect([leak, json.includes(leak)]).toEqual([leak, false]);
      }
      for (const path of [`${MK}/submissions/${codeS}/pages/1?download=1`, `${MK}/submissions/${codeS}/marking-guide`, `${MK}/submissions/${codeS}/pages/1`]) {
        const file = await http().get(path).set(bearer(c1)).buffer(true).parse((res, cb) => { res.on('data', () => {}); res.on('end', () => cb(null, null)); });
        expect(file.status).toBe(200);
        const headers = JSON.stringify(file.headers);
        expect(headers).toMatch(/page-1\.png| - marking guide\.pdf/);   // the guide: named after the test's title; never the uploader's name
        for (const leak of ['student', 'Uwase', 'IMG_0042', 'Test School', stS, 'Kamali', 'Guide by']) expect([path, leak, headers.includes(leak)]).toEqual([path, leak, false]);
      }
      // The file itself: the marker's copy has no identifying metadata; the stored original (staff) is unchanged.
      const asBytes = (req: any) => req.buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      const markerCopy: Buffer = (await asBytes(http().get(`${MK}/submissions/${codeS}/pages/1`).set(bearer(c1)))).body;
      expect(markerCopy.equals(PNG_OK)).toBe(true);
      expect(markerCopy.toString('latin1')).not.toContain('Uwase');
      const versionId = (await subOf(id, stS)).currentVersionId!;
      const original: Buffer = (await asBytes(http().get(`${T}/${id}/submissions/${subS}/versions/${versionId}/pages/1`).set(bearer(hm)))).body;
      expect(original.equals(PNG_NAMED)).toBe(true);
      // The reviewer sees who it is.
      const review = (await http().get(`${M(id)}/submissions/${subS}`).set(bearer(hm)).expect(200)).body;
      expect(review.student).toMatchObject({ id: stS, username: 'student.s', school: { name: 'Test School' } });
    });

    it('every marker request checks the assignment: another coach, an unknown code, a malformed code → 403', async () => {
      expect(await status(http().get(`${MK}/submissions/${codeS}`).set(bearer(c2)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
      expect(await status(http().get(`${MK}/submissions/${codeS}/pages/1`).set(bearer(c2)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
      expect(await status(http().put(`${MK}/submissions/${codeS}/marking`).set(bearer(c2)).send(marks(q, 1, 1)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
      expect(await status(http().get(`${MK}/submissions/ZZZZ-ZZZZ`).set(bearer(c1)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
      expect(await status(http().get(`${MK}/submissions/not-a-code`).set(bearer(c1)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
      expect(await status(http().get(`${MK}/submissions/${codeS}`).set(bearer(c3)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
    });

    it('marks: whole numbers, never above the maxima; drafts; 10 parallel draft saves apply one after another; every change logged', async () => {
      const put = (body: object, token = c1) => http().put(`${MK}/submissions/${codeS}/marking`).set(bearer(token)).send(body);
      expect(await status(put(marks(q, 6, 1)))).toEqual([400, 'MARKS_EXCEED_MAXIMUM']);
      expect(await status(put(marks(q, 2.5, 1)))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(put(marks(q, -1, 1)))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(put({ totalMarks: 10 }))).toEqual([400, 'TOTAL_NOT_ALLOWED']);
      expect(await status(put({ scores: [{ questionId: randomUUID(), marks: 1 }] }))).toEqual([400, 'QUESTION_NOT_IN_TEST']);
      const first = (await put({ ...marks(q, 3, null, 'Good start') }).expect(200)).body;
      expect(first).toMatchObject({ state: 'IN_PROGRESS', myMarking: { status: 'DRAFT', totalMarks: 3 } });
      expect((await subOf(id, stS)).status).toBe('MARKING_IN_PROGRESS');
      const rev = first.myMarking.revision;
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => put(marks(q, 4, i))));
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      const after = (await http().get(`${MK}/submissions/${codeS}`).set(bearer(c1)).expect(200)).body.myMarking;
      expect(after.revision).toBe(rev + 10);
      expect(after.scores.find((s: any) => s.questionId === q[0]).marks).toBe(4);
      // The status changed once (ASSIGNED → MARKING_IN_PROGRESS); each save is audited; every mark change is logged.
      const sub = await subOf(id, stS);
      expect(await p().testSubmissionStatusChange.count({ where: { submissionId: sub.id, toStatus: 'MARKING_IN_PROGRESS' } })).toBe(1);
      expect(await p().auditLog.count({ where: { action: 'TEST_MARKING_DRAFT_SAVED', metadata: { path: ['submissionId'], equals: sub.id } } })).toBe(11);
      const changes = await p().testMarkChange.findMany({ where: { marking: { submissionId: sub.id }, questionId: q[1] }, orderBy: { createdAt: 'asc' } });
      expect(changes.length).toBeGreaterThanOrEqual(9);
      expect(changes.every((c) => c.changedById === c1Id && c.changedByRole === 'MENTOR')).toBe(true);
      // A stale screen: the revision it started from is not the current one.
      expect(await status(put({ ...marks(q, 4, 9), expectedRevision: rev }))).toEqual([409, 'MARKING_CHANGED']);
    });

    it('submit for approval: every question marked; the same submission again is a replay; then the marks are locked', async () => {
      const submit = (body: object) => http().post(`${MK}/submissions/${codeS}/marking/submit`).set(bearer(c1)).send(body);
      expect(await status(submit(marks(q, 4, null)))).toEqual([400, 'MARKS_INCOMPLETE']);
      const done = (await submit(marks(q, 4, 11, 'Good start')).expect(200)).body;
      expect(done).toMatchObject({ state: 'MARKED', canEdit: false, replayed: false, myMarking: { status: 'SUBMITTED', totalMarks: 15 } });
      expect((await subOf(id, stS)).status).toBe('MARKED');
      expect((await submit(marks(q, 4, 11, 'Good start')).expect(200)).body.replayed).toBe(true);
      expect(await status(submit(marks(q, 5, 11)))).toEqual([409, 'MARKING_SUBMITTED']);
      expect(await status(http().put(`${MK}/submissions/${codeS}/marking`).set(bearer(c1)).send(marks(q, 1, 1)))).toEqual([409, 'MARKING_SUBMITTED']);
      // The database refuses too.
      const m = await p().testMarking.findFirstOrThrow({ where: { submission: { id: subS }, kind: 'FIRST' } });
      await expect(p().$executeRaw`UPDATE "TestMarking" SET "totalMarks" = 1 WHERE "id" = ${m.id}`).rejects.toThrow(/locked/);
      await expect(p().$executeRaw`UPDATE "TestMarkingScore" SET "marks" = 1 WHERE "markingId" = ${m.id}`).rejects.toThrow(/locked/);
    });

    it('return for correction needs a comment; the marker sees it, corrects, resubmits', async () => {
      expect(await status(http().post(`${M(id)}/submissions/${subS}/return`).set(bearer(hm)).send({}))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(`${M(id)}/submissions/${subS}/return`).set(bearer(hm)).send({ comment: '  ' }))).toEqual([400, 'VALIDATION_FAILED']);
      const r = (await http().post(`${M(id)}/submissions/${subS}/return`).set(bearer(admin)).send({ comment: 'Question 2 deserves more.' }).expect(200)).body;
      expect(r.status).toBe('RETURNED');
      await waitForEvents();
      expect(await p().notificationOutbox.count({ where: { type: 'test.marking.returned', recipientUserId: c1Id } })).toBe(1);
      const mine = (await http().get(`${MK}/submissions/${codeS}`).set(bearer(c1)).expect(200)).body;
      expect(mine).toMatchObject({ state: 'IN_PROGRESS', canEdit: true, myMarking: { status: 'RETURNED', returnComment: 'Question 2 deserves more.' } });
      expect((await http().get(`${MK}/queue?state=IN_PROGRESS`).set(bearer(c1)).expect(200)).body.data.find((x: any) => x.code === codeS)).toMatchObject({ returned: true });
      await http().put(`${MK}/submissions/${codeS}/marking`).set(bearer(c1)).send(marks(q, 4, 13, 'Good start')).expect(200);
      expect((await subOf(id, stS)).status).toBe('MARKING_IN_PROGRESS');
      await http().post(`${MK}/submissions/${codeS}/marking/submit`).set(bearer(c1)).send(marks(q, 4, 13, 'Good start')).expect(200);
      expect((await subOf(id, stS)).status).toBe('MARKED');
    });

    it('second marking: another authorised coach only; independent and blind (no first marks); then a choice is required', async () => {
      const ask = (body: object, token = hm) => http().post(`${M(id)}/submissions/${subS}/second-marking`).set(bearer(token)).send(body);
      expect(await status(ask({ coachId: c1Id }))).toEqual([409, 'SAME_MARKER']);
      expect(await status(ask({ coachId: c3Id }))).toEqual([400, 'COACH_NOT_AUTHORIZED']);
      expect((await ask({ coachId: c2Id, reason: 'Borderline' }, admin).expect(200)).body.status).toBe('AWAITING_SECOND_MARKING');
      expect(await status(ask({ coachId: c2Id }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      const second = (await http().get(`${MK}/submissions/${codeS}`).set(bearer(c2)).expect(200)).body;
      expect(second).toMatchObject({ code: codeS, state: 'NOT_STARTED', myMarking: null, canEdit: true });
      const json = JSON.stringify(second);
      for (const leak of ['Good start', '"totalMarks":17', 'mentor.j', 'firstMarking', 'markings']) expect([leak, json.includes(leak)]).toEqual([leak, false]);
      // C1's own view is read-only and shows only C1's marks.
      expect((await http().get(`${MK}/submissions/${codeS}`).set(bearer(c1)).expect(200)).body).toMatchObject({ canEdit: false, myMarking: { totalMarks: 17 } });
      await http().post(`${MK}/submissions/${codeS}/marking/submit`).set(bearer(c2)).send(marks(q, 5, 9, 'Second view')).expect(200);
      expect((await subOf(id, stS)).status).toBe('MARKED');
      // Side by side for the reviewer.
      const detail = (await http().get(`${M(id)}/submissions/${subS}`).set(bearer(hm)).expect(200)).body;
      expect(detail.markings.filter((m: any) => m.status === 'SUBMITTED').map((m: any) => [m.kind, m.totalMarks]).sort()).toEqual([['FIRST', 17], ['SECOND', 14]]);
      expect(detail.actions).toMatchObject({ approve: true, choose: true, requestSecondMarking: false, unlock: false });
      expect(await status(http().post(`${M(id)}/submissions/${subS}/approve`).set(bearer(hm)).send({}))).toEqual([409, 'MARK_CHOICE_REQUIRED']);
    });

    it('G4: an Administrator never chooses or adjusts; the Head Coach chooses with a mandatory reason, or adjusts (logged old → new)', async () => {
      const choose = (body: object, token = hm) => http().post(`${M(id)}/submissions/${subS}/choose`).set(bearer(token)).send(body);
      expect(await status(choose({ source: 'ADJUSTMENT', reason: 'Fair', marks: marks(q, 5, 10) }, admin))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(choose({ source: 'FIRST', reason: 'Fair' }, admin))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(choose({ source: 'FIRST' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(choose({ source: 'ADJUSTMENT', reason: 'Fair' }))).toEqual([400, 'MARKS_REQUIRED']);
      expect(await status(choose({ source: 'ADJUSTMENT', reason: 'Fair', marks: marks(q, 5, 16) }))).toEqual([400, 'MARKS_EXCEED_MAXIMUM']);
      expect((await choose({ source: 'SECOND', reason: 'Closer to the guide' }).expect(200)).body.markings.find((m: any) => m.final).kind).toBe('SECOND');
      const adj = (await choose({ source: 'ADJUSTMENT', reason: 'Between the two', marks: marks(q, 5, 10) }).expect(200)).body;
      const final = adj.markings.find((m: any) => m.final);
      expect(final).toMatchObject({ kind: 'ADJUSTMENT', totalMarks: 15, status: 'SUBMITTED' });
      // The adjustment's log: against the marks it replaces (the chosen second marking: 5, 9 → 5, 10), with the reason.
      const log = adj.markChanges.filter((c: any) => c.markingId === final.id);
      expect(log.map((c: any) => [c.oldMarks, c.newMarks, c.reason])).toEqual([[9, 10, 'Between the two']]);
      expect(adj.reviews.filter((r: any) => r.action === 'MARK_CHOSEN').map((r: any) => r.comment)).toEqual(['Closer to the guide', 'Between the two']);
      expect(adj.status).toBe('MARKED');
    });

    it('approve locks; unlock needs a reason (Administrator or subject Head Coach), audited; approve again', async () => {
      const ap = (await http().post(`${M(id)}/submissions/${subS}/approve`).set(bearer(admin)).send({}).expect(200)).body;
      expect(ap.status).toBe('APPROVED');
      expect(ap.markings.find((m: any) => m.final)).toMatchObject({ kind: 'ADJUSTMENT', status: 'APPROVED' });
      expect(await status(http().post(`${M(id)}/submissions/${subS}/return`).set(bearer(hm)).send({ comment: 'Again' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(await status(http().post(`${M(id)}/submissions/${subS}/choose`).set(bearer(hm)).send({ source: 'FIRST', reason: 'x y z' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(await status(http().post(`${M(id)}/submissions/${subS}/unlock`).set(bearer(hm)).send({}))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(`${M(id)}/submissions/${subS}/unlock`).set(bearer(hp)).send({ reason: 'Not mine' }))).toEqual([403, 'SCOPE_FORBIDDEN']);
      const un = (await http().post(`${M(id)}/submissions/${subS}/unlock`).set(bearer(hm)).send({ reason: 'Recount question 2' }).expect(200)).body;
      expect(un.status).toBe('MARKED');
      expect(un.markings.find((m: any) => m.final)).toMatchObject({ kind: 'ADJUSTMENT', status: 'SUBMITTED' });
      expect(await p().auditLog.count({ where: { action: 'TEST_MARKING_UNLOCKED', entityId: subS } })).toBe(1);
      const again = (await http().post(`${M(id)}/submissions/${subS}/approve`).set(bearer(hm)).send({ clientKey: randomUUID() }).expect(200)).body;
      expect(again.status).toBe('APPROVED');
      // Every step is in the history, each an allowed transition; the review list shows the approved total.
      const statuses = again.statusHistory.map((h: any) => `${h.fromStatus}>${h.toStatus}`);
      expect(statuses).toEqual([
        'null>SUBMITTED', 'SUBMITTED>ASSIGNED', 'ASSIGNED>MARKING_IN_PROGRESS', 'MARKING_IN_PROGRESS>MARKED', 'MARKED>RETURNED',
        'RETURNED>MARKING_IN_PROGRESS', 'MARKING_IN_PROGRESS>MARKED', 'MARKED>AWAITING_SECOND_MARKING', 'AWAITING_SECOND_MARKING>MARKED',
        'MARKED>MARKED', 'MARKED>MARKED', 'MARKED>APPROVED', 'APPROVED>MARKED', 'MARKED>APPROVED',
      ]);
      const list = (await http().get(`${M(id)}/submissions?status=APPROVED`).set(bearer(hm)).expect(200)).body;
      expect(list.data.map((r: any) => [r.student.username, r.final.totalMarks])).toEqual([['student.s', 15]]);
      // The history tab: status changes, the mark-change log, the decisions.
      for (const type of ['status', 'marks', 'reviews']) {
        const h = (await http().get(`${M(id)}/history?type=${type}&submissionId=${subS}`).set(bearer(admin)).expect(200)).body;
        expect([type, h.meta.total > 0]).toEqual([type, true]);
      }
    });

    it('two reviewers approve at the same moment: one succeeds, the other gets 409; a repeated clientKey is a replay', async () => {
      const others = await p().testSubmission.findMany({ where: { testId: id, studentId: { in: [stJ, stJ2] } }, include: { markerAssignments: { where: { endedAt: null } } } });
      const target = others[0];
      const coachToken = target.markerAssignments[0].coachId === c1Id ? c1 : c2;
      const code = target.publicCode;
      await http().post(`${MK}/submissions/${code}/marking/submit`).set(bearer(coachToken)).send(marks(q, 2, 2)).expect(200);
      const [a, b] = await Promise.all([
        http().post(`${M(id)}/submissions/${target.id}/approve`).set(bearer(hm)).send({}),
        http().post(`${M(id)}/submissions/${target.id}/approve`).set(bearer(admin)).send({}),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a, b].find((r) => r.status === 409)!.body.code).toBe('INVALID_STATUS_TRANSITION');
      expect(await p().testReview.count({ where: { submissionId: target.id, action: 'APPROVED' } })).toBe(1);
      const key = randomUUID();
      await http().post(`${M(id)}/submissions/${target.id}/unlock`).set(bearer(admin)).send({ reason: 'Check', clientKey: key }).expect(200);
      const replay = (await http().post(`${M(id)}/submissions/${target.id}/unlock`).set(bearer(admin)).send({ reason: 'Check', clientKey: key }).expect(200)).body;
      expect(replay).toMatchObject({ replayed: true, status: 'MARKED' });
      expect(await p().testReview.count({ where: { submissionId: target.id, action: 'UNLOCKED' } })).toBe(1);
      expect(await status(http().post(`${M(id)}/submissions/${target.id}/approve`).set(bearer(hm)).send({ expectedStatus: 'APPROVED' }))).toEqual([409, 'SUBMISSION_CHANGED']);
    });

    it('reassignment (reason): the new coach starts fresh and never sees the previous draft; the previous coach is refused', async () => {
      const target = await p().testSubmission.findFirstOrThrow({ where: { testId: id, status: 'ASSIGNED' }, include: { markerAssignments: { where: { endedAt: null } } } });
      const fromId = target.markerAssignments[0].coachId;
      const [fromToken, toId, toToken] = fromId === c1Id ? [c1, c2Id, c2] : [c2, c1Id, c1];
      await http().put(`${MK}/submissions/${target.publicCode}/marking`).set(bearer(fromToken)).send(marks(q, 1, 1, 'draft of the first coach')).expect(200);
      expect(await status(http().post(`${M(id)}/submissions/${target.id}/reassign`).set(bearer(hm)).send({ coachId: toId }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(`${M(id)}/submissions/${target.id}/reassign`).set(bearer(hm)).send({ coachId: c3Id, reason: 'Holiday' }))).toEqual([400, 'COACH_NOT_AUTHORIZED']);
      const re = (await http().post(`${M(id)}/submissions/${target.id}/reassign`).set(bearer(hm)).send({ coachId: toId, reason: 'Holiday' }).expect(200)).body;
      expect(re.status).toBe('ASSIGNED');
      expect(re.assignments.map((a: any) => [a.coach.id, a.current, a.endReason])).toEqual([[fromId, false, 'Holiday'], [toId, true, null]]);
      expect(await status(http().get(`${MK}/submissions/${target.publicCode}`).set(bearer(fromToken)))).toEqual([403, 'MARKING_NOT_ASSIGNED']);
      const fresh = (await http().get(`${MK}/submissions/${target.publicCode}`).set(bearer(toToken)).expect(200)).body;
      expect(fresh.myMarking).toBeNull();
      expect(JSON.stringify(fresh)).not.toContain('draft of the first coach');
    });

    it('authorisation revoked mid-way: every marker request is refused at once; the queue drops that subject', async () => {
      const target = await p().testSubmission.findFirstOrThrow({ where: { testId: id, markerAssignments: { some: { coachId: c2Id, endedAt: null } } } });
      const auth = await p().markerAuthorization.findFirstOrThrow({ where: { coachId: c2Id, disciplineId: maths, revokedAt: null } });
      await http().post(`/api/v1/admin/test-markers/${auth.id}/revoke`).set(bearer(hm)).send({ reason: 'Conflict of interest' }).expect(200);
      for (const [method, path] of [['get', `${MK}/submissions/${target.publicCode}`], ['get', `${MK}/submissions/${target.publicCode}/pages/1`],
        ['get', `${MK}/submissions/${target.publicCode}/marking-guide`], ['put', `${MK}/submissions/${target.publicCode}/marking`],
        ['post', `${MK}/submissions/${target.publicCode}/marking/submit`]] as const) {
        expect([path, await status((http() as any)[method](path).set(bearer(c2)).send(marks(q, 1, 1)))]).toEqual([path, [403, 'MARKER_NOT_AUTHORIZED']]);
      }
      expect((await http().get(`${MK}/queue`).set(bearer(c2)).expect(200)).body.meta.total).toBe(0);
      // Distribution refuses the coach too; the overview shows them as not authorised.
      expect(await status(http().post(`${M(id)}/distribute`).set(bearer(hm)).send({ coachIds: [c2Id] }))).toEqual([400, 'COACH_NOT_AUTHORIZED']);
      expect((await http().get(M(id)).set(bearer(hm)).expect(200)).body.coaches.find((c: any) => c.coach.id === c2Id)).toMatchObject({ authorised: false });
      await http().post('/api/v1/admin/test-markers').set(bearer(hm)).send({ coachId: c2Id, subjectId: maths }).expect(201);
      expect((await http().get(`${MK}/submissions/${target.publicCode}`).set(bearer(c2))).status).toBe(200);
    });

    it('the database keeps the history: assignments, the mark-change log and the decisions are append-only', async () => {
      const a = await p().testMarkerAssignment.findFirstOrThrow({ where: { endedAt: { not: null } } });
      await expect(p().$executeRaw`DELETE FROM "TestMarkerAssignment" WHERE "id" = ${a.id}`).rejects.toThrow(/never deleted/);
      await expect(p().$executeRaw`UPDATE "TestMarkerAssignment" SET "endReason" = 'x' WHERE "id" = ${a.id}`).rejects.toThrow(/never changes/);
      await expect(p().$executeRaw`UPDATE "TestMarkerAssignment" SET "coachId" = ${c3Id} WHERE "endedAt" IS NULL`).rejects.toThrow(/facts never change/);
      await expect(p().$executeRaw`UPDATE "TestMarkChange" SET "newMarks" = 0`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`DELETE FROM "TestMarkChange"`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`UPDATE "TestReview" SET "comment" = 'x'`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`DELETE FROM "TestReview"`).rejects.toThrow(/append-only/);
      await expect(p().$executeRaw`DELETE FROM "TestMarking"`).rejects.toThrow(/never deleted/);
      // A draft's marks above a question's maximum are refused by the database itself.
      const draft = await p().testMarking.findFirstOrThrow({ where: { status: 'DRAFT' } });
      await expect(p().$executeRaw`UPDATE "TestMarkingScore" SET "marks" = 99 WHERE "markingId" = ${draft.id}`).rejects.toThrow(/exceed/);
      await expect(p().$executeRaw`UPDATE "TestMarking" SET "totalMarks" = 21 WHERE "id" = ${draft.id}`).rejects.toThrow(/exceed/);
    });

    it('the course-assignment pipeline is untouched (rows, the coach\'s grading permission)', async () => {
      expect({ assignment: await p().assignment.count(), submission: await p().submission.count(), review: await p().mentorReview.count() }).toEqual(courseBefore);
      const perms = (await http().get('/api/v1/me/permissions').set(bearer(c1)).expect(200)).body.permissions;
      expect(perms).toEqual(expect.arrayContaining(['reviews.grade', 'assignments.prepare']));
      expect((await http().get('/api/v1/me/teaching').set(bearer(c1))).status).toBe(200);
    });
  });

  it('a test without questions is marked as one total, never above the test maximum', async () => {
    const id = await publishedTest({ questions: false, title: 'One total' });
    await submitTyped(sj, id, 'Total answer');
    await closeNow(id);
    await http().post(`${M(id)}/distribute`).set(bearer(admin)).send({ coachIds: [c1Id] }).expect(200);
    const code = (await subOf(id, stJ)).publicCode;
    const put = (body: object) => http().put(`${MK}/submissions/${code}/marking`).set(bearer(c1)).send(body);
    expect(await status(put({ totalMarks: 21 }))).toEqual([400, 'MARKS_EXCEED_MAXIMUM']);
    expect(await status(put({ scores: [{ questionId: randomUUID(), marks: 1 }] }))).toEqual([400, 'SCORES_NOT_ALLOWED']);
    await put({ totalMarks: 12, comment: 'Clear' }).expect(200);
    const done = (await http().post(`${MK}/submissions/${code}/marking/submit`).set(bearer(c1)).send({ totalMarks: 20 }).expect(200)).body;
    expect(done.myMarking).toMatchObject({ status: 'SUBMITTED', totalMarks: 20 });
    const log = await p().testMarkChange.findMany({ where: { marking: { submission: { publicCode: code } } }, orderBy: { createdAt: 'asc' } });
    expect(log.map((c) => [c.questionId, c.oldMarks, c.newMarks])).toEqual([[null, null, 12], [null, 12, 20]]);
  });

  it('performance sanity: 5,000 submissions over 20 coaches — even (±1), quick, and list pages read a constant number of queries', async () => {
    const id = await publishedTest({ title: 'Large round' });
    // 5,000 students with a submitted answer each (set-based inserts), 20 authorised coaches.
    await p().$executeRawUnsafe(`
      INSERT INTO "User" ("id", "username", "firstName", "lastName", "email", "role", "gradeLevel", "divisionId", "activatedAt", "updatedAt")
      SELECT 'perf-s-' || g, 'perf.s' || g, 'Perf' || g, 'Student', 'perf.s' || g || '@test.local', 'STUDENT', 'S2', '${ctx.ids.junior}', now(), now()
        FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestSubmission" ("id", "testId", "studentId", "publicCode", "status", "versionCount", "createdAt", "updatedAt")
      SELECT 'perf-sub-' || g, '${id}', 'perf-s-' || g, 'P' || lpad(g::text, 4, '0') || '-' || upper(substr(md5(g::text), 1, 4)), 'SUBMITTED', 1, now(), now()
        FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "TestSubmissionVersion" ("id", "submissionId", "number", "clientKey", "submittedById", "submitterRole", "submittedAt", "applicableDeadline", "underExtension", "typedAnswer", "pageCount")
      SELECT 'perf-v-' || g, 'perf-sub-' || g, 1, 'k' || g, 'perf-s-' || g, 'STUDENT', now(), now(), false, 'x', 0 FROM generate_series(1, 5000) g`);
    await p().$executeRawUnsafe(`UPDATE "TestSubmission" SET "currentVersionId" = 'perf-v-' || substr("id", 10) WHERE "id" LIKE 'perf-sub-%'`);
    await p().$executeRawUnsafe(`
      INSERT INTO "User" ("id", "username", "firstName", "lastName", "email", "role", "activatedAt", "updatedAt")
      SELECT gen_random_uuid()::text, 'perf.c' || g, 'Coach' || g, 'Perf', 'perf.c' || g || '@test.local', 'MENTOR', now(), now() FROM generate_series(1, 20) g`);
    await p().$executeRawUnsafe(`
      INSERT INTO "MarkerAuthorization" ("id", "coachId", "disciplineId", "grantedAt")
      SELECT gen_random_uuid()::text, "id", '${maths}', now() FROM "User" WHERE "username" LIKE 'perf.c%'`);
    await closeNow(id);
    const coachIds = (await p().user.findMany({ where: { username: { startsWith: 'perf.c' } }, orderBy: { username: 'asc' }, select: { id: true } })).map((c) => c.id);
    expect(coachIds).toHaveLength(20);
    let queries = 0;
    (ctx.prisma as any).$on('query', () => { queries++; });
    const started = Date.now();
    const res = (await http().post(`${M(id)}/distribute`).set(bearer(admin)).send({ coachIds }).expect(200)).body;
    const elapsed = Date.now() - started;
    const distributionQueries = queries;   // the request itself (notices are sent after the response)
    expect(res.assigned).toBe(5000);
    const sizes = res.coaches.map((c: any) => c.assigned);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBe(5000);
    expect(elapsed).toBeLessThan(60_000);
    // A fixed number of statements whatever the number of submissions (≈ a few per coach for the notices).
    expect(distributionQueries).toBeLessThan(200);
    // Background work (the coaches' notices are sent after the response) settles first, so only the request is counted.
    const count = async (fn: () => Promise<unknown>) => { await waitForEvents(); queries = 0; await fn(); return queries; };
    await http().get(`${M(id)}/submissions?limit=1`).set(bearer(admin)).expect(200);   // warm-up
    const small = await count(() => http().get(`${M(id)}/submissions?limit=5`).set(bearer(admin)).expect(200));
    const large = await count(() => http().get(`${M(id)}/submissions?limit=100`).set(bearer(admin)).expect(200));
    expect([small, large]).toEqual([small, small]);
    const overviewQ = await count(() => http().get(M(id)).set(bearer(admin)).expect(200));
    expect(overviewQ).toBeLessThan(30);
    // A coach's queue: 250 assignments, pages of 10 and 100 cost the same.
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    await p().user.update({ where: { username: 'perf.c1' }, data: { passwordHash: hash } });
    const pc = await login(ctx, 'perf.c1');
    await http().get(`${MK}/queue?limit=1`).set(bearer(pc)).expect(200);   // warm-up: the first request of a new session does one-off work
    const q10 = await count(() => http().get(`${MK}/queue?limit=10`).set(bearer(pc)).expect(200));
    const q100 = await count(() => http().get(`${MK}/queue?limit=100`).set(bearer(pc)).expect(200));
    expect([q10, q100]).toEqual([q10, q10]);
    expect((await http().get(`${MK}/queue?limit=1`).set(bearer(pc)).expect(200)).body.counts.total).toBe(250);
  }, 180_000);
});
