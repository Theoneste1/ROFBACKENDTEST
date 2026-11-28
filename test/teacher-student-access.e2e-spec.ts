/**
 * Teacher–student access (owner approvals TS-1…TS-6, 2026-11-18).
 *
 * Fixtures: "Test School" (A) with verified students student.j, student.j2, student.s and one PENDING student
 * (tsa.pending); school B with verified students tsa.o and tsa.o2. Teachers: T1 and T2 at A, T3 at B, T4 without a
 * school. Coach mentor.j and student student.j sign in to prove they are refused.
 */
import { BulkOperationsWorker } from '../src/users/bulk/bulk-operations.worker.js';
import { AuditService } from '../src/audit/audit.service.js';
import { assignStudentInTx, dropStaleSelections } from '../src/teachers/teacher-student-ops.js';
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

describe('Teacher–student access (TS-1…TS-6)', () => {
  let ctx: TestContext;
  let admin: string, t1: string, t2: string, t3: string, coach: string, student: string;
  let t1Id: string, t2Id: string, t3Id: string, t4Id: string, schoolA: string, schoolB: string;
  let pendingId: string, notMemberId: string, oId: string, o2Id: string, workId: string;
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
    const claim = (studentId: string, schoolId: string, st: 'VERIFIED' | 'PENDING' | 'REJECTED') => p().studentSchoolAffiliation.create({ data: {
      studentId, schoolId, status: st, source: st !== 'PENDING' ? 'ADMIN' : 'REGISTRATION', createdById: ctx.ids.admin,
      ...(st !== 'PENDING' && { decidedById: ctx.ids.admin, decidedAt: new Date() }),
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
    // Owner 2026-11-21: a PENDING claim makes a student of the school; a REJECTED one never does — this student is
    // outside every teacher's school (the cross-school cases below).
    notMemberId = await mk('tsa.notmember', 'STUDENT', { ...junior, schoolId: schoolA, homeLocation: 'Huye' });
    await claim(notMemberId, schoolA, 'REJECTED');
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

  it('TS-1 (owner 2026-11-21): a teacher sees the students of their schools — verified and pending claims — never a rejected claim or another school; the summary counts those ROF has not verified yet', async () => {
    const list = await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200);
    const ids = list.body.data.map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior, pendingId]));
    expect(ids).not.toContain(notMemberId);
    // Each row carries the student's profile picture link (owner 2026-11-27); /users/:id/avatar decides who sees it.
    expect(list.body.data.every((s: any) => 'avatarUrl' in s)).toBe(true);
    expect(ids).not.toContain(oId);
    expect(list.body.data[0]).toMatchObject({ access: { school: true, assigned: false }, can: { viewProfile: false, viewProgress: false, submitOnBehalf: false } });
    const sum = await http().get('/api/v1/teacher/students/summary').set(bearer(t1)).expect(200);
    expect(sum.body).toEqual({ schools: 1, students: 4, viaSchool: 4, viaAssignment: 0, pendingVerification: 1 });
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
    // A refused new assignment leaves the old one: tsa.notmember (rejected claim) is not T4's student and no reason is given.
    await assign({ teacherId: t1Id, studentIds: [notMemberId], reason: 'Rejected claim, camp group' }).expect(200);
    const kept = await http().post(`${TS}/reassign`).set(bearer(admin)).send({ fromTeacherId: t1Id, toTeacherId: t4Id, studentIds: [notMemberId] }).expect(200);
    expect(outcomes(kept)).toEqual({ [notMemberId]: ['FAILED', 'REASON_REQUIRED'] });
    expect((await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t1Id, studentId: notMemberId } })).isActive).toBe(true);
  });

  it('SR-2: a student outside the teacher\'s schools (here a REJECTED claim) is assigned only with a reason, audited; the teacher sees that one student, other teachers of the school do not', async () => {
    // No reason → refused (not a student of T2's school).
    expect(outcomes(await assign({ teacherId: t2Id, studentIds: [notMemberId] }).expect(200))).toEqual({ [notMemberId]: ['FAILED', 'REASON_REQUIRED'] });
    const row = await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t1Id, studentId: notMemberId } });
    expect(row).toMatchObject({ isActive: true, crossSchool: true, reason: 'Rejected claim, camp group', assignedById: ctx.ids.admin });
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'TEACHER_STUDENT_ASSIGNED', entityId: row.id } })).metadata)
      .toMatchObject({ teacherId: t1Id, studentId: notMemberId, crossSchool: true, reason: 'Rejected claim, camp group' });
    const t1List = (await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200)).body.data;
    expect(t1List.find((s: any) => s.id === notMemberId)).toMatchObject({ access: { school: false, assigned: true } });
    expect((await http().get('/api/v1/teacher/students').query({ access: 'SCHOOL' }).set(bearer(t1)).expect(200)).body.data.map((s: any) => s.id)).not.toContain(notMemberId);
    expect((await http().get('/api/v1/teacher/students').set(bearer(t2)).expect(200)).body.data.map((s: any) => s.id)).not.toContain(notMemberId);
    // A PENDING claim, by contrast, is a student of the school: every teacher of it sees them, without any assignment.
    for (const t of [t1, t2]) {
      expect((await http().get('/api/v1/teacher/students').query({ access: 'SCHOOL' }).set(bearer(t)).expect(200)).body.data.map((s: any) => s.id)).toContain(pendingId);
    }
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
    expect(pending.body.data.map((s: any) => [s.id, s.claim.status, s.teachers.map((t: any) => t.id)])).toEqual([[pendingId, 'PENDING', []]]);
    const unassigned = await http().get(`/api/v1/admin/schools/${schoolA}/access/students`).query({ assigned: false }).set(bearer(admin)).expect(200);
    expect(unassigned.body.data.map((s: any) => s.id).sort()).toEqual([ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior, pendingId].sort());
    const text = JSON.stringify([access.body, pending.body, unassigned.body]);
    expect(text).not.toMatch(/@test\.local|phone|guardian|dateOfBirth/i);
    await http().get('/api/v1/admin/schools/00000000-0000-4000-8000-000000000000/access').set(bearer(admin)).expect(404);

    const listed = await http().get(TS).query({ teacherId: t1Id, isActive: true }).set(bearer(admin)).expect(200);
    expect(listed.body.data.map((a: any) => a.student.id).sort()).toEqual([oId, notMemberId].sort());
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

  it('review fixes: a lost school link ends same-school access and takes students off selected permissions (claim revoked, teacher school ended); a bulk grant for an unseen student creates nothing', async () => {
    // Fixtures: school C, teacher T6 at C, students C1 and C2 verified at C.
    const schoolC = (await p().school.create({ data: { name: 'TSA School C', location: 'Huye' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'STUDENT', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Tsa', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const t6Id = await mk('tsa.t6', 'TEACHER');
    const [c1, c2] = [await mk('tsa.c1', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolC, homeLocation: 'Huye' }),
      await mk('tsa.c2', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolC, homeLocation: 'Huye' })];
    const claims: Record<string, string> = {};
    for (const s of [c1, c2]) {
      claims[s] = (await p().studentSchoolAffiliation.create({ data: {
        studentId: s, schoolId: schoolC, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date(),
      } })).id;
    }
    const tsa = await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: t6Id, schoolId: schoolC }).expect(201);
    expect(outcomes(await assign({ teacherId: t6Id, studentIds: [c1] }).expect(200))).toEqual({ [c1]: ['ASSIGNED', null] });   // same school: no reason
    const sel = await http().post(delegations(t6Id)).set(bearer(admin))
      .send({ permission: 'students.viewProfile', reason: 'Selected pair', studentScope: 'SELECTED', studentIds: [c1, c2] }).expect(201);
    let t6 = await login(ctx, 'tsa.t6');
    await http().get(`/api/v1/teacher/students/${c2}`).set(bearer(t6)).expect(200);

    // C2's verified claim is revoked → C2 leaves T6's selected permission (flagged), and T6 no longer sees C2.
    await http().post(`/api/v1/admin/school-affiliations/${claims[c2]}/revoke`).set(bearer(admin)).send({ reason: 'Not a student of this school' })
      .expect((r) => { if (r.status >= 300) throw new Error(`revoke ${r.status} ${JSON.stringify(r.body)}`); });
    const afterRevoke = await p().userPermissionOverrideStudent.findFirstOrThrow({ where: { overrideId: sel.body.id, studentId: c2 } });
    expect(afterRevoke).toMatchObject({ removeReason: 'SCHOOL_CLAIM_CHANGED' });
    expect(afterRevoke.removedAt).not.toBeNull();
    expect((await p().userPermissionOverride.findUniqueOrThrow({ where: { id: sel.body.id } })).reviewReason).toBe('STUDENT_LEFT_SCOPE');
    t6 = await login(ctx, 'tsa.t6');
    expect(await status(http().get(`/api/v1/teacher/students/${c2}`).set(bearer(t6)))).toEqual([404, 'NOT_FOUND']);

    // T6's school assignment ends → the same-school assignment of C1 gives nothing any more (no reason was given, TS-3),
    // C1 leaves the selected permission; the assignment row stays (history).
    await http().delete(`/api/v1/admin/teacher-assignments/${tsa.body.id}`).set(bearer(admin)).expect(200);
    t6 = await login(ctx, 'tsa.t6');
    expect(await status(http().get(`/api/v1/teacher/students/${c1}`).set(bearer(t6)))).toEqual([404, 'NOT_FOUND']);
    expect((await http().get('/api/v1/teacher/students').set(bearer(t6)).expect(200)).body.data).toEqual([]);
    expect(await p().userPermissionOverrideStudent.findFirstOrThrow({ where: { overrideId: sel.body.id, studentId: c1 } }))
      .toMatchObject({ removeReason: 'SCHOOL_ASSIGNMENT_ENDED' });
    expect((await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t6Id, studentId: c1 } })).isActive).toBe(true);

    // A bulk grant for a student the teacher does not see creates no delegation and sends no notice.
    const before = await p().notificationOutbox.count({ where: { recipientUserId: t6Id, type: 'permissions.granted' } });
    const params = { teacherId: t6Id, permission: 'students.viewProgress' };
    const pv = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send({ action: 'grantDelegation', selection: { mode: 'ids', ids: [c1] }, params }).expect(200);
    const run = await http().post('/api/v1/admin/users/bulk').set(bearer(admin)).send({
      action: 'grantDelegation', selection: { mode: 'ids', ids: [c1] }, params, selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total,
      confirm: true, idempotencyKey: `tsa-l2-${Date.now()}`, reason: 'Bulk grant check',
    }).expect(202);
    while ((await worker.processBatch()) > 0) { /* drain */ }
    expect(await p().bulkOperationItem.findFirstOrThrow({ where: { operationId: run.body.operation.id } })).toMatchObject({ outcome: 'FAILED', code: 'STUDENT_NOT_IN_TEACHER_SCOPE' });
    expect(await p().userPermissionOverride.count({ where: { userId: t6Id, permission: 'students.viewProgress' } })).toBe(0);
    expect(await p().notificationOutbox.count({ where: { recipientUserId: t6Id, type: 'permissions.granted' } })).toBe(before);
  });

  it('SR-1: a SUSPENDED, DEACTIVATED or ARCHIVED student is hidden from the teacher on every path (school and cross-school assignment); Administrators still see them; reactivation restores access', async () => {
    // Fixtures: school D with teacher T7; D1 a verified student of D; E1 a verified student of school E assigned to T7 cross-school.
    const [schoolD, schoolE] = [(await p().school.create({ data: { name: 'TSA School D', location: 'Huye' } })).id,
      (await p().school.create({ data: { name: 'TSA School E', location: 'Huye' } })).id];
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'STUDENT', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Tsa', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const t7Id = await mk('tsa.t7', 'TEACHER');
    const d1 = await mk('tsa.d1', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolD, homeLocation: 'Huye' });
    const e1 = await mk('tsa.e1', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolE, homeLocation: 'Huye' });
    for (const [s, school] of [[d1, schoolD], [e1, schoolE]]) {
      await p().studentSchoolAffiliation.create({ data: { studentId: s, schoolId: school, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } });
    }
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: t7Id, schoolId: schoolD }).expect(201);
    expect(outcomes(await assign({ teacherId: t7Id, studentIds: [e1], reason: 'Camp group, other school' }).expect(200))).toEqual({ [e1]: ['ASSIGNED', null] });
    await http().post(delegations(t7Id)).set(bearer(admin)).send({ permission: 'students.viewProfile', reason: 'School profiles', studentScope: 'SCHOOL' }).expect(201);
    await http().post(delegations(t7Id)).set(bearer(admin)).send({ permission: 'students.viewProgress', reason: 'Assigned progress', studentScope: 'ASSIGNED' }).expect(201);
    const sel = await http().post(delegations(t7Id)).set(bearer(admin))
      .send({ permission: 'submissions.submitOnBehalf', reason: 'Selected submissions', studentScope: 'SELECTED', studentIds: [d1, e1] }).expect(201);
    const t7 = await login(ctx, 'tsa.t7');
    const submitFor = (studentId: string) => http().post(`/api/v1/teacher/students/${studentId}/submissions`).set(bearer(t7))
      .field('assignmentId', workId).attach('file', PDF, 'work.pdf');
    const listed = async (q: object = {}) => (await http().get('/api/v1/teacher/students').query(q).set(bearer(t7)).expect(200)).body.data.map((s: any) => s.id).sort();
    const setStatus = (id: string, toStatus: string) => http().post(`/api/v1/admin/users/${id}/status-changes`).set(bearer(admin))
      .send({ toStatus, reason: 'SR-1 regression check', ...(toStatus === 'ACTIVE' && { confirm: true }) })
      .expect((r) => { if (r.status >= 300) throw new Error(`status ${toStatus} ${r.status} ${JSON.stringify(r.body)}`); });
    const visible = async () => {
      expect(await listed()).toEqual([d1, e1].sort());
      expect(await listed({ access: 'SCHOOL' })).toEqual([d1]);
      expect(await listed({ access: 'ASSIGNED' })).toEqual([e1]);
      expect((await http().get('/api/v1/teacher/students/summary').set(bearer(t7)).expect(200)).body).toMatchObject({ students: 2, viaSchool: 1, viaAssignment: 1 });
      await http().get(`/api/v1/teacher/students/${d1}`).set(bearer(t7)).expect(200);
      await http().get(`/api/v1/teacher/students/${e1}/progress`).set(bearer(t7)).expect(200);
    };
    await visible();
    expect((await submitFor(d1)).status).toBe(201);

    for (const state of ['SUSPENDED', 'DEACTIVATED', 'ARCHIVED']) {
      for (const s of [d1, e1]) await setStatus(s, state);
      // Teacher: list (every filter), summary, profile, progress, submit on behalf — both the school and the cross-school student.
      expect(await listed()).toEqual([]);
      expect(await listed({ access: 'SCHOOL' })).toEqual([]);
      expect(await listed({ access: 'ASSIGNED' })).toEqual([]);
      expect((await http().get('/api/v1/teacher/students/summary').set(bearer(t7)).expect(200)).body).toMatchObject({ students: 0, viaSchool: 0, viaAssignment: 0 });
      for (const s of [d1, e1]) {
        expect([state, await status(http().get(`/api/v1/teacher/students/${s}`).set(bearer(t7)))]).toEqual([state, [404, 'NOT_FOUND']]);
        expect([state, await status(http().get(`/api/v1/teacher/students/${s}/progress`).set(bearer(t7)))]).toEqual([state, [404, 'NOT_FOUND']]);
        expect([state, await status(submitFor(s))]).toEqual([state, [404, 'NOT_FOUND']]);
      }
      // A delegation cannot newly cover them, and a bulk grant creates nothing.
      expect(await status(http().post(delegations(t7Id)).set(bearer(admin))
        .send({ permission: 'students.viewProgress', reason: 'Selected', studentScope: 'SELECTED', studentIds: [d1] }))).toEqual([400, 'STUDENT_NOT_IN_TEACHER_SCOPE']);
      // Administrators still see and manage them; the assignment and the selections stay (hidden is not out of scope).
      expect((await http().get(`/api/v1/admin/users/${d1}`).set(bearer(admin)).expect(200)).body.accountStatus).toBe(state);
      const access = await http().get(`/api/v1/admin/schools/${schoolD}/access/students`).set(bearer(admin)).expect(200);
      expect(access.body.data.map((s: any) => s.id)).toContain(d1);
      expect((await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: t7Id, studentId: e1 } })).isActive).toBe(true);
      expect(await p().userPermissionOverrideStudent.count({ where: { overrideId: sel.body.id, removedAt: null } })).toBe(2);
      if (state === 'SUSPENDED') {
        // A scope sweep while they are hidden (T7's second school ends) must not drop their selections: hidden ≠ left scope.
        const schoolF = (await p().school.create({ data: { name: 'TSA School F', location: 'Huye' } })).id;
        const f = await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: t7Id, schoolId: schoolF }).expect(201);
        await http().delete(`/api/v1/admin/teacher-assignments/${f.body.id}`).set(bearer(admin)).expect(200);
        expect(await p().userPermissionOverrideStudent.count({ where: { overrideId: sel.body.id, removedAt: null } })).toBe(2);
      }
      for (const s of [d1, e1]) await setStatus(s, 'ACTIVE');
      await visible();
    }
    expect((await p().userPermissionOverride.findUniqueOrThrow({ where: { id: sel.body.id } })).reviewReason).toBeNull();
    expect((await submitFor(e1)).status).toBe(201);
  });

  describe('final review (2026-11-18): races, existing tokens, claim revocation, role re-check', () => {
    let schoolR: string, tR: string, r0: string, r1: string, selId: string;
    const claimsR: Record<string, string> = {};
    const mkUser = async (username: string, role: 'TEACHER' | 'STUDENT', extra: object = {}) => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      return (await p().user.create({ data: { username, firstName: username, lastName: 'Rv', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    };
    beforeAll(async () => {
      schoolR = (await p().school.create({ data: { name: 'TSA School R', location: 'Huye' } })).id;
      tR = await mkUser('tsa.tr', 'TEACHER');
      const st = { gradeLevel: 'S2' as const, divisionId: ctx.ids.junior, schoolId: schoolR, homeLocation: 'Huye' };
      [r0, r1] = [await mkUser('tsa.r0', 'STUDENT', st), await mkUser('tsa.r1', 'STUDENT', st)];
      for (const s of [r0, r1]) claimsR[s] = (await p().studentSchoolAffiliation.create({ data: { studentId: s, schoolId: schoolR, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } })).id;
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: tR, schoolId: schoolR }).expect(201);
      selId = (await http().post(delegations(tR)).set(bearer(admin))
        .send({ permission: 'students.viewProfile', reason: 'Selected pair', studentScope: 'SELECTED', studentIds: [r0] }).expect(201)).body.id;
    });

    it('a student added to a selected delegation while their claim is being revoked never stays listed (the add waits, then is refused)', async () => {
      const audit = ctx.app.get(AuditService);
      let settled = false;
      let addRes: any;
      await p().$transaction(async (tx) => {
        // The revoke: claim changed and the TS-5 sweep run, not yet committed (it holds the selection lock).
        await tx.studentSchoolAffiliation.update({ where: { id: claimsR[r1] }, data: { status: 'REVOKED', revokedAt: new Date() } });
        await dropStaleSelections(tx, audit, { studentId: r1 }, { actorId: ctx.ids.admin, actorRole: 'ADMIN' }, 'SCHOOL_CLAIM_CHANGED');
        // Meanwhile an Administrator adds r1 to the delegation (another connection).
        addRes = http().post(`${delegations(tR)}/${selId}/students`).set(bearer(admin)).send({ studentIds: [r1] }).then((r) => { settled = true; return r; });
        await new Promise((r) => setTimeout(r, 1500));
        expect(settled).toBe(false);   // it waits for the revoke instead of reading the old, still-committed claim
      }, { timeout: 30_000 });
      const res = await addRes;
      expect(outcomes(res)).toEqual({ [r1]: ['FAILED', 'STUDENT_NOT_IN_TEACHER_SCOPE'] });
      expect(await p().userPermissionOverrideStudent.count({ where: { overrideId: selId, studentId: r1 } })).toBe(0);
    });

    it('revoking a delegation and ending access apply to a token issued before (no new sign-in)', async () => {
      const token = await login(ctx, 'tsa.tr');
      await http().get(`/api/v1/teacher/students/${r0}`).set(bearer(token)).expect(200);
      await http().delete(`${delegations(tR)}/${selId}`).set(bearer(admin)).expect(200);
      expect(await status(http().get(`/api/v1/teacher/students/${r0}`).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
      // A school-wide grant on the same token works at once, and so does the end of the teacher's school.
      const g = await http().post(delegations(tR)).set(bearer(admin)).send({ permission: 'students.viewProfile', reason: 'School-wide', studentScope: 'SCHOOL' }).expect(201);
      await http().get(`/api/v1/teacher/students/${r0}`).set(bearer(token)).expect(200);
      expect(g.body.studentScope).toBe('SCHOOL');
    });

    it('a same-school assignment made without a reason stops counting when the student\'s verified claim is revoked', async () => {
      const token = await login(ctx, 'tsa.tr');
      expect(outcomes(await assign({ teacherId: tR, studentIds: [r0] }).expect(200))).toEqual({ [r0]: ['ASSIGNED', null] });
      const assigned = async () => (await http().get('/api/v1/teacher/students').query({ access: 'ASSIGNED' }).set(bearer(token)).expect(200)).body.data.map((s: any) => s.id);
      expect(await assigned()).toEqual([r0]);
      await http().post(`/api/v1/admin/school-affiliations/${claimsR[r0]}/revoke`).set(bearer(admin)).send({ reason: 'Left the school' })
        .expect((r) => { if (r.status >= 300) throw new Error(`revoke ${r.status} ${JSON.stringify(r.body)}`); });
      expect(await assigned()).toEqual([]);
      expect(await status(http().get(`/api/v1/teacher/students/${r0}`).set(bearer(token)))).toEqual([404, 'NOT_FOUND']);
      expect((await p().teacherStudentAssignment.findFirstOrThrow({ where: { teacherId: tR, studentId: r0 } })).isActive).toBe(true);   // history kept
    });

    it('an assignment re-checks both roles inside its transaction (a role change committed in between is seen)', async () => {
      const t9 = await mkUser('tsa.t9', 'TEACHER');
      await p().user.update({ where: { id: t9 }, data: { role: 'MENTOR' } });   // the role change committed before the item's transaction
      const audit = ctx.app.get(AuditService);
      const r = await p().$transaction((tx) => assignStudentInTx(tx, audit, {
        teacherId: t9, studentId: r1, actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' }, source: 'ADMIN', reason: 'Role re-check',
      }));
      expect(r).toMatchObject({ outcome: 'FAILED', code: 'NOT_A_TEACHER' });
      expect(await p().teacherStudentAssignment.count({ where: { teacherId: t9 } })).toBe(0);
    });
  });

  describe('student profile pictures (owner decision 2026-11-18): the student, Administrators, and teachers who may view the profile', () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    let pupil: string, classmate: string, teacherP: string, teacherQ: string, headCoach: string;
    let pupilId: string, teacherPId: string, schoolP: string;
    const picture = (id: string, token?: string) => { const r = http().get(`/api/v1/users/${id}/avatar`); return token ? r.set(bearer(token)) : r; };

    beforeAll(async () => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const mk = async (username: string, role: 'TEACHER' | 'STUDENT' | 'HEAD_COACH', extra: object = {}) =>
        (await p().user.create({ data: { username, firstName: username, lastName: 'Pic', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
      schoolP = (await p().school.create({ data: { name: 'TSA School P', location: 'Huye' } })).id;
      const st = { gradeLevel: 'S2' as const, divisionId: ctx.ids.junior, schoolId: schoolP, homeLocation: 'Huye', dateOfBirth: new Date('2011-01-01T00:00:00Z') };
      pupilId = await mk('pic.pupil', 'STUDENT', st);
      await mk('pic.classmate', 'STUDENT', st);
      teacherPId = await mk('pic.tp', 'TEACHER');
      await mk('pic.tq', 'TEACHER');
      await mk('pic.hc', 'HEAD_COACH');
      await p().studentSchoolAffiliation.create({ data: { studentId: pupilId, schoolId: schoolP, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } });
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: teacherPId, schoolId: schoolP }).expect(201);
      [pupil, classmate, teacherP, teacherQ, headCoach] = await Promise.all(['pic.pupil', 'pic.classmate', 'pic.tp', 'pic.tq', 'pic.hc'].map((u) => login(ctx, u)));
      await http().put('/api/v1/me/avatar').set(bearer(pupil)).attach('file', PNG, 'me.png').expect(200);
      await http().put('/api/v1/me/avatar').set(bearer(coach)).attach('file', PNG, 'me.png').expect(200);   // a staff picture
    });

    it('the student and Administrators see it (never cached); signed out is 401', async () => {
      for (const token of [pupil, admin]) {
        const r = await picture(pupilId, token).expect(200);
        expect(r.headers['cache-control']).toBe('private, no-store');
        expect(r.headers['content-type']).toMatch(/^image\/png/);
      }
      await picture(pupilId).expect(401);
    });

    it('owner 2026-11-22: everyone who may view the student\'s profile sees it — a classmate, the coach of the student\'s division, the teacher of the student\'s school (no delegation needed); others get 404, the same answer as "no picture"', async () => {
      for (const token of [classmate, coach, teacherP]) await picture(pupilId, token).expect(200);
      const noPicture = await picture(ctx.ids.studentSenior, admin).expect(404);   // an account without a picture
      for (const token of [headCoach, teacherQ]) {   // no programme or taught division in common; another school
        const r = await picture(pupilId, token).expect(404);
        expect(r.body.message).toBe(noPicture.body.message);
      }
    });

    it('a suspended student\'s picture: hidden from other students and from the school\'s teacher again; Administrators still see it', async () => {
      await http().post(`/api/v1/admin/users/${pupilId}/status-changes`).set(bearer(admin)).send({ toStatus: 'SUSPENDED', reason: 'Picture visibility check' })
        .expect((r) => { if (r.status >= 300) throw new Error(`suspend ${r.status}`); });
      await picture(pupilId, classmate).expect(404);
      await picture(pupilId, teacherP).expect(404);
      await picture(pupilId, admin).expect(200);
      await http().post(`/api/v1/admin/users/${pupilId}/status-changes`).set(bearer(admin)).send({ toStatus: 'ACTIVE', reason: 'Picture visibility check' })
        .expect((r) => { if (r.status >= 300) throw new Error(`reactivate ${r.status}`); });
      await picture(pupilId, classmate).expect(200);
      await picture(pupilId, teacherP).expect(200);
    });

    it("owner 2026-11-27: a Coach's picture follows the Coach's profile (users.manage, or themself): Administrators see it, never cached; a classmate and a Teacher get 404", async () => {
      const r = await picture(ctx.ids.mentorJunior, admin).expect(200);
      expect(r.headers['cache-control']).toBe('private, no-store');
      for (const token of [classmate, teacherQ]) {
        const refused = await picture(ctx.ids.mentorJunior, token).expect(404);
        expect(refused.body.message).toBe('This account has no profile picture.');
      }
    });

    it("a Head Coach's picture follows the Head Coach's profile: Administrators see it; a student and a Teacher get 404", async () => {
      await http().put('/api/v1/me/avatar').set(bearer(headCoach)).attach('file', PNG, 'me.png').expect(200);
      const hcId = (await p().user.findUniqueOrThrow({ where: { username: 'pic.hc' } })).id;
      const r = await picture(hcId, admin).expect(200);
      expect(r.headers['cache-control']).toBe('private, no-store');
      for (const token of [classmate, teacherQ]) await picture(hcId, token).expect(404);
    });

    it("other accounts are unchanged: a Teacher's picture — any signed-in user, cacheable", async () => {
      await http().put('/api/v1/me/avatar').set(bearer(teacherQ)).attach('file', PNG, 'me.png').expect(200);
      const tqId = (await p().user.findUniqueOrThrow({ where: { username: 'pic.tq' } })).id;
      for (const token of [classmate, headCoach]) {
        const r = await picture(tqId, token).expect(200);
        expect(r.headers['cache-control']).toBe('private, max-age=86400');
      }
    });
  });
});
