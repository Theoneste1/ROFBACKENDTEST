/**
 * P1-06 — routes converted from @Roles to @RequirePermission: boundaries for
 * all six roles over HTTP, with real accounts (new roles created with the flags
 * on; SUPER_ADMIN written directly, as it is never assignable via the API).
 *
 * Existing STUDENT / MENTOR / ADMIN decisions are proven unchanged for every
 * handler by the P1-02 baseline and the equivalence harness (unit tests); this
 * file checks the new roles, escalation attempts and that services still apply
 * their record and scope rules behind the permission.
 */
import { createTestApp, login, bearer, PDF, inDays, type TestContext } from './helpers.js';

describe('Route permissions — six-role boundaries (P1-06)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  let admin: string, mentorJ: string, studentJ: string;
  let superAdmin: string, headCoach: string, teacher: string;
  let subId: string, assignmentId: string;

  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    [admin, mentorJ, studentJ] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));

    for (const [username, role] of [['p6.teacher', 'TEACHER'], ['p6.head', 'HEAD_COACH']] as const) {
      await http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'P6', lastName: role, username, email: `${username}@test.local`, password: 'Str0ng!Passw0rd', role,
      }).expect(201);
    }
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    await ctx.prisma.user.create({ data: {
      username: 'p6.super', firstName: 'P6', lastName: 'Super', email: 'p6.super@test.local',
      role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date(),
    } });
    teacher    = await login(ctx, 'p6.teacher', 'Str0ng!Passw0rd');
    headCoach  = await login(ctx, 'p6.head', 'Str0ng!Passw0rd');
    superAdmin = await login(ctx, 'p6.super');

    // A real submission, distributed to mentor.j (Algebra × Junior).
    const a = await ctx.prisma.assignment.create({ data: {
      title: 'P6 work', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
    } });
    assignmentId = a.id;
    subId = (await http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', a.id).attach('file', PDF, 'work.pdf').expect(201)).body.id;
    await http().patch(`/api/v1/submissions/${subId}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
  });

  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  const reviewState = () => ctx.prisma.submission.findUniqueOrThrow({
    where: { id: subId }, select: { status: true, currentReview: { select: { status: true, mentorId: true } } },
  });

  it('unauthenticated requests are refused (401) on converted routes', async () => {
    for (const make of [
      () => http().get('/api/v1/admin/users'),
      () => http().get('/api/v1/admin/audit-logs'),
      () => http().patch(`/api/v1/submissions/${subId}/start-review`),
      () => http().get('/api/v1/mentor/reviews'),
      () => http().get('/api/v1/me/results'),
      () => http().post(`/api/v1/assignments/${assignmentId}/distribute`),
    ]) expect((await make()).status).toBe(401);
  });

  it('SUPER_ADMIN holds the administrative permissions…', async () => {
    await http().get('/api/v1/admin/users').set(bearer(superAdmin)).expect(200);
    await http().get('/api/v1/admin/audit-logs').set(bearer(superAdmin)).expect(200);
    await http().get('/api/v1/admin/settings').set(bearer(superAdmin)).expect(200);
    await http().get('/api/v1/admin/email/jobs').set(bearer(superAdmin)).expect(200);
  });

  it('…but never grades or authors assignments (RS1), and is not a student', async () => {
    const before = await reviewState();
    expect(await status(http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(superAdmin)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(superAdmin)).field('score', '9').field('mentorFeedback', 'x'))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().get('/api/v1/mentor/reviews').set(bearer(superAdmin)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().post('/api/v1/assignments').set(bearer(superAdmin))
      .field('title', 'x').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
      .field('instructions', 'xxxxxxxxxxxx').field('deadline', inDays(3)).field('points', '1').field('maximumMarks', '1')))
      .toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().post('/api/v1/submissions').set(bearer(superAdmin)).field('assignmentId', assignmentId).attach('file', PDF, 'w.pdf')))
      .toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await reviewState()).toEqual(before);
  });

  it('ADMIN still never grades (now refused by the permission guard)', async () => {
    expect(await status(http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(admin)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().get('/api/v1/mentor/reviews').set(bearer(admin)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('HEAD_COACH: no global administration — user, audit, settings, distribution, results and e-mail are refused', async () => {
    for (const make of [
      () => http().get('/api/v1/admin/users'),
      () => http().post('/api/v1/auth/register/admin').send({ firstName: 'X', lastName: 'Y', username: 'hc.admin', email: 'hc.admin@test.local', password: 'Str0ng!Passw0rd' }),
      () => http().get('/api/v1/admin/audit-logs'),
      () => http().get('/api/v1/admin/settings'),
      () => http().patch(`/api/v1/submissions/${subId}/reassign`).send({ mentorId: ctx.ids.mentorJunior2 }),
      () => http().post(`/api/v1/assignments/${assignmentId}/results/publish`),
      () => http().get('/api/v1/admin/email/jobs'),
      () => http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}/archive`),
    ]) expect(await status(make().set(bearer(headCoach)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('HEAD_COACH (Option A): programme-scoped areas stay closed until programme membership exists (P1-07/P1-10)', async () => {
    for (const make of [
      () => http().get('/api/v1/admin/mentor-assignments'),
      () => http().post('/api/v1/admin/mentor-assignments').send({ mentorId: ctx.ids.mentorJunior, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }),
      () => http().get('/api/v1/admin/dashboard'),
      () => http().get('/api/v1/admin/reports/students'),
      () => http().get('/api/v1/admin/activity'),
    ]) expect((await make().set(bearer(headCoach))).status).toBe(403);
    // No course content outside a programme either.
    expect((await http().get('/api/v1/courses').set(bearer(headCoach))).status).toBe(403);
  });

  it('HEAD_COACH: the course-work grants pass the guard, but the services still require an assigned coach (H4) — nothing is exposed or changed', async () => {
    const before = await reviewState();
    expect(await status(http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(headCoach)))).toEqual([403, 'NOT_ASSIGNED_MENTOR']);
    const queue = await http().get('/api/v1/mentor/reviews').set(bearer(headCoach)).expect(200);
    expect(queue.body.data).toEqual([]);   // never sees mentor.j's assigned work
    expect(await status(http().post('/api/v1/assignments').set(bearer(headCoach))
      .field('title', 'HC work').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
      .field('instructions', 'xxxxxxxxxxxx').field('deadline', inDays(3)).field('points', '1').field('maximumMarks', '1')))
      .toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
    expect((await http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior }).set(bearer(headCoach))).status).toBe(403);
    expect(await reviewState()).toEqual(before);
    expect(await ctx.prisma.assignment.count({ where: { title: 'HC work' } })).toBe(0);
  });

  it('TEACHER: refused on every converted administrative, grading, authoring and student route', async () => {
    for (const make of [
      () => http().get('/api/v1/admin/users'),
      () => http().get('/api/v1/admin/audit-logs'),
      () => http().patch(`/api/v1/submissions/${subId}/start-review`),
      () => http().get('/api/v1/mentor/reviews'),
      () => http().post('/api/v1/assignments').field('title', 'T'),
      () => http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).field('title', 'T'),
      () => http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior }),
      () => http().get('/api/v1/me/results'),
      () => http().post('/api/v1/submissions').field('assignmentId', assignmentId),
    ]) expect(await status(make().set(bearer(teacher)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('privilege escalation by existing roles is refused', async () => {
    // Students: no administration, no grading.
    for (const make of [
      () => http().get('/api/v1/admin/users'),
      () => http().patch(`/api/v1/submissions/${subId}/start-review`),
      () => http().patch(`/api/v1/assignments/${assignmentId}/publish`),
    ]) expect(await status(make().set(bearer(studentJ)))).toEqual([403, 'PERMISSION_REQUIRED']);
    // Coaches: no publishing, distribution, approval or user management.
    for (const make of [
      () => http().patch(`/api/v1/assignments/${assignmentId}/publish`),
      () => http().patch(`/api/v1/submissions/${subId}/reassign`).send({ mentorId: ctx.ids.mentorJunior2 }),
      () => http().patch(`/api/v1/submissions/${subId}/approve`).send({}),
      () => http().post(`/api/v1/assignments/${assignmentId}/results/publish`),
      () => http().get('/api/v1/admin/users'),
      () => http().post('/api/v1/auth/register/admin').send({ firstName: 'X', lastName: 'Y', username: 'm.admin', email: 'm.admin@test.local', password: 'Str0ng!Passw0rd' }),
    ]) expect(await status(make().set(bearer(mentorJ)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await ctx.prisma.user.count({ where: { username: { in: ['hc.admin', 'm.admin'] } } })).toBe(0);
  });

  it('the assigned coach still works normally behind the permission', async () => {
    await http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ)).expect(200);
    const queue = await http().get('/api/v1/mentor/reviews').set(bearer(mentorJ)).expect(200);
    expect(queue.body.data.map((s: any) => s.id)).toContain(subId);
  });
});
