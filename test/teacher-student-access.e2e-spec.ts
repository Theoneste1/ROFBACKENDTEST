/**
 * Teacher–student access (owner approvals TS-1…TS-6, 2026-11-18).
 *
 * Fixtures: "Test School" (A) with verified students student.j, student.j2, student.s and one PENDING student
 * (tsa.pending); school B with verified students tsa.o and tsa.o2. Teachers: T1 and T2 at A, T3 at B, T4 without a
 * school. Coach mentor.j and student student.j sign in to prove they are refused.
 */
import { BulkOperationsWorker } from '../src/users/bulk/bulk-operations.worker.js';
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

describe('Teacher–student access (TS-1…TS-6)', () => {
  let ctx: TestContext;
  let admin: string, t1: string, t2: string, t3: string, coach: string, student: string;
  let t1Id: string, t2Id: string, t3Id: string, t4Id: string, schoolA: string, schoolB: string;
  let pendingId: string, oId: string, o2Id: string, workId: string;
  let worker: BulkOperationsWorker;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const TS = '/api/v1/admin/teacher-students';
  const delegations = (id: string) => `/api/v1/admin/teachers/${id}/delegations`;
  const assign = (body: object) => http().post(TS).set(bearer(admin)).send(body);
  const outcomes = (res: any) => Object.fromEntries(res.body.results.map((r: any) => [r.studentId, [r.outcome, r.code ?? null]]));
  const notices = (teacherId: string) => p().notificationOutbox.count({ where: { type: 'teacher.students.assigned', recipientUserId: teacherId } });
  let keyN = 0;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    worker = ctx.app.get(BulkOperationsWorker);
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    schoolA = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    schoolB = (await p().school.create({ data: { name: 'TSA School B', location: 'Huye' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'STUDENT', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Tsa', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const claim = (studentId: string, schoolId: string, st: 'VERIFIED' | 'PENDING') => p().studentSchoolAffiliation.create({ data: {
      studentId, schoolId, status: st, source: st === 'VERIFIED' ? 'ADMIN' : 'REGISTRATION', createdById: ctx.ids.admin,
      ...(st === 'VERIFIED' && { decidedById: ctx.ids.admin, decidedAt: new Date() }),
    } });
    t1Id = await mk('tsa.t1', 'TEACHER');
    t2Id = await mk('tsa.t2', 'TEACHER');
    t3Id = await mk('tsa.t3', 'TEACHER');
    t4Id = await mk('tsa.t4', 'TEACHER');
    const junior = { gradeLevel: 'S2' as const, divisionId: ctx.ids.junior };
    pendingId = await mk('tsa.pending', 'STUDENT', { ...junior, schoolId: schoolA, homeLocation: 'Huye' });
    oId = await mk('tsa.o', 'STUDENT', { ...junior, schoolId: schoolB, homeLocation: 'Huye' });
    o2Id = await mk('tsa.o2', 'STUDENT', { ...junior, schoolId: schoolB, homeLocation: 'Huye' });
    for (const s of [ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior]) await claim(s, schoolA, 'VERIFIED');
    await claim(pendingId, schoolA, 'PENDING');
    await claim(oId, schoolB, 'VERIFIED');
    await claim(o2Id, schoolB, 'VERIFIED');
    for (const [teacherId, schoolId] of [[t1Id, schoolA], [t2Id, schoolA], [t3Id, schoolB]]) {
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId }).expect(201);
    }
    [t1, t2, t3] = await Promise.all(['tsa.t1', 'tsa.t2', 'tsa.t3'].map((u) => login(ctx, u)));
    workId = (await p().assignment.create({ data: {
      title: 'TSA work', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(), allowResubmission: true, maxResubmissions: 3,
    } })).id;
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('TS-1: a teacher sees verified students of their schools only; pending ones only as a number', async () => {
    const list = await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200);
    const ids = list.body.data.map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior]));
    expect(ids).not.toContain(pendingId);
    expect(ids).not.toContain(oId);
    expect(list.body.data[0]).toMatchObject({ access: { school: true, assigned: false }, can: { viewProfile: false, viewProgress: false, submitOnBehalf: false } });
    const sum = await http().get('/api/v1/teacher/students/summary').set(bearer(t1)).expect(200);
    expect(sum.body).toEqual({ schools: 1, students: 3, viaSchool: 3, viaAssignment: 0, pendingVerification: 1 });
    expect(JSON.stringify(sum.body)).not.toContain('tsa.pending');
    // Other roles: the summary is the teacher's (the service answers 403 for anyone else).
    expect((await status(http().get('/api/v1/teacher/students/summary').set(bearer(admin))))[0]).toBe(403);
  });

  it('only Administrators manage assignments and school access', async () => {
    for (const token of [t1, coach, student]) {
      expect(await status(http().post(TS).set(bearer(token)).send({ teacherId: t1Id, studentIds: [oId] }))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(http().get(`/api/v1/admin/schools/${schoolA}/access`).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
    expect((await status(http().get(TS)))[0]).toBe(401);
    expect(await status(assign({ teacherId: ctx.ids.mentorJunior, studentIds: [oId] }))).toEqual([400, 'NOT_A_TEACHER']);
    expect(await status(assign({ teacherId: t1Id, studentIds: [] }))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('TS-3: a student of another school needs a reason; the teacher then sees that student only (not the school)', async () => {
    const refused = await assign({ teacherId: t1Id, studentIds: [oId, ctx.ids.mentorJunior] }).expect(200);
    expect(outcomes(refused)).toEqual({ [oId]: ['FAILED', 'REASON_REQUIRED'], [ctx.ids.mentorJunior]: ['FAILED', 'NOT_A_STUDENT'] });
    expect(await p().teacherStudentAssignment.count({ where: { teacherId: t1Id } })).toBe(0);
    expect(await notices(t1Id)).toBe(0);

    const ok = await assign({ teacherId: t1Id, studentIds: [oId], reason: 'Olympiad camp group' }).expect(200);
    expect(outcomes(ok)).toEqual({ [oId]: ['ASSIGNED', null] });
    const row = await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t1Id, studentId: oId } });
    expect(row).toMatchObject({ isActive: true, crossSchool: true, reason: 'Olympiad camp group', source: 'ADMIN', assignedById: ctx.ids.admin });
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'TEACHER_STUDENT_ASSIGNED', entityId: row.id } })).metadata)
      .toMatchObject({ teacherId: t1Id, studentId: oId, crossSchool: true, reason: 'Olympiad camp group', from: null, to: 'ACTIVE' });

    const list = await http().get('/api/v1/teacher/students').query({ access: 'ASSIGNED' }).set(bearer(t1)).expect(200);
    expect(list.body.data.map((s: any) => [s.id, s.access])).toEqual([[oId, { school: false, assigned: true }]]);
    const all = (await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200)).body.data.map((s: any) => s.id);
    expect(all).toContain(oId);
    expect(all).not.toContain(o2Id);   // the rest of school B stays hidden
  });

  it('TS-6 / TS-2: the teacher is told once, never the student; duplicates are skipped; several teachers per student', async () => {
    expect(await notices(t1Id)).toBe(1);
    expect(await p().notificationOutbox.count({ where: { recipientUserId: oId } })).toBe(0);
    const again = await assign({ teacherId: t1Id, studentIds: [oId], reason: 'Olympiad camp group' }).expect(200);
    expect(outcomes(again)).toEqual({ [oId]: ['SKIPPED', 'ALREADY_ASSIGNED'] });
    expect(await notices(t1Id)).toBe(1);
    expect(await p().teacherStudentAssignment.count({ where: { teacherId: t1Id, studentId: oId } })).toBe(1);

    await assign({ teacherId: t2Id, studentIds: [oId], reason: 'Second mentor teacher' }).expect(200);
    expect(await p().teacherStudentAssignment.count({ where: { studentId: oId, isActive: true } })).toBe(2);
    const notice = await p().notificationOutbox.findFirstOrThrow({ where: { type: 'teacher.students.assigned', recipientUserId: t2Id } });
    expect(notice.payload).toMatchObject({ count: 1 });
    expect(JSON.stringify(notice.payload)).not.toContain('tsa.o');
  });

  it('TS-4: delegation scopes — assigned students only, selected students only, the whole school (existing default)', async () => {
    const assigned = await http().post(delegations(t1Id)).set(bearer(admin))
      .send({ permission: 'submissions.submitOnBehalf', reason: 'Camp submissions', studentScope: 'ASSIGNED' }).expect(201);
    expect(assigned.body).toMatchObject({ studentScope: 'ASSIGNED', students: [] });
    t1 = await login(ctx, 'tsa.t1');   // the new GRANT is read at sign-in by the guard
    const submitFor = (studentId: string) => http().post(`/api/v1/teacher/students/${studentId}/submissions`).set(bearer(t1))
      .field('assignmentId', workId).attach('file', PDF, 'work.pdf');
    expect((await submitFor(oId)).status).toBe(201);
    expect(await status(submitFor(ctx.ids.studentJunior))).toEqual([403, 'DELEGATION_NOT_FOR_STUDENT']);

    // SELECTED: only listed students the teacher sees.
    expect(await status(http().post(delegations(t1Id)).set(bearer(admin))
      .send({ permission: 'students.viewProfile', reason: 'Selected', studentScope: 'SELECTED', studentIds: [o2Id] }))).toEqual([400, 'STUDENT_NOT_IN_TEACHER_SCOPE']);
    expect(await status(http().post(delegations(t1Id)).set(bearer(admin))
      .send({ permission: 'students.viewProfile', reason: 'Selected', studentScope: 'SELECTED' }))).toEqual([400, 'VALIDATION_FAILED']);
    const sel = await http().post(delegations(t1Id)).set(bearer(admin))
      .send({ permission: 'students.viewProfile', reason: 'Selected', studentScope: 'SELECTED', studentIds: [ctx.ids.studentJunior] }).expect(201);
    expect(sel.body.students.map((s: any) => s.studentId)).toEqual([ctx.ids.studentJunior]);
    t1 = await login(ctx, 'tsa.t1');
    await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(t1)).expect(200);
    expect(await status(http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior2}`).set(bearer(t1)))).toEqual([403, 'DELEGATION_NOT_FOR_STUDENT']);
    expect(await status(http().get(`/api/v1/teacher/students/${o2Id}`).set(bearer(t1)))).toEqual([404, 'NOT_FOUND']);

    const list = await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200);
    const can = Object.fromEntries(list.body.data.map((s: any) => [s.id, s.can]));
    expect(can[oId]).toMatchObject({ submitOnBehalf: true, viewProfile: false });
    expect(can[ctx.ids.studentJunior]).toMatchObject({ submitOnBehalf: false, viewProfile: true });

    // The existing form (no scope) is the whole school, as before.
    const school = await http().post(delegations(t2Id)).set(bearer(admin)).send({ permission: 'students.viewProgress', reason: 'Coordinator' }).expect(201);
    expect(school.body.studentScope).toBe('SCHOOL');
    t2 = await login(ctx, 'tsa.t2');
    await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior2}/progress`).set(bearer(t2)).expect(200);
    expect(await status(http().get(`/api/v1/teacher/students/${oId}/progress`).set(bearer(t2)))).toEqual([403, 'DELEGATION_NOT_FOR_STUDENT']);
  });

  it('TS-5: ending an assignment takes the student off selected-student delegations, flags them; nothing is deleted', async () => {
    const sel = await http().post(delegations(t1Id)).set(bearer(admin))
      .send({ permission: 'students.viewProgress', reason: 'Camp progress', studentScope: 'SELECTED', studentIds: [oId] }).expect(201);
    const row = await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t1Id, studentId: oId } });

    const ended = await http().delete(`${TS}/${row.id}`).set(bearer(admin)).expect(200);
    expect(ended.body).toMatchObject({ id: row.id, isActive: false, endReason: 'ADMIN', endedBy: { id: ctx.ids.admin } });
    expect(await status(http().delete(`${TS}/${row.id}`).set(bearer(admin)))).toEqual([409, 'ASSIGNMENT_ENDED']);

    const after = await p().userPermissionOverride.findUniqueOrThrow({ where: { id: sel.body.id }, include: { students: true } });
    expect(after.revokedAt).toBeNull();
    expect(after.reviewReason).toBe('STUDENT_LEFT_SCOPE');
    expect(after.students).toEqual([expect.objectContaining({ studentId: oId, removeReason: 'ASSIGNMENT_ENDED' })]);
    expect(after.students[0].removedAt).not.toBeNull();
    t1 = await login(ctx, 'tsa.t1');
    expect(await status(http().get(`/api/v1/teacher/students/${oId}/progress`).set(bearer(t1)))).toEqual([404, 'NOT_FOUND']);

    // The Administrator sees it on the School Access page of the teacher's school and marks it reviewed.
    const access = await http().get(`/api/v1/admin/schools/${schoolA}/access`).set(bearer(admin)).expect(200);
    expect(access.body.attention.delegationsNeedingReview).toEqual([
      { teacherId: t1Id, overrideId: sel.body.id, permission: 'students.viewProgress', reviewReason: 'STUDENT_LEFT_SCOPE' },
    ]);
    await http().post(`${delegations(t1Id)}/${sel.body.id}/reviewed`).set(bearer(admin)).expect(200);
    expect(await status(http().post(`${delegations(t1Id)}/${sel.body.id}/reviewed`).set(bearer(admin)))).toEqual([409, 'NO_REVIEW_NEEDED']);

    // Re-assigning re-activates the same row (history kept, no duplicate).
    const back = await assign({ teacherId: t1Id, studentIds: [oId], reason: 'Back in the camp group' }).expect(200);
    expect(back.body.results[0]).toMatchObject({ outcome: 'REACTIVATED', id: row.id });
    // The student can be listed again on the delegation; the removed row is re-activated.
    const add = await http().post(`${delegations(t1Id)}/${sel.body.id}/students`).set(bearer(admin)).send({ studentIds: [oId, o2Id] }).expect(200);
    expect(outcomes(add)).toEqual({ [oId]: ['ADDED', null], [o2Id]: ['FAILED', 'STUDENT_NOT_IN_TEACHER_SCOPE'] });
    await http().delete(`${delegations(t1Id)}/${sel.body.id}/students/${oId}`).set(bearer(admin)).expect(200);
    await http().delete(`${delegations(t1Id)}/${sel.body.id}/students/${oId}`).set(bearer(admin)).expect(404);
    expect(await p().userPermissionOverrideStudent.count({ where: { overrideId: sel.body.id } })).toBe(1);
  });

  it('reassign: the old assignment ends and the new one starts together, or nothing changes for that student', async () => {
    const res = await http().post(`${TS}/reassign`).set(bearer(admin)).send({ fromTeacherId: t2Id, toTeacherId: t3Id, studentIds: [oId, ctx.ids.studentJunior] }).expect(200);
    expect(outcomes(res)).toEqual({ [oId]: ['ASSIGNED', null], [ctx.ids.studentJunior]: ['FAILED', 'NOT_ASSIGNED'] });
    expect(await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t2Id, studentId: oId } })).toMatchObject({ isActive: false, endReason: 'REASSIGNED' });
    expect(await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t3Id, studentId: oId } })).toMatchObject({ isActive: true, crossSchool: false });
    expect(await status(http().post(`${TS}/reassign`).set(bearer(admin)).send({ fromTeacherId: t3Id, toTeacherId: t3Id, studentIds: [oId] }))).toEqual([400, 'SAME_TEACHER']);
    // A refused new assignment leaves the old one: tsa.pending is not T4's verified student and no reason is given.
    await assign({ teacherId: t1Id, studentIds: [pendingId], reason: 'Pending claim, camp group' }).expect(200);
    const kept = await http().post(`${TS}/reassign`).set(bearer(admin)).send({ fromTeacherId: t1Id, toTeacherId: t4Id, studentIds: [pendingId] }).expect(200);
    expect(outcomes(kept)).toEqual({ [pendingId]: ['FAILED', 'REASON_REQUIRED'] });
    expect((await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t1Id, studentId: pendingId } })).isActive).toBe(true);
  });

  it('School Access: teachers with their access, counts, and students with their teachers — never contact data', async () => {
    const access = await http().get(`/api/v1/admin/schools/${schoolA}/access`).set(bearer(admin)).expect(200);
    expect(access.body.counts).toEqual({ verifiedStudents: 3, pendingStudents: 1, verifiedWithoutTeacher: 3 });
    expect(access.body.teachers.map((t: any) => t.teacher.id).sort()).toEqual([t1Id, t2Id].sort());
    const t1Row = access.body.teachers.find((t: any) => t.teacher.id === t1Id);
    expect(t1Row.delegations.map((d: any) => [d.permission, d.studentScope]).sort()).toEqual([
      ['students.viewProfile', 'SELECTED'], ['students.viewProgress', 'SELECTED'], ['submissions.submitOnBehalf', 'ASSIGNED'],
    ]);

    const pending = await http().get(`/api/v1/admin/schools/${schoolA}/access/students`).query({ verification: 'PENDING' }).set(bearer(admin)).expect(200);
    expect(pending.body.data.map((s: any) => [s.id, s.claim.status, s.teachers.map((t: any) => t.id)])).toEqual([[pendingId, 'PENDING', [t1Id]]]);
    const unassigned = await http().get(`/api/v1/admin/schools/${schoolA}/access/students`).query({ assigned: false }).set(bearer(admin)).expect(200);
    expect(unassigned.body.data.map((s: any) => s.id).sort()).toEqual([ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior].sort());
    const text = JSON.stringify([access.body, pending.body, unassigned.body]);
    expect(text).not.toMatch(/@test\.local|phone|guardian|dateOfBirth/i);
    await http().get('/api/v1/admin/schools/00000000-0000-4000-8000-000000000000/access').set(bearer(admin)).expect(404);

    const listed = await http().get(TS).query({ teacherId: t1Id, isActive: true }).set(bearer(admin)).expect(200);
    expect(listed.body.data.map((a: any) => a.student.id).sort()).toEqual([oId, pendingId].sort());
  });

  it('bulk: assign, give a permission for selected students, take it back — per-student results, one notice per operation', async () => {
    const preview = (body: object) => http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send(body);
    const run = async (action: string, ids: string[], params: object, reason?: string) => {
      const pv = await preview({ action, selection: { mode: 'ids', ids }, params }).expect(200);
      const res = await http().post('/api/v1/admin/users/bulk').set(bearer(admin)).send({
        action, selection: { mode: 'ids', ids }, params, selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total,
        confirm: true, idempotencyKey: `tsa-${++keyN}-${Date.now()}`, ...(reason && { reason }),
      }).expect(202);
      while ((await worker.processBatch()) > 0) { /* drain */ }
      const items = await p().bulkOperationItem.findMany({ where: { operationId: res.body.operation.id } });
      return { pv, opId: res.body.operation.id as string, by: Object.fromEntries(items.map((i) => [i.userId, [i.outcome, i.code]])) };
    };
    expect(await status(preview({ action: 'assignTeacher', selection: { mode: 'ids', ids: [ctx.ids.studentJunior2] }, params: {} }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(preview({ action: 'assignTeacher', selection: { mode: 'ids', ids: [ctx.ids.studentJunior2] }, params: { teacherId: ctx.ids.mentorJunior } }))).toEqual([400, 'NOT_A_TEACHER']);

    const before = await notices(t2Id);
    const a = await run('assignTeacher', [ctx.ids.studentJunior2, ctx.ids.studentSenior, ctx.ids.mentorJunior], { teacherId: t2Id });
    expect(a.pv.body.warnings.map((w: any) => w.code)).toContain('NOT_STUDENTS');
    expect(a.by).toEqual({
      [ctx.ids.studentJunior2]: ['SUCCEEDED', null], [ctx.ids.studentSenior]: ['SUCCEEDED', null], [ctx.ids.mentorJunior]: ['SKIPPED', 'NOT_A_STUDENT'],
    });
    expect(await notices(t2Id)).toBe(before + 1);   // one notice for the whole operation
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'TEACHER_STUDENT_ASSIGNED', metadata: { path: ['operationId'], equals: a.opId } } })).metadata).toMatchObject({ source: 'BULK' });

    const g = await run('grantDelegation', [ctx.ids.studentJunior2, o2Id], { teacherId: t2Id, permission: 'students.viewProfile' }, 'Bulk profile access');
    expect(g.by).toEqual({ [ctx.ids.studentJunior2]: ['SUCCEEDED', null], [o2Id]: ['FAILED', 'STUDENT_NOT_IN_TEACHER_SCOPE'] });
    const ov = await p().userPermissionOverride.findFirstOrThrow({ where: { userId: t2Id, permission: 'students.viewProfile', studentScope: 'SELECTED', revokedAt: null }, include: { students: true } });
    expect(ov.students.map((s) => s.studentId)).toEqual([ctx.ids.studentJunior2]);
    t2 = await login(ctx, 'tsa.t2');
    await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior2}`).set(bearer(t2)).expect(200);

    const r = await run('revokeDelegation', [ctx.ids.studentJunior2, ctx.ids.studentSenior], { teacherId: t2Id, permission: 'students.viewProfile' });
    expect(r.by).toEqual({ [ctx.ids.studentJunior2]: ['SUCCEEDED', null], [ctx.ids.studentSenior]: ['SKIPPED', 'NOT_APPLICABLE'] });
    expect(await status(http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior2}`).set(bearer(t2)))).toEqual([403, 'DELEGATION_NOT_FOR_STUDENT']);

    const u = await run('unassignTeacher', [ctx.ids.studentJunior2, oId], { teacherId: t2Id });
    expect(u.by).toEqual({ [ctx.ids.studentJunior2]: ['SUCCEEDED', null], [oId]: ['SKIPPED', 'ASSIGNMENT_ENDED'] });
  });

  it('a delegation written without a scope (an older release, e.g. during the deploy) is school-wide and blocks an identical SCHOOL grant', async () => {
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: t4Id, schoolId: schoolA }).expect(201);
    await p().userPermissionOverride.create({ data: { userId: t4Id, permission: 'students.viewProfile', effect: 'GRANT', reason: 'Older release', createdById: ctx.ids.admin } });
    const t4 = await login(ctx, 'tsa.t4');
    await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(t4)).expect(200);
    expect(await status(http().post(delegations(t4Id)).set(bearer(admin))
      .send({ permission: 'students.viewProfile', reason: 'Again', studentScope: 'SCHOOL' }))).toEqual([409, 'OVERRIDE_EXISTS']);
    // Other overrides never carry a student scope (database rule).
    await expect(p().userPermissionOverride.create({ data: { userId: t4Id, permission: 'users.view', effect: 'DENY', reason: 'x', studentScope: 'SCHOOL' } }))
      .rejects.toThrow(/UserPermissionOverride_student_scope/);
  });

  it('a role change ends the person\'s assignments (kept as history)', async () => {
    expect(await p().teacherStudentAssignment.count({ where: { teacherId: t3Id, isActive: true } })).toBe(1);
    await http().patch(`/api/v1/admin/users/${t3Id}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    expect(await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t3Id, studentId: oId } })).toMatchObject({ isActive: false, endReason: 'ROLE_CHANGE' });
  });
});
