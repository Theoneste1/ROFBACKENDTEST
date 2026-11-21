/**
 * Teacher self-service and locked submissions (owner, 2026-11-21) — the whole path, end to end:
 *  - two teachers register with the same listed school: each gets the account at once and signs in;
 *  - both see the school's students (verified and pending claims), never another school's or a rejected claim;
 *  - a teacher submits a test for a student; the student cannot overwrite it, nor the other teacher; the student's own
 *    rights stay (another test: they submit themselves);
 *  - an Administrator revokes one teacher's test submission (reason, audited): that teacher is refused, still signs in
 *    and still sees their students; the other teacher and the students are unaffected; restored: submits again;
 *  - only Administrators change it (not a teacher, a Head Coach or a student); the Users list shows the state.
 */
import { randomUUID } from 'node:crypto';

import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe('Teacher self-service: register, find the school\'s students, submit; locked; Administrator controls (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hc: string;
  let school: string, other: string, maths: string;
  let sVerified: string, sPending: string, sRejected: string, sOther: string;
  let t1: string, t2: string, t1Id: string, t2Id: string, stud: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };

  const registerTeacher = (username: string) => http().post('/api/v1/auth/register/teacher').send({
    firstName: 'Theoneste', lastName: 'Nsanza', username, email: `${username}@test.local`, password: 'Secret123', confirmPassword: 'Secret123',
    gender: 'MALE', country: 'RW', phone: '0788123456', olympiadInterests: ['MATHEMATICS'],
    schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolId: school,
    homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma',
  });

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': true }).expect(200);
    const official = (name: string, code: string) => p().school.create({ data: {
      name, code, nameKey: name.toLowerCase(), location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST', province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
    } }).then((s) => s.id);
    school = await official('gs self service', '230001');
    other = await official('gs elsewhere', '230002');
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const kid = async (username: string, schoolId: string, claim: 'VERIFIED' | 'PENDING' | 'REJECTED') => {
      const id = (await p().user.create({ data: {
        username, firstName: username, lastName: 'S', email: `${username}@test.local`, role: 'STUDENT', passwordHash: hash, activatedAt: new Date(),
        gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId, homeLocation: 'Huye', dateOfBirth: new Date('2011-01-01'), olympiadInterests: ['MATHEMATICS'],
      } })).id;
      await p().studentSchoolAffiliation.create({ data: {
        studentId: id, schoolId, status: claim, source: claim === 'PENDING' ? 'REGISTRATION' : 'ADMIN', createdById: ctx.ids.admin,
        ...(claim !== 'PENDING' && { decidedById: ctx.ids.admin, decidedAt: new Date() }),
      } });
      return id;
    };
    sVerified = await kid('ss.verified', school, 'VERIFIED');
    sPending = await kid('ss.pending', school, 'PENDING');
    sRejected = await kid('ss.rejected', school, 'REJECTED');
    sOther = await kid('ss.other', other, 'VERIFIED');
    stud = await login(ctx, 'ss.pending');
    const hcId = (await p().user.create({ data: { username: 'ss.hc', firstName: 'H', lastName: 'C', email: 'ss.hc@test.local', role: 'HEAD_COACH', passwordHash: hash, activatedAt: new Date() } })).id;
    await p().programmeMembership.create({ data: { userId: hcId, disciplineId: maths, source: 'MANUAL' } });
    hc = await login(ctx, 'ss.hc');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('two teachers register with the same school: accounts at once, signed in, both see the school\'s students (pending included) and no other', async () => {
    for (const u of ['ss.t1', 'ss.t2']) {
      const res = await registerTeacher(u).expect(201);
      expect(res.body).toMatchObject({ status: 'APPROVED', accountCreated: true, emailVerificationRequired: false });
    }
    [t1, t2] = await Promise.all(['ss.t1', 'ss.t2'].map((u) => login(ctx, u, 'Secret123')));
    t1Id = (await p().user.findUniqueOrThrow({ where: { username: 'ss.t1' } })).id;
    t2Id = (await p().user.findUniqueOrThrow({ where: { username: 'ss.t2' } })).id;
    // The first is the school's primary teacher, the second a secondary one: the same rights.
    expect((await p().teacherSchoolAssignment.findMany({ where: { schoolId: school }, orderBy: { createdAt: 'asc' }, select: { teacherId: true, role: true } })))
      .toEqual([{ teacherId: t1Id, role: 'PRIMARY' }, { teacherId: t2Id, role: 'SECONDARY' }]);
    for (const t of [t1, t2]) {
      const ids = (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(t)).expect(200)).body.data.map((s: any) => s.id);
      expect(ids.sort()).toEqual([sVerified, sPending].sort());
      for (const hidden of [sRejected, sOther]) expect(ids).not.toContain(hidden);
    }
  });

  describe('a test', () => {
    let testId: string;
    const forStudent = (token: string, studentId: string) => `/api/v1/teacher/tests/${testId}/students/${studentId}/submission`;
    beforeAll(async () => {
      const t = await http().post('/api/v1/admin/tests').set(bearer(admin)).send({
        title: 'Self service round', subjectId: maths, division: 'JUNIOR', answerFormat: 'TYPED_ONLY', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10, questions: [{ prompt: 'Prove it', maxMarks: 10 }],
      }).expect(201);
      testId = t.body.id;
      await http().post(`/api/v1/admin/tests/${testId}/publish`).set(bearer(admin)).expect(200);
    });

    it('the teacher submits for a student; locked for the student and the other teacher; another school\'s student is refused', async () => {
      await http().post(forStudent(t1, sPending)).set(bearer(t1)).send({ clientKey: randomUUID(), typedAnswer: 'Answer handed in on paper' }).expect(201);
      expect(await status(http().post(`/api/v1/me/tests/${testId}/submission`).set(bearer(stud)).send({ clientKey: randomUUID(), typedAnswer: 'mine' }))).toEqual([409, 'SUBMISSION_LOCKED']);
      expect(await status(http().post(forStudent(t2, sPending)).set(bearer(t2)).send({ clientKey: randomUUID(), typedAnswer: 'overwrite' }))).toEqual([409, 'SUBMISSION_LOCKED']);
      for (const hidden of [sOther, sRejected]) {
        expect(await status(http().post(forStudent(t1, hidden)).set(bearer(t1)).send({ clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([403, 'STUDENT_NOT_IN_SCOPE']);
      }
      expect((await http().get(`/api/v1/teacher/tests/${testId}/students`).query({ limit: 100 }).set(bearer(t2)).expect(200)).body.data.map((r: any) => r.student.id).sort())
        .toEqual([sVerified, sPending].sort());
      const view = (await http().get(`/api/v1/me/tests/${testId}`).set(bearer(stud)).expect(200)).body;
      expect([view.locked, view.canSubmit, view.submission.versions[0].submitterRole]).toEqual([true, false, 'TEACHER']);
    });

    it('an Administrator revokes one teacher\'s test submission: refused for that teacher only; the account, sign-in and student list stay; restored', async () => {
      const url = (id: string) => `/api/v1/admin/teachers/${id}/test-submission`;
      expect((await http().get(url(t1Id)).set(bearer(admin)).expect(200)).body).toMatchObject({ allowed: true, revokedAt: null });
      // Only Administrators: not a teacher, a Head Coach or a student; a reason is required to revoke.
      for (const token of [t1, t2, hc, stud]) expect((await http().put(url(t1Id)).set(bearer(token)).send({ allowed: false, reason: 'Testing' })).status).toBe(403);
      expect(await status(http().put(url(t1Id)).set(bearer(admin)).send({ allowed: false }))).toEqual([400, 'REASON_REQUIRED']);
      expect(await status(http().put(url(sVerified)).set(bearer(admin)).send({ allowed: false, reason: 'Not a teacher' }))).toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
      const revoked = (await http().put(url(t1Id)).set(bearer(admin)).send({ allowed: false, reason: 'Submitted for the wrong school' }).expect(200)).body;
      expect(revoked).toMatchObject({ allowed: false, reason: 'Submitted for the wrong school', revokedBy: { id: ctx.ids.admin } });
      // Idempotent: revoking again changes nothing (one audit entry).
      await http().put(url(t1Id)).set(bearer(admin)).send({ allowed: false, reason: 'Again' }).expect(200);
      expect(await p().auditLog.count({ where: { action: 'TEACHER_TEST_SUBMISSION_REVOKED', entityId: t1Id } })).toBe(1);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'TEACHER_TEST_SUBMISSION_REVOKED', entityId: t1Id } })).metadata)
        .toMatchObject({ permission: 'tests.submitForStudents', reason: 'Submitted for the wrong school' });

      // Teacher 1: refused on the test submission routes, on the next request — but still signed in, still an ACTIVE
      // account, still sees their students.
      expect((await http().get(`/api/v1/teacher/tests/${testId}/students`).set(bearer(t1))).status).toBe(403);
      expect((await http().post(forStudent(t1, sVerified)).set(bearer(t1)).send({ clientKey: randomUUID(), typedAnswer: 'x' })).status).toBe(403);
      await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200);
      expect((await p().user.findUniqueOrThrow({ where: { id: t1Id } })).accountStatus).toBe('ACTIVE');
      expect((await http().post('/api/v1/auth/login').send({ username: 'ss.t1', password: 'Secret123' })).status).toBe(200);
      // The Users list shows it on the teacher's row.
      const rows = (await http().get('/api/v1/admin/users').query({ role: 'TEACHER', limit: 100 }).set(bearer(admin)).expect(200)).body.data;
      expect(Object.fromEntries(rows.filter((r: any) => [t1Id, t2Id].includes(r.id)).map((r: any) => [r.username, r.testSubmissionAllowed])))
        .toEqual({ 'ss.t1': false, 'ss.t2': true });

      // Teacher 2 and the students are unaffected: teacher 2 submits for the verified student; a student submits their own.
      await http().post(forStudent(t2, sVerified)).set(bearer(t2)).send({ clientKey: randomUUID(), typedAnswer: 'by teacher two' }).expect(201);
      const own = await login(ctx, 'ss.verified');
      expect(await status(http().post(`/api/v1/me/tests/${testId}/submission`).set(bearer(own)).send({ clientKey: randomUUID(), typedAnswer: 'x' }))).toEqual([409, 'SUBMISSION_LOCKED']);

      // Restored: teacher 1 submits again (for a student without an answer yet, in a new test).
      const restored = (await http().put(url(t1Id)).set(bearer(admin)).send({ allowed: true }).expect(200)).body;
      expect(restored).toMatchObject({ allowed: true, revokedAt: null });
      expect(await p().auditLog.count({ where: { action: 'TEACHER_TEST_SUBMISSION_RESTORED', entityId: t1Id } })).toBe(1);
      await http().get(`/api/v1/teacher/tests/${testId}/students`).set(bearer(t1)).expect(200);
    });

    it('the student keeps their own right: in a test without a teacher\'s answer they submit themselves (then locked); an Administrator unlocks, they replace', async () => {
      const t = await http().post('/api/v1/admin/tests').set(bearer(admin)).send({
        title: 'Own round', subjectId: maths, division: 'JUNIOR', answerFormat: 'TYPED_ONLY', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10, questions: [{ prompt: 'Prove it', maxMarks: 10 }],
      }).expect(201);
      await http().post(`/api/v1/admin/tests/${t.body.id}/publish`).set(bearer(admin)).expect(200);
      const mine = `/api/v1/me/tests/${t.body.id}/submission`;
      await http().post(mine).set(bearer(stud)).send({ clientKey: randomUUID(), typedAnswer: 'My own answer' }).expect(201);
      expect(await status(http().post(`/api/v1/teacher/tests/${t.body.id}/students/${sPending}/submission`).set(bearer(t1)).send({ clientKey: randomUUID(), typedAnswer: 'overwrite' })))
        .toEqual([409, 'SUBMISSION_LOCKED']);
      const sub = await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: t.body.id, studentId: sPending } } });
      await http().post(`/api/v1/admin/tests/${t.body.id}/submissions/${sub.id}/resubmission`).set(bearer(admin)).send({ reason: 'Wrong file' }).expect(200);
      await http().post(mine).set(bearer(stud)).send({ clientKey: randomUUID(), typedAnswer: 'Corrected answer' }).expect(201);
      expect(await status(http().post(mine).set(bearer(stud)).send({ clientKey: randomUUID(), typedAnswer: 'again' }))).toEqual([409, 'SUBMISSION_LOCKED']);
      expect((await p().testSubmissionVersion.findMany({ where: { submissionId: sub.id }, orderBy: { number: 'asc' } })).map((v) => v.typedAnswer))
        .toEqual(['My own answer', 'Corrected answer']);
    });
  });
});
