/**
 * Notification settings and recipients for the Phase 1 roles:
 * - a Super Administrator receives what administrators receive, so sees and can switch the same types;
 * - a Head Coach receives what coaches receive for course work an Administrator assigned them
 *   (COURSE_WORK_ROLES), so sees the coaches' switches, and is notified of a new discussion in that scope;
 * - a Teacher has no switchable notifications (403, like a student).
 */
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';

describe('Notification settings for Super Admins, Head Coaches and Teachers (e2e)', () => {
  let ctx: TestContext;
  let admin: string, studentJ: string, superA: string, headC: string, teacher: string;
  let headCoachId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const typesOf = async (token: string) =>
    ((await http().get('/api/v1/me/notification-settings').set(bearer(token)).expect(200)).body.settings as Array<{ type: string }>).map((s) => s.type);

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    studentJ = await login(ctx, 'student.j');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'SUPER_ADMIN' | 'HEAD_COACH' | 'TEACHER') => (await p().user.create({ data: {
      username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(),
    } })).id;
    await mk('n.super', 'SUPER_ADMIN');
    headCoachId = await mk('n.head', 'HEAD_COACH');
    await mk('n.teacher', 'TEACHER');
    const maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    await http().put(`/api/v1/admin/programmes/${maths}/heads`).set(bearer(admin)).send({ userIds: [headCoachId] }).expect(200);
    superA = await login(ctx, 'n.super');
    headC = await login(ctx, 'n.head');
    teacher = await login(ctx, 'n.teacher');
  });

  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('a Super Administrator sees exactly the administrators\' switches', async () => {
    const adminTypes = await typesOf(admin);
    const superTypes = await typesOf(superA);
    expect(superTypes.length).toBeGreaterThan(0);
    expect([...superTypes].sort()).toEqual([...adminTypes].sort());
    expect(superTypes).toContain('moderation.content_reported');
  });

  it('a Super Administrator switches an administrators\' notification off', async () => {
    const res = await http().patch('/api/v1/me/notification-settings').set(bearer(superA))
      .send({ settings: [{ type: 'moderation.content_reported', inAppEnabled: false }] }).expect(200);
    expect(res.body.settings.find((s: any) => s.type === 'moderation.content_reported')).toMatchObject({ inAppEnabled: false });
    await http().post('/api/v1/me/notification-settings/reset').set(bearer(superA)).expect(200);
  });

  it('a Head Coach sees the coaches\' switches and can change and reset them', async () => {
    const coachTypes = await typesOf(await login(ctx, 'mentor.j'));
    const headTypes = await typesOf(headC);
    expect([...headTypes].sort()).toEqual([...coachTypes].sort());
    expect(headTypes).toEqual(expect.arrayContaining(['submissions.assigned', 'discussion.thread_created']));
    expect(headTypes).not.toContain('moderation.content_reported');
    const off = await http().patch('/api/v1/me/notification-settings').set(bearer(headC))
      .send({ settings: [{ type: 'submissions.assigned', emailEnabled: false }] }).expect(200);
    expect(off.body.settings.find((s: any) => s.type === 'submissions.assigned')).toMatchObject({ inAppEnabled: true, emailEnabled: false });
    // A type of another role cannot be switched.
    await http().patch('/api/v1/me/notification-settings').set(bearer(headC))
      .send({ settings: [{ type: 'moderation.content_reported', inAppEnabled: false }] }).expect(400);
    await http().post('/api/v1/me/notification-settings/reset').set(bearer(headC)).expect(200);
  });

  it('a Teacher has no notification switches', async () => {
    await http().get('/api/v1/me/notification-settings').set(bearer(teacher)).expect(403);
    await http().patch('/api/v1/me/notification-settings').set(bearer(teacher))
      .send({ settings: [{ type: 'submissions.assigned', inAppEnabled: false }] }).expect(403);
  });

  it('a Head Coach assigned to a course × division is told of a new discussion there; without the assignment, not', async () => {
    const count = () => p().notification.count({ where: { userId: headCoachId, type: 'discussion.thread_created' } });
    // No assignment yet: not notified.
    await http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
      .send({ title: 'Before the assignment', content: 'Anyone?' }).expect(201);
    await waitForEvents();
    expect(await count()).toBe(0);

    await http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
      .send({ mentorId: headCoachId, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }).expect(201);
    await http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
      .send({ title: 'After the assignment', content: 'How do I start?' }).expect(201);
    await waitForEvents();
    expect(await count()).toBe(1);
  });
});
