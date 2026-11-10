/**
 * User reports for administrators: student and mentor lists, enrolment and
 * course participation. JSON for the API (lists are paginated) and CSV for
 * download (up to MAX_ROWS rows). All figures come from live records using
 * aggregate queries; per-row statistics are fetched for the current page only.
 */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from '../common/auth-user.js';
import { ReportScopeService, teachingIn, type ReportScope } from './report-scope.js';
import type { ReportListDto, UserReportDto, UserStatusFilter } from './dto/report-filters.dto.js';
import { toCsv } from './csv.js';

export const MAX_ROWS = 50_000;

const PERSON = { id: true, firstName: true, lastName: true, username: true } as const;

type Account = { isActive: boolean; activatedAt: Date | null };
export const accountStatus = (u: Account): UserStatusFilter =>
  !u.isActive ? 'INACTIVE' : u.activatedAt ? 'ACTIVE' : 'AWAITING_SETUP';

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const round1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

@Injectable()
export class UserReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope:  ReportScopeService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Students
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Students in scope. Date range = registered between. Course = students who
   * opened that course. Status = account status.
   */
  async students(q: UserReportDto, user: AuthUser) {
    const s = await this.scope.resolve(q, user);
    const { page, limit, skip, take } = pageArgs(q);
    const where = this.studentListWhere(s, q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: this.studentSelect(s) }),
      this.prisma.user.count({ where }),
    ]);
    return { filters: { ...this.scope.describe(s), status: q.status ?? null }, ...paginated(await this.studentViews(s, rows), total, page, limit) };
  }

  async studentsCsv(q: UserReportDto, user: AuthUser) {
    const s = await this.scope.resolve(q, user);
    const rows = await this.prisma.user.findMany({
      where: this.studentListWhere(s, q), take: MAX_ROWS,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: this.studentSelect(s),
    });
    const views = await this.studentViews(s, rows);
    return toCsv(
      ['Student', 'Username', 'Email', 'Status', 'Division', 'Grade', 'School', 'Enrolment status',
       'Submissions', 'Results published', 'Points', 'Registered', 'Activated', 'Last login'],
      views.map((v) => [
        v.name, v.username, v.email, v.status, v.division?.name, v.gradeLevel, v.school?.name, v.enrollmentStatus,
        v.submissions, v.resultsPublished, v.points, v.registeredAt, v.activatedAt, v.lastLoginAt,
      ]),
    );
  }

  private studentListWhere(s: ReportScope, q: UserReportDto): Prisma.UserWhereInput {
    const range = this.scope.range(s);
    return {
      ...this.scope.studentWhere(s),
      ...this.scope.userStatusWhere(q.status),
      ...(range && { createdAt: range }),
      ...(s.courseId && { courseEnrollments: { some: { courseId: s.courseId, status: { in: ['ROLLED', 'COMPLETED'] } } } }),
      ...(q.q && { AND: [searchWhere(q.q)] }),
    };
  }

  private studentSelect(s: ReportScope) {
    return {
      ...PERSON, email: true, gradeLevel: true, isActive: true, activatedAt: true,
      createdAt: true, lastLoginAt: true, points: true,
      division: { select: { id: true, code: true, name: true } },
      school:   { select: { id: true, name: true } },
      studentEnrollments: {
        where:  { academicYearId: s.year?.id ?? '' },
        take:   1,
        select: { gradeLevel: true, status: true, division: { select: { id: true, code: true, name: true } }, school: { select: { id: true, name: true } } },
      },
    } satisfies Prisma.UserSelect;
  }

  /** Adds submission counts for the page in one grouped query. */
  private async studentViews(s: ReportScope, rows: Array<Prisma.UserGetPayload<{ select: ReturnType<UserReportsService['studentSelect']> }>>) {
    const counts = rows.length
      ? await this.prisma.submission.groupBy({
          by:     ['studentId', 'status'],
          where:  { studentId: { in: rows.map((r) => r.id) }, assignment: this.scope.assignmentWhere(s) },
          _count: { _all: true },
        })
      : [];
    const restricted = this.scope.restricted(s);
    return rows.map((u) => {
      const mine = counts.filter((c) => c.studentId === u.id);
      const enrol = u.studentEnrollments[0];
      return {
        id: u.id, name: fullName(u), username: u.username,
        ...(!restricted && { email: u.email }),   // Head Coach: no contact details (D7)
        status:           accountStatus(u),
        // The selected year's enrolment when there is one; otherwise current placement.
        division:         enrol?.division ?? u.division,
        gradeLevel:       enrol?.gradeLevel ?? u.gradeLevel,
        school:           enrol?.school ?? u.school,
        enrollmentStatus: enrol?.status ?? null,
        submissions:      mine.reduce((n, c) => n + c._count._all, 0),
        resultsPublished: mine.find((c) => c.status === 'PUBLISHED')?._count._all ?? 0,
        points:           u.points,
        registeredAt:     u.createdAt,
        activatedAt:      u.activatedAt,
        lastLoginAt:      u.lastLoginAt,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mentors
  // ═══════════════════════════════════════════════════════════════════════════

  /** Mentors in scope (assigned to the division/course). Date range = registered between. */
  async mentors(q: UserReportDto, user: AuthUser) {
    const s = await this.scope.resolve(q, user);
    const { page, limit, skip, take } = pageArgs(q);
    const where = this.mentorListWhere(s, q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: MENTOR_SELECT }),
      this.prisma.user.count({ where }),
    ]);
    return { filters: { ...this.scope.describe(s), status: q.status ?? null }, ...paginated(await this.mentorViews(s, rows), total, page, limit) };
  }

  async mentorsCsv(q: UserReportDto, user: AuthUser) {
    const s = await this.scope.resolve(q, user);
    const rows = await this.prisma.user.findMany({
      where: this.mentorListWhere(s, q), take: MAX_ROWS,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: MENTOR_SELECT,
    });
    const views = await this.mentorViews(s, rows);
    return toCsv(
      ['Coach', 'Username', 'Email', 'Status', 'Teaching', 'Open reviews', 'Registered', 'Activated', 'Last login'],
      views.map((v) => [
        v.name, v.username, v.email, v.status,
        v.teaching.map((t) => `${t.course.title} (${t.division.name})`).join('; '),
        v.openReviews, v.registeredAt, v.activatedAt, v.lastLoginAt,
      ]),
    );
  }

  private mentorListWhere(s: ReportScope, q: UserReportDto): Prisma.UserWhereInput {
    const range = this.scope.range(s);
    return {
      ...this.scope.mentorWhere(s),
      ...this.scope.userStatusWhere(q.status),
      ...(range && { createdAt: range }),
      ...(q.q && { AND: [searchWhere(q.q)] }),
    };
  }

  private async mentorViews(s: ReportScope, rows: Array<Prisma.UserGetPayload<{ select: typeof MENTOR_SELECT }>>) {
    const open = rows.length
      ? await this.prisma.mentorReview.groupBy({
          by:     ['mentorId'],
          where:  { mentorId: { in: rows.map((r) => r.id) }, status: { in: OPEN_REVIEW_STATUSES }, submission: { assignment: this.scope.assignmentWhere(s) } },
          _count: { _all: true },
        })
      : [];
    const restricted = this.scope.restricted(s);
    return rows.map((m) => ({
      id: m.id, name: fullName(m), username: m.username,
      ...(!restricted && { email: m.email }),   // Head Coach: no contact details (D7)
      status:       accountStatus(m),
      teaching:     teachingIn(s, m.mentorAssignments),
      openReviews:  open.find((o) => o.mentorId === m.id)?._count._all ?? 0,
      registeredAt: m.createdAt,
      activatedAt:  m.activatedAt,
      lastLoginAt:  m.lastLoginAt,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Enrolment
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Student enrolments per academic year × division × school × grade, by
   * enrolment status. Date range = enrolled between. Not filterable by course.
   */
  async enrollment(q: ReportListDto, user: AuthUser) {
    const s = await this.scope.resolve(q, user, { unsupported: ['courseId'] });
    const range = this.scope.range(s);
    const groups = await this.prisma.studentEnrollment.groupBy({
      by:    ['academicYearId', 'divisionId', 'schoolId', 'gradeLevel', 'status'],
      where: {
        ...(s.year && { academicYearId: s.year.id }),
        ...(s.divisionId && { divisionId: s.divisionId }),
        ...(range && { enrolledAt: range }),
      },
      _count: { _all: true },
    });

    const [years, divisions, schools] = await Promise.all([
      this.prisma.academicYear.findMany({ where: { id: { in: unique(groups.map((g) => g.academicYearId)) } }, select: { id: true, name: true } }),
      this.prisma.division.findMany({ where: { id: { in: unique(groups.map((g) => g.divisionId)) } }, select: { id: true, code: true, name: true } }),
      this.prisma.school.findMany({ where: { id: { in: unique(groups.map((g) => g.schoolId)) } }, select: { id: true, name: true, location: true } }),
    ]);

    const rows = new Map<string, EnrollmentRow>();
    for (const g of groups) {
      const key = [g.academicYearId, g.divisionId, g.schoolId ?? '', g.gradeLevel].join('|');
      let row = rows.get(key);
      if (!row) {
        const school = schools.find((x) => x.id === g.schoolId) ?? null;
        row = {
          academicYear: years.find((y) => y.id === g.academicYearId)!,
          division:     divisions.find((d) => d.id === g.divisionId)!,
          school, gradeLevel: g.gradeLevel,
          active: 0, promoted: 0, graduated: 0, withdrawn: 0, total: 0,
        };
        rows.set(key, row);
      }
      const n = g._count._all;
      row[g.status.toLowerCase() as 'active' | 'promoted' | 'graduated' | 'withdrawn'] += n;
      row.total += n;
    }
    const list = [...rows.values()].sort((a, b) =>
      a.academicYear.name.localeCompare(b.academicYear.name) || a.division.code.localeCompare(b.division.code)
      || (a.school?.name ?? '').localeCompare(b.school?.name ?? '') || a.gradeLevel.localeCompare(b.gradeLevel));

    const sum = (pick: (r: EnrollmentRow) => number, rs = list) => rs.reduce((n, r) => n + pick(r), 0);
    return {
      filters: this.scope.describe(s),
      totals: {
        active: sum((r) => r.active), promoted: sum((r) => r.promoted),
        graduated: sum((r) => r.graduated), withdrawn: sum((r) => r.withdrawn), total: sum((r) => r.total),
      },
      byDivision: divisions.map((d) => {
        const mine = list.filter((r) => r.division.id === d.id);
        return { division: d, active: sum((r) => r.active, mine), total: sum((r) => r.total, mine) };
      }),
      rows: list,
    };
  }

  async enrollmentCsv(q: ReportListDto, user: AuthUser) {
    const report = await this.enrollment(q, user);
    return toCsv(
      ['Academic year', 'Division', 'School', 'Location', 'Grade', 'Active', 'Promoted', 'Graduated', 'Withdrawn', 'Total'],
      report.rows.map((r) => [
        r.academicYear.name, r.division.name, r.school?.name ?? '(no school)', r.school?.location, r.gradeLevel,
        r.active, r.promoted, r.graduated, r.withdrawn, r.total,
      ]),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Course participation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Per course × division: students in scope, how many opened and completed
   * the course, assignments, submissions, average published score and
   * discussion activity. Date range = activity between.
   */
  async courseParticipation(q: ReportListDto, user: AuthUser) {
    const s = await this.scope.resolve(q, user);
    const range = this.scope.range(s);
    const A = this.scope.assignmentSql(s);

    const [courses, divisions, students, opened, assignments, submissions, discussion] = await Promise.all([
      this.prisma.course.findMany({ where: this.scope.courseWhere(s), orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, title: true } }),
      this.prisma.division.findMany({ where: s.divisionId ? { id: s.divisionId } : {}, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
      this.studentsPerDivision(s),
      this.openedPerCourse(s),
      this.prisma.assignment.groupBy({
        by:     ['courseId', 'divisionId'],
        where:  { ...this.scope.assignmentWhere(s), status: { in: ['PUBLISHED', 'CLOSED', 'ARCHIVED'] }, publishedAt: range ?? { not: null } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ courseId: string; divisionId: string; submissions: number; students: number; average: number | null }>>`
        SELECT a."courseId", a."divisionId",
               count(s."id")::int AS "submissions",
               count(DISTINCT s."studentId")::int AS "students",
               avg(r."percentage") AS "average"
          FROM "Submission" s
          JOIN "Assignment" a ON a."id" = s."assignmentId"
          LEFT JOIN "MentorReview" r ON r."id" = s."publishedReviewId"
         WHERE ${A} AND ${this.scope.rangeSql(s, 's."submittedAt"')} AND ${this.scope.memberSql(s, 's."studentId"')}
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<Array<{ courseId: string; divisionId: string; threads: number; comments: number }>>`
        SELECT COALESCE(t."courseId", a."courseId") AS "courseId", t."divisionId",
               count(DISTINCT t."id") FILTER (WHERE ${this.scope.rangeSql(s, 't."createdAt"')})::int AS "threads",
               count(c."id")::int AS "comments"
          FROM "DiscussionThread" t
          LEFT JOIN "Assignment" a ON a."id" = t."assignmentId"
          LEFT JOIN "Comment" c ON c."threadId" = t."id" AND c."status" = 'ACTIVE' AND ${this.scope.rangeSql(s, 'c."createdAt"')}
         WHERE t."status" <> 'DELETED'
           AND (t."assignmentId" IS NULL OR ${A})
           ${s.divisionId ? Prisma.sql`AND t."divisionId" = ${s.divisionId}` : Prisma.empty}
           ${s.courseId ? Prisma.sql`AND COALESCE(t."courseId", a."courseId") = ${s.courseId}` : Prisma.empty}
           AND ${this.scope.courseSql(s, 'COALESCE(t."courseId", a."courseId")')}
         GROUP BY 1, 2`,
    ]);

    const find = <T extends { courseId: string; divisionId: string }>(rows: T[], c: string, d: string) =>
      rows.find((r) => r.courseId === c && r.divisionId === d);

    const restricted = this.scope.restricted(s);
    const rows = courses.flatMap((course) => divisions.map((division) => {
      const enrolled = students.get(division.id) ?? 0;
      const o   = find(opened, course.id, division.id);
      const sub = find(submissions, course.id, division.id);
      const dis = find(discussion, course.id, division.id);
      return {
        course, division,
        students:              enrolled,
        opened:                o?.opened ?? 0,
        completed:             o?.completed ?? 0,
        participationRate:     rate(o?.opened ?? 0, enrolled),
        assignmentsPublished:  find(assignments, course.id, division.id)?._count._all ?? 0,
        submissions:           sub?.submissions ?? 0,
        studentsSubmitted:     sub?.students ?? 0,
        submissionRate:        rate(sub?.students ?? 0, enrolled),
        averageScore:          restricted ? null : round1(sub?.average),   // Head Coach: no score aggregates (D7)
        discussionThreads:     dis?.threads ?? 0,
        discussionComments:    dis?.comments ?? 0,
      };
    }));
    return { filters: this.scope.describe(s), rows };
  }

  async courseParticipationCsv(q: ReportListDto, user: AuthUser) {
    const { rows } = await this.courseParticipation(q, user);
    return toCsv(
      ['Course', 'Division', 'Students', 'Opened course', 'Completed course', 'Participation %', 'Assignments published',
       'Submissions', 'Students who submitted', 'Submission %', 'Average score %', 'Discussion threads', 'Comments'],
      rows.map((r) => [
        r.course.title, r.division.name, r.students, r.opened, r.completed, r.participationRate, r.assignmentsPublished,
        r.submissions, r.studentsSubmitted, r.submissionRate, r.averageScore, r.discussionThreads, r.discussionComments,
      ]),
    );
  }

  /**
   * Active students per division (activated, not suspended): the year's active
   * enrolments, or current placement when every year is selected.
   */
  async studentsPerDivision(s: ReportScope): Promise<Map<string, number>> {
    const active = this.scope.userStatusWhere('ACTIVE');
    if (s.year) {
      const rows = await this.prisma.studentEnrollment.groupBy({
        by:     ['divisionId'],
        where:  { academicYearId: s.year.id, status: 'ACTIVE', student: { ...active, ...this.scope.memberWhere(s) }, ...(s.divisionId && { divisionId: s.divisionId }) },
        _count: { _all: true },
      });
      return new Map(rows.map((r) => [r.divisionId, r._count._all]));
    }
    const rows = await this.prisma.user.groupBy({
      by:     ['divisionId'],
      where:  { role: 'STUDENT', ...active, ...this.scope.memberWhere(s), ...(s.divisionId && { divisionId: s.divisionId }) },
      _count: { _all: true },
    });
    return new Map(rows.filter((r) => r.divisionId).map((r) => [r.divisionId!, r._count._all]));
  }

  /** Students (in scope) who opened / completed each course, per division. */
  private openedPerCourse(s: ReportScope) {
    const division = s.year
      ? Prisma.sql`JOIN "StudentEnrollment" x ON x."studentId" = ce."studentId" AND x."academicYearId" = ${s.year.id} AND x."status" = 'ACTIVE'`
      : Prisma.sql`JOIN "User" x ON x."id" = ce."studentId"`;
    return this.prisma.$queryRaw<Array<{ courseId: string; divisionId: string; opened: number; completed: number }>>`
      SELECT ce."courseId", x."divisionId",
             count(*) FILTER (WHERE ${this.scope.rangeSql(s, 'ce."firstOpenedAt"')})::int AS "opened",
             count(*) FILTER (WHERE ce."status" = 'COMPLETED' AND ${this.scope.rangeSql(s, 'ce."completedAt"')})::int AS "completed"
        FROM "CourseEnrollment" ce
        ${division}
       WHERE ce."status" IN ('ROLLED', 'COMPLETED') AND x."divisionId" IS NOT NULL
         ${s.divisionId ? Prisma.sql`AND x."divisionId" = ${s.divisionId}` : Prisma.empty}
         ${s.courseId ? Prisma.sql`AND ce."courseId" = ${s.courseId}` : Prisma.empty}
         AND ${this.scope.courseSql(s, 'ce."courseId"')} AND ${this.scope.memberSql(s, 'ce."studentId"')}
       GROUP BY 1, 2`;
  }
}

export interface EnrollmentRow {
  academicYear: { id: string; name: string };
  division:     { id: string; code: string; name: string };
  school:       { id: string; name: string; location: string | null } | null;
  gradeLevel:   string;
  active: number; promoted: number; graduated: number; withdrawn: number; total: number;
}

const MENTOR_SELECT = {
  ...PERSON, email: true, isActive: true, activatedAt: true, createdAt: true, lastLoginAt: true,
  mentorAssignments: {
    where:   { isActive: true },
    orderBy: { createdAt: 'asc' },
    select:  { course: { select: { id: true, code: true, title: true } }, division: { select: { id: true, code: true, name: true } } },
  },
} as const satisfies Prisma.UserSelect;

/** Name, username or e-mail contains the term (case-insensitive). */
export function searchWhere(term: string): Prisma.UserWhereInput {
  const contains = { contains: term, mode: 'insensitive' as const };
  return { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }, { email: contains }] };
}

function unique<T>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== null))];
}
