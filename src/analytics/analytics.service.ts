/**
 * Course analytics for a (course × division): what mentors need to see how
 * their students are doing. Admins can view any scope.
 *
 * All figures are computed on demand from live data. Per-assignment result
 * statistics and resource views are aggregated in SQL (PERF-05): at 100,000
 * students one course × division holds hundreds of thousands of published
 * results, which were all loaded into memory before.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access/access.service.js';
import { PermissionService } from '../auth/permission.service.js';
import type { AuthUser } from '../common/auth-user.js';

/** Per-assignment statistics of the published results (percentage NULL counts as 0, as before). */
interface ResultStats {
  assignmentId: string;
  n:            number;
  avg:          number | null;
  median:       number | null;
  max:          number | null;
  min:          number | null;
  buckets:      number[];
  avgHours:     number | null;
}

const BUCKETS = [
  { label: '0-19',   min: 0,  max: 20 },
  { label: '20-39',  min: 20, max: 40 },
  { label: '40-59',  min: 40, max: 60 },
  { label: '60-79',  min: 60, max: 80 },
  { label: '80-100', min: 80, max: 100.0001 },
];

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * Who may see this course × division: a holder of `analytics.course` at GLOBAL
   * scope (ADMIN, SUPER_ADMIN — plan §5); at PROGRAMME scope (Head Coach, P1-10)
   * only for a course of a programme they head — otherwise 404; or the coach
   * assigned to it. Returns whether the caller is programme-scoped.
   */
  private async assertCanManageScope(user: AuthUser, scope: { courseId: string; divisionId: string }, disciplineId: string): Promise<boolean> {
    const grant = this.permissions.scopeOf(user, 'analytics.course');
    if (grant === 'global') return false;
    if (grant === 'programme') {
      if (!(await this.access.headedProgrammes(user)).includes(disciplineId)) throw new NotFoundException('Course not found.');
      return true;
    }
    await this.access.assertCanManage(user, scope);
    return false;
  }

  async courseAnalytics(courseId: string, divisionId: string, user: AuthUser) {
    const [course, division] = await Promise.all([
      this.prisma.course.findUnique({ where: { id: courseId }, select: { id: true, code: true, title: true, disciplineId: true } }),
      this.prisma.division.findUnique({ where: { id: divisionId }, select: { id: true, code: true, name: true } }),
    ]);
    if (!course)   throw new NotFoundException('Course not found.');
    if (!division) throw new NotFoundException('Division not found.');
    const programmeScoped = await this.assertCanManageScope(user, { courseId, divisionId }, course.disciplineId);
    const { disciplineId, ...courseView } = course;
    // Head Coach: the programme's member students only, and no score aggregates (D7).
    const studentWhere = {
      role: 'STUDENT' as const, divisionId, isActive: true, isApproved: true,
      ...(programmeScoped && { programmeMemberships: { some: { disciplineId, isActive: true } } }),
    };
    const scope        = { courseId, divisionId };

    const [students, enrollment, assignments, stats, pipeline, resources, views] = await Promise.all([
      this.prisma.user.count({ where: studentWhere }),
      this.prisma.courseEnrollment.groupBy({
        by: ['status'], where: { courseId, student: studentWhere }, _count: { _all: true },
      }),
      this.prisma.assignment.findMany({
        where:   { ...scope, status: { in: ['PUBLISHED', 'CLOSED'] } },
        orderBy: { deadline: 'asc' },
        select:  {
          id: true, title: true, deadline: true, maximumMarks: true, resultsPublishedAt: true,
          _count: { select: { submissions: true } },
        },
      }),
      this.resultStats(courseId, divisionId),
      this.prisma.submission.groupBy({
        by: ['status'], where: { assignment: scope }, _count: { _all: true },
      }),
      this.prisma.courseResource.findMany({
        where:  { ...scope, isPublished: true },
        select: {
          id: true, title: true, type: true,
          _count: { select: { views: true } },
        },
      }),
      this.prisma.resourceView.aggregate({
        where: { resource: { ...scope, isPublished: true } },
        _sum:  { viewCount: true },
      }),
    ]);
    const statsOf = new Map(stats.map((r) => [r.assignmentId, r]));

    const lateCounts = await this.prisma.submission.groupBy({
      by: ['assignmentId'], where: { assignment: scope, isLate: true }, _count: { _all: true },
    });
    const lateByAssignment = new Map(lateCounts.map((l) => [l.assignmentId, l._count._all]));

    const enrolled = Object.fromEntries(enrollment.map((e) => [e.status, e._count._all]));
    const opened   = (enrolled['ROLLED'] ?? 0) + (enrolled['COMPLETED'] ?? 0);

    return {
      course: courseView,
      division,
      generatedAt: new Date(),
      students: {
        total:     students,
        unrolled:  Math.max(students - opened, 0),
        rolled:    enrolled['ROLLED'] ?? 0,
        completed: enrolled['COMPLETED'] ?? 0,
        completionRate: rate(enrolled['COMPLETED'] ?? 0, students),
      },
      assignments: assignments.map((a) => {
        const r = statsOf.get(a.id);
        const n = r?.n ?? 0;
        const scores = !programmeScoped && n > 0;
        return {
          id:                 a.id,
          title:              a.title,
          deadline:           a.deadline,
          resultsPublishedAt: a.resultsPublishedAt,
          submissions:        a._count.submissions,
          submissionRate:     rate(a._count.submissions, students),
          lateSubmissions:    lateByAssignment.get(a.id) ?? 0,
          publishedResults:   n,
          averagePercentage:  scores ? round(r!.avg!) : null,
          medianPercentage:   scores ? round(r!.median!) : null,
          highestPercentage:  scores ? r!.max : null,
          lowestPercentage:   scores ? r!.min : null,
          distribution:       programmeScoped ? [] : BUCKETS.map((b, i) => ({ range: b.label, count: r?.buckets[i] ?? 0 })),
          averageReviewHours: r?.avgHours == null ? null : round(r.avgHours),
        };
      }),
      reviewPipeline: Object.fromEntries(pipeline.map((p) => [p.status, p._count._all])),
      resources: {
        published: resources.length,
        uniqueViewers: resources.reduce((s, r) => s + r._count.views, 0),
        totalViews:    views._sum.viewCount ?? 0,
        mostViewed: [...resources]
          .sort((a, b) => b._count.views - a._count.views)
          .slice(0, 5)
          .map((r) => ({ id: r.id, title: r.title, type: r.type, uniqueViewers: r._count.views })),
      },
    };
  }

  /**
   * One row per assignment of the scope with published results: count, mean, median, highest and
   * lowest percentage, bucket counts and the mean review time (distribution → returned, hours).
   * The same figures the former in-memory computation produced (median = mean of the two middle
   * values for an even count; a missing percentage or review counts as 0%).
   */
  private resultStats(courseId: string, divisionId: string) {
    const buckets = BUCKETS.map((b) => Prisma.sql`(count(*) FILTER (WHERE p >= ${b.min}::float8 AND p < ${b.max}::float8))::int`);
    return this.prisma.$queryRaw<ResultStats[]>`
      SELECT x."assignmentId",
             count(*)::int                                           AS "n",
             avg(x.p)::float8                                        AS "avg",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY x.p)::float8 AS "median",
             max(x.p)::float8                                        AS "max",
             min(x.p)::float8                                        AS "min",
             ARRAY[${Prisma.join(buckets)}]                          AS "buckets",
             (avg(EXTRACT(EPOCH FROM (x."returnedAt" - x."assignedAt"))) FILTER (WHERE x."returnedAt" IS NOT NULL) / 3600)::float8 AS "avgHours"
        FROM (
          SELECT s."assignmentId", COALESCE(r."percentage", 0)::float8 AS p, r."assignedAt", r."returnedAt"
            FROM "Submission" AS s
            JOIN "Assignment" AS a ON a."id" = s."assignmentId"
            LEFT JOIN "MentorReview" AS r ON r."id" = s."publishedReviewId"
           WHERE a."courseId" = ${courseId} AND a."divisionId" = ${divisionId} AND s."status" = 'PUBLISHED'
        ) AS x
       GROUP BY x."assignmentId"`;
  }
}

function rate(part: number, whole: number) {
  return whole > 0 ? round((part / whole) * 100) : 0;
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}
