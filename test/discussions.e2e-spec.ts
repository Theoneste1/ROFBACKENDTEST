/**
 * Discussions and moderation: assignment and course threads, edit/delete
 * permissions, reports with snapshots, administrators hiding and removing
 * content, the moderation record, and discussion notifications.
 */
import { createTestApp, login, bearer, inDays, type TestContext } from './helpers.js';

const waitForEvents = () => new Promise((r) => setTimeout(r, 300));

describe('Discussions and moderation (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, studentJ: string, studentJ2: string, studentS: string;
  let assignmentId: string;
  let threadId: string, questionId: string, answerId: string;

  const notes = (userId: string, type: string) =>
    ctx.prisma.notification.findMany({ where: { userId, type }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, studentJ, studentJ2, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'student.j', 'student.j2', 'student.s'].map((u) => login(ctx, u)),
    );
    const a = await ctx.prisma.assignment.create({
      data: {
        title: 'Number theory set', instructions: 'Solve.', deadline: new Date(inDays(5)),
        points: 10, maximumMarks: 10, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
    assignmentId = a.id;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('assignment discussions', () => {
    it('a student starts a thread on an assignment; its mentors are notified', async () => {
      const t = await ctx.http().post(`/api/v1/assignments/${assignmentId}/threads`).set(bearer(studentJ))
        .send({ title: 'Question 2 wording', content: 'Does "integer" include negatives?' }).expect(201);
      expect(t.body).toMatchObject({ assignmentId, courseId: null, divisionId: ctx.ids.junior, status: 'OPEN' });
      threadId = t.body.id;

      const list = await ctx.http().get(`/api/v1/assignments/${assignmentId}/threads`).set(bearer(studentJ2)).expect(200);
      expect(list.body.data.map((x: any) => x.id)).toEqual([threadId]);
      // Another division cannot see the assignment or its threads.
      await ctx.http().get(`/api/v1/assignments/${assignmentId}/threads`).set(bearer(studentS)).expect(404);
      await ctx.http().get(`/api/v1/threads/${threadId}`).set(bearer(studentS)).expect(404);

      await waitForEvents();
      expect(await notes(ctx.ids.mentorJunior, 'discussion.thread_created')).toHaveLength(1);
      expect(await notes(ctx.ids.mentorJunior2, 'discussion.thread_created')).toHaveLength(1);
      expect(await notes(ctx.ids.mentorSenior, 'discussion.thread_created')).toHaveLength(0);
      expect(await notes(ctx.ids.studentJunior, 'discussion.thread_created')).toHaveLength(0);

      const comments = await ctx.http().get(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ)).expect(200);
      questionId = comments.body.data[0].id;
    });

    it('replies notify the people being answered, never the poster', async () => {
      const reply = await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(mentorJ))
        .send({ content: 'Yes, negatives count.', parentId: questionId }).expect(201);
      answerId = reply.body.id;
      await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ2))
        .send({ content: 'I had the same question, thanks.' }).expect(201);
      await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ))
        .send({ content: 'Thank you!', parentId: questionId }).expect(201);

      await waitForEvents();
      // student.j: a reply to their comment, and a post in their thread.
      const forAuthor = await notes(ctx.ids.studentJunior, 'discussion.comment_posted');
      expect(forAuthor.map((n) => n.title).sort()).toEqual(['New activity in your discussion', 'New reply to your comment']);
      // Nobody is notified about their own posts.
      expect(await notes(ctx.ids.mentorJunior, 'discussion.comment_posted')).toHaveLength(0);
      expect(await notes(ctx.ids.studentJunior2, 'discussion.comment_posted')).toHaveLength(0);
    });

    it('reactions toggle on and off', async () => {
      const on = await ctx.http().post(`/api/v1/comments/${answerId}/reactions`).set(bearer(studentJ)).send({ type: 'HELPFUL' }).expect(201);
      expect(on.body.reacted).toBe(true);
      const off = await ctx.http().post(`/api/v1/comments/${answerId}/reactions`).set(bearer(studentJ)).send({ type: 'HELPFUL' }).expect(201);
      expect(off.body.reacted).toBe(false);
      await ctx.http().post(`/api/v1/comments/${answerId}/reactions`).set(bearer(studentJ)).send({ type: 'LOVE' }).expect(400);
    });
  });

  describe('editing and deleting', () => {
    it('only authors edit; non-admins cannot remove other people\'s content', async () => {
      await ctx.http().patch(`/api/v1/threads/${threadId}`).set(bearer(studentJ2)).send({ title: 'Hijacked' }).expect(403);
      await ctx.http().patch(`/api/v1/threads/${threadId}`).set(bearer(studentJ)).send({ title: 'Question 2: integers' }).expect(200);
      await ctx.http().patch(`/api/v1/comments/${answerId}`).set(bearer(studentJ)).send({ content: 'No.' }).expect(403);

      await ctx.http().delete(`/api/v1/comments/${answerId}`).set(bearer(studentJ)).expect(403);
      await ctx.http().delete(`/api/v1/threads/${threadId}`).set(bearer(studentJ2)).expect(403);
      // Mentors are not moderators.
      await ctx.http().patch(`/api/v1/comments/${questionId}/hide`).set(bearer(mentorJ)).send({}).expect(403);
      await ctx.http().patch(`/api/v1/threads/${threadId}/lock`).set(bearer(mentorJ)).send({}).expect(403);
    });

    it('an author cannot delete a thread others have answered, but can delete their own comments', async () => {
      const blocked = await ctx.http().delete(`/api/v1/threads/${threadId}`).set(bearer(studentJ)).expect(409);
      expect(blocked.body.code).toBe('THREAD_HAS_REPLIES');

      const mine = await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ2))
        .send({ content: 'Posted by mistake' }).expect(201);
      await ctx.http().delete(`/api/v1/comments/${mine.body.id}`).set(bearer(studentJ2)).expect(200);
      const row = await ctx.prisma.comment.findUniqueOrThrow({ where: { id: mine.body.id } });
      expect(row).toMatchObject({ status: 'DELETED', content: '[deleted]' });
      expect(row.deletedAt).toBeInstanceOf(Date);
      // Not a moderation action.
      expect(await ctx.prisma.moderationAction.count({ where: { commentId: mine.body.id } })).toBe(0);
    });

    it('an author deletes their own unanswered thread; it disappears for everyone but admins', async () => {
      const t = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ2))
        .send({ title: 'Never mind', content: 'Figured it out.' }).expect(201);
      await ctx.http().delete(`/api/v1/threads/${t.body.id}`).set(bearer(studentJ2)).expect(200);

      await ctx.http().get(`/api/v1/threads/${t.body.id}`).set(bearer(studentJ2)).expect(404);
      const list = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ)).expect(200);
      expect(list.body.data.map((x: any) => x.id)).not.toContain(t.body.id);
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`).query({ status: 'DELETED' }).set(bearer(studentJ)).expect(404);

      const forAdmin = await ctx.http().get(`/api/v1/threads/${t.body.id}`).set(bearer(admin)).expect(200);
      expect(forAdmin.body.status).toBe('DELETED');
      expect(forAdmin.body.deletedAt).toBeTruthy();
    });
  });

  describe('reporting and moderation', () => {
    let reportId: string;

    it('users report content; the report keeps what was reported and administrators are told', async () => {
      const r = await ctx.http().post(`/api/v1/comments/${answerId}/report`).set(bearer(studentJ2))
        .send({ reason: 'INAPPROPRIATE', details: 'Rude tone' }).expect(201);
      reportId = r.body.id;
      await ctx.http().post(`/api/v1/threads/${threadId}/report`).set(bearer(studentJ)).send({ reason: 'SPAM' }).expect(400);

      // The author edits afterwards; the report still shows the original text.
      await ctx.http().patch(`/api/v1/comments/${answerId}`).set(bearer(mentorJ)).send({ content: 'Yes.' }).expect(200);

      await waitForEvents();
      expect(await notes(ctx.ids.admin, 'moderation.content_reported')).toHaveLength(1);

      const queue = await ctx.http().get('/api/v1/admin/moderation/reports').query({ targetType: 'COMMENT' }).set(bearer(admin)).expect(200);
      expect(queue.body.data).toEqual([expect.objectContaining({
        id: reportId, targetType: 'COMMENT', reason: 'INAPPROPRIATE', contentSnapshot: 'Yes, negatives count.',
        comment: expect.objectContaining({ content: 'Yes.', author: expect.objectContaining({ username: 'mentor.j' }) }),
        thread:  expect.objectContaining({ id: threadId, assignmentId }),
      })]);
      const threadsOnly = await ctx.http().get('/api/v1/admin/moderation/reports').query({ targetType: 'THREAD' }).set(bearer(admin)).expect(200);
      expect(threadsOnly.body.meta.total).toBe(0);
    });

    it('administrators review a report with every other report and past action on the item', async () => {
      await ctx.http().post(`/api/v1/comments/${answerId}/report`).set(bearer(studentJ)).send({ reason: 'ABUSE' }).expect(201);
      const res = await ctx.http().get(`/api/v1/admin/moderation/reports/${reportId}`).set(bearer(admin)).expect(200);
      expect(res.body.otherReports.map((r: any) => r.reason)).toEqual(['ABUSE']);
      expect(res.body.moderationHistory).toEqual([]);
      await ctx.http().get(`/api/v1/admin/moderation/reports/${reportId}`).set(bearer(mentorJ)).expect(403);
    });

    it('removing the content keeps it on record, closes every report, and tells the author and reporters', async () => {
      await ctx.http().delete(`/api/v1/comments/${answerId}`).set(bearer(admin)).send({ reason: 'Disrespectful' }).expect(200);

      const reports = await ctx.prisma.contentReport.findMany({ where: { commentId: answerId } });
      expect(reports.map((r) => [r.status, r.resolvedById])).toEqual([['RESOLVED', ctx.ids.admin], ['RESOLVED', ctx.ids.admin]]);

      // Masked everywhere for users; the text is kept for administrators.
      const replies = await ctx.http().get(`/api/v1/comments/${questionId}/replies`).set(bearer(studentJ)).expect(200);
      expect(replies.body.data.map((c: any) => c.id)).not.toContain(answerId);
      const actions = await ctx.http().get('/api/v1/admin/moderation/actions').query({ commentId: answerId }).set(bearer(admin)).expect(200);
      expect(actions.body.data).toEqual([expect.objectContaining({
        action: 'DELETE_COMMENT', reason: 'Disrespectful',
        moderator: expect.objectContaining({ username: 'admin' }),
        comment:   expect.objectContaining({ content: 'Yes.', status: 'DELETED' }),
      })]);

      await waitForEvents();
      const [toAuthor] = await notes(ctx.ids.mentorJunior, 'moderation.content_moderated');
      expect(toAuthor.title).toBe('Your comment was removed');
      expect(toAuthor.body).toContain('Disrespectful');
      for (const reporter of [ctx.ids.studentJunior, ctx.ids.studentJunior2]) {
        expect(await notes(reporter, 'moderation.reports_resolved'), reporter).toHaveLength(1);
      }

      const again = await ctx.http().post(`/api/v1/admin/moderation/reports/${reportId}/resolve`).set(bearer(admin))
        .send({ action: 'NONE' }).expect(409);
      expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('a reported thread can be hidden, restored, or removed through its report', async () => {
      const t = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ2))
        .send({ title: 'Buy cheap essays', content: 'Visit my site' }).expect(201);
      const report = await ctx.http().post(`/api/v1/threads/${t.body.id}/report`).set(bearer(studentJ))
        .send({ reason: 'SPAM' }).expect(201);

      await ctx.http().patch(`/api/v1/threads/${t.body.id}/hide`).set(bearer(admin)).send({ reason: 'Checking' }).expect(200);
      await ctx.http().get(`/api/v1/threads/${t.body.id}`).set(bearer(studentJ)).expect(404);
      await ctx.http().patch(`/api/v1/threads/${t.body.id}/restore`).set(bearer(admin)).send({}).expect(200);

      // Hiding closed the first report; a fresh report is removed outright.
      const report2 = await ctx.http().post(`/api/v1/threads/${t.body.id}/report`).set(bearer(mentorJ))
        .send({ reason: 'SPAM' }).expect(201);
      const removed = await ctx.http().post(`/api/v1/admin/moderation/reports/${report2.body.id}/resolve`).set(bearer(admin))
        .send({ action: 'DELETE', note: 'Advertising' }).expect(200);
      expect(removed.body.status).toBe('RESOLVED');

      await ctx.http().get(`/api/v1/threads/${t.body.id}`).set(bearer(studentJ2)).expect(404);
      await ctx.http().post(`/api/v1/threads/${t.body.id}/comments`).set(bearer(admin)).send({ content: 'x' }).expect(409);
      await ctx.http().patch(`/api/v1/threads/${t.body.id}/restore`).set(bearer(admin)).send({}).expect(409);

      const history = await ctx.http().get('/api/v1/admin/moderation/actions').query({ threadId: t.body.id }).set(bearer(admin)).expect(200);
      expect(history.body.data.map((a: any) => a.action)).toEqual(['DELETE_THREAD', 'RESTORE_THREAD', 'HIDE_THREAD']);
      expect((await ctx.prisma.contentReport.findUniqueOrThrow({ where: { id: report.body.id } })).status).toBe('RESOLVED');

      await waitForEvents();
      const toAuthor = await notes(ctx.ids.studentJunior2, 'moderation.content_moderated');
      expect(toAuthor.map((n) => n.title)).toEqual([
        'Your discussion was hidden', 'Your discussion was restored', 'Your discussion was removed',
      ]);
    });

    it('dismissing a report leaves the content alone and is recorded', async () => {
      const report = await ctx.http().post(`/api/v1/comments/${questionId}/report`).set(bearer(studentJ2))
        .send({ reason: 'OFF_TOPIC' }).expect(201);
      const res = await ctx.http().post(`/api/v1/admin/moderation/reports/${report.body.id}/resolve`).set(bearer(admin))
        .send({ action: 'NONE', note: 'On topic' }).expect(200);
      expect(res.body.status).toBe('DISMISSED');
      expect((await ctx.prisma.comment.findUniqueOrThrow({ where: { id: questionId } })).status).toBe('ACTIVE');

      const dismissed = await ctx.http().get('/api/v1/admin/moderation/actions').query({ action: 'DISMISS_REPORT' }).set(bearer(admin)).expect(200);
      expect(dismissed.body.data).toEqual([expect.objectContaining({ reason: 'On topic', report: expect.objectContaining({ id: report.body.id }) })]);
    });
  });

  describe('restrictions', () => {
    it('there is no private or direct messaging', async () => {
      for (const path of ['/api/v1/messages', '/api/v1/conversations', `/api/v1/users/${ctx.ids.studentJunior2}/messages`]) {
        await ctx.http().post(path).set(bearer(studentJ)).send({ content: 'hi' }).expect(404);
        await ctx.http().get(path).set(bearer(studentJ)).expect(404);
      }
    });
  });
});
