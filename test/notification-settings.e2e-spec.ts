/**
 * Notification settings: administrators and mentors choose, in their profile
 * settings, which notifications they get in the app and by e-mail.
 */
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

const waitForEvents = () => new Promise((r) => setTimeout(r, 300));

describe('Notification settings (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorJ2: string, studentJ: string;

  const inbox = (userId: string, type: string) => ctx.prisma.notification.count({ where: { userId, type } });
  const outbox = (userId: string) => ctx.prisma.emailDelivery.count({ where: { recipientId: userId } });

  /** A published assignment with one submission, assigned to the given mentor. */
  const assignWork = async (mentorId: string) => {
    const a = await ctx.prisma.assignment.create({
      data: {
        title: `Work ${Math.random().toString(36).slice(2, 7)}`, instructions: 'Solve.', deadline: new Date(inDays(5)),
        points: 10, maximumMarks: 10, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
    const s = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', a.id).attach('files', PDF, 'work.pdf').expect(201);
    await ctx.http().patch(`/api/v1/submissions/${s.body.id}/assign`).set(bearer(admin)).send({ mentorId }).expect(200);
    await waitForEvents();
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorJ2, studentJ] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.j2', 'student.j'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('each role sees the notifications it receives, all on by default', async () => {
    const mentor = await ctx.http().get('/api/v1/me/notification-settings').set(bearer(mentorJ)).expect(200);
    const mentorTypes = mentor.body.settings.map((s: any) => s.type);
    expect(mentorTypes).toEqual(expect.arrayContaining([
      'submissions.assigned', 'review.rejected', 'assignment.published', 'assignment.rejected',
      'discussion.thread_created', 'discussion.comment_posted',
    ]));
    expect(mentorTypes).not.toContain('moderation.content_reported');
    expect(mentor.body.settings.find((s: any) => s.type === 'submissions.assigned')).toMatchObject({
      label: 'Submissions assigned to you', category: 'REVIEWS', inAppEnabled: true,
      emailAvailable: true, emailEnabled: true, categoryEmailEnabled: true,
    });
    expect(mentor.body.settings.find((s: any) => s.type === 'discussion.thread_created'))
      .toMatchObject({ emailAvailable: false, emailEnabled: false });

    const forAdmin = await ctx.http().get('/api/v1/me/notification-settings').set(bearer(admin)).expect(200);
    const adminTypes = forAdmin.body.settings.map((s: any) => s.type);
    expect(adminTypes).toEqual(expect.arrayContaining(['assignment.submitted_for_review', 'review.returned', 'moderation.content_reported']));
    expect(adminTypes).not.toContain('submissions.assigned');
    expect(forAdmin.body.settings.every((s: any) => s.inAppEnabled)).toBe(true);
  });

  it('students do not have these settings', async () => {
    await ctx.http().get('/api/v1/me/notification-settings').set(bearer(studentJ)).expect(403);
    await ctx.http().patch('/api/v1/me/notification-settings').set(bearer(studentJ))
      .send({ settings: [{ type: 'results.published', inAppEnabled: false }] }).expect(403);
    await ctx.http().get('/api/v1/me/notification-settings').expect(401);
  });

  it('a mentor switches a notification off, in the app and by e-mail', async () => {
    const res = await ctx.http().patch('/api/v1/me/notification-settings').set(bearer(mentorJ))
      .send({ settings: [{ type: 'submissions.assigned', inAppEnabled: false, emailEnabled: false }] }).expect(200);
    expect(res.body.settings.find((s: any) => s.type === 'submissions.assigned')).toMatchObject({ inAppEnabled: false, emailEnabled: false });

    const mailBefore = await outbox(ctx.ids.mentorJunior);
    await assignWork(ctx.ids.mentorJunior);
    expect(await inbox(ctx.ids.mentorJunior, 'submissions.assigned')).toBe(0);
    expect(await outbox(ctx.ids.mentorJunior)).toBe(mailBefore);

    // Another mentor's settings are their own: they get it in the app and by e-mail.
    await assignWork(ctx.ids.mentorJunior2);
    expect(await inbox(ctx.ids.mentorJunior2, 'submissions.assigned')).toBe(1);
    expect(await outbox(ctx.ids.mentorJunior2)).toBeGreaterThan(0);
  });

  it('e-mail and in-app are separate switches', async () => {
    await ctx.http().patch('/api/v1/me/notification-settings').set(bearer(mentorJ2))
      .send({ settings: [{ type: 'submissions.assigned', emailEnabled: false }] }).expect(200);
    const mailBefore = await outbox(ctx.ids.mentorJunior2);
    await assignWork(ctx.ids.mentorJunior2);
    expect(await inbox(ctx.ids.mentorJunior2, 'submissions.assigned')).toBe(2);
    expect(await outbox(ctx.ids.mentorJunior2)).toBe(mailBefore);

    // Changing one switch leaves the other as it was.
    const res = await ctx.http().patch('/api/v1/me/notification-settings').set(bearer(mentorJ))
      .send({ settings: [{ type: 'submissions.assigned', inAppEnabled: true }] }).expect(200);
    expect(res.body.settings.find((s: any) => s.type === 'submissions.assigned')).toMatchObject({ inAppEnabled: true, emailEnabled: false });
  });

  it('an administrator switches off reported-content alerts; other admins\' notifications are unaffected', async () => {
    await ctx.http().patch('/api/v1/me/notification-settings').set(bearer(admin))
      .send({ settings: [{ type: 'moderation.content_reported', inAppEnabled: false }] }).expect(200);

    const t = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(mentorJ))
      .send({ title: 'Office hours', content: 'Thursdays.', divisionId: ctx.ids.junior }).expect(201);
    await ctx.http().post(`/api/v1/threads/${t.body.id}/report`).set(bearer(studentJ)).send({ reason: 'SPAM' }).expect(201);
    await waitForEvents();
    expect(await inbox(ctx.ids.admin, 'moderation.content_reported')).toBe(0);

    // Unswitched types still arrive.
    await ctx.http().post(`/api/v1/threads/${t.body.id}/comments`).set(bearer(studentJ)).send({ content: 'Thanks!' }).expect(201);
    await waitForEvents();
    expect(await inbox(ctx.ids.mentorJunior, 'discussion.comment_posted')).toBe(1);
  });

  it('rejects types the role does not receive, unknown types, and e-mail switches on in-app-only types', async () => {
    const send = (token: string, settings: unknown[]) =>
      ctx.http().patch('/api/v1/me/notification-settings').set(bearer(token)).send({ settings });

    expect((await send(mentorJ, [{ type: 'moderation.content_reported', inAppEnabled: false }]).expect(400)).body.code)
      .toBe('UNKNOWN_NOTIFICATION_TYPE');
    expect((await send(admin, [{ type: 'submissions.assigned', inAppEnabled: false }]).expect(400)).body.code)
      .toBe('UNKNOWN_NOTIFICATION_TYPE');
    expect((await send(admin, [{ type: 'made.up', inAppEnabled: false }]).expect(400)).body.code).toBe('UNKNOWN_NOTIFICATION_TYPE');
    expect((await send(mentorJ, [{ type: 'discussion.thread_created', emailEnabled: true }]).expect(400)).body.code)
      .toBe('EMAIL_NOT_AVAILABLE');
    expect((await send(mentorJ, [{ type: 'review.rejected' }]).expect(400)).body.code).toBe('NO_CHANGES');
    expect((await send(mentorJ, [
      { type: 'review.rejected', inAppEnabled: false }, { type: 'review.rejected', inAppEnabled: true },
    ]).expect(400)).body.code).toBe('DUPLICATE_NOTIFICATION_TYPE');
    await send(mentorJ, []).expect(400);
    await send(mentorJ, [{ type: 'review.rejected', inAppEnabled: 'no' }]).expect(400);
  });

  it('reset turns everything back on', async () => {
    const res = await ctx.http().post('/api/v1/me/notification-settings/reset').set(bearer(mentorJ)).expect(200);
    expect(res.body.settings.every((s: any) => s.inAppEnabled && (s.emailEnabled || !s.emailAvailable))).toBe(true);
    await assignWork(ctx.ids.mentorJunior);
    expect(await inbox(ctx.ids.mentorJunior, 'submissions.assigned')).toBe(1);
  });

  it('the category e-mail preference is shown alongside each switch', async () => {
    await ctx.http().put('/api/v1/me/notification-preferences').set(bearer(mentorJ))
      .send({ preferences: [{ category: 'REVIEWS', emailEnabled: false }] }).expect(200);
    const res = await ctx.http().get('/api/v1/me/notification-settings').set(bearer(mentorJ)).expect(200);
    expect(res.body.settings.find((s: any) => s.type === 'submissions.assigned'))
      .toMatchObject({ emailEnabled: true, categoryEmailEnabled: false });
  });
});
