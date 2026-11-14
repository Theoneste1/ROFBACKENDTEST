/**
 * Distribution and publication of many results at once (PERF-02/03: set-based statements).
 * Real PostgreSQL, real HTTP. Pins, for every row of a bulk run, what the former per-row loops
 * guaranteed: a new review cycle per submission (cycle = previous + 1) with its batch and ASSIGNED
 * event; only still-APPROVED results published, each with its review moved to PUBLISHED and a
 * PUBLISHED event; the release count; the points cache; the audit entries.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const STUDENTS = 24;

describe('Bulk distribution and publication', () => {
  let ctx: TestContext;
  let admin: string;
  let assignmentId: string;
  let students: string[] = [];
  let subs: string[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    const a = await ctx.prisma.assignment.create({
      data: {
        title: 'Bulk', instructions: 'Solve.', deadline: new Date(Date.now() - 86_400_000), points: 40, maximumMarks: 20,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
    assignmentId = a.id;
    for (let i = 0; i < STUDENTS; i++) {
      const u = await ctx.prisma.user.create({
        data: {
          username: `bulk${i}`, firstName: `Bulk${i}`, lastName: 'Test', email: `bulk${i}@test.local`, role: 'STUDENT',
          activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior,
        },
      });
      students.push(u.id);
      const s = await ctx.prisma.submission.create({
        data: { assignmentId, studentId: u.id, status: 'SUBMITTED', submittedAt: new Date(Date.now() - (STUDENTS - i) * 60_000), revisionCount: 1 },
      });
      subs.push(s.id);
    }
    // One submission already had a (cancelled) review cycle: its next one is cycle 2.
    await ctx.prisma.mentorReview.create({ data: { submissionId: subs[0], cycle: 1, mentorId: ctx.ids.mentorJunior, status: 'CANCELLED' } });
    // An earlier published result of student 1 elsewhere: their total must include it.
    const other = await ctx.prisma.assignment.create({
      data: {
        title: 'Earlier', instructions: 'x', deadline: new Date(), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED',
      },
    });
    await ctx.prisma.submission.create({
      data: { assignmentId: other.id, studentId: students[1], status: 'PUBLISHED', pointsAwarded: 7, publishedAt: new Date() },
    });
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('distributes every submission round-robin in submission order, one cycle + event each', async () => {
    const res = await ctx.http().post(`/api/v1/assignments/${assignmentId}/distribute`).set(bearer(admin))
      .send({ strategy: 'ROUND_ROBIN' }).expect(200);
    expect(res.body).toMatchObject({ strategy: 'ROUND_ROBIN', distributed: STUDENTS });
    expect(Object.values(res.body.byMentor)).toEqual([STUDENTS / 2, STUDENTS / 2]);

    const rows = await ctx.prisma.submission.findMany({
      where: { assignmentId }, orderBy: { submittedAt: 'asc' },
      include: { currentReview: { include: { events: true } } },
    });
    const mentors = [ctx.ids.mentorJunior, ctx.ids.mentorJunior2];
    rows.forEach((s, i) => {
      expect(s.status).toBe('ASSIGNED');
      expect(s.currentReview).toMatchObject({
        status: 'ASSIGNED', mentorId: mentors[i % 2], distributionBatchId: res.body.batchId, assignedById: ctx.ids.admin,
        cycle: s.id === subs[0] ? 2 : 1,
      });
      expect(s.currentReview!.events.map((e) => [e.type, e.actorId])).toEqual([['ASSIGNED', ctx.ids.admin]]);
    });
    const batch = await ctx.prisma.distributionBatch.findUniqueOrThrow({ where: { id: res.body.batchId } });
    expect(batch.assignedCount).toBe(STUDENTS);

    // Nothing left: a second run distributes nothing.
    const again = await ctx.http().post(`/api/v1/assignments/${assignmentId}/distribute`).set(bearer(admin)).send({}).expect(200);
    expect(again.body.distributed).toBe(0);
  });

  it('publishes only the APPROVED results, moves their reviews, awards points and records the release', async () => {
    // Coaches marked everything; the administrator approved all but the last two.
    const rows = await ctx.prisma.submission.findMany({ where: { assignmentId }, select: { id: true, currentReviewId: true, studentId: true } });
    for (const [i, s] of rows.entries()) {
      const approved = i < rows.length - 2;
      await ctx.prisma.mentorReview.update({ where: { id: s.currentReviewId! }, data: { status: approved ? 'APPROVED' : 'RETURNED', score: i % 21, percentage: ((i % 21) / 20) * 100 } });
      await ctx.prisma.submission.update({ where: { id: s.id }, data: { status: approved ? 'APPROVED' : 'SUBMITTED_TO_ADMIN' } });
    }

    const res = await ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(admin)).send({}).expect(200);
    expect(res.body).toMatchObject({ published: STUDENTS - 2, notYetPublished: { SUBMITTED_TO_ADMIN: 2 } });

    const release = await ctx.prisma.resultRelease.findUniqueOrThrow({ where: { id: res.body.releaseId } });
    expect(release.resultCount).toBe(STUDENTS - 2);

    for (const [i, s] of rows.entries()) {
      const after = await ctx.prisma.submission.findUniqueOrThrow({ where: { id: s.id }, include: { publishedReview: { include: { events: true } } } });
      if (i >= rows.length - 2) {
        expect(after).toMatchObject({ status: 'SUBMITTED_TO_ADMIN', publishedReviewId: null, pointsAwarded: 0 });
        continue;
      }
      expect(after).toMatchObject({
        status: 'PUBLISHED', publishedReviewId: s.currentReviewId, resultReleaseId: release.id,
        pointsAwarded: Math.round((40 * (i % 21)) / 20),
      });
      expect(after.publishedAt).toEqual(after.publishedReview!.publishedAt);
      expect(after.publishedReview!.status).toBe('PUBLISHED');
      expect(after.publishedReview!.events.map((e) => e.type).sort()).toEqual(['ASSIGNED', 'PUBLISHED']);
      // The points cache: this result (+ 7 earlier points for student 1).
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: s.studentId } });
      const extra = s.studentId === students[1] ? 7 : 0;
      expect(user).toMatchObject({ points: after.pointsAwarded + extra, problemsSolved: extra ? 2 : 1 });
    }

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'PUBLISH_RESULTS', entityId: release.id } });
    expect((audit.metadata as { submissionIds: string[] }).submissionIds).toHaveLength(STUDENTS - 2);
  });

  it('a release whose result lost its APPROVED review is refused as a whole (nothing published)', async () => {
    const [s] = await ctx.prisma.submission.findMany({ where: { assignmentId, status: 'SUBMITTED_TO_ADMIN' }, take: 1 });
    await ctx.prisma.submission.update({ where: { id: s.id }, data: { status: 'APPROVED' } });   // review still RETURNED
    const res = await ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(admin)).send({}).expect(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await ctx.prisma.submission.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('APPROVED');
    expect(await ctx.prisma.resultRelease.count({ where: { assignmentId } })).toBe(1);
  });

  it('results.csv lists every row once, in the same order as before (deadline, last name, id) across batches', async () => {
    // A few last names that sort differently from the ids.
    for (const [i, id] of students.entries()) {
      await ctx.prisma.user.update({ where: { id }, data: { lastName: ['Uwase', 'Habimana', 'Mugisha'][i % 3] } });
    }
    const expected = await ctx.prisma.submission.findMany({
      where: { assignment: { courseId: ctx.ids.algebra, divisionId: ctx.ids.junior } },
      orderBy: [{ assignment: { deadline: 'asc' } }, { student: { lastName: 'asc' } }, { id: 'asc' }],
      select: { student: { select: { username: true } }, assignment: { select: { title: true } } },
    });
    const res = await ctx.http().get('/api/v1/admin/reports/results.csv').query({ courseId: ctx.ids.algebra, divisionId: ctx.ids.junior })
      .set(bearer(admin)).expect(200);
    const rows = res.text.replace(/^﻿/, '').trim().split('\r\n').slice(1).map((l) => l.split(','));
    expect(rows.map((r) => `${r[2]}/${r[4]}`)).toEqual(expected.map((e) => `${e.assignment.title}/${e.student.username}`));
    expect(rows.length).toBeGreaterThan(STUDENTS);   // crosses many 2-row batches (REPORT_CSV_BATCH_SIZE=2)
  });
});
