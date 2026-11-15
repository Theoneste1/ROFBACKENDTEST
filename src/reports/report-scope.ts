/**
 * Resolves and validates report filters into a scope, and turns that scope
 * into database conditions every report applies the same way.
 *
 *   academicYearId  omitted → the current academic year; "all" → every year.
 *   divisionId / courseId must exist (404 otherwise).
 *   from / to       a plain date covers the whole day in APP_TIMEZONE; `to` is
 *                   inclusive of that day. `from` must be before `to`.
 *
 * Programme scope (P1-10, plan §7.2): for a Head Coach caller every condition
 * below is also restricted to the programmes they head — their courses, and
 * the Students and Coaches who are active members; a course of another
 * programme → 404. Administrators: no restriction. The caller is a required
 * argument, so no report can resolve a scope without it.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access/access.service.js';
import { isAdmin, isHeadCoach, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { DATE_PATTERN, DEFAULT_TIME_ZONE, fromZoned } from '../common/time/zoned-time.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ReportFiltersDto, UserStatusFilter } from './dto/report-filters.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportScope {
  /** null = every academic year. */
  year:       { id: string; name: string } | null;
  divisionId?: string;
  courseId?:   string;
  /** Inclusive start, exclusive end. */
  from?:      Date;
  to?:        Date;
  /** Head Coach callers only: the programmes they head and those programmes' course ids (both may be empty → nothing matches). */
  programmes?:         string[];
  programmeCourseIds?: string[];
}

