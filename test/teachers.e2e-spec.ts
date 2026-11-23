/**
 * P1-11 — Teachers (owner decisions 2026-11-10): school-based scope, individual
 * delegations granted by Administrators or Super Admins, and submission on a
 * student's behalf with the student as owner.
 *
 * Fixtures: the seed's "Test School" (students student.j, student.j2, student.s);
 * a second school with student O; teacher T1 (Test School), T2 (Other School),
 * T3 (no school); a published Algebra × Junior assignment with a published result
 * for student.j.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildOpenApiDocument } from '../src/openapi.js';
import { createTestApp, login, bearer, inDays, PDF, PASSWORD, type TestContext } from './helpers.js';

describe('Teachers (P1-11)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, t1: string, t2: string, t3: string, coachJ: string, studentJ2: string;
  let t1Id: string, t2Id: string, t3Id: string, schoolA: string, schoolB: string, studentO: string;
  let workId: string, gradedId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const ASSIGN = '/api/v1/admin/teacher-assignments';
  const delegations = (id: string) => `/api/v1/admin/teachers/${id}/delegations`;
  const grant = (token: string, teacherId: string, permission: string) =>
    http().post(delegations(teacherId)).set(bearer(token)).send({ permission, reason: 'School coordinator duties' });
  /** Fixture: the student's school membership verified by an Administrator (school administration PR A). */
  const verifiedAt = (studentId: string, schoolId: string) => p().studentSchoolAffiliation.create({ data: {
    studentId, schoolId, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date(),
  } });
  const submitFor = (token: string, studentId: string, assignmentId: string) =>
    http().post(`/api/v1/teacher/students/${studentId}/submissions`).set(bearer(token)).field('assignmentId', assignmentId).attach('file', PDF, 'work.pdf');

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coachJ = await login(ctx, 'mentor.j');
    studentJ2 = await login(ctx, 'student.j2');
    schoolA = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    schoolB = (await p().school.create({ data: { name: 'Other School', location: 'Huye' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'STUDENT' | 'SUPER_ADMIN', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    t1Id = await mk('t.one', 'TEACHER');
    t2Id = await mk('t.two', 'TEACHER');
    t3Id = await mk('t.three', 'TEACHER');
    await mk('t.super', 'SUPER_ADMIN');
    studentO = await mk('student.o', 'STUDENT', { gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolB, homeLocation: 'Huye' });
    // Every fixture student's membership is verified, so each test's own condition is the only reason a student is hidden.
    for (const s of [ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior]) await verifiedAt(s, schoolA);
    await verifiedAt(studentO, schoolB);
    [t1, t2, t3, superAdmin] = await Promise.all(['t.one', 't.two', 't.three', 't.super'].map((u) => login(ctx, u)));

    workId = (await p().assignment.create({ data: {
      title: 'Teacher-visible work', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(), allowResubmission: true, maxResubmissions: 3,
    } })).id;
    // A graded, published result for student.j (must never reach a teacher, D7).
    gradedId = (await p().assignment.create({ data: {
      title: 'Graded work', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
    } })).id;
    const s = await p().submission.create({ data: { assignmentId: gradedId, studentId: ctx.ids.studentJunior, status: 'PUBLISHED', submittedAt: new Date(), publishedAt: new Date() } });
    await p().submissionRevision.create({ data: { submissionId: s.id, revisionNumber: 1, submittedById: ctx.ids.studentJunior } });
    const r = await p().mentorReview.create({ data: {
      submissionId: s.id, mentorId: ctx.ids.mentorJunior, cycle: 1, status: 'APPROVED', score: 7, percentage: 70,
      feedback: 'SECRET-FEEDBACK', assignedAt: new Date(), returnedAt: new Date(),
    } });
    await p().submission.update({ where: { id: s.id }, data: { publishedReviewId: r.id } });
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('school assignments: only Administrators manage them (audited); only Teachers can hold one', async () => {
    for (const token of [t1, coachJ, studentJ2]) {
      expect(await status(http().post(ASSIGN).set(bearer(token)).send({ teacherId: t1Id, schoolId: schoolA }))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
    expect(await status(http().post(ASSIGN).set(bearer(admin)).send({ teacherId: ctx.ids.mentorJunior, schoolId: schoolA }))).toEqual([400, 'NOT_A_TEACHER']);
    const a = await http().post(ASSIGN).set(bearer(admin)).send({ teacherId: t1Id, schoolId: schoolA }).expect(201);
    expect(a.body).toMatchObject({ isActive: true, teacher: { id: t1Id }, school: { id: schoolA } });
    expect(await status(http().post(ASSIGN).set(bearer(admin)).send({ teacherId: t1Id, schoolId: schoolA }))).toEqual([409, 'ALREADY_ASSIGNED']);
    await http().post(ASSIGN).set(bearer(superAdmin)).send({ teacherId: t2Id, schoolId: schoolB }).expect(201);
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'ASSIGN_TEACHER_SCHOOL', entityId: a.body.id } }))
      .toMatchObject({ actorId: ctx.ids.admin, metadata: { teacherId: t1Id, schoolId: schoolA } });
  });

  it('teachers of a school (INT-07, the school page): filtered by school and state; names only, never contact details; Administrators only', async () => {
    const bySchool = await http().get(ASSIGN).query({ schoolId: schoolA }).set(bearer(admin)).expect(200);
    expect(bySchool.body.data.map((r: any) => r.teacher.id)).toEqual([t1Id]);
    expect(Object.keys(bySchool.body.data[0].teacher).sort()).toEqual(['firstName', 'id', 'lastName', 'username']);
    expect(JSON.stringify(bySchool.body)).not.toMatch(/email|phone/i);
    expect((await http().get(ASSIGN).query({ schoolId: schoolB, isActive: true }).set(bearer(superAdmin)).expect(200)).body.data.map((r: any) => r.teacher.id)).toEqual([t2Id]);
    expect((await http().get(ASSIGN).query({ schoolId: schoolA, isActive: false }).set(bearer(admin)).expect(200)).body.data).toEqual([]);
    for (const token of [coachJ, studentJ2, t1]) expect(await status(http().get(ASSIGN).query({ schoolId: schoolA }).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('school isolation: a Teacher lists only students of their schools, without contact details; other schools 404; other roles refused', async () => {
    // Access follows the School relationship (schoolId), not a name: a school with a similar name stays invisible.
    const lookalike = (await p().school.create({ data: { name: 'Test School Branch', location: 'Kigali' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const branchStudent = (await p().user.create({ data: {
      username: 'student.branch', firstName: 'B', lastName: 'S', email: 'student.branch@test.local', role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: lookalike,
    } })).id;
    await verifiedAt(branchStudent, lookalike);

    // Not yet approved by an Administrator (the school check): never shown to a teacher (P1-11).
    const pending = (await p().user.create({ data: {
      username: 'student.pending', firstName: 'P', lastName: 'S', email: 'student.pending@test.local', role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), isApproved: false, gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolA,
    } })).id;
    await verifiedAt(pending, schoolA);   // verified membership: approval is the only missing condition

    const mine = (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(t1)).expect(200)).body.data;
    expect(mine.map((s: any) => s.id).sort()).toEqual([ctx.ids.studentJunior, ctx.ids.studentJunior2, ctx.ids.studentSenior].sort());
    expect(mine.map((s: any) => s.id)).not.toContain(branchStudent);
    expect(mine.map((s: any) => s.id)).not.toContain(pending);
    // The default list exposes exactly: name, username, grade, division, school — plus (teacher–student access) how the
    // teacher sees the student and what their permissions let them do. Never contact details.
    for (const s of mine) expect(Object.keys(s).sort()).toEqual(['access', 'can', 'division', 'firstName', 'gradeLevel', 'id', 'lastName', 'school', 'username']);
    for (const s of mine) expect(Object.keys(s.access).sort()).toEqual(['assigned', 'school']);
    for (const s of mine) expect(Object.keys(s.can).sort()).toEqual(['submitOnBehalf', 'viewProfile', 'viewProgress']);

    // Every registered student of the school counts — no programme, course or enrolment condition.
    expect(await p().programmeMembership.count({ where: { userId: studentO } })).toBe(0);
    expect(await p().studentEnrollment.count({ where: { studentId: studentO } })).toBe(0);
    expect(await p().courseEnrollment.count({ where: { studentId: studentO } })).toBe(0);
    expect((await http().get('/api/v1/teacher/students').set(bearer(t2)).expect(200)).body.data.map((s: any) => s.id)).toEqual([studentO]);
    expect((await http().get('/api/v1/teacher/students').set(bearer(t3)).expect(200)).body.data).toEqual([]);
    expect((await http().get('/api/v1/teacher/students').query({ schoolId: schoolB }).set(bearer(t1))).status).toBe(404);
    // Administrators use the admin user API; Coaches and Students have no access.
    expect(await status(http().get('/api/v1/teacher/students').set(bearer(admin)))).toEqual([403, 'ROLE_NOT_SUPPORTED']);
    for (const token of [coachJ, studentJ2]) expect(await status(http().get('/api/v1/teacher/students').set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('API documentation: the four Teacher student routes name exactly TEACHER, the school-assignment rule and the delegation', async () => {
    // Access lines come from the running app; route summaries from the generated document (build plugin, JSDoc).
    const doc = buildOpenApiDocument(ctx.app);
    const generated = JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'api', 'openapi.json'), 'utf8'));
    const op = (path: string, method: string) => (doc.paths[path] as any)[method];
    const routes: Array<[string, string, string, boolean]> = [
      ['/api/v1/teacher/students', 'get', 'students.viewScoped', false],
      ['/api/v1/teacher/students/{id}', 'get', 'students.viewProfile', true],
      // Changed on purpose — owner decision 2026-11-23 (confirmed 2026-11-24): course homework progress and handing in
      // are Teacher defaults now, documented as such (no longer "granted individually").
      ['/api/v1/teacher/students/{id}/progress', 'get', 'students.viewProgress', false],
      ['/api/v1/teacher/students/{id}/submissions', 'post', 'submissions.submitOnBehalf', false],
    ];
    for (const [path, method, permission, delegated] of routes) {
      const o = op(path, method);
      expect([path, o['x-roles'], o['x-permission']]).toEqual([path, ['TEACHER'], permission]);
      const summary: string = generated.paths[path][method].summary ?? '';
      expect([path, /assigned schools|assigned to you/.test(summary)]).toEqual([path, true]);
      expect(generated.paths[path][method]['x-roles']).toEqual(['TEACHER']);
      if (delegated) expect([path, o.description]).toEqual([path, expect.stringContaining('granted individually by an Administrator or Super Admin')]);
      if (permission === 'students.viewProgress' || permission === 'submissions.submitOnBehalf') {
        expect([path, o.description]).toEqual([path, expect.stringContaining('every Teacher by default (an Administrator switches course homework off per teacher)')]);
      }
    }
  });

  it('without a delegation a Teacher cannot view profiles; course homework progress and handing in are Teacher defaults (owner 2026-11-24)', async () => {
    expect(await status(http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(t1)))).toEqual([403, 'PERMISSION_REQUIRED']);
    // Changed on purpose — owner decision 2026-11-23 (confirmed 2026-11-24): teachers see their students' homework progress
    // and hand homework in for them by default, like tests (was: 403 PERMISSION_REQUIRED without a delegation). Still only
    // for the students they see: another school's student is not found, nothing written.
    await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}/progress`).set(bearer(t1)).expect(200);
    expect(await status(http().get(`/api/v1/teacher/students/${studentO}/progress`).set(bearer(t1)))).toEqual([404, 'NOT_FOUND']);
    expect(await status(submitFor(t1, studentO, workId))).toEqual([404, 'NOT_FOUND']);
    expect(await p().submission.count({ where: { assignmentId: workId } })).toBe(0);
  });

  it('2026-11-14: a Teacher holds no course access — /me/permissions lists only the school-scoped student list and the leaderboard; course routes stay refused', async () => {
    // + tests.submitForStudents (Test Management Phase 2, G2): a test-answer default for verified students of their schools — still no course access; + tests.viewSchoolResults (Phase 4: published results of their schools' students).
    // + students.viewProgress, submissions.submitOnBehalf: changed on purpose — owner decision 2026-11-24, course homework for their students by default (still no course access).
    expect((await http().get('/api/v1/me/permissions').set(bearer(t1)).expect(200)).body.permissions).toEqual([
      'leaderboard.view', 'students.viewScoped', 'students.viewProgress', 'submissions.submitOnBehalf', 'tests.submitForStudents', 'tests.viewSchoolResults',
    ]);
    // The one route gated by courses.view (the programme list) now refuses at the permission check; the
    // signed-in course and discussion routes were already refused by their services (the grants were dead).
    expect(await status(http().get('/api/v1/programmes').set(bearer(t1)))).toEqual([403, 'PERMISSION_REQUIRED']);
    for (const [path, refused] of [['/api/v1/courses', 403], [`/api/v1/courses/${ctx.ids.algebra}/resources`, 403], [`/api/v1/courses/${ctx.ids.algebra}/threads`, 404]] as const) {
      expect([path, (await http().get(path).set(bearer(t1))).status]).toEqual([path, refused]);
    }
    // The teacher portal itself still works.
    await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200);
    // assignments.prepare can no longer be granted to a Teacher (removed from the approved list).
    expect(await status(http().post(`/api/v1/admin/users/${t1Id}/permission-overrides`).set(bearer(superAdmin))
      .send({ permission: 'assignments.prepare', effect: 'GRANT', reason: 'draft help', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }))).toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
  });

  it('delegations: Administrators and Super Admins grant only the three teacher delegations, only to Teachers with a school; nobody grants themselves', async () => {
    // Teachers (and other non-administrators) cannot grant anything — not even to themselves.
    expect(await status(grant(t1, t1Id, 'students.viewProfile'))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().post(`/api/v1/admin/users/${t1Id}/permission-overrides`).set(bearer(t1))
      .send({ permission: 'students.viewProfile', effect: 'GRANT', reason: 'self grant' }))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(grant(coachJ, t1Id, 'students.viewProfile'))).toEqual([403, 'PERMISSION_REQUIRED']);
    // Not a delegation (validation), not a Teacher, no school, own account.
    expect((await grant(admin, t1Id, 'users.manageStudents')).status).toBe(400);
    expect((await grant(admin, t1Id, 'reviews.grade')).status).toBe(400);
    expect(await status(grant(admin, ctx.ids.mentorJunior, 'students.viewProfile'))).toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
    expect(await status(grant(admin, t3Id, 'students.viewProfile'))).toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
    expect(await status(grant(admin, ctx.ids.admin, 'students.viewProfile'))).toEqual([403, 'OVERRIDE_NOT_ALLOWED']);
    expect(await p().userPermissionOverride.count()).toBe(0);

    const g = await grant(admin, t1Id, 'students.viewProfile').expect(201);
    expect(g.body).toMatchObject({ permission: 'students.viewProfile', effect: 'GRANT', courseId: null, divisionId: null, active: true });
    expect(await status(grant(admin, t1Id, 'students.viewProfile'))).toEqual([409, 'OVERRIDE_EXISTS']);
    await grant(superAdmin, t1Id, 'students.viewProgress').expect(201);
    await grant(admin, t1Id, 'submissions.submitOnBehalf').expect(201);
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'PERMISSION_OVERRIDE_CREATE', entityId: g.body.id } }))
      .toMatchObject({ actorId: ctx.ids.admin, metadata: { targetUserId: t1Id, permission: 'students.viewProfile', effect: 'GRANT', scope: 'SCHOOL', via: 'TEACHER_DELEGATION' } });
    const listed = (await http().get(delegations(t1Id)).set(bearer(admin)).expect(200)).body.map((o: any) => o.permission).sort();
    expect(listed).toEqual(['students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf']);
    expect((await http().get('/api/v1/me/permissions').set(bearer(t1)).expect(200)).body.permissions)
      .toEqual(expect.arrayContaining(['students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf']));
  });

  it('profile: own-school students only, no contact details; another school 404 even with the delegation', async () => {
    const res = (await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(t1)).expect(200)).body;
    expect(res).toMatchObject({ id: ctx.ids.studentJunior, school: { id: schoolA }, gradeLevel: 'S2', account: { isActive: true } });
    for (const key of ['email', 'phone', 'homeLocation', 'passwordHash']) expect([key, key in res]).toEqual([key, false]);
    expect((await http().get(`/api/v1/teacher/students/${studentO}`).set(bearer(t1))).status).toBe(404);
    expect((await http().get(`/api/v1/teacher/students/${ctx.ids.mentorJunior}`).set(bearer(t1))).status).toBe(404);
    // An unapproved student of the teacher's own school: not revealed.
    const pending = await p().user.findUniqueOrThrow({ where: { username: 'student.pending' } });
    expect((await http().get(`/api/v1/teacher/students/${pending.id}`).set(bearer(t1))).status).toBe(404);
  });

  it('unverified students (e-mail not activated) of the teacher\'s own school: not listed; profile, progress and submit all 404', async () => {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const unverified = (await p().user.create({ data: {
      username: 'student.unverified', firstName: 'U', lastName: 'V', email: 'student.unverified@test.local', role: 'STUDENT', passwordHash: hash,
      activatedAt: null, isApproved: true, gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolA,
    } })).id;
    await verifiedAt(unverified, schoolA);   // verified membership: e-mail activation is the only missing condition
    const listed = (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(t1)).expect(200)).body.data.map((s: any) => s.id);
    expect(listed).not.toContain(unverified);
    expect(listed).toContain(ctx.ids.studentJunior);   // activated students of the same school still are
    expect((await http().get(`/api/v1/teacher/students/${unverified}`).set(bearer(t1))).status).toBe(404);
    expect((await http().get(`/api/v1/teacher/students/${unverified}/progress`).set(bearer(t1))).status).toBe(404);
    expect((await submitFor(t1, unverified, workId)).status).toBe(404);
    expect(await p().submission.count({ where: { studentId: unverified } })).toBe(0);
    // Once activated, the same student is visible.
    await p().user.update({ where: { id: unverified }, data: { activatedAt: new Date() } });
    expect((await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(t1)).expect(200)).body.data.map((s: any) => s.id)).toContain(unverified);
    await p().user.update({ where: { id: unverified }, data: { activatedAt: null } });
  });

  it('progress: assignment availability and submission history — never scores, marks or feedback (D7)', async () => {
    const res = (await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}/progress`).set(bearer(t1)).expect(200)).body;
    const graded = res.assignments.find((a: any) => a.id === gradedId);
    expect(graded.submission).toMatchObject({ status: 'PUBLISHED', attempts: [{ revisionNumber: 1, submittedBy: { id: ctx.ids.studentJunior } }] });
    expect(res.assignments.find((a: any) => a.id === workId)).toMatchObject({ submission: null });
    const text = JSON.stringify(res);
    for (const leak of ['SECRET-FEEDBACK', '"score"', '"percentage"', '"pointsAwarded"', 'mentorFeedback']) expect([leak, text.includes(leak)]).toEqual([leak, false]);
    expect((await http().get(`/api/v1/teacher/students/${studentO}/progress`).set(bearer(t1))).status).toBe(404);
  });

  it('submit on behalf: the student owns the submission; the teacher is recorded as submitter, uploader and audit actor', async () => {
    const res = await submitFor(t1, ctx.ids.studentJunior2, workId).expect(201);
    expect(res.body).toMatchObject({ studentId: ctx.ids.studentJunior2, assignmentId: workId, status: 'SUBMITTED', submittedBy: { id: t1Id, role: 'TEACHER' } });
    const sub = await p().submission.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { revisions: { include: { attachments: { include: { file: true } } } } },
    });
    expect(sub.studentId).toBe(ctx.ids.studentJunior2);
    expect(sub.revisions).toHaveLength(1);
    expect(sub.revisions[0].submittedById).toBe(t1Id);
    expect(sub.revisions[0].attachments).toHaveLength(1);
    expect(sub.revisions[0].attachments[0].file.uploadedById).toBe(t1Id);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'SUBMIT_ASSIGNMENT', entityId: sub.id } });
    expect(audit).toMatchObject({
      actorId: t1Id, actorRole: 'TEACHER',
      metadata: { assignmentId: workId, onBehalfOf: ctx.ids.studentJunior2, studentId: ctx.ids.studentJunior2, fileIds: [sub.revisions[0].attachments[0].fileId] },
    });
    expect(audit.createdAt).toBeInstanceOf(Date);

    // The student sees it as their own work; a resubmission on their behalf is a new attempt by the teacher.
    const mine = (await http().get('/api/v1/me/submissions').set(bearer(studentJ2)).expect(200)).body.data.map((s: any) => s.id);
    expect(mine).toContain(sub.id);
    await submitFor(t1, ctx.ids.studentJunior2, workId).expect(201);
    const revisions = await p().submissionRevision.findMany({ where: { submissionId: sub.id }, orderBy: { revisionNumber: 'asc' } });
    expect(revisions.map((r) => r.submittedById)).toEqual([t1Id, t1Id]);
    expect(await p().auditLog.count({ where: { action: 'RESUBMIT_ASSIGNMENT', entityId: sub.id, actorId: t1Id } })).toBe(1);

    // Another school's student: 404, nothing written. Normal assignment rules still apply (a Senior student: 404).
    expect((await submitFor(t1, studentO, workId)).status).toBe(404);
    expect((await submitFor(t1, ctx.ids.studentSenior, workId)).status).toBe(404);
    expect(await p().submission.count({ where: { assignmentId: workId } })).toBe(1);
  });

  it('submit on behalf honours the student\'s own permission: denied while submissions.submit is DENYed for the student, allowed once the DENY is revoked', async () => {
    const deny = await http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/permission-overrides`).set(bearer(superAdmin))
      .send({ permission: 'submissions.submit', effect: 'DENY', reason: 'Submission suspended for this student' }).expect(201);
    expect(await status(submitFor(t1, ctx.ids.studentJunior, workId))).toEqual([403, 'STUDENT_SUBMISSION_DENIED']);
    expect(await p().submission.count({ where: { studentId: ctx.ids.studentJunior, assignmentId: workId } })).toBe(0);
    expect(await p().auditLog.count({ where: { action: 'SUBMIT_ASSIGNMENT', metadata: { path: ['onBehalfOf'], equals: ctx.ids.studentJunior } } })).toBe(0);
    // The student is refused on their own route too — the same rule.
    const studentJ = await login(ctx, 'student.j');
    expect(await status(http().post('/api/v1/submissions').set(bearer(studentJ)).field('assignmentId', workId).attach('file', PDF, 'own.pdf'))).toEqual([403, 'PERMISSION_REQUIRED']);

    await http().delete(`/api/v1/admin/users/${ctx.ids.studentJunior}/permission-overrides/${deny.body.id}`).set(bearer(superAdmin)).expect(200);
    const ok = await submitFor(t1, ctx.ids.studentJunior, workId).expect(201);
    expect(ok.body).toMatchObject({ studentId: ctx.ids.studentJunior, submittedBy: { id: t1Id } });
  });

  it('student account and password changes still need separate authorization — no delegation gives them', async () => {
    for (const make of [
      () => http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).send({ firstName: 'Changed' }),
      () => http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).send({ password: 'N3w!Passw0rd' }),
      () => http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/send-password-reset`),
      () => http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}/status`).send({ isActive: false }),
      () => http().get('/api/v1/admin/users'),
    ]) expect(await status(make().set(bearer(t1)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).firstName).toBe('student.j');
  });

  it('revocation applies on the next request (same token); Administrators revoke only teacher delegations', async () => {
    const onBehalf = await p().userPermissionOverride.findFirstOrThrow({ where: { userId: t1Id, permission: 'submissions.submitOnBehalf', revokedAt: null } });
    await http().delete(`${delegations(t1Id)}/${onBehalf.id}`).set(bearer(admin)).expect(200);
    // Changed on purpose — owner decision 2026-11-24: handing in homework is a Teacher default, so revoking the older
    // delegation leaves it; the Administrator's course homework switch takes it away, on the next request (same token).
    await http().put(`/api/v1/admin/teachers/${t1Id}/homework-submission`).set(bearer(admin)).send({ allowed: false, reason: 'Pause homework' }).expect(200);
    expect(await status(submitFor(t1, ctx.ids.studentJunior, workId))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().put(`/api/v1/admin/teachers/${t1Id}/homework-submission`).set(bearer(admin)).send({ allowed: true }).expect(200);
    expect(await status(http().delete(`${delegations(t1Id)}/${onBehalf.id}`).set(bearer(admin)))).toEqual([409, 'OVERRIDE_ALREADY_REVOKED']);
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'PERMISSION_OVERRIDE_REVOKE', entityId: onBehalf.id } }))
      .toMatchObject({ actorId: ctx.ids.admin, metadata: { via: 'TEACHER_DELEGATION' } });
    // A Super Admin's DENY on the teacher is not a delegation: an Administrator cannot see or revoke it there.
    const deny = await http().post(`/api/v1/admin/users/${t1Id}/permission-overrides`).set(bearer(superAdmin))
      .send({ permission: 'leaderboard.view', effect: 'DENY', reason: 'Not for teachers here' }).expect(201);
    expect((await http().get(delegations(t1Id)).set(bearer(admin)).expect(200)).body.map((o: any) => o.id)).not.toContain(deny.body.id);
    expect((await http().delete(`${delegations(t1Id)}/${deny.body.id}`).set(bearer(admin))).status).toBe(404);
    expect((await p().userPermissionOverride.findUniqueOrThrow({ where: { id: deny.body.id } })).revokedAt).toBeNull();
  });

  it('ending a school assignment removes the teacher\'s access to those students on the next request', async () => {
    const a = await p().teacherSchoolAssignment.findFirstOrThrow({ where: { teacherId: t1Id, schoolId: schoolA } });
    await http().delete(`${ASSIGN}/${a.id}`).set(bearer(admin)).expect(200);
    expect((await http().get('/api/v1/teacher/students').set(bearer(t1)).expect(200)).body.data).toEqual([]);
    expect((await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(t1))).status).toBe(404);
    expect(await status(http().delete(`${ASSIGN}/${a.id}`).set(bearer(admin)))).toEqual([409, 'ASSIGNMENT_ENDED']);
    expect(await p().auditLog.count({ where: { action: 'UNASSIGN_TEACHER_SCHOOL', entityId: a.id, actorId: ctx.ids.admin } })).toBe(1);
  });

  it('registration.studentRequiresApproval: listed once registered with the school code (owner 2026-11-21), and (policy on) only once the account is approved; no valid school → never listed', async () => {
    const coded = (await p().school.create({ data: { name: 'APPROVAL TEST SCHOOL', location: 'Kigali, Gasabo', code: '120998', province: 'Kigali City', district: 'Gasabo', sector: 'Kigali', ownership: 'PUBLIC', nameKey: 'approval test school' } })).id;
    await http().post(ASSIGN).set(bearer(admin)).send({ teacherId: t3Id, schoolId: coded }).expect(201);
    const reg = (username: string, extra: object = {}) => http().post('/api/v1/auth/register/student').send({
      firstName: 'R', lastName: username, username, email: `${username}@test.local`, password: 'Secret123', dateOfBirth: '2010-05-01', gender: 'FEMALE', homeCountry: 'UG', guardianPhone: '0722000111', gradeLevel: 'S2',
      schoolCode: '120998', homeLocation: 'Kigali', ...extra,
    });
    const listed = async () => (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(t3)).expect(200)).body.data.map((s: any) => s.username);

    const verifyClaim = async (username: string) => {
      const u = await p().user.findUniqueOrThrow({ where: { username } });
      const claim = await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: u.id, supersededAt: null } });
      await http().post(`/api/v1/admin/school-affiliations/${claim.id}/verify`).set(bearer(admin)).send({}).expect(200);
    };

    // Policy off (the default): approved at registration; the school claim is PENDING — and the student is listed at once
    // (owner 2026-11-21: automatic discovery by the school code; no Administrator step). Verifying it changes nothing here.
    const off = await reg('appr.off').expect(201);
    expect(off.body).toMatchObject({ requiresApproval: false, schoolVerification: 'PENDING' });
    expect(await listed()).toContain('appr.off');
    await verifyClaim('appr.off');
    expect(await listed()).toContain('appr.off');

    // Policy on: registered unapproved → cannot sign in, not listed; listed on the next request after approval.
    await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.studentRequiresApproval': true }).expect(200);
    try {
      expect((await reg('appr.on').expect(201)).body.requiresApproval).toBe(true);
      const pendingUser = await p().user.findUniqueOrThrow({ where: { username: 'appr.on' } });
      expect(pendingUser).toMatchObject({ isApproved: false, schoolId: coded });
      expect((await http().post('/api/v1/auth/login').send({ username: 'appr.on', password: 'Secret123' })).body.code).toBe('ACCOUNT_PENDING_APPROVAL');
      expect(await listed()).not.toContain('appr.on');
      expect((await http().get(`/api/v1/teacher/students/${pendingUser.id}`).set(bearer(t1))).status).not.toBe(200);
      // Verifying the school does not approve the account, and approving does not verify the school.
      await verifyClaim('appr.on');
      expect(await listed()).not.toContain('appr.on');
      expect((await p().user.findUniqueOrThrow({ where: { id: pendingUser.id } })).isApproved).toBe(false);
      await http().patch(`/api/v1/admin/users/${pendingUser.id}/status`).set(bearer(admin)).send({ isApproved: true }).expect(200);
      expect(await listed()).toContain('appr.on');
    } finally {
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.studentRequiresApproval': false }).expect(200);
    }

    // Approved but without a valid school (another country; an unknown Rwandan name): never in a teacher list.
    await reg('appr.intl', { country: 'KE', schoolCode: undefined, schoolName: 'Nairobi School' }).expect(201);
    await reg('appr.noname', { schoolCode: undefined, schoolName: 'No Such School' }).expect(201);
    for (const u of ['appr.intl', 'appr.noname']) {
      expect((await p().user.findUniqueOrThrow({ where: { username: u } })).schoolId).toBeNull();
      expect(await listed()).not.toContain(u);
    }
  });

  it('a Teacher who changes role keeps no school scope and no delegation applies', async () => {
    await http().post(ASSIGN).set(bearer(admin)).send({ teacherId: t2Id, schoolId: schoolA }).expect(201);
    await grant(admin, t2Id, 'students.viewProfile').expect(201);
    await http().patch(`/api/v1/admin/users/${t2Id}`).set(bearer(admin)).send({ role: 'MENTOR', currentPassword: PASSWORD }).expect(200);
    expect(await p().teacherSchoolAssignment.count({ where: { teacherId: t2Id, isActive: true } })).toBe(0);
    expect(await p().auditLog.count({ where: { action: 'UNASSIGN_TEACHER_SCHOOL', metadata: { path: ['teacherId'], equals: t2Id } } })).toBe(2);
    const asCoach = await login(ctx, 't.two');
    expect((await http().get('/api/v1/me/permissions').set(bearer(asCoach)).expect(200)).body.permissions).not.toContain('students.viewProfile');
    expect(await status(http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(asCoach)))).toEqual([403, 'PERMISSION_REQUIRED']);

    // The delegation is revoked by the role change itself (audited), not merely inert.
    const grants = await p().userPermissionOverride.findMany({ where: { userId: t2Id, permission: 'students.viewProfile' } });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ revokeReason: 'ROLE_CHANGE', revokedById: ctx.ids.admin });
    expect(grants[0].revokedAt).not.toBeNull();
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'PERMISSION_OVERRIDE_REVOKE', entityId: grants[0].id } }))
      .toMatchObject({ actorId: ctx.ids.admin, metadata: { reason: 'ROLE_CHANGE', from: 'TEACHER', to: 'MENTOR' } });

    // Round trip: back to TEACHER with a school again — the old delegation does NOT come back.
    await http().patch(`/api/v1/admin/users/${t2Id}`).set(bearer(admin)).send({ role: 'TEACHER', currentPassword: PASSWORD }).expect(200);
    await http().post(ASSIGN).set(bearer(admin)).send({ teacherId: t2Id, schoolId: schoolA }).expect(201);
    const asTeacherAgain = await login(ctx, 't.two');
    expect((await http().get('/api/v1/me/permissions').set(bearer(asTeacherAgain)).expect(200)).body.permissions).not.toContain('students.viewProfile');
    expect(await status(http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(asTeacherAgain)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await http().get('/api/v1/teacher/students').set(bearer(asTeacherAgain)).expect(200)).body.data.map((s: any) => s.id)).toContain(ctx.ids.studentJunior);
    // An Administrator can grant it again explicitly.
    await grant(admin, t2Id, 'students.viewProfile').expect(201);
    await http().get(`/api/v1/teacher/students/${ctx.ids.studentJunior}`).set(bearer(asTeacherAgain)).expect(200);
  });
});
