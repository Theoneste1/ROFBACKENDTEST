/**
 * Test Management (WS3; owner spec and plan approved 2026-11-19) — the COMPLETE workflow across every role, on PostgreSQL,
 * through the API only (except moving time forward: database clock, as everywhere in these specs):
 *
 *   Administrator creates a test with questions, paper and marking guide, publishes it → the subject's Head Coach
 *   authorises two coaches as markers → a student submits their own answer (typed + a page) and a teacher submits for a
 *   classmate under a teacher extension → every deadline passes → the Head Coach distributes → coach A marks BLIND →
 *   a second, independent and blind marking by coach B → the Head Coach adjusts the mark (reason) → approve → publish →
 *   the students and their teacher see the results (never ranks), the Administrator and the Head Coach see the rankings →
 *   unlocking withdraws a published result (G6) → re-approve → republish.
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, PDF, waitForEvents, type TestContext } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Test Management — the complete workflow from test creation to publication, withdrawal and republication (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, cA: string, cB: string, sj: string, sj2: string, ta: string;
  let maths: string, school: string, stJ: string, stJ2: string, tA: string, cAId: string, cBId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  let id: string;
  let q: string[];
  const names: Record<string, string> = {};

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    school = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'TEACHER') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Workflow', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    const hmId = await mk('hc.maths', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    stJ = ctx.ids.studentJunior; stJ2 = ctx.ids.studentJunior2;
    for (const s of [stJ, stJ2]) {
      await p().studentSchoolAffiliation.create({ data: { studentId: s, schoolId: school, source: 'ADMIN', createdById: ctx.ids.admin, status: 'VERIFIED', decidedById: ctx.ids.admin, decidedAt: new Date() } });
    }
    tA = await mk('teacher.a', 'TEACHER');
    await p().teacherSchoolAssignment.create({ data: { teacherId: tA, schoolId: school, role: 'SECONDARY' } });
    cAId = ctx.ids.mentorJunior; cBId = ctx.ids.mentorJunior2;
    for (const u of await p().user.findMany({ where: { id: { in: [stJ, stJ2] } } })) names[u.id] = `${u.firstName} ${u.lastName}`;
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'hc.maths');
    cA = await login(ctx, 'mentor.j');
    cB = await login(ctx, 'mentor.j2');
    sj = await login(ctx, 'student.j');
    sj2 = await login(ctx, 'student.j2');
    ta = await login(ctx, 'teacher.a');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('1. the Administrator creates the test with questions, the paper and the marking guide, and publishes it', async () => {
    const created = (await http().post(T).set(bearer(admin)).send({
      title: 'National round 1', subjectId: maths, division: 'JUNIOR', answerFormat: 'BOTH', opensAt: minutes(-30), closesAt: minutes(60),
      maxMarks: 20, questions: [{ prompt: 'Algebra', maxMarks: 8 }, { prompt: 'Geometry', maxMarks: 12 }],
    }).expect(201)).body;
    id = created.id;
    await http().put(`${T}/${id}/files/paper`).set(bearer(admin)).attach('file', PDF, 'round1 paper.pdf').expect(200);
    await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'answers by Mr Kamali.pdf').expect(200);
    await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200);
    q = (await p().testQuestion.findMany({ where: { testId: id }, orderBy: { order: 'asc' } })).map((x) => x.id);
    expect((await http().get(`${T}/${id}`).set(bearer(hm)).expect(200)).body).toMatchObject({ status: 'PUBLISHED', maxMarks: 20 });
  });

  it('2. the subject\'s Head Coach authorises coaches A and B to mark Mathematics', async () => {
    for (const coachId of [cAId, cBId]) await http().post('/api/v1/admin/test-markers').set(bearer(hm)).send({ coachId, subjectId: maths }).expect(201);
    expect(await p().markerAuthorization.count({ where: { disciplineId: maths, revokedAt: null } })).toBe(2);
  });

  it('3. the student submits (typed + a photo page); the deadline passes; the teacher submits for a classmate under a teacher extension', async () => {
    const key = randomUUID();
    await http().post(`/api/v1/me/tests/${id}/uploads/${key}/pages/1`).set(bearer(sj)).attach('file', PNG, 'page1.png').expect(201);
    await http().post(`/api/v1/me/tests/${id}/submission`).set(bearer(sj)).send({ clientKey: key, typedAnswer: 'x = 3', pageCount: 1 }).expect(201);
    await http().post(`${T}/${id}/extensions`).set(bearer(hm)).send({ kind: 'TEACHER', teacherId: tA, newDeadline: minutes(120), reason: 'Power cut at the school' }).expect(201);
    // The test's own deadline passes (database time); the teacher's extension still runs.
    await p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "id" = ${id}`;
    expect((await http().post(`/api/v1/me/tests/${id}/submission`).set(bearer(sj2)).send({ clientKey: randomUUID(), typedAnswer: 'late' })).status).toBe(409);
    await http().post(`/api/v1/teacher/tests/${id}/students/${stJ2}/submission`).set(bearer(ta)).send({ clientKey: randomUUID(), typedAnswer: 'x = 4 (typed in class)' }).expect(201);
    const v = await p().testSubmissionVersion.findFirstOrThrow({ where: { submission: { testId: id, studentId: stJ2 } } });
    expect(v).toMatchObject({ submitterRole: 'TEACHER', submittedById: tA, teacherId: tA, underExtension: true });
    // Marking cannot begin before every applicable deadline has passed (G5) — for BOTH students: the extended teacher teaches
    // at their school and could still submit (or replace) for either of them.
    expect((await http().get(`${T}/${id}/marking`).set(bearer(hm)).expect(200)).body.distribution).toMatchObject({ readyToAssign: 0, waitingForDeadline: 2 });
    expect((await http().post(`${T}/${id}/marking/distribute`).set(bearer(hm)).send({ coachIds: [cAId] }).expect(200)).body).toMatchObject({ assigned: 0, waitingForDeadline: 2 });
    await p().$executeRaw`UPDATE "TestExtension" SET "newDeadline" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "testId" = ${id}`;
  });

  it('4. the Head Coach distributes; coach A marks BLIND (code only) and submits for approval', async () => {
    expect((await http().post(`${T}/${id}/marking/distribute`).set(bearer(hm)).send({ coachIds: [cAId] }).expect(200)).body.assigned).toBe(2);
    const queue = (await http().get('/api/v1/marking/queue').set(bearer(cA)).expect(200)).body;
    expect(queue.data).toHaveLength(2);
    const text = JSON.stringify(queue);
    for (const n of Object.values(names)) expect(text).not.toContain(n);
    expect(text).not.toMatch(/teacher|extension|underExtension|Test School/i);
    const marksOf: Record<string, [number, number]> = { [stJ]: [6, 10], [stJ2]: [7, 9] };
    for (const item of queue.data) {
      const detail = (await http().get(`/api/v1/marking/submissions/${item.code}`).set(bearer(cA)).expect(200)).body;
      expect(JSON.stringify(detail)).not.toMatch(/student\.j|Workflow|teacher|underExtension/);
      const sub = await p().testSubmission.findUniqueOrThrow({ where: { publicCode: item.code } });
      const [a, b] = marksOf[sub.studentId];
      const body = { scores: [{ questionId: q[0], marks: a, comment: 'Good method' }, { questionId: q[1], marks: b }], comment: 'Solid work' };
      await http().put(`/api/v1/marking/submissions/${item.code}/marking`).set(bearer(cA)).send(body).expect(200);
      await http().post(`/api/v1/marking/submissions/${item.code}/marking/submit`).set(bearer(cA)).send(body).expect(200);
    }
    expect((await p().testSubmission.findMany({ where: { testId: id } })).map((s) => s.status)).toEqual(['MARKED', 'MARKED']);
  });

  it('5. a second, independent and blind marking by coach B; the Head Coach adjusts the mark with a reason; both approved', async () => {
    const subJ = (await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: id, studentId: stJ } } }));
    await http().post(`${T}/${id}/marking/submissions/${subJ.id}/second-marking`).set(bearer(hm)).send({ coachId: cBId, reason: 'Borderline for the prize' }).expect(200);
    const view = (await http().get(`/api/v1/marking/submissions/${subJ.publicCode}`).set(bearer(cB)).expect(200)).body;
    expect(JSON.stringify(view)).not.toMatch(/Good method|Solid work|"totalMarks":16/);
    const second = { scores: [{ questionId: q[0], marks: 8 }, { questionId: q[1], marks: 11 }], comment: 'Very clear' };
    await http().put(`/api/v1/marking/submissions/${subJ.publicCode}/marking`).set(bearer(cB)).send(second).expect(200);
    await http().post(`/api/v1/marking/submissions/${subJ.publicCode}/marking/submit`).set(bearer(cB)).send(second).expect(200);
    // Two markings: the subject's Head Coach must choose (an Administrator never can, G4).
    expect(await status(http().post(`${T}/${id}/marking/submissions/${subJ.id}/approve`).set(bearer(admin)).send({}))).toEqual([409, 'MARK_CHOICE_REQUIRED']);
    expect(await status(http().post(`${T}/${id}/marking/submissions/${subJ.id}/choose`).set(bearer(admin)).send({ source: 'SECOND', reason: 'x' }))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().post(`${T}/${id}/marking/submissions/${subJ.id}/choose`).set(bearer(hm)).send({
      source: 'ADJUSTMENT', reason: 'Second marker right on Q1; Q2 between both',
      marks: { scores: [{ questionId: q[0], marks: 8, comment: 'Excellent algebra' }, { questionId: q[1], marks: 10 }] },
    }).expect(200);
    await http().post(`${T}/${id}/marking/submissions/${subJ.id}/approve`).set(bearer(hm)).send({}).expect(200);
    const subJ2 = await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: id, studentId: stJ2 } } });
    await http().post(`${T}/${id}/marking/submissions/${subJ2.id}/approve`).set(bearer(admin)).send({}).expect(200);
    const final = await p().testMarking.findUniqueOrThrow({ where: { id: (await p().testSubmission.findUniqueOrThrow({ where: { id: subJ.id } })).finalMarkingId! } });
    expect(final).toMatchObject({ kind: 'ADJUSTMENT', totalMarks: 18, status: 'APPROVED' });
    expect(await p().testMarkChange.count({ where: { markingId: final.id } })).toBeGreaterThan(0);
  });

  it('6. nothing is visible before publication; the Head Coach publishes (everything approved); students and the teacher are told once', async () => {
    expect(await status(http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj)))).toEqual([404, 'RESULT_NOT_FOUND']);
    expect((await http().get(`/api/v1/teacher/test-results/${id}`).set(bearer(ta)).expect(200)).body.meta.total).toBe(0);
    const pv = (await http().get(`${T}/${id}/results/preview`).set(bearer(hm)).expect(200)).body;
    expect(pv.counts).toMatchObject({ approved: 2, unapproved: 0 });
    expect(pv.actions.publish).toBe(true);
    const pub = (await http().post(`${T}/${id}/results/publish`).set(bearer(hm)).send({ clientKey: randomUUID() }).expect(200)).body;
    expect(pub).toMatchObject({ replayed: false, published: 2, publication: { number: 1, override: false } });
    await waitForEvents();
    const notices = await p().notificationOutbox.findMany({ where: { type: 'test.results.published', entityId: id } });
    expect(notices.map((n) => n.recipientUserId).sort()).toEqual([stJ, stJ2, tA].sort());
  });

  it('7. each student sees their own marks per question, total and comments (never a rank or a marker); the teacher sees the school\'s results; Administrator and Head Coach see the rankings', async () => {
    const mine = (await http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj)).expect(200)).body;
    expect(mine.result).toMatchObject({ totalMarks: 18, maxMarks: 20, questions: [{ marks: 8, comment: 'Excellent algebra' }, { marks: 10 }] });
    expect(JSON.stringify(mine)).not.toMatch(/"rank"|mentor\.j|hc\.maths/);
    expect((await http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj2)).expect(200)).body.result.totalMarks).toBe(16);
    const school = (await http().get(`/api/v1/teacher/test-results/${id}`).set(bearer(ta)).expect(200)).body;
    expect(school.data.map((r: any) => r.totalMarks).sort()).toEqual([16, 18]);
    expect(JSON.stringify(school)).not.toMatch(/"rank"/);
    for (const token of [admin, hm]) {
      const ranks = (await http().get(`${T}/${id}/results/rankings`).set(bearer(token)).expect(200)).body;
      expect(ranks.data.map((r: any) => [r.student.id, r.rank, r.totalMarks])).toEqual([[stJ, 1, 18], [stJ2, 2, 16]]);
    }
    for (const token of [sj, ta, cA]) expect(await status(http().get(`${T}/${id}/results/rankings`).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('8. unlocking a published result withdraws it (G6; told once); re-approval and republication restore it', async () => {
    const sub = await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: id, studentId: stJ2 } } });
    await http().post(`${T}/${id}/marking/submissions/${sub.id}/unlock`).set(bearer(admin)).send({ reason: 'Parent query on question 2' }).expect(200);
    expect(await status(http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj2)))).toEqual([404, 'RESULT_NOT_FOUND']);
    expect((await http().get(`/api/v1/teacher/test-results/${id}`).set(bearer(ta)).expect(200)).body.meta.total).toBe(1);
    await waitForEvents();
    expect((await p().notificationOutbox.findMany({ where: { type: 'test.result.withdrawn', entityId: id } })).map((n) => n.recipientUserId).sort()).toEqual([stJ2, tA].sort());
    await http().post(`${T}/${id}/marking/submissions/${sub.id}/approve`).set(bearer(hm)).send({}).expect(200);
    expect(await status(http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj2)))).toEqual([404, 'RESULT_NOT_FOUND']);
    expect((await http().post(`${T}/${id}/results/publish`).set(bearer(admin)).send({}).expect(200)).body).toMatchObject({ published: 1, publication: { number: 2 } });
    expect((await http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj2)).expect(200)).body.result.totalMarks).toBe(16);
    expect((await http().get(`/api/v1/teacher/test-results/${id}`).set(bearer(ta)).expect(200)).body.meta.total).toBe(2);
    // The full history of the result, every step through the transition table.
    const history = await p().testSubmissionStatusChange.findMany({ where: { submissionId: sub.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => h.toStatus)).toEqual(['SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'APPROVED', 'PUBLISHED', 'MARKED', 'APPROVED', 'PUBLISHED']);
    // Every step is in the audit log (TESTS category).
    const actions = new Set((await p().auditLog.findMany({ select: { action: true } })).map((a) => a.action));
    for (const a of ['TEST_CREATED', 'TEST_PUBLISHED', 'TEST_EXTENSION_GRANTED', 'TEST_SUBMITTED', 'TEST_MARKING_DISTRIBUTED', 'TEST_MARKING_SUBMITTED',
      'TEST_SECOND_MARKING_REQUESTED', 'TEST_MARK_CHOSEN', 'TEST_MARKING_APPROVED', 'TEST_RESULTS_PUBLISHED', 'TEST_MARKING_UNLOCKED', 'TEST_RESULT_WITHDRAWN']) {
      expect([a, actions.has(a)]).toEqual([a, true]);
    }
  });
});
