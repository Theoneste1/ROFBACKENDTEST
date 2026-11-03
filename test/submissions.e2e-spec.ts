/**
 * Student submissions: typed answers and files, attempt history,
 * resubmission rules, mentor-requested resubmissions and the student-facing
 * statuses Not Started → Submitted → Pending Review → (Resubmission
 * Requested →) … → Reviewed.
 */
import { createTestApp, login, bearer, PDF, EXE, inDays, type TestContext } from './helpers.js';

describe('Submissions (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorJ2: string, studentJ: string, studentJ2: string, studentS: string;
  let assignmentId: string;
  let subId: string;

  const publish = (data: Record<string, unknown> = {}) => ctx.prisma.assignment.create({
    data: {
      title: 'Number patterns', instructions: 'Find the next term and prove it.', deadline: new Date(inDays(5)),
      points: 10, maximumMarks: 10, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      allowResubmission: true, maxResubmissions: 2, ...data,
    },
  });
  const myRow = async (token: string, id: string) => {
    const res = await ctx.http().get('/api/v1/me/assignments').set(bearer(token)).expect(200);
    return res.body.data.find((a: any) => a.id === id);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorJ2, studentJ, studentJ2, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.j2', 'student.j', 'student.j2', 'student.s'].map((u) => login(ctx, u)),
    );
    assignmentId = (await publish()).id;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('submitting', () => {
    it('starts as Not Started', async () => {
      expect(await myRow(studentJ, assignmentId)).toMatchObject({ displayStatus: 'Not Started', submission: null, canSubmit: true });
    });

    it('validates the answer and the files before storing anything', async () => {
      const none = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', '   ').expect(400);
      expect(none.body.code).toBe('ANSWER_REQUIRED');

      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', 'x'.repeat(20_001)).expect(400);

      const exe = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).attach('file', EXE, { filename: 'answer.pdf', contentType: 'application/pdf' }).expect(415);
      expect(exe.body.code).toBe('FILE_TYPE_NOT_ALLOWED');

      const big = Buffer.concat([PDF, Buffer.alloc(21 * 1024 * 1024, 0x20)]);
      // Over the 20 MB submission limit: refused by the upload layer before storage.
      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).attach('file', big, 'huge.pdf').expect(413);

      expect(await ctx.prisma.submission.count()).toBe(0);
      expect(await ctx.prisma.fileObject.count({ where: { purpose: 'SUBMISSION' } })).toBe(0);
    });

    it('accepts a typed answer with a file and records the time', async () => {
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', 'The next term is 42.')
        .attach('files', PDF, 'working.pdf').expect(201);
      subId = res.body.id;
      expect(res.body).toMatchObject({ status: 'SUBMITTED', displayStatus: 'Submitted', answerText: 'The next term is 42.' });
      expect(res.body.files).toHaveLength(1);
      expect(new Date(res.body.submittedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('a typed answer alone is enough', async () => {
      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ2))
        .field('assignmentId', assignmentId).field('answerText', '42, because each term doubles and adds 2.').expect(201);
    });

    it('resubmits within the rules and keeps every attempt', async () => {
      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', 'Corrected: 46.').expect(201);

      const history = await ctx.http().get(`/api/v1/submissions/${subId}/history`).set(bearer(studentJ)).expect(200);
      expect(history.body.attempts.map((a: any) => [a.revisionNumber, a.answerText])).toEqual([
        [1, 'The next term is 42.'], [2, 'Corrected: 46.'],
      ]);
      expect(history.body.attempts[0].attachments).toHaveLength(1);
      expect(history.body.attempts.every((a: any) => a.submittedAt)).toBe(true);

      // The first attempt's file is still downloadable.
      await ctx.http().get(`/api/v1/submissions/${subId}/revisions/1/file`).set(bearer(studentJ)).expect(200);
    });
  });

  describe('privacy', () => {
    it('other students cannot see the submission, its history or its files', async () => {
      await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(studentJ2)).expect(404);
      await ctx.http().get(`/api/v1/submissions/${subId}/history`).set(bearer(studentJ2)).expect(404);
      await ctx.http().get(`/api/v1/submissions/${subId}/revisions/1/file`).set(bearer(studentJ2)).expect(404);
      const att = (await ctx.prisma.submissionAttachment.findFirstOrThrow({ where: { revision: { submissionId: subId } } })).id;
      await ctx.http().get(`/api/v1/submissions/${subId}/attachments/${att}/file`).set(bearer(studentS)).expect(404);
    });

    it('mentors only see submissions assigned to them', async () => {
      await ctx.http().get(`/api/v1/submissions/${subId}/history`).set(bearer(mentorJ)).expect(404);
    });

    it('students cannot request resubmissions or act as a mentor', async () => {
      await ctx.http().patch(`/api/v1/submissions/${subId}/request-resubmission`).set(bearer(studentJ))
        .send({ note: 'Let me redo it.' }).expect(403);
      await ctx.http().patch(`/api/v1/submissions/${subId}/request-resubmission`).set(bearer(admin))
        .send({ note: 'Admins do not review.' }).expect(403);
    });
  });

  describe('mentor-requested resubmission', () => {
    it('the reviewing mentor asks for a new attempt', async () => {
      await ctx.http().patch(`/api/v1/submissions/${subId}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ)).expect(200);
      expect(await myRow(studentJ, assignmentId)).toMatchObject({ displayStatus: 'Pending Review', canSubmit: false });

      // Another mentor of the same scope cannot.
      await ctx.http().patch(`/api/v1/submissions/${subId}/request-resubmission`).set(bearer(mentorJ2))
        .send({ note: 'Not mine to ask.' }).expect(403);
      await ctx.http().patch(`/api/v1/submissions/${subId}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'x' }).expect(400);

      const res = await ctx.http().patch(`/api/v1/submissions/${subId}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'Prove the pattern holds for every term.', dueAt: inDays(4) }).expect(200);
      expect(res.body).toMatchObject({
        status: 'RESUBMISSION_REQUESTED',
        resubmissionRequest: { note: 'Prove the pattern holds for every term.' },
      });
    });

    it('the student sees the request and may resubmit even after the assignment closes', async () => {
      await ctx.http().patch(`/api/v1/assignments/${assignmentId}/close`).set(bearer(admin)).send({}).expect(200);

      const row = await myRow(studentJ, assignmentId);
      expect(row).toMatchObject({ status: 'CLOSED', displayStatus: 'Resubmission Requested', canSubmit: true });

      const mine = await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(studentJ)).expect(200);
      expect(mine.body.resubmissionRequest).toMatchObject({ note: 'Prove the pattern holds for every term.' });
      expect(mine.body).not.toHaveProperty('review');

      // Other students of a closed assignment still cannot submit.
      const closed = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ2))
        .field('assignmentId', assignmentId).field('answerText', 'Another go').expect(409);
      expect(closed.body.code).toBe('ASSIGNMENT_CLOSED');
    });

    it('the new attempt goes straight back to the same mentor', async () => {
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', assignmentId).field('answerText', '46, proved by induction.')
        .attach('files', PDF, 'proof.pdf').expect(201);
      expect(res.body).toMatchObject({ status: 'ASSIGNED', displayStatus: 'Submitted', resubmissionRequest: null });

      const queue = await ctx.http().get('/api/v1/mentor/reviews').set(bearer(mentorJ)).expect(200);
      expect(queue.body.data.find((s: any) => s.id === subId)).toMatchObject({ review: { status: 'ASSIGNED', cycle: 2 } });
    });

    it('the history shows every attempt and the request (anonymous for the student)', async () => {
      const student = await ctx.http().get(`/api/v1/submissions/${subId}/history`).set(bearer(studentJ)).expect(200);
      expect(student.body.attempts).toHaveLength(3);
      expect(student.body.resubmissionRequests).toEqual([
        expect.objectContaining({ type: 'RESUBMISSION_REQUESTED', note: 'Prove the pattern holds for every term.' }),
      ]);
      expect(student.body.resubmissionRequests[0]).not.toHaveProperty('by');

      const staff = await ctx.http().get(`/api/v1/submissions/${subId}/history`).set(bearer(admin)).expect(200);
      expect(staff.body.resubmissionRequests[0].by).toMatchObject({ username: 'mentor.j' });

      const reviews = await ctx.http().get(`/api/v1/submissions/${subId}/reviews`).set(bearer(admin)).expect(200);
      expect(reviews.body.map((r: any) => r.status)).toEqual(['RESUBMISSION_REQUESTED', 'ASSIGNED']);
    });

    it('cannot exceed the assignment\'s resubmission limit', async () => {
      // Two resubmissions used (one voluntary, one requested) — the limit is 2.
      await ctx.http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(mentorJ)).expect(200);
      const res = await ctx.http().patch(`/api/v1/submissions/${subId}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'One more time please.' }).expect(400);
      expect(res.body.code).toBe('RESUBMISSION_LIMIT_REACHED');
    });

    it('then completes normally and is shown as Reviewed', async () => {
      await ctx.http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(mentorJ))
        .field('score', '9').field('mentorFeedback', 'Clear induction proof.').expect(200);
      await ctx.http().patch(`/api/v1/submissions/${subId}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(admin)).send({}).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${subId}/publish`).set(bearer(admin)).expect(200);

      const mine = await ctx.http().get(`/api/v1/submissions/${subId}`).set(bearer(studentJ)).expect(200);
      expect(mine.body).toMatchObject({ displayStatus: 'Reviewed', result: { score: 9 } });
    });
  });

  describe('request rules', () => {
    let other: string;

    beforeAll(async () => {
      const a = await publish({ title: 'Sequences II', maxResubmissions: 0 });
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ2))
        .field('assignmentId', a.id).field('answerText', 'First go.').expect(201);
      other = res.body.id;
      await ctx.http().patch(`/api/v1/submissions/${other}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior2 }).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${other}/start-review`).set(bearer(mentorJ2)).expect(200);
    });

    it('the student cannot resubmit after the request\'s due date', async () => {
      await ctx.http().patch(`/api/v1/submissions/${other}/request-resubmission`).set(bearer(mentorJ2))
        .send({ note: 'Please add a diagram.' }).expect(200);
      await ctx.prisma.submission.update({ where: { id: other }, data: { resubmissionDueAt: new Date(Date.now() - 1000) } });

      const sub = await ctx.prisma.submission.findUniqueOrThrow({ where: { id: other }, select: { assignmentId: true } });
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ2))
        .field('assignmentId', sub.assignmentId).field('answerText', 'Too late.').expect(400);
      expect(res.body.code).toBe('RESUBMISSION_WINDOW_CLOSED');
    });

    it('the mentor withdraws the request and reviews the work as submitted', async () => {
      const res = await ctx.http().patch(`/api/v1/submissions/${other}/withdraw-resubmission-request`).set(bearer(mentorJ2)).expect(200);
      expect(res.body).toMatchObject({ status: 'IN_REVIEW', review: { status: 'IN_PROGRESS' }, resubmissionRequest: null });
      const mine = await ctx.http().get(`/api/v1/submissions/${other}`).set(bearer(studentJ2)).expect(200);
      expect(mine.body.displayStatus).toBe('Pending Review');
    });

    it('is refused where the assignment does not permit resubmissions', async () => {
      const a = await publish({ title: 'One shot', allowResubmission: false, maxResubmissions: 0 });
      const s = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', a.id).field('answerText', 'Only attempt.').expect(201);
      await ctx.http().patch(`/api/v1/submissions/${s.body.id}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);

      const res = await ctx.http().patch(`/api/v1/submissions/${s.body.id}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'Please redo.' }).expect(400);
      expect(res.body.code).toBe('RESUBMISSION_NOT_ALLOWED');

      // …and the student cannot resubmit on their own either.
      const again = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', a.id).field('answerText', 'Second attempt.').expect(400);
      expect(again.body.code).toBe('RESUBMISSION_NOT_ALLOWED');
    });

    it('rejects an invalid due date', async () => {
      const a = await publish({ title: 'Dates' });
      const s = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', a.id).field('answerText', 'Attempt.').expect(201);
      await ctx.http().patch(`/api/v1/submissions/${s.body.id}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${s.body.id}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'Please redo.', dueAt: 'tomorrow' }).expect(400);
      await ctx.http().patch(`/api/v1/submissions/${s.body.id}/request-resubmission`).set(bearer(mentorJ))
        .send({ note: 'Please redo.', dueAt: inDays(90) }).expect(400);
    });
  });
});
