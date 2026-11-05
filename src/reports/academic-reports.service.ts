/**
 * Academic reports for administrators: assignment submission statistics,
 * pending and completed reviews, results publication and mentor activity.
 *
 * Summaries are computed over everything matching the filters with aggregate
 * queries; per-row statistics are computed for the current page only (one
 * grouped query per figure, never one query per row). Averages and medians
 * are computed in SQL.
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';
import { Prisma, type SubmissionStatus } from '../generated/prisma/client.js';
import { ReportScopeService, type ReportScope } from './report-scope.js';
import { toCounts } from './dashboard.service.js';
import { accountStatus, MAX_ROWS, searchWhere } from './user-reports.service.js';
import type { AssignmentReportDto, ReportFiltersDto, ReportListDto, UserReportDto } from './dto/report-filters.dto.js';
import { toCsv } from './csv.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERSON = { id: true, firstName: true, lastName: true, username: true } as const;

/** Submission statuses grouped the way the reports present them. */
const STAGES: Record<string, SubmissionStatus[]> = {
  awaitingDistribution:  ['SUBMITTED'],
  inReview:              ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED'],
  resubmissionRequested: ['RESUBMISSION_REQUESTED'],
  awaitingApproval:      ['SUBMITTED_TO_ADMIN'],
  approved:              ['APPROVED'],
  published:             ['PUBLISHED'],
};

const ASSIGNMENT_SELECT = {
  id: true, title: true, status: true, deadline: true, publishedAt: true, maximumMarks: true,
  academicYearId: true, divisionId: true,
  course:       { select: { id: true, code: true, title: true } },
  division:     { select: { id: true, code: true, name: true } },
  academicYear: { select: { id: true, name: true } },
} as const satisfies Prisma.AssignmentSelect;

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const round1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

