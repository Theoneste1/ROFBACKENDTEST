/**
 * Course analytics and the active-user count are aggregated in the database (PERF-05/06).
 * Real PostgreSQL, real HTTP. The figures must equal what the former in-memory computation gave:
 * it is re-implemented here as the reference and compared on awkward data (odd and even counts,
 * a missing percentage, bucket borders, unreturned reviews).
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const round = (n: number) => Math.round(n * 10) / 10;
const BUCKETS = [[0, 20], [20, 40], [40, 60], [60, 80], [80, 100.0001]];

/** The former computation (analytics.service.ts before PERF-05). */
function reference(results: Array<{ percentage: number | null; assignedAt: Date; returnedAt: Date | null }>) {
  const pct = results.map((r) => r.percentage ?? 0).sort((x, y) => x - y);
  const mid = Math.floor(pct.length / 2);
  const median = pct.length % 2 ? pct[mid] : (pct[mid - 1] + pct[mid]) / 2;
  const spans = results.filter((r) => r.returnedAt).map((r) => (r.returnedAt!.getTime() - r.assignedAt.getTime()) / 3_600_000);
  return {
    publishedResults:   pct.length,
    averagePercentage:  pct.length ? round(pct.reduce((s, v) => s + v, 0) / pct.length) : null,
    medianPercentage:   pct.length ? round(median) : null,
    highestPercentage:  pct.length ? pct[pct.length - 1] : null,
    lowestPercentage:   pct.length ? pct[0] : null,
    distribution:       ['0-19', '20-39', '40-59', '60-79', '80-100'].map((range, i) => ({ range, count: pct.filter((v) => v >= BUCKETS[i][0] && v < BUCKETS[i][1]).length })),
    averageReviewHours: spans.length ? round(spans.reduce((s, v) => s + v, 0) / spans.length) : null,
  };
}

describe('Course analytics and active users, aggregated in SQL', () => {
  let ctx: TestContext;
  let admin: string;
  const sets: Record<string, Array<{ percentage: number | null; hours: number | null }>> = {
    odd:   [{ percentage: 100, hours: 5 }, { percentage: 80, hours: 2.25 }, { percentage: 79.99, hours: null }, { percentage: 20, hours: 1 }, { percentage: null, hours: 3 }],
    even:  [{ percentage: 60, hours: 1.5 }, { percentage: 40, hours: 2 }, { percentage: 19.5, hours: 7 }, { percentage: 59.95, hours: 0.1 }],
    none:  [],
  };
  const expected: Record<string, ReturnType<typeof reference>> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    let n = 0;
    for (const [title, rows] of Object.entries(sets)) {
      const a = await ctx.prisma.assignment.create({
        data: {
          title, instructions: 'x', deadline: new Date(Date.now() - 86_400_000 * (3 - n)), points: 10, maximumMarks: 100,
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
          createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
        },
      });
      ids[title] = a.id;
      const results = [];
      for (const [i, r] of rows.entries()) {
        const u = await ctx.prisma.user.create({
          data: { username: `an${n}_${i}`, firstName: 'A', lastName: 'N', email: `an${n}_${i}@t.local`, role: 'STUDENT', gradeLevel: 'S1', divisionId: ctx.ids.junior, activatedAt: new Date() },
        });
        const s = await ctx.prisma.submission.create({ data: { assignmentId: a.id, studentId: u.id, status: 'PUBLISHED', publishedAt: new Date() } });
        const assignedAt = new Date(Date.UTC(2026, 10, 1, 8, 0, 0, 123 * i));
        const returnedAt = r.hours === null ? null : new Date(assignedAt.getTime() + r.hours * 3_600_000);
        const review = await ctx.prisma.mentorReview.create({
          data: { submissionId: s.id, cycle: 1, mentorId: ctx.ids.mentorJunior, status: 'PUBLISHED', percentage: r.percentage, score: 1, assignedAt, returnedAt },
        });
        await ctx.prisma.submission.update({ where: { id: s.id }, data: { publishedReviewId: review.id, currentReviewId: review.id } });
        results.push({ percentage: r.percentage, assignedAt, returnedAt });
      }
      expected[title] = reference(results);
      n++;
    }
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('per-assignment result statistics equal the former in-memory computation', async () => {
    const res = await ctx.http().get(`/api/v1/analytics/courses/${ctx.ids.algebra}`).query({ divisionId: ctx.ids.junior }).set(bearer(admin)).expect(200);
    for (const title of Object.keys(sets)) {
      const row = res.body.assignments.find((a: { id: string }) => a.id === ids[title]);
      expect(row, title).toMatchObject(expected[title]);
    }
    // Spot checks of the reference itself (so a shared mistake cannot hide).
    expect(expected.odd).toMatchObject({ medianPercentage: 80, lowestPercentage: 0, highestPercentage: 100 });
    expect(expected.even.medianPercentage).toBe(round((40 + 59.95) / 2));
    expect(expected.none).toMatchObject({ publishedResults: 0, averagePercentage: null, averageReviewHours: null });
  });

  it('the active-user count counts each user once, within the period', async () => {
    const people = await ctx.prisma.user.findMany({ where: { role: 'STUDENT' }, take: 3, orderBy: { username: 'asc' } });
    await ctx.prisma.activityLog.deleteMany({});
    const now = Date.now();
    await ctx.prisma.activityLog.createMany({
      data: [
        { userId: people[0].id, type: 'LOGIN', createdAt: new Date(now - 3_600_000) },
        { userId: people[0].id, type: 'COURSE_OPENED', createdAt: new Date(now - 7_200_000) },
        { userId: people[0].id, type: 'LOGIN', createdAt: new Date(now - 10_800_000) },
        { userId: people[1].id, type: 'LOGIN', createdAt: new Date(now - 3_600_000) },
        { userId: people[2].id, type: 'LOGIN', createdAt: new Date(now - 40 * 86_400_000) },   // outside the period
      ],
    });
    const from = new Date(now - 86_400_000).toISOString();
    const res = await ctx.http().get('/api/v1/admin/activity/summary').query({ from }).set(bearer(admin)).expect(200);
    expect(res.body.activeUsers).toBe(2);
    expect(res.body.byType).toMatchObject({ LOGIN: 3, COURSE_OPENED: 1 });
  });
});
