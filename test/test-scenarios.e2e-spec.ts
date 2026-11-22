/**
 * Test Management (WS3) — the owner's required scenarios (spec §14) that need more than the phase specs check, on
 * PostgreSQL: several Head Coaches of one subject (9), another subject's Head Coach on EVERY action (7, 41, 51), losing
 * Head Coach status (10), a coach authorised for another subject (1), the marking guide (17), upload limits (16),
 * extensions — teacher scope, whole test, editing, audit (19, 20, 24, 25), extension information in every marker response
 * (26), non-student accounts (27), submission times (30), audit of every marking step (40), approved marks locked (42).
 * Traceability: docs/tests/test-management-scenarios.md.
 *
 * Fixtures: Mathematics (seed) and Physics. Head Coaches HM and HM2 head Mathematics; HP heads Physics; HX headed
 * Mathematics until removed. Coaches C1, C2 authorised for Mathematics; C3 authorised for Physics only. "Test School":
 * student.j (S2), student.j2 (S3) VERIFIED, teacher.a; student.s (S5) VERIFIED; student.p (S2) PENDING. "Other School":
 * student.o (S2) VERIFIED, teacher.o.
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, PDF, waitForEvents, type TestContext } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Anything that tells a marker about an extension or when / by whom an answer arrived. */
const EXTENSION_LEAK = /underExtension|"extended"|extensionId|extensionKind|applicableDeadline|"deadline"|submittedAt|teacher|Exam clash/i;

