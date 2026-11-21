/**
 * Olympiad levels (owner, 2026-11-21), end to end:
 *  - the grade suggests the level (S1–S2 Junior, S3–S4 Middle, S5–S6 Senior) whatever creates or changes the student;
 *  - a Coach / Head Coach (their programmes' students) or a User Manager sets it by hand (reason, history, audit); a level
 *    set by hand no longer follows the grade; "automatic" returns it to the suggestion;
 *  - who may: User Managers (any student), Coaches and Head Coaches (only their programmes' students; others 404); never
 *    a student, a teacher or anyone signed out; refusals and edge cases;
 *  - tests: a MIDDLE test; eligibility, the student's list, the teacher's list, tracking and extensions use the LEVEL,
 *    never the grade; a submission keeps the level it was made at; lists filter by level; the profile shows it.
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe('Olympiad levels: suggested by the grade, set by Coaches and User Managers, used by tests (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hc: string, coach: string, outsider: string, teacher: string;
  let maths: string, physics: string, school: string;
  let hash: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const L = (id: string) => `/api/v1/admin/students/${id}/olympiad-level`;
  const levelOf = async (id: string) => (await p().user.findUniqueOrThrow({ where: { id }, select: { olympiadLevel: true, olympiadLevelManual: true } }));

  let n = 0;
  /** A student created directly in the database (as sign-up, an import or an Administrator would): the trigger decides. */
  const student = async (grade: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6', extra: { programme?: string } = {}) => {
    n += 1;
    const division = ['S1', 'S2', 'S3'].includes(grade) ? ctx.ids.junior : (await p().division.findFirstOrThrow({ where: { code: 'SENIOR' } })).id;
    const u = await p().user.create({ data: {
      username: `ol.s${n}`, firstName: `Olga${n}`, lastName: 'Level', email: `ol.s${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: grade, divisionId: division, schoolId: school, homeLocation: 'Huye',
      dateOfBirth: new Date('2010-01-01'), olympiadInterests: ['MATHEMATICS'],
    } });
    await p().studentSchoolAffiliation.create({ data: { studentId: u.id, schoolId: school, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } });
    if (extra.programme) await p().programmeMembership.create({ data: { userId: u.id, disciplineId: extra.programme, source: 'MANUAL' } });
    return u.id;
  };
  const publishedTest = async (division: string, extra: Record<string, unknown> = {}) => {
    const t = await http().post('/api/v1/admin/tests').set(bearer(admin)).send({
      title: `Level ${division} ${randomUUID().slice(0, 4)}`, subjectId: maths, division, answerFormat: 'TYPED_ONLY',
      opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10, questions: [{ prompt: 'Prove it', maxMarks: 10 }], ...extra,
    }).expect(201);
    await http().post(`/api/v1/admin/tests/${t.body.id}/publish`).set(bearer(admin)).expect(200);
    return t.body.id as string;
  };

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
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('the grade suggests the level for every grade (S1–S2 Junior, S3–S4 Middle, S5–S6 Senior); other roles: none', async () => {
    const expected = { S1: 'JUNIOR', S2: 'JUNIOR', S3: 'MIDDLE', S4: 'MIDDLE', S5: 'SENIOR', S6: 'SENIOR' } as const;
    for (const [grade, level] of Object.entries(expected)) {
      const id = await student(grade as keyof typeof expected);
      expect([grade, await levelOf(id)]).toEqual([grade, { olympiadLevel: level, olympiadLevelManual: false }]);
      expect((await p().olympiadLevelChange.findMany({ where: { studentId: id } })).map((h) => [h.source, h.fromLevel, h.toLevel, h.gradeLevel]))
        .toEqual([['GRADE', null, level, grade]]);
    }
    // A student always has a grade (CHECK User_student_division_check), so always a suggested level.
    expect((await p().user.findUniqueOrThrow({ where: { username: 'ol.coach' } })).olympiadLevel).toBeNull();
  });

  it('an Administrator\'s grade change moves the level (and records it); the profile and the Users list show it and filter by it', async () => {
    const id = await student('S2');
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ gradeLevel: 'S4' }).expect(200);
    expect(await levelOf(id)).toEqual({ olympiadLevel: 'MIDDLE', olympiadLevelManual: false });
    const view = (await http().get(L(id)).set(bearer(admin)).expect(200)).body;
    expect(view).toMatchObject({ studentId: id, gradeLevel: 'S4', level: 'MIDDLE', manual: false, suggestedLevel: 'MIDDLE' });
    expect(view.history.map((h: any) => [h.source, h.fromLevel, h.toLevel])).toEqual([['GRADE', 'JUNIOR', 'MIDDLE'], ['GRADE', null, 'JUNIOR']]);
    // The student sees their own level; administrators see it, and whether it was set by hand, in the Users list.
    const me = (await http().get('/api/v1/me').set(bearer(await login(ctx, (await p().user.findUniqueOrThrow({ where: { id } })).username))).expect(200)).body;
    expect(me.olympiadLevel).toBe('MIDDLE');
    const rows = (await http().get('/api/v1/admin/users').query({ role: 'STUDENT', olympiadLevel: 'MIDDLE', limit: 100 }).set(bearer(admin)).expect(200)).body.data;
    expect(rows.map((r: any) => r.id)).toContain(id);
    expect(rows.every((r: any) => r.olympiadLevel === 'MIDDLE')).toBe(true);
    expect(rows.find((r: any) => r.id === id)).toMatchObject({ olympiadLevel: 'MIDDLE', olympiadLevelManual: false });
    await http().get('/api/v1/admin/users').query({ olympiadLevel: 'PRIMARY' }).set(bearer(admin)).expect(400);
  });

  it('set by hand (reason, history, audit): it stays when the grade changes; automatic returns it to the suggestion and it follows the grade again', async () => {
    const id = await student('S5');
    const set = (await http().put(L(id)).set(bearer(admin)).send({ level: 'MIDDLE', reason: '  Joined the Middle squad  ' }).expect(200)).body;
    expect(set).toMatchObject({ level: 'MIDDLE', manual: true, suggestedLevel: 'SENIOR' });
    expect(set.history[0]).toMatchObject({ source: 'MANUAL', fromLevel: 'SENIOR', toLevel: 'MIDDLE', gradeLevel: 'S5', reason: 'Joined the Middle squad', changedBy: { id: ctx.ids.admin } });
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'OLYMPIAD_LEVEL_CHANGED', entityId: id } })).metadata)
      .toMatchObject({ from: 'SENIOR', to: 'MIDDLE', manual: true, gradeLevel: 'S5', reason: 'Joined the Middle squad' });
    // Set by hand: a grade change no longer moves it, and writes no history.
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ gradeLevel: 'S1' }).expect(200);
    expect(await levelOf(id)).toEqual({ olympiadLevel: 'MIDDLE', olympiadLevelManual: true });
    expect(await p().olympiadLevelChange.count({ where: { studentId: id } })).toBe(2);
    // The same again: nothing to do, nothing written.
    await http().put(L(id)).set(bearer(admin)).send({ level: 'MIDDLE', reason: 'Again' }).expect(200);
    expect(await p().auditLog.count({ where: { action: 'OLYMPIAD_LEVEL_CHANGED', entityId: id } })).toBe(1);
    // Automatic: the grade's suggestion (S1 → Junior), and the grade leads again.
    const auto = (await http().put(L(id)).set(bearer(admin)).send({ automatic: true, reason: 'Back to the grade' }).expect(200)).body;
    expect(auto).toMatchObject({ level: 'JUNIOR', manual: false, suggestedLevel: 'JUNIOR' });
    expect(auto.history[0]).toMatchObject({ source: 'AUTOMATIC', fromLevel: 'MIDDLE', toLevel: 'JUNIOR', reason: 'Back to the grade' });
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ gradeLevel: 'S6' }).expect(200);
    expect(await levelOf(id)).toEqual({ olympiadLevel: 'SENIOR', olympiadLevelManual: false });
    // Every transition between the three levels is allowed by hand.
    for (const [a, b] of [['SENIOR', 'JUNIOR'], ['JUNIOR', 'MIDDLE'], ['MIDDLE', 'SENIOR'], ['SENIOR', 'MIDDLE'], ['MIDDLE', 'JUNIOR'], ['JUNIOR', 'SENIOR']]) {
      expect((await levelOf(id)).olympiadLevel).toBe(a);
      expect((await http().put(L(id)).set(bearer(admin)).send({ level: b, reason: `${a} to ${b}` }).expect(200)).body.level).toBe(b);
    }
  });

  it('who may: User Managers any student; Coaches and Head Coaches their programmes\' students only (others 404); never a student, a teacher or anyone signed out', async () => {
    const member = await student('S3', { programme: maths });
    const other = await student('S3', { programme: physics });
    const own = await login(ctx, (await p().user.findUniqueOrThrow({ where: { id: member } })).username);
    for (const token of [hc, coach]) {
      await http().get(L(member)).set(bearer(token)).expect(200);
      expect(await status(http().get(L(other)).set(bearer(token)))).toEqual([404, 'STUDENT_NOT_FOUND']);
      expect(await status(http().put(L(other)).set(bearer(token)).send({ level: 'SENIOR', reason: 'Not mine' }))).toEqual([404, 'STUDENT_NOT_FOUND']);
    }
    expect((await http().put(L(member)).set(bearer(coach)).send({ level: 'JUNIOR', reason: 'Needs the basics' }).expect(200)).body.history[0].changedBy.username).toBe('ol.coach');
    expect((await http().put(L(member)).set(bearer(hc)).send({ level: 'SENIOR', reason: 'Strong results' }).expect(200)).body.level).toBe('SENIOR');
    // The coach of another programme sees nothing of this student.
    expect(await status(http().get(L(member)).set(bearer(outsider)))).toEqual([404, 'STUDENT_NOT_FOUND']);
    for (const token of [own, teacher]) {
      expect((await http().get(L(member)).set(bearer(token))).status).toBe(403);
      expect((await http().put(L(member)).set(bearer(token)).send({ level: 'JUNIOR', reason: 'Myself' })).status).toBe(403);
    }
    expect((await http().put(L(member)).send({ level: 'JUNIOR', reason: 'Anonymous' })).status).toBe(401);
    expect((await levelOf(member)).olympiadLevel).toBe('SENIOR');
    // A Super Administrator's DENY override takes it from one coach (the permission is individual).
    await p().userPermissionOverride.create({ data: {
      userId: (await p().user.findUniqueOrThrow({ where: { username: 'ol.coach' } })).id, permission: 'students.classifyLevel', effect: 'DENY',
      reason: 'Not this term', createdById: ctx.ids.admin,
    } });
    expect((await http().get(L(member)).set(bearer(coach))).status).toBe(403);
  });

  it('refusals: reason, unknown level, both or neither, unknown student or not a student', async () => {
    const id = await student('S2');
    const put = (body: object, target = id) => status(http().put(L(target)).set(bearer(admin)).send(body));
    expect(await put({ level: 'MIDDLE' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await put({ level: 'MIDDLE', reason: 'x' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await put({ level: 'MIDDLE', reason: 'y'.repeat(501) })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await put({ level: 'PRIMARY', reason: 'Unknown' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await put({ reason: 'Neither' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await put({ level: 'MIDDLE', automatic: true, reason: 'Both' })).toEqual([400, 'LEVEL_WITH_AUTOMATIC']);
    expect(await put({ level: 'MIDDLE', reason: 'Unknown' }, randomUUID())).toEqual([404, 'STUDENT_NOT_FOUND']);
    expect(await put({ level: 'MIDDLE', reason: 'A coach' }, (await p().user.findUniqueOrThrow({ where: { username: 'ol.coach' } })).id)).toEqual([404, 'STUDENT_NOT_FOUND']);
    expect((await http().put(`/api/v1/admin/students/not-a-uuid/olympiad-level`).set(bearer(admin)).send({ level: 'MIDDLE', reason: 'Bad' })).status).toBe(400);
    expect(await p().olympiadLevelChange.count({ where: { studentId: id, source: { not: 'GRADE' } } })).toBe(0);
  });

  it('two classifiers at once: both changes are applied in order, each recorded; the history never interleaves', async () => {
    const id = await student('S1');
    const results = await Promise.all(['MIDDLE', 'SENIOR'].map((level) => http().put(L(id)).set(bearer(admin)).send({ level, reason: `To ${level}` })));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const manual = await p().olympiadLevelChange.findMany({ where: { studentId: id, source: 'MANUAL' }, orderBy: { createdAt: 'asc' } });
    expect(manual).toHaveLength(2);
    expect(manual[1].fromLevel).toBe(manual[0].toLevel);   // the second saw the first's result (row lock)
    expect((await levelOf(id)).olympiadLevel).toBe(manual[1].toLevel);
  });

  describe('tests by Olympiad level', () => {
    let middleS2: string, seniorS4: string, juniorS6: string, middleTest: string, juniorTest: string;
    beforeAll(async () => {
      middleS2 = await student('S2');   // Junior by grade, moved to Middle
      await http().put(L(middleS2)).set(bearer(admin)).send({ level: 'MIDDLE', reason: 'Middle squad' }).expect(200);
      seniorS4 = await student('S4');   // Middle by grade, moved to Senior
      await http().put(L(seniorS4)).set(bearer(admin)).send({ level: 'SENIOR', reason: 'Senior squad' }).expect(200);
      juniorS6 = await student('S6');   // Senior by grade, moved to Junior
      await http().put(L(juniorS6)).set(bearer(admin)).send({ level: 'JUNIOR', reason: 'New to Olympiads' }).expect(200);
      middleTest = await publishedTest('MIDDLE');
      juniorTest = await publishedTest('JUNIOR');
    });
    const tokenOf = async (id: string) => login(ctx, (await p().user.findUniqueOrThrow({ where: { id } })).username);

    it('a MIDDLE test is created and published; each student sees and answers the tests OF THEIR LEVEL, whatever their grade', async () => {
      expect((await p().test.findUniqueOrThrow({ where: { id: middleTest } })).division).toBe('MIDDLE');
      const mine = async (id: string) => (await http().get('/api/v1/me/tests').query({ limit: 100 }).set(bearer(await tokenOf(id))).expect(200)).body.data.map((t: any) => t.id);
      expect(await mine(middleS2)).toContain(middleTest);
      expect(await mine(middleS2)).not.toContain(juniorTest);
      expect(await mine(juniorS6)).toContain(juniorTest);
      expect(await mine(juniorS6)).not.toContain(middleTest);
      expect(await mine(seniorS4)).not.toContain(middleTest);
      const submit = async (id: string, testId: string) => status(http().post(`/api/v1/me/tests/${testId}/submission`).set(bearer(await tokenOf(id))).send({ clientKey: randomUUID(), typedAnswer: 'answer' }));
      expect(await submit(seniorS4, middleTest)).toEqual([404, 'TEST_NOT_FOUND']);
      expect((await submit(middleS2, middleTest))[0]).toBe(201);
      expect((await submit(juniorS6, juniorTest))[0]).toBe(201);
      // The submission keeps the level it was made at.
      expect((await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: middleTest, studentId: middleS2 } } })).level).toBe('MIDDLE');
    });

    it('the teacher\'s list, tracking and extension targets of a MIDDLE test hold the Middle students only; the teacher submits for one', async () => {
      const listed = (await http().get(`/api/v1/teacher/tests/${middleTest}/students`).query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data;
      const ids = listed.map((r: any) => r.student.id);
      expect(ids).toContain(middleS2);
      expect(ids).not.toContain(seniorS4);
      expect(ids).not.toContain(juniorS6);
      expect(listed.every((r: any) => r.student.olympiadLevel === 'MIDDLE' && r.student.division === 'MIDDLE')).toBe(true);
      // The teacher's own student list filters by level.
      const mine = (await http().get('/api/v1/teacher/students').query({ olympiadLevel: 'MIDDLE', limit: 100 }).set(bearer(teacher)).expect(200)).body.data;
      expect(mine.every((s: any) => s.olympiadLevel === 'MIDDLE')).toBe(true);
      expect(mine.map((s: any) => s.id)).toContain(middleS2);
      const tracked = (await http().get(`/api/v1/admin/tests/${middleTest}/submissions`).query({ limit: 100 }).set(bearer(admin)).expect(200)).body.data.map((r: any) => r.student.id);
      expect(tracked).toContain(middleS2);
      expect(tracked).not.toContain(juniorS6);
      const targets = (await http().get(`/api/v1/admin/tests/${middleTest}/extension-targets`).query({ kind: 'STUDENT', q: 'Olga' }).set(bearer(admin)).expect(200)).body.data.map((s: any) => s.id);
      expect(targets).toContain(middleS2);
      expect(targets).not.toContain(seniorS4);
      expect(await status(http().post(`/api/v1/admin/tests/${middleTest}/extensions`).set(bearer(admin)).send({ kind: 'STUDENT', studentId: seniorS4, newDeadline: minutes(300), reason: 'Wrong level' })))
        .toEqual([400, 'STUDENT_NOT_IN_DIVISION']);
      // A Middle student of the teacher's school without an answer yet: the teacher submits for them.
      const fresh = await student('S3');
      await http().post(`/api/v1/teacher/tests/${middleTest}/students/${fresh}/submission`).set(bearer(teacher)).send({ clientKey: randomUUID(), typedAnswer: 'on paper' }).expect(201);
    });

    it('a later change of level never moves a submitted answer\'s level (the ranking group)', async () => {
      await http().put(L(middleS2)).set(bearer(admin)).send({ level: 'SENIOR', reason: 'Promoted' }).expect(200);
      expect((await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: middleTest, studentId: middleS2 } } })).level).toBe('MIDDLE');
      // …while the student now sees the tests of the new level only.
      const mine = (await http().get('/api/v1/me/tests').query({ limit: 100 }).set(bearer(await tokenOf(middleS2))).expect(200)).body.data.map((t: any) => t.id);
      expect(mine).not.toContain(juniorTest);
      expect(mine).not.toContain(middleTest);
    });
  });
});
