/**
 * The official assignment workflow, end to end:
 *
 *   1. Mentor prepares an assignment.
 *   2. Administrator reviews and publishes it.
 *   3. Students submit their work.
 *   4. Administrator distributes submissions to mentors.
 *   5. Mentors review, score and give feedback.
 *   6. Mentors return completed reviews.
 *   7. Administrator coordinates and publishes results.
 *   8. Students view their results and feedback.
 */
import { createTestApp, login, bearer, PDF, inDays, type TestContext } from './helpers.js';

describe('Assignment workflow (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorJ2: string, studentJ: string, studentJ2: string;
  let assignmentId: string;
  const submissionIds: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorJ2, studentJ, studentJ2] = await Promise.all([
      login(ctx, 'admin'), login(ctx, 'mentor.j'), login(ctx, 'mentor.j2'),
      login(ctx, 'student.j'), login(ctx, 'student.j2'),
    ]);
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('1. mentor prepares a draft assignment with a brief', async () => {
    const res = await ctx.http()
      .post('/api/v1/assignments')
      .set(bearer(mentorJ))
      .field('title', 'Quadratic equations')
      .field('courseId', ctx.ids.algebra)
      .field('divisionId', ctx.ids.junior)
      .field('instructions', 'Solve all five problems and show your working.')
      .field('deadline', inDays(7))
      .field('points', '40')
      .field('maximumMarks', '20')
      .field('allowResubmission', 'true')
      .attach('file', PDF, 'brief.pdf')
      .expect(201);

    expect(res.body.status).toBe('DRAFT');
    expect(res.body.file.mimeType).toBe('application/pdf');
    assignmentId = res.body.id;

    // Students cannot see drafts.
    await ctx.http().get(`/api/v1/assignments/${assignmentId}`).set(bearer(studentJ)).expect(404);
  });

  it('1b. mentor submits it for official publication', async () => {
    const res = await ctx.http().patch(`/api/v1/assignments/${assignmentId}/submit`).set(bearer(mentorJ)).expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
  });

  it('2. admin publishes (and only the admin may)', async () => {
    await ctx.http().patch(`/api/v1/assignments/${assignmentId}/publish`).set(bearer(mentorJ)).expect(403);

    const res = await ctx.http().patch(`/api/v1/assignments/${assignmentId}/publish`).set(bearer(admin)).expect(200);
    expect(res.body.status).toBe('PUBLISHED');

    // Publishing twice is an invalid transition, not a silent success.
    const again = await ctx.http().patch(`/api/v1/assignments/${assignmentId}/publish`).set(bearer(admin)).expect(409);
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('3. students of the division see it and submit', async () => {
    const list = await ctx.http().get('/api/v1/me/assignments').set(bearer(studentJ)).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].displayStatus).toBe('New');

    const detail = await ctx.http().get(`/api/v1/assignments/${assignmentId}`).set(bearer(studentJ)).expect(200);
    expect(detail.body.displayStatus).toBe('Opened');
    expect(detail.body.canSubmit).toBe(true);

    await ctx.http().get(`/api/v1/assignments/${assignmentId}/file`).set(bearer(studentJ)).expect(200);

    for (const [name, token] of [['j', studentJ], ['j2', studentJ2]] as const) {
      const res = await ctx.http()
        .post('/api/v1/submissions')
        .set(bearer(token))
        .field('assignmentId', assignmentId)
        .field('note', 'My solutions')
        .attach('file', PDF, 'solutions.pdf')
        .expect(201);
      expect(res.body.status).toBe('SUBMITTED');
      expect(res.body.displayStatus).toBe('Submitted');
      expect(res.body.result).toBeUndefined();
      submissionIds[name] = res.body.id;
    }
  });

  it('3b. a resubmission is revision 2 and a second first-submission is refused', async () => {
    const res = await ctx.http()
      .post('/api/v1/submissions')
      .set(bearer(studentJ))
      .field('assignmentId', assignmentId)
      .attach('file', PDF, 'solutions-v2.pdf')
      .expect(201);
    expect(res.body.id).toBe(submissionIds['j']);
    expect(res.body.revisionCount).toBe(1);
    expect(res.body.revisions.map((r: any) => r.revisionNumber)).toEqual([1, 2]);
  });

  it('4. admin distributes submissions across the division\'s mentors', async () => {
    const res = await ctx.http()
      .post(`/api/v1/assignments/${assignmentId}/distribute`)
      .set(bearer(admin))
      .send({ strategy: 'BALANCED' })
      .expect(200);

    expect(res.body.distributed).toBe(2);
    // Balanced: one each.
    expect(Object.values(res.body.byMentor)).toEqual([1, 1]);

    // Once under distribution, the student can no longer resubmit if review starts;
    // while ASSIGNED it is still allowed (verified elsewhere).
  });

  it('5. only the assigned mentor reviews and scores — admins cannot grade', async () => {
    const queueJ  = await ctx.http().get('/api/v1/mentor/reviews').set(bearer(mentorJ)).expect(200);
    const queueJ2 = await ctx.http().get('/api/v1/mentor/reviews').set(bearer(mentorJ2)).expect(200);
    expect(queueJ.body.data.length + queueJ2.body.data.length).toBe(2);

    for (const [token, queue] of [[mentorJ, queueJ], [mentorJ2, queueJ2]] as const) {
      for (const s of queue.body.data) {
        // Admin is refused on mentor-only routes.
        await ctx.http().patch(`/api/v1/submissions/${s.id}/start-review`).set(bearer(admin)).expect(403);

        // The *other* mentor is refused too.
        const other = token === mentorJ ? mentorJ2 : mentorJ;
        const denied = await ctx.http().patch(`/api/v1/submissions/${s.id}/start-review`).set(bearer(other)).expect(403);
        expect(denied.body.code).toBe('NOT_ASSIGNED_MENTOR');

        await ctx.http().get(`/api/v1/submissions/${s.id}/file`).set(bearer(token)).expect(200);
        await ctx.http().patch(`/api/v1/submissions/${s.id}/start-review`).set(bearer(token)).expect(200);

        // Score above maximum marks is rejected.
        const tooHigh = await ctx.http()
          .patch(`/api/v1/submissions/${s.id}/mark`).set(bearer(token))
          .field('score', '25').field('mentorFeedback', 'Too generous').expect(400);
        expect(tooHigh.body.code).toBe('INVALID_SCORE');

        const marked = await ctx.http()
          .patch(`/api/v1/submissions/${s.id}/mark`).set(bearer(token))
          .field('score', s.student.username === 'student.j' ? '15' : '20')
          .field('mentorFeedback', 'Clear reasoning. Check problem 4 again.')
          .attach('feedbackFile', PDF, 'feedback.pdf')
          .expect(200);
        expect(marked.body.status).toBe('MARKED');
        expect(marked.body.percentage).toBeGreaterThan(0);
      }
    }
  });

  it('5b. students still see no score before publication', async () => {
    const res = await ctx.http().get(`/api/v1/submissions/${submissionIds['j']}`).set(bearer(studentJ)).expect(200);
    expect(res.body.displayStatus).toBe('In Review');
    expect(res.body.result).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Check problem 4');

    await ctx.http().get(`/api/v1/submissions/${submissionIds['j']}/feedback-file`).set(bearer(studentJ)).expect(403);
  });

  it('6. mentors return their completed reviews', async () => {
    for (const token of [mentorJ, mentorJ2]) {
      const queue = await ctx.http().get('/api/v1/mentor/reviews').set(bearer(token));
      for (const s of queue.body.data) {
        const res = await ctx.http().patch(`/api/v1/submissions/${s.id}/submit-to-admin`).set(bearer(token)).expect(200);
        expect(res.body.status).toBe('SUBMITTED_TO_ADMIN');
      }
    }
  });

  it('7. admin sends one review back, then approves and publishes all results', async () => {
    const back = await ctx.http()
      .patch(`/api/v1/submissions/${submissionIds['j2']}/reject`).set(bearer(admin))
      .send({ rejectionReason: 'Please justify the full marks.' }).expect(200);
    expect(back.body.status).toBe('REJECTED');

    // The responsible mentor revises and returns it.
    const sub = await ctx.prisma.submission.findUniqueOrThrow({ where: { id: submissionIds['j2'] } });
    const token = sub.mentorId === ctx.ids.mentorJunior ? mentorJ : mentorJ2;
    await ctx.http().patch(`/api/v1/submissions/${sub.id}/start-review`).set(bearer(token)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${sub.id}/mark`).set(bearer(token))
      .field('score', '18').field('mentorFeedback', 'Revised: excellent work.').expect(200);
    await ctx.http().patch(`/api/v1/submissions/${sub.id}/submit-to-admin`).set(bearer(token)).expect(200);

    for (const id of Object.values(submissionIds)) {
      await ctx.http().patch(`/api/v1/submissions/${id}/approve`).set(bearer(admin))
        .send({ coordinationNote: 'Checked against the marking scheme.' }).expect(200);
    }

    const res = await ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(admin)).expect(200);
    expect(res.body.published).toBe(2);
    expect(res.body.notYetPublished).toEqual({});
  });

  it('8. students view their result, feedback and points', async () => {
    const res = await ctx.http().get(`/api/v1/submissions/${submissionIds['j']}`).set(bearer(studentJ)).expect(200);
    expect(res.body.displayStatus).toBe('Marked');
    expect(res.body.result).toMatchObject({
      score: 15, maximumMarks: 20, percentage: 75, pointsAwarded: 30,
      mentorFeedback: 'Clear reasoning. Check problem 4 again.',
    });
    // Internal coordination notes never reach students.
    expect(JSON.stringify(res.body)).not.toContain('marking scheme');

    await ctx.http().get(`/api/v1/submissions/${submissionIds['j']}/feedback-file`).set(bearer(studentJ)).expect(200);

    const me = await ctx.http().get('/api/v1/me').set(bearer(studentJ)).expect(200);
    expect(me.body.points).toBe(30);

    const board = await ctx.http().get('/api/v1/leaderboard').set(bearer(studentJ)).expect(200);
    expect(board.body.data[0]).toMatchObject({ rank: 1, points: 36 }); // student.j2: 18/20 × 40
    expect(board.body.data[1]).toMatchObject({ rank: 2, points: 30, isMe: true });
    expect(board.body.data[1].displayName).toBe('student.j T.');
  });

  it('reopening a published result removes its points and returns it to the mentor', async () => {
    const res = await ctx.http()
      .patch(`/api/v1/submissions/${submissionIds['j']}/reopen`).set(bearer(admin))
      .send({ reopenNote: 'Problem 3 was marked against the wrong answer key.' }).expect(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', previousScore: 15, pointsAwarded: 0 });

    const me = await ctx.http().get('/api/v1/me').set(bearer(studentJ)).expect(200);
    expect(me.body.points).toBe(0);

    const studentView = await ctx.http().get(`/api/v1/submissions/${submissionIds['j']}`).set(bearer(studentJ)).expect(200);
    expect(studentView.body.result).toBeUndefined();
  });

  it('mentor analytics and admin reports reflect the workflow', async () => {
    const analytics = await ctx.http()
      .get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior })
      .set(bearer(mentorJ)).expect(200);
    expect(analytics.body.assignments[0]).toMatchObject({ submissions: 2, publishedResults: 1 });

    // A mentor of another division cannot see these analytics.
    const senior = await login(ctx, 'mentor.s');
    await ctx.http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior })
      .set(bearer(senior)).expect(403);

    const csv = await ctx.http().get('/api/v1/admin/reports/results.csv').query({ assignmentId })
      .set(bearer(admin)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Quadratic equations');

    const overview = await ctx.http().get('/api/v1/admin/reports/overview').set(bearer(admin)).expect(200);
    expect(overview.body.actionRequired).toHaveProperty('reviewsAwaitingApproval');
  });
});
