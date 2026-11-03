/**
 * Administrator dashboard and reports, checked against a dataset whose every
 * number is known: students in several account states and two academic
 * years, published/draft assignments, submissions at different stages, a
 * review that was sent back, a published result, a reported comment, a live
 * session. Also filters, validation, CSV exports and authorization.
 */
import { createTestApp, login, bearer, inDays, PDF, type TestContext, waitForEvents } from './helpers.js';

describe('Admin dashboard and reports (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, studentJ: string, studentJ2: string, studentS: string;
  let pastYear: string, a1: string, a2: string, a3: string;

  const get = (path: string, query: Record<string, string | number> = {}, token = admin) =>
    ctx.http().get(`/api/v1${path}`).query(query).set(bearer(token));

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, studentJ, studentJ2, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'student.j', 'student.j2', 'student.s'].map((u) => login(ctx, u)),
    );
    const p = ctx.prisma;
    const { year, junior, algebra, geometry } = ctx.ids;
    const school = (await p.user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).schoolId;

    // Accounts in other states: a suspended student, an invited student and an invited mentor.
    const suspended = await p.user.create({ data: {
      username: 'student.x', email: 'x@test.local', firstName: 'Xavier', lastName: 'Suspended', role: 'STUDENT',
      isActive: false, activatedAt: new Date(), gradeLevel: 'S1', divisionId: junior, schoolId: school,
    } });
    const invited = await p.user.create({ data: {
      username: 'student.inv', email: 'inv@test.local', firstName: 'Ines', lastName: 'Invited', role: 'STUDENT',
      activatedAt: null, gradeLevel: 'S1', divisionId: junior, schoolId: school,
    } });
    await p.user.create({ data: { username: 'mentor.inv', email: 'minv@test.local', firstName: 'Max', lastName: 'Invited', role: 'MENTOR', activatedAt: null } });
    await p.studentEnrollment.createMany({ data: [suspended, invited].map((u) => ({
      studentId: u.id, academicYearId: year, gradeLevel: 'S1', divisionId: junior, schoolId: school,
    })) });

    // Last year: student.j was enrolled (then promoted) and one assignment ran.
    pastYear = (await p.academicYear.create({ data: {
      name: '2025-2026', startsOn: new Date('2025-09-01'), endsOn: new Date('2026-07-31'), status: 'CLOSED',
    } })).id;
    await p.studentEnrollment.create({ data: {
      studentId: ctx.ids.studentJunior, academicYearId: pastYear, gradeLevel: 'S1', divisionId: junior, schoolId: school, status: 'PROMOTED',
    } });

    const assignment = (data: Record<string, unknown>) => p.assignment.create({ data: {
      title: 'x', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 20, maximumMarks: 20,
      courseId: algebra, divisionId: junior, academicYearId: year, createdById: ctx.ids.mentorJunior,
      status: 'PUBLISHED', publishedAt: new Date(), ...data,
    } });
    a1 = (await assignment({ title: 'Junior algebra 1' })).id;
    a2 = (await assignment({ title: 'Senior algebra 1', divisionId: ctx.ids.senior, createdById: ctx.ids.mentorSenior })).id;
    a3 = (await assignment({ title: 'Junior draft', status: 'DRAFT', publishedAt: null })).id;
    await assignment({ title: 'Last year', academicYearId: pastYear, deadline: new Date('2026-03-01') });

    // Course participation.
    await p.courseEnrollment.createMany({ data: [
      { courseId: algebra,  studentId: ctx.ids.studentJunior,  status: 'ROLLED' },
      { courseId: geometry, studentId: ctx.ids.studentJunior,  status: 'COMPLETED', completedAt: new Date() },
      { courseId: algebra,  studentId: ctx.ids.studentJunior2, status: 'ROLLED' },
      { courseId: algebra,  studentId: ctx.ids.studentSenior,  status: 'ROLLED' },
    ] });

    // Submissions: j → reviewed, sent back once, approved, published (16/20 = 80%);
    // j2 → assigned to mentor.j2 (pending); s → waiting for distribution.
    const submit = async (token: string, assignmentId: string) =>
      (await ctx.http().post('/api/v1/submissions').set(bearer(token)).field('assignmentId', assignmentId)
        .attach('files', PDF, 'work.pdf').expect(201)).body.id as string;
    const subJ = await submit(studentJ, a1);
    const subJ2 = await submit(studentJ2, a1);
    await submit(studentS, a2);

    const http = ctx.http;
    await http().patch(`/api/v1/submissions/${subJ}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
    await http().patch(`/api/v1/submissions/${subJ2}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior2 }).expect(200);
    const markAndReturn = async (score: string) => {
      await http().patch(`/api/v1/submissions/${subJ}/start-review`).set(bearer(mentorJ)).expect(200);
      await http().patch(`/api/v1/submissions/${subJ}/mark`).set(bearer(mentorJ)).field('score', score).field('mentorFeedback', 'Good.').expect(200);
      await http().patch(`/api/v1/submissions/${subJ}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
    };
    await markAndReturn('15');
    await http().patch(`/api/v1/submissions/${subJ}/reject`).set(bearer(admin)).send({ rejectionReason: 'Explain (b).' }).expect(200);
    await markAndReturn('16');
    await http().patch(`/api/v1/submissions/${subJ}/approve`).set(bearer(admin)).send({}).expect(200);
    await http().patch(`/api/v1/submissions/${subJ}/publish`).set(bearer(admin)).expect(200);

    // Discussion: a thread with a mentor reply; the reply gets reported.
    const thread = await http().post(`/api/v1/courses/${algebra}/threads`).set(bearer(studentJ))
      .send({ title: 'Question', content: 'How?' }).expect(201);
    const reply = await http().post(`/api/v1/threads/${thread.body.id}/comments`).set(bearer(mentorJ)).send({ content: 'Like this.' }).expect(201);
    await http().post(`/api/v1/comments/${reply.body.id}/report`).set(bearer(studentJ2)).send({ reason: 'OFF_TOPIC' }).expect(201);

    // A live session hosted by mentor.j.
    await p.liveSession.create({ data: {
      courseId: algebra, divisionId: junior, academicYearId: year, hostId: ctx.ids.mentorJunior, title: 'Clinic',
      startsAt: new Date(inDays(2)), endsAt: new Date(inDays(2.04)), provider: 'ZOOM', meetingUrl: 'https://zoom.us/j/1',
    } });
    await waitForEvents();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('dashboard', () => {
    it('returns accurate statistics for the current academic year', async () => {
      const { body } = await get('/admin/dashboard').expect(200);
      expect(body.filters.academicYear).toMatchObject({ id: ctx.ids.year, name: '2026-2027' });

      expect(body.students).toMatchObject({ total: 5, active: 3, inactive: 1, awaitingSetup: 1, registeredInRange: null });
      expect(body.students.byDivision.map((d: any) => [d.code, d.students])).toEqual([['JUNIOR', 2], ['SENIOR', 1]]);
      const course = (code: string) => body.students.byCourse.find((c: any) => c.code === code);
      expect(course('ALGEBRA')).toMatchObject({ participating: 3, completed: 0 });
      expect(course('GEOMETRY')).toMatchObject({ participating: 1, completed: 1 });

      expect(body.mentors).toMatchObject({ total: 4, active: 3, inactive: 0, awaitingSetup: 1 });
      expect(body.mentors.activity.mentorsWithCompletedReviews).toBe(1);
      expect(body.mentors.activity.mostReviewsCompleted).toEqual([
        expect.objectContaining({ mentor: expect.objectContaining({ username: 'mentor.j' }), reviewsCompleted: 1, openReviews: 0 }),
      ]);

      expect(body.assignments).toMatchObject({ published: 2, byStatus: { PUBLISHED: 2, DRAFT: 1 } });
      expect(body.submissions).toMatchObject({ total: 3, late: 0, byStatus: { PUBLISHED: 1, ASSIGNED: 1, SUBMITTED: 1 } });
      expect(body.reviews).toMatchObject({
        pendingMentorReview: 1, pendingByStatus: { ASSIGNED: 1 }, awaitingDistribution: 1, awaitingAdminApproval: 0, completed: 1,
      });
      expect(body.results).toEqual({ published: 1, awaitingPublication: 0 });
      expect(body.reportedContent).toMatchObject({ open: 1, total: 1, byReason: { OFF_TOPIC: 1 } });
      expect(body.accountsAwaitingSetup).toMatchObject({ total: 2, byRole: { STUDENT: 1, MENTOR: 1 } });
    });

    it('filters by division and course', async () => {
      const junior = (await get('/admin/dashboard', { divisionId: ctx.ids.junior }).expect(200)).body;
      expect(junior.students).toMatchObject({ total: 4, active: 2 });
      expect(junior.students.byDivision).toHaveLength(1);
      expect(junior.submissions.total).toBe(2);
      expect(junior.reviews).toMatchObject({ pendingMentorReview: 1, awaitingDistribution: 0 });
      expect(junior.mentors.total).toBe(2);

      const geometry = (await get('/admin/dashboard', { courseId: ctx.ids.geometry }).expect(200)).body;
      expect(geometry.assignments.published).toBe(0);
      expect(geometry.submissions.total).toBe(0);
      expect(geometry.reportedContent.open).toBe(0);
      expect(geometry.students.byCourse).toEqual([expect.objectContaining({ code: 'GEOMETRY', participating: 1 })]);
    });

    it('filters by academic year ("all" or a past year)', async () => {
      const all = (await get('/admin/dashboard', { academicYearId: 'all' }).expect(200)).body;
      expect(all.filters.academicYear).toBe('all');
      expect(all.assignments.published).toBe(3);
      expect(all.students.total).toBe(5);

      const past = (await get('/admin/dashboard', { academicYearId: pastYear }).expect(200)).body;
      expect(past.students.total).toBe(1);
      expect(past.assignments.published).toBe(1);
      expect(past.submissions.total).toBe(0);
    });

    it('a date range limits activity figures, not the current snapshot', async () => {
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      const future = (await get('/admin/dashboard', { from: tomorrow }).expect(200)).body;
      expect(future.submissions.total).toBe(0);
      expect(future.reviews.completed).toBe(0);
      expect(future.results.published).toBe(0);
      expect(future.assignments.published).toBe(0);
      expect(future.students.registeredInRange).toBe(0);
      // Still waiting now:
      expect(future.reviews.pendingMentorReview).toBe(1);
      expect(future.reportedContent.open).toBe(1);

      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const recent = (await get('/admin/dashboard', { from: yesterday, to: today }).expect(200)).body;
      expect(recent.submissions.total).toBe(3);
      expect(recent.students.registeredInRange).toBe(5);
    });

    it('validates the filters', async () => {
      const cases: Array<[Record<string, string>, number, string?]> = [
        [{ academicYearId: 'last-year' }, 400, 'VALIDATION_FAILED'],
        [{ academicYearId: '00000000-0000-4000-8000-000000000000' }, 404],
        [{ divisionId: 'junior' }, 400, 'VALIDATION_FAILED'],
        [{ courseId: '00000000-0000-4000-8000-000000000000' }, 404],
        [{ from: '2026-13-01' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-02-30' }, 400, 'VALIDATION_FAILED'],
        [{ from: '2026-11-10', to: '2026-11-01' }, 400, 'INVALID_DATE_RANGE'],
        [{ unknown: 'x' }, 400, 'VALIDATION_FAILED'],
      ];
      for (const [query, status, code] of cases) {
        const res = await get('/admin/dashboard', query).expect(status);
        if (code) expect(res.body.code, JSON.stringify(query)).toBe(code);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('user reports', () => {
    it('student list: status, division, course and search filters; per-student figures', async () => {
      const all = (await get('/admin/reports/students').expect(200)).body;
      expect(all.meta.total).toBe(5);
      const j = all.data.find((s: any) => s.username === 'student.j');
      expect(j).toMatchObject({
        status: 'ACTIVE', division: { code: 'JUNIOR' }, gradeLevel: 'S2', enrollmentStatus: 'ACTIVE',
        submissions: 1, resultsPublished: 1, school: { name: 'Test School' },
      });
      expect(j).not.toHaveProperty('passwordHash');

      const names = async (q: Record<string, string>) => (await get('/admin/reports/students', q).expect(200)).body.data.map((s: any) => s.username).sort();
      expect(await names({ status: 'ACTIVE' })).toEqual(['student.j', 'student.j2', 'student.s']);
      expect(await names({ status: 'INACTIVE' })).toEqual(['student.x']);
      expect(await names({ status: 'AWAITING_SETUP' })).toEqual(['student.inv']);
      expect(await names({ divisionId: ctx.ids.senior })).toEqual(['student.s']);
      expect(await names({ courseId: ctx.ids.geometry })).toEqual(['student.j']);
      expect(await names({ q: 'J2' })).toEqual(['student.j2']);
      expect(await names({ academicYearId: pastYear })).toEqual(['student.j']);

      const page = (await get('/admin/reports/students', { limit: 2, page: 2 }).expect(200)).body;
      expect(page.meta).toEqual({ total: 5, page: 2, limit: 2, totalPages: 3 });
      expect(page.data).toHaveLength(2);
      await get('/admin/reports/students', { status: 'SLEEPING' }).expect(400);
      await get('/admin/reports/students', { limit: 1000 }).expect(400);
    });

    it('mentor list with scopes, status and open reviews', async () => {
      const all = (await get('/admin/reports/mentors').expect(200)).body;
      expect(all.meta.total).toBe(4);
      expect(all.data.find((m: any) => m.username === 'mentor.j2')).toMatchObject({
        status: 'ACTIVE', openReviews: 1, teaching: [{ course: { code: 'ALGEBRA' }, division: { code: 'JUNIOR' } }],
      });
      const senior = (await get('/admin/reports/mentors', { divisionId: ctx.ids.senior }).expect(200)).body;
      expect(senior.data.map((m: any) => m.username)).toEqual(['mentor.s']);
      const invited = (await get('/admin/reports/mentors', { status: 'AWAITING_SETUP' }).expect(200)).body;
      expect(invited.data.map((m: any) => m.username)).toEqual(['mentor.inv']);
    });

    it('enrolment report by year, division, school and grade', async () => {
      const current = (await get('/admin/reports/enrollment').expect(200)).body;
      expect(current.totals).toEqual({ active: 5, promoted: 0, graduated: 0, withdrawn: 0, total: 5 });
      expect(current.byDivision.find((d: any) => d.division.code === 'JUNIOR')).toMatchObject({ active: 4, total: 4 });
      expect(current.rows.find((r: any) => r.division.code === 'JUNIOR' && r.gradeLevel === 'S1'))
        .toMatchObject({ school: { name: 'Test School' }, active: 2, total: 2 });

      const all = (await get('/admin/reports/enrollment', { academicYearId: 'all' }).expect(200)).body;
      expect(all.totals).toMatchObject({ promoted: 1, total: 6 });

      const res = await get('/admin/reports/enrollment', { courseId: ctx.ids.algebra }).expect(400);
      expect(res.body.code).toBe('FILTER_NOT_SUPPORTED');
    });

    it('course participation per course and division', async () => {
      const { body } = await get('/admin/reports/course-participation').expect(200);
      const row = (course: string, division: string) => body.rows.find((r: any) => r.course.code === course && r.division.code === division);
      expect(row('ALGEBRA', 'JUNIOR')).toMatchObject({
        students: 2, opened: 2, completed: 0, participationRate: 100, assignmentsPublished: 1,
        submissions: 2, studentsSubmitted: 2, submissionRate: 100, averageScore: 80,
        // The opening message and the mentor's reply.
        discussionThreads: 1, discussionComments: 2, liveSessions: 1,
      });
      expect(row('GEOMETRY', 'JUNIOR')).toMatchObject({ students: 2, opened: 1, completed: 1, participationRate: 50, submissions: 0 });
      expect(row('ALGEBRA', 'SENIOR')).toMatchObject({ students: 1, opened: 1, submissions: 1, averageScore: null });

      const filtered = (await get('/admin/reports/course-participation', { courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }).expect(200)).body;
      expect(filtered.rows).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('academic reports', () => {
    it('assignment submission statistics', async () => {
      const { body } = await get('/admin/reports/assignments').expect(200);
      expect(body.summary).toMatchObject({ assignments: 2, submissions: 3, late: 0, byStage: { published: 1, inReview: 1, awaitingDistribution: 1 } });
      const junior = body.data.find((a: any) => a.id === a1);
      expect(junior).toMatchObject({
        title: 'Junior algebra 1', expectedStudents: 2, submitted: 2, onTime: 2, late: 0, notSubmitted: 0,
        submissionRate: 100, averageScore: 80, byStage: { published: 1, inReview: 1, awaitingDistribution: 0 },
      });
      expect(body.data.find((a: any) => a.id === a2)).toMatchObject({ expectedStudents: 1, submitted: 1, byStage: { awaitingDistribution: 1 } });

      const drafts = (await get('/admin/reports/assignments', { status: 'DRAFT' }).expect(200)).body;
      expect(drafts.data.map((a: any) => a.id)).toEqual([a3]);
      await get('/admin/reports/assignments', { status: 'LOST' }).expect(400);
    });

    it('pending and completed review statistics', async () => {
      const { body } = await get('/admin/reports/reviews').expect(200);
      expect(body.pending).toMatchObject({
        total: 1, byStatus: { ASSIGNED: 1 }, byAge: { underTwoDays: 1, twoToSevenDays: 0, overSevenDays: 0 },
        awaitingDistribution: 1, awaitingAdminApproval: 0,
        byMentor: [expect.objectContaining({ mentor: expect.objectContaining({ username: 'mentor.j2' }), open: 1 })],
      });
      expect(body.pending.oldestAssignedAt).toBeTruthy();
      expect(body.completed).toMatchObject({
        total: 1, approvedByAdmin: 1, sentBackByAdmin: 1, published: 1,
        byMentor: [expect.objectContaining({ mentor: expect.objectContaining({ username: 'mentor.j' }), completed: 1 })],
      });
      expect(body.completed.averageTurnaroundHours).toBeGreaterThanOrEqual(0);
      expect(body.completed.medianTurnaroundHours).toBeGreaterThanOrEqual(0);
    });

    it('results publication statistics', async () => {
      const { body } = await get('/admin/reports/results-publication').expect(200);
      expect(body.summary).toMatchObject({
        resultsPublished: 1, awaitingPublication: 0, releases: 1, averagePublishedScore: 80,
        byPublisher: [expect.objectContaining({ publishedBy: expect.objectContaining({ username: 'admin' }), releases: 1, results: 1 })],
      });
      expect(body.meta.total).toBe(2);
      expect(body.data.find((a: any) => a.id === a1)).toMatchObject({
        submissions: 2, published: 1, releases: 1, averageScore: 80, lastPublishedBy: expect.objectContaining({ username: 'admin' }),
      });
    });

    it('mentor activity', async () => {
      const { body } = await get('/admin/reports/mentor-activity').expect(200);
      expect(body.summary).toMatchObject({ mentors: 4, mentorsWithCompletedReviews: 1, reviewsCompleted: 1, openReviews: 1 });
      const row = (u: string) => body.data.find((m: any) => m.username === u);
      expect(row('mentor.j')).toMatchObject({
        status: 'ACTIVE', reviewsAssigned: 1, reviewsCompleted: 1, openReviews: 0, sentBackByAdmin: 1,
        assignmentsPrepared: 2, liveSessionsHosted: 1, discussionComments: 1,
      });
      expect(row('mentor.j').averageReviewHours).toBeGreaterThanOrEqual(0);
      expect(row('mentor.j2')).toMatchObject({ reviewsAssigned: 1, reviewsCompleted: 0, openReviews: 1, averageReviewHours: null });
      expect(row('mentor.inv')).toMatchObject({ status: 'AWAITING_SETUP', reviewsAssigned: 0 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('earlier CSV exports', () => {
    const csv = async (path: string, query: Record<string, string> = {}) => {
      const res = await get(path, query).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      return res.text.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
    };

    it('results.csv: one row per submission, by assignment or by course and division', async () => {
      const byAssignment = await csv('/admin/reports/results.csv', { assignmentId: a1 });
      expect(byAssignment[0].slice(0, 8)).toEqual(['Course', 'Division', 'Assignment', 'Student', 'Username', 'Grade', 'School', 'Status']);
      expect(byAssignment).toHaveLength(3); // header + student.j + student.j2
      const j = byAssignment.find((r) => r[4] === 'student.j')!;
      expect(j[7]).toBe('PUBLISHED');
      expect(j[8]).toBe('16'); // score
      expect(j[10]).toBe('80'); // percentage
      expect(byAssignment.find((r) => r[4] === 'student.j2')![8]).toBe(''); // not published: no score

      const byScope = await csv('/admin/reports/results.csv', { courseId: ctx.ids.algebra, divisionId: ctx.ids.senior });
      expect(byScope.slice(1).map((r) => r[4])).toEqual(['student.s']);

      const missing = await get('/admin/reports/results.csv', { courseId: ctx.ids.algebra }).expect(400);
      expect(missing.body.code).toBe('FILTER_REQUIRED');
    });

    it('student-progress.csv: one row per student of a division with course status and results', async () => {
      const rows = await csv('/admin/reports/student-progress.csv', { divisionId: ctx.ids.junior });
      expect(rows[0].slice(0, 4)).toEqual(['Student', 'Username', 'Email', 'Grade']);
      const j = rows.find((r) => r[1] === 'student.j')!;
      const header = rows[0];
      expect(j[header.indexOf('Results published')]).toBe('1');
      expect(j[header.indexOf('Average %')]).toBe('80');
      expect(j[header.findIndex((h) => /^geometry status$/i.test(h))]).toBe('COMPLETED');
      expect(rows.find((r) => r[1] === 'student.x')![header.indexOf('Active')]).toBe('no');
      expect(rows.some((r) => r[1] === 'student.s')).toBe(false); // other division

      await get('/admin/reports/student-progress.csv').expect(400);
      await get('/admin/reports/student-progress.csv', { divisionId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    });

    it('mentor-workload.csv: one row per mentor with scopes, open and returned reviews', async () => {
      const rows = await csv('/admin/reports/mentor-workload.csv');
      expect(rows[0]).toEqual(['Mentor', 'Username', 'Email', 'Active', 'Teaching', 'Open reviews', 'Returned reviews', 'Average review hours']);
      const byUser = Object.fromEntries(rows.slice(1).map((r) => [r[1], r]));
      expect(byUser['mentor.j'][6]).toBe('1');  // returned (completed) reviews
      expect(byUser['mentor.j2'][5]).toBe('1'); // open review
      expect(Number(byUser['mentor.j'][7])).toBeGreaterThanOrEqual(0);
      expect(byUser['mentor.inv'][6]).toBe('0');
    });
  });

  describe('CSV downloads', () => {
    it.each([
      ['students', 'Student,Username,Email,Status', 5],
      ['mentors', 'Mentor,Username,Email,Status', 4],
      ['enrollment', 'Academic year,Division,School', 4], // Junior S1, S2, S3; Senior S5
      ['course-participation', 'Course,Division,Students', 8],
      ['assignments', 'Assignment,Course,Division', 2],
      ['reviews', 'Assignment,Course,Division,Student,Mentor', 2],
      ['results-publication', 'Assignment,Course,Division', 2],
      ['mentor-activity', 'Mentor,Username,Email,Status', 4],
    ])('%s.csv downloads with the filters applied, and is audited', async (name, header, rows) => {
      const res = await get(`/admin/reports/${name}.csv`).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="${name}-\\d{4}-\\d{2}-\\d{2}\\.csv"`));
      const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0].startsWith(header)).toBe(true);
      expect(lines).toHaveLength(rows + 1);

      const log = await ctx.prisma.auditLog.findFirst({ where: { action: 'EXPORT_REPORT' }, orderBy: { createdAt: 'desc' } });
      expect(log?.metadata).toMatchObject({ report: name });
    });

    it('CSV filters match the JSON report', async () => {
      const res = await get('/admin/reports/students.csv', { status: 'INACTIVE' }).expect(200);
      const lines = res.text.trim().split('\r\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('student.x');
      await get('/admin/reports/students.csv', { status: 'nope' }).expect(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  it('only administrators can see the dashboard and reports', async () => {
    const paths = [
      '/admin/dashboard', '/admin/reports/students', '/admin/reports/mentors', '/admin/reports/enrollment',
      '/admin/reports/course-participation', '/admin/reports/assignments', '/admin/reports/reviews',
      '/admin/reports/results-publication', '/admin/reports/mentor-activity', '/admin/reports/students.csv',
      '/admin/reports/mentor-activity.csv',
    ];
    for (const path of paths) {
      await get(path, {}, mentorJ).expect(403);
      await get(path, {}, studentJ).expect(403);
      await ctx.http().get(`/api/v1${path}`).expect(401);
    }
  });
});
