/**
 * Course analytics for a (course × division): what mentors need to see how
 * their students are doing. Admins can view any scope.
 *
 * All figures are computed on demand from live data. Volumes are small
 * (one course × one division), so this stays fast without materialised views.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';

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
  ) {}

  async courseAnalytics(courseId: string, divisionId: string, user: AuthUser) {
    const [course, division] = await Promise.all([
      this.prisma.course.findUnique({ where: { id: courseId }, select: { id: true, code: true, title: true } }),
      this.prisma.division.findUnique({ where: { id: divisionId }, select: { id: true, code: true, name: true } }),
    ]);
    if (!course)   throw new NotFoundException('Course not found.');
    if (!division) throw new NotFoundException('Division not found.');
    await this.access.assertCanManage(user, { courseId, divisionId });

    const studentWhere = { role: 'STUDENT' as const, divisionId, isActive: true, isApproved: true };
    const scope        = { courseId, divisionId };

    const [students, enrollment, assignments, published, pipeline, resources, sessions] = await Promise.all([
      this.prisma.user.count({ where: studentWhere }),
      this.prisma.courseEnrollment.groupBy({
        by: ['status'], where: { courseId, student: studentWhere }, _count: { _all: true },
      }),
      this.prisma.assignment.findMany({
        where:   { ...scope, status: 'PUBLISHED' },
        orderBy: { deadline: 'asc' },
        select:  {
          id: true, title: true, deadline: true, maximumMarks: true, resultsPublishedAt: true,
          _count: { select: { submissions: true } },
        },
      }),
      this.prisma.submission.findMany({
        where:  { assignment: scope, status: 'PUBLISHED' },
        select: { assignmentId: true, percentage: true, isLate: true, assignedAt: true, submittedToAdminAt: true },
      }),
      this.prisma.submission.groupBy({
        by: ['status'], where: { assignment: scope }, _count: { _all: true },
      }),
      this.prisma.courseResource.findMany({
        where:  { ...scope, isPublished: true },
        select: {
          id: true, title: true, type: true,
          _count: { select: { views: true } },
          views:  { select: { viewCount: true } },
        },
      }),
      this.prisma.liveSession.groupBy({
        by: ['status'], where: scope, _count: { _all: true },
      }),
    ]);

    const lateCounts = await this.prisma.submission.groupBy({
      by: ['assignmentId'], where: { assignment: scope, isLate: true }, _count: { _all: true },
    });
    const lateByAssignment = new Map(lateCounts.map((l) => [l.assignmentId, l._count._all]));

    const enrolled = Object.fromEntries(enrollment.map((e) => [e.status, e._count._all]));
    const opened   = (enrolled['ROLLED'] ?? 0) + (enrolled['COMPLETED'] ?? 0);

    return {
      course,
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
        const results = published.filter((p) => p.assignmentId === a.id);
        const pct     = results.map((r) => r.percentage ?? 0).sort((x, y) => x - y);
        return {
          id:                 a.id,
          title:              a.title,
          deadline:           a.deadline,
          resultsPublishedAt: a.resultsPublishedAt,
          submissions:        a._count.submissions,
          submissionRate:     rate(a._count.submissions, students),
          lateSubmissions:    lateByAssignment.get(a.id) ?? 0,
          publishedResults:   results.length,
          averagePercentage:  pct.length ? round(pct.reduce((s, v) => s + v, 0) / pct.length) : null,
          medianPercentage:   pct.length ? round(median(pct)) : null,
          highestPercentage:  pct.length ? pct[pct.length - 1] : null,
          lowestPercentage:   pct.length ? pct[0] : null,
          distribution:       BUCKETS.map((b) => ({ range: b.label, count: pct.filter((v) => v >= b.min && v < b.max).length })),
          averageReviewHours: avgHours(results),
        };
      }),
      reviewPipeline: Object.fromEntries(pipeline.map((p) => [p.status, p._count._all])),
      resources: {
        published: resources.length,
        uniqueViewers: resources.reduce((s, r) => s + r._count.views, 0),
        totalViews:    resources.reduce((s, r) => s + r.views.reduce((v, x) => v + x.viewCount, 0), 0),
        mostViewed: [...resources]
          .sort((a, b) => b._count.views - a._count.views)
          .slice(0, 5)
          .map((r) => ({ id: r.id, title: r.title, type: r.type, uniqueViewers: r._count.views })),
      },
      liveSessions: Object.fromEntries(sessions.map((s) => [s.status, s._count._all])),
    };
  }
}

function rate(part: number, whole: number) {
  return whole > 0 ? round((part / whole) * 100) : 0;
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}

function median(sorted: number[]) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Mean hours from distribution to the mentor returning the review. */
function avgHours(rows: Array<{ assignedAt: Date | null; submittedToAdminAt: Date | null }>) {
  const spans = rows
    .filter((r) => r.assignedAt && r.submittedToAdminAt)
    .map((r) => (r.submittedToAdminAt!.getTime() - r.assignedAt!.getTime()) / 3_600_000);
  return spans.length ? round(spans.reduce((s, v) => s + v, 0) / spans.length) : null;
}
