/**
 * Course homework by teachers, by default (owner decision 2026-11-23, confirmed 2026-11-24; capability
 * teacherHomeworkDefault): every Teacher sees the homework progress of, and hands course homework in for, the students
 * they see — their schools' students and the students assigned to them (the same students as for tests) — without a
 * delegation. An Administrator switches both off or on again per teacher (GET / PUT /admin/teachers/:id/homework-submission,
 * users.manageTeachers, reason required to switch off, audited); switched off, no delegation brings either back. Every
 * on-behalf submission records the teacher as the submitter.
 *
 * Fixtures: the seed's "Test School" (student.j, a verified student) with teacher HW1; a second school with student B,
 * assigned to HW1 with a reason (cross-school) and a student of teacher HW2; a third school with student C (nobody's);
 * a published Algebra × Junior assignment.
 */
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

describe('Course homework by teachers, by default (owner 2026-11-24)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, coachJ: string, studentJ2: string, t1: string, t2: string;
  let t1Id: string, t2Id: string, schoolA: string, schoolB: string, schoolC: string, studentB: string, studentC: string, workId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const SWITCH = (id: string) => `/api/v1/admin/teachers/${id}/homework-submission`;
  const progress = (token: string, studentId: string) => http().get(`/api/v1/teacher/students/${studentId}/progress`).set(bearer(token));
  const submitFor = (token: string, studentId: string) =>
    http().post(`/api/v1/teacher/students/${studentId}/submissions`).set(bearer(token)).field('assignmentId', workId).attach('file', PDF, 'homework.pdf');
  const mine = async (token: string) => (await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.permissions as string[];
  const listed = async (token: string) => Object.fromEntries(
    ((await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(token)).expect(200)).body.data as any[]).map((r) => [r.id, { access: r.access, can: r.can }]),
  );
  const verifiedAt = (studentId: string, schoolId: string) => p().studentSchoolAffiliation.create({ data: {
    studentId, schoolId, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date(),
  } });

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coachJ = await login(ctx, 'mentor.j');
    studentJ2 = await login(ctx, 'student.j2');
    schoolA = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    schoolB = (await p().school.create({ data: { name: 'Homework School B', location: 'Huye' } })).id;
    schoolC = (await p().school.create({ data: { name: 'Homework School C', location: 'Musanze' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'STUDENT' | 'SUPER_ADMIN', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    t1Id = await mk('hw.t1', 'TEACHER');
    t2Id = await mk('hw.t2', 'TEACHER');
    await mk('hw.super', 'SUPER_ADMIN');
    studentB = await mk('hw.student.b', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolB, homeLocation: 'Huye' });
    studentC = await mk('hw.student.c', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolC, homeLocation: 'Musanze' });
    await verifiedAt(ctx.ids.studentJunior, schoolA);
    await verifiedAt(studentB, schoolB);
    await verifiedAt(studentC, schoolC);
    [t1, t2, superAdmin] = await Promise.all(['hw.t1', 'hw.t2', 'hw.super'].map((u) => login(ctx, u)));
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: t1Id, schoolId: schoolA }).expect(201);
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: t2Id, schoolId: schoolB }).expect(201);
    // Student B (another school) assigned to HW1 — with a reason, as for any cross-school assignment (TS-3).
    const assigned = await http().post('/api/v1/admin/teacher-students').set(bearer(admin))
      .send({ teacherId: t1Id, studentIds: [studentB], reason: 'Olympiad camp group' }).expect(200);
    expect(assigned.body.results).toEqual([expect.objectContaining({ studentId: studentB, outcome: 'ASSIGNED' })]);
    workId = (await p().assignment.create({ data: {
      title: 'Homework for teachers', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(), allowResubmission: true, maxResubmissions: 5,
    } })).id;
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('the capability is announced', async () => {
    expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toContain('teacherHomeworkDefault');
  });

  it('by default, with no delegation, a teacher holds homework progress and on-behalf submission for the students they see', async () => {
    expect(await p().userPermissionOverride.count({ where: { userId: t1Id } })).toBe(0);
    expect(await mine(t1)).toEqual(expect.arrayContaining(['students.viewProgress', 'submissions.submitOnBehalf']));
    expect(await mine(t1)).not.toContain('students.viewProfile');   // the profile is still a delegation
    const rows = await listed(t1);
    expect(rows[ctx.ids.studentJunior]).toEqual({ access: { school: true, assigned: false }, can: { viewProfile: false, viewProgress: true, submitOnBehalf: true } });
    expect(rows[studentB]).toEqual({ access: { school: false, assigned: true }, can: { viewProfile: false, viewProgress: true, submitOnBehalf: true } });
    expect(rows[studentC]).toBeUndefined();
  });

  it('a school student: progress, then homework handed in by the teacher — the student owns it, the teacher is recorded', async () => {
    const before = (await progress(t1, ctx.ids.studentJunior).expect(200)).body;
    expect(before.assignments.find((a: any) => a.id === workId)).toMatchObject({ submission: null });
    const res = (await submitFor(t1, ctx.ids.studentJunior).expect(201)).body;
    expect(res).toMatchObject({ assignmentId: workId, studentId: ctx.ids.studentJunior, status: 'SUBMITTED', submittedBy: { id: t1Id, role: 'TEACHER' } });
    const revision = await p().submissionRevision.findFirstOrThrow({ where: { submissionId: res.id } });
    expect(revision.submittedById).toBe(t1Id);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'SUBMIT_ASSIGNMENT', entityId: res.id } });
    expect([audit.actorId, audit.actorRole]).toEqual([t1Id, 'TEACHER']);
    expect(audit.metadata).toMatchObject({ onBehalfOf: ctx.ids.studentJunior });
    const after = (await progress(t1, ctx.ids.studentJunior).expect(200)).body;
    expect(after.assignments.find((a: any) => a.id === workId).submission.attempts[0].submittedBy).toMatchObject({ id: t1Id, role: 'TEACHER' });
  });

  it('a student of another school assigned to the teacher: progress and homework too', async () => {
    await progress(t1, studentB).expect(200);
    const res = (await submitFor(t1, studentB).expect(201)).body;
    expect(res).toMatchObject({ studentId: studentB, submittedBy: { id: t1Id } });
  });

  it('a student outside both (another school, not assigned): not found, nothing saved', async () => {
    expect(await status(progress(t1, studentC))).toEqual([404, 'NOT_FOUND']);
    const refused = await submitFor(t1, studentC);
    expect([refused.status, refused.body.code, refused.body.message]).toEqual([404, 'NOT_FOUND', 'Student not found.']);
    expect(await p().submission.count({ where: { studentId: studentC } })).toBe(0);
  });

  it('only an Administrator (or Super Admin) reads or changes the switch; a reason is required to switch it off', async () => {
    expect((await http().get(SWITCH(t1Id)).set(bearer(admin)).expect(200)).body).toEqual({ userId: t1Id, allowed: true, revokedAt: null, reason: null, revokedBy: null });
    await http().get(SWITCH(t1Id)).set(bearer(superAdmin)).expect(200);
    for (const token of [t1, t2, coachJ, studentJ2]) {
      expect(await status(http().get(SWITCH(t1Id)).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(http().put(SWITCH(t1Id)).set(bearer(token)).send({ allowed: false, reason: 'Not allowed' }))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
    expect((await status(http().get(SWITCH(t1Id))))[0]).toBe(401);
    const noReason = await http().put(SWITCH(t1Id)).set(bearer(admin)).send({ allowed: false });
    expect([noReason.status, noReason.body.code, noReason.body.message]).toEqual([400, 'REASON_REQUIRED', 'Give a reason (3–500 characters) for switching off course homework.']);
    expect(await status(http().put(SWITCH(studentB)).set(bearer(admin)).send({ allowed: false, reason: 'Not a teacher' }))).toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
    expect(await status(http().put(SWITCH(t1Id)).set(bearer(admin)).send({ reason: 'x' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await p().userPermissionOverride.count({ where: { userId: t1Id } })).toBe(0);
  });

  it('switched off: progress and homework refused for that teacher only — even with a delegation; audited once; the test switch untouched', async () => {
    const off = (await http().put(SWITCH(t1Id)).set(bearer(admin)).send({ allowed: false, reason: 'Handed in for the wrong class' }).expect(200)).body;
    expect(off).toMatchObject({ userId: t1Id, allowed: false, reason: 'Handed in for the wrong class', revokedBy: { id: ctx.ids.admin } });
    // Idempotent: switching off again changes nothing.
    await http().put(SWITCH(t1Id)).set(bearer(admin)).send({ allowed: false, reason: 'Again' }).expect(200);
    const denies = await p().userPermissionOverride.findMany({ where: { userId: t1Id, effect: 'DENY', revokedAt: null }, orderBy: { permission: 'asc' } });
    expect(denies.map((d) => d.permission)).toEqual(['students.viewProgress', 'submissions.submitOnBehalf']);
    const audits = await p().auditLog.findMany({ where: { action: 'TEACHER_HOMEWORK_SUBMISSION_REVOKED', entityId: t1Id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN', entity: 'User' });
    expect(audits[0].metadata).toMatchObject({
      permissions: ['students.viewProgress', 'submissions.submitOnBehalf'], overrideIds: expect.arrayContaining(denies.map((d) => d.id)),
      reason: 'Handed in for the wrong class', previous: { allowed: true }, next: { allowed: false },
    });

    // The teacher, on the next request: refused in plain words, nothing saved; still signed in and still sees the students.
    for (const s of [ctx.ids.studentJunior, studentB]) {
      const r = await progress(t1, s);
      expect([r.status, r.body.code, r.body.message]).toEqual([403, 'PERMISSION_REQUIRED', 'You do not have permission to do this. If you need it, ask an administrator.']);
      expect(await status(submitFor(t1, s))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
    expect(await mine(t1)).not.toEqual(expect.arrayContaining(['students.viewProgress']));
    expect(await mine(t1)).not.toContain('submissions.submitOnBehalf');
    expect(await mine(t1)).toContain('tests.submitForStudents');
    expect((await listed(t1))[ctx.ids.studentJunior].can).toEqual({ viewProfile: false, viewProgress: false, submitOnBehalf: false });
    expect((await http().get(`/api/v1/admin/teachers/${t1Id}/test-submission`).set(bearer(admin)).expect(200)).body.allowed).toBe(true);

    // A delegation of the same permissions (still grantable) does not bring them back while the switch is off.
    await http().post(`/api/v1/admin/teachers/${t1Id}/delegations`).set(bearer(admin)).send({ permission: 'students.viewProgress', reason: 'Coordinator duties' }).expect(201);
    await http().post(`/api/v1/admin/teachers/${t1Id}/delegations`).set(bearer(admin)).send({ permission: 'submissions.submitOnBehalf', reason: 'Coordinator duties' }).expect(201);
    expect(await status(progress(t1, ctx.ids.studentJunior))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(submitFor(t1, ctx.ids.studentJunior))).toEqual([403, 'PERMISSION_REQUIRED']);

    // Another teacher is not affected: HW2 sees student B (their school's) and hands homework in for them.
    expect((await http().get(SWITCH(t2Id)).set(bearer(admin)).expect(200)).body.allowed).toBe(true);
    await progress(t2, studentB).expect(200);
    expect((await submitFor(t2, studentB).expect(201)).body.submittedBy).toMatchObject({ id: t2Id });
  });

  it('switched on again: allowed at once; audited; every DENY of the switch lifted', async () => {
    const on = (await http().put(SWITCH(t1Id)).set(bearer(admin)).send({ allowed: true }).expect(200)).body;
    expect(on).toEqual({ userId: t1Id, allowed: true, revokedAt: null, reason: null, revokedBy: null });
    await http().put(SWITCH(t1Id)).set(bearer(admin)).send({ allowed: true }).expect(200);   // idempotent
    expect(await p().userPermissionOverride.count({ where: { userId: t1Id, effect: 'DENY', revokedAt: null } })).toBe(0);
    const restored = await p().auditLog.findMany({ where: { action: 'TEACHER_HOMEWORK_SUBMISSION_RESTORED', entityId: t1Id } });
    expect(restored).toHaveLength(1);
    expect(restored[0].metadata).toMatchObject({ permissions: ['students.viewProgress', 'submissions.submitOnBehalf'], previous: { allowed: false }, next: { allowed: true } });
    await progress(t1, ctx.ids.studentJunior).expect(200);
    await progress(t1, studentB).expect(200);
    expect((await submitFor(t1, ctx.ids.studentJunior).expect(201)).body).toMatchObject({ studentId: ctx.ids.studentJunior, revisionCount: 1, submittedBy: { id: t1Id } });
    expect(await status(progress(t1, studentC))).toEqual([404, 'NOT_FOUND']);
  });

  it('a Super Admin DENY of one of the two shows the switch off; switching on lifts it', async () => {
    await http().post(`/api/v1/admin/users/${t1Id}/permission-overrides`).set(bearer(superAdmin))
      .send({ permission: 'submissions.submitOnBehalf', effect: 'DENY', reason: 'Super Admin check' }).expect(201);
    expect((await http().get(SWITCH(t1Id)).set(bearer(admin)).expect(200)).body).toMatchObject({ allowed: false, reason: 'Super Admin check' });
    await progress(t1, ctx.ids.studentJunior).expect(200);   // only the denied one is refused
    expect(await status(submitFor(t1, ctx.ids.studentJunior))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().put(SWITCH(t1Id)).set(bearer(admin)).send({ allowed: true, reason: 'Checked' }).expect(200);
    await submitFor(t1, ctx.ids.studentJunior).expect(201);
  });
});
