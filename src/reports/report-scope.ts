/**
 * Resolves and validates report filters into a scope, and turns that scope
 * into database conditions every report applies the same way.
 *
 *   academicYearId  omitted → the current academic year; "all" → every year.
 *   divisionId / courseId must exist (404 otherwise).
 *   from / to       a plain date covers the whole day in APP_TIMEZONE; `to` is
 *                   inclusive of that day. `from` must be before `to`.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
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
}

@Injectable()
export class ReportScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async resolve(q: ReportFiltersDto, opts: { unsupported?: Array<keyof ReportFiltersDto> } = {}): Promise<ReportScope> {
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

    const from = q.from ? this.boundary(q.from, 'start') : undefined;
    const to   = q.to   ? this.boundary(q.to, 'end')     : undefined;
    if (from && to && to <= from) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_DATE_RANGE', '`from` must be before `to`.');
    }
    return { year, divisionId: q.divisionId, courseId: q.courseId, from, to };
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
      ...(s.courseId   && { courseId: s.courseId }),
    };
  }

  /**
   * Students in scope: enrolled in the year (and division) when a year is
   * selected; otherwise by current placement.
   */
  studentWhere(s: ReportScope): Prisma.UserWhereInput {
    return {
      role: 'STUDENT',
      ...(s.year
        ? { studentEnrollments: { some: { academicYearId: s.year.id, ...(s.divisionId && { divisionId: s.divisionId }) } } }
        : s.divisionId ? { divisionId: s.divisionId } : {}),
    };
  }

  /** Mentors in scope: those assigned to the division and/or course. */
  mentorWhere(s: ReportScope): Prisma.UserWhereInput {
    return {
      role: 'MENTOR',
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
    };
  }

  /** Raw-SQL conditions on an Assignment row aliased `a`. */
  assignmentSql(s: ReportScope, alias = 'a'): Prisma.Sql {
    const col = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
    const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (s.year)       parts.push(Prisma.sql`${col('academicYearId')} = ${s.year.id}`);
    if (s.divisionId) parts.push(Prisma.sql`${col('divisionId')} = ${s.divisionId}`);
    if (s.courseId)   parts.push(Prisma.sql`${col('courseId')} = ${s.courseId}`);
    return Prisma.join(parts, ' AND ');
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
