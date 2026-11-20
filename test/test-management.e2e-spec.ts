/**
 * Test Management, Phase 1 (WS3; owner spec and plan approved 2026-11-19): tests, questions (sum rule), the paper and
 * the marking guide (private, neutral names), marker authorisations — and who may do what.
 *
 * Fixtures: Mathematics (seed) + Physics and Computing (created here, as migration 20261220000100 does in real
 * databases); Head Coach HM heads Mathematics, HP heads Physics; coach C (mentor.j, Mathematics member from the seed)
 * and coach P (Physics member); a Teacher; the seed's students.
 */
import { createTestApp, login, bearer, PDF, EXE, inDays, type TestContext } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4aa0000000049454e44ae426082', 'hex');

describe('Test Management Phase 1 (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, coach: string, teacher: string, student: string;
  let maths: string, physics: string, computing: string;
  let hmId: string, coachPId: string, teacherId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const T = '/api/v1/admin/tests';
  const M = '/api/v1/admin/test-markers';
  const body = (subjectId: string, extra: object = {}) => ({
    title: 'Round 1', subjectId, division: 'JUNIOR', answerFormat: 'BOTH', opensAt: inDays(1), closesAt: inDays(2), maxMarks: 20, ...extra,
  });
  const auditOf = (entityId: string) => p().auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' }, select: { action: true, actorId: true, actorRole: true, metadata: true } });

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics', sortOrder: 1 } })).id;
    computing = (await p().discipline.create({ data: { code: 'COMPUTING', name: 'Computing', sortOrder: 2 } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'MENTOR' | 'TEACHER', programmes: string[], extra: object = {}) => {
      const u = await p().user.create({ data: {
        username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra,
      } });
      for (const disciplineId of programmes) await p().programmeMembership.create({ data: { userId: u.id, disciplineId, source: 'MANUAL' } });
      return u.id;
    };
    hmId = await mk('hc.maths', 'HEAD_COACH', [maths]);
    await mk('hc.phys', 'HEAD_COACH', [physics]);
    coachPId = await mk('coach.p', 'MENTOR', [physics], { olympiadInterests: ['PHYSICS'] });
    teacherId = await mk('teacher.t', 'TEACHER', []);
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'hc.maths');
    hp = await login(ctx, 'hc.phys');
    coach = await login(ctx, 'mentor.j');
    teacher = await login(ctx, 'teacher.t');
    student = await login(ctx, 'student.j');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('Coaches, Teachers and Students reach no test-management route (403 PERMISSION_REQUIRED); anonymous 401', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const token of [coach, teacher, student]) {
      for (const [method, path] of [
        ['get', T], ['get', `${T}/subjects`], ['post', T], ['get', `${T}/${id}`], ['patch', `${T}/${id}`], ['delete', `${T}/${id}`],
        ['post', `${T}/${id}/publish`], ['post', `${T}/${id}/unpublish`], ['post', `${T}/${id}/questions`],
        ['put', `${T}/${id}/questions/order`], ['patch', `${T}/${id}/questions/${id}`], ['delete', `${T}/${id}/questions/${id}`],
        ['put', `${T}/${id}/files/paper`], ['get', `${T}/${id}/files/marking-guide`], ['delete', `${T}/${id}/files/paper`],
        ['get', M], ['get', `${M}/candidates`], ['post', M], ['post', `${M}/${id}/revoke`],
      ] as const) {
        expect([method, path, await status((http() as any)[method](path).set(bearer(token)).send({}))]).toEqual([method, path, [403, 'PERMISSION_REQUIRED']]);
      }
    }
    expect((await http().get(T)).status).toBe(401);
    expect(await p().test.count()).toBe(0);
  });

  it('subjects: Administrators see every subject; a Head Coach only those they head', async () => {
    const all = await http().get(`${T}/subjects`).set(bearer(admin)).expect(200);
    expect(all.body.map((s: any) => s.code)).toEqual(['MATHEMATICS', 'PHYSICS', 'COMPUTING']);
    const mine = await http().get(`${T}/subjects`).set(bearer(hm)).expect(200);
    expect(mine.body.map((s: any) => s.code)).toEqual(['MATHEMATICS']);
  });

  it('validation: division mandatory, opensAt < closesAt, whole positive marks, answer format enum, question sum', async () => {
    const { division: _omit, ...noDivision } = body(maths);
    expect(await status(http().post(T).set(bearer(admin)).send(noDivision))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(T).set(bearer(admin)).send(body(maths, { opensAt: inDays(3), closesAt: inDays(2) })))).toEqual([400, 'INVALID_TEST_WINDOW']);
    expect(await status(http().post(T).set(bearer(admin)).send(body(maths, { maxMarks: 12.5 })))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(T).set(bearer(admin)).send(body(maths, { maxMarks: 0 })))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(T).set(bearer(admin)).send(body(maths, { answerFormat: 'ORAL' })))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(T).set(bearer(admin)).send(body(maths, { questions: [{ prompt: 'Q1', maxMarks: 15 }, { prompt: 'Q2', maxMarks: 6 }] }))))
      .toEqual([400, 'QUESTION_MARKS_EXCEED_TOTAL']);
    expect(await status(http().post(T).set(bearer(admin)).send(body('7d5e8a3c-1b2f-4c3d-9e8f-0a1b2c3d4e5f')))).toEqual([400, 'SUBJECT_NOT_FOUND']);
    expect(await p().test.count()).toBe(0);
  });

  describe('Administrator: full access in every subject', () => {
    let id: string;

    it('creates a test (with questions), reads and lists it with filters', async () => {
      const res = await http().post(T).set(bearer(admin)).send(body(physics, {
        title: 'Physics heat 1', division: 'SENIOR', questions: [{ prompt: 'Kinematics', maxMarks: 8 }, { prompt: 'Optics', maxMarks: 7 }],
      })).expect(201);
      id = res.body.id;
      expect(res.body).toMatchObject({
        title: 'Physics heat 1', subject: { id: physics, code: 'PHYSICS' }, division: 'SENIOR', answerFormat: 'BOTH', maxMarks: 20,
        status: 'DRAFT', questionCount: 2, questionMarksTotal: 15, questionsComplete: false, deadlineMoved: false,
        files: { paper: null, markingGuide: null }, createdBy: { id: ctx.ids.admin },
      });
      expect(res.body.questions.map((q: any) => [q.order, q.prompt, q.maxMarks])).toEqual([[1, 'Kinematics', 8], [2, 'Optics', 7]]);
      expect(res.body.originalClosesAt).toBe(res.body.closesAt);

      await http().post(T).set(bearer(admin)).send(body(maths, { title: 'Algebra sprint' })).expect(201);
      const list = await http().get(T).set(bearer(admin)).expect(200);
      expect(list.body.meta).toMatchObject({ total: 2, page: 1 });
      expect((await http().get(`${T}?subjectId=${physics}`).set(bearer(admin)).expect(200)).body.data.map((t: any) => t.id)).toEqual([id]);
      expect((await http().get(`${T}?division=SENIOR&status=DRAFT&q=heat`).set(bearer(admin)).expect(200)).body.meta.total).toBe(1);
      expect((await http().get(`${T}?division=ALL`).set(bearer(admin)).expect(200)).body.meta.total).toBe(0);
      expect((await http().get(`${T}?limit=1&page=2`).set(bearer(admin)).expect(200)).body.data).toHaveLength(1);
      const row = list.body.data.find((t: any) => t.id === id);
      expect(row).toMatchObject({ questionCount: 2, questionMarksTotal: 15 });
      expect(row.questions).toBeUndefined();
      expect(await status(http().get(`${T}?status=OPEN`).set(bearer(admin)))).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('questions: add, edit, reorder, remove — never above the total; the sum is shown against the maximum', async () => {
      expect(await status(http().post(`${T}/${id}/questions`).set(bearer(admin)).send({ prompt: 'Too much', maxMarks: 6 }))).toEqual([400, 'QUESTION_MARKS_EXCEED_TOTAL']);
      let t = (await http().post(`${T}/${id}/questions`).set(bearer(admin)).send({ prompt: 'Waves', maxMarks: 5 }).expect(201)).body;
      expect([t.questionMarksTotal, t.questionsComplete]).toEqual([20, true]);
      const [q1, q2, q3] = t.questions.map((q: any) => q.id);
      expect(await status(http().patch(`${T}/${id}/questions/${q1}`).set(bearer(admin)).send({ maxMarks: 9 }))).toEqual([400, 'QUESTION_MARKS_EXCEED_TOTAL']);
      expect(await status(http().patch(`${T}/${id}/questions/${q1}`).set(bearer(admin)).send({ maxMarks: 1.5 }))).toEqual([400, 'VALIDATION_FAILED']);
      t = (await http().patch(`${T}/${id}/questions/${q1}`).set(bearer(admin)).send({ prompt: 'Kinematics (revised)', maxMarks: 7 }).expect(200)).body;
      expect(t.questions[0]).toMatchObject({ prompt: 'Kinematics (revised)', maxMarks: 7 });
      expect(await status(http().put(`${T}/${id}/questions/order`).set(bearer(admin)).send({ questionIds: [q3, q1] }))).toEqual([400, 'QUESTION_ORDER_MISMATCH']);
      t = (await http().put(`${T}/${id}/questions/order`).set(bearer(admin)).send({ questionIds: [q3, q1, q2] }).expect(200)).body;
      expect(t.questions.map((q: any) => [q.id, q.order])).toEqual([[q3, 1], [q1, 2], [q2, 3]]);
      t = (await http().delete(`${T}/${id}/questions/${q1}`).set(bearer(admin)).expect(200)).body;
      expect(t.questions.map((q: any) => [q.id, q.order])).toEqual([[q3, 1], [q2, 2]]);
      expect([t.questionMarksTotal, t.questionsComplete]).toEqual([12, false]);
      expect(await status(http().patch(`${T}/${id}`).set(bearer(admin)).send({ maxMarks: 11 }))).toEqual([400, 'TEST_MAX_MARKS_BELOW_QUESTIONS']);
      t = (await http().post(`${T}/${id}/questions`).set(bearer(admin)).send({ prompt: 'Thermodynamics', maxMarks: 8 }).expect(201)).body;
      expect([t.questionCount, t.questionMarksTotal, t.questionsComplete]).toEqual([3, 20, true]);
      expect(await status(http().delete(`${T}/${id}/questions/${ctx.ids.admin}`).set(bearer(admin)))).toEqual([404, 'QUESTION_NOT_FOUND']);
    });

    it('files: paper and marking guide — private, PDF or images, neutral names; replace and remove', async () => {
      expect(await status(http().put(`${T}/${id}/files/paper`).set(bearer(admin)))).toEqual([400, 'FILE_REQUIRED']);
      expect(await status(http().put(`${T}/${id}/files/paper`).set(bearer(admin)).attach('file', EXE, 'paper.pdf'))).toEqual([415, 'FILE_TYPE_NOT_ALLOWED']);
      expect(await status(http().put(`${T}/${id}/files/answers`).set(bearer(admin)).attach('file', PDF, 'x.pdf'))).toEqual([404, 'TEST_FILE_NOT_FOUND']);
      let t = (await http().put(`${T}/${id}/files/paper`).set(bearer(admin)).attach('file', PDF, 'Secret Name Physics.pdf').expect(200)).body;
      expect(t.files.paper).toMatchObject({ name: 'test-paper.pdf', mimeType: 'application/pdf' });
      expect(JSON.stringify(t)).not.toContain('Secret Name');
      t = (await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PNG, 'answers photo.png').expect(200)).body;
      expect(t.files.markingGuide).toMatchObject({ name: 'marking-guide.png', mimeType: 'image/png' });
      const firstPaper = t.files.paper.fileId;
      t = (await http().put(`${T}/${id}/files/paper`).set(bearer(admin)).attach('file', PDF, 'v2.pdf').expect(200)).body;
      expect(t.files.paper.fileId).not.toBe(firstPaper);
      expect(await p().testFile.count({ where: { testId: id } })).toBe(2);

      const dl = await http().get(`${T}/${id}/files/paper?download=1`).set(bearer(admin)).expect(200);
      expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="test-paper\.pdf"/);
      expect(dl.headers['cache-control']).toBe('private, no-store');
      const guide = await http().get(`${T}/${id}/files/marking-guide`).set(bearer(admin)).expect(200);
      expect(guide.headers['content-disposition']).toMatch(/filename="marking-guide\.png"/);
      expect(Buffer.compare(guide.body, PNG)).toBe(0);
      expect(await status(http().get(`${T}/${id}/files/marking-guide`))).toEqual([401, 'UNAUTHORIZED']);

      await http().delete(`${T}/${id}/files/marking-guide`).set(bearer(admin)).expect(200);
      expect(await status(http().get(`${T}/${id}/files/marking-guide`).set(bearer(admin)))).toEqual([404, 'TEST_FILE_NOT_FOUND']);
      expect(await status(http().delete(`${T}/${id}/files/marking-guide`).set(bearer(admin)))).toEqual([404, 'TEST_FILE_NOT_FOUND']);
      await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'guide.pdf').expect(200);
      // The replaced and removed files are orphans (cleaned nightly); the current two are kept by their links.
      const kept = await p().fileObject.count({ where: { testFiles: { some: { testId: id } } } });
      expect(kept).toBe(2);
    });

    it('publish (ready checks), deadline moves keep the original, unpublish; a published test is not deleted', async () => {
      const draft = (await http().post(T).set(bearer(admin)).send(body(computing, { title: 'Empty' })).expect(201)).body;
      expect((await http().post(`${T}/${draft.id}/publish`).set(bearer(admin)).expect(409)).body.details.problems).toEqual(['NO_PAPER_OR_QUESTIONS']);
      await http().delete(`${T}/${draft.id}`).set(bearer(admin)).expect(204);
      expect(await p().test.count({ where: { id: draft.id } })).toBe(0);

      const before = (await http().get(`${T}/${id}`).set(bearer(admin)).expect(200)).body;
      const moved = inDays(3);
      // A draft never published: the "original" deadline follows.
      let t = (await http().patch(`${T}/${id}`).set(bearer(admin)).send({ closesAt: moved }).expect(200)).body;
      expect([t.closesAt, t.originalClosesAt, t.deadlineMoved]).toEqual([moved, moved, false]);
      t = (await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200)).body;
      expect([t.status, t.originalClosesAt]).toEqual(['PUBLISHED', moved]);
      expect(await status(http().post(`${T}/${id}/publish`).set(bearer(admin)))).toEqual([409, 'TEST_ALREADY_PUBLISHED']);
      // Published: moving the deadline keeps the original.
      const later = inDays(5);
      t = (await http().patch(`${T}/${id}`).set(bearer(admin)).send({ closesAt: later }).expect(200)).body;
      expect([t.closesAt, t.originalClosesAt, t.deadlineMoved]).toEqual([later, moved, true]);
      expect(await status(http().patch(`${T}/${id}`).set(bearer(admin)).send({ opensAt: inDays(6) }))).toEqual([400, 'INVALID_TEST_WINDOW']);
      // Published: the questions must keep totalling the maximum.
      expect(await status(http().post(`${T}/${id}/questions`).set(bearer(admin)).send({ prompt: 'Extra', maxMarks: 1 }))).toEqual([400, 'QUESTION_MARKS_EXCEED_TOTAL']);
      expect(await status(http().patch(`${T}/${id}/questions/${t.questions[0].id}`).set(bearer(admin)).send({ maxMarks: 1 }))).toEqual([409, 'QUESTION_MARKS_MISMATCH']);
      expect(await status(http().patch(`${T}/${id}`).set(bearer(admin)).send({ maxMarks: 25 }))).toEqual([409, 'QUESTION_MARKS_MISMATCH']);
      expect(await status(http().patch(`${T}/${id}`).set(bearer(admin)).send({ subjectId: maths }))).toEqual([409, 'TEST_PUBLISHED']);
      expect(await status(http().delete(`${T}/${id}`).set(bearer(admin)))).toEqual([409, 'TEST_PUBLISHED']);
      expect(await status(http().patch(`${T}/${id}`).set(bearer(admin)).send({}))).toEqual([400, 'NO_CHANGES']);
      t = (await http().post(`${T}/${id}/unpublish`).set(bearer(admin)).expect(200)).body;
      expect([t.status, t.originalClosesAt]).toEqual(['DRAFT', moved]);
      expect(await status(http().post(`${T}/${id}/unpublish`).set(bearer(admin)))).toEqual([409, 'TEST_NOT_PUBLISHED']);
      expect(before.id).toBe(id);
    });

    it('every write is audited in the TESTS category, in the same transaction, with the acting administrator', async () => {
      const actions = (await auditOf(id)).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['TEST_CREATED', 'TEST_UPDATED', 'TEST_PUBLISHED', 'TEST_UNPUBLISHED', 'TEST_QUESTIONS_REORDERED']));
      const all = await p().auditLog.findMany({ where: { action: { startsWith: 'TEST_' } }, select: { action: true, actorId: true } });
      for (const a of ['TEST_QUESTION_ADDED', 'TEST_QUESTION_UPDATED', 'TEST_QUESTION_REMOVED', 'TEST_FILE_UPLOADED', 'TEST_FILE_REPLACED', 'TEST_FILE_REMOVED', 'TEST_DELETED']) {
        expect([a, all.some((x) => x.action === a && x.actorId === ctx.ids.admin)]).toEqual([a, true]);
      }
      const res = await http().get('/api/v1/admin/audit-logs?category=TESTS&limit=100').set(bearer(admin)).expect(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(all.length);
      // A refused change writes no TESTS entry (only the generic ADMIN_REQUEST trail of the request itself).
      const testEntries = () => p().auditLog.count({ where: { OR: [{ action: { startsWith: 'TEST_' } }, { action: { startsWith: 'MARKER_' } }] } });
      const n = await testEntries();
      await http().post(`${T}/${id}/questions`).set(bearer(admin)).send({ prompt: 'Over', maxMarks: 50 }).expect(400);
      expect(await testEntries()).toBe(n);
    });
  });

  describe('Head Coach: own subject yes, other subjects 403', () => {
    let mathsTest: string, physicsTest: string;

    beforeAll(async () => {
      physicsTest = (await p().test.findFirstOrThrow({ where: { disciplineId: physics } })).id;
    });

    it('creates and manages tests in the subject they head; the audit records which Head Coach acted', async () => {
      const res = await http().post(T).set(bearer(hm)).send(body(maths, { title: 'HC maths', division: 'ALL' })).expect(201);
      mathsTest = res.body.id;
      await http().patch(`${T}/${mathsTest}`).set(bearer(hm)).send({ title: 'HC maths (edited)' }).expect(200);
      await http().post(`${T}/${mathsTest}/questions`).set(bearer(hm)).send({ prompt: 'Q', maxMarks: 20 }).expect(201);
      for (const kind of ['paper', 'marking-guide']) {
        await http().put(`${T}/${mathsTest}/files/${kind}`).set(bearer(hm)).attach('file', PDF, `${kind}.pdf`).expect(200);
      }
      await http().get(`${T}/${mathsTest}/files/marking-guide`).set(bearer(hm)).expect(200);
      await http().post(`${T}/${mathsTest}/publish`).set(bearer(hm)).expect(200);
      const audit = await auditOf(mathsTest);
      expect(audit.every((a) => a.actorId === hmId && a.actorRole === 'HEAD_COACH')).toBe(true);
      expect(audit.map((a) => a.action)).toEqual(['TEST_CREATED', 'TEST_UPDATED', 'TEST_PUBLISHED']);
      // Lists only their subject's tests.
      const list = await http().get(T).set(bearer(hm)).expect(200);
      expect(new Set(list.body.data.map((t: any) => t.subject.code))).toEqual(new Set(['MATHEMATICS']));
    });

    it('another subject: 403 SCOPE_FORBIDDEN on every route, including the marking guide; nothing changes', async () => {
      expect(await status(http().post(T).set(bearer(hm)).send(body(physics)))).toEqual([403, 'SCOPE_FORBIDDEN']);
      expect(await status(http().get(`${T}?subjectId=${physics}`).set(bearer(hm)))).toEqual([403, 'SCOPE_FORBIDDEN']);
      for (const [method, path, send] of [
        ['get', `${T}/${physicsTest}`, {}], ['patch', `${T}/${physicsTest}`, { title: 'Hijack' }], ['delete', `${T}/${physicsTest}`, {}],
        ['post', `${T}/${physicsTest}/publish`, {}], ['post', `${T}/${physicsTest}/questions`, { prompt: 'Q', maxMarks: 1 }],
        ['get', `${T}/${physicsTest}/files/paper`, {}], ['get', `${T}/${physicsTest}/files/marking-guide`, {}],
        ['delete', `${T}/${physicsTest}/files/marking-guide`, {}],
      ] as const) {
        expect([method, path, await status((http() as any)[method](path).set(bearer(hm)).send(send))]).toEqual([method, path, [403, 'SCOPE_FORBIDDEN']]);
      }
      expect(await status(http().put(`${T}/${physicsTest}/files/paper`).set(bearer(hm)).attach('file', PDF, 'x.pdf'))).toEqual([403, 'SCOPE_FORBIDDEN']);
      expect(await status(http().patch(`${T}/${mathsTest}`).set(bearer(hm)).send({ subjectId: physics }))).toEqual([403, 'SCOPE_FORBIDDEN']);
      expect((await p().test.findUniqueOrThrow({ where: { id: physicsTest } })).title).toBe('Physics heat 1');
      // The Physics Head Coach can read the Physics test and its marking guide — not the Mathematics one.
      await http().get(`${T}/${physicsTest}/files/marking-guide`).set(bearer(hp)).expect(200);
      expect(await status(http().get(`${T}/${mathsTest}/files/marking-guide`).set(bearer(hp)))).toEqual([403, 'SCOPE_FORBIDDEN']);
      expect(await status(http().get(`${T}/${ctx.ids.admin}`).set(bearer(hp)))).toEqual([404, 'TEST_NOT_FOUND']);
    });

    it('a Head Coach who heads nothing sees nothing and creates nothing', async () => {
      await p().programmeMembership.updateMany({ where: { userId: hmId }, data: { isActive: false, endedAt: new Date() } });
      try {
        expect((await http().get(T).set(bearer(hm)).expect(200)).body.meta.total).toBe(0);
        expect((await http().get(`${T}/subjects`).set(bearer(hm)).expect(200)).body).toEqual([]);
        expect(await status(http().get(`${T}/${mathsTest}`).set(bearer(hm)))).toEqual([403, 'SCOPE_FORBIDDEN']);
      } finally {
        await p().programmeMembership.updateMany({ where: { userId: hmId }, data: { isActive: true, endedAt: null } });
      }
    });
  });

  describe('marker authorisations (separate from interests; reason on revoke; audited)', () => {
    let authId: string;

    it('a coach\'s interest grants nothing: no authorisation exists until one is granted', async () => {
      expect((await p().user.findUniqueOrThrow({ where: { id: coachPId } })).olympiadInterests).toEqual(['PHYSICS']);
      expect((await http().get(`${M}?subjectId=${physics}`).set(bearer(admin)).expect(200)).body.meta.total).toBe(0);
      const cands = (await http().get(`${M}/candidates?subjectId=${physics}`).set(bearer(hp)).expect(200)).body;
      expect(cands.data.map((c: any) => [c.username, c.interestedInSubject, c.authorizationId])).toEqual([['coach.p', true, null]]);
    });

    it('the subject\'s Head Coach grants (own subject\'s coaches only); duplicates and non-coaches are refused', async () => {
      const res = await http().post(M).set(bearer(hp)).send({ coachId: coachPId, subjectId: physics }).expect(201);
      authId = res.body.id;
      expect(res.body).toMatchObject({ active: true, coach: { id: coachPId, interestedInSubject: true }, subject: { code: 'PHYSICS' }, grantedBy: { username: 'hc.phys' } });
      expect(await status(http().post(M).set(bearer(admin)).send({ coachId: coachPId, subjectId: physics }))).toEqual([409, 'MARKER_ALREADY_AUTHORIZED']);
      expect(await status(http().post(M).set(bearer(hp)).send({ coachId: ctx.ids.mentorJunior, subjectId: physics }))).toEqual([403, 'SCOPE_FORBIDDEN']);
      expect(await status(http().post(M).set(bearer(hm)).send({ coachId: coachPId, subjectId: physics }))).toEqual([403, 'SCOPE_FORBIDDEN']);
      expect(await status(http().post(M).set(bearer(admin)).send({ coachId: teacherId, subjectId: physics }))).toEqual([400, 'NOT_A_COACH']);
      expect(await status(http().post(M).set(bearer(admin)).send({ coachId: hmId, subjectId: maths }))).toEqual([400, 'NOT_A_COACH']);
      // An Administrator may authorise any active coach in any subject.
      const other = await http().post(M).set(bearer(admin)).send({ coachId: ctx.ids.mentorJunior, subjectId: computing, reason: 'Strong programmer' }).expect(201);
      expect(other.body.grantReason).toBe('Strong programmer');
      expect((await http().get(`${M}/candidates?subjectId=${physics}`).set(bearer(hp)).expect(200)).body.data[0].authorizationId).toBe(authId);
      // Lists: the Head Coach sees their subject's only.
      expect((await http().get(M).set(bearer(hp)).expect(200)).body.data.map((a: any) => a.id)).toEqual([authId]);
      expect((await http().get(M).set(bearer(admin)).expect(200)).body.meta.total).toBe(2);
      expect(await status(http().get(`${M}?subjectId=${computing}`).set(bearer(hp)))).toEqual([403, 'SCOPE_FORBIDDEN']);
    });

    it('concurrent grants for the same coach and subject create one authorisation', async () => {
      await p().programmeMembership.create({ data: { userId: coachPId, disciplineId: computing, source: 'MANUAL' } });
      const results = await Promise.all([1, 2, 3].map(() => http().post(M).set(bearer(admin)).send({ coachId: coachPId, subjectId: computing })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await p().markerAuthorization.count({ where: { coachId: coachPId, disciplineId: computing, revokedAt: null } })).toBe(1);
    });

    it('revoke needs a reason; it keeps the row and is audited; a second revoke is refused; a new grant is possible', async () => {
      expect(await status(http().post(`${M}/${authId}/revoke`).set(bearer(hp)).send({}))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(`${M}/${authId}/revoke`).set(bearer(hm)).send({ reason: 'Not my subject' }))).toEqual([403, 'SCOPE_FORBIDDEN']);
      const res = await http().post(`${M}/${authId}/revoke`).set(bearer(hp)).send({ reason: 'Conflict of interest' }).expect(200);
      expect(res.body).toMatchObject({ active: false, revokeReason: 'Conflict of interest', revokedBy: { username: 'hc.phys' } });
      expect(await status(http().post(`${M}/${authId}/revoke`).set(bearer(admin)).send({ reason: 'Again' }))).toEqual([409, 'MARKER_AUTHORIZATION_REVOKED']);
      expect((await http().get(`${M}?state=revoked`).set(bearer(hp)).expect(200)).body.data.map((a: any) => a.id)).toEqual([authId]);
      expect((await http().get(M).set(bearer(hp)).expect(200)).body.meta.total).toBe(0);
      const audit = await auditOf(authId);
      expect(audit.map((a) => [a.action, a.actorRole])).toEqual([['MARKER_AUTHORIZED', 'HEAD_COACH'], ['MARKER_AUTHORIZATION_REVOKED', 'HEAD_COACH']]);
      expect(audit[1].metadata).toMatchObject({ coachId: coachPId, subjectId: physics, reason: 'Conflict of interest' });
      await http().post(M).set(bearer(hp)).send({ coachId: coachPId, subjectId: physics }).expect(201);
      expect(await p().markerAuthorization.count({ where: { coachId: coachPId, disciplineId: physics } })).toBe(2);
    });
  });

  it('existing course assignments are unaffected: their routes answer as before and no assignment row changed', async () => {
    const counts = async () => Promise.all([p().assignment.count(), p().submission.count(), p().mentorReview.count(), p().resultRelease.count(), p().course.count()]);
    const before = await counts();
    await http().get('/api/v1/assignments').set(bearer(admin)).expect(200);
    await http().get('/api/v1/me/assignments').set(bearer(student)).expect(200);
    await http().post(T).set(bearer(admin)).send(body(maths, { title: 'Isolation check' })).expect(201);
    expect(await counts()).toEqual(before);
  });
});
