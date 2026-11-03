/**
 * Results and formal feedback: visible only after official publication,
 * published by administrators (who and when recorded), complete result
 * details, feedback downloads, corrections with history, notifications, and
 * no replies on results.
 */
import { createTestApp, login, bearer, PDF, inDays, type TestContext, waitForEvents } from './helpers.js';

describe('Results and feedback (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, studentJ: string, studentJ2: string;
  let assignmentId: string;
  const subs: Record<string, string> = {};

  const review = async (subId: string, score: string, feedback: string, withFile = false) => {
    await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ)).expect(200);
    const req = ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ))
      .field('score', score).field('mentorFeedback', feedback);
    if (withFile) req.attach('feedbackFiles', PDF, 'worked-solution.pdf');
    await req.expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(admin)).send({}).expect(200);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, studentJ, studentJ2] = await Promise.all(
      ['admin', 'mentor.j', 'student.j', 'student.j2'].map((u) => login(ctx, u)),
    );
    const a = await ctx.prisma.assignment.create({
      data: {
        title: 'Inequalities I', description: 'AM-GM practice', instructions: 'Prove all three.', deadline: new Date(inDays(5)),
        points: 40, maximumMarks: 20, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
    assignmentId = a.id;
    for (const [key, token] of [['j', studentJ], ['j2', studentJ2]] as const) {
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(token))
        .field('assignmentId', assignmentId).field('answerText', `Proofs by ${key}`).attach('files', PDF, 'proofs.pdf').expect(201);
      subs[key] = res.body.id;
      await ctx.http().patch(`/api/v1/submissions/${res.body.id}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
    }
    await review(subs.j, '16', 'Solid proofs; the equality case in (3) is missing.', true);
    await review(subs.j2, '19', 'Excellent.');
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('before publication', () => {
    it('students see no score, feedback or files even though the review is approved', async () => {
      const list = await ctx.http().get('/api/v1/me/results').set(bearer(studentJ)).expect(200);
      expect(list.body.data).toHaveLength(0);
      await ctx.http().get(`/api/v1/me/results/${subs.j}`).set(bearer(studentJ)).expect(404);

      const att = (await ctx.prisma.reviewAttachment.findFirstOrThrow({ where: { review: { submissionId: subs.j } } })).id;
      await ctx.http().get(`/api/v1/me/results/${subs.j}/feedback-files/${att}`).set(bearer(studentJ)).expect(403);

      const sub = await ctx.http().get(`/api/v1/submissions/${subs.j}`).set(bearer(studentJ)).expect(200);
      expect(sub.body).not.toHaveProperty('result');
      expect(JSON.stringify(sub.body)).not.toContain('equality case');
    });

    it('only administrators can publish', async () => {
      await ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(mentorJ)).send({}).expect(403);
      await ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(studentJ)).send({}).expect(403);
      await ctx.http().patch(`/api/v1/submissions/${subs.j}/publish`).set(bearer(mentorJ)).expect(403);
    });
  });

  describe('publication', () => {
    it('records the release (who and when) and notifies each student', async () => {
      const res = await ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(admin))
        .send({ note: 'Week 3 results' }).expect(200);
      expect(res.body.published).toBe(2);

      const release = await ctx.prisma.resultRelease.findUniqueOrThrow({ where: { id: res.body.releaseId } });
      expect(release).toMatchObject({ publishedById: ctx.ids.admin, resultCount: 2, note: 'Week 3 results' });
      expect(release.publishedAt).toBeInstanceOf(Date);

      await waitForEvents();
      const notes = await ctx.prisma.notification.findMany({ where: { type: 'results.published' } });
      expect(notes.map((n) => n.userId).sort()).toEqual([ctx.ids.studentJunior, ctx.ids.studentJunior2].sort());
    });
  });

  describe('student view', () => {
    it('lists previously reviewed assignments', async () => {
      const list = await ctx.http().get('/api/v1/me/results').set(bearer(studentJ)).expect(200);
      expect(list.body.data).toEqual([expect.objectContaining({
        submissionId: subs.j, score: 16, maximumMarks: 20, percentage: 80, pointsAwarded: 32,
        assignment: expect.objectContaining({ title: 'Inequalities I', course: expect.objectContaining({ code: 'ALGEBRA' }) }),
      })]);
      const other = await ctx.http().get('/api/v1/me/results').query({ courseId: ctx.ids.geometry }).set(bearer(studentJ)).expect(200);
      expect(other.body.data).toHaveLength(0);
    });

    it('shows the full result details with no reply option', async () => {
      const res = await ctx.http().get(`/api/v1/me/results/${subs.j}`).set(bearer(studentJ)).expect(200);
      expect(res.body).toMatchObject({
        submissionId: subs.j,
        assignment:   { id: assignmentId, title: 'Inequalities I', description: 'AM-GM practice', maximumMarks: 20 },
        submission:   { attempts: 1, isLate: false, answerText: 'Proofs by j' },
        score: 16, percentage: 80,
        feedback: { text: 'Solid proofs; the equality case in (3) is missing.', mentor: { firstName: expect.any(String) } },
        previousVersions: [],
        repliesAllowed: false,
      });
      expect(res.body.submission.files).toHaveLength(1);
      for (const t of ['reviewedAt', 'publishedAt']) expect(res.body[t], t).toBeTruthy();

      // Internal admin notes and mentor accounts are never part of the result.
      expect(res.body.feedback.mentor).not.toHaveProperty('username');
      expect(JSON.stringify(res.body)).not.toMatch(/coordinationNote|decisionNote/);

      const [file] = res.body.feedback.files;
      expect(file.file.originalName).toBe('worked-solution.pdf');
      const dl = await ctx.http().get(file.downloadPath).set(bearer(studentJ)).expect(200);
      expect(dl.headers['content-disposition']).toContain('attachment');
    });

    it('students cannot see each other\'s results or feedback files', async () => {
      await ctx.http().get(`/api/v1/me/results/${subs.j}`).set(bearer(studentJ2)).expect(404);
      const att = (await ctx.prisma.reviewAttachment.findFirstOrThrow({ where: { review: { submissionId: subs.j } } })).id;
      await ctx.http().get(`/api/v1/me/results/${subs.j}/feedback-files/${att}`).set(bearer(studentJ2)).expect(404);
      await ctx.http().get('/api/v1/me/results').set(bearer(mentorJ)).expect(403);
    });

    it('results are separate from discussions: there is nowhere to reply', async () => {
      await ctx.http().post(`/api/v1/me/results/${subs.j}`).set(bearer(studentJ)).send({ content: 'Why -4?' }).expect(404);
      await ctx.http().post(`/api/v1/me/results/${subs.j}/comments`).set(bearer(studentJ)).send({ content: 'Why -4?' }).expect(404);
      await ctx.http().post(`/api/v1/submissions/${subs.j}/threads`).set(bearer(studentJ))
        .send({ title: 'About my mark', content: 'Why -4?' }).expect(404);
      expect(await ctx.prisma.discussionThread.count()).toBe(0);
    });
  });

  describe('corrections', () => {
    it('a reopened result is withdrawn until republished, then shows its previous version', async () => {
      await ctx.http().patch(`/api/v1/submissions/${subs.j}/reopen`).set(bearer(admin))
        .send({ reopenNote: 'Marking scheme allows full credit for (3).' }).expect(200);
      await ctx.http().get(`/api/v1/me/results/${subs.j}`).set(bearer(studentJ)).expect(404);

      await review(subs.j, '18', 'Solid proofs; (3) accepted under the revised scheme.');
      await ctx.http().patch(`/api/v1/submissions/${subs.j}/publish`).set(bearer(admin)).expect(200);

      const res = await ctx.http().get(`/api/v1/me/results/${subs.j}`).set(bearer(studentJ)).expect(200);
      expect(res.body).toMatchObject({ score: 18, pointsAwarded: 36 });
      expect(res.body.previousVersions).toEqual([
        expect.objectContaining({ score: 16, publishedAt: expect.any(String), withdrawnAt: expect.any(String) }),
      ]);
      // The admin's reason is internal.
      expect(JSON.stringify(res.body)).not.toContain('Marking scheme');
    });

    it('administrators see every publication with who published and withdrew it', async () => {
      const res = await ctx.http().get(`/api/v1/submissions/${subs.j}/result-history`).set(bearer(admin)).expect(200);
      expect(res.body.publications).toEqual([
        expect.objectContaining({
          cycle: 1, score: 16, mentor: expect.objectContaining({ username: 'mentor.j' }),
          publishedBy: expect.objectContaining({ username: 'admin' }),
          withdrawn: expect.objectContaining({ note: 'Marking scheme allows full credit for (3).', by: expect.objectContaining({ username: 'admin' }) }),
        }),
        expect.objectContaining({ cycle: 2, score: 18, publishedBy: expect.objectContaining({ username: 'admin' }), withdrawn: null }),
      ]);
      expect(res.body.currentRelease.publishedBy.username).toBe('admin');

      await ctx.http().get(`/api/v1/submissions/${subs.j}/result-history`).set(bearer(studentJ)).expect(403);
      await ctx.http().get(`/api/v1/submissions/${subs.j}/result-history`).set(bearer(mentorJ)).expect(403);
    });
  });
});
