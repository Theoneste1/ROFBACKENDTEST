/**
 * Administrator-managed divisions = Olympiad levels (owner, 2026-11-21/22), end to end:
 *  - divisions: Administrators create (permanent code), edit, give grades (taken from the division that had them),
 *    order, deactivate (refused while students are in it or a test is open); every grade stays with exactly one active
 *    division; never a Coach, Head Coach, teacher or student; audited;
 *  - a student's division follows the grade (the active division whose suggested grades hold it), whatever writes it;
 *  - a Coach / Head Coach (their programmes' students) or a User Manager sets it by hand (reason, history, audit); set by
 *    hand it no longer follows the grade; "automatic" returns it to the suggestion; the active enrolment moves with it;
 *  - who may: User Managers (any student), Coaches and Head Coaches (their programmes' students only; others 404); never a
 *    student, a teacher or anyone signed out; refusals and edge cases; two classifiers at once;
 *  - tests: a test for any active division (MIDDLE or a new one); eligibility, the student's list, the teacher's list,
 *    tracking and extensions use the DIVISION, never the grade; a submission keeps the division it was made in; bulk.
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe('Divisions and Olympiad levels: managed by Administrators, set by Coaches and User Managers, used by tests (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hc: string, coach: string, outsider: string, teacher: string;
  let maths: string, physics: string, school: string;
  let hash: string;
  let div: Record<string, string>;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const L = (id: string) => `/api/v1/admin/students/${id}/olympiad-level`;
  const D = (id = '') => `/api/v1/admin/divisions${id ? `/${id}` : ''}`;
  const divisionOf = async (id: string) => {
    const u = await p().user.findUniqueOrThrow({ where: { id }, select: { divisionManual: true, division: { select: { code: true } } } });
    return { code: u.division?.code ?? null, manual: u.divisionManual };
  };
  const grades = async () => Object.fromEntries((await p().division.findMany({ orderBy: { sortOrder: 'asc' } })).map((d) => [d.code, d.suggestedGrades]));

  let n = 0;
  /** A student created directly in the database (as sign-up, an import or an Administrator would): the trigger decides. */
  const student = async (grade: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6', extra: { programme?: string } = {}) => {
    n += 1;
    const u = await p().user.create({ data: {
      username: `ol.s${n}`, firstName: `Olga${n}`, lastName: 'Level', email: `ol.s${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: grade, divisionId: ctx.ids.junior, schoolId: school, homeLocation: 'Huye',
      dateOfBirth: new Date('2010-01-01'), olympiadInterests: ['MATHEMATICS'],
    } });
    await p().studentSchoolAffiliation.create({ data: { studentId: u.id, schoolId: school, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } });
    if (extra.programme) await p().programmeMembership.create({ data: { userId: u.id, disciplineId: extra.programme, source: 'MANUAL' } });
    return u.id;
  };
  const publishedTest = async (division: string) => {
    const t = await http().post('/api/v1/admin/tests').set(bearer(admin)).send({
      title: `Level ${division} ${randomUUID().slice(0, 4)}`, subjectId: maths, division, answerFormat: 'TYPED_ONLY',
      opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10, questions: [{ prompt: 'Prove it', maxMarks: 10 }],
    }).expect(201);
    await http().post(`/api/v1/admin/tests/${t.body.id}/publish`).set(bearer(admin)).expect(200);
    return t.body.id as string;
  };
  const tokenOf = async (id: string) => login(ctx, (await p().user.findUniqueOrThrow({ where: { id } })).username);

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.upsert({ where: { code: 'PHYSICS' }, create: { code: 'PHYSICS', name: 'Physics' }, update: {} })).id;   // test database only
    school = (await p().school.create({ data: {
      name: 'gs levels', code: '240001', nameKey: 'gs levels', location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST', province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
    } })).id;
    const staff = async (username: string, role: 'HEAD_COACH' | 'MENTOR' | 'TEACHER', programme?: string) => {
      const id = (await p().user.create({ data: { username, firstName: username, lastName: 'Staff', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
      if (programme) await p().programmeMembership.create({ data: { userId: id, disciplineId: programme, source: 'MANUAL' } });
      return id;
    };
    await staff('ol.hc', 'HEAD_COACH', maths);
    await staff('ol.coach', 'MENTOR', maths);
    await staff('ol.outsider', 'MENTOR', physics);
    const tId = await staff('ol.teacher', 'TEACHER');
    await p().teacherSchoolAssignment.create({ data: { teacherId: tId, schoolId: school, isActive: true, role: 'PRIMARY' } });
    [hc, coach, outsider, teacher] = await Promise.all(['ol.hc', 'ol.coach', 'ol.outsider', 'ol.teacher'].map((u) => login(ctx, u)));
    div = Object.fromEntries((await p().division.findMany()).map((d) => [d.code, d.id]));
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  describe('divisions (administrator-managed)', () => {
    it('start: Junior S1–S3, Middle (no grade), Senior S4–S6, in order; the public list says so', async () => {
      expect(await grades()).toEqual({ JUNIOR: ['S1', 'S2', 'S3'], MIDDLE: [], SENIOR: ['S4', 'S5', 'S6'] });
      const pub = (await http().get('/api/v1/divisions').expect(200)).body;
      expect(pub.map((d: any) => [d.code, d.gradeLevels, d.isActive])).toEqual([['JUNIOR', ['S1', 'S2', 'S3'], true], ['MIDDLE', [], true], ['SENIOR', ['S4', 'S5', 'S6'], true]]);
    });

    it('giving grades to Middle takes them from Junior and Senior in one step; a student whose grade changes follows; existing ones stay', async () => {
      const s3 = await student('S3');
      expect((await divisionOf(s3)).code).toBe('JUNIOR');
      const r = (await http().patch(D(div.MIDDLE)).set(bearer(admin)).send({ suggestedGrades: ['S3', 'S4'] }).expect(200)).body;
      expect(r).toMatchObject({ code: 'MIDDLE', suggestedGrades: ['S3', 'S4'] });
      expect(await grades()).toEqual({ JUNIOR: ['S1', 'S2'], MIDDLE: ['S3', 'S4'], SENIOR: ['S5', 'S6'] });
      // Existing students are not moved by the mapping…
      expect((await divisionOf(s3)).code).toBe('JUNIOR');
      // …new students and grade changes follow it (an Administrator's grade change; the history records it).
      expect((await divisionOf(await student('S4'))).code).toBe('MIDDLE');
      await http().patch(`/api/v1/admin/users/${s3}`).set(bearer(admin)).send({ gradeLevel: 'S4' }).expect(200);
      expect(await divisionOf(s3)).toEqual({ code: 'MIDDLE', manual: false });
      expect((await p().divisionChange.findMany({ where: { studentId: s3 }, orderBy: { createdAt: 'asc' }, include: { toDivision: true } })).map((h) => [h.source, h.toDivision.code, h.gradeLevel]))
        .toEqual([['GRADE', 'JUNIOR', 'S3'], ['GRADE', 'MIDDLE', 'S4']]);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_DIVISION', entityId: div.MIDDLE } })).metadata).toMatchObject({ code: 'MIDDLE' });
    });

    it('a new division: permanent code, any grades; every grade must stay with one active division; codes are unique; ALL is reserved', async () => {
      const created = (await http().post(D()).set(bearer(admin)).send({ code: 'advanced', name: 'Advanced', sortOrder: 4, suggestedGrades: ['S6'] }).expect(201)).body;
      expect(created).toMatchObject({ code: 'ADVANCED', name: 'Advanced', isActive: true, suggestedGrades: ['S6'] });
      div.ADVANCED = created.id;
      expect(await grades()).toEqual({ JUNIOR: ['S1', 'S2'], MIDDLE: ['S3', 'S4'], SENIOR: ['S5'], ADVANCED: ['S6'] });
      expect((await divisionOf(await student('S6'))).code).toBe('ADVANCED');
      expect(await status(http().post(D()).set(bearer(admin)).send({ code: 'ADVANCED', name: 'Again' }))).toEqual([409, 'DIVISION_CODE_TAKEN']);
      for (const code of ['ALL', 'x', '9LEVEL', 'with space']) expect(await status(http().post(D()).set(bearer(admin)).send({ code, name: 'Bad' }))).toEqual([400, 'VALIDATION_FAILED']);
      // Removing S5 from Senior with nobody taking it: refused, nothing changed.
      expect(await status(http().patch(D(div.SENIOR)).set(bearer(admin)).send({ suggestedGrades: [] }))).toEqual([409, 'GRADES_NOT_COVERED']);
      expect((await grades()).SENIOR).toEqual(['S5']);
      expect(await p().auditLog.count({ where: { action: 'CREATE_DIVISION', entityId: created.id } })).toBe(1);
    });

    it('deactivating: refused while students are in it, or it still holds grades; allowed once empty and its grades given away', async () => {
      expect(await status(http().patch(D(div.ADVANCED)).set(bearer(admin)).send({ isActive: false }))).toEqual([409, 'DIVISION_HAS_STUDENTS']);
      const inIt = await p().user.findMany({ where: { divisionId: div.ADVANCED }, select: { id: true } });
      for (const u of inIt) await http().put(L(u.id)).set(bearer(admin)).send({ divisionId: div.SENIOR, reason: 'Advanced closes' }).expect(200);
      expect(await status(http().patch(D(div.ADVANCED)).set(bearer(admin)).send({ isActive: false }))).toEqual([409, 'GRADES_NOT_COVERED']);
      await http().patch(D(div.SENIOR)).set(bearer(admin)).send({ suggestedGrades: ['S5', 'S6'] }).expect(200);
      const off = (await http().patch(D(div.ADVANCED)).set(bearer(admin)).send({ isActive: false }).expect(200)).body;
      expect(off).toMatchObject({ isActive: false, suggestedGrades: [] });
      // An inactive division is offered for nothing new: no test, no student.
      expect(await status(http().post('/api/v1/admin/tests').set(bearer(admin)).send({
        title: 'Closed level', subjectId: maths, division: 'ADVANCED', answerFormat: 'TYPED_ONLY', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10,
      }))).toEqual([400, 'UNKNOWN_DIVISION']);
    });

    it('only Administrators manage divisions (never a Head Coach, Coach, teacher, student, or anyone signed out)', async () => {
      const s = await tokenOf(await student('S1'));
      for (const token of [hc, coach, teacher, s]) {
        expect((await http().post(D()).set(bearer(token)).send({ code: 'NOPE', name: 'Nope' })).status).toBe(403);
        expect((await http().patch(D(div.MIDDLE)).set(bearer(token)).send({ name: 'Nope' })).status).toBe(403);
      }
      expect((await http().post(D()).send({ code: 'NOPE', name: 'Nope' })).status).toBe(401);
      expect(await p().division.count({ where: { code: 'NOPE' } })).toBe(0);
    });
  });

  describe('a student\'s division, set by hand', () => {
    it('set by hand (reason, history, audit, the active enrolment too): it stays when the grade changes; automatic follows the grade again', async () => {
      const id = await student('S5');
      const set = (await http().put(L(id)).set(bearer(admin)).send({ divisionId: div.MIDDLE, reason: '  Joined the Middle squad  ' }).expect(200)).body;
      expect(set).toMatchObject({ level: { code: 'MIDDLE' }, manual: true, suggestedLevel: { code: 'SENIOR' } });
      expect(set.choices.map((c: any) => c.code)).toEqual(['JUNIOR', 'MIDDLE', 'SENIOR']);   // active divisions only
      expect(set.history[0]).toMatchObject({ source: 'MANUAL', fromDivision: { code: 'SENIOR' }, toDivision: { code: 'MIDDLE' }, gradeLevel: 'S5', reason: 'Joined the Middle squad', changedBy: { id: ctx.ids.admin } });
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'OLYMPIAD_LEVEL_CHANGED', entityId: id } })).metadata)
        .toMatchObject({ from: 'SENIOR', to: 'MIDDLE', manual: true, gradeLevel: 'S5', reason: 'Joined the Middle squad' });
      // Set by hand: a grade change (an Administrator's edit) never moves it, and writes no history.
      await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ gradeLevel: 'S1' }).expect(200);
      expect(await divisionOf(id)).toEqual({ code: 'MIDDLE', manual: true });
      expect(await p().divisionChange.count({ where: { studentId: id } })).toBe(2);
      // The same again: nothing to do, nothing written.
      await http().put(L(id)).set(bearer(admin)).send({ divisionId: div.MIDDLE, reason: 'Again' }).expect(200);
      expect(await p().auditLog.count({ where: { action: 'OLYMPIAD_LEVEL_CHANGED', entityId: id } })).toBe(1);
      // Automatic: the grade's division (S1 → Junior), and the grade leads again.
      const auto = (await http().put(L(id)).set(bearer(admin)).send({ automatic: true, reason: 'Back to the grade' }).expect(200)).body;
      expect(auto).toMatchObject({ level: { code: 'JUNIOR' }, manual: false });
      expect(auto.history[0]).toMatchObject({ source: 'AUTOMATIC', fromDivision: { code: 'MIDDLE' }, toDivision: { code: 'JUNIOR' }, reason: 'Back to the grade' });
      await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ gradeLevel: 'S6' }).expect(200);
      expect(await divisionOf(id)).toEqual({ code: 'SENIOR', manual: false });
      // Every transition between the divisions is allowed by hand.
      for (const [a, b] of [['SENIOR', 'JUNIOR'], ['JUNIOR', 'MIDDLE'], ['MIDDLE', 'SENIOR'], ['SENIOR', 'MIDDLE'], ['MIDDLE', 'JUNIOR'], ['JUNIOR', 'SENIOR']]) {
        expect((await divisionOf(id)).code).toBe(a);
        expect((await http().put(L(id)).set(bearer(admin)).send({ divisionId: div[b], reason: `${a} to ${b}` }).expect(200)).body.level.code).toBe(b);
      }
    });

    it('who may: User Managers any student; Coaches and Head Coaches their programmes\' students only (others 404); never a student, a teacher or anyone signed out', async () => {
      const member = await student('S3', { programme: maths });
      const other = await student('S3', { programme: physics });
      const own = await tokenOf(member);
      for (const token of [hc, coach]) {
        await http().get(L(member)).set(bearer(token)).expect(200);
        expect(await status(http().get(L(other)).set(bearer(token)))).toEqual([404, 'STUDENT_NOT_FOUND']);
        expect(await status(http().put(L(other)).set(bearer(token)).send({ divisionId: div.SENIOR, reason: 'Not mine' }))).toEqual([404, 'STUDENT_NOT_FOUND']);
      }
      expect((await http().put(L(member)).set(bearer(coach)).send({ divisionId: div.JUNIOR, reason: 'Needs the basics' }).expect(200)).body.history[0].changedBy.username).toBe('ol.coach');
      expect((await http().put(L(member)).set(bearer(hc)).send({ divisionId: div.SENIOR, reason: 'Strong results' }).expect(200)).body.level.code).toBe('SENIOR');
      expect(await status(http().get(L(member)).set(bearer(outsider)))).toEqual([404, 'STUDENT_NOT_FOUND']);
      for (const token of [own, teacher]) {
        expect((await http().get(L(member)).set(bearer(token))).status).toBe(403);
        expect((await http().put(L(member)).set(bearer(token)).send({ divisionId: div.JUNIOR, reason: 'Myself' })).status).toBe(403);
      }
      expect((await http().put(L(member)).send({ divisionId: div.JUNIOR, reason: 'Anonymous' })).status).toBe(401);
      expect((await divisionOf(member)).code).toBe('SENIOR');
      // An individual DENY override takes the permission from one coach.
      await p().userPermissionOverride.create({ data: {
        userId: (await p().user.findUniqueOrThrow({ where: { username: 'ol.coach' } })).id, permission: 'students.classifyLevel', effect: 'DENY',
        reason: 'Not this term', createdById: ctx.ids.admin,
      } });
      expect((await http().get(L(member)).set(bearer(coach))).status).toBe(403);
    });

    it('refusals: reason, unknown or inactive division, both or neither, unknown student or not a student', async () => {
      const id = await student('S2');
      const put = (body: object, target = id) => status(http().put(L(target)).set(bearer(admin)).send(body));
      expect(await put({ divisionId: div.MIDDLE })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await put({ divisionId: div.MIDDLE, reason: 'x' })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await put({ divisionId: div.MIDDLE, reason: 'y'.repeat(501) })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await put({ divisionId: 'not-a-division', reason: 'Bad id' })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await put({ divisionId: randomUUID(), reason: 'Unknown' })).toEqual([400, 'UNKNOWN_DIVISION']);
      expect(await put({ divisionId: div.ADVANCED, reason: 'Inactive' })).toEqual([400, 'UNKNOWN_DIVISION']);
      expect(await put({ reason: 'Neither' })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await put({ divisionId: div.MIDDLE, automatic: true, reason: 'Both' })).toEqual([400, 'LEVEL_WITH_AUTOMATIC']);
      expect(await put({ divisionId: div.MIDDLE, reason: 'Unknown' }, randomUUID())).toEqual([404, 'STUDENT_NOT_FOUND']);
      expect(await put({ divisionId: div.MIDDLE, reason: 'A coach' }, (await p().user.findUniqueOrThrow({ where: { username: 'ol.coach' } })).id)).toEqual([404, 'STUDENT_NOT_FOUND']);
      expect(await p().divisionChange.count({ where: { studentId: id, source: { not: 'GRADE' } } })).toBe(0);
    });

    it('two classifiers at once: both changes are applied in order, each recorded; the history never interleaves', async () => {
      const id = await student('S1');
      const results = await Promise.all(['MIDDLE', 'SENIOR'].map((code) => http().put(L(id)).set(bearer(admin)).send({ divisionId: div[code], reason: `To ${code}` })));
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const manual = await p().divisionChange.findMany({ where: { studentId: id, source: 'MANUAL' }, orderBy: { createdAt: 'asc' } });
      expect(manual).toHaveLength(2);
      expect(manual[1].fromDivisionId).toBe(manual[0].toDivisionId);   // the second saw the first's result (row lock)
      expect((await p().user.findUniqueOrThrow({ where: { id } })).divisionId).toBe(manual[1].toDivisionId);
    });

    it('bulk: Administrators set the division of many students at once (reason required), or send them back to their grade\'s', async () => {
      const ids = [await student('S1'), await student('S2')];
      const selection = { mode: 'ids', ids };
      const run = async (olympiadLevel: string) => {
        const pv = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send({ action: 'setOlympiadLevel', selection, params: { olympiadLevel } }).expect(200);
        await http().post('/api/v1/admin/users/bulk').set(bearer(admin)).send({
          action: 'setOlympiadLevel', selection, params: { olympiadLevel }, selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total,
          confirm: true, idempotencyKey: randomUUID(), reason: `Bulk to ${olympiadLevel}`,
        }).expect(202);
        const { BulkOperationsWorker } = await import('../src/bulk/bulk-operations.worker.js');
        const worker = ctx.app.get(BulkOperationsWorker);
        while ((await worker.processBatch()) > 0) { /* drain */ }
      };
      await run('MIDDLE');
      for (const id of ids) expect(await divisionOf(id)).toEqual({ code: 'MIDDLE', manual: true });
      await run('AUTOMATIC');
      for (const id of ids) expect(await divisionOf(id)).toEqual({ code: 'JUNIOR', manual: false });
      expect(await status(http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send({ action: 'setOlympiadLevel', selection, params: { olympiadLevel: 'ADVANCED' } })))
        .toEqual([400, 'UNKNOWN_DIVISION']);
    });
  });

  describe('tests by division', () => {
    let middleS2: string, seniorS3: string, juniorS6: string, middleTest: string, juniorTest: string;
    beforeAll(async () => {
      middleS2 = await student('S2');   // Junior by grade, moved to Middle
      await http().put(L(middleS2)).set(bearer(admin)).send({ divisionId: div.MIDDLE, reason: 'Middle squad' }).expect(200);
      seniorS3 = await student('S3');   // Middle by grade (above), moved to Senior
      await http().put(L(seniorS3)).set(bearer(admin)).send({ divisionId: div.SENIOR, reason: 'Senior squad' }).expect(200);
      juniorS6 = await student('S6');   // Senior by grade, moved to Junior
      await http().put(L(juniorS6)).set(bearer(admin)).send({ divisionId: div.JUNIOR, reason: 'New to Olympiads' }).expect(200);
      middleTest = await publishedTest('MIDDLE');
      juniorTest = await publishedTest('JUNIOR');
    });

    it('each student sees and answers the tests OF THEIR DIVISION, whatever their grade; the submission keeps its division', async () => {
      const mine = async (id: string) => (await http().get('/api/v1/me/tests').query({ limit: 100 }).set(bearer(await tokenOf(id))).expect(200)).body.data.map((t: any) => t.id);
      expect(await mine(middleS2)).toContain(middleTest);
      expect(await mine(middleS2)).not.toContain(juniorTest);
      expect(await mine(juniorS6)).toContain(juniorTest);
      expect(await mine(juniorS6)).not.toContain(middleTest);
      expect(await mine(seniorS3)).not.toContain(middleTest);
      const submit = async (id: string, testId: string) => status(http().post(`/api/v1/me/tests/${testId}/submission`).set(bearer(await tokenOf(id))).send({ clientKey: randomUUID(), typedAnswer: 'answer' }));
      expect(await submit(seniorS3, middleTest)).toEqual([404, 'TEST_NOT_FOUND']);
      expect((await submit(middleS2, middleTest))[0]).toBe(201);
      expect((await submit(juniorS6, juniorTest))[0]).toBe(201);
      expect((await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: middleTest, studentId: middleS2 } } })).level).toBe('MIDDLE');
    });

    it('the teacher\'s list, tracking and extension targets of a MIDDLE test hold the Middle students only; the teacher submits for one', async () => {
      const listed = (await http().get(`/api/v1/teacher/tests/${middleTest}/students`).query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data;
      const ids = listed.map((r: any) => r.student.id);
      expect(ids).toContain(middleS2);
      expect(ids).not.toContain(seniorS3);
      expect(ids).not.toContain(juniorS6);
      expect(listed.every((r: any) => r.student.division === 'MIDDLE' && r.student.divisionName === 'Middle')).toBe(true);
      expect((await http().get(`/api/v1/teacher/tests/${juniorTest}/students`).query({ division: 'MIDDLE', limit: 100 }).set(bearer(teacher)).expect(200)).body.data).toEqual([]);
      const tracked = (await http().get(`/api/v1/admin/tests/${middleTest}/submissions`).query({ limit: 100 }).set(bearer(admin)).expect(200)).body.data.map((r: any) => r.student.id);
      expect(tracked).toContain(middleS2);
      expect(tracked).not.toContain(juniorS6);
      const targets = (await http().get(`/api/v1/admin/tests/${middleTest}/extension-targets`).query({ kind: 'STUDENT', q: 'Olga' }).set(bearer(admin)).expect(200)).body.data.map((s: any) => s.id);
      expect(targets).toContain(middleS2);
      expect(targets).not.toContain(seniorS3);
      expect(await status(http().post(`/api/v1/admin/tests/${middleTest}/extensions`).set(bearer(admin)).send({ kind: 'STUDENT', studentId: seniorS3, newDeadline: minutes(300), reason: 'Wrong level' })))
        .toEqual([400, 'STUDENT_NOT_IN_DIVISION']);
      const fresh = await student('S3');   // Middle by grade now
      await http().post(`/api/v1/teacher/tests/${middleTest}/students/${fresh}/submission`).set(bearer(teacher)).send({ clientKey: randomUUID(), typedAnswer: 'on paper' }).expect(201);
      const counts = (await http().get('/api/v1/teacher/tests').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.find((t: any) => t.id === middleTest);
      expect(counts.students).toBe(await p().user.count({ where: { role: 'STUDENT', divisionId: div.MIDDLE, schoolId: school, accountStatus: 'ACTIVE' } }));
    });

    it('a later change of division never moves a submitted answer\'s level (the ranking group)', async () => {
      await http().put(L(middleS2)).set(bearer(admin)).send({ divisionId: div.SENIOR, reason: 'Promoted' }).expect(200);
      expect((await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: middleTest, studentId: middleS2 } } })).level).toBe('MIDDLE');
      const mine = (await http().get('/api/v1/me/tests').query({ limit: 100 }).set(bearer(await tokenOf(middleS2))).expect(200)).body.data.map((t: any) => t.id);
      expect(mine).not.toContain(juniorTest);
      expect(mine).not.toContain(middleTest);
    });
  });
});