@Injectable()
export class AcademicReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope:  ReportScopeService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Assignment submission statistics
  // ═══════════════════════════════════════════════════════════════════════════

  /** Per assignment: expected students, submitted, late, missing and where the work is. Date range = deadline between. */
  async assignments(q: AssignmentReportDto) {
    const s = await this.scope.resolve(q);
    const { page, limit, skip, take } = pageArgs(q);
    const where = this.assignmentListWhere(s, q);
    const [rows, total, byStatus, late] = await this.prisma.$transaction([
      this.prisma.assignment.findMany({ where, skip, take, orderBy: [{ deadline: 'desc' }, { id: 'asc' }], select: ASSIGNMENT_SELECT }),
      this.prisma.assignment.count({ where }),
      this.prisma.submission.groupBy({ by: ['status'], where: { assignment: where }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.submission.count({ where: { assignment: where, isLate: true } }),
    ]);
    const submissions = byStatus.reduce((n, r) => n + (r._count as { _all: number })._all, 0);
    return {
      filters: { ...this.scope.describe(s), status: q.status ?? null },
      summary: {
        assignments: total,
        submissions,
        late,
        byStage: stages(byStatus.map((r) => ({ status: r.status, n: (r._count as { _all: number })._all }))),
      },
      ...paginated(await this.assignmentRows(rows), total, page, limit),
    };
  }

  async assignmentsCsv(q: AssignmentReportDto) {
    const s = await this.scope.resolve(q);
    const rows = await this.prisma.assignment.findMany({
      where: this.assignmentListWhere(s, q), take: MAX_ROWS, orderBy: [{ deadline: 'desc' }, { id: 'asc' }], select: ASSIGNMENT_SELECT,
    });
    const views = await this.assignmentRows(rows);
    return toCsv(
      ['Assignment', 'Course', 'Division', 'Academic year', 'Status', 'Published', 'Deadline', 'Expected students',
       'Submitted', 'On time', 'Late', 'Not submitted', 'Submission %', 'Awaiting distribution', 'In review',
       'Resubmission requested', 'Awaiting approval', 'Approved', 'Published results', 'Average score %'],
      views.map((v) => [
        v.title, v.course.title, v.division.name, v.academicYear.name, v.status, v.publishedAt, v.deadline, v.expectedStudents,
        v.submitted, v.onTime, v.late, v.notSubmitted, v.submissionRate, v.byStage.awaitingDistribution, v.byStage.inReview,
        v.byStage.resubmissionRequested, v.byStage.awaitingApproval, v.byStage.approved, v.byStage.published, v.averageScore,
      ]),
    );
  }

  private assignmentListWhere(s: ReportScope, q: AssignmentReportDto): Prisma.AssignmentWhereInput {
    const range = this.scope.range(s);
    return {
      ...this.scope.assignmentWhere(s),
      // Drafts and rejected briefs never reached students.
      status: q.status ?? { in: ['PUBLISHED', 'CLOSED', 'ARCHIVED'] },
      ...(range && { deadline: range }),
    };
  }

  private async assignmentRows(rows: Array<Prisma.AssignmentGetPayload<{ select: typeof ASSIGNMENT_SELECT }>>) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [byStatus, late, expected, averages] = await Promise.all([
      this.prisma.submission.groupBy({ by: ['assignmentId', 'status'], where: { assignmentId: { in: ids } }, _count: { _all: true } }),
      this.prisma.submission.groupBy({ by: ['assignmentId'], where: { assignmentId: { in: ids }, isLate: true }, _count: { _all: true } }),
      // Students expected: active enrolments (activated accounts) of the assignment's year and division.
      this.prisma.studentEnrollment.groupBy({
        by:     ['academicYearId', 'divisionId'],
        where:  {
          status: 'ACTIVE', student: this.scope.userStatusWhere('ACTIVE'),
          academicYearId: { in: [...new Set(rows.map((r) => r.academicYearId))] },
          divisionId:     { in: [...new Set(rows.map((r) => r.divisionId))] },
        },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ assignmentId: string; average: number | null }>>`
        SELECT s."assignmentId", avg(r."percentage") AS "average"
          FROM "Submission" s JOIN "MentorReview" r ON r."id" = s."publishedReviewId"
         WHERE s."assignmentId" = ANY(${ids}::text[])
         GROUP BY 1`,
    ]);

    return rows.map((a) => {
      const mine = byStatus.filter((r) => r.assignmentId === a.id).map((r) => ({ status: r.status, n: r._count._all }));
      const submitted = mine.reduce((n, r) => n + r.n, 0);
      const lateCount = late.find((r) => r.assignmentId === a.id)?._count._all ?? 0;
      const expectedStudents = expected.find((e) => e.academicYearId === a.academicYearId && e.divisionId === a.divisionId)?._count._all ?? 0;
      const { academicYearId: _y, divisionId: _d, ...rest } = a;
      return {
        ...rest,
        expectedStudents,
        submitted,
        onTime:         submitted - lateCount,
        late:           lateCount,
        notSubmitted:   Math.max(expectedStudents - submitted, 0),
        submissionRate: rate(submitted, expectedStudents),
        byStage:        stages(mine),
        averageScore:   round1(averages.find((x) => x.assignmentId === a.id)?.average),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pending and completed reviews
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Pending: open review cycles now (by status, age and mentor), plus work
   * waiting for distribution or admin approval. Completed: reviews mentors
   * finished (in the date range, if given) — outcomes and turnaround.
   */
  async reviews(q: ReportFiltersDto) {
    const s = await this.scope.resolve(q);
    const assignment = this.scope.assignmentWhere(s);
    const range = this.scope.range(s);
    const scoped: Prisma.MentorReviewWhereInput = { submission: { assignment } };
    const open: Prisma.MentorReviewWhereInput = { ...scoped, status: { in: OPEN_REVIEW_STATUSES } };
    const now = Date.now();
    const completedWhere: Prisma.MentorReviewWhereInput = { ...scoped, returnedAt: range ?? { not: null } };

    const [pendingByStatus, under2, from2to7, over7, oldest, pendingByMentor, awaitingDistribution, awaitingApproval,
      completed, approved, published, sentBack, turnaround, completedByMentor] = await Promise.all([
      this.prisma.mentorReview.groupBy({ by: ['status'], where: open, _count: { _all: true } }),
      this.prisma.mentorReview.count({ where: { ...open, assignedAt: { gte: new Date(now - 2 * DAY_MS) } } }),
      this.prisma.mentorReview.count({ where: { ...open, assignedAt: { lt: new Date(now - 2 * DAY_MS), gte: new Date(now - 7 * DAY_MS) } } }),
      this.prisma.mentorReview.count({ where: { ...open, assignedAt: { lt: new Date(now - 7 * DAY_MS) } } }),
      this.prisma.mentorReview.aggregate({ where: open, _min: { assignedAt: true } }),
      this.prisma.mentorReview.groupBy({ by: ['mentorId'], where: open, _count: { _all: true }, _min: { assignedAt: true } }),
      this.prisma.submission.count({ where: { status: 'SUBMITTED', assignment } }),
      this.prisma.mentorReview.count({ where: { ...scoped, status: 'RETURNED' } }),
      this.prisma.mentorReview.count({ where: completedWhere }),
      this.prisma.mentorReview.count({ where: { ...scoped, decidedAt: range ?? { not: null }, status: { in: ['APPROVED', 'PUBLISHED'] } } }),
      this.prisma.mentorReview.count({ where: { ...scoped, publishedAt: range ?? { not: null } } }),
      this.prisma.reviewEvent.count({ where: { type: 'SENT_BACK', review: scoped, ...(range && { createdAt: range }) } }),
      this.prisma.$queryRaw<Array<{ average: number | null; median: number | null }>>`
        SELECT avg(EXTRACT(EPOCH FROM (r."returnedAt" - r."assignedAt")) / 3600) AS "average",
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r."returnedAt" - r."assignedAt")) / 3600) AS "median"
          FROM "MentorReview" r
          JOIN "Submission" s ON s."id" = r."submissionId"
          JOIN "Assignment" a ON a."id" = s."assignmentId"
         WHERE r."returnedAt" IS NOT NULL AND ${this.scope.assignmentSql(s)} AND ${this.scope.rangeSql(s, 'r."returnedAt"')}`,
      this.prisma.mentorReview.groupBy({ by: ['mentorId'], where: completedWhere, _count: { _all: true } }),
    ]);

    const mentorIds = [...new Set([...pendingByMentor, ...completedByMentor].map((r) => r.mentorId))];
    const mentors = await this.prisma.user.findMany({ where: { id: { in: mentorIds } }, select: PERSON });
    const who = (id: string) => mentors.find((m) => m.id === id) ?? null;

    return {
      filters: this.scope.describe(s),
      pending: {
        /** Assigned to a mentor and not finished (snapshot). */
        total:    pendingByStatus.reduce((n, r) => n + r._count._all, 0),
        byStatus: toCounts(pendingByStatus, (r) => r.status),
        byAge:    { underTwoDays: under2, twoToSevenDays: from2to7, overSevenDays: over7 },
        oldestAssignedAt: oldest._min.assignedAt,
        awaitingDistribution,
        awaitingAdminApproval: awaitingApproval,
        byMentor: pendingByMentor
          .map((r) => ({ mentor: who(r.mentorId), open: r._count._all, oldestAssignedAt: r._min.assignedAt }))
          .sort((a, b) => b.open - a.open),
      },
      completed: {
        /** Reviews mentors finished (in the date range, if given). */
        total:                   completed,
        approvedByAdmin:         approved,
        sentBackByAdmin:         sentBack,
        published,
        averageTurnaroundHours:  round1(turnaround[0]?.average),
        medianTurnaroundHours:   round1(turnaround[0]?.median),
        byMentor: completedByMentor
          .map((r) => ({ mentor: who(r.mentorId), completed: r._count._all }))
          .sort((a, b) => b.completed - a.completed),
      },
    };
  }

  /** One row per review cycle (assigned in the date range, if given). */
  async reviewsCsv(q: ReportFiltersDto) {
    const s = await this.scope.resolve(q);
    const range = this.scope.range(s);
    const rows = await this.prisma.mentorReview.findMany({
      where:   { submission: { assignment: this.scope.assignmentWhere(s) }, ...(range && { assignedAt: range }) },
      orderBy: [{ assignedAt: 'desc' }, { id: 'asc' }],
      take:    MAX_ROWS,
      select:  {
        cycle: true, status: true, score: true, percentage: true,
        assignedAt: true, startedAt: true, markedAt: true, returnedAt: true, decidedAt: true, publishedAt: true,
        mentor:     { select: PERSON },
        submission: {
          select: {
            student:    { select: PERSON },
            assignment: { select: { title: true, course: { select: { title: true } }, division: { select: { name: true } } } },
          },
        },
      },
    });
    const now = Date.now();
    return toCsv(
      ['Assignment', 'Course', 'Division', 'Student', 'Mentor', 'Cycle', 'Status', 'Score', 'Percentage',
       'Assigned', 'Started', 'Marked', 'Completed', 'Decided', 'Published', 'Hours to complete', 'Days open'],
      rows.map((r) => [
        r.submission.assignment.title, r.submission.assignment.course.title, r.submission.assignment.division.name,
        fullName(r.submission.student), fullName(r.mentor), r.cycle, r.status, r.score, r.percentage,
        r.assignedAt, r.startedAt, r.markedAt, r.returnedAt, r.decidedAt, r.publishedAt,
        r.returnedAt ? round1((r.returnedAt.getTime() - r.assignedAt.getTime()) / 3_600_000) : null,
        OPEN_REVIEW_STATUSES.includes(r.status) ? round1((now - r.assignedAt.getTime()) / DAY_MS) : null,
      ]),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Results publication
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Published results, releases and who published them; per assignment the
   * results reviewed, waiting and published. Date range = published between.
   */
  async resultsPublication(q: ReportListDto) {
    const s = await this.scope.resolve(q);
    const { page, limit, skip, take } = pageArgs(q);
    const assignment = this.scope.assignmentWhere(s);
    const range = this.scope.range(s);
    const listWhere = this.resultsListWhere(s);

    const [published, awaiting, releases, byPublisher, average, rows, total] = await Promise.all([
      this.prisma.submission.count({ where: { assignment, status: 'PUBLISHED', publishedAt: range ?? { not: null } } }),
      this.prisma.submission.count({ where: { assignment, status: 'APPROVED' } }),
      this.prisma.resultRelease.count({ where: { assignment, ...(range && { publishedAt: range }) } }),
      this.prisma.resultRelease.groupBy({
        by: ['publishedById'], where: { assignment, ...(range && { publishedAt: range }) },
        _count: { _all: true }, _sum: { resultCount: true },
      }),
      this.prisma.$queryRaw<Array<{ average: number | null }>>`
        SELECT avg(r."percentage") AS "average"
          FROM "Submission" s
          JOIN "Assignment" a ON a."id" = s."assignmentId"
          JOIN "MentorReview" r ON r."id" = s."publishedReviewId"
         WHERE s."status" = 'PUBLISHED' AND ${this.scope.assignmentSql(s)} AND ${this.scope.rangeSql(s, 's."publishedAt"')}`,
      this.prisma.assignment.findMany({ where: listWhere, skip, take, orderBy: [{ deadline: 'desc' }, { id: 'asc' }], select: ASSIGNMENT_SELECT }),
      this.prisma.assignment.count({ where: listWhere }),
    ]);
    const publishers = await this.prisma.user.findMany({ where: { id: { in: byPublisher.map((p) => p.publishedById) } }, select: PERSON });

    return {
      filters: this.scope.describe(s),
      summary: {
        resultsPublished:    published,
        awaitingPublication: awaiting,
        releases,
        averagePublishedScore: round1(average[0]?.average),
        byPublisher: byPublisher.map((p) => ({
          publishedBy: publishers.find((u) => u.id === p.publishedById) ?? null,
          releases:    p._count._all,
          results:     p._sum.resultCount ?? 0,
        })),
      },
      ...paginated(await this.resultRows(rows, s), total, page, limit),
    };
  }

  async resultsPublicationCsv(q: ReportListDto) {
    const s = await this.scope.resolve(q);
    const rows = await this.prisma.assignment.findMany({
      where: this.resultsListWhere(s), take: MAX_ROWS, orderBy: [{ deadline: 'desc' }, { id: 'asc' }], select: ASSIGNMENT_SELECT,
    });
    const views = await this.resultRows(rows, s);
    return toCsv(
      ['Assignment', 'Course', 'Division', 'Academic year', 'Deadline', 'Submissions', 'Awaiting approval',
       'Approved, not published', 'Published', 'Releases', 'Last published', 'Last published by', 'Average score %'],
      views.map((v) => [
        v.title, v.course.title, v.division.name, v.academicYear.name, v.deadline, v.submissions, v.awaitingApproval,
        v.awaitingPublication, v.published, v.releases, v.lastPublishedAt,
        v.lastPublishedBy ? fullName(v.lastPublishedBy) : null, v.averageScore,
      ]),
    );
  }

  /** Assignments with work submitted; with a date range, those with a release in it. */
  private resultsListWhere(s: ReportScope): Prisma.AssignmentWhereInput {
    const range = this.scope.range(s);
    return {
      ...this.scope.assignmentWhere(s),
      ...(range ? { resultReleases: { some: { publishedAt: range } } } : { submissions: { some: {} } }),
    };
  }

  private async resultRows(rows: Array<Prisma.AssignmentGetPayload<{ select: typeof ASSIGNMENT_SELECT }>>, s: ReportScope) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const range = this.scope.range(s);
    const [byStatus, releases, latest, averages] = await Promise.all([
      this.prisma.submission.groupBy({ by: ['assignmentId', 'status'], where: { assignmentId: { in: ids } }, _count: { _all: true } }),
      this.prisma.resultRelease.groupBy({
        by: ['assignmentId'], where: { assignmentId: { in: ids }, ...(range && { publishedAt: range }) },
        _count: { _all: true }, _max: { publishedAt: true },
      }),
      this.prisma.resultRelease.findMany({
        where:    { assignmentId: { in: ids } },
        distinct: ['assignmentId'],
        orderBy:  [{ assignmentId: 'asc' }, { publishedAt: 'desc' }],
        select:   { assignmentId: true, publishedAt: true, publishedBy: { select: PERSON } },
      }),
      this.prisma.$queryRaw<Array<{ assignmentId: string; average: number | null }>>`
        SELECT s."assignmentId", avg(r."percentage") AS "average"
          FROM "Submission" s JOIN "MentorReview" r ON r."id" = s."publishedReviewId"
         WHERE s."assignmentId" = ANY(${ids}::text[]) AND s."status" = 'PUBLISHED'
         GROUP BY 1`,
    ]);
    return rows.map((a) => {
      const of = (...st: SubmissionStatus[]) => byStatus
        .filter((r) => r.assignmentId === a.id && st.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
      const rel  = releases.find((r) => r.assignmentId === a.id);
      const last = latest.find((r) => r.assignmentId === a.id);
      const { academicYearId: _y, divisionId: _d, ...rest } = a;
      return {
        ...rest,
        submissions:         byStatus.filter((r) => r.assignmentId === a.id).reduce((n, r) => n + r._count._all, 0),
        awaitingApproval:    of('SUBMITTED_TO_ADMIN'),
        awaitingPublication: of('APPROVED'),
        published:           of('PUBLISHED'),
        releases:            rel?._count._all ?? 0,
        lastPublishedAt:     last?.publishedAt ?? null,
        lastPublishedBy:     last?.publishedBy ?? null,
        averageScore:        round1(averages.find((x) => x.assignmentId === a.id)?.average),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mentor activity
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Per mentor (in the division/course scope): reviews assigned, completed and
   * open, admin send-backs, turnaround, assignments prepared, discussion
   * comments and last login. Date range = activity between.
   */
  async mentorActivity(q: UserReportDto) {
    const s = await this.scope.resolve(q);
    const { page, limit, skip, take } = pageArgs(q);
    const where = this.mentorActivityWhere(s, q);
    const [rows, total, summary] = await Promise.all([
      this.prisma.user.findMany({ where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: MENTOR_SELECT }),
      this.prisma.user.count({ where }),
      this.mentorSummary(s, where),
    ]);
    return {
      filters: { ...this.scope.describe(s), status: q.status ?? null },
      summary,
      ...paginated(await this.mentorRows(s, rows), total, page, limit),
    };
  }

  async mentorActivityCsv(q: UserReportDto) {
    const s = await this.scope.resolve(q);
    const rows = await this.prisma.user.findMany({
      where: this.mentorActivityWhere(s, q), take: MAX_ROWS,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: MENTOR_SELECT,
    });
    const views = await this.mentorRows(s, rows);
    return toCsv(
      ['Mentor', 'Username', 'Email', 'Status', 'Teaching', 'Reviews assigned', 'Reviews completed', 'Open reviews',
       'Sent back by admin', 'Average review hours', 'Assignments prepared', 'Discussion comments', 'Last login'],
      views.map((v) => [
        fullName(v), v.username, v.email, v.status,
        v.teaching.map((t) => `${t.course.title} (${t.division.name})`).join('; '),
        v.reviewsAssigned, v.reviewsCompleted, v.openReviews, v.sentBackByAdmin, v.averageReviewHours,
        v.assignmentsPrepared, v.discussionComments, v.lastLoginAt,
      ]),
    );
  }

  private mentorActivityWhere(s: ReportScope, q: UserReportDto): Prisma.UserWhereInput {
    return {
      ...this.scope.mentorWhere(s),
      ...this.scope.userStatusWhere(q.status),
      ...(q.q && { AND: [searchWhere(q.q)] }),
    };
  }

  /** Totals over every mentor matching the filters. */
  private async mentorSummary(s: ReportScope, mentorWhere: Prisma.UserWhereInput) {
    const range = this.scope.range(s);
    const scoped: Prisma.MentorReviewWhereInput = { mentor: mentorWhere, submission: { assignment: this.scope.assignmentWhere(s) } };
    const [mentors, active, completed, open, turnaround] = await Promise.all([
      this.prisma.user.count({ where: mentorWhere }),
      this.prisma.user.count({ where: { ...mentorWhere, reviews: { some: { ...scoped, returnedAt: range ?? { not: null } } } } }),
      this.prisma.mentorReview.count({ where: { ...scoped, returnedAt: range ?? { not: null } } }),
      this.prisma.mentorReview.count({ where: { ...scoped, status: { in: OPEN_REVIEW_STATUSES } } }),
      this.prisma.$queryRaw<Array<{ average: number | null }>>`
        SELECT avg(EXTRACT(EPOCH FROM (r."returnedAt" - r."assignedAt")) / 3600) AS "average"
          FROM "MentorReview" r
          JOIN "Submission" s ON s."id" = r."submissionId"
          JOIN "Assignment" a ON a."id" = s."assignmentId"
          JOIN "User" m ON m."id" = r."mentorId"
         WHERE r."returnedAt" IS NOT NULL AND m."role" = 'MENTOR'
           AND ${this.scope.assignmentSql(s)} AND ${this.scope.rangeSql(s, 'r."returnedAt"')}`,
    ]);
    return {
      mentors,
      /** Mentors who completed at least one review (in the date range, if given). */
      mentorsWithCompletedReviews: active,
      reviewsCompleted: completed,
      openReviews:      open,
      averageReviewHours: round1(turnaround[0]?.average),
    };
  }

  private async mentorRows(s: ReportScope, rows: Array<Prisma.UserGetPayload<{ select: typeof MENTOR_SELECT }>>) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const range = this.scope.range(s);
    const assignment = this.scope.assignmentWhere(s);
    const scoped: Prisma.MentorReviewWhereInput = { mentorId: { in: ids }, submission: { assignment } };

    const [assigned, completed, open, sentBack, hours, prepared, comments] = await Promise.all([
      this.prisma.mentorReview.groupBy({ by: ['mentorId'], where: { ...scoped, ...(range && { assignedAt: range }) }, _count: { _all: true } }),
      this.prisma.mentorReview.groupBy({ by: ['mentorId'], where: { ...scoped, returnedAt: range ?? { not: null } }, _count: { _all: true } }),
      this.prisma.mentorReview.groupBy({ by: ['mentorId'], where: { ...scoped, status: { in: OPEN_REVIEW_STATUSES } }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ mentorId: string; n: number }>>`
        SELECT r."mentorId", count(*)::int AS "n"
          FROM "ReviewEvent" e
          JOIN "MentorReview" r ON r."id" = e."reviewId"
          JOIN "Submission" s ON s."id" = r."submissionId"
          JOIN "Assignment" a ON a."id" = s."assignmentId"
         WHERE e."type" = 'SENT_BACK' AND r."mentorId" = ANY(${ids}::text[])
           AND ${this.scope.assignmentSql(s)} AND ${this.scope.rangeSql(s, 'e."createdAt"')}
         GROUP BY 1`,
      this.prisma.$queryRaw<Array<{ mentorId: string; average: number | null }>>`
        SELECT r."mentorId", avg(EXTRACT(EPOCH FROM (r."returnedAt" - r."assignedAt")) / 3600) AS "average"
          FROM "MentorReview" r
          JOIN "Submission" s ON s."id" = r."submissionId"
          JOIN "Assignment" a ON a."id" = s."assignmentId"
         WHERE r."returnedAt" IS NOT NULL AND r."mentorId" = ANY(${ids}::text[])
           AND ${this.scope.assignmentSql(s)} AND ${this.scope.rangeSql(s, 'r."returnedAt"')}
         GROUP BY 1`,
      this.prisma.assignment.groupBy({
        by: ['createdById'], where: { ...assignment, createdById: { in: ids }, ...(range && { createdAt: range }) }, _count: { _all: true },
      }),
      this.prisma.comment.groupBy({
        by:    ['authorId'],
        where: { authorId: { in: ids }, status: { not: 'DELETED' }, thread: this.scope.threadWhere(s), ...(range && { createdAt: range }) },
        _count: { _all: true },
      }),
    ]);

    const count = <K extends string>(list: Array<Record<K, string> & { _count: { _all: number } }>, key: K, id: string) =>
      list.find((r) => r[key] === id)?._count._all ?? 0;

    return rows.map((m) => ({
      id: m.id, firstName: m.firstName, lastName: m.lastName, username: m.username, email: m.email,
      status:              accountStatus(m),
      teaching:            m.mentorAssignments.map((a) => ({ course: a.course, division: a.division })),
      reviewsAssigned:     count(assigned, 'mentorId', m.id),
      reviewsCompleted:    count(completed, 'mentorId', m.id),
      openReviews:         count(open, 'mentorId', m.id),
      sentBackByAdmin:     sentBack.find((r) => r.mentorId === m.id)?.n ?? 0,
      averageReviewHours:  round1(hours.find((r) => r.mentorId === m.id)?.average),
      assignmentsPrepared: count(prepared, 'createdById', m.id),
      discussionComments:  count(comments, 'authorId', m.id),
      lastLoginAt:         m.lastLoginAt,
    }));
  }
}

const MENTOR_SELECT = {
  ...PERSON, email: true, isActive: true, activatedAt: true, lastLoginAt: true,
  mentorAssignments: {
    where:   { isActive: true },
    orderBy: { createdAt: 'asc' },
    select:  { course: { select: { id: true, code: true, title: true } }, division: { select: { id: true, code: true, name: true } } },
  },
} as const satisfies Prisma.UserSelect;

/** Submission status counts → the report's stages. */
function stages(counts: Array<{ status: SubmissionStatus; n: number }>) {
  return Object.fromEntries(
    Object.entries(STAGES).map(([stage, statuses]) => [
      stage, counts.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c.n, 0),
    ]),
  ) as Record<keyof typeof STAGES, number>;
}
