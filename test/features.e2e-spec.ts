/**
 * Discussions, live sessions, notifications, e-mail outbox, admin tools.
 */
import { EmailWorker } from '../src/email/email.worker.js';
import { LiveSessionsService } from '../src/live-sessions/live-sessions.service.js';
import { createTestApp, login, bearer, inDays, type TestContext, waitForEvents } from './helpers.js';

describe('Features (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorS: string, studentJ: string, studentJ2: string, studentS: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorS, studentJ, studentJ2, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.s', 'student.j', 'student.j2', 'student.s'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('discussions', () => {
    let threadId: string;
    let questionId: string;

    it('course threads are separate per division', async () => {
      const t = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
        .send({ title: 'Factoring quadratics', content: 'How do I factor x² − 5x + 6?' }).expect(201);
      expect(t.body).toMatchObject({ title: 'Factoring quadratics', status: 'OPEN', divisionId: ctx.ids.junior });
      threadId = t.body.id;

      await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentS))
        .send({ title: 'Inequalities', content: 'Senior question about inequalities' }).expect(201);

      const junior = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ)).expect(200);
      expect(junior.body.data.map((x: any) => x.title)).toEqual(['Factoring quadratics']);
      await ctx.http().get(`/api/v1/threads/${threadId}`).set(bearer(studentS)).expect(404);

      // Mentors must say which division; and only one they teach.
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(mentorJ)).expect(400);
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`).query({ divisionId: ctx.ids.senior })
        .set(bearer(mentorJ)).expect(403);
      const forMentor = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`)
        .query({ divisionId: ctx.ids.junior }).set(bearer(mentorJ)).expect(200);
      expect(forMentor.body.meta.total).toBe(1);

      const comments = await ctx.http().get(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ)).expect(200);
      questionId = comments.body.data[0].id;
    });

    it('replies, reactions, author-only edits', async () => {
      await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(mentorJ))
        .send({ content: 'Find two numbers that multiply to 6 and add to −5.', parentId: questionId }).expect(201);
      const replies = await ctx.http().get(`/api/v1/comments/${questionId}/replies`).set(bearer(studentJ)).expect(200);
      expect(replies.body.data).toHaveLength(1);

      const r = await ctx.http().post(`/api/v1/comments/${questionId}/reactions`).set(bearer(studentJ)).send({ type: 'HELPFUL' }).expect(201);
      expect(r.body.reacted).toBe(true);

      await ctx.http().patch(`/api/v1/comments/${questionId}`).set(bearer(mentorJ)).send({ content: 'edited' }).expect(403);
      const edited = await ctx.http().patch(`/api/v1/comments/${questionId}`).set(bearer(studentJ))
        .send({ content: 'How do I factor x² − 5x + 6? (edited)' }).expect(200);
      expect(edited.body.editedAt).toBeTruthy();
    });

    it('content reports → moderation queue → action recorded', async () => {
      const report = await ctx.http().post(`/api/v1/comments/${questionId}/report`).set(bearer(studentJ2))
        .send({ reason: 'OFF_TOPIC', details: 'Not about this course' }).expect(201);
      expect(report.body.status).toBe('OPEN');
      const again = await ctx.http().post(`/api/v1/comments/${questionId}/report`).set(bearer(studentJ2))
        .send({ reason: 'SPAM' }).expect(409);
      expect(again.body.code).toBe('ALREADY_REPORTED');
      // Authors cannot report themselves; students cannot moderate.
      await ctx.http().post(`/api/v1/comments/${questionId}/report`).set(bearer(studentJ)).send({ reason: 'SPAM' }).expect(400);
      await ctx.http().get('/api/v1/admin/moderation/reports').set(bearer(studentJ)).expect(403);

      const queue = await ctx.http().get('/api/v1/admin/moderation/reports').set(bearer(admin)).expect(200);
      expect(queue.body.meta.total).toBe(1);

      const resolved = await ctx.http().post(`/api/v1/admin/moderation/reports/${report.body.id}/resolve`).set(bearer(admin))
        .send({ action: 'HIDE', note: 'Off topic' }).expect(200);
      expect(resolved.body.status).toBe('RESOLVED');

      // Hidden for students, visible to admins.
      const forStudent = await ctx.http().get(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ)).expect(200);
      expect(forStudent.body.data).toHaveLength(0);
      const forAdmin = await ctx.http().get(`/api/v1/threads/${threadId}/comments`).set(bearer(admin)).expect(200);
      expect(forAdmin.body.data[0].status).toBe('HIDDEN');

      await ctx.http().patch(`/api/v1/comments/${questionId}/restore`).set(bearer(admin)).send({ reason: 'Reviewed again' }).expect(200);

      const actions = await ctx.http().get('/api/v1/admin/moderation/actions').set(bearer(admin)).expect(200);
      expect(actions.body.data.map((a: any) => a.action)).toEqual(['RESTORE_COMMENT', 'HIDE_COMMENT']);
    });

    it('locked threads accept no replies; pin and archive are moderation actions', async () => {
      await ctx.http().patch(`/api/v1/threads/${threadId}/lock`).set(bearer(admin)).send({}).expect(200);
      const blocked = await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ))
        .send({ content: 'one more?' }).expect(409);
      expect(blocked.body.code).toBe('INVALID_STATE_TRANSITION');
      await ctx.http().patch(`/api/v1/threads/${threadId}/explode`).set(bearer(admin)).send({}).expect(400);
      await ctx.http().patch(`/api/v1/threads/${threadId}/pin`).set(bearer(admin)).send({}).expect(200);
      await ctx.http().patch(`/api/v1/threads/${threadId}/archive`).set(bearer(admin)).send({}).expect(200);
      const t = await ctx.http().get(`/api/v1/threads/${threadId}`).set(bearer(studentJ)).expect(200);
      expect(t.body).toMatchObject({ status: 'ARCHIVED', isPinned: true });
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
    it('starting a new academic year promotes students, keeps history and archives old assignments', async () => {
      const oldAssignment = await ctx.prisma.assignment.create({
        data: {
          title: 'Last year', instructions: 'Old work.', deadline: new Date(inDays(2)), points: 1, maximumMarks: 1,
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
          createdById: ctx.ids.mentorJunior, status: 'PUBLISHED',
        },
      });

      const next = await ctx.http().post('/api/v1/admin/academic-years').set(bearer(admin))
        .send({ name: '2027-2028', startsOn: '2027-09-01', endsOn: '2028-07-31' }).expect(201);
      expect(next.body.status).toBe('PLANNED');

      const res = await ctx.http().post(`/api/v1/admin/academic-years/${next.body.id}/activate`).set(bearer(admin))
        .send({ promoteStudents: true }).expect(200);
      expect(res.body).toMatchObject({ promoted: 3, assignmentsArchived: 1 });
      expect(res.body.academicYear).toMatchObject({ status: 'ACTIVE', isCurrent: true });

      // S3 moves into the senior division; the old year's enrolment is kept as PROMOTED.
      const s3 = await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior2 } });
      expect(s3).toMatchObject({ gradeLevel: 'S4', divisionId: ctx.ids.senior });
      const history = await ctx.prisma.studentEnrollment.findMany({
        where: { studentId: ctx.ids.studentJunior2 }, orderBy: { enrolledAt: 'asc' },
      });
      expect(history.map((e) => [e.gradeLevel, e.status])).toEqual([['S3', 'PROMOTED'], ['S4', 'ACTIVE']]);

      const old = await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } });
      expect(old).toMatchObject({ status: 'CLOSED', isCurrent: null });
      expect((await ctx.prisma.assignment.findUniqueOrThrow({ where: { id: oldAssignment.id } })).status).toBe('ARCHIVED');

      // The student's own enrolment history.
      const mine = await ctx.http().get('/api/v1/me/enrollments').set(bearer(studentJ)).expect(200);
      expect(mine.body.map((e: any) => e.gradeLevel)).toEqual(['S3', 'S2']);

      // Only one current year can exist (database-enforced).
      await expect(ctx.prisma.academicYear.update({ where: { id: ctx.ids.year }, data: { isCurrent: true } })).rejects.toThrow();
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
      const res = await ctx.http().get('/api/v1/admin/audit-logs').query({ action: 'ACTIVATE_ACADEMIC_YEAR' }).set(bearer(admin)).expect(200);
      expect(res.body.meta.total).toBe(1);
    });
  });
