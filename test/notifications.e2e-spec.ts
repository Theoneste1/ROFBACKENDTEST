/**
 * Notifications: who is told about what (assignments, reviews, resubmission
 * requests, results, discussions), and the inbox
 * API — read/unread, timestamps, filters, and that users only ever reach
 * their own notifications.
 */
import { createTestApp, login, bearer, inDays, PDF, type TestContext, waitForEvents } from './helpers.js';

describe('Notifications (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, studentJ: string, studentJ2: string, studentS: string;
  let assignmentId: string, submissionId: string;

  const types = async (userId: string) =>
    (await ctx.prisma.notification.findMany({ where: { userId }, select: { type: true } })).map((n) => n.type);

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, studentJ, studentJ2, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'student.j', 'student.j2', 'student.s'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('who is notified', () => {
    it('new published assignments → students of that division only', async () => {
      const draft = await ctx.http().post('/api/v1/assignments').set(bearer(mentorJ))
        .field('title', 'Sequences').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
        .field('instructions', 'Find the general term.').field('deadline', inDays(0.5))
        .field('points', '10').field('maximumMarks', '10').field('allowResubmission', 'true').field('maxResubmissions', '2')
        .expect(201);
      assignmentId = draft.body.id;
      await ctx.http().patch(`/api/v1/assignments/${assignmentId}/submit`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/assignments/${assignmentId}/publish`).set(bearer(admin)).expect(200);

      await waitForEvents();
      expect(await types(ctx.ids.studentJunior)).toContain('assignment.published');
      expect(await types(ctx.ids.studentJunior2)).toContain('assignment.published');
      expect(await types(ctx.ids.studentSenior)).not.toContain('assignment.published');
      expect(await types(ctx.ids.admin)).toContain('assignment.submitted_for_review');
    });

    it('no automatic "due soon" reminders are sent', async () => {
      const sub = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', 'a_n = 2n + 1').attach('files', PDF, 'work.pdf').expect(201);
      submissionId = sub.body.id;

      // The deadline is 12 hours away; nobody is reminded.
      await waitForEvents();
      expect(await types(ctx.ids.studentJunior2)).not.toContain('assignment.deadline_approaching');
    });

    it('submissions awaiting review → the mentor they are assigned to', async () => {
      await waitForEvents();
      // The student gets a receipt.
      expect(await types(ctx.ids.studentJunior)).toContain('submission.received');
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await waitForEvents();
      expect(await types(ctx.ids.mentorJunior)).toContain('submissions.assigned');
      expect(await types(ctx.ids.mentorJunior2)).not.toContain('submissions.assigned');
    });

    it('resubmission requests → the student', async () => {
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/start-review`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'Justify the general term.', dueAt: inDays(4) }).expect(200);
      await waitForEvents();
      expect(await types(ctx.ids.studentJunior)).toContain('submission.resubmission_requested');
      expect(await types(ctx.ids.studentJunior2)).not.toContain('submission.resubmission_requested');
    });

    it('published results → the student, with a link to the result', async () => {
      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', 'a_n = 2n + 1, by induction …').expect(201);
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/start-review`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/mark`).set(bearer(mentorJ))
        .field('score', '9').field('mentorFeedback', 'Well justified.').expect(200);
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/approve`).set(bearer(admin)).send({}).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${submissionId}/publish`).set(bearer(admin)).expect(200);

      await waitForEvents();
      const n = await ctx.prisma.notification.findFirstOrThrow({ where: { userId: ctx.ids.studentJunior, type: 'results.published' } });
      expect(n).toMatchObject({ category: 'RESULTS', link: `/results/${submissionId}` });
      expect(await types(ctx.ids.studentJunior2)).not.toContain('results.published');
    });

    it('discussion activity → the people concerned', async () => {
      const t = await ctx.http().post(`/api/v1/assignments/${assignmentId}/threads`).set(bearer(studentJ2))
        .send({ title: 'Is n from 0 or 1?', content: 'Where does the sequence start?' }).expect(201);
      await ctx.http().post(`/api/v1/threads/${t.body.id}/comments`).set(bearer(mentorJ)).send({ content: 'From 1.' }).expect(201);

      await waitForEvents();
      expect(await types(ctx.ids.mentorJunior)).toContain('discussion.thread_created');
      expect(await types(ctx.ids.studentJunior2)).toContain('discussion.comment_posted');
      expect(await types(ctx.ids.studentSenior)).toEqual([]);
    });
  });

  describe('inbox', () => {
    it('lists the caller\'s notifications newest first, with timestamps, read state and links', async () => {
      const res = await ctx.http().get('/api/v1/notifications').set(bearer(studentJ2)).expect(200);
      const times = res.body.data.map((n: any) => Date.parse(n.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      for (const n of res.body.data) {
        expect(n).toMatchObject({ isRead: false, readAt: null, createdAt: expect.any(String) });
        expect(n).not.toHaveProperty('userId');
      }
      expect(res.body.data.find((n: any) => n.type === 'assignment.published').link).toBe(`/assignments/${assignmentId}`);
    });

    it('filters by category, type and unread', async () => {
      const assignments = await ctx.http().get('/api/v1/notifications').query({ category: 'ASSIGNMENTS' }).set(bearer(studentJ2)).expect(200);
      expect(new Set(assignments.body.data.map((n: any) => n.category))).toEqual(new Set(['ASSIGNMENTS']));
      const published = await ctx.http().get('/api/v1/notifications').query({ type: 'assignment.published' }).set(bearer(studentJ2)).expect(200);
      expect(published.body.meta.total).toBe(1);
      await ctx.http().get('/api/v1/notifications').query({ category: 'GOSSIP' }).set(bearer(studentJ2)).expect(400);
    });

    it('marks read and unread, one, several or all; counts unread per category', async () => {
      const before = await ctx.http().get('/api/v1/notifications/unread-count').set(bearer(studentJ2)).expect(200);
      expect(before.body.byCategory).toEqual({ ASSIGNMENTS: 1, SUBMISSIONS: 0, REVIEWS: 0, RESULTS: 0, RESOURCES: 0, ACCOUNT: 0, DISCUSSIONS: 1 });
      expect(before.body.unread).toBe(2);

      const list = await ctx.http().get('/api/v1/notifications').set(bearer(studentJ2)).expect(200);
      const [first, second] = list.body.data.map((n: any) => n.id);

      expect((await ctx.http().patch(`/api/v1/notifications/${first}/read`).set(bearer(studentJ2)).expect(200)).body.updated).toBe(1);
      const one = await ctx.http().get(`/api/v1/notifications/${first}`).set(bearer(studentJ2)).expect(200);
      expect(one.body).toMatchObject({ isRead: true, readAt: expect.any(String) });

      await ctx.http().patch(`/api/v1/notifications/${first}/unread`).set(bearer(studentJ2)).expect(200);
      const batch = await ctx.http().post('/api/v1/notifications/read').set(bearer(studentJ2)).send({ ids: [first, second] }).expect(200);
      expect(batch.body.updated).toBe(2);
      expect((await ctx.http().get('/api/v1/notifications/unread-count').set(bearer(studentJ2))).body.unread).toBe(0);

      await ctx.http().post('/api/v1/notifications/read').set(bearer(studentJ2)).send({ ids: [] }).expect(400);
      await ctx.http().post('/api/v1/notifications/read').set(bearer(studentJ2)).send({ ids: ['not-a-uuid'] }).expect(400);

      await ctx.http().post('/api/v1/notifications/read-all').set(bearer(studentJ2)).expect(201);
      const unread = await ctx.http().get('/api/v1/notifications').query({ unreadOnly: true }).set(bearer(studentJ2)).expect(200);
      expect(unread.body.meta.total).toBe(0);
    });

    it('nobody can read or change another user\'s notifications', async () => {
      const mine = await ctx.prisma.notification.findFirstOrThrow({ where: { userId: ctx.ids.studentJunior, readAt: null } });

      await ctx.http().get(`/api/v1/notifications/${mine.id}`).set(bearer(studentJ2)).expect(404);
      await ctx.http().get(`/api/v1/notifications/${mine.id}`).set(bearer(admin)).expect(404);
      expect((await ctx.http().patch(`/api/v1/notifications/${mine.id}/read`).set(bearer(studentJ2)).expect(200)).body.updated).toBe(0);
      expect((await ctx.http().post('/api/v1/notifications/read').set(bearer(admin)).send({ ids: [mine.id] }).expect(200)).body.updated).toBe(0);
      expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).toBeNull();

      const others = await ctx.http().get('/api/v1/notifications').set(bearer(studentS)).expect(200);
      expect(others.body.data).toEqual([]);
      await ctx.http().get('/api/v1/notifications').expect(401);
      await ctx.http().get(`/api/v1/notifications/${mine.id}`).expect(401);
    });
  });

  it('there is no private messaging through notifications', async () => {
    await ctx.http().post('/api/v1/notifications').set(bearer(studentJ)).send({ userId: ctx.ids.studentJunior2, body: 'hi' }).expect(404);
    await ctx.http().post(`/api/v1/users/${ctx.ids.studentJunior2}/notifications`).set(bearer(studentJ)).send({ body: 'hi' }).expect(404);
  });
});
