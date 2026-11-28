import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Question-level marking (design Rev 5.2, approved 2026-11-26) on PostgreSQL: the shared pool, one holder per
 * (paper, question, round, cycle), several coaches on different questions of the SAME paper, claims / expiry / release /
 * the limit, review per question, second-assessment cycles, decisions, the paper projection and the COMPOSED final
 * marking, publication and withdrawal, revocation, resubmission, the structure / wording / guide freezes, the access log,
 * permissions, and PAPER-mode compatibility.
 *
 * Fixtures: Mathematics; Head Coach HM heads it. Coaches X, Y, Z (authorised for Mathematics) and W (not authorised).
 * Kaline = student.j. Questions Q1 (5), Q2 (10), Q3 (5): markers Q1 X,Y; Q2 X,Y,Z; Q3 X,Z (the owner's example).
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, PDF, waitForEvents, type TestContext } from './helpers.js';

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Measurements for the completion report (also printed): appended to <tmp>/qm-reports.jsonl. */
const qmReport = (kind: string, data: unknown) => appendFileSync(join(tmpdir(), 'qm-reports.jsonl'), JSON.stringify({ kind, at: new Date().toISOString(), data }) + '\n');

describe('Question-level marking (Rev 5.2) — e2e', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, hm: string, cx: string, cy: string, cz: string, cw: string, sj: string, sj2: string, ss: string;
  let maths: string, xId: string, yId: string, zId: string, wId: string, stJ: string, stJ2: string, stS: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  const ME = '/api/v1/me/tests';
  const MT = '/api/v1/marking/tasks';
  const QM = (id: string) => `${T}/${id}/question-marking`;

  /** A published QUESTION-mode test with three questions (5, 10, 5), the marking guide, markers as in the owner's example. */
  const questionTest = async (title: string, questions: number[] = [5, 10, 5]) => {
    const max = questions.reduce((a, b) => a + b, 0);
    const res = await http().post(T).set(bearer(admin)).send({
      title, subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: max,
      questions: questions.map((m, i) => ({ prompt: `Question ${i + 1}`, maxMarks: m })),
    }).expect(201);
    const id = res.body.id as string;
    await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'guide.pdf').expect(200);
    await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200);
    await http().patch(`${QM(id)}/mode`).set(bearer(hm)).send({ mode: 'QUESTION' }).expect(200);
    return id;
  };
  const qids = async (testId: string) => (await p().testQuestion.findMany({ where: { testId }, orderBy: { order: 'asc' } })).map((q) => q.id);
  const setMarkers = (id: string, q: string, add: string[], remove: string[] = [], reason?: string) =>
    http().put(`${QM(id)}/questions/${q}/markers`).set(bearer(hm)).send({ add, remove, ...(reason && { reason }) });
  const ownersMarkers = async (id: string) => {
    const [q1, q2, q3] = await qids(id);
    await setMarkers(id, q1, [xId, yId]).expect(200);
    await setMarkers(id, q2, [xId, yId, zId]).expect(200);
    await setMarkers(id, q3, [xId, zId]).expect(200);
  };
  const closeNow = (id: string) => p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
  const submit = async (token: string, id: string, withPage = false) => {
    const key = randomUUID();
    if (withPage) await http().post(`${ME}/${id}/uploads/${key}/pages/1`).set(bearer(token)).attach('file', PNG, 'IMG Kaline Uwase.png').expect(201);
    await http().post(`${ME}/${id}/submission`).set(bearer(token)).send({ clientKey: key, typedAnswer: 'My answers', ...(withPage && { pageCount: 1 }) }).expect(201);
  };
  const codeOf = async (testId: string, studentId: string) => (await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId } } })).publicCode;
  const paperOf = (testId: string, studentId: string) => p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId } } });
  const taskId = async (testId: string, studentId: string, order: number, round: 'FIRST' | 'SECOND' = 'FIRST', cycle = 0) =>
    (await p().testQuestionTask.findFirstOrThrow({ where: { submission: { testId, studentId }, question: { order }, round, cycle } })).id;
  const claim = (token: string, code: string, ref: string) => http().post(`${MT}/${code}/${ref}/claim`).set(bearer(token)).send({});
  const save = (token: string, code: string, ref: string, body: object) => http().put(`${MT}/${code}/${ref}/marks`).set(bearer(token)).send(body);
  const submitQ = (token: string, code: string, ref: string, body: object) => http().post(`${MT}/${code}/${ref}/submit`).set(bearer(token)).send(body);
  const release = (token: string, code: string, ref: string) => http().post(`${MT}/${code}/${ref}/release`).set(bearer(token)).send({});
  /** A ready test: three answers (Kaline with a photo page), deadline passed, tasks generated. */
  const readyTest = async (title: string) => {
    const id = await questionTest(title);
    await ownersMarkers(id);
    await submit(sj, id, true);
    await submit(sj2, id);
    await submit(ss, id);
    await closeNow(id);
    const g = await http().post(`${QM(id)}/tasks/generate`).set(bearer(hm)).send({}).expect(200);
    expect(g.body).toMatchObject({ created: 9, papers: 3, questions: 3, skipped: [] });
    return id;
  };

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    process.env.QUESTION_MARKING_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'MENTOR' | 'SUPER_ADMIN') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    const hmId = await mk('qm.head', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    await mk('qm.super', 'SUPER_ADMIN');
    xId = await mk('qm.x', 'MENTOR'); yId = await mk('qm.y', 'MENTOR'); zId = await mk('qm.z', 'MENTOR'); wId = await mk('qm.w', 'MENTOR');
    stJ = ctx.ids.studentJunior; stJ2 = ctx.ids.studentJunior2; stS = ctx.ids.studentSenior;
    admin = await login(ctx, 'admin');
    superAdmin = await login(ctx, 'qm.super');
    hm = await login(ctx, 'qm.head');
    cx = await login(ctx, 'qm.x'); cy = await login(ctx, 'qm.y'); cz = await login(ctx, 'qm.z'); cw = await login(ctx, 'qm.w');
    sj = await login(ctx, 'student.j'); sj2 = await login(ctx, 'student.j2'); ss = await login(ctx, 'student.s');
    for (const coachId of [xId, yId, zId]) await http().post('/api/v1/admin/test-markers').set(bearer(admin)).send({ coachId, subjectId: maths }).expect(201);
  });
  /** Independence between tests: every open claim is given back by its holder; X, Y and Z are authorised again. */
  afterEach(async () => {
    const tokens = new Map([[xId, cx], [yId, cy], [zId, cz]]);
    const open = await p().$queryRaw<Array<{ coachId: string; code: string; ord: number; round: string; cycle: number }>>`
      SELECT c."coachId", s."publicCode" AS "code", q."order" AS "ord", k."round"::text AS "round", k."cycle"
        FROM "TestTaskClaim" c JOIN "TestQuestionTask" k ON k."claimId" = c."id" JOIN "TestSubmission" s ON s."id" = k."submissionId" JOIN "TestQuestion" q ON q."id" = k."questionId"
       WHERE c."endedAt" IS NULL`;
    for (const o of open) {
      const token = tokens.get(o.coachId);
      if (token) await release(token, o.code, o.round === 'SECOND' ? `q${o.ord}-s${o.cycle}` : `q${o.ord}`);
    }
    for (const coachId of [xId, yId, zId]) {
      if (!(await p().markerAuthorization.count({ where: { coachId, disciplineId: maths, revokedAt: null } }))) {
        await http().post('/api/v1/admin/test-markers').set(bearer(admin)).send({ coachId, subjectId: maths }).expect(201);
      }
    }
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED; delete process.env.TEACHERS_ENABLED; delete process.env.QUESTION_MARKING_ENABLED;
    await ctx?.app.close();
  });

  it('permissions per role and route: staff routes for Administrators and Head Coaches; decide for the Head Coach only (G4); the pool for Coaches only', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const staff = [['get', QM(id)], ['patch', `${QM(id)}/mode`], ['get', `${QM(id)}/markers`], ['put', `${QM(id)}/questions/${id}/markers`],
      ['post', `${QM(id)}/tasks/generate`], ['get', `${QM(id)}/tasks`], ['get', `${QM(id)}/tasks/${id}`], ['post', `${QM(id)}/tasks/${id}/assign`],
      ['post', `${QM(id)}/tasks/${id}/release`], ['post', `${QM(id)}/tasks/${id}/review-hold`], ['post', `${QM(id)}/tasks/${id}/approve`],
      ['post', `${QM(id)}/tasks/${id}/return`], ['post', `${QM(id)}/tasks/${id}/second-assessment`], ['post', `${QM(id)}/tasks/${id}/cancel-second`],
      ['post', `${QM(id)}/tasks/${id}/reopen`], ['get', `${QM(id)}/progress`], ['get', `${QM(id)}/history`], ['get', `${QM(id)}/papers/${id}/pages/1`],
      ['post', `${QM(id)}/questions/${id}/wording-correction`], ['post', `${QM(id)}/structure-correction`]] as const;
    const decide = [['post', `${QM(id)}/tasks/${id}/decide`]] as const;
    const code = 'ABCD-EFGH';
    const coach = [['get', MT], ['post', `${MT}/${code}/q1/claim`], ['get', `${MT}/${code}/q1`], ['get', `${MT}/${code}/q1/pages/1`],
      ['get', `${MT}/${code}/q1/paper`], ['get', `${MT}/${code}/q1/marking-guide`], ['post', `${MT}/${code}/q1/heartbeat`],
      ['put', `${MT}/${code}/q1/marks`], ['post', `${MT}/${code}/q1/submit`], ['post', `${MT}/${code}/q1/release`]] as const;
    const check = async (tokens: string[], routes: readonly (readonly [string, string])[]) => {
      for (const token of tokens) for (const [method, path] of routes) {
        expect([method, path, await status((http() as any)[method](path).set(bearer(token)).send({}))]).toEqual([method, path, [403, 'PERMISSION_REQUIRED']]);
      }
    };
    await check([sj, cx], staff);
    await check([sj, cx, admin, superAdmin], decide);   // G4: Administrators and Super Admins never decide marks
    await check([sj, admin, superAdmin, hm], coach);    // nobody but a Coach marks
    for (const [method, path] of [...staff, ...decide, ...coach]) expect((await (http() as any)[method](path)).status).toBe(401);
  });

  it('mode: QUESTION needs questions; refused once paper-level marking exists (assignment, ended assignment, marking, review); PAPER routes refuse a QUESTION test', async () => {
    const noQ = await http().post(T).set(bearer(admin)).send({ title: 'No questions', subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(60), maxMarks: 10 }).expect(201);
    expect(await status(http().patch(`${QM(noQ.body.id)}/mode`).set(bearer(hm)).send({ mode: 'QUESTION' }))).toEqual([409, 'NO_QUESTIONS']);
    // A PAPER test marked the old way: every legacy state blocks the mode change, through the API and the trigger.
    const res = await http().post(T).set(bearer(admin)).send({ title: 'Legacy', subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(60), maxMarks: 10, questions: [{ prompt: 'a', maxMarks: 10 }] }).expect(201);
    const legacy = res.body.id;
    await http().post(`${T}/${legacy}/publish`).set(bearer(admin)).expect(200);
    await submit(sj, legacy);
    await closeNow(legacy);
    const triggerRefuses = async () => { await expect(p().$executeRaw`UPDATE "Test" SET "markingMode" = 'QUESTION' WHERE "id" = ${legacy}`).rejects.toThrow(/marking mode cannot change/); };
    await http().post(`${T}/${legacy}/marking/distribute`).set(bearer(hm)).send({ coachIds: [xId] }).expect(200);
    expect(await status(http().patch(`${QM(legacy)}/mode`).set(bearer(hm)).send({ mode: 'QUESTION' }))).toEqual([409, 'MARKING_STARTED']);
    await triggerRefuses();
    const sub = await paperOf(legacy, stJ);
    await http().post(`${T}/${legacy}/marking/submissions/${sub.id}/reassign`).set(bearer(hm)).send({ coachId: yId, reason: 'Coach X away' }).expect(200);
    await triggerRefuses();                              // an ENDED assignment still counts
    expect(await status(http().get(QM(legacy)).set(bearer(hm)))).toEqual([200, null]);
    expect(await status(http().get(`${QM(legacy)}/markers`).set(bearer(hm)))).toEqual([409, 'WRONG_MARKING_MODE']);
    // and the paper-level routes refuse a QUESTION test
    const q = await questionTest('Paper routes refused');
    expect(await status(http().post(`${T}/${q}/marking/distribute`).set(bearer(hm)).send({ coachIds: [xId] }))).toEqual([409, 'WRONG_MARKING_MODE']);
    expect(await status(http().patch(`${QM(q)}/mode`).set(bearer(hm)).send({ mode: 'PAPER' }))).toEqual([200, null]);
  });

  it("the owner's example: X, Z and Y hold Kaline's Q1, Q3 and Q2 at once; Q2 is refused to X and Z; W (not a marker) is refused", async () => {
    const id = await readyTest('Owner example');
    const code = await codeOf(id, stJ);
    const r1 = await claim(cx, code, 'q1').expect(200);
    expect(r1.body).toMatchObject({ ref: 'q1', code, question: { order: 1, maxMarks: 5 }, canEdit: true, myAssessment: { status: 'DRAFT', marks: null } });
    await claim(cz, code, 'q3').expect(200);
    await claim(cy, code, 'q2').expect(200);
    expect(await status(claim(cx, code, 'q2'))).toEqual([409, 'TASK_TAKEN']);
    expect(await status(claim(cz, code, 'q2'))).toEqual([409, 'TASK_TAKEN']);
    expect(await status(claim(cw, code, 'q1'))).toEqual([403, 'MARKER_NOT_AUTHORIZED']);
    expect(await status(claim(cy, code, 'q3'))).toEqual([403, 'QUESTION_NOT_ASSIGNED']);
    const held = await p().testQuestionTask.findMany({ where: { submission: { testId: id, studentId: stJ } }, orderBy: { question: { order: 'asc' } }, select: { holderId: true, status: true } });
    expect(held).toEqual([{ holderId: xId, status: 'IN_PROGRESS' }, { holderId: yId, status: 'IN_PROGRESS' }, { holderId: zId, status: 'IN_PROGRESS' }]);
    expect((await paperOf(id, stJ)).status).toBe('MARKING_IN_PROGRESS');
    // Blind: nothing names the student (server-side assertQmBlind too), and nothing of anyone else's work.
    const d = await http().get(`${MT}/${code}/q1`).set(bearer(cx)).expect(200);
    const text = JSON.stringify(d.body);
    for (const leak of ['student.j', 'Kaline', 'qm.y', 'qm.z', 'IMG']) expect([leak, text.includes(leak)]).toEqual([leak, false]);
    expect(d.body.answer.pages).toEqual([expect.objectContaining({ pageNumber: 1, name: 'page-1.png' })]);
    // The queue: X sees Q1 as MINE, Kaline's Q2 as TAKEN (in ALL), Q1/Q2/Q3 of the others as AVAILABLE
    const q = await http().get(MT).query({ view: 'ALL', testId: id }).set(bearer(cx)).expect(200);
    const mine = q.body.data.filter((r: any) => r.code === code).map((r: any) => [r.ref, r.state]);
    expect(mine).toEqual([['q1', 'MINE'], ['q2', 'TAKEN'], ['q3', 'TAKEN']]);
    expect(q.body.counts.TO_MARK).toBe(1 + 6);              // mine + the two other papers' three questions
    // Each submits independently; the others keep marking.
    await submitQ(cx, code, 'q1', { marks: 4, comment: 'Good' }).expect(200);
    await save(cy, code, 'q2', { marks: 7 }).expect(200);
    expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: await taskId(id, stJ, 1) } })).status).toBe('SUBMITTED');
    expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: await taskId(id, stJ, 2) } })).status).toBe('IN_PROGRESS');
    expect(await status(save(cx, code, 'q1', { marks: 5 }))).toEqual([409, 'CLAIM_LOST']);   // submitted: no more edits
  });

  it('release and drafts (Rev 5): X saves and releases, Y claims empty, Y releases, X claims again EMPTY; earlier drafts only for staff', async () => {
    const id = await readyTest('Release');
    const code = await codeOf(id, stJ2);
    await claim(cx, code, 'q2').expect(200);
    await save(cx, code, 'q2', { marks: 3, comment: 'draft X' }).expect(200);
    await release(cx, code, 'q2').expect(200);
    const yView = await claim(cy, code, 'q2').expect(200);
    expect(yView.body.myAssessment).toMatchObject({ marks: null, comment: null, status: 'DRAFT' });
    await save(cy, code, 'q2', { marks: 8 }).expect(200);
    await release(cy, code, 'q2').expect(200);
    const again = await claim(cx, code, 'q2').expect(200);
    expect(again.body.myAssessment).toMatchObject({ marks: null, comment: null, status: 'DRAFT' });
    expect(JSON.stringify(again.body)).not.toContain('draft X');
    const t2 = await taskId(id, stJ2, 2);
    const all = await p().testQuestionAssessment.findMany({ where: { taskId: t2 }, orderBy: { createdAt: 'asc' }, select: { markerId: true, status: true, marks: true } });
    expect(all).toEqual([{ markerId: xId, status: 'ABANDONED', marks: 3 }, { markerId: yId, status: 'ABANDONED', marks: 8 }, { markerId: xId, status: 'DRAFT', marks: null }]);
    const ev = (await p().testTaskEvent.findMany({ where: { taskId: t2 }, orderBy: { createdAt: 'asc' }, select: { action: true } })).map((e) => e.action);
    expect(ev).toEqual(['CLAIMED', 'ASSESSMENT_ABANDONED', 'RELEASED', 'CLAIMED', 'ASSESSMENT_ABANDONED', 'RELEASED', 'CLAIMED']);
    // Staff see the whole history.
    const staff = await http().get(`${QM(id)}/tasks/${t2}`).set(bearer(hm)).expect(200);
    expect(staff.body.assessments.map((a: any) => a.status)).toEqual(['ABANDONED', 'ABANDONED', 'DRAFT']);
    await release(cx, code, 'q2').expect(200);
  });

  it('expiry: a lapsed claim is taken by another coach; the old tab cannot save (CLAIM_LOST EXPIRED); its draft is kept; the next claim is empty', async () => {
    const id = await readyTest('Expiry');
    const code = await codeOf(id, stS);
    await claim(cx, code, 'q1').expect(200);
    await save(cx, code, 'q1', { marks: 2 }).expect(200);
    const hb = await http().post(`${MT}/${code}/q1/heartbeat`).set(bearer(cx)).send({}).expect(200);
    expect(new Date(hb.body.lockExpiresAt).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    const t1 = await taskId(id, stS, 1);
    await p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() - interval '1 minute' WHERE "id" = ${t1}`;
    const r = await claim(cy, code, 'q1').expect(200);
    expect(r.body.myAssessment.marks).toBeNull();
    const lost = await save(cx, code, 'q1', { marks: 5 });
    expect([lost.status, lost.body.code, lost.body.details?.reason]).toEqual([409, 'CLAIM_LOST', 'EXPIRED']);
    const claims = await p().testTaskClaim.findMany({ where: { taskId: t1 }, orderBy: { claimedAt: 'asc' }, select: { coachId: true, endReason: true } });
    expect(claims).toEqual([{ coachId: xId, endReason: 'EXPIRED' }, { coachId: yId, endReason: null }]);
    expect((await p().testQuestionAssessment.findFirstOrThrow({ where: { taskId: t1, markerId: xId } })).status).toBe('ABANDONED');
    await release(cy, code, 'q1').expect(200);
  });

  it('the active-claim limit (3, configurable): expired claims never count; staff assignment obeys the same limit (no override)', async () => {
    const id = await readyTest('Limit');
    const [a, b, c] = [await codeOf(id, stJ), await codeOf(id, stJ2), await codeOf(id, stS)];
    await claim(cx, a, 'q1').expect(200);
    await claim(cx, b, 'q1').expect(200);
    await claim(cx, c, 'q1').expect(200);
    expect(await status(claim(cx, a, 'q2'))).toEqual([409, 'CLAIM_LIMIT']);
    const t = await taskId(id, stJ, 2);
    const assign = await http().post(`${QM(id)}/tasks/${t}/assign`).set(bearer(hm)).send({ coachId: xId, reason: 'Exceptional cover' });
    expect([assign.status, assign.body.code]).toEqual([409, 'CLAIM_LIMIT']);
    expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: t } })).status).toBe('NOT_STARTED');
    // One of X's claims lapses: it no longer counts, and the claim cleans it up first.
    await p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() - interval '1 minute' WHERE "id" = ${await taskId(id, stJ, 1)}`;
    await claim(cx, a, 'q2').expect(200);
    expect(await p().testTaskClaim.count({ where: { coachId: xId, endedAt: null } })).toBe(3);
    expect((await p().testTaskClaim.findFirstOrThrow({ where: { coachId: xId, task: { id: await taskId(id, stJ, 1) } } })).endReason).toBe('EXPIRED');
    // A Super Admin raises the limit to 4: assignment then works (and records the reason).
    await p().systemSetting.upsert({ where: { key: 'marking.maxActiveClaims' }, create: { key: 'marking.maxActiveClaims', value: 4 }, update: { value: 4 } });
    await http().post(`${QM(id)}/tasks/${await taskId(id, stJ, 3)}/assign`).set(bearer(hm)).send({ coachId: xId, reason: 'Exceptional cover' }).expect(200);
    await p().systemSetting.delete({ where: { key: 'marking.maxActiveClaims' } });
    for (const [code, ref] of [[a, 'q2'], [b, 'q1'], [c, 'q1'], [a, 'q3']] as const) await release(cx, code, ref).expect(200);
  });

  it('review per question, projection and the COMPOSED marking: approved / returned / resumed; the paper approves only when every question does; publish; reopen withdraws', async () => {
    const id = await readyTest('Review');
    const code = await codeOf(id, stJ);
    for (const [tok, ref, m] of [[cx, 'q1', 4], [cy, 'q2', 7], [cz, 'q3', 3]] as const) {
      await claim(tok, code, ref).expect(200);
      await submitQ(tok, code, ref, { marks: m }).expect(200);
    }
    const [t1, t2, t3] = [await taskId(id, stJ, 1), await taskId(id, stJ, 2), await taskId(id, stJ, 3)];
    expect((await paperOf(id, stJ)).status).toBe('MARKED');
    await http().post(`${QM(id)}/tasks/${t1}/approve`).set(bearer(hm)).send({}).expect(200);
    expect((await paperOf(id, stJ)).status).toBe('MARKED');                       // partially approved
    expect(await status(http().post(`${QM(id)}/tasks/${t2}/return`).set(bearer(hm)).send({}))).toEqual([400, 'VALIDATION_FAILED']);
    await http().post(`${QM(id)}/tasks/${t2}/return`).set(bearer(hm)).send({ reason: 'Recheck part (b).' }).expect(200);
    expect((await paperOf(id, stJ)).status).toBe('RETURNED');
    expect(await status(claim(cx, code, 'q2'))).toEqual([409, 'TASK_NOT_AVAILABLE']);   // reserved for Y
    const back = await claim(cy, code, 'q2').expect(200);                               // RESUME
    expect(back.body).toMatchObject({ myAssessment: { status: 'RETURNED', marks: 7, version: 1 }, returnReason: 'Recheck part (b).' });
    await submitQ(cy, code, 'q2', { marks: 8 }).expect(200);
    const versions = await p().testAssessmentVersion.findMany({ where: { assessment: { taskId: t2 } }, orderBy: { version: 'asc' }, select: { version: true, marks: true } });
    expect(versions).toEqual([{ version: 1, marks: 7 }, { version: 2, marks: 8 }]);
    await http().post(`${QM(id)}/tasks/${t2}/approve`).set(bearer(admin)).send({}).expect(200);
    expect((await paperOf(id, stJ)).status).toBe('MARKED');
    // Concurrent review: two reviewers on Q3 — one approves, the other's return loses with TASK_CHANGED.
    const [ra, rb] = await Promise.all([
      http().post(`${QM(id)}/tasks/${t3}/approve`).set(bearer(hm)).send({}),
      http().post(`${QM(id)}/tasks/${t3}/return`).set(bearer(admin)).send({ reason: 'Too generous.' }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.code).toBe('TASK_CHANGED');
    const final = (await p().testQuestionTask.findUniqueOrThrow({ where: { id: t3 } })).status;
    if (final === 'RETURNED') { await claim(cz, code, 'q3').expect(200); await submitQ(cz, code, 'q3', { marks: 3 }).expect(200); await http().post(`${QM(id)}/tasks/${t3}/approve`).set(bearer(hm)).send({}).expect(200); }
    const paper = await paperOf(id, stJ);
    expect(paper.status).toBe('APPROVED');
    const composed = await p().testMarking.findUniqueOrThrow({ where: { id: paper.finalMarkingId! }, select: { kind: true, status: true, totalMarks: true, markerId: true, scores: { select: { marks: true } } } });
    expect(composed).toMatchObject({ kind: 'COMPOSED', status: 'APPROVED', totalMarks: 4 + 8 + 3 });
    expect(composed.scores.map((s) => s.marks).sort()).toEqual([3, 4, 8]);
    const decisions = await p().testQuestionDecision.findMany({ where: { task: { submissionId: paper.id }, supersededAt: null }, select: { source: true } });
    expect(decisions.map((d) => d.source)).toEqual(['APPROVED_AS_MARKED', 'APPROVED_AS_MARKED', 'APPROVED_AS_MARKED']);
    // The other papers: approve all, then publish through the EXISTING results path.
    for (const st of [stJ2, stS]) {
      const c = await codeOf(id, st);
      for (const [tok, ref] of [[cx, 'q1'], [cy, 'q2'], [cz, 'q3']] as const) { await claim(tok, c, ref).expect(200); await submitQ(tok, c, ref, { marks: 1 }).expect(200); }
      for (const o of [1, 2, 3]) await http().post(`${QM(id)}/tasks/${await taskId(id, st, o)}/approve`).set(bearer(hm)).send({}).expect(200);
    }
    await http().post(`${T}/${id}/results/publish`).set(bearer(hm)).send({}).expect(200);
    expect((await paperOf(id, stJ)).status).toBe('PUBLISHED');
    const mine = await http().get(`/api/v1/me/test-results/${id}`).set(bearer(sj)).expect(200);
    expect(mine.body.result).toMatchObject({ totalMarks: 15, maxMarks: 20 });
    // Reopen Q2 of a PUBLISHED paper: withdrawn (G6), decision superseded, composed unset, Y has it back.
    await http().post(`${QM(id)}/tasks/${t2}/reopen`).set(bearer(hm)).send({ reason: 'Score sheet error.', to: 'RETURNED' }).expect(200);
    // Review 2026-11-28: the coach is told the reopen's reason, not the older return's.
    const reopened = await claim(cy, code, 'q2').expect(200);
    expect(reopened.body).toMatchObject({ returnReason: 'Score sheet error.' });
    await http().post(`${MT}/${code}/q2/release`).set(bearer(cy)).send({}).expect(200);
    const after = await paperOf(id, stJ);
    expect([after.status, after.finalMarkingId, after.publicationId]).toEqual(['RETURNED', null, null]);
    expect(await p().testResultWithdrawal.count({ where: { submissionId: paper.id } })).toBe(1);
    expect(await p().testQuestionDecision.count({ where: { taskId: t2, supersededAt: { not: null } } })).toBe(1);
    expect((await p().testMarking.findUniqueOrThrow({ where: { id: paper.finalMarkingId! } })).status).toBe('APPROVED');   // old COMPOSED kept
    await waitForEvents();
  });

  it('second-assessment cycles: first marker excluded (claim and assignment), blind second, decision required, Head Coach only, cancel, a new cycle after reopen', async () => {
    const id = await readyTest('Second');
    const code = await codeOf(id, stJ2);
    await claim(cx, code, 'q2').expect(200);
    await submitQ(cx, code, 'q2', { marks: 6, comment: 'first view' }).expect(200);
    const t2 = await taskId(id, stJ2, 2);
    await http().post(`${QM(id)}/tasks/${t2}/second-assessment`).set(bearer(hm)).send({ reason: 'Borderline' }).expect(200);
    expect(await status(http().post(`${QM(id)}/tasks/${t2}/second-assessment`).set(bearer(hm)).send({ cycleSeen: 0 }))).toEqual([409, 'TASK_CHANGED']);
    expect(await status(claim(cx, code, 'q2-s1'))).toEqual([403, 'FIRST_MARKER_EXCLUDED']);
    const s1 = await taskId(id, stJ2, 2, 'SECOND', 1);
    expect(await status(http().post(`${QM(id)}/tasks/${s1}/assign`).set(bearer(hm)).send({ coachId: xId, reason: 'Try first marker' }))).toEqual([403, 'FIRST_MARKER_EXCLUDED']);
    const view = await claim(cz, code, 'q2-s1').expect(200);
    const txt = JSON.stringify(view.body);
    expect(txt).not.toContain('first view');
    expect(txt).not.toContain('"marks":6');
    await submitQ(cz, code, 'q2-s1', { marks: 9 }).expect(200);
    expect(await status(http().post(`${QM(id)}/tasks/${t2}/approve`).set(bearer(hm)).send({}))).toEqual([409, 'DECISION_REQUIRED']);
    expect(await status(http().post(`${QM(id)}/tasks/${t2}/decide`).set(bearer(admin)).send({ source: 'ADJUSTED', marks: 8, reason: 'x' }))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().post(`${QM(id)}/tasks/${t2}/decide`).set(bearer(hm)).send({ source: 'ADJUSTED', marks: 8, reason: 'Between both readings' }).expect(200);
    expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: s1 } })).status).toBe('CLOSED');
    // Reopen for re-review → cycle 2 → cancelled → cycle 3 decided SECOND; cycles 1–3 kept with their own numbers.
    await http().post(`${QM(id)}/tasks/${t2}/reopen`).set(bearer(hm)).send({ reason: 'Moderation request', to: 'SUBMITTED' }).expect(200);
    await http().post(`${QM(id)}/tasks/${t2}/second-assessment`).set(bearer(hm)).send({ cycleSeen: 1 }).expect(200);
    await http().post(`${QM(id)}/tasks/${t2}/cancel-second`).set(bearer(hm)).send({ reason: 'No coach available' }).expect(200);
    await http().post(`${QM(id)}/tasks/${t2}/second-assessment`).set(bearer(hm)).send({ coachId: yId, reason: 'Named second marker' }).expect(200);
    const s3 = await taskId(id, stJ2, 2, 'SECOND', 3);
    expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: s3 } })).holderId).toBe(yId);
    await submitQ(cy, code, 'q2-s3', { marks: 7 }).expect(200);
    await http().post(`${QM(id)}/tasks/${t2}/decide`).set(bearer(hm)).send({ source: 'SECOND', reason: 'Second reading accepted' }).expect(200);
    const seconds = await p().testQuestionTask.findMany({ where: { firstTaskId: t2 }, orderBy: { cycle: 'asc' }, select: { cycle: true, status: true } });
    expect(seconds).toEqual([{ cycle: 1, status: 'CLOSED' }, { cycle: 2, status: 'CANCELLED' }, { cycle: 3, status: 'CLOSED' }]);
    const decisions = await p().testQuestionDecision.findMany({ where: { taskId: t2 }, orderBy: { decidedAt: 'asc' }, select: { source: true, marks: true, cycle: true, supersededAt: true } });
    expect(decisions.map((d) => [d.source, d.marks, d.cycle, d.supersededAt === null])).toEqual([['ADJUSTED', 8, 1, false], ['SECOND', 7, 3, true]]);
    // Review 2026-11-28: reopening a decided question for re-review, the Head Coach may approve it as marked (the decided
    // cycle's CLOSED second assessment no longer blocks it).
    await http().post(`${QM(id)}/tasks/${t2}/reopen`).set(bearer(hm)).send({ reason: 'Approve as first marked', to: 'SUBMITTED' }).expect(200);
    const reopenedDetail = await http().get(`${QM(id)}/tasks/${t2}`).set(bearer(hm)).expect(200);
    expect(reopenedDetail.body.allowed).toMatchObject({ approve: true, return: true });
    await http().post(`${QM(id)}/tasks/${t2}/approve`).set(bearer(hm)).send({}).expect(200);
    const current = await p().testQuestionDecision.findFirstOrThrow({ where: { taskId: t2, supersededAt: null }, select: { source: true, marks: true } });
    expect(current).toEqual({ source: 'APPROVED_AS_MARKED', marks: 6 });
    // The database refuses a decision whose marks differ from its source version, and a second current decision.
    const v = await p().testAssessmentVersion.findFirstOrThrow({ where: { assessment: { taskId: s3 } } });
    await expect(p().testQuestionDecision.create({ data: { taskId: t2, cycle: 3, source: 'SECOND', marks: 1, sourceVersionId: v.id, reason: 'forged', decidedAt: new Date() } })).rejects.toThrow();
  });

  it('revocation: the coach loses the subject — open claims end AUTHORISATION_LOST, reserved returns need reassignment, later saves are refused', async () => {
    const id = await readyTest('Revocation');
    const code = await codeOf(id, stS);
    await claim(cz, code, 'q2').expect(200);
    await save(cz, code, 'q2', { marks: 4 }).expect(200);
    await claim(cz, code, 'q3').expect(200);
    await submitQ(cz, code, 'q3', { marks: 2 }).expect(200);
    const t3 = await taskId(id, stS, 3);
    await http().post(`${QM(id)}/tasks/${t3}/return`).set(bearer(hm)).send({ reason: 'Please look again' }).expect(200);
    const auth = await p().markerAuthorization.findFirstOrThrow({ where: { coachId: zId, disciplineId: maths, revokedAt: null } });
    await http().post(`/api/v1/admin/test-markers/${auth.id}/revoke`).set(bearer(hm)).send({ reason: 'Left the programme' }).expect(200);
    const t2 = await taskId(id, stS, 2);
    expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t2 }, select: { status: true, holderId: true } })).toEqual({ status: 'NOT_STARTED', holderId: null });
    expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t3 }, select: { status: true, reservedForId: true, needsReassignment: true } })).toEqual({ status: 'RETURNED', reservedForId: null, needsReassignment: true });
    const lost = await save(cz, code, 'q2', { marks: 5 });
    expect([lost.status, lost.body.code]).toEqual([409, 'CLAIM_LOST']);
    expect(await status(claim(cz, code, 'q1'))).toEqual([403, 'MARKER_NOT_AUTHORIZED']);
    // A needs-reassignment return goes to someone only by staff assignment (never the pool): X gets it, starting empty.
    expect(await status(claim(cx, code, 'q3'))).toEqual([409, 'TASK_NOT_AVAILABLE']);
    await http().post(`${QM(id)}/tasks/${t3}/assign`).set(bearer(hm)).send({ coachId: xId, reason: 'Z left' }).expect(200);
    const assessments = await p().testQuestionAssessment.findMany({ where: { taskId: t3 }, orderBy: { createdAt: 'asc' }, select: { markerId: true, status: true, marks: true } });
    expect(assessments).toEqual([{ markerId: zId, status: 'SUPERSEDED', marks: 2 }, { markerId: xId, status: 'DRAFT', marks: null }]);
    await http().post('/api/v1/admin/test-markers').set(bearer(admin)).send({ coachId: zId, subjectId: maths }).expect(201);
    await release(cx, code, 'q3').expect(200);
  });

  it('authorisation is enforced on EVERY request, without the sweep (workers off): reads and writes refuse, the claim ends at once, another coach can take it', async () => {
    const id = await readyTest('Authorisation on every request');
    const code = await codeOf(id, stJ);
    const auth = await p().markerAuthorization.findFirstOrThrow({ where: { coachId: xId, disciplineId: maths, revokedAt: null } });
    // An authorisation loss no hook saw (e.g. a direct data correction): only the API's own check can catch it.
    const loseX = () => p().$executeRaw`UPDATE "MarkerAuthorization" SET "revokedAt" = now(), "revokedById" = ${ctx.ids.admin}, "revokeReason" = 'direct' WHERE "id" = ${auth.id}`;
    const restoreX = () => p().$executeRaw`UPDATE "MarkerAuthorization" SET "revokedAt" = NULL, "revokedById" = NULL, "revokeReason" = NULL WHERE "id" = ${auth.id}`;
    try {
      await claim(cx, code, 'q3').expect(200);
      await submitQ(cx, code, 'q3', { marks: 3 }).expect(200);
      await claim(cx, code, 'q1').expect(200);
      await save(cx, code, 'q1', { marks: 2 }).expect(200);
      await loseX();
      const t1 = await taskId(id, stJ, 1);
      // 1. Reading the paper (the task, a page, the guide): refused, and the claim ends in that very request.
      const detail = await http().get(`${MT}/${code}/q1`).set(bearer(cx));
      expect([detail.status, detail.body.code, detail.body.details?.reason]).toEqual([409, 'CLAIM_LOST', 'AUTHORISATION_LOST']);
      expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t1 }, select: { status: true, holderId: true, claimId: true } })).toEqual({ status: 'NOT_STARTED', holderId: null, claimId: null });
      const claims = await p().testTaskClaim.findMany({ where: { taskId: t1, coachId: xId }, select: { endReason: true } });
      expect(claims).toEqual([{ endReason: 'AUTHORISATION_LOST' }]);
      expect((await p().testQuestionAssessment.findFirstOrThrow({ where: { taskId: t1, markerId: xId } })).status).toBe('ABANDONED');   // the draft is kept for staff
      for (const path of ['pages/1', 'marking-guide', 'paper']) {
        const r = await http().get(`${MT}/${code}/q1/${path}`).set(bearer(cx));
        expect([path, r.status, r.body.code]).toEqual([path, 409, 'CLAIM_LOST']);
      }
      // 2. Writes: refused with the reason.
      for (const r of [await save(cx, code, 'q1', { marks: 3 }), await submitQ(cx, code, 'q1', { marks: 3 }), await http().post(`${MT}/${code}/q1/heartbeat`).set(bearer(cx)).send({})]) {
        expect([r.status, r.body.code, r.body.details?.reason]).toEqual([409, 'CLAIM_LOST', 'AUTHORISATION_LOST']);
      }
      // 3. Even the coach's own submitted work is no longer shown to them.
      expect(await status(http().get(`${MT}/${code}/q3`).set(bearer(cx)))).toEqual([403, 'MARKER_NOT_AUTHORIZED']);
      expect(await status(claim(cx, code, 'q2'))).toEqual([403, 'MARKER_NOT_AUTHORIZED']);
      // 4. A live hold of a coach who lost authorisation (no request of theirs since): another coach takes it over at once.
      await restoreX();
      await claim(cx, code, 'q2').expect(200);
      await save(cx, code, 'q2', { marks: 7 }).expect(200);
      await loseX();
      const takeover = await claim(cy, code, 'q2');
      expect(takeover.status).toBe(200);
      const t2 = await taskId(id, stJ, 2);
      expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: t2 } })).holderId).toBe(yId);
      expect((await p().testTaskClaim.findFirstOrThrow({ where: { taskId: t2, coachId: xId } })).endReason).toBe('AUTHORISATION_LOST');
      const ev = await p().testTaskEvent.findFirstOrThrow({ where: { taskId: t2, action: { equals: 'CLAIMED' } }, orderBy: { createdAt: 'desc' } });
      expect(ev.meta).toMatchObject({ previousHolder: xId, previousEnd: 'AUTHORISATION_LOST' });
      const y = await http().get(`${MT}/${code}/q2`).set(bearer(cy)).expect(200);
      expect(y.body.myAssessment).toMatchObject({ status: 'DRAFT', marks: null });   // Y starts empty: X's draft is not passed on
      const lost = await http().post(`${MT}/${code}/q2/heartbeat`).set(bearer(cx)).send({});
      expect([lost.status, lost.body.code, lost.body.details?.reason]).toEqual([409, 'CLAIM_LOST', 'AUTHORISATION_LOST']);
      await release(cy, code, 'q2').expect(200);
      // 5. Giving the work back is refused too: the claim ends AUTHORISATION_LOST, never as an ordinary release.
      await restoreX();
      await claim(cx, code, 'q1').expect(200);   // q1 is back in the pool since step 1
      await loseX();
      const rel = await release(cx, code, 'q1');
      expect([rel.status, rel.body.code, rel.body.details?.reason]).toEqual([409, 'CLAIM_LOST', 'AUTHORISATION_LOST']);
      expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t1 }, select: { status: true, holderId: true } })).toEqual({ status: 'NOT_STARTED', holderId: null });
      expect((await p().testTaskClaim.findFirstOrThrow({ where: { taskId: t1, coachId: xId }, orderBy: { claimedAt: 'desc' } })).endReason).toBe('AUTHORISATION_LOST');
    } finally {
      await restoreX();
    }
  });

  it('account suspended, programme membership ended, role changed: the coach\'s question work ends in the same transaction', async () => {
    const id = await readyTest('Authorisation ends with the account');
    const code = await codeOf(id, stJ2);
    const [q1, q2] = await qids(id);
    // Suspension (the status endpoint; bulk operations use the same service).
    await claim(cz, code, 'q2').expect(200);
    const t2 = await taskId(id, stJ2, 2);
    try {
      await http().post(`/api/v1/admin/users/${zId}/status-changes`).set(bearer(admin)).send({ toStatus: 'SUSPENDED', reason: 'Investigation' }).expect(200);
      expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t2 }, select: { status: true, holderId: true } })).toEqual({ status: 'NOT_STARTED', holderId: null });
      expect((await p().testTaskClaim.findFirstOrThrow({ where: { taskId: t2, coachId: zId } })).endReason).toBe('AUTHORISATION_LOST');
    } finally {
      await http().post(`/api/v1/admin/users/${zId}/status-changes`).set(bearer(admin)).send({ toStatus: 'ACTIVE', reason: 'Cleared' }).expect(200);
      cz = await login(ctx, 'qm.z');
    }
    // A coach marking through programme membership only: ending the membership ends the subject's question work.
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const vId = (await p().user.create({ data: { username: 'qm.v', firstName: 'V', lastName: 'Test', email: 'qm.v@test.local', role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } })).id;
    await p().programmeMembership.create({ data: { userId: vId, disciplineId: maths, source: 'MANUAL' } });
    await setMarkers(id, q1, [vId]).expect(200);
    const cv = await login(ctx, 'qm.v');
    await claim(cv, code, 'q1').expect(200);
    const del = await http().delete(`/api/v1/admin/programmes/${maths}/members/${vId}`).set(bearer(admin));
    expect([200, 204]).toContain(del.status);
    const t1 = await taskId(id, stJ2, 1);
    expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t1 }, select: { status: true, holderId: true } })).toEqual({ status: 'NOT_STARTED', holderId: null });
    expect(await p().testQuestionMarker.count({ where: { questionId: q1, coachId: vId, endedAt: null } })).toBe(0);
    // A role change (Coach → Head Coach): no longer a coach, so the same.
    await p().programmeMembership.updateMany({ where: { userId: vId, disciplineId: maths }, data: { isActive: true, endedAt: null } });
    await setMarkers(id, q2, [vId]).expect(200);
    const cv2 = await login(ctx, 'qm.v');
    await claim(cv2, code, 'q2').expect(200);
    const role = await http().patch(`/api/v1/admin/users/${vId}`).set(bearer(admin)).send({ role: 'HEAD_COACH' });
    expect([role.status, role.body?.code ?? null]).toEqual([200, null]);
    expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: t2 }, select: { status: true, holderId: true } })).toEqual({ status: 'NOT_STARTED', holderId: null });
    expect((await p().testTaskClaim.findFirstOrThrow({ where: { taskId: t2, coachId: vId } })).endReason).toBe('AUTHORISATION_LOST');
  });

  it('Super Administrator sets the questions of a test that already has papers (owner 2026-11-27), then it is marked by question', async () => {
    // A published PAPER test created without questions (marked as one total), the way Computing and Physics were set up.
    const res = await http().post(T).set(bearer(admin)).send({
      title: 'No questions yet', subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 20,
    }).expect(201);
    const id = res.body.id as string;
    await http().put(`${T}/${id}/files/paper`).set(bearer(admin)).attach('file', PDF, 'paper.pdf').expect(200);
    await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200);
    await submit(sj, id, true);
    await submit(sj2, id);
    const papersBefore = await p().testSubmission.findMany({ where: { testId: id }, orderBy: { id: 'asc' }, select: { id: true, status: true, currentVersionId: true, versionCount: true } });
    const pagesBefore = await p().testAnswerPage.count({ where: { version: { submission: { testId: id } } } });
    const body = { questions: [{ prompt: 'Question 1', maxMarks: 8 }, { prompt: 'Question 2', maxMarks: 12 }], reason: 'The test was created without its questions' };

    // Refused: an Administrator once papers exist; a Super Administrator without a reason, or with marks that do not add up.
    expect(await status(http().put(`${T}/${id}/questions`).set(bearer(admin)).send(body))).toEqual([403, 'SUPER_ADMIN_REQUIRED']);
    expect(await status(http().put(`${T}/${id}/questions`).set(bearer(superAdmin)).send({ questions: body.questions }))).toEqual([400, 'REASON_REQUIRED']);
    expect(await status(http().put(`${T}/${id}/questions`).set(bearer(superAdmin)).send({ ...body, questions: [{ prompt: 'Only one', maxMarks: 8 }] }))).toEqual([409, 'QUESTION_MARKS_MISMATCH']);
    expect(await p().testQuestion.count({ where: { testId: id } })).toBe(0);

    // Allowed: the Super Administrator, with a reason, before any marking. The papers are untouched.
    const ok = await http().put(`${T}/${id}/questions`).set(bearer(superAdmin)).send(body).expect(200);
    expect(ok.body.questions.map((q: { order: number; maxMarks: number }) => [q.order, q.maxMarks])).toEqual([[1, 8], [2, 12]]);
    expect(await p().testSubmission.findMany({ where: { testId: id }, orderBy: { id: 'asc' }, select: { id: true, status: true, currentVersionId: true, versionCount: true } })).toEqual(papersBefore);
    expect(await p().testAnswerPage.count({ where: { version: { submission: { testId: id } } } })).toBe(pagesBefore);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'TEST_QUESTIONS_SET', entityId: id } });
    expect(audit.metadata).toMatchObject({ afterSubmissions: true, reason: body.reason, before: [], after: [{ order: 1, maxMarks: 8 }, { order: 2, maxMarks: 12 }] });

    // Now it can be marked question by question: mode, markers, tasks for every paper.
    await http().patch(`${QM(id)}/mode`).set(bearer(hm)).send({ mode: 'QUESTION' }).expect(200);
    const [q1, q2] = await qids(id);
    await setMarkers(id, q1, [xId]).expect(200);
    await setMarkers(id, q2, [yId]).expect(200);
    await closeNow(id);
    const g = await http().post(`${QM(id)}/tasks/generate`).set(bearer(hm)).send({}).expect(200);
    expect(g.body).toMatchObject({ created: 4, papers: 2, questions: 2 });

    // Once marking has started, the questions are frozen, even for a Super Administrator.
    expect(await status(http().put(`${T}/${id}/questions`).set(bearer(superAdmin)).send({ ...body, questions: [{ prompt: 'All', maxMarks: 20 }] }))).toEqual([409, 'MARKING_STARTED']);
    expect(await p().testQuestion.count({ where: { testId: id } })).toBe(2);
  });

  it('before any submission an Administrator sets the questions at once, no reason needed', async () => {
    const res = await http().post(T).set(bearer(admin)).send({
      title: 'Draft questions', subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(60), closesAt: minutes(120), maxMarks: 10,
      questions: [{ prompt: 'Old', maxMarks: 10 }],
    }).expect(201);
    const r = await http().put(`${T}/${res.body.id}/questions`).set(bearer(admin)).send({ questions: [{ prompt: 'A', maxMarks: 4 }, { prompt: 'B', maxMarks: 6 }] }).expect(200);
    expect(r.body.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['A', 'B']);
    expect(await status(http().put(`${T}/${res.body.id}/questions`).set(bearer(admin)).send({ questions: [{ prompt: 'Too many', maxMarks: 11 }] }))).toEqual([400, 'QUESTION_MARKS_EXCEED_TOTAL']);
  });

  it('resubmission: an open authorisation stops claims; the replacement moves the tasks; refused once any task was claimed', async () => {
    const id = await readyTest('Resubmission');
    const sub = await paperOf(id, stJ2);
    await http().post(`${T}/${id}/submissions/${sub.id}/resubmission`).set(bearer(admin)).send({ reason: 'Wrong file uploaded' }).expect(200);
    expect(await status(claim(cx, sub.publicCode, 'q1'))).toEqual([409, 'RESUBMISSION_PENDING']);
    await p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour' WHERE "id" = ${id}`;
    await submit(sj2, id);
    const newer = await paperOf(id, stJ2);
    expect(await p().testQuestionTask.count({ where: { submissionId: sub.id, versionId: newer.currentVersionId! } })).toBe(3);
    await closeNow(id);
    await claim(cx, sub.publicCode, 'q1').expect(200);
    expect(await status(http().post(`${T}/${id}/submissions/${sub.id}/resubmission`).set(bearer(admin)).send({ reason: 'Again' }))).toEqual([409, 'SUBMISSION_IN_MARKING']);
    await release(cx, sub.publicCode, 'q1').expect(200);
    expect(await status(http().post(`${T}/${id}/submissions/${sub.id}/resubmission`).set(bearer(admin)).send({ reason: 'Again' }))).toEqual([409, 'SUBMISSION_IN_MARKING']);
  });

  it('freezes: structure (database) after submissions; wording (QUESTION mode) and guide after tasks — a Super Admin corrects with a reason, history kept', async () => {
    const id = await readyTest('Freeze');
    const [q1] = await qids(id);
    await expect(p().testQuestion.update({ where: { id: q1 }, data: { maxMarks: 6 } })).rejects.toThrow(/frozen/);
    await expect(p().testQuestion.update({ where: { id: q1 }, data: { prompt: 'Changed' } })).rejects.toThrow(/wording is frozen/);
    expect(await status(http().post(`${QM(id)}/questions/${q1}/wording-correction`).set(bearer(admin)).send({ prompt: 'Fixed', reason: 'Typo in question' }))).toEqual([403, 'SUPER_ADMIN_ONLY']);
    await http().post(`${QM(id)}/questions/${q1}/wording-correction`).set(bearer(superAdmin)).send({ prompt: 'Question 1 (corrected)', reason: 'Typo in question' }).expect(200);
    expect(await p().testQuestion.findUniqueOrThrow({ where: { id: q1 }, select: { prompt: true, promptVersion: true } })).toEqual({ prompt: 'Question 1 (corrected)', promptVersion: 2 });
    expect(await p().testQuestionPromptHistory.findFirstOrThrow({ where: { questionId: q1 }, select: { version: true, prompt: true } })).toEqual({ version: 1, prompt: 'Question 1' });
    expect(await status(http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'g2.pdf'))).toEqual([409, 'GUIDE_FROZEN']);
    await http().put(`${T}/${id}/files/marking-guide?correctionReason=Wrong%20answer%20key`).set(bearer(superAdmin)).attach('file', PDF, 'g2.pdf').expect(200);
    expect(await status(http().post(`${QM(id)}/structure-correction`).set(bearer(superAdmin)).send({ questions: [], reason: 'too late' }))).toEqual([409, 'STRUCTURE_FROZEN']);
    // Before any task: a Super Admin structure correction (maxima must add up).
    const other = await questionTest('Structure fix');
    await submit(sj, other);
    const qs = await qids(other);
    expect(await status(http().post(`${QM(other)}/structure-correction`).set(bearer(superAdmin)).send({ questions: qs.map((qid, i) => ({ id: qid, order: i + 1, maxMarks: 1 })), reason: 'Wrong marks' }))).toEqual([400, 'MARKS_DO_NOT_ADD_UP']);
    await http().post(`${QM(other)}/structure-correction`).set(bearer(superAdmin)).send({ maxMarks: 20, questions: [{ id: qs[0], order: 2, maxMarks: 10 }, { id: qs[1], order: 1, maxMarks: 5 }, { id: qs[2], order: 3, maxMarks: 5 }], reason: 'Order and marks fixed' }).expect(200);
    expect((await p().testQuestion.findUniqueOrThrow({ where: { id: qs[0] } })).order).toBe(2);
  });

  it('access log: repeated opens and page views make one row each with a count; staff views one row per day; history and progress', async () => {
    const id = await readyTest('Access');
    const code = await codeOf(id, stJ);
    await claim(cy, code, 'q1').expect(200);
    for (let i = 0; i < 10; i++) await http().get(`${MT}/${code}/q1`).set(bearer(cy)).expect(200);
    for (let i = 0; i < 3; i++) await http().get(`${MT}/${code}/q1/pages/1`).set(bearer(cy)).expect(200);
    await http().get(`${MT}/${code}/q1/marking-guide`).set(bearer(cy)).expect(200);
    await http().get(`${MT}/${code}/q1/paper`).set(bearer(cy)).expect(404);   // no question paper uploaded for this test
    const rows = await p().testPaperAccess.findMany({ where: { claim: { coachId: yId, task: { id: await taskId(id, stJ, 1) } } }, orderBy: { kind: 'asc' }, select: { kind: true, page: true, count: true } });
    expect(rows).toEqual([{ kind: 'PAPER_OPENED', page: 0, count: 11 }, { kind: 'PAGE_VIEWED', page: 1, count: 3 }, { kind: 'GUIDE_VIEWED', page: 0, count: 1 }]);
    await expect(p().testPaperAccess.deleteMany({})).rejects.toThrow();
    const sub = await paperOf(id, stJ);
    for (let i = 0; i < 2; i++) await http().get(`${QM(id)}/papers/${sub.id}/pages/1`).set(bearer(hm)).expect(200);
    expect(await p().testStaffPaperAccess.findMany({ where: { submissionId: sub.id, kind: 'PAGE_VIEWED' }, select: { count: true } })).toEqual([{ count: 2 }]);
    const hb = await http().post(`${MT}/${code}/q1/heartbeat`).set(bearer(cy)).send({}).expect(200);
    expect(hb.body.heartbeatSeconds).toBe(120);
    const prog = await http().get(`${QM(id)}/progress`).set(bearer(hm)).expect(200);
    expect(prog.body).toMatchObject({ papers: { total: 3 }, tasks: { total: 9 } });
    const hist = await http().get(`${QM(id)}/history`).set(bearer(hm)).expect(200);
    expect(hist.body.data.length).toBeGreaterThan(0);
    const list = await http().get(`${QM(id)}/tasks`).query({ question: 1 }).set(bearer(hm)).expect(200);
    expect(list.body.meta.total).toBe(3);
    const hold = await http().post(`${QM(id)}/tasks/${await taskId(id, stJ2, 2)}/review-hold`).set(bearer(hm)).send({});
    expect([hold.status, hold.body.code]).toEqual([409, 'TASK_CHANGED']);   // not submitted yet
    await http().post(`${QM(id)}/tasks/${await taskId(id, stJ, 1)}/release`).set(bearer(hm)).send({ reason: 'Coach unavailable' }).expect(200);
    const after = await http().get(`${MT}/${code}/q1`).set(bearer(cy));
    expect([after.status, after.body.code, after.body.details?.reason]).toEqual([409, 'CLAIM_LOST', 'RELEASED_BY_STAFF']);
    const m = await http().get(`${QM(id)}/markers`).set(bearer(hm)).expect(200);
    expect(m.body.questions.map((q: any) => q.coaches.length)).toEqual([2, 3, 2]);
    // Removing a marker ends their open claims on that question (reason required).
    await claim(cx, code, 'q3').expect(200);
    const [, , q3] = await qids(id);
    expect(await status(setMarkers(id, q3, [], [xId]))).toEqual([400, 'REASON_REQUIRED']);
    await setMarkers(id, q3, [], [xId], 'No longer on Q3').expect(200);
    expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: await taskId(id, stJ, 3) } })).status).toBe('NOT_STARTED');
  });

  it('concurrency on real PostgreSQL: 20 coaches race for one task — exactly one wins; 20 coaches on 20 questions of one paper — all win (measured)', async () => {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const coaches: Array<{ id: string; token: string }> = [];
    for (let i = 0; i < 20; i++) {
      const id = (await p().user.create({ data: { username: `qm.race.${i}`, firstName: 'Race', lastName: `${i}`, email: `qm.race.${i}@test.local`, role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } })).id;
      await p().markerAuthorization.create({ data: { coachId: id, disciplineId: maths, grantedById: ctx.ids.admin } });
      coaches.push({ id, token: await login(ctx, `qm.race.${i}`) });
    }
    const id = await questionTest('Race', Array.from({ length: 20 }, () => 1));
    const qs = await qids(id);
    for (const q of qs) await setMarkers(id, q, coaches.map((c) => c.id)).expect(200);
    await submit(sj, id);
    await closeNow(id);
    await http().post(`${QM(id)}/tasks/generate`).set(bearer(hm)).send({}).expect(200);
    const code = await codeOf(id, stJ);
    for (let run = 0; run < 5; run++) {
      const results = await Promise.all(coaches.map((c) => claim(c.token, code, 'q1')));
      const ok = results.filter((r) => r.status === 200);
      expect(ok.length).toBe(1);
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.code === 'TASK_TAKEN')).toBe(true);
      const t = await taskId(id, stJ, 1);
      expect(await p().testTaskClaim.count({ where: { taskId: t, endedAt: null } })).toBe(1);
      expect(await p().testQuestionAssessment.count({ where: { taskId: t, status: { in: ['DRAFT', 'RETURNED'] } } })).toBe(1);
      const winner = coaches[results.indexOf(ok[0])];
      await release(winner.token, code, 'q1').expect(200);
    }
    // 20 coaches, 20 different questions of the same paper, all at once.
    const before = await p().$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`;
    const started = Date.now();
    const timings: number[] = [];
    const all = await Promise.all(coaches.map(async (c, i) => { const s = Date.now(); const r = await claim(c.token, code, `q${i + 1}`); timings.push(Date.now() - s); return r; }));
    const total = Date.now() - started;
    const after = await p().$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`;
    const holders = await p().testQuestionTask.findMany({ where: { submission: { testId: id, studentId: stJ } }, select: { holderId: true } });
    const report = {
      successfulClaims: all.filter((r) => r.status === 200).length,
      activeClaims: await p().testTaskClaim.count({ where: { task: { submission: { testId: id } }, endedAt: null } }),
      openAssessments: await p().testQuestionAssessment.count({ where: { task: { submission: { testId: id } }, status: { in: ['DRAFT', 'RETURNED'] } } }),
      duplicateHolders: holders.length - new Set(holders.map((h) => h.holderId)).size,
      maxClaimMs: Math.max(...timings), medianClaimMs: timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)], totalMs: total,
      deadlocks: Number(after[0].d - before[0].d),
    };
    console.log('QM_CONCURRENCY_REPORT', JSON.stringify(report)); qmReport('api-race', report);
    expect(report).toMatchObject({ successfulClaims: 20, activeClaims: 20, openAssessments: 20, duplicateHolders: 0, deadlocks: 0 });
  });
});
