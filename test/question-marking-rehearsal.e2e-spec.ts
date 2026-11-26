/**
 * Question-marking release REHEARSAL driver (design Rev 5.2 §10 "run a synthetic QUESTION-mode test end to end; roll back
 * levels 1 to 3"). OPT-IN: skipped unless QM_REHEARSAL_PHASE is set — it is run by the rehearsal script against a
 * disposable rehearsal database that already holds the previous release's data, and it NEVER resets the database
 * (unlike every other e2e file). Phases:
 *   exam      a synthetic QUESTION exam in progress (no paper fully approved, so no COMPOSED marking yet): tasks, claims,
 *             drafts, submissions, a return, a staff release, an open hold; plus a PAPER test marked and approved on the
 *             same schema (PAPER mode unchanged).
 *   flag-off  rollback level 1 (QUESTION_MARKING_ENABLED=false): question routes 404 FEATURE_DISABLED; PAPER marking works;
 *             the question data is untouched.
 *   finish    every question of one paper approved → a COMPOSED final marking; results published (paper and question
 *             tests); PAPER still works.
 * Each phase writes what it did to QM_REHEARSAL_OUT (JSON lines) for the rehearsal report.
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app/app.module.js';
import { configureApp } from '../src/main.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PASSWORD, PDF, bearer } from './helpers.js';

const PHASE = process.env.QM_REHEARSAL_PHASE ?? '';
const OUT = process.env.QM_REHEARSAL_OUT ?? '';
const record = (step: string, data: unknown) => { if (OUT) appendFileSync(OUT, `${JSON.stringify({ phase: PHASE, step, data })}\n`); };
const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe.skipIf(!PHASE)(`question-marking rehearsal driver (${PHASE || 'off'})`, () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());
  const T = '/api/v1/admin/tests';
  const MT = '/api/v1/marking/tasks';
  const QM = (id: string) => `${T}/${id}/question-marking`;
  const tok = new Map<string, string>();
  const login = async (username: string) => {
    if (!tok.has(username)) {
      const r = await http().post('/api/v1/auth/login').send({ username, password: PASSWORD });
      expect([username, r.status]).toEqual([username, 200]);
      tok.set(username, r.body.access_token);
    }
    return tok.get(username)!;
  };
  const userId = async (username: string) => (await prisma.user.findUniqueOrThrow({ where: { username } })).id;
  const maths = async () => (await prisma.discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
  const counts = async () => {
    const [row] = await prisma.$queryRaw<Array<Record<string, bigint>>>`
      SELECT (SELECT count(*) FROM "TestQuestionTask") AS tasks, (SELECT count(*) FROM "TestTaskClaim") AS claims,
             (SELECT count(*) FROM "TestQuestionAssessment") AS assessments, (SELECT count(*) FROM "TestQuestionDecision") AS decisions,
             (SELECT count(*) FROM "TestTaskEvent") AS events, (SELECT count(*) FROM "TestMarking" WHERE "kind" = 'COMPOSED') AS composed,
             (SELECT count(*) FROM "TestMarking") AS markings, (SELECT count(*) FROM "Test" WHERE "markingMode" = 'QUESTION') AS question_tests`;
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  };

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    process.env.QUESTION_MARKING_ENABLED = PHASE === 'flag-off' ? 'false' : 'true';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  }, 120_000);
  afterAll(async () => { await app?.close(); });

  /** The rehearsal's people (created once; the previous release's data came from its own e2e run). */
  const people = async () => {
    const hash = (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).passwordHash;
    const subject = await maths();
    const mk = async (username: string, role: 'HEAD_COACH' | 'MENTOR') => {
      const found = await prisma.user.findUnique({ where: { username } });
      if (found) return found.id;
      const id = (await prisma.user.create({ data: { username, firstName: username.replace(/\W/g, ' '), lastName: 'Rehearsal', email: `${username}@rehearsal.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
      // Banking information (2026-11-25): coaches and Head Coaches are held at the banking step without it.
      await prisma.$executeRaw`INSERT INTO "UserBankDetails" ("userId", "personalAccountName", "personalBankName", "personalAccountNumber", "updatedAt")
        VALUES (${id}, 'Rehearsal Account', 'Umwalimu SACCO', '100000000001', now()) ON CONFLICT ("userId") DO NOTHING`;
      return id;
    };
    const head = await mk('reh.head', 'HEAD_COACH');
    await prisma.programmeMembership.upsert({ where: { userId_disciplineId: { userId: head, disciplineId: subject } }, create: { userId: head, disciplineId: subject, source: 'MANUAL' }, update: { isActive: true, endedAt: null } });
    const coaches = [await mk('reh.x', 'MENTOR'), await mk('reh.y', 'MENTOR'), await mk('reh.z', 'MENTOR')];
    const admin = await login('admin');
    for (const coachId of coaches) {
      const r = await http().post('/api/v1/admin/test-markers').set(bearer(admin)).send({ coachId, subjectId: subject });
      expect([201, 409]).toContain(r.status);
    }
    return { subject, head, coaches };
  };

  const newTest = async (title: string, subject: string, mode: 'PAPER' | 'QUESTION') => {
    const admin = await login('admin');
    const res = await http().post(T).set(bearer(admin)).send({
      title, subjectId: subject, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 20,
      questions: [{ prompt: 'Question one', maxMarks: 5 }, { prompt: 'Question two', maxMarks: 10 }, { prompt: 'Question three', maxMarks: 5 }],
    });
    expect(res.status).toBe(201);
    const id = res.body.id as string;
    expect((await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'guide.pdf')).status).toBe(200);
    expect((await http().post(`${T}/${id}/publish`).set(bearer(admin))).status).toBe(200);
    if (mode === 'QUESTION') expect((await http().patch(`${QM(id)}/mode`).set(bearer(await login('reh.head'))).send({ mode: 'QUESTION' })).status).toBe(200);
    // The previous release's seeded students (its e2e run) answer every rehearsal test.
    for (const s of ['student.j', 'student.j2', 'student.s']) {
      const r = await http().post(`/api/v1/me/tests/${id}/submission`).set(bearer(await login(s))).send({ clientKey: randomUUID(), typedAnswer: `Answers of ${s}` });
      expect([s, r.status]).toEqual([s, 201]);
    }
    await prisma.$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
    return id;
  };

  /** A PAPER test marked end to end on the new schema: distribute, mark, submit, approve (PAPER mode unchanged). */
  const paperRound = async (title: string, subject: string) => {
    const id = await newTest(title, subject, 'PAPER');
    const head = await login('reh.head');
    const x = await userId('reh.x');
    expect((await http().post(`${T}/${id}/marking/distribute`).set(bearer(head)).send({ coachIds: [x] })).status).toBe(200);
    const cx = await login('reh.x');
    const queue = await http().get('/api/v1/marking/queue').query({ testId: id }).set(bearer(cx));
    expect(queue.status).toBe(200);
    for (const row of queue.body.data) {
      const detail = await http().get(`/api/v1/marking/submissions/${row.code}`).set(bearer(cx));
      const scores = detail.body.test.questions.map((q: { id: string; maxMarks: number }) => ({ questionId: q.id, marks: Math.min(3, q.maxMarks) }));
      expect((await http().post(`/api/v1/marking/submissions/${row.code}/marking/submit`).set(bearer(cx)).send({ scores })).status).toBe(200);
    }
    const subs = await prisma.testSubmission.findMany({ where: { testId: id }, select: { id: true } });
    for (const s of subs) expect((await http().post(`${T}/${id}/marking/submissions/${s.id}/approve`).set(bearer(head)).send({})).status).toBe(200);
    const statuses = await prisma.testSubmission.groupBy({ by: ['status'], where: { testId: id }, _count: true });
    return { id, statuses: statuses.map((s) => [s.status, s._count]) };
  };

  it('runs the phase', async () => {
    if (PHASE === 'exam') {
      const p = await people();
      const qTest = await newTest('Rehearsal question exam', p.subject, 'QUESTION');
      const head = await login('reh.head');
      const qs = await prisma.testQuestion.findMany({ where: { testId: qTest }, orderBy: { order: 'asc' } });
      const [x, y, z] = p.coaches;
      const add = async (q: string, coaches: string[]) => expect((await http().put(`${QM(qTest)}/questions/${q}/markers`).set(bearer(head)).send({ add: coaches })).status).toBe(200);
      await add(qs[0].id, [x, y]); await add(qs[1].id, [x, y, z]); await add(qs[2].id, [x, z]);
      const g = await http().post(`${QM(qTest)}/tasks/generate`).set(bearer(head)).send({});
      expect(g.body).toMatchObject({ created: 9, papers: 3, questions: 3 });
      const codes = (await prisma.testSubmission.findMany({ where: { testId: qTest }, orderBy: { publicCode: 'asc' }, select: { publicCode: true } })).map((s) => s.publicCode);
      const [cx, cy, cz] = [await login('reh.x'), await login('reh.y'), await login('reh.z')];
      const claim = async (t: string, code: string, ref: string) => { const r = await http().post(`${MT}/${code}/${ref}/claim`).set(bearer(t)).send({}); expect([code, ref, r.status]).toEqual([code, ref, 200]); return r.body; };
      const submit = async (t: string, code: string, ref: string, marks: number) => expect((await http().post(`${MT}/${code}/${ref}/submit`).set(bearer(t)).send({ marks, comment: 'Rehearsal' })).status).toBe(200);
      // Three coaches on one paper at once (different questions), then the rest.
      await Promise.all([claim(cx, codes[0], 'q1'), claim(cy, codes[0], 'q2'), claim(cz, codes[0], 'q3')]);
      await submit(cx, codes[0], 'q1', 4); await submit(cy, codes[0], 'q2', 8); await submit(cz, codes[0], 'q3', 5);
      await claim(cx, codes[1], 'q1'); await submit(cx, codes[1], 'q1', 3);
      await claim(cy, codes[1], 'q2'); await submit(cy, codes[1], 'q2', 6);
      await claim(cz, codes[1], 'q3');
      expect((await http().put(`${MT}/${codes[1]}/q3/marks`).set(bearer(cz)).send({ marks: 2, comment: 'draft' })).status).toBe(200);   // open hold with a draft
      await claim(cy, codes[2], 'q1');
      expect((await http().put(`${MT}/${codes[2]}/q1/marks`).set(bearer(cy)).send({ marks: 1 })).status).toBe(200);
      expect((await http().post(`${MT}/${codes[2]}/q1/release`).set(bearer(cy)).send({})).status).toBe(200);              // given back
      await claim(cx, codes[2], 'q2');
      const t22 = await prisma.testQuestionTask.findFirstOrThrow({ where: { submission: { publicCode: codes[2] }, question: { order: 2 }, round: 'FIRST' } });
      expect((await http().post(`${QM(qTest)}/tasks/${t22.id}/release`).set(bearer(head)).send({ reason: 'Rehearsal: released by staff' })).status).toBe(200);
      // Review: paper 0 q1 approved, q2 returned (reason) — paper 0 is not fully approved, so no COMPOSED marking yet.
      const task = async (code: string, order: number) => (await prisma.testQuestionTask.findFirstOrThrow({ where: { submission: { publicCode: code }, question: { order }, round: 'FIRST' } })).id;
      expect((await http().post(`${QM(qTest)}/tasks/${await task(codes[0], 1)}/approve`).set(bearer(head)).send({})).status).toBe(200);
      expect((await http().post(`${QM(qTest)}/tasks/${await task(codes[0], 2)}/return`).set(bearer(head)).send({ reason: 'Rehearsal: check the second part' })).status).toBe(200);
      const paper = await paperRound('Rehearsal paper test', p.subject);
      const progress = (await http().get(`${QM(qTest)}/progress`).set(bearer(head))).body;
      record('exam', { questionTest: qTest, codes, counts: await counts(), progress: { papers: progress.papers, tasks: progress.tasks }, paperTest: paper });
      expect((await counts()).composed).toBe(0);
    } else if (PHASE === 'flag-off') {
      const before = await counts();
      const head = await login('reh.head');
      const cx = await login('reh.x');
      const qTest = (await prisma.test.findFirstOrThrow({ where: { title: 'Rehearsal question exam' } })).id;
      const coach = await http().get(MT).set(bearer(cx));
      const staff = await http().get(QM(qTest)).set(bearer(head));
      expect([coach.status, coach.body.code, staff.status, staff.body.code]).toEqual([404, 'FEATURE_DISABLED', 404, 'FEATURE_DISABLED']);
      const paper = await paperRound('Rehearsal paper test (flag off)', await maths());
      const overview = await http().get(`${T}/${paper.id}/marking`).set(bearer(head));
      expect(overview.status).toBe(200);
      const after = await counts();
      expect({ ...after, markings: 0 }).toEqual({ ...before, markings: 0 });   // question data untouched (only PAPER markings were added)
      record('flag-off', { coachQueue: [coach.status, coach.body.code], staffOverview: [staff.status, staff.body.code], paperTest: paper, counts: after });
    } else if (PHASE === 'finish') {
      const head = await login('reh.head');
      const qTest = (await prisma.test.findFirstOrThrow({ where: { title: 'Rehearsal question exam' } })).id;
      const codes = (await prisma.testSubmission.findMany({ where: { testId: qTest }, orderBy: { publicCode: 'asc' }, select: { publicCode: true } })).map((s) => s.publicCode);
      const cy = await login('reh.y');
      // The returned q2 of paper 0 goes back to its coach (Y), who corrects and resubmits; then q2 and q3 are approved.
      expect((await http().post(`${MT}/${codes[0]}/q2/claim`).set(bearer(cy)).send({})).status).toBe(200);
      expect((await http().post(`${MT}/${codes[0]}/q2/submit`).set(bearer(cy)).send({ marks: 9, comment: 'Corrected' })).status).toBe(200);
      const task = async (code: string, order: number) => (await prisma.testQuestionTask.findFirstOrThrow({ where: { submission: { publicCode: code }, question: { order }, round: 'FIRST' } })).id;
      for (const order of [2, 3]) expect((await http().post(`${QM(qTest)}/tasks/${await task(codes[0], order)}/approve`).set(bearer(head)).send({})).status).toBe(200);
      const paper0 = await prisma.testSubmission.findFirstOrThrow({ where: { publicCode: codes[0] }, select: { status: true, finalMarking: { select: { kind: true, status: true, totalMarks: true } } } });
      expect(paper0).toMatchObject({ status: 'APPROVED', finalMarking: { kind: 'COMPOSED', status: 'APPROVED', totalMarks: 4 + 9 + 5 } });
      const publish = await http().post(`${T}/${qTest}/results/publish`).set(bearer(head)).send({});
      const paper = await paperRound('Rehearsal paper test (after composed)', await maths());
      record('finish', { paper0, publish: [publish.status, publish.body?.publishedCount ?? publish.body?.code ?? null], paperTest: paper, counts: await counts() });
      expect((await counts()).composed).toBe(1);
    }
  }, 600_000);
});
