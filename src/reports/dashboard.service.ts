/**
 * Administrator dashboard: headline statistics computed live from the
 * database with aggregate queries (counts and group-bys; no rows are loaded).
 *
 * Filters (see ReportScopeService): academic year (default current), division,
 * course and a date range.
 *   - Snapshot figures (how many students, pending reviews, open reports,
 *     accounts awaiting setup) describe the present state within the scope.
 *   - Activity figures (published, submitted, completed, reported, new
 *     registrations) count what happened inside the date range when one is
 *     given, otherwise all time within the scope.
 *   - The course filter applies to course-scoped figures (students by course,
 *     assignments, submissions, reviews, results, reports, mentors).
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ReportScopeService, type ReportScope } from './report-scope.js';
import { UserReportsService } from './user-reports.service.js';
import type { ReportFiltersDto } from './dto/report-filters.dto.js';

const PUBLISHED_ASSIGNMENT = ['PUBLISHED', 'CLOSED', 'ARCHIVED'] as const;
const TOP_MENTORS = 5;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope:  ReportScopeService,
    private readonly users:  UserReportsService,
  ) {}

  async dashboard(q: ReportFiltersDto) {
    const s = await this.scope.resolve(q);
    const [students, mentors, assignments, submissions, reviews, results, reports, accounts] = await Promise.all([
      this.students(s),
      this.mentors(s),
      this.assignments(s),
      this.submissions(s),
      this.reviews(s),
      this.results(s),
      this.reportedContent(s),
      this.accountsAwaitingSetup(),
    ]);
    return {
      generatedAt: new Date(),
      filters:     this.scope.describe(s),
      students,
      mentors,
      assignments,
      submissions,
      reviews,
      results,
      reportedContent:       reports,
      accountsAwaitingSetup: accounts,
    };
  }

  // ─── Students ─────────────────────────────────────────────────────────────

  private async students(s: ReportScope) {
    const where = this.scope.studentWhere(s);
    const range = this.scope.range(s);
    const [total, active, inactive, awaitingSetup, registered, byDivision, byCourse] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, ...this.scope.userStatusWhere('ACTIVE') } }),
      this.prisma.user.count({ where: { ...where, ...this.scope.userStatusWhere('INACTIVE') } }),
      this.prisma.user.count({ where: { ...where, ...this.scope.userStatusWhere('AWAITING_SETUP') } }),
      range ? this.prisma.user.count({ where: { ...where, createdAt: range } }) : null,
      this.studentsByDivision(s),
      this.studentsByCourse(s, where),
    ]);
    return { total, active, inactive, awaitingSetup, registeredInRange: registered, byDivision, byCourse };
  }

  /** Active students per division (activated, not suspended). */
  private async studentsByDivision(s: ReportScope) {
    const [divisions, counts] = await Promise.all([
      this.prisma.division.findMany({
        where:   s.divisionId ? { id: s.divisionId } : {},
        orderBy: { code: 'asc' },
        select:  { id: true, code: true, name: true },
      }),
      this.users.studentsPerDivision(s),
    ]);
    return divisions.map((d) => ({ ...d, students: counts.get(d.id) ?? 0 }));
  }

  /** Students in scope who opened / completed each course. */
  private async studentsByCourse(s: ReportScope, studentWhere: Prisma.UserWhereInput) {
    const [courses, rows] = await Promise.all([
      this.prisma.course.findMany({
        where:   s.courseId ? { id: s.courseId } : {},
        orderBy: { sortOrder: 'asc' },
        select:  { id: true, code: true, title: true },
      }),
      this.prisma.courseEnrollment.groupBy({
        by:     ['courseId', 'status'],
        where:  { status: { in: ['ROLLED', 'COMPLETED'] }, student: studentWhere, ...(s.courseId && { courseId: s.courseId }) },
        _count: { _all: true },
      }),
    ]);
    return courses.map((c) => {
      const of = (status: string) => rows.find((r) => r.courseId === c.id && r.status === status)?._count._all ?? 0;
      return { ...c, participating: of('ROLLED') + of('COMPLETED'), completed: of('COMPLETED') };
    });
  }

  // ─── Mentors ──────────────────────────────────────────────────────────────

  private async mentors(s: ReportScope) {
    const where = this.scope.mentorWhere(s);
    const range = this.scope.range(s);
    const reviewScope: Prisma.MentorReviewWhereInput = { submission: { assignment: this.scope.assignmentWhere(s) } };
    const completedWhere: Prisma.MentorReviewWhereInput = { ...reviewScope, returnedAt: range ?? { not: null } };

    const [total, active, inactive, awaitingSetup, withCompletedReviews, top] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...where, ...this.scope.userStatusWhere('ACTIVE') } }),
      this.prisma.user.count({ where: { ...where, ...this.scope.userStatusWhere('INACTIVE') } }),
      this.prisma.user.count({ where: { ...where, ...this.scope.userStatusWhere('AWAITING_SETUP') } }),
      this.prisma.user.count({ where: { ...where, reviews: { some: completedWhere } } }),
      this.prisma.mentorReview.groupBy({
        by:      ['mentorId'],
        where:   { ...completedWhere, mentor: where },
        _count:  { _all: true },
        orderBy: { _count: { mentorId: 'desc' } },
        take:    TOP_MENTORS,
      }),
    ]);

    const [people, open] = await Promise.all([
      this.prisma.user.findMany({
        where:  { id: { in: top.map((t) => t.mentorId) } },
        select: { id: true, firstName: true, lastName: true, username: true, lastLoginAt: true },
      }),
      this.prisma.mentorReview.groupBy({
        by:     ['mentorId'],
        where:  { ...reviewScope, mentorId: { in: top.map((t) => t.mentorId) }, status: { in: OPEN_REVIEW_STATUSES } },
        _count: { _all: true },
      }),
    ]);

    return {
      total, active, inactive, awaitingSetup,
      activity: {
        /** Mentors who completed at least one review (in the date range, if given). */
        mentorsWithCompletedReviews: withCompletedReviews,
        mostReviewsCompleted: top.map((t) => ({
          mentor:           people.find((p) => p.id === t.mentorId) ?? null,
          reviewsCompleted: t._count._all,
          openReviews:      open.find((o) => o.mentorId === t.mentorId)?._count._all ?? 0,
        })),
      },
    };
  }

  // ─── Assessment ───────────────────────────────────────────────────────────

  private async assignments(s: ReportScope) {
    const where = this.scope.assignmentWhere(s);
    const range = this.scope.range(s);
    const [published, byStatus] = await Promise.all([
      this.prisma.assignment.count({
        where: { ...where, status: { in: [...PUBLISHED_ASSIGNMENT] }, publishedAt: range ?? { not: null } },
      }),
      this.prisma.assignment.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return { published, byStatus: toCounts(byStatus, (r) => r.status) };
  }

  private async submissions(s: ReportScope) {
    const where: Prisma.SubmissionWhereInput = {
      assignment: this.scope.assignmentWhere(s),
      ...(this.scope.range(s) && { submittedAt: this.scope.range(s) }),
    };
    const [total, late, byStatus] = await Promise.all([
      this.prisma.submission.count({ where }),
      this.prisma.submission.count({ where: { ...where, isLate: true } }),
      this.prisma.submission.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return { total, late, byStatus: toCounts(byStatus, (r) => r.status) };
  }

  private async reviews(s: ReportScope) {
    const assignment = this.scope.assignmentWhere(s);
    const range = this.scope.range(s);
    const [pendingByStatus, awaitingDistribution, awaitingApproval, completed] = await Promise.all([
      this.prisma.mentorReview.groupBy({
        by:     ['status'],
        where:  { status: { in: OPEN_REVIEW_STATUSES }, submission: { assignment } },
        _count: { _all: true },
      }),
      this.prisma.submission.count({ where: { status: 'SUBMITTED', assignment } }),
      this.prisma.mentorReview.count({ where: { status: 'RETURNED', submission: { assignment } } }),
      this.prisma.mentorReview.count({ where: { returnedAt: range ?? { not: null }, submission: { assignment } } }),
    ]);
    return {
      /** Assigned to a mentor and not yet finished (snapshot). */
      pendingMentorReview: pendingByStatus.reduce((n, r) => n + r._count._all, 0),
      pendingByStatus:     toCounts(pendingByStatus, (r) => r.status),
      awaitingDistribution,
      awaitingAdminApproval: awaitingApproval,
      /** Reviews mentors finished (in the date range, if given). */
      completed,
    };
  }

  private async results(s: ReportScope) {
    const assignment = this.scope.assignmentWhere(s);
    const range = this.scope.range(s);
    const [published, awaitingPublication] = await Promise.all([
      this.prisma.submission.count({ where: { assignment, status: 'PUBLISHED', publishedAt: range ?? { not: null } } }),
      this.prisma.submission.count({ where: { assignment, status: 'APPROVED' } }),
    ]);
    return { published, awaitingPublication };
  }

  // ─── Moderation and accounts ──────────────────────────────────────────────

  private async reportedContent(s: ReportScope) {
    const thread = this.scope.threadWhere(s);
    const scoped: Prisma.ContentReportWhereInput = Object.keys(thread).length
      ? { OR: [{ thread }, { comment: { thread } }] }
      : {};
    const range = this.scope.range(s);
    const [open, byStatus, byReason] = await Promise.all([
      this.prisma.contentReport.count({ where: { ...scoped, status: 'OPEN' } }),
      this.prisma.contentReport.groupBy({ by: ['status'], where: { ...scoped, ...(range && { createdAt: range }) }, _count: { _all: true } }),
      this.prisma.contentReport.groupBy({ by: ['reason'], where: { ...scoped, ...(range && { createdAt: range }) }, _count: { _all: true } }),
    ]);
    return {
      /** Waiting for an administrator (snapshot). */
      open,
      /** Reports filed (in the date range, if given). */
      total:    byStatus.reduce((n, r) => n + r._count._all, 0),
      byStatus: toCounts(byStatus, (r) => r.status),
      byReason: toCounts(byReason, (r) => r.reason),
    };
  }

  /** Accounts that cannot be used yet. Not scoped: setup is account-wide. */
  private async accountsAwaitingSetup() {
    const [byRole, studentsAwaitingApproval, mentorApplications] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: this.scope.userStatusWhere('AWAITING_SETUP'), _count: { _all: true } }),
      this.prisma.user.count({ where: { role: 'STUDENT', isActive: true, isApproved: false } }),
      this.prisma.mentorRequest.count({ where: { status: 'PENDING' } }),
    ]);
    return {
      /** Invited or created, never activated. */
      total:  byRole.reduce((n, r) => n + r._count._all, 0),
      byRole: toCounts(byRole, (r) => r.role),
      studentsAwaitingApproval,
      mentorApplications,
    };
  }
}

/** Group-by rows → `{ KEY: count }`. */
export function toCounts<T extends { _count: { _all: number } }>(rows: T[], key: (r: T) => string | null): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [key(r) ?? 'NONE', r._count._all]));
}
