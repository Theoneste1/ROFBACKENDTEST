/**
 * Authorization boundaries: roles, division scoping, mentor scoping,
 * submission ownership and upload validation.
 */
import { createTestApp, login, bearer, PDF, EXE, inDays, type TestContext } from './helpers.js';

describe('Access control (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorS: string, studentJ: string, studentJ2: string, studentS: string;
  let juniorAssignment: string;
  let submissionJ: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorS, studentJ, studentJ2, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.s', 'student.j', 'student.j2', 'student.s'].map((u) => login(ctx, u)),
    );

    const a = await ctx.prisma.assignment.create({
      data: {
        title: 'Junior algebra set', instructions: 'Solve the problems.', deadline: new Date(inDays(5)),
        points: 10, maximumMarks: 10, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
    juniorAssignment = a.id;

    const sub = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', juniorAssignment).attach('file', PDF, 'work.pdf').expect(201);
    submissionJ = sub.body.id;
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('roles', () => {
    it.each([
      ['GET',   '/api/v1/admin/users'],
      ['GET',   '/api/v1/admin/audit-logs'],
      ['GET',   '/api/v1/admin/settings'],
      ['GET',   '/api/v1/admin/reports/overview'],
      ['GET',   '/api/v1/submissions'],
      ['POST',  '/api/v1/admin/mentor-assignments'],
    ])('students are refused %s %s', async (method, path) => {
      const req = method === 'GET' ? ctx.http().get(path) : ctx.http().post(path).send({});
      await req.set(bearer(studentJ)).expect(403);
    });

    it('admins cannot prepare assignments (mentors only)', async () => {
      await ctx.http().post('/api/v1/assignments').set(bearer(admin))
        .field('title', 'x').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
        .field('instructions', 'xxxxxxxxxxxx').field('deadline', inDays(3)).field('points', '1').field('maximumMarks', '1')
        .expect(403);
    });

    it('admins cannot score or give feedback', async () => {
      await ctx.http().patch(`/api/v1/submissions/${submissionJ}/mark`).set(bearer(admin))
        .send({ score: 10, mentorFeedback: 'Great' }).expect(403);
    });
  });

  describe('division scoping', () => {
    it('a senior student cannot see a junior assignment', async () => {
      await ctx.http().get(`/api/v1/assignments/${juniorAssignment}`).set(bearer(studentS)).expect(404);
      const list = await ctx.http().get('/api/v1/me/assignments').set(bearer(studentS)).expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('a senior student cannot submit to a junior assignment', async () => {
      await ctx.http().post('/api/v1/submissions').set(bearer(studentS))
        .field('assignmentId', juniorAssignment).attach('file', PDF, 'x.pdf').expect(404);
    });

    it('a mentor of another division cannot create content in this one', async () => {
      const res = await ctx.http().post('/api/v1/assignments').set(bearer(mentorS))
        .field('title', 'Wrong division').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
        .field('instructions', 'xxxxxxxxxxxx').field('deadline', inDays(3)).field('points', '1').field('maximumMarks', '1')
        .expect(403);
      expect(res.body.code).toBe('NOT_ASSIGNED_TO_SCOPE');
    });

    it('a mentor not assigned to a course cannot add resources to it', async () => {
      await ctx.http().post(`/api/v1/courses/${ctx.ids.geometry}/resources`).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'Circles').expect(403);
    });

    it('an unpublished course hides its content from students', async () => {
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}/unpublish`).set(bearer(admin)).expect(200);
      await ctx.http().get(`/api/v1/assignments/${juniorAssignment}`).set(bearer(studentJ)).expect(404);
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}/publish`).set(bearer(admin)).expect(200);
      await ctx.http().get(`/api/v1/assignments/${juniorAssignment}`).set(bearer(studentJ)).expect(200);
    });
  });

  describe('submission ownership', () => {
    it('another student cannot read or download someone else\'s submission', async () => {
      await ctx.http().get(`/api/v1/submissions/${submissionJ}`).set(bearer(studentJ2)).expect(404);
      await ctx.http().get(`/api/v1/submissions/${submissionJ}/file`).set(bearer(studentJ2)).expect(404);
    });

    it('the owner can download their own submission', async () => {
      const res = await ctx.http().get(`/api/v1/submissions/${submissionJ}/file`).set(bearer(studentJ)).expect(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('a mentor cannot open a submission before it is assigned to them', async () => {
      await ctx.http().get(`/api/v1/submissions/${submissionJ}`).set(bearer(mentorJ)).expect(404);
    });

    it('distribution only uses mentors of the matching course × division', async () => {
      const res = await ctx.http().patch(`/api/v1/submissions/${submissionJ}/assign`).set(bearer(admin))
        .send({ mentorId: ctx.ids.mentorSenior }).expect(400);
      expect(res.body.code).toBe('MENTOR_NOT_ELIGIBLE');
    });

    it('resubmitting while assigned returns the work to the queue', async () => {
      await ctx.http().patch(`/api/v1/submissions/${submissionJ}/assign`).set(bearer(admin))
        .send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await ctx.prisma.assignment.update({ where: { id: juniorAssignment }, data: { allowResubmission: true } });

      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', juniorAssignment).attach('file', PDF, 'v2.pdf').expect(201);
      expect(res.body.status).toBe('SUBMITTED');
      const row = await ctx.prisma.submission.findUniqueOrThrow({ where: { id: submissionJ } });
      expect(row.mentorId).toBeNull();
    });

    it('work under review can no longer be replaced', async () => {
      await ctx.http().patch(`/api/v1/submissions/${submissionJ}/assign`).set(bearer(admin))
        .send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${submissionJ}/start-review`).set(bearer(mentorJ)).expect(200);

      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', juniorAssignment).attach('file', PDF, 'v3.pdf').expect(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });
  });

  describe('uploads', () => {
    it('rejects a file whose content is not an allowed type, whatever its name', async () => {
      const res = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'Notes')
        .attach('file', EXE, { filename: 'notes.pdf', contentType: 'application/pdf' })
        .expect(415);
      expect(res.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      expect(await ctx.prisma.fileObject.count({ where: { purpose: 'RESOURCE' } })).toBe(0);
    });

    it('requires a file when submitting', async () => {
      const other = await ctx.prisma.assignment.create({
        data: {
          title: 'Another', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 1, maximumMarks: 1,
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year, createdById: ctx.ids.mentorJunior, status: 'PUBLISHED',
        },
      });
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ2))
        .field('assignmentId', other.id).expect(400);
      expect(res.body.code).toBe('FILE_REQUIRED');
    });

    it('stores resources with the detected type and serves PDFs inline', async () => {
      const created = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'Factoring notes')
        .attach('file', PDF, 'factoring.pdf').expect(201);

      // Unpublished resources are invisible to students.
      await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/resources/${created.body.id}`).set(bearer(studentJ)).expect(404);
      await ctx.http().patch(`/api/v1/courses/${ctx.ids.algebra}/resources/${created.body.id}/publish`).set(bearer(mentorJ)).expect(200);

      const file = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/resources/${created.body.id}/file`)
        .set(bearer(studentJ)).expect(200);
      expect(file.headers['content-type']).toBe('application/pdf');
      expect(file.headers['content-disposition']).toMatch(/^inline/);

      // Senior students don't see junior resources.
      const senior = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}/resources`).set(bearer(studentS)).expect(200);
      expect(senior.body).toHaveLength(0);
    });
  });
});