@Injectable()
export class ReportScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: AccessService,
  ) {}

  async resolve(q: ReportFiltersDto, caller: AuthUser, opts: { unsupported?: Array<keyof ReportFiltersDto> } = {}): Promise<ReportScope> {
    for (const key of opts.unsupported ?? []) {
      if (q[key] !== undefined) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'FILTER_NOT_SUPPORTED', `This report cannot be filtered by ${key}.`);
      }
    }

    const [year, division, course] = await Promise.all([
      this.resolveYear(q.academicYearId),
      q.divisionId ? this.prisma.division.findUnique({ where: { id: q.divisionId }, select: { id: true } }) : null,
      q.courseId   ? this.prisma.course.findUnique({ where: { id: q.courseId }, select: { id: true } })     : null,
    ]);
    if (q.divisionId && !division) throw new NotFoundException('Division not found.');
    if (q.courseId && !course)     throw new NotFoundException('Course not found.');
    const programme = await this.programmeScope(caller);
    // A course outside the Head Coach's programmes is not revealed.
    if (programme && q.courseId && !programme.programmeCourseIds.includes(q.courseId)) throw new NotFoundException('Course not found.');

    const from = q.from ? this.boundary(q.from, 'start') : undefined;
    const to   = q.to   ? this.boundary(q.to, 'end')     : undefined;
    if (from && to && to <= from) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_DATE_RANGE', '`from` must be before `to`.');
    }
    return { year, divisionId: q.divisionId, courseId: q.courseId, from, to, ...programme };
  }

  /** Administrators: none. Head Coach: the programmes they head and their courses. Anyone else is refused. */
  private async programmeScope(caller: AuthUser): Promise<{ programmes: string[]; programmeCourseIds: string[] } | null> {
    if (isAdmin(caller)) return null;
    if (isHeadCoach(caller)) {
      const programmes = await this.access.headedProgrammes(caller);
      const courses = await this.prisma.course.findMany({ where: this.access.programmeCoursesFilter(programmes), select: { id: true } });
      return { programmes, programmeCourseIds: courses.map((c) => c.id) };
    }
    throw unsupportedRole();
  }

  /** The filters as applied, echoed in every report. */
  describe(s: ReportScope) {
    return {
      academicYear: s.year ?? 'all',
      divisionId:   s.divisionId ?? null,
      courseId:     s.courseId ?? null,
      from:         s.from ?? null,
      to:           s.to ?? null,
    };
  }

  // ─── Conditions ───────────────────────────────────────────────────────────

  /** `{ gte, lt }` for the date range, or undefined when no range is set. */
  range(s: ReportScope): Prisma.DateTimeFilter | undefined {
    if (!s.from && !s.to) return undefined;
    return { ...(s.from && { gte: s.from }), ...(s.to && { lt: s.to }) };
  }

  assignmentWhere(s: ReportScope): Prisma.AssignmentWhereInput {
    return {
      ...(s.year       && { academicYearId: s.year.id }),
      ...(s.divisionId && { divisionId: s.divisionId }),
      ...this.courseIdWhere(s),
    };
  }

  /** `{ courseId }` for the selected course, else the programme's courses (Head Coach), else nothing. */
  courseIdWhere(s: ReportScope): { courseId?: string | { in: string[] } } {
    if (s.courseId) return { courseId: s.courseId };
    if (s.programmeCourseIds) return { courseId: { in: s.programmeCourseIds } };
    return {};
  }

  /** Course rows in scope (the selected course, or the programme's courses for a Head Coach). */
  courseWhere(s: ReportScope): Prisma.CourseWhereInput {
    if (s.courseId) return { id: s.courseId };
    if (s.programmeCourseIds) return { id: { in: s.programmeCourseIds } };
    return {};
  }

  /** Head Coach: users with an active membership in one of the programmes. */
  memberWhere(s: ReportScope): Prisma.UserWhereInput {
    if (!s.programmes) return {};
    return { programmeMemberships: { some: { disciplineId: { in: s.programmes }, isActive: true } } };
  }

  /**
   * Students in scope: enrolled in the year (and division) when a year is
   * selected; otherwise by current placement.
   */
  studentWhere(s: ReportScope): Prisma.UserWhereInput {
    return {
      role: 'STUDENT',
      ...this.memberWhere(s),
      ...(s.year
        ? { studentEnrollments: { some: { academicYearId: s.year.id, ...(s.divisionId && { divisionId: s.divisionId }) } } }
        : s.divisionId ? { divisionId: s.divisionId } : {}),
    };
  }

  /** Mentors in scope: those assigned to the division and/or course. */
  mentorWhere(s: ReportScope): Prisma.UserWhereInput {
    return {
      role: 'MENTOR',
      ...this.memberWhere(s),
      ...((s.divisionId || s.courseId) && {
        mentorAssignments: {
          some: {
            isActive: true,
            ...(s.divisionId && { divisionId: s.divisionId }),
            ...(s.courseId   && { courseId: s.courseId }),
          },
        },
      }),
    };
  }

  /** Account status as defined by the account flags. */
  userStatusWhere(status?: UserStatusFilter): Prisma.UserWhereInput {
    switch (status) {
      case 'ACTIVE':         return { isActive: true, activatedAt: { not: null } };
      case 'INACTIVE':       return { isActive: false };
      case 'AWAITING_SETUP': return { isActive: true, activatedAt: null };
      default:               return {};
    }
  }

  /** Discussion threads in the division/course scope (course threads and assignment threads). */
  threadWhere(s: ReportScope): Prisma.DiscussionThreadWhereInput {
    return {
      ...(s.divisionId && { divisionId: s.divisionId }),
      ...(s.courseId && { OR: [{ courseId: s.courseId }, { assignment: { courseId: s.courseId } }] }),
      ...(!s.courseId && s.programmeCourseIds && {
        OR: [{ courseId: { in: s.programmeCourseIds } }, { assignment: { courseId: { in: s.programmeCourseIds } } }],
      }),
    };
  }

  /** Raw-SQL conditions on an Assignment row aliased `a`. */
  assignmentSql(s: ReportScope, alias = 'a'): Prisma.Sql {
    const col = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
    const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (s.year)       parts.push(Prisma.sql`${col('academicYearId')} = ${s.year.id}`);
    if (s.divisionId) parts.push(Prisma.sql`${col('divisionId')} = ${s.divisionId}`);
    if (s.courseId)   parts.push(Prisma.sql`${col('courseId')} = ${s.courseId}`);
    if (s.programmeCourseIds) parts.push(Prisma.sql`${col('courseId')} = ANY(${s.programmeCourseIds}::text[])`);
    return Prisma.join(parts, ' AND ');
  }

  /** Raw-SQL: the course id column is one of the programme's courses (Head Coach); TRUE otherwise. */
  courseSql(s: ReportScope, column: string): Prisma.Sql {
    if (!s.programmeCourseIds) return Prisma.sql`TRUE`;
    return Prisma.sql`${Prisma.raw(column)} = ANY(${s.programmeCourseIds}::text[])`;
  }

  /** Raw-SQL: the user id column is an active member of the programmes (Head Coach); TRUE otherwise. */
  memberSql(s: ReportScope, column: string): Prisma.Sql {
    if (!s.programmes) return Prisma.sql`TRUE`;
    return Prisma.sql`EXISTS (SELECT 1 FROM "ProgrammeMembership" pm WHERE pm."userId" = ${Prisma.raw(column)} AND pm."isActive" AND pm."disciplineId" = ANY(${s.programmes}::text[]))`;
  }

  /** Head Coach callers see no contact details and no score aggregates (D7). */
  restricted(s: ReportScope): boolean {
    return s.programmes !== undefined;
  }

  /** Raw-SQL range condition on a timestamp column, e.g. `r."returnedAt"`. */
  rangeSql(s: ReportScope, column: string): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (s.from) parts.push(Prisma.sql`${Prisma.raw(column)} >= ${s.from}`);
    if (s.to)   parts.push(Prisma.sql`${Prisma.raw(column)} < ${s.to}`);
    return Prisma.join(parts, ' AND ');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async resolveYear(value: string | undefined) {
    if (value === 'all') return null;
    if (value === undefined || value === '') {
      // Default: the current year; with none active, every year.
      return this.prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
    }
    if (!UUID.test(value)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'academicYearId must be a UUID or "all".');
    }
    const year = await this.prisma.academicYear.findUnique({ where: { id: value }, select: { id: true, name: true } });
    if (!year) throw new NotFoundException('Academic year not found.');
    return year;
  }

  private boundary(value: string, side: 'start' | 'end'): Date {
    if (!DATE_PATTERN.test(value)) return new Date(value);
    const tz = this.config.get<string>('APP_TIMEZONE') || DEFAULT_TIME_ZONE;
    let start: Date;
    try {
      start = fromZoned(value, '00:00', tz);
    } catch {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', `${value} is not a valid date.`);
    }
    return side === 'start' ? start : new Date(start.getTime() + DAY_MS);
  }
}

/** A coach's teaching, limited to the programme's courses for a Head Coach (plan §7.2: shared coach). */
export function teachingIn<C extends { id: string }, D>(s: ReportScope, list: Array<{ course: C; division: D }>): Array<{ course: C; division: D }> {
  return list
    .filter((a) => !s.programmeCourseIds || s.programmeCourseIds.includes(a.course.id))
    .map((a) => ({ course: a.course, division: a.division }));
}
