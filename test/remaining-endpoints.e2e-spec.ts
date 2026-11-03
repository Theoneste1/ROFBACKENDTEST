/**
 * Endpoints not exercised by the feature suites: course completion and the
 * student's own lists, assignment and resource attachments, assignment recall
 * and unpublishing, resource unpublish/restore, feedback-file management,
 * divisions, schools, leaderboard, mentor applications, bulk e-mail jobs,
 * hidden comments, academic years and signing out everywhere.
 *
 * Each test checks the behaviour and who may (and may not) call the route.
 */
import { EmailWorker } from '../src/email/email.worker.js';
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

describe('Remaining endpoints (e2e)', () => {
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

  const http = () => ctx.http();
  const draft = async (title = 'Attachments') => (await http().post('/api/v1/assignments').set(bearer(mentorJ))
    .field('title', title).field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
    .field('instructions', 'Solve every problem.').field('deadline', inDays(5)).field('points', '10').field('maximumMarks', '10')
    .expect(201)).body.id as string;

  // ═══════════════════════════════════════════════════════════════════════════
  describe('courses: the student\'s own view', () => {
    it('a student completes a course they opened, and sees it in their course list', async () => {
      const notOpened = await http().post(`/api/v1/courses/${ctx.ids.geometry}/complete`).set(bearer(studentJ)).expect(400);
      expect(notOpened.body.code).toBe('COURSE_NOT_OPENED');

      await http().get(`/api/v1/courses/${ctx.ids.geometry}`).set(bearer(studentJ)).expect(200); // opening it
      const done = await http().post(`/api/v1/courses/${ctx.ids.geometry}/complete`).set(bearer(studentJ)).expect(200);
      expect(done.body).toMatchObject({ enrollmentStatus: 'COMPLETED' });
      const again = await http().post(`/api/v1/courses/${ctx.ids.geometry}/complete`).set(bearer(studentJ)).expect(200);
      expect(again.body.alreadyCompleted).toBe(true);

      const mine = await http().get('/api/v1/me/courses').set(bearer(studentJ)).expect(200);
      const list = Array.isArray(mine.body) ? mine.body : mine.body.data;
      expect(list.find((c: any) => c.id === ctx.ids.geometry || c.course?.id === ctx.ids.geometry)).toBeTruthy();

      await http().post(`/api/v1/courses/${ctx.ids.geometry}/complete`).set(bearer(mentorJ)).expect(403);
      await http().get('/api/v1/me/courses').set(bearer(mentorJ)).expect(403);
    });

    it('a student lists only their own submissions', async () => {
      const a = await ctx.prisma.assignment.create({ data: {
        title: 'Mine only', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      } });
      for (const token of [studentJ, studentJ2]) {
        await http().post('/api/v1/submissions').set(bearer(token)).field('assignmentId', a.id).field('answerText', 'x = 2').expect(201);
      }
      const mine = await http().get('/api/v1/me/submissions').set(bearer(studentJ)).expect(200);
      const rows = Array.isArray(mine.body) ? mine.body : mine.body.data;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(ctx.ids.studentJunior2);
      await http().get('/api/v1/me/submissions').set(bearer(mentorJ)).expect(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('assignments: attachments, recall and unpublish', () => {
    it('the author adds, downloads and removes brief attachments; others cannot', async () => {
      const id = await draft();
      const added = await http().post(`/api/v1/assignments/${id}/attachments`).set(bearer(mentorJ))
        .attach('files', PDF, 'brief.pdf').attach('files', PDF, 'formulas.pdf').expect(201);
      const attachments = added.body.attachments;
      expect(attachments.map((x: any) => x.file.originalName)).toEqual(['brief.pdf', 'formulas.pdf']);

      await http().post(`/api/v1/assignments/${id}/attachments`).set(bearer(mentorS)).attach('files', PDF, 'x.pdf').expect(403);
      await http().post(`/api/v1/assignments/${id}/attachments`).set(bearer(admin)).attach('files', PDF, 'x.pdf').expect(403);

      const file = await http().get(`/api/v1/assignments/${id}/attachments/${attachments[0].id}/file`).set(bearer(mentorJ)).expect(200);
      expect(file.headers['content-type']).toContain('application/pdf');
      expect(file.headers['content-disposition']).toContain('brief.pdf');
      // Students cannot fetch the files of a draft.
      await http().get(`/api/v1/assignments/${id}/attachments/${attachments[0].id}/file`).set(bearer(studentJ)).expect(404);

      await http().delete(`/api/v1/assignments/${id}/attachments/${attachments[1].id}`).set(bearer(mentorJ)).expect(200);
      const after = await http().get(`/api/v1/assignments/${id}`).set(bearer(mentorJ)).expect(200);
      expect(after.body.attachments.map((x: any) => x.file.originalName)).toEqual(['brief.pdf']);
    });

    it('a mentor recalls an assignment awaiting approval; an admin unpublishes one without submissions', async () => {
      const id = await draft('Recall me');
      await http().patch(`/api/v1/assignments/${id}/submit`).set(bearer(mentorJ)).expect(200);
      const recalled = await http().patch(`/api/v1/assignments/${id}/recall`).set(bearer(mentorJ)).expect(200);
      expect(recalled.body.status).toBe('DRAFT');
      await http().patch(`/api/v1/assignments/${id}/recall`).set(bearer(mentorJ)).expect(409);

      await http().patch(`/api/v1/assignments/${id}/submit`).set(bearer(mentorJ)).expect(200);
      await http().patch(`/api/v1/assignments/${id}/publish`).set(bearer(admin)).expect(200);
      await http().patch(`/api/v1/assignments/${id}/unpublish`).set(bearer(mentorJ)).expect(403);
      const unpublished = await http().patch(`/api/v1/assignments/${id}/unpublish`).set(bearer(admin)).expect(200);
      expect(unpublished.body.status).toBe('DRAFT');

      // Not once students have submitted.
      await http().patch(`/api/v1/assignments/${id}/submit`).set(bearer(mentorJ)).expect(200);
      await http().patch(`/api/v1/assignments/${id}/publish`).set(bearer(admin)).expect(200);
      await http().post('/api/v1/submissions').set(bearer(studentJ)).field('assignmentId', id).field('answerText', 'Done').expect(201);
      await http().patch(`/api/v1/assignments/${id}/unpublish`).set(bearer(admin)).expect(409);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('course resources: attachments, unpublish and restore', () => {
    const base = () => `/api/v1/courses/${ctx.ids.algebra}/resources`;
    let resourceId: string;

    beforeAll(async () => {
      const r = await http().post(base()).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'Week 1 notes').attach('file', PDF, 'week1.pdf').expect(201);
      resourceId = r.body.id;
      await http().patch(`${base()}/${resourceId}/publish`).set(bearer(mentorJ)).expect(200);
    });

    it('mentors of the scope add and remove files; students download published files of their division', async () => {
      const added = await http().post(`${base()}/${resourceId}/attachments`).set(bearer(mentorJ)).attach('files', PDF, 'week1-solutions.pdf').expect(201);
      const att = added.body.attachments.find((a: any) => a.file.originalName === 'week1-solutions.pdf');
      await http().post(`${base()}/${resourceId}/attachments`).set(bearer(mentorS)).attach('files', PDF, 'x.pdf').expect(403);
      await http().post(`${base()}/${resourceId}/attachments`).set(bearer(studentJ)).attach('files', PDF, 'x.pdf').expect(403);

      const dl = await http().get(`${base()}/${resourceId}/attachments/${att.id}/file`).set(bearer(studentJ)).expect(200);
      expect(dl.headers['content-type']).toContain('application/pdf');
      await http().get(`${base()}/${resourceId}/attachments/${att.id}/file`).set(bearer(studentS)).expect(404);

      await http().delete(`${base()}/${resourceId}/attachments/${att.id}`).set(bearer(mentorJ)).expect(200);
      await http().get(`${base()}/${resourceId}/attachments/${att.id}/file`).set(bearer(studentJ)).expect(404);
    });

    it('unpublishing hides a resource from students; an archived one can be restored', async () => {
      await http().patch(`${base()}/${resourceId}/unpublish`).set(bearer(mentorJ)).expect(200);
      await http().get(`${base()}/${resourceId}`).set(bearer(studentJ)).expect(404);
      await http().patch(`${base()}/${resourceId}/publish`).set(bearer(mentorJ)).expect(200);

      await http().patch(`${base()}/${resourceId}/archive`).set(bearer(mentorJ)).expect(200);
      await http().get(`${base()}/${resourceId}`).set(bearer(studentJ)).expect(404);
      await http().patch(`${base()}/${resourceId}/restore`).set(bearer(studentJ)).expect(403);
      await http().patch(`${base()}/${resourceId}/restore`).set(bearer(mentorJ)).expect(200);
      await http().patch(`${base()}/${resourceId}/publish`).set(bearer(mentorJ)).expect((r) => {
        if (![200, 409].includes(r.status)) throw new Error(`publish after restore: ${r.status}`);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('mentor feedback files', () => {
    it('the reviewing mentor removes a feedback file before returning; the student downloads the rest once published', async () => {
      const a = await ctx.prisma.assignment.create({ data: {
        title: 'Feedback files', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      } });
      const sid = (await http().post('/api/v1/submissions').set(bearer(studentJ2)).field('assignmentId', a.id).field('answerText', 'Proof').expect(201)).body.id;
      await http().patch(`/api/v1/submissions/${sid}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await http().patch(`/api/v1/submissions/${sid}/start-review`).set(bearer(mentorJ)).expect(200);
      const marked = await http().patch(`/api/v1/submissions/${sid}/mark`).set(bearer(mentorJ))
        .field('score', '9').field('mentorFeedback', 'Neat.').attach('feedbackFiles', PDF, 'keep.pdf').attach('feedbackFiles', PDF, 'remove.pdf').expect(200);
      const [keep, remove] = marked.body.review.attachments;

      await http().delete(`/api/v1/submissions/${sid}/review/attachments/${remove.id}`).set(bearer(admin)).expect(403);
      await http().delete(`/api/v1/submissions/${sid}/review/attachments/${remove.id}`).set(bearer(mentorS)).expect(403);
      await http().delete(`/api/v1/submissions/${sid}/review/attachments/${remove.id}`).set(bearer(mentorJ)).expect(200);

      // Not visible to the student before publication.
      await http().get(`/api/v1/submissions/${sid}/feedback-files/${keep.id}`).set(bearer(studentJ2)).expect(403);

      await http().patch(`/api/v1/submissions/${sid}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
      await http().delete(`/api/v1/submissions/${sid}/review/attachments/${keep.id}`).set(bearer(mentorJ)).expect(409);
      await http().patch(`/api/v1/submissions/${sid}/approve`).set(bearer(admin)).send({}).expect(200);
      await http().patch(`/api/v1/submissions/${sid}/publish`).set(bearer(admin)).expect(200);

      const file = await http().get(`/api/v1/submissions/${sid}/feedback-files/${keep.id}`).set(bearer(studentJ2)).expect(200);
      expect(file.headers['content-disposition']).toContain('keep.pdf');
      await http().get(`/api/v1/submissions/${sid}/feedback-files/${remove.id}`).set(bearer(studentJ2)).expect(404);
      // Another student cannot.
      await http().get(`/api/v1/submissions/${sid}/feedback-files/${keep.id}`).set(bearer(studentJ)).expect(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('reference data and the leaderboard', () => {
    it('divisions: public list; administrators rename', async () => {
      const pub = await http().get('/api/v1/divisions').expect(200);
      expect(pub.body.map((d: any) => d.code).sort()).toEqual(['JUNIOR', 'SENIOR']);
      const all = await http().get('/api/v1/admin/divisions').set(bearer(admin)).expect(200);
      expect(all.body.length).toBe(2);
      await http().get('/api/v1/admin/divisions').set(bearer(mentorJ)).expect(403);

      const renamed = await http().patch(`/api/v1/admin/divisions/${ctx.ids.junior}`).set(bearer(admin)).send({ name: 'Junior (S1–S3)' }).expect(200);
      expect(renamed.body.name).toBe('Junior (S1–S3)');
      await http().patch(`/api/v1/admin/divisions/${ctx.ids.junior}`).set(bearer(admin)).send({ code: 'HACK' }).expect(400);
      await http().patch(`/api/v1/admin/divisions/${ctx.ids.junior}`).set(bearer(studentJ)).send({ name: 'x' }).expect(403);
    });

    it('schools: a public search for sign-up exposes names only; administrators see details', async () => {
      const found = await http().get('/api/v1/schools/search').query({ q: 'Test' }).expect(200);
      expect(found.body).toEqual([expect.objectContaining({ name: 'Test School' })]);
      expect(Object.keys(found.body[0]).sort()).toEqual(['id', 'location', 'name']);
      await http().get('/api/v1/schools/search').query({ q: 'T' }).expect(400);

      const list = await http().get('/api/v1/schools').set(bearer(admin)).expect(200);
      const schoolId = (list.body.data ?? list.body)[0].id;
      await http().get(`/api/v1/schools/${schoolId}`).set(bearer(admin)).expect(200);
      await http().get('/api/v1/schools').set(bearer(mentorJ)).expect(403);
      await http().get(`/api/v1/schools/${schoolId}`).set(bearer(studentJ)).expect(403);
    });

    it('leaderboard: a student\'s own rank, school summary, and an administrator recompute', async () => {
      const me = await http().get('/api/v1/leaderboard/me').set(bearer(studentJ)).expect(200);
      expect(me.body).toHaveProperty('points');
      await http().get('/api/v1/leaderboard/me').set(bearer(mentorJ)).expect(403);

      await http().get('/api/v1/leaderboard/schools').set(bearer(studentJ)).expect(200);
      await http().post('/api/v1/admin/leaderboard/recompute').set(bearer(studentJ)).expect(403);
      await http().post('/api/v1/admin/leaderboard/recompute').set(bearer(admin)).expect((r) => {
        if (r.status !== 200 && r.status !== 201) throw new Error(`recompute: ${r.status}`);
      });
    });

    it('academic years are listed for everyone signed in', async () => {
      const years = await http().get('/api/v1/academic-years').set(bearer(studentJ)).expect(200);
      expect((years.body.data ?? years.body).some((y: any) => y.id === ctx.ids.year)).toBe(true);
      await http().get('/api/v1/academic-years').expect(401);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('administration', () => {
    it('administrators reject a mentor application', async () => {
      const apply = await http().post('/api/v1/mentor-requests')
        .send({ firstName: 'Jean', lastName: 'Applicant', username: 'jean.app', email: 'jean.app@example.com', password: 'Mentor123' }).expect(201);
      await http().patch(`/api/v1/mentor-requests/${apply.body.id}/reject`).set(bearer(mentorJ)).expect(403);
      await http().patch(`/api/v1/mentor-requests/${apply.body.id}/reject`).set(bearer(admin)).expect(200);
      await http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(409);
      expect(await ctx.prisma.user.count({ where: { username: 'jean.app' } })).toBe(0);
    });

    it('bulk e-mail: recipients, jobs, deliveries and retry', async () => {
      const users = await http().get('/api/v1/admin/email/users').query({ role: 'STUDENT' }).set(bearer(admin)).expect(200);
      expect((users.body.data ?? users.body).every((u: any) => !('passwordHash' in u))).toBe(true);

      const job = await http().post('/api/v1/admin/email/send').set(bearer(admin)).send({
        idempotencyKey: 'remaining-endpoints-1', recipientMode: 'ROLE', recipientRole: 'MENTOR', subject: 'Meeting', body: 'Friday 10:00.',
      }).expect(201);
      const worker = ctx.app.get(EmailWorker);
      while ((await worker.processBatch()) > 0) { /* drain */ }

      const jobs = await http().get('/api/v1/admin/email/jobs').set(bearer(admin)).expect(200);
      expect(jobs.body.data.map((j: any) => j.id)).toContain(job.body.id);
      const deliveries = await http().get(`/api/v1/admin/email/jobs/${job.body.id}/deliveries`).set(bearer(admin)).expect(200);
      expect(deliveries.body.data.length).toBe(job.body.totalRecipients);
      // Nothing failed, so there is nothing to retry.
      const retry = await http().post(`/api/v1/admin/email/jobs/${job.body.id}/retry`).set(bearer(admin)).expect(400);
      expect(retry.body.code).toBe('NOTHING_TO_RETRY');

      for (const path of ['/api/v1/admin/email/users', '/api/v1/admin/email/jobs', `/api/v1/admin/email/jobs/${job.body.id}/deliveries`]) {
        await http().get(path).set(bearer(mentorJ)).expect(403);
      }
      await http().post(`/api/v1/admin/email/jobs/${job.body.id}/retry`).set(bearer(studentJ)).expect(403);
    });

    it('administrators list hidden comments for review', async () => {
      const t = await http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ)).send({ title: 'Off topic', content: 'Buy now' }).expect(201);
      const comment = (await http().get(`/api/v1/threads/${t.body.id}/comments`).set(bearer(studentJ)).expect(200)).body.data[0];
      await http().patch(`/api/v1/comments/${comment.id}/hide`).set(bearer(admin)).send({ reason: 'Spam' }).expect(200);
      const hidden = await http().get('/api/v1/admin/comments/hidden').set(bearer(admin)).expect(200);
      expect(hidden.body.data.map((c: any) => c.id)).toContain(comment.id);
      await http().get('/api/v1/admin/comments/hidden').set(bearer(mentorJ)).expect(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  it('signing out everywhere revokes every refresh token of that user only', async () => {
    const first  = await http().post('/api/v1/auth/login').send({ username: 'student.s', password: 'Passw0rd!' }).expect(200);
    const second = await http().post('/api/v1/auth/login').send({ username: 'student.s', password: 'Passw0rd!' }).expect(200);
    await http().post('/api/v1/auth/logout-all').set(bearer(second.body.access_token)).expect((r) => {
      if (r.status !== 200 && r.status !== 204) throw new Error(`logout-all: ${r.status}`);
    });
    for (const s of [first, second]) {
      expect(s.body.refresh_token).toBeTruthy();
      await http().post('/api/v1/auth/refresh').send({ refreshToken: s.body.refresh_token }).expect(401);
    }
    // Other users are unaffected.
    await http().get('/api/v1/users/me').set(bearer(studentJ)).expect((r) => {
      if (r.status === 401) throw new Error('another user was signed out');
    });
    await http().post('/api/v1/auth/logout-all').expect(401);
  });
});
