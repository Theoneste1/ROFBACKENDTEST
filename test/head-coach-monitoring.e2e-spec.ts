/**
 * P1-10 part 3 — Head Coach monitoring (dashboard, reports, course analytics,
 * activity) and coach invitation (plan §7.2, §10.1, §11.2, §11.5 scope isolation).
 *
 * Fixtures: Mathematics (seed) + test-only Physics with course Mechanics; HM heads
 * Maths, HP heads Physics; coach B shared (Maths + Physics, teaching Mechanics);
 * coach P and student P in Physics only; a published Maths result and a published
 * Mechanics result.
 */
import { createTestApp, login, bearer, inDays, PASSWORD, type TestContext } from './helpers.js';

describe('Head Coach monitoring and coach invitation (P1-10 part 3)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, coachJ: string, studentJ: string;
  let maths: string, physics: string, mechanics: string;
  let hmId: string, hpId: string, coachB: string, coachP: string, studentP: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const get = (path: string, token: string, query: object = {}) => http().get(path).set(bearer(token)).query({ academicYearId: 'all', ...query });

  /** A published, graded result in a course × division (marked by `mentorId`). */
  const publishedResult = async (courseId: string, studentId: string, mentorId: string, percentage: number) => {
    const a = await p().assignment.create({ data: {
      title: `Work ${courseId.slice(0, 4)}`, instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year, createdById: mentorId, status: 'PUBLISHED', publishedAt: new Date(),
    } });
    const s = await p().submission.create({ data: { assignmentId: a.id, studentId, status: 'PUBLISHED', submittedAt: new Date(), publishedAt: new Date() } });
    const r = await p().mentorReview.create({ data: {
      submissionId: s.id, mentorId, cycle: 1, status: 'APPROVED', score: percentage / 10, percentage, assignedAt: new Date(), returnedAt: new Date(),
    } });
    await p().submission.update({ where: { id: s.id }, data: { publishedReviewId: r.id } });
    return a.id;
  };

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coachJ = await login(ctx, 'mentor.j');
    studentJ = await login(ctx, 'student.j');
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } })).id;
    mechanics = (await p().course.create({ data: {
      code: 'MECHANICS', disciplineId: physics, title: 'Mechanics', description: 'Physics course', status: 'PUBLISHED', publishedAt: new Date(),
    } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'MENTOR' | 'STUDENT', programmes: string[]) => {
      const u = await p().user.create({ data: {
        username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(),
        ...(role === 'STUDENT' && { gradeLevel: 'S2', divisionId: ctx.ids.junior }),
      } });
      for (const disciplineId of programmes) await p().programmeMembership.create({ data: { userId: u.id, disciplineId, source: 'MANUAL' } });
      return u.id;
    };
    hmId = await mk('m3.maths', 'HEAD_COACH', []);
    hpId = await mk('m3.phys', 'HEAD_COACH', []);
    coachB = await mk('m3.coach.b', 'MENTOR', [maths, physics]);
    coachP = await mk('m3.coach.p', 'MENTOR', [physics]);
    studentP = await mk('m3.student.p', 'STUDENT', [physics]);
    await p().studentEnrollment.create({ data: { studentId: studentP, academicYearId: ctx.ids.year, gradeLevel: 'S2', divisionId: ctx.ids.junior } });
    await p().mentorAssignment.createMany({ data: [
      { mentorId: coachB, courseId: mechanics, divisionId: ctx.ids.junior },
      { mentorId: coachB, courseId: ctx.ids.geometry, divisionId: ctx.ids.junior },
      { mentorId: coachP, courseId: mechanics, divisionId: ctx.ids.junior },
    ] });
    await http().put(`/api/v1/admin/programmes/${maths}/heads`).set(bearer(admin)).send({ userIds: [hmId] }).expect(200);
    await http().put(`/api/v1/admin/programmes/${physics}/heads`).set(bearer(admin)).send({ userIds: [hpId] }).expect(200);
    await publishedResult(ctx.ids.algebra, ctx.ids.studentJunior, ctx.ids.mentorJunior, 80);
    await publishedResult(mechanics, studentP, coachP, 40);
    await p().activityLog.createMany({ data: [
      { userId: ctx.ids.studentJunior, type: 'COURSE_OPENED', courseId: ctx.ids.algebra },
      { userId: studentP, type: 'COURSE_OPENED', courseId: mechanics },
      { userId: coachB, type: 'RESOURCE_VIEWED', courseId: mechanics },   // shared coach, Physics course
      { userId: coachB, type: 'RESOURCE_VIEWED', courseId: ctx.ids.geometry },
      { userId: ctx.ids.admin, type: 'LOGIN' },
    ] });
    hm = await login(ctx, 'm3.maths');
    hp = await login(ctx, 'm3.phys');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('dashboard: only the programmes a Head Coach heads, no moderation or account-wide sections; a foreign course is 404', async () => {
    const hmDash = (await get('/api/v1/admin/dashboard', hm).expect(200)).body;
    const adminDash = (await get('/api/v1/admin/dashboard', admin).expect(200)).body;
    expect(hmDash.students.byCourse.map((c: any) => c.id)).not.toContain(mechanics);
    expect(adminDash.students.byCourse.map((c: any) => c.id)).toContain(mechanics);
    expect(hmDash.students.total).toBe(adminDash.students.total - 1);   // student P is Physics only
    expect(hmDash.submissions.total).toBe(1);                            // the Maths result only
    expect((await get('/api/v1/admin/dashboard', hp).expect(200)).body.submissions.total).toBe(1);
    expect('reportedContent' in hmDash || 'accountsAwaitingSetup' in hmDash).toBe(false);
    expect(adminDash).toHaveProperty('reportedContent');
    expect((await get('/api/v1/admin/dashboard', hm, { courseId: mechanics })).status).toBe(404);
  });

  it('reports: students and coaches of the programme only, no contact details; a shared coach shows only this programme\'s teaching', async () => {
    const students = (await get('/api/v1/admin/reports/students', hm, { limit: 100 }).expect(200)).body.data;
    expect(students.map((s: any) => s.id)).toEqual(expect.arrayContaining([ctx.ids.studentJunior]));
    expect(students.map((s: any) => s.id)).not.toContain(studentP);
    for (const s of students) expect([s.id, 'email' in s]).toEqual([s.id, false]);
    expect((await get('/api/v1/admin/reports/students', admin, { limit: 100 }).expect(200)).body.data.every((s: any) => 'email' in s)).toBe(true);

    for (const path of ['/api/v1/admin/reports/mentors', '/api/v1/admin/reports/mentor-activity']) {
      const rows = (await get(path, hm, { limit: 100 }).expect(200)).body.data;
      expect([path, rows.map((m: any) => m.id)]).toEqual([path, expect.not.arrayContaining([coachP])]);
      const b = rows.find((m: any) => m.id === coachB);
      expect([path, b.teaching.map((t: any) => t.course.id)]).toEqual([path, [ctx.ids.geometry]]);
      for (const m of rows) expect([path, m.id, 'email' in m]).toEqual([path, m.id, false]);
      const bAdmin = (await get(path, admin, { limit: 100 }).expect(200)).body.data.find((m: any) => m.id === coachB);
      expect(bAdmin.teaching.map((t: any) => t.course.id).sort()).toEqual([ctx.ids.geometry, mechanics].sort());
    }
    const hpCoaches = (await get('/api/v1/admin/reports/mentors', hp, { limit: 100 }).expect(200)).body.data.map((m: any) => m.id);
    expect(hpCoaches.sort()).toEqual([coachB, coachP].sort());
    expect((await get('/api/v1/admin/reports/students', hm, { courseId: mechanics })).status).toBe(404);
  });

  it('course participation: programme courses only and no score aggregate for a Head Coach; Administrators unchanged', async () => {
    const rows = (await get('/api/v1/admin/reports/course-participation', hm).expect(200)).body.rows;
    expect(rows.map((r: any) => r.course.id)).not.toContain(mechanics);
    const algebra = rows.find((r: any) => r.course.id === ctx.ids.algebra && r.division.id === ctx.ids.junior);
    expect(algebra).toMatchObject({ submissions: 1, averageScore: null });
    const adminAlgebra = (await get('/api/v1/admin/reports/course-participation', admin).expect(200)).body.rows
      .find((r: any) => r.course.id === ctx.ids.algebra && r.division.id === ctx.ids.junior);
    expect(adminAlgebra.averageScore).toBe(80);
    // The Physics student is not counted in Maths figures.
    expect(algebra.students).toBe(adminAlgebra.students - 1);
  });

  it('course analytics: a course of the Head Coach\'s programme without score aggregates; another programme 404; coach and admin unchanged', async () => {
    const res = (await http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior }).set(bearer(hm)).expect(200)).body;
    const work = res.assignments.find((a: any) => a.publishedResults === 1);
    expect(work).toMatchObject({ averagePercentage: null, medianPercentage: null, highestPercentage: null, lowestPercentage: null, distribution: [] });
    expect('disciplineId' in res.course).toBe(false);
    expect((await http().get(`/api/v1/analytics/courses/${mechanics}`).query({ divisionId: ctx.ids.junior }).set(bearer(hm))).status).toBe(404);
    expect((await http().get(`/api/v1/analytics/courses/${mechanics}`).query({ divisionId: ctx.ids.junior }).set(bearer(hp))).status).toBe(200);
    const adminWork = (await http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior }).set(bearer(admin)).expect(200))
      .body.assignments.find((a: any) => a.publishedResults === 1);
    expect(adminWork.averagePercentage).toBe(80);
    await http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior }).set(bearer(coachJ)).expect(200);
  });

  it('activity: only programme members, and only this programme\'s courses (a shared coach\'s other programme stays hidden); summary likewise', async () => {
    const rows = (await http().get('/api/v1/admin/activity').query({ limit: 100 }).set(bearer(hm)).expect(200)).body.data;
    const seen = rows.map((r: any) => [r.user.id, r.courseId]);
    expect(seen).toEqual(expect.arrayContaining([[ctx.ids.studentJunior, ctx.ids.algebra], [coachB, ctx.ids.geometry]]));
    expect(seen).not.toEqual(expect.arrayContaining([[coachB, mechanics]]));
    for (const r of rows) {
      expect([r.user.id, ['STUDENT', 'MENTOR'].includes(r.user.role)]).toEqual([r.user.id, true]);
      expect([r.id, r.courseId === null || r.courseId !== mechanics]).toEqual([r.id, true]);
    }
    expect(rows.map((r: any) => r.user.id)).not.toContain(studentP);
    expect(rows.map((r: any) => r.user.id)).not.toContain(ctx.ids.admin);
    expect((await http().get('/api/v1/admin/activity').query({ courseId: mechanics }).set(bearer(hm))).status).toBe(404);

    const summary = (await http().get('/api/v1/admin/activity/summary').set(bearer(hm)).expect(200)).body;
    const adminSummary = (await http().get('/api/v1/admin/activity/summary').set(bearer(admin)).expect(200)).body;
    expect(summary.activeUsers).toBeLessThan(adminSummary.activeUsers);
    // Logins: exactly those of Maths Students and Coaches (members) — never an administrator's or a Physics-only user's.
    const memberLogins = await p().activityLog.count({ where: { type: 'LOGIN', user: { role: { in: ['STUDENT', 'MENTOR'] }, programmeMemberships: { some: { disciplineId: maths, isActive: true } } } } });
    expect(summary.byType.LOGIN ?? 0).toBe(memberLogins);
    expect(adminSummary.byType.LOGIN).toBeGreaterThan(memberLogins);
  });

  it('exports and the other administrator reports stay closed to Head Coaches', async () => {
    for (const path of [
      'students.csv', 'mentors.csv', 'enrollment.csv', 'course-participation.csv', 'assignments.csv', 'reviews.csv',
      'results-publication.csv', 'mentor-activity.csv', 'results.csv', 'mentor-workload.csv',
    ]) expect([path, ...(await status(http().get(`/api/v1/admin/reports/${path}`).set(bearer(hm))))]).toEqual([path, 403, 'PERMISSION_REQUIRED']);
    for (const path of ['overview', 'enrollment', 'assignments', 'reviews', 'results-publication']) {
      expect([path, (await http().get(`/api/v1/admin/reports/${path}`).set(bearer(hm))).status]).toEqual([path, 403]);
    }
    expect(await p().auditLog.count({ where: { action: 'EXPORT_REPORT', actorId: hmId } })).toBe(0);
    // Administrators keep every export.
    await http().get('/api/v1/admin/reports/students.csv').set(bearer(admin)).expect(200);
    // Coaches and students: still refused.
    for (const token of [coachJ, studentJ]) {
      for (const path of ['/api/v1/admin/dashboard', '/api/v1/admin/reports/students', '/api/v1/admin/reports/mentors', '/api/v1/admin/activity']) {
        expect([path, (await http().get(path).set(bearer(token))).status]).toEqual([path, 403]);
      }
    }
  });

  it('coach invitation: a Head Coach invites a Coach into their programme — pending, member, audited; an Administrator approves; no login before', async () => {
    const invite = (token: string, programme: string, username: string) => http().post(`/api/v1/admin/programmes/${programme}/coach-invitations`).set(bearer(token))
      .send({ firstName: 'Invited', lastName: 'Coach', email: `${username}@test.local`, username });

    const res = await invite(hm, maths, 'm3.invited').expect(201);
    expect(res.body).toMatchObject({ pendingApproval: true, user: { role: 'MENTOR', username: 'm3.invited' } });
    const invited = await p().user.findUniqueOrThrow({ where: { username: 'm3.invited' } });
    expect(invited).toMatchObject({ role: 'MENTOR', isApproved: false, activatedAt: null, passwordHash: null });
    expect(await p().programmeMembership.findUniqueOrThrow({ where: { userId_disciplineId: { userId: invited.id, disciplineId: maths } } }))
      .toMatchObject({ isActive: true, source: 'MANUAL', addedById: hmId });
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'INVITE_USER', entityId: invited.id } }))
      .toMatchObject({ actorId: hmId, actorRole: 'HEAD_COACH', metadata: { role: 'MENTOR', programmeId: maths, pendingApproval: true } });

    // Only the Head Coach's own programmes; nothing created elsewhere; duplicates refused.
    expect((await invite(hm, physics, 'm3.elsewhere')).status).toBe(404);
    expect(await p().user.count({ where: { username: 'm3.elsewhere' } })).toBe(0);
    expect(await status(invite(hm, maths, 'm3.invited'))).toEqual([409, 'IDENTITY_TAKEN']);
    // Only Coaches: the endpoint has no role field, and extra fields are rejected.
    expect((await http().post(`/api/v1/admin/programmes/${maths}/coach-invitations`).set(bearer(hm))
      .send({ firstName: 'X', lastName: 'Y', email: 'm3.admin@test.local', role: 'ADMIN' })).status).toBe(400);
    expect(await p().user.count({ where: { email: 'm3.admin@test.local' } })).toBe(0);

    // The Head Coach cannot approve; an Administrator sees it pending and approves (audited).
    expect(await status(http().patch(`/api/v1/admin/users/${invited.id}/status`).set(bearer(hm)).send({ isApproved: true }))).toEqual([403, 'PERMISSION_REQUIRED']);
    const pending = (await http().get('/api/v1/admin/users').query({ isApproved: 'false', limit: 100 }).set(bearer(admin)).expect(200)).body.data;
    expect(pending.map((u: any) => u.id)).toContain(invited.id);
    // Not usable before approval, even with a password set.
    await p().user.update({ where: { id: invited.id }, data: { passwordHash: (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash, activatedAt: new Date() } });
    expect((await http().post('/api/v1/auth/login').send({ username: 'm3.invited', password: PASSWORD })).status).toBe(403);
    await http().patch(`/api/v1/admin/users/${invited.id}/status`).set(bearer(admin)).send({ isApproved: true }).expect(200);
    expect(await p().auditLog.count({ where: { action: 'UPDATE_USER_STATUS', entityId: invited.id, actorId: ctx.ids.admin } })).toBe(1);
    await login(ctx, 'm3.invited');

    // An Administrator's invitation through the same endpoint is approved at once.
    const byAdmin = await invite(admin, physics, 'm3.byadmin').expect(201);
    expect(byAdmin.body.pendingApproval).toBe(false);
    expect((await p().user.findUniqueOrThrow({ where: { username: 'm3.byadmin' } })).isApproved).toBe(true);
    // Coaches and students cannot invite.
    for (const token of [coachJ, studentJ]) expect(await status(invite(token, maths, 'm3.nope'))).toEqual([403, 'PERMISSION_REQUIRED']);
  });
});
