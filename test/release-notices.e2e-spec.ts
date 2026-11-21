/**
 * Release decisions Q-14 and Q-18:
 *  - a student is told when a published result is withdrawn for correction (once per withdrawal);
 *  - administrators are told about new student registrations and coach applications, in-app,
 *    exactly once per event even when the event is delivered more than once.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';

import { createTestApp, login, bearer, inDays, PDF, type TestContext, waitForEvents } from './helpers.js';
import { Events } from '../src/notifications/events.js';

describe('Release notices (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, studentJ: string;

  const count = (where: object) => ctx.prisma.notification.count({ where });

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, studentJ] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('a withdrawn result → the student, once, without the note addressed to the coach', async () => {
    const draft = await ctx.http().post('/api/v1/assignments').set(bearer(mentorJ))
      .field('title', 'Withdrawal check').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
      .field('instructions', 'Solve the equation.').field('deadline', inDays(2)).field('points', '10').field('maximumMarks', '10').field('allowResubmission', 'false')
      .expect(201);
    const assignmentId = draft.body.id;
    await ctx.http().patch(`/api/v1/assignments/${assignmentId}/submit`).set(bearer(mentorJ)).expect(200);
    await ctx.http().patch(`/api/v1/assignments/${assignmentId}/publish`).set(bearer(admin)).expect(200);
    const sub = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', assignmentId).field('answerText', 'x = 2').attach('files', PDF, 'work.pdf').expect(201);
    const id = sub.body.id;
    await ctx.http().patch(`/api/v1/submissions/${id}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${id}/start-review`).set(bearer(mentorJ)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${id}/mark`).set(bearer(mentorJ)).field('score', '8').field('mentorFeedback', 'Good.').expect(200);
    await ctx.http().patch(`/api/v1/submissions/${id}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${id}/approve`).set(bearer(admin)).send({}).expect(200);
    await ctx.http().patch(`/api/v1/submissions/${id}/publish`).set(bearer(admin)).expect(200);
    const reviewId = (await ctx.prisma.submission.findUniqueOrThrow({ where: { id }, select: { publishedReviewId: true } })).publishedReviewId!;

    await ctx.http().patch(`/api/v1/submissions/${id}/reopen`).set(bearer(admin))
      .send({ reopenNote: 'Internal: marking scheme changed.' }).expect(200);
    await waitForEvents();

    const where = { userId: ctx.ids.studentJunior, type: 'result.reopened', data: { path: ['submissionId'], equals: id } };
    const n = await ctx.prisma.notification.findFirstOrThrow({ where });
    expect(n).toMatchObject({ category: 'RESULTS', title: 'Your result was withdrawn for correction', link: `/assignments/${assignmentId}` });
    expect(n.body).not.toContain('marking scheme');
    // The coach is still told (unchanged behaviour), under the review type.
    expect(await count({ userId: ctx.ids.mentorJunior, type: 'review.rejected', data: { path: ['submissionId'], equals: id } })).toBeGreaterThan(0);

    // The same withdrawal delivered again does not notify twice.
    ctx.app.get(EventEmitter2).emit(Events.ResultReopened, { submissionId: id, previousReviewId: reviewId });
    await waitForEvents();
    expect(await count(where)).toBe(1);
  });

  it('a new student registration → every active administrator, in-app only, once', async () => {
    const before = await ctx.prisma.emailDelivery.count();
    const res = await ctx.http().post('/api/v1/auth/register/student').send({
      firstName: 'Nadia', lastName: 'Keza', username: 'nadia.keza', email: 'nadia.keza@example.com',
      password: 'Secret123', dateOfBirth: '2010-05-01', gender: 'FEMALE', homeCountry: 'UG', guardianPhone: '0722000111', gradeLevel: 'S2', schoolName: 'Lycée de Kigali', schoolLocation: 'kigali', homeLocation: 'kigali',
    }).expect(201);
    await waitForEvents();

    const where = { type: 'registration.student', data: { path: ['userId'], equals: res.body.id } };
    const rows = await ctx.prisma.notification.findMany({ where, select: { userId: true, title: true, link: true, category: true } });
    const admins = (await ctx.prisma.user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true }, select: { id: true } })).map((a) => a.id);
    expect(rows.map((r) => r.userId).sort()).toEqual(admins.sort());
    expect(rows[0]).toMatchObject({ category: 'ACCOUNT', link: `/admin/users/${res.body.id}` });
    expect(rows[0].title).toMatch(/^New student/);
    // Only the student's own account e-mail is queued; administrators get no e-mail for it.
    const mails = await ctx.prisma.emailDelivery.findMany({ skip: before, orderBy: { createdAt: 'asc' }, select: { recipientEmail: true } });
    expect(mails.map((m) => m.recipientEmail)).toEqual(['nadia.keza@example.com']);

    // Replays (a retried or duplicated event, concurrently) create nothing more.
    const emitter = ctx.app.get(EventEmitter2);
    await Promise.all([1, 2, 3].map(() => emitter.emitAsync(Events.StudentRegistered, { userId: res.body.id, requiresApproval: false })));
    await waitForEvents();
    expect(await count(where)).toBe(admins.length);
  });

  it('a coach application → administrators once per submission; a re-application is a new notice', async () => {
    const apply = await ctx.http().post('/api/v1/mentor-requests')
      .send({ firstName: 'Eric', lastName: 'Mugisha', username: 'eric.m', email: 'eric.m@example.com', password: 'Mentor123', gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'] })
      .expect(201);
    await waitForEvents();
    const where = { userId: ctx.ids.admin, type: 'registration.mentor_request', data: { path: ['mentorRequestId'], equals: apply.body.id } };
    expect(await count(where)).toBe(1);
    const n = await ctx.prisma.notification.findFirstOrThrow({ where });
    expect(n).toMatchObject({ category: 'ACCOUNT', title: 'New coach application', link: '/admin/mentors' });

    const emitter = ctx.app.get(EventEmitter2);
    const again = { requestId: apply.body.id, submittedAt: new Date(apply.body.updatedAt).toISOString(), reapplication: false };
    await Promise.all([emitter.emitAsync(Events.MentorRequestSubmitted, again), emitter.emitAsync(Events.MentorRequestSubmitted, again)]);
    await waitForEvents();
    expect(await count(where)).toBe(1);

    await ctx.http().patch(`/api/v1/mentor-requests/${apply.body.id}/reject`).set(bearer(admin)).expect(200);
    const again2 = await ctx.http().post('/api/v1/mentor-requests')
      .send({ firstName: 'Eric', lastName: 'Mugisha', username: 'eric.m', email: 'eric.m@example.com', password: 'Mentor123', gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'] })
      .expect(201);
    await waitForEvents();
    // The re-application is its own application (one row per attempt): one new notice, for the new request.
    expect(again2.body.id).not.toBe(apply.body.id);
    expect(await count(where)).toBe(1);
    expect(await count({ ...where, data: { path: ['mentorRequestId'], equals: again2.body.id } })).toBe(1);
  });

  it('administrators can switch the registration notices off', async () => {
    await ctx.http().patch('/api/v1/me/notification-settings').set(bearer(admin))
      .send({ settings: [{ type: 'registration.student', inAppEnabled: false }] }).expect(200);
    const res = await ctx.http().post('/api/v1/auth/register/student').send({
      firstName: 'Paul', lastName: 'Habimana', username: 'paul.h', email: 'paul.h@example.com',
      password: 'Secret123', dateOfBirth: '2010-05-01', gender: 'FEMALE', homeCountry: 'UG', guardianPhone: '0722000111', gradeLevel: 'S5', schoolName: 'Lycée de Kigali', schoolLocation: 'kigali', homeLocation: 'kigali',
    }).expect(201);
    await waitForEvents();
    expect(await count({ userId: ctx.ids.admin, type: 'registration.student', data: { path: ['userId'], equals: res.body.id } })).toBe(0);
  });
});