describe('Test Management — the owner\'s scenarios beyond the phase specs (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hm2: string, hp: string, hx: string, c1: string, c2: string, c3: string;
  let sj: string, sj2: string, so: string, ta: string, to: string;
  let maths: string, physics: string, school: string, other: string;
  let stJ: string, stJ2: string, stS: string, stP: string, stO: string, tA: string, tO: string, hmId: string, hm2Id: string, hxId: string;
  let c1Id: string, c2Id: string, c3Id: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  const ME = '/api/v1/me/tests';
  const TT = '/api/v1/teacher/tests';
  const MK = '/api/v1/marking';
  const M = (id: string) => `${T}/${id}/marking`;

  const createTest = async (token: string, opts: { subjectId?: string; title?: string; division?: string; closeIn?: number } = {}) => {
    const res = await http().post(T).set(bearer(token)).send({
      title: opts.title ?? 'Scenario round', subjectId: opts.subjectId ?? maths, division: opts.division ?? 'ALL', answerFormat: 'BOTH',
      opensAt: minutes(-60), closesAt: minutes(opts.closeIn ?? 120), maxMarks: 20,
      questions: [{ prompt: 'Q one', maxMarks: 5 }, { prompt: 'Q two', maxMarks: 15 }],
    }).expect(201);
    await http().put(`${T}/${res.body.id}/files/marking-guide`).set(bearer(token)).attach('file', PDF, 'guide.pdf').expect(200);
    await http().post(`${T}/${res.body.id}/publish`).set(bearer(token)).expect(200);
    return res.body.id as string;
  };
  const closeNow = (id: string) => p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
  const submitTyped = (token: string, id: string, text = 'answer') => http().post(`${ME}/${id}/submission`).set(bearer(token)).send({ clientKey: randomUUID(), typedAnswer: text });
  const subOf = (testId: string, studentId: string) => p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId } } });
  const questionsOf = async (testId: string) => (await p().testQuestion.findMany({ where: { testId }, orderBy: { order: 'asc' } })).map((q) => q.id);
  const marks = (q: string[], a: number, b: number) => ({ scores: [{ questionId: q[0], marks: a, comment: 'ok' }, { questionId: q[1], marks: b }] });

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
      (await p().user.create({ data: { username, firstName: username, lastName: 'Scenario', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const claim = (studentId: string, schoolId: string, verified: boolean) => p().studentSchoolAffiliation.create({ data: {
      studentId, schoolId, source: 'ADMIN', createdById: ctx.ids.admin,
      ...(verified ? { status: 'VERIFIED', decidedById: ctx.ids.admin, decidedAt: new Date() } : { status: 'PENDING' }) } });
    hmId = await mk('hc.maths', 'HEAD_COACH');
    hm2Id = await mk('hc.maths2', 'HEAD_COACH');
    hxId = await mk('hc.former', 'HEAD_COACH');
    const hpId = await mk('hc.phys', 'HEAD_COACH');
    for (const userId of [hmId, hm2Id, hxId]) await p().programmeMembership.create({ data: { userId, disciplineId: maths, source: 'MANUAL' } });
    await p().programmeMembership.create({ data: { userId: hpId, disciplineId: physics, source: 'MANUAL' } });
    stJ = ctx.ids.studentJunior; stJ2 = ctx.ids.studentJunior2; stS = ctx.ids.studentSenior;
    for (const s of [stJ, stJ2, stS]) await claim(s, school, true);
    stP = await mk('student.p', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: school, dateOfBirth: new Date('2011-01-01') });
    await claim(stP, school, false);
    stO = await mk('student.o', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: other, dateOfBirth: new Date('2011-01-01') });
    await claim(stO, other, true);
    tA = await mk('teacher.a', 'TEACHER');
    tO = await mk('teacher.o', 'TEACHER');
    await p().teacherSchoolAssignment.createMany({ data: [{ teacherId: tA, schoolId: school, role: 'PRIMARY' }, { teacherId: tO, schoolId: other, role: 'PRIMARY' }] });
    c1Id = ctx.ids.mentorJunior; c2Id = ctx.ids.mentorJunior2; c3Id = ctx.ids.mentorSenior;
    // mentor.s also coaches Physics (a programme member there), so the Physics Head Coach may authorise them.
    await p().programmeMembership.create({ data: { userId: c3Id, disciplineId: physics, source: 'MANUAL' } });
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'hc.maths');
    hm2 = await login(ctx, 'hc.maths2');
    hx = await login(ctx, 'hc.former');
    hp = await login(ctx, 'hc.phys');
    c1 = await login(ctx, 'mentor.j');
    c2 = await login(ctx, 'mentor.j2');
    c3 = await login(ctx, 'mentor.s');
    sj = await login(ctx, 'student.j');
    sj2 = await login(ctx, 'student.j2');
    so = await login(ctx, 'student.o');
    ta = await login(ctx, 'teacher.a');
    to = await login(ctx, 'teacher.o');
    for (const coachId of [c1Id, c2Id]) await http().post('/api/v1/admin/test-markers').set(bearer(hm)).send({ coachId, subjectId: maths }).expect(201);
    await http().post('/api/v1/admin/test-markers').set(bearer(hp)).send({ coachId: c3Id, subjectId: physics }).expect(201);
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('scenario 9: two Head Coaches of the same subject may each act on the other\'s work; every action records exactly which one acted', async () => {
    const id = await createTest(hm, { title: 'Two heads' });
    await http().patch(`${T}/${id}`).set(bearer(hm2)).send({ title: 'Two heads (edited)' }).expect(200);
    const ext = (await http().post(`${T}/${id}/extensions`).set(bearer(hm2)).send({ kind: 'STUDENT', studentId: stJ2, newDeadline: minutes(240), reason: 'Illness' }).expect(201)).body;
    await http().post(`${T}/${id}/extensions/${ext.id}/cancel`).set(bearer(hm)).send({ reason: 'Recovered early' }).expect(200);
    await submitTyped(sj, id).expect(201);
    await closeNow(id);
    await http().post(`${M(id)}/distribute`).set(bearer(hm2)).send({ coachIds: [c1Id] }).expect(200);
    const q = await questionsOf(id);
    const code = (await subOf(id, stJ)).publicCode;
    await http().put(`${MK}/submissions/${code}/marking`).set(bearer(c1)).send(marks(q, 3, 9)).expect(200);
    await http().post(`${MK}/submissions/${code}/marking/submit`).set(bearer(c1)).send(marks(q, 3, 9)).expect(200);
    const sid = (await subOf(id, stJ)).id;
    await http().post(`${M(id)}/submissions/${sid}/return`).set(bearer(hm)).send({ comment: 'Check question 2 again' }).expect(200);
    await http().put(`${MK}/submissions/${code}/marking`).set(bearer(c1)).send(marks(q, 3, 10)).expect(200);
    await http().post(`${MK}/submissions/${code}/marking/submit`).set(bearer(c1)).send(marks(q, 3, 10)).expect(200);
    await http().post(`${M(id)}/submissions/${sid}/choose`).set(bearer(hm2)).send({ source: 'FIRST', reason: 'Corrected marks are right' }).expect(200);
    await http().post(`${M(id)}/submissions/${sid}/approve`).set(bearer(hm)).send({}).expect(200);
    await http().post(`${T}/${id}/results/publish`).set(bearer(hm2)).send({}).expect(200);
    const who = async (action: string, entityId?: string) => (await p().auditLog.findMany({ where: { action, ...(entityId && { entityId }) } })).map((a) => a.actorId);
    expect(await who('TEST_CREATED', id)).toEqual([hmId]);
    expect(await who('TEST_UPDATED', id)).toEqual([hm2Id]);
    expect(await who('TEST_EXTENSION_GRANTED', ext.id)).toEqual([hm2Id]);
    expect(await who('TEST_EXTENSION_CANCELLED', ext.id)).toEqual([hmId]);
    expect(await who('TEST_MARKING_DISTRIBUTED', id)).toEqual([hm2Id]);
    expect(await who('TEST_MARKING_RETURNED', sid)).toEqual([hmId]);
    expect(await who('TEST_MARK_CHOSEN', sid)).toEqual([hm2Id]);
    expect(await who('TEST_MARKING_APPROVED', sid)).toEqual([hmId]);
    expect(await who('TEST_RESULTS_PUBLISHED', id)).toEqual([hm2Id]);
    expect((await p().testReview.findMany({ where: { submissionId: sid }, orderBy: { createdAt: 'asc' } })).map((r) => [r.action, r.actorId]))
      .toEqual([['RETURNED', hmId], ['MARK_CHOSEN', hm2Id], ['APPROVED', hmId]]);
    expect((await p().testPublication.findFirstOrThrow({ where: { testId: id } })).publishedById).toBe(hm2Id);
  });

  it('scenarios 7, 41, 51: another subject\'s Head Coach is refused on EVERY action of a test they do not head — tests, markers, extensions, submissions, marking, review, approval, results, rankings', async () => {
    const id = await createTest(hm, { title: 'Not for Physics' });
    const ext = (await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'STUDENT', studentId: stJ2, newDeadline: minutes(240), reason: 'Illness' }).expect(201)).body;
    await submitTyped(sj, id).expect(201);
    await closeNow(id);
    await http().post(`${T}/${id}/extensions/${ext.id}/cancel`).set(bearer(hm)).send({ reason: 'Not needed' }).expect(200);
    await http().post(`${M(id)}/distribute`).set(bearer(hm)).send({ coachIds: [c1Id] }).expect(200);
    const sid = (await subOf(id, stJ)).id;
    const vid = (await subOf(id, stJ)).currentVersionId!;
    const routes: Array<[string, string, object?]> = [
      ['get', `${T}/${id}`], ['patch', `${T}/${id}`, { title: 'Renamed by Physics' }], ['delete', `${T}/${id}`], ['post', `${T}/${id}/unpublish`],
      ['post', `${T}/${id}/questions`, { prompt: 'Extra question', maxMarks: 1 }], ['get', `${T}/${id}/files/marking-guide`],
      ['get', `${T}/${id}/extensions`], ['post', `${T}/${id}/extensions`, { kind: 'TEST', newDeadline: minutes(300), reason: 'Everyone' }],
      ['patch', `${T}/${id}/extensions/${ext.id}`, { reason: 'Change it' }], ['post', `${T}/${id}/extensions/${ext.id}/cancel`, { reason: 'Cancel it' }],
      ['get', `${T}/${id}/submissions`], ['get', `${T}/${id}/submissions/${sid}`], ['get', `${T}/${id}/submissions/${sid}/versions/${vid}/pages/1`],
      ['get', M(id)], ['post', `${M(id)}/distribute`, { coachIds: [c3Id] }], ['post', `${M(id)}/assign`, { submissionIds: [sid], coachId: c3Id }],
      ['get', `${M(id)}/submissions`], ['get', `${M(id)}/submissions/${sid}`], ['get', `${M(id)}/history`],
      ['post', `${M(id)}/submissions/${sid}/reassign`, { coachId: c3Id, reason: 'Take over' }], ['post', `${M(id)}/submissions/${sid}/approve`, {}],
      ['post', `${M(id)}/submissions/${sid}/return`, { comment: 'Again' }], ['post', `${M(id)}/submissions/${sid}/second-marking`, { coachId: c3Id }],
      ['post', `${M(id)}/submissions/${sid}/choose`, { source: 'FIRST', reason: 'Because' }], ['post', `${M(id)}/submissions/${sid}/unlock`, { reason: 'Because' }],
      ['get', `${T}/${id}/results`], ['get', `${T}/${id}/results/preview`], ['post', `${T}/${id}/results/publish`, {}], ['get', `${T}/${id}/results/publications`],
      ['get', `${T}/${id}/results/rankings`], ['get', `${T}/${id}/results/report`], ['get', `${T}/${id}/results/export.csv`],
    ];
    for (const [method, path, body] of routes) {
      expect([method, path, await status((http() as any)[method](path).set(bearer(hp)).send(body ?? {}))]).toEqual([method, path, [403, 'SCOPE_FORBIDDEN']]);
    }
    // Marker authorisations of a subject they do not head.
    expect(await status(http().post('/api/v1/admin/test-markers').set(bearer(hp)).send({ coachId: c3Id, subjectId: maths }))).toEqual([403, 'SCOPE_FORBIDDEN']);
    // Nothing changed.
    expect((await p().test.findUniqueOrThrow({ where: { id } })).title).toBe('Not for Physics');
    expect((await subOf(id, stJ)).status).toBe('ASSIGNED');
    expect(await p().testPublication.count({ where: { testId: id } })).toBe(0);
    // The subject's own Head Coach and an Administrator are allowed (a sample).
    for (const token of [hm, admin]) expect((await http().get(`${T}/${id}/results/preview`).set(bearer(token))).status).toBe(200);
  });

  it('scenario 10: a Head Coach removed from the subject loses every Test Management action at once (tests, extensions, submissions, review, publication, rankings)', async () => {
    const id = await createTest(hx, { title: 'Former head' });
    await submitTyped(sj, id).expect(201);
    const sid = (await subOf(id, stJ)).id;
    expect((await http().get(`${T}/${id}/submissions`).set(bearer(hx))).status).toBe(200);
    expect((await http().get(`${T}/${id}/results/preview`).set(bearer(hx))).status).toBe(200);
    await p().programmeMembership.updateMany({ where: { userId: hxId, disciplineId: maths }, data: { isActive: false, endedAt: new Date(), endedById: ctx.ids.admin } });
    for (const [method, path, body] of [
      ['get', `${T}/${id}`], ['patch', `${T}/${id}`, { title: 'Renamed by a former head' }], ['post', `${T}/${id}/extensions`, { kind: 'TEST', newDeadline: minutes(300), reason: 'Everyone' }],
      ['get', `${T}/${id}/submissions/${sid}`], ['get', `${M(id)}/submissions`], ['post', `${M(id)}/submissions/${sid}/approve`, {}],
      ['get', `${T}/${id}/results/preview`], ['post', `${T}/${id}/results/publish`, {}], ['get', `${T}/${id}/results/rankings`],
    ] as Array<[string, string, object?]>) {
      expect([path, await status((http() as any)[method](path).set(bearer(hx)).send(body ?? {}))]).toEqual([path, [403, 'SCOPE_FORBIDDEN']]);
    }
    expect(await status(http().post('/api/v1/admin/test-markers').set(bearer(hx)).send({ coachId: c2Id, subjectId: maths }))).toEqual([403, 'SCOPE_FORBIDDEN']);
    expect((await http().get('/api/v1/admin/test-dashboard').set(bearer(hx)).expect(200)).body.subjects).toEqual([]);
  });

  describe('marking across subjects, the marking guide, extensions and locks', () => {
    let mId: string, pId: string, q: string[];
    let codeJ: string, codeJ2: string, codeP: string;

    beforeAll(async () => {
      mId = await createTest(hm, { title: 'Maths marking' });
      pId = await createTest(hp, { title: 'Physics marking', subjectId: physics });
      q = await questionsOf(mId);
      await submitTyped(sj, mId).expect(201);
      await submitTyped(sj2, mId).expect(201);
      await submitTyped(sj, pId).expect(201);
      // A whole-test extension for physics, an individual one for maths, both while open; they end before marking.
      await http().post(`${T}/${mId}/extensions`).set(bearer(hm)).send({ kind: 'STUDENT', studentId: stJ2, newDeadline: minutes(240), reason: 'Exam clash' }).expect(201);
      for (const id of [mId, pId]) await closeNow(id);
      await p().$executeRaw`UPDATE "TestExtension" SET "newDeadline" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "testId" = ${mId}`;
      await http().post(`${M(mId)}/assign`).set(bearer(hm)).send({ submissionIds: [(await subOf(mId, stJ)).id, (await subOf(mId, stJ2)).id], coachId: c1Id }).expect(200);
      await http().post(`${M(pId)}/distribute`).set(bearer(hp)).send({ coachIds: [c3Id] }).expect(200);
      codeJ = (await subOf(mId, stJ)).publicCode;
      codeJ2 = (await subOf(mId, stJ2)).publicCode;
      codeP = (await subOf(pId, stJ)).publicCode;
    });

    it('scenario 1: a coach authorised and assigned in Physics cannot open, read or mark a Mathematics submission; their queue shows Physics only', async () => {
      expect((await http().get(`${MK}/submissions/${codeP}`).set(bearer(c3))).status).toBe(200);
      for (const [method, path, body] of [['get', `${MK}/submissions/${codeJ}`], ['get', `${MK}/submissions/${codeJ}/pages/1`],
        ['get', `${MK}/submissions/${codeJ}/paper`], ['get', `${MK}/submissions/${codeJ}/marking-guide`],
        ['put', `${MK}/submissions/${codeJ}/marking`, marks(q, 1, 1)], ['post', `${MK}/submissions/${codeJ}/marking/submit`, marks(q, 1, 1)]] as Array<[string, string, object?]>) {
        const [code, err] = await status((http() as any)[method](path).set(bearer(c3)).send(body ?? {}));
        expect([path, code, ['MARKING_NOT_ASSIGNED', 'MARKER_NOT_AUTHORIZED'].includes(err)]).toEqual([path, 403, true]);
      }
      const queue = (await http().get(`${MK}/queue`).set(bearer(c3)).expect(200)).body;
      expect(queue.data.map((x: any) => x.test.subject.code)).toEqual(['PHYSICS']);
      expect(await p().testMarking.count({ where: { submission: { testId: mId } } })).toBe(0);
    });

    it('scenario 17: the marking guide — the assigned marker yes; an authorised but unassigned coach, a teacher, a student: no', async () => {
      const ok = await http().get(`${MK}/submissions/${codeJ}/marking-guide`).set(bearer(c1)).expect(200);
      expect(ok.headers['content-disposition']).toMatch(/marking-guide\.pdf/);
      expect((await status(http().get(`${MK}/submissions/${codeJ}/marking-guide`).set(bearer(c2))))[0]).toBe(403);
      expect(await status(http().get(`${T}/${mId}/files/marking-guide`).set(bearer(ta)))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(http().get(`${T}/${mId}/files/marking-guide`).set(bearer(sj)))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(http().get(`${MK}/submissions/${codeJ}/marking-guide`).set(bearer(ta)))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect((await http().get(`${TT}/${mId}/marking-guide`).set(bearer(ta))).status).toBe(404);   // no such route for teachers
      expect((await http().get(`${ME}/${mId}/marking-guide`).set(bearer(sj))).status).toBe(404);
    });

    it('scenario 26: NO marker response carries extension information — queue, detail, save, submit, errors, file headers, notices', async () => {
      const bodies: unknown[] = [];
      bodies.push((await http().get(`${MK}/queue`).set(bearer(c1)).expect(200)).body);
      bodies.push((await http().get(`${MK}/submissions/${codeJ2}`).set(bearer(c1)).expect(200)).body);
      bodies.push((await http().put(`${MK}/submissions/${codeJ2}/marking`).set(bearer(c1)).send(marks(q, 2, 8)).expect(200)).body);
      bodies.push((await http().put(`${MK}/submissions/${codeJ2}/marking`).set(bearer(c1)).send(marks(q, 9, 8))).body);   // an error body
      bodies.push((await http().post(`${MK}/submissions/${codeJ2}/marking/submit`).set(bearer(c1)).send({ scores: [] })).body);   // another error
      bodies.push((await http().post(`${MK}/submissions/${codeJ2}/marking/submit`).set(bearer(c1)).send(marks(q, 2, 8)).expect(200)).body);
      bodies.push((await http().get(`${MK}/dashboard`).set(bearer(c1)).expect(200)).body);
      for (const b of bodies) expect(JSON.stringify(b)).not.toMatch(EXTENSION_LEAK);
      const guide = await http().get(`${MK}/submissions/${codeJ2}/paper`).set(bearer(c1));
      expect(JSON.stringify(guide.headers)).not.toMatch(EXTENSION_LEAK);
      await waitForEvents();
      const notices = await p().notification.findMany({ where: { userId: c1Id } });
      for (const n of notices) expect(`${n.title} ${n.body}`).not.toMatch(/extension|extended|deadline/i);
    });

    it('scenario 42: approved marks are locked — the marker cannot save or resubmit, no second marking, no choice, the database refuses a change; only an authorised unlock reopens', async () => {
      const sid = (await subOf(mId, stJ2)).id;
      await http().post(`${M(mId)}/submissions/${sid}/approve`).set(bearer(hm)).send({}).expect(200);
      expect((await status(http().put(`${MK}/submissions/${codeJ2}/marking`).set(bearer(c1)).send(marks(q, 1, 1))))[0]).toBe(409);
      expect((await status(http().post(`${MK}/submissions/${codeJ2}/marking/submit`).set(bearer(c1)).send(marks(q, 1, 1))))[0]).toBe(409);
      expect(await status(http().post(`${M(mId)}/submissions/${sid}/second-marking`).set(bearer(hm)).send({ coachId: c2Id }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(await status(http().post(`${M(mId)}/submissions/${sid}/choose`).set(bearer(hm)).send({ source: 'FIRST', reason: 'Because' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      const final = (await p().testSubmission.findUniqueOrThrow({ where: { id: sid } })).finalMarkingId!;
      await expect(p().$executeRaw`UPDATE "TestMarking" SET "totalMarks" = 1 WHERE "id" = ${final}`).rejects.toThrow(/locked/);
      await expect(p().$executeRaw`UPDATE "TestMarkingScore" SET "marks" = 1 WHERE "markingId" = ${final}`).rejects.toThrow(/locked/);
      expect((await p().testMarking.findUniqueOrThrow({ where: { id: final } })).totalMarks).toBe(10);
      // A coach, a teacher or a student can never unlock; the subject's Head Coach can (reason).
      for (const token of [c1, ta, sj]) expect(await status(http().post(`${M(mId)}/submissions/${sid}/unlock`).set(bearer(token)).send({ reason: 'Please' }))).toEqual([403, 'PERMISSION_REQUIRED']);
      await http().post(`${M(mId)}/submissions/${sid}/unlock`).set(bearer(hm)).send({ reason: 'Recount question 2' }).expect(200);
      expect((await p().testMarking.findUniqueOrThrow({ where: { id: final } })).status).toBe('SUBMITTED');
    });

    it('scenario 40: every marking step is audited — draft, submit, return, correction, choice, approval, unlock — and every mark change is logged', async () => {
      const sid = (await subOf(mId, stJ)).id;
      await http().put(`${MK}/submissions/${codeJ}/marking`).set(bearer(c1)).send(marks(q, 4, 12)).expect(200);
      await http().post(`${MK}/submissions/${codeJ}/marking/submit`).set(bearer(c1)).send(marks(q, 4, 12)).expect(200);
      await http().post(`${M(mId)}/submissions/${sid}/return`).set(bearer(hm)).send({ comment: 'Q2 is worth more' }).expect(200);
      await http().put(`${MK}/submissions/${codeJ}/marking`).set(bearer(c1)).send(marks(q, 4, 14)).expect(200);
      await http().post(`${MK}/submissions/${codeJ}/marking/submit`).set(bearer(c1)).send(marks(q, 4, 14)).expect(200);
      await http().post(`${M(mId)}/submissions/${sid}/choose`).set(bearer(hm)).send({ source: 'ADJUSTMENT', reason: 'Q1 deserves full marks', marks: marks(q, 5, 14) }).expect(200);
      await http().post(`${M(mId)}/submissions/${sid}/approve`).set(bearer(admin)).send({}).expect(200);
      const actions = (await p().auditLog.findMany({ where: { action: { startsWith: 'TEST_' } }, orderBy: { createdAt: 'asc' } }))
        .filter((a) => a.entityId === sid || (a.metadata as any)?.submissionId === sid);
      const names = actions.map((a) => a.action);
      for (const a of ['TEST_MARKING_SUBMITTED', 'TEST_MARKING_RETURNED', 'TEST_MARK_CHOSEN', 'TEST_MARKING_APPROVED']) expect([a, names.includes(a)]).toEqual([a, true]);
      expect(actions.find((a) => a.action === 'TEST_MARKING_RETURNED')!.metadata).toMatchObject({ comment: 'Q2 is worth more' });
      expect(actions.find((a) => a.action === 'TEST_MARK_CHOSEN')!.metadata).toMatchObject({ comment: 'Q1 deserves full marks', source: 'ADJUSTMENT' });
      expect(actions.find((a) => a.action === 'TEST_MARKING_APPROVED')!.actorRole).toBe('ADMIN');
      // The mark-change log: the first marking 12 → 14 on Q2 after the return; the adjustment 4 → 5 on Q1 with its reason.
      const log = await p().testMarkChange.findMany({ where: { marking: { submissionId: sid } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { question: true } });
      expect(log.filter((c) => c.oldMarks !== null).map((c) => [c.question?.order, c.oldMarks, c.newMarks, c.changedByRole, c.reason])).toEqual([
        [2, 12, 14, 'MENTOR', null], [1, 4, 5, 'HEAD_COACH', 'Q1 deserves full marks'],
      ]);
    });
  });

  describe('submissions and extensions', () => {
    it('scenario 16: answer pages — the 20 MB limit and the allowed types are enforced; nothing is stored for a refused page', async () => {
      const id = await createTest(hm, { title: 'Upload limits' });
      const before = await p().fileObject.count();
      const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024 + 1024, 0)]);
      const tooBig = await http().post(`${ME}/${id}/uploads/${randomUUID()}/pages/1`).set(bearer(sj)).attach('file', big, 'big.png');
      expect(tooBig.status).toBe(413);
      const text = await http().post(`${ME}/${id}/uploads/${randomUUID()}/pages/1`).set(bearer(sj)).attach('file', Buffer.from('hello'), 'notes.txt');
      expect([text.status, text.body.code]).toEqual([415, 'FILE_TYPE_NOT_ALLOWED']);
      expect(await p().fileObject.count()).toBe(before);
      await http().post(`${ME}/${id}/uploads/${randomUUID()}/pages/1`).set(bearer(sj)).attach('file', PDF, 'page.pdf').expect(201);
    });

    it('scenario 27: only existing student accounts can have submissions — an unknown id, a teacher, a coach or an Administrator is refused; nothing is created', async () => {
      const id = await createTest(hm, { title: 'Only students' });
      for (const target of [randomUUID(), tO, c1Id, ctx.ids.admin, hmId]) {
        expect([target, await status(http().post(`${TT}/${id}/students/${target}/submission`).set(bearer(ta)).send({ clientKey: randomUUID(), typedAnswer: 'x' }))])
          .toEqual([target, [403, 'STUDENT_NOT_IN_SCOPE']]);
      }
      expect(await status(http().post(`${TT}/${id}/students/not-a-uuid/submission`).set(bearer(ta)).send({ clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([400, 'BAD_REQUEST']);
      expect(await p().testSubmission.count({ where: { testId: id } })).toBe(0);
      // Staff cannot submit as a student either.
      for (const token of [admin, hm, c1]) expect((await submitTyped(token, id)).status).toBe(403);
    });

    it('scenario 30: submission times are the database\'s, versions are numbered in order and each keeps its own time and deadline', async () => {
      const id = await createTest(hm, { title: 'Times' });
      const [{ now: t0 }] = await p().$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      await submitTyped(sj, id, 'first').expect(201);
      // Locked once submitted (owner 2026-11-21): an Administrator authorizes the second version.
      await http().post(`${T}/${id}/submissions/${(await subOf(id, stJ)).id}/resubmission`).set(bearer(admin)).send({ reason: 'Teacher hands in the paper copy' }).expect(200);
      await sleep(30);
      await http().post(`${TT}/${id}/students/${stJ}/submission`).set(bearer(ta)).send({ clientKey: randomUUID(), typedAnswer: 'second' }).expect(201);
      const [{ now: t1 }] = await p().$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      const sub = await subOf(id, stJ);
      const versions = await p().testSubmissionVersion.findMany({ where: { submissionId: sub.id }, orderBy: { number: 'asc' } });
      expect(versions.map((v) => [v.number, v.submitterRole, v.typedAnswer])).toEqual([[1, 'STUDENT', 'first'], [2, 'TEACHER', 'second']]);
      for (const v of versions) {
        expect(v.submittedAt.getTime()).toBeGreaterThanOrEqual(t0.getTime());
        expect(v.submittedAt.getTime()).toBeLessThanOrEqual(t1.getTime());
      }
      expect(versions[1].submittedAt.getTime()).toBeGreaterThan(versions[0].submittedAt.getTime());
      expect(sub.firstSubmittedAt!.getTime()).toBe(versions[0].submittedAt.getTime());
      expect(sub.lastSubmittedAt!.getTime()).toBe(versions[1].submittedAt.getTime());
      const test = await p().test.findUniqueOrThrow({ where: { id } });
      for (const v of versions) expect(v.applicableDeadline.getTime()).toBe(test.closesAt.getTime());
      // The student sees both versions with their times, newest first.
      const view = (await http().get(`${ME}/${id}`).set(bearer(sj)).expect(200)).body;
      expect(view.submission.versions.map((v: any) => v.number)).toEqual([2, 1]);
    });

    it('scenario 19: a teacher extension never lets that teacher submit for another school\'s student or another division; a pending claim is a student of the school (owner 2026-11-21)', async () => {
      const id = await createTest(hm, { title: 'Teacher extension scope', division: 'JUNIOR' });
      await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'TEACHER', teacherId: tA, newDeadline: minutes(240), reason: 'Network down' }).expect(201);
      await closeNow(id);
      const submitFor = (studentId: string, token = ta) => http().post(`${TT}/${id}/students/${studentId}/submission`).set(bearer(token)).send({ clientKey: randomUUID(), typedAnswer: 'x' });
      expect(await status(submitFor(stO))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);       // another school
      expect((await submitFor(stP)).status).toBe(201);                                   // pending claim: their school's student (owner 2026-11-21)
      expect((await submitFor(stS)).status).toBe(403);                                   // Senior student, Junior test
      expect((await submitFor(stJ)).status).toBe(201);                                   // their own verified Junior student: yes
      expect(await status(submitFor(stO, to))).toEqual([409, 'DEADLINE_PASSED']);        // the other school's teacher: not extended
      expect(await status(submitTyped(sj2, id))).toEqual([409, 'DEADLINE_PASSED']);      // the student themself: not extended
    });

    it('scenario 20: a whole-test extension applies to everyone — several students and teachers of different schools', async () => {
      const id = await createTest(hm, { title: 'Whole test' });
      await http().post(`${T}/${id}/extensions`).set(bearer(admin)).send({ kind: 'TEST', newDeadline: minutes(240), reason: 'National power cut' }).expect(201);
      await closeNow(id);
      await submitTyped(sj, id).expect(201);
      await submitTyped(so, id).expect(201);
      await http().post(`${TT}/${id}/students/${stJ2}/submission`).set(bearer(ta)).send({ clientKey: randomUUID(), typedAnswer: 'x' }).expect(201);
      const versions = await p().testSubmissionVersion.findMany({ where: { submission: { testId: id } } });
      expect(versions).toHaveLength(3);
      for (const v of versions) expect(v.underExtension).toBe(true);
      for (const token of [sj, so]) expect((await http().get(`${ME}/${id}`).set(bearer(token)).expect(200)).body.test.window).toBe('OPEN');
    });

    it('scenarios 24, 25: editing an extension moves exactly that student\'s deadline (later, then earlier — enforced); creation, edit and cancellation are audited with actor, reason and deadlines', async () => {
      const id = await createTest(hm, { title: 'Edited extension' });
      const ext = (await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'STUDENT', studentId: stJ, newDeadline: minutes(180), reason: 'Hospital visit' }).expect(201)).body;
      const later = minutes(300);
      await http().patch(`${T}/${id}/extensions/${ext.id}`).set(bearer(hm2)).send({ newDeadline: later, reason: 'Longer stay' }).expect(200);
      expect(new Date((await http().get(`${ME}/${id}`).set(bearer(sj)).expect(200)).body.test.deadline).toISOString()).toBe(later);
      expect(new Date((await http().get(`${ME}/${id}`).set(bearer(sj2)).expect(200)).body.test.deadline).getTime()).toBeLessThan(new Date(later).getTime());
      await closeNow(id);
      await submitTyped(sj, id, 'under the extension').expect(201);
      expect(await status(submitTyped(sj2, id))).toEqual([409, 'DEADLINE_PASSED']);
      // Shortened to a moment just ahead: once it passes, the student is blocked.
      const soon = new Date(Date.now() + 2_500).toISOString();
      await http().patch(`${T}/${id}/extensions/${ext.id}`).set(bearer(hm)).send({ newDeadline: soon, reason: 'Back at school' }).expect(200);
      await sleep(3_000);
      expect(await status(submitTyped(sj, id, 'too late'))).toEqual([409, 'DEADLINE_PASSED']);
      // A second extension, then cancelled: the student is blocked again.
      const ext2 = (await http().post(`${T}/${id}/extensions`).set(bearer(admin)).send({ kind: 'STUDENT', studentId: stJ2, newDeadline: minutes(60), reason: 'Bereavement' }).expect(201)).body;
      await submitTyped(sj2, id).expect(201);
      await http().post(`${T}/${id}/extensions/${ext2.id}/cancel`).set(bearer(hm)).send({ reason: 'Granted by mistake' }).expect(200);
      expect(await status(submitTyped(sj2, id))).toEqual([409, 'DEADLINE_PASSED']);
      const audit = await p().auditLog.findMany({ where: { entityId: { in: [ext.id, ext2.id] } }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => [a.action, a.actorId])).toEqual([
        ['TEST_EXTENSION_GRANTED', hmId], ['TEST_EXTENSION_UPDATED', hm2Id], ['TEST_EXTENSION_UPDATED', hmId],
        ['TEST_EXTENSION_GRANTED', ctx.ids.admin], ['TEST_EXTENSION_CANCELLED', hmId],
      ]);
      expect(audit[0].metadata).toMatchObject({ kind: 'STUDENT', studentId: stJ, reason: 'Hospital visit' });
      expect(audit[1].metadata).toMatchObject({ before: { reason: 'Hospital visit' }, after: { newDeadline: later, reason: 'Longer stay' } });
      expect(audit[2].metadata).toMatchObject({ before: { newDeadline: later }, after: { reason: 'Back at school' } });
      expect(audit[4].metadata).toMatchObject({ studentId: stJ2, reason: 'Granted by mistake' });
    });
  });
});
