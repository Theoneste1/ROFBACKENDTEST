/**
 * Distribution and mentor review: reassignment, review history, who reviewed
 * and when, and the guarantees that only the assigned mentor grades and that
 * administrators never grade or write academic feedback.
 */
import { createTestApp, login, bearer, PDF, inDays, type TestContext } from './helpers.js';

describe('Distribution and mentor review (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorJ2: string, mentorS: string, studentJ: string;
  let subId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorJ2, mentorS, studentJ] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.j2', 'mentor.s', 'student.j'].map((u) => login(ctx, u)),
    );
    const a = await ctx.prisma.assignment.create({
      data: {
        title: 'Quadratics', instructions: 'Solve and justify.', deadline: new Date(inDays(5)),
        points: 30, maximumMarks: 20, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
    const sub = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', a.id).attach('file', PDF, 'work.pdf').expect(201);
    subId = sub.body.id;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('administrators see submitted work waiting for distribution', async () => {
    const res = await ctx.http().get('/api/v1/submissions').query({ status: 'SUBMITTED' }).set(bearer(admin)).expect(200);
    expect(res.body.data.map((s: any) => s.id)).toEqual([subId]);
    await ctx.http().get('/api/v1/submissions').set(bearer(mentorJ)).expect(403);
  });

  it('distribution only accepts eligible mentors and cannot carry grading data', async () => {
    const wrong = await ctx.http().patch(`/api/v1/submissions/${subId}/assign`).set(bearer(admin))
      .send({ mentorId: ctx.ids.mentorSenior }).expect(400);
    expect(wrong.body.code).toBe('MENTOR_NOT_ELIGIBLE');
    await ctx.http().patch(`/api/v1/submissions/${subId}/assign`).set(bearer(admin))
      .send({ mentorId: ctx.ids.mentorJunior, score: 20 }).expect(400);
    await ctx.http().patch(`/api/v1/submissions/${subId}/assign`).set(bearer(admin))
      .send({ mentorId: ctx.ids.mentorJunior }).expect(200);
  });

  it('only the assigned mentor can open and review it', async () => {
    await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(mentorJ2)).expect(404);
    const denied = await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ2)).expect(403);
    expect(denied.body.code).toBe('NOT_ASSIGNED_MENTOR');
    await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorS)).expect(403);

    await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ))
      .field('score', '12').field('mentorFeedback', 'Good start; part (c) is incomplete.').expect(200);
  });

  it('reassigning keeps the first review in the history and moves access to the new mentor', async () => {
    const same = await ctx.http().patch(`/api/v1/submissions/${subId}/reassign`).set(bearer(admin))
      .send({ mentorId: ctx.ids.mentorJunior }).expect(400);
    expect(same.body.code).toBe('SAME_MENTOR');
    await ctx.http().patch(`/api/v1/submissions/${subId}/reassign`).set(bearer(mentorJ))
      .send({ mentorId: ctx.ids.mentorJunior2 }).expect(403);

    const res = await ctx.http().patch(`/api/v1/submissions/${subId}/reassign`).set(bearer(admin))
      .send({ mentorId: ctx.ids.mentorJunior2 }).expect(200);
    expect(res.body).toMatchObject({ status: 'ASSIGNED', review: { cycle: 2, status: 'ASSIGNED', score: null } });

    // The previous mentor loses access; the new one has it in their queue.
    await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(mentorJ)).expect(404);
    await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ))
      .field('score', '20').field('mentorFeedback', 'Changing my mind.').expect(403);
    const queue = await ctx.http().get('/api/v1/mentor/reviews').set(bearer(mentorJ2)).expect(200);
    expect(queue.body.data.map((s: any) => s.id)).toContain(subId);

    const history = await ctx.http().get(`/api/v1/submissions/${subId}/reviews`).set(bearer(admin)).expect(200);
    expect(history.body.map((r: any) => [r.cycle, r.status, r.score, r.mentor.username])).toEqual([
      [1, 'SUPERSEDED', 12, 'mentor.j'],
      [2, 'ASSIGNED', null, 'mentor.j2'],
    ]);
    expect(history.body[0].events.map((e: any) => e.type)).toEqual(['ASSIGNED', 'STARTED', 'MARKED', 'REASSIGNED']);

    // A mentor only sees the cycles they did themselves.
    const own = await ctx.http().get(`/api/v1/submissions/${subId}/reviews`).set(bearer(mentorJ)).expect(200);
    expect(own.body.map((r: any) => r.cycle)).toEqual([1]);
  });

  it('the new mentor scores, writes feedback, attaches documents and submits the review', async () => {
    await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ2)).expect(200);

    const over = await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ2))
      .field('score', '21').field('mentorFeedback', 'Too many marks.').expect(400);
    expect(over.body.code).toBe('INVALID_SCORE');

    const marked = await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ2))
      .field('score', '17').field('mentorFeedback', 'Correct method; one arithmetic slip in (c).')
      .attach('feedbackFiles', PDF, 'annotated.pdf').expect(200);
    expect(marked.body.review).toMatchObject({ score: 17, percentage: 85 });
    expect(marked.body.review.attachments).toHaveLength(1);

    await ctx.http().patch(`/api/v1/submissions/${subId}/submit-to-admin`).set(bearer(mentorJ2)).expect(200);
  });

  it('a submitted review cannot be changed by the mentor, and administrators cannot grade it', async () => {
    await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ2))
      .field('score', '20').field('mentorFeedback', 'Bumping it up.').expect(409);

    await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(admin))
      .send({ score: 20, mentorFeedback: 'Admin override' }).expect(403);
    await ctx.http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(admin))
      .send({ score: 20 }).expect(400);
    await ctx.http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(admin))
      .send({ mentorFeedback: 'Excellent' }).expect(400);
  });

  it('the admin sends it back once; the mentor revises; the admin approves and publishes', async () => {
    await ctx.http().patch(`/api/v1/submissions/${subId}/reject`).set(bearer(admin))
      .send({ rejectionReason: 'Please explain the deduction in (c).' }).expect(200);
    const back = await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(mentorJ2)).expect(200);
    expect(back.body.review).toMatchObject({ status: 'SENT_BACK', decisionNote: 'Please explain the deduction in (c).' });

    await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ2)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ2))
      .field('score', '17').field('mentorFeedback', 'Correct method; -3 for the arithmetic slip in (c).').expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/submit-to-admin`).set(bearer(mentorJ2)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(admin))
      .send({ coordinationNote: 'Checked with the head mentor.' }).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/publish`).set(bearer(admin)).expect(200);

    // Published results are locked for mentors too.
    await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ2)).expect(409);
  });

  it('records who reviewed, when, and every step; the student sees the mentor\'s feedback only', async () => {
    const history = await ctx.http().get(`/api/v1/submissions/${subId}/reviews`).set(bearer(admin)).expect(200);
    const final = history.body[1];
    expect(final).toMatchObject({ status: 'PUBLISHED', score: 17, mentor: { username: 'mentor.j2' }, decidedBy: { username: 'admin' } });
    for (const t of ['assignedAt', 'startedAt', 'markedAt', 'returnedAt', 'decidedAt', 'publishedAt']) {
      expect(final[t], t).toBeTruthy();
    }
    expect(final.events.map((e: any) => e.type)).toEqual([
      'ASSIGNED', 'STARTED', 'MARKED', 'RETURNED', 'SENT_BACK', 'STARTED', 'MARKED', 'RETURNED', 'APPROVED', 'PUBLISHED',
    ]);
    expect(final.events.find((e: any) => e.type === 'MARKED').actor.username).toBe('mentor.j2');

    const student = await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(studentJ)).expect(200);
    expect(student.body.result).toMatchObject({
      score: 17, maximumMarks: 20, mentorFeedback: 'Correct method; -3 for the arithmetic slip in (c).',
    });
    expect(JSON.stringify(student.body)).not.toContain('Checked with the head mentor.');
    expect(student.body.result.feedbackFiles).toHaveLength(1);
    await ctx.http().get(`/api/v1/submissions/${subId}/feedback-file`).set(bearer(studentJ)).expect(200);
  });
});