describe('records, permissions and retention', () => {
    it('activity log records learning activity; admins can query it', async () => {
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(studentJ)).expect(200);
      await new Promise((r) => setTimeout(r, 200));
      const res = await ctx.http().get('/api/v1/admin/activity').query({ userId: ctx.ids.studentJunior }).set(bearer(admin)).expect(200);
      const types = res.body.data.map((a: any) => a.type);
      expect(types).toEqual(expect.arrayContaining(['LOGIN', 'COURSE_OPENED', 'THREAD_CREATED']));
      const summary = await ctx.http().get('/api/v1/admin/activity/summary').set(bearer(admin)).expect(200);
      expect(summary.body.activeUsers).toBeGreaterThan(0);
      await ctx.http().get('/api/v1/admin/activity').set(bearer(mentorJ)).expect(403);
    });

    it('permissions map per role', async () => {
      const s = await ctx.http().get('/api/v1/me/permissions').set(bearer(studentJ)).expect(200);
      expect(s.body.permissions).toContain('submissions.submit');
      expect(s.body.permissions).not.toContain('reviews.grade');
      const a = await ctx.http().get('/api/v1/me/permissions').set(bearer(admin)).expect(200);
      expect(a.body.permissions).toContain('results.publish');
      expect(a.body.permissions).not.toContain('reviews.grade');
      const m = await ctx.http().get('/api/v1/me/permissions').set(bearer(mentorJ)).expect(200);
      expect(m.body.permissions).toContain('reviews.grade');
    });

    it('archived courses and resources disappear for students but are kept', async () => {
      const res = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'Old notes').expect(201);
      await ctx.http().patch(`/api/v1/courses/${ctx.ids.algebra}/resources/${res.body.id}/publish`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/courses/${ctx.ids.algebra}/resources/${res.body.id}/archive`).set(bearer(mentorJ)).expect(200);
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/resources/${res.body.id}`).set(bearer(studentJ)).expect(404);
      const staff = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/resources`)
        .query({ divisionId: ctx.ids.junior, includeArchived: true }).set(bearer(mentorJ)).expect(200);
      expect(staff.body.some((r: any) => r.id === res.body.id && r.archivedAt)).toBe(true);

      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.geometry}/archive`).set(bearer(admin)).expect(200);
      const courses = await ctx.http().get('/api/v1/courses').set(bearer(studentJ)).expect(200);
      expect(courses.body.map((c: any) => c.code)).not.toContain('GEOMETRY');
      expect(courses.body[0].discipline).toMatchObject({ code: 'MATHEMATICS' });

      const disciplines = await ctx.http().get('/api/v1/disciplines').set(bearer(studentJ)).expect(200);
      expect(disciplines.body.map((d: any) => d.code)).toEqual(['MATHEMATICS']);
    });

    it('retention purges old activity and read notifications only', async () => {
      const { RetentionService } = await import('../src/activity/retention.service.js');
      const old = new Date(Date.now() - 500 * 86_400_000);
      await ctx.prisma.activityLog.create({ data: { userId: ctx.ids.studentJunior, type: 'LOGIN', createdAt: old } });
      await ctx.prisma.notification.create({
        data: { userId: ctx.ids.studentJunior, category: 'ACCOUNT', type: 't', title: 't', body: 'b', readAt: old, createdAt: old },
      });
      const result = await ctx.app.get(RetentionService).run();
      expect(result.activityDeleted).toBe(1);
      expect(result.notificationsDeleted).toBe(1);
      expect(await ctx.prisma.activityLog.count({ where: { userId: ctx.ids.studentJunior } })).toBeGreaterThan(0);
    });
  });
});
