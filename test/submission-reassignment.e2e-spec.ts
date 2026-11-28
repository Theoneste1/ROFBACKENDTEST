/**
 * Reassign a submission (owner 2026-11-28): Administrators and Super Administrators correct a test answer submitted under
 * the wrong subject or level — the SAME submission moves (id, public code, versions, pages, typed answer, timestamps,
 * status, history kept); nothing is copied or deleted; every correction is audited with before, after and reason.
 *  - Junior Mathematics → Senior Mathematics (separate tests per level); Physics → Computing (another subject).
 *  - The level only, within one test for every level: allowed even once marking started (the marks stay).
 *  - Another test once marking started: refused (MARKING_STARTED), nothing changed.
 *  - DUPLICATE_SUBMISSION, LEVEL_NOT_IN_TEST, FORMAT_MISMATCH, NO_CHANGE, SUBMISSION_CHANGED.
 *  - Only Administrators and Super Administrators reach the four routes (Head Coaches, Coaches, Teachers, Students: 403).
 *  - Search across tests by name, subject, level; lists and filters follow the correction.
 */
import { randomUUID } from 'crypto';
import { createTestApp, login, bearer, PDF, type TestContext } from './helpers.js';

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('Reassign a submission (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const T = '/api/v1/admin/tests';
  const SUB = (testId: string, subId: string) => `${T}/${testId}/submissions/${subId}`;
  let admin: string, superAdmin: string, headCoach: string, coach: string, teacher: string, sj: string, sj2: string, ss: string;
  let maths: string, physics: string, computing: string;
  let mathsJunior: string, mathsSenior: string, mathsAll: string, physicsAll: string, computingAll: string, typedOnly: string;

  const newTest = async (title: string, subjectId: string, division: string, answerFormat = 'BOTH', opts: { question?: boolean } = {}) => {
    const res = await http().post(T).set(bearer(admin)).send({
      title, subjectId, division, answerFormat, opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10,
      questions: opts.question ? [{ prompt: 'Question 1', maxMarks: 5 }, { prompt: 'Question 2', maxMarks: 5 }] : [{ prompt: 'Question 1', maxMarks: 10 }],
    }).expect(201);
    const id = res.body.id as string;
    await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'guide.pdf').expect(200);
    await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200);
    return id;
  };
  /** The student's answer: a typed answer, and a photographed page when `withPage`. */
  const submit = async (token: string, testId: string, withPage = true) => {
    const key = randomUUID();
    if (withPage) await http().post(`/api/v1/me/tests/${testId}/uploads/${key}/pages/1`).set(bearer(token)).attach('file', PNG, 'page.png').expect(201);
    await http().post(`/api/v1/me/tests/${testId}/submission`).set(bearer(token)).send({ clientKey: key, typedAnswer: 'My working', ...(withPage && { pageCount: 1 }) }).expect(201);
    return p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId: await studentIdOf(token) } } });
  };
  const studentIds = new Map<string, string>();
  const studentIdOf = async (token: string) => studentIds.get(token)!;
  /** Everything that must survive a correction, as stored. */
  const evidence = async (submissionId: string) => {
    const s = await p().testSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      select: { id: true, publicCode: true, studentId: true, status: true, versionCount: true, currentVersionId: true, firstSubmittedAt: true, lastSubmittedAt: true, createdAt: true },
    });
    const versions = await p().testSubmissionVersion.findMany({ where: { submissionId }, orderBy: { number: 'asc' }, select: { id: true, number: true, typedAnswer: true, pageCount: true, submittedAt: true } });
    const pages = await p().testAnswerPage.findMany({ where: { version: { submissionId } }, orderBy: { pageNumber: 'asc' }, select: { id: true, fileId: true, pageNumber: true, versionId: true } });
    const history = await p().testSubmissionStatusChange.count({ where: { submissionId } });
    return { s, versions, pages, history };
  };
  const reassign = (token: string, testId: string, subId: string, body: Record<string, unknown>) =>
    http().post(`${SUB(testId, subId)}/reassignment`).set(bearer(token)).send(body);

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    process.env.QUESTION_MARKING_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'RA_PHYSICS', name: 'Physics' } })).id;
    computing = (await p().discipline.create({ data: { code: 'RA_COMPUTING', name: 'Computing' } })).id;
    const pw = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = (username: string, role: 'SUPER_ADMIN' | 'HEAD_COACH' | 'TEACHER') =>
      p().user.create({ data: { username, firstName: username, lastName: 'Ra', email: `${username}@test.local`, role, passwordHash: pw, activatedAt: new Date() } });
    await mk('ra.super', 'SUPER_ADMIN');
    const hc = await mk('ra.head', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hc.id, disciplineId: maths, source: 'MANUAL' } });
    await mk('ra.teacher', 'TEACHER');
    admin = await login(ctx, 'admin');
    superAdmin = await login(ctx, 'ra.super');
    headCoach = await login(ctx, 'ra.head');
    coach = await login(ctx, 'mentor.j');
    teacher = await login(ctx, 'ra.teacher');
    sj = await login(ctx, 'student.j'); sj2 = await login(ctx, 'student.j2'); ss = await login(ctx, 'student.s');
    studentIds.set(sj, ctx.ids.studentJunior); studentIds.set(sj2, ctx.ids.studentJunior2); studentIds.set(ss, ctx.ids.studentSenior);
    mathsJunior = await newTest('RA Mathematics Junior', maths, 'JUNIOR');
    mathsSenior = await newTest('RA Mathematics Senior', maths, 'SENIOR');
    mathsAll = await newTest('RA Mathematics All', maths, 'ALL', 'BOTH', { question: true });
    physicsAll = await newTest('RA Physics', physics, 'ALL');
    computingAll = await newTest('RA Computing', computing, 'ALL');
    typedOnly = await newTest('RA Computing typed only', computing, 'ALL', 'TYPED_ONLY');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED; delete process.env.TEACHERS_ENABLED; delete process.env.QUESTION_MARKING_ENABLED;
    await ctx?.app.close();
  });

  it('only Administrators and Super Administrators reach the four routes; every other role is refused (403)', async () => {
    const sub = await submit(sj2, mathsJunior);
    const routes = [
      ['get', '/api/v1/admin/test-submissions'],
      ['get', `${SUB(mathsJunior, sub.id)}/reassignment`],
      ['post', `${SUB(mathsJunior, sub.id)}/reassignment`],
      ['get', `${SUB(mathsJunior, sub.id)}/reassignment/history`],
    ] as const;
    for (const [who, token] of [['head coach', headCoach], ['coach', coach], ['teacher', teacher], ['student', sj2]] as const) {
      for (const [m, url] of routes) {
        const r = await (http() as any)[m](url).set(bearer(token)).send(m === 'post' ? { testId: mathsSenior, level: 'SENIOR', reason: 'Wrong level chosen' } : undefined);
        expect({ who, url, status: r.status }).toEqual({ who, url, status: 403 });
      }
    }
    for (const [m, url] of routes) {
      const r = await (http() as any)[m](url).send(m === 'post' ? {} : undefined);
      expect({ url, status: r.status }).toEqual({ url, status: 401 });
    }
    // Nothing moved.
    expect((await p().testSubmission.findUniqueOrThrow({ where: { id: sub.id } })).testId).toBe(mathsJunior);
    // Administrators and Super Administrators may.
    await http().get(`${SUB(mathsJunior, sub.id)}/reassignment`).set(bearer(admin)).expect(200);
    await http().get(`${SUB(mathsJunior, sub.id)}/reassignment`).set(bearer(superAdmin)).expect(200);
    await http().get('/api/v1/admin/test-submissions').set(bearer(superAdmin)).expect(200);
  });

  it('Junior Mathematics → Senior Mathematics: the same submission moves, everything it holds is kept, audited; lists follow', async () => {
    const sub = await submit(sj, mathsJunior);
    const before = await evidence(sub.id);
    expect(before.pages).toHaveLength(1);
    // The search finds it by name, subject and level.
    const found = await http().get('/api/v1/admin/test-submissions').query({ q: 'student', subjectId: maths, level: sub.level! }).set(bearer(admin)).expect(200);
    expect(found.body.data.map((r: any) => r.id)).toContain(sub.id);
    const opts = await http().get(`${SUB(mathsJunior, sub.id)}/reassignment`).set(bearer(admin)).expect(200);
    expect(opts.body.current).toMatchObject({ test: { id: mathsJunior }, subject: { id: maths }, level: sub.level });
    expect(opts.body.markingStarted).toBe(false);
    expect(opts.body.destinations.find((d: any) => d.id === mathsSenior)).toMatchObject({ available: true, problem: null });
    expect(opts.body.destinations.find((d: any) => d.id === mathsJunior)).toMatchObject({ problem: 'SAME_TEST' });

    // The level must be the destination's.
    expect((await reassign(admin, mathsJunior, sub.id, { testId: mathsSenior, level: 'JUNIOR', reason: 'Should be Senior Mathematics' })).body.code).toBe('LEVEL_NOT_IN_TEST');
    const r = await reassign(admin, mathsJunior, sub.id, { testId: mathsSenior, level: 'SENIOR', reason: 'Should be Senior Mathematics', expectedTestId: mathsJunior }).expect(200);
    expect(r.body).toMatchObject({ moved: true, before: { testId: mathsJunior, level: sub.level }, after: { testId: mathsSenior, level: 'SENIOR' } });

    const after = await evidence(sub.id);
    expect(after).toEqual(before);   // same id, code, versions, pages and files, typed answer, timestamps, status, history
    const row = await p().testSubmission.findUniqueOrThrow({ where: { id: sub.id } });
    expect([row.testId, row.level]).toEqual([mathsSenior, 'SENIOR']);
    expect(await p().testSubmission.count({ where: { studentId: ctx.ids.studentJunior } })).toBe(1);   // no duplicate
    // The page is served under the new test; the old test no longer has the answer.
    await http().get(`${SUB(mathsSenior, sub.id)}/versions/${after.s.currentVersionId}/pages/1`).set(bearer(admin)).expect(200);
    await http().get(SUB(mathsJunior, sub.id)).set(bearer(admin)).expect(404);
    const senior = await http().get(`${T}/${mathsSenior}/submissions`).query({ status: 'SUBMITTED' }).set(bearer(admin)).expect(200);
    expect(JSON.stringify(senior.body)).toContain(sub.publicCode);
    const junior = await http().get(`${T}/${mathsJunior}/submissions`).query({ status: 'SUBMITTED' }).set(bearer(admin)).expect(200);
    expect(JSON.stringify(junior.body)).not.toContain(sub.publicCode);
    // The student sees the answer under the right test.
    // The student (whose profile level is still Junior) still sees the answer, under the corrected test, but cannot submit there.
    const mine = await http().get(`/api/v1/me/tests/${mathsSenior}`).set(bearer(sj)).expect(200);
    expect(mine.body.submission).toMatchObject({ versionCount: 1 });
    expect(mine.body.canSubmit).toBe(false);
    const list = await http().get('/api/v1/me/tests').set(bearer(sj)).expect(200);
    expect(list.body.data.map((t: any) => t.id)).toEqual(expect.arrayContaining([mathsSenior]));
    // A Senior-only test the student has no answer in stays hidden from a Junior student.
    await http().get(`/api/v1/me/tests/${mathsSenior}`).set(bearer(sj2)).expect(404);
    // Audited: who, when, before, after, reason — and the history route shows it.
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'TEST_SUBMISSION_REASSIGNED', entityId: sub.id } });
    expect(audit.actorId).toBe(ctx.ids.admin);
    expect(audit.metadata).toMatchObject({ reason: 'Should be Senior Mathematics', before: { testId: mathsJunior, subjectCode: 'MATHEMATICS' }, after: { testId: mathsSenior, level: 'SENIOR' } });
    const hist = await http().get(`${SUB(mathsSenior, sub.id)}/reassignment/history`).set(bearer(admin)).expect(200);
    expect(hist.body).toEqual([expect.objectContaining({ reason: 'Should be Senior Mathematics', before: expect.objectContaining({ testId: mathsJunior }), after: expect.objectContaining({ testId: mathsSenior }) })]);
    // A second correction from a stale screen is refused.
    expect((await reassign(admin, mathsJunior, sub.id, { testId: mathsAll, level: 'SENIOR', reason: 'Stale screen attempt' })).status).toBe(409);
  });

  it('Physics → Computing (another subject), by a Super Administrator; filters follow the subject', async () => {
    const sub = await submit(ss, physicsAll);
    const before = await evidence(sub.id);
    await reassign(superAdmin, physicsAll, sub.id, { testId: computingAll, level: sub.level!, reason: 'Submitted under Physics by mistake' }).expect(200);
    expect(await evidence(sub.id)).toEqual(before);
    const inComputing = await http().get('/api/v1/admin/test-submissions').query({ subjectId: computing }).set(bearer(admin)).expect(200);
    expect(inComputing.body.data.map((r: any) => r.id)).toContain(sub.id);
    const inPhysics = await http().get('/api/v1/admin/test-submissions').query({ subjectId: physics }).set(bearer(admin)).expect(200);
    expect(inPhysics.body.data.map((r: any) => r.id)).not.toContain(sub.id);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'TEST_SUBMISSION_REASSIGNED', entityId: sub.id } });
    expect(audit.metadata).toMatchObject({ before: { subjectCode: 'RA_PHYSICS' }, after: { subjectCode: 'RA_COMPUTING' } });
  });

  it('refusals: DUPLICATE_SUBMISSION, FORMAT_MISMATCH, NO_CHANGE, a short reason — and nothing changes', async () => {
    const a = await submit(sj2, physicsAll);
    await submit(sj2, computingAll);
    const before = await p().testSubmission.findUniqueOrThrow({ where: { id: a.id } });
    const dup = await reassign(admin, physicsAll, a.id, { testId: computingAll, level: a.level!, reason: 'Wrong subject chosen' });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_SUBMISSION']);
    const fmt = await reassign(admin, physicsAll, a.id, { testId: typedOnly, level: a.level!, reason: 'Wrong subject chosen' });
    expect([fmt.status, fmt.body.code]).toEqual([400, 'FORMAT_MISMATCH']);
    const same = await reassign(admin, physicsAll, a.id, { testId: physicsAll, level: a.level!, reason: 'No change at all' });
    expect([same.status, same.body.code]).toEqual([400, 'NO_CHANGE']);
    expect((await reassign(admin, physicsAll, a.id, { testId: mathsAll, level: a.level!, reason: 'no' })).status).toBe(400);
    expect(await p().testSubmission.findUniqueOrThrow({ where: { id: a.id } })).toEqual(before);
    const opts = await http().get(`${SUB(physicsAll, a.id)}/reassignment`).set(bearer(admin)).expect(200);
    expect(opts.body.destinations.find((d: any) => d.id === computingAll).problem).toBe('DUPLICATE_SUBMISSION');
    expect(opts.body.destinations.find((d: any) => d.id === typedOnly).problem).toBe('FORMAT_MISMATCH');
  });

  it('marking started: another test is refused (MARKING_STARTED) and nothing changes; the level within the test is corrected and the marks stay', async () => {
    // A question-marked test for every level: the paper is marked on question 1 by an authorised coach.
    await http().patch(`${T}/${mathsAll}/question-marking/mode`).set(bearer(headCoach)).send({ mode: 'QUESTION' }).expect(200);
    const marker = await p().user.findUniqueOrThrow({ where: { username: 'mentor.j' } });
    await http().post('/api/v1/admin/test-markers').set(bearer(admin)).send({ coachId: marker.id, subjectId: maths }).expect(201);
    const qs = (await p().testQuestion.findMany({ where: { testId: mathsAll }, orderBy: { order: 'asc' } })).map((q) => q.id);
    for (const q of qs) await http().put(`${T}/${mathsAll}/question-marking/questions/${q}/markers`).set(bearer(headCoach)).send({ add: [marker.id], remove: [] }).expect(200);
    const sub = await submit(sj2, mathsAll);
    await p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${mathsAll}`;
    await http().post(`${T}/${mathsAll}/question-marking/tasks/generate`).set(bearer(headCoach)).send({}).expect(200);
    await http().post(`/api/v1/marking/tasks/${sub.publicCode}/q1/claim`).set(bearer(coach)).send({}).expect(200);
    await http().post(`/api/v1/marking/tasks/${sub.publicCode}/q1/submit`).set(bearer(coach)).send({ marks: 4 }).expect(200);
    const marksBefore = await p().testQuestionAssessment.findMany({ where: { task: { submissionId: sub.id } }, select: { id: true, marks: true, status: true } });
    const tasksBefore = await p().testQuestionTask.findMany({ where: { submissionId: sub.id }, select: { id: true, status: true, questionId: true } });
    expect(marksBefore).toEqual([expect.objectContaining({ marks: 4 })]);
    const rowBefore = await p().testSubmission.findUniqueOrThrow({ where: { id: sub.id } });

    const opts = await http().get(`${SUB(mathsAll, sub.id)}/reassignment`).set(bearer(admin)).expect(200);
    expect(opts.body.markingStarted).toBe(true);
    expect(opts.body.marking.questionTasks).toBe(2);
    expect(opts.body.destinations.filter((d: any) => d.problem === null)).toEqual([]);
    const move = await reassign(admin, mathsAll, sub.id, { testId: mathsSenior, level: 'SENIOR', reason: 'Should be Senior Mathematics' });
    expect([move.status, move.body.code]).toEqual([409, 'MARKING_STARTED']);
    expect(await p().testSubmission.findUniqueOrThrow({ where: { id: sub.id } })).toEqual(rowBefore);

    // The level only, within the same test: allowed; the marks, tasks and status stay exactly as they were.
    const lv = await reassign(admin, mathsAll, sub.id, { testId: mathsAll, level: 'SENIOR', reason: 'Student is in the Senior level' }).expect(200);
    expect(lv.body).toMatchObject({ moved: false, after: { testId: mathsAll, level: 'SENIOR' } });
    const rowAfter = await p().testSubmission.findUniqueOrThrow({ where: { id: sub.id } });
    expect({ ...rowAfter, level: null, updatedAt: null }).toEqual({ ...rowBefore, level: null, updatedAt: null });
    expect(rowAfter.level).toBe('SENIOR');
    expect(await p().testQuestionAssessment.findMany({ where: { task: { submissionId: sub.id } }, select: { id: true, marks: true, status: true } })).toEqual(marksBefore);
    expect(await p().testQuestionTask.findMany({ where: { submissionId: sub.id }, select: { id: true, status: true, questionId: true } })).toEqual(tasksBefore);
    await http().post(`/api/v1/marking/tasks/${sub.publicCode}/q1/release`).set(bearer(coach)).send({});
  });
});
