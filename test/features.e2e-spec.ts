/**
 * Discussions, live sessions, notifications, e-mail outbox, admin tools.
 */
import { EmailWorker } from '../src/email/email.worker.js';
import { LiveSessionsService } from '../src/live-sessions/live-sessions.service.js';
import { createTestApp, login, bearer, inDays, type TestContext } from './helpers.js';

const waitForEvents = () => new Promise((r) => setTimeout(r, 300));

describe('Features (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorS: string, studentJ: string, studentS: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorS, studentJ, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.s', 'student.j', 'student.s'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('discussions', () => {
    it('course threads are separate per division', async () => {
      await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(studentJ))
        .send({ content: 'How do I factor x² − 5x + 6?' }).expect(201);
      await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(studentS))
        .send({ content: 'Senior question about inequalities' }).expect(201);

      const junior = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(studentJ)).expect(200);
      expect(junior.body.data.map((c: any) => c.content)).toEqual(['How do I factor x² − 5x + 6?']);

      // Mentors must say which division's thread; and only one they teach.
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(mentorJ)).expect(400);
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/comments`).query({ divisionId: ctx.ids.senior })
        .set(bearer(mentorJ)).expect(403);
      const forMentor = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/comments`)
        .query({ divisionId: ctx.ids.junior }).set(bearer(mentorJ)).expect(200);
      expect(forMentor.body.meta.total).toBe(1);
    });

    it('replies, reactions and moderation', async () => {
      const list = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(studentJ));
      const questionId = list.body.data[0].id;

      await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(mentorJ))
        .send({ content: 'Find two numbers that multiply to 6 and add to −5.', parentId: questionId, divisionId: ctx.ids.junior })
        .expect(201);

      const r = await ctx.http().post(`/api/v1/comments/${questionId}/reactions`).set(bearer(studentJ)).send({ type: 'HELPFUL' }).expect(201);
      expect(r.body.reacted).toBe(true);

      // Only the author edits; admins moderate.
      await ctx.http().patch(`/api/v1/comments/${questionId}`).set(bearer(mentorJ)).send({ content: 'edited' }).expect(403);
      await ctx.http().patch(`/api/v1/comments/${questionId}/hide`).set(bearer(admin)).expect(200);

      const afterHide = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/comments`).set(bearer(studentJ));
      expect(afterHide.body.data).toHaveLength(0);
      await ctx.http().get(`/api/v1/comments/${questionId}/replies`).set(bearer(studentJ)).expect(404);

      const queue = await ctx.http().get('/api/v1/admin/comments/hidden').set(bearer(admin)).expect(200);
      expect(queue.body.meta.total).toBe(1);
      await ctx.http().patch(`/api/v1/comments/${questionId}/restore`).set(bearer(admin)).expect(200);
    });
  });

  describe('live sessions and notifications', () => {
    let sessionId: string;

    it('mentors schedule sessions for their scope; students of that division are notified', async () => {
      await ctx.http().post('/api/v1/live-sessions').set(bearer(mentorS))
        .send({
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, title: 'Wrong scope',
          startsAt: inDays(1), endsAt: inDays(1.05), meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }).expect(403);

      const insecure = await ctx.http().post('/api/v1/live-sessions').set(bearer(mentorJ))
        .send({
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, title: 'Revision',
          startsAt: inDays(1), endsAt: inDays(1.05), meetingUrl: 'http://example.com/meet',
        }).expect(400);
      expect(insecure.body.code).toBe('VALIDATION_FAILED');

      const res = await ctx.http().post('/api/v1/live-sessions').set(bearer(mentorJ))
        .send({
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, title: 'Revision: quadratics',
          startsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          endsAt:   new Date(Date.now() + 90 * 60_000).toISOString(),
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }).expect(201);
      expect(res.body.provider).toBe('GOOGLE_MEET');
      sessionId = res.body.id;

      await waitForEvents();
      const notes = await ctx.http().get('/api/v1/notifications').set(bearer(studentJ)).expect(200);
      expect(notes.body.data.some((n: any) => n.data?.sessionId === sessionId)).toBe(true);

      const seniorNotes = await ctx.http().get('/api/v1/notifications').set(bearer(studentS)).expect(200);
      expect(seniorNotes.body.data.some((n: any) => n.data?.sessionId === sessionId)).toBe(false);

      const seniorList = await ctx.http().get('/api/v1/live-sessions').set(bearer(studentS)).expect(200);
      expect(seniorList.body.data).toHaveLength(0);
    });

    it('sends one reminder per session', async () => {
      const service = ctx.app.get(LiveSessionsService);
      expect(await service.sendReminders()).toBe(1);
      expect(await service.sendReminders()).toBe(0);
    });

    it('notification read state and e-mail preferences', async () => {
      const count = await ctx.http().get('/api/v1/notifications/unread-count').set(bearer(studentJ)).expect(200);
      expect(count.body.unread).toBeGreaterThan(0);
      await ctx.http().post('/api/v1/notifications/read-all').set(bearer(studentJ)).expect(201);
      const after = await ctx.http().get('/api/v1/notifications/unread-count').set(bearer(studentJ));
      expect(after.body.unread).toBe(0);

      const prefs = await ctx.http().put('/api/v1/me/notification-preferences').set(bearer(studentJ))
        .send({ preferences: [{ category: 'LIVE_SESSIONS', emailEnabled: false }, { category: 'ACCOUNT', emailEnabled: false }] })
        .expect(200);
      expect(prefs.body.find((p: any) => p.category === 'LIVE_SESSIONS').emailEnabled).toBe(false);
      expect(prefs.body.find((p: any) => p.category === 'ACCOUNT').emailEnabled).toBe(true); // locked
    });

    it('cancelling withholds the meeting link from students', async () => {
      await ctx.http().post(`/api/v1/live-sessions/${sessionId}/cancel`).set(bearer(mentorJ)).send({ reason: 'Holiday' }).expect(200);
      const s = await ctx.http().get(`/api/v1/live-sessions/${sessionId}`).set(bearer(studentJ)).expect(200);
      expect(s.body).toMatchObject({ status: 'CANCELLED', meetingUrl: null });
    });
  });

  describe('e-mail outbox', () => {
    it('bulk e-mail is idempotent and delivered by the worker', async () => {
      const body = {
        idempotencyKey: 'term-start-2026', recipientMode: 'DIVISION', recipientDivisionId: ctx.ids.junior,
        subject: 'Welcome back', body: 'Term starts on Monday.',
      };
      const first = await ctx.http().post('/api/v1/admin/email/send').set(bearer(admin)).send(body).expect(201);
      expect(first.body).toMatchObject({ totalRecipients: 2, alreadyExisted: false });
      const second = await ctx.http().post('/api/v1/admin/email/send').set(bearer(admin)).send(body).expect(201);
      expect(second.body).toMatchObject({ id: first.body.id, alreadyExisted: true });

      // Drain everything (notification e-mails included) in dry-run mode.
      const worker = ctx.app.get(EmailWorker);
      while ((await worker.processBatch()) > 0) { /* keep draining */ }

      const job = await ctx.http().get(`/api/v1/admin/email/jobs/${first.body.id}`).set(bearer(admin)).expect(200);
      expect(job.body).toMatchObject({ status: 'COMPLETED', sentCount: 2, failedCount: 0 });
      expect(await ctx.prisma.emailDelivery.count({ where: { status: 'PENDING' } })).toBe(0);
    });
  });

  describe('admin tools', () => {
    it('promotes students a grade, moving S3 into the senior division', async () => {
      await ctx.http().post('/api/v1/admin/users/promote-students').set(bearer(admin)).send({ graduateS6: false }).expect(200);
      const s3 = await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior2 } });
      expect(s3).toMatchObject({ gradeLevel: 'S4', divisionId: ctx.ids.senior });
    });

    it('settings reject unknown keys and wrong types', async () => {
      const res = await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin))
        .send({ 'nope': true, 'leaderboard.visibleToStudents': 'yes' }).expect(400);
      expect(res.body.details).toHaveLength(2);
    });

    it('hiding the leaderboard from students', async () => {
      await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'leaderboard.visibleToStudents': false }).expect(200);
      const res = await ctx.http().get('/api/v1/leaderboard').set(bearer(studentJ)).expect(403);
      expect(res.body.code).toBe('LEADERBOARD_HIDDEN');
      await ctx.http().get('/api/v1/leaderboard').query({ divisionId: ctx.ids.junior }).set(bearer(admin)).expect(200);
    });

    it('users with academic history cannot be hard-deleted', async () => {
      const res = await ctx.http().delete(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).expect(409);
      expect(res.body.code).toBe('USER_HAS_HISTORY');
    });

    it('audit log records actions and caps page size', async () => {
      await ctx.http().get('/api/v1/admin/audit-logs').query({ limit: 1000 }).set(bearer(admin)).expect(400);
      const res = await ctx.http().get('/api/v1/admin/audit-logs').query({ action: 'PROMOTE' }).set(bearer(admin)).expect(200);
      expect(res.body.meta.total).toBe(1);
    });
  });
});
