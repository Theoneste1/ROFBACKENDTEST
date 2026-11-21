/**
 * Academic years and student enrolment.
 *
 * - Exactly one academic year is current (DB-enforced: isCurrent is TRUE or
 *   NULL with a unique index).
 * - Each student has one StudentEnrollment per year (grade, division, school).
 *   User.gradeLevel / divisionId / schoolId mirror the current enrolment and are
 *   always updated in the same transaction.
 * - Activating a new year closes the previous one, archives its assignments
 *   and (optionally) promotes every active student one grade.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { auditChanges } from '../audit/audit-changes.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { DIVISION_GRADES, divisionCodeForGrade, nextGrade } from '../common/grade-levels.js';
import type { CallerCtx } from '../common/auth-user.js';
import { Prisma, type GradeLevel } from '../generated/prisma/client.js';
import {
  ActivateAcademicYearDto,
  CreateAcademicYearDto,
  ListEnrollmentsDto,
  UpdateAcademicYearDto,
  UpdateEnrollmentDto,
} from './dto/academic-year.dto.js';

type Tx = Prisma.TransactionClient;

/** pg advisory lock key of academic-year starts (any constant unique in this database). */
const ACTIVATION_LOCK_KEY = 7_302_026_001n;

const GRADES: GradeLevel[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

/** SQL for nextGrade(): the grade after `column`, NULL after S6 (generated from the same rule). */
function nextGradeSql(column: Prisma.Sql): Prisma.Sql {
  const steps = GRADES.map((g) => [g, nextGrade(g)] as const).filter(([, n]) => n !== null);
  return Prisma.sql`(CASE ${column} ${Prisma.join(steps.map(([g, n]) => Prisma.sql`WHEN ${g}::"GradeLevel" THEN ${n}::"GradeLevel"`), ' ')} ELSE NULL END)`;
}

/** SQL for divisionCodeForGrade() mapped to the division ids: JUNIOR for S1–S3, SENIOR otherwise. */
function divisionSql(divisionFor: Record<'JUNIOR' | 'SENIOR', string>, grade: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN ${grade}::text IN (${Prisma.join(DIVISION_GRADES.JUNIOR)}) THEN ${divisionFor.JUNIOR} ELSE ${divisionFor.SENIOR} END)`;
}

@Injectable()
export class AcademicYearsService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly divisions: DivisionsService,
  ) {}

  // ─── Read ─────────────────────────────────────────────────────────────────

  async list() {
    return this.prisma.academicYear.findMany({
      orderBy: { startsOn: 'desc' },
      include: { _count: { select: { enrollments: true, assignments: true } } },
    });
  }

  /** The current academic year, or an error if none is configured. */
  async current(tx: Tx | PrismaService = this.prisma) {
    const year = await tx.academicYear.findFirst({ where: { isCurrent: true } });
    if (!year) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'NO_CURRENT_ACADEMIC_YEAR',
        'No academic year is active. An administrator must activate one.',
      );
    }
    return year;
  }

  async findOne(id: string) {
    const year = await this.prisma.academicYear.findUnique({
      where:   { id },
      include: { _count: { select: { enrollments: true, assignments: true } } },
    });
    if (!year) throw new NotFoundException('Academic year not found.');
    return year;
  }

  // ─── Admin: manage years ──────────────────────────────────────────────────

  async create(dto: CreateAcademicYearDto, caller: CallerCtx) {
    this.assertDates(dto.startsOn, dto.endsOn);
    const year = await this.prisma.academicYear.create({
      data: { name: dto.name, startsOn: new Date(dto.startsOn), endsOn: new Date(dto.endsOn) },
    });
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'CREATE_ACADEMIC_YEAR', entity: 'AcademicYear', entityId: year.id, metadata: { name: dto.name },
    });
    return year;
  }

  async update(id: string, dto: UpdateAcademicYearDto, caller: CallerCtx) {
    const year = await this.findOne(id);
    if (year.status === 'CLOSED') throw invalidState('A closed academic year cannot be edited.');
    const startsOn = dto.startsOn ?? year.startsOn.toISOString().slice(0, 10);
    const endsOn   = dto.endsOn   ?? year.endsOn.toISOString().slice(0, 10);
    this.assertDates(startsOn, endsOn);

    const updated = await this.prisma.academicYear.update({
      where: { id },
      data:  { name: dto.name, startsOn: new Date(startsOn), endsOn: new Date(endsOn) },
    });
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UPDATE_ACADEMIC_YEAR', entity: 'AcademicYear', entityId: id,
      metadata: { ...dto, changes: auditChanges(year, updated, ['name', 'startsOn', 'endsOn']) },
    });
    return updated;
  }

  /**
   * Make a PLANNED year current.
   *
   *   1. The previous current year is CLOSED and its assignments ARCHIVED
   *      (reviews already in progress can still be finished and published).
   *   2. Every ACTIVE enrolment of the previous year rolls over:
   *        promoteStudents=true  → next grade (S3 → S4 changes division);
   *                                S6 students are GRADUATED (and deactivated
   *                                when deactivateGraduates=true);
   *        promoteStudents=false → same grade in the new year.
   *   3. Active students without an enrolment are enrolled at their current grade
   *      — except students whose latest enrolment is GRADUATED (never re-enrolled
   *      automatically, whether kept active or reactivated later).
   * Steps 2 and 3 are one SQL statement each (rollOver, enrollUnenrolled).
   */
  async activate(id: string, dto: ActivateAcademicYearDto, caller: CallerCtx) {
    await this.findOne(id);   // 404 before anything else

    // Resolve outside the transaction: only `tx` may be used inside it.
    const divisionFor = {
      JUNIOR: await this.divisions.idForCode('JUNIOR'),
      SENIOR: await this.divisions.idForCode('SENIOR'),
    };
    const counts = { promoted: 0, carriedOver: 0, graduated: 0, newlyEnrolled: 0, assignmentsArchived: 0 };

    // A start rewrites every student's enrolment, so starts are single-flight, platform-wide:
    // the transaction-scoped advisory lock is held until this start commits or rolls back. A
    // concurrent start (a retry after the proxy's ~26 s timeout, a double click, another
    // administrator) does not wait behind it — it is refused at once, and a retry after the
    // first one committed is answered from its audit record (no second rollover).
    const replay = await this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${ACTIVATION_LOCK_KEY}::bigint) AS locked`;
      if (!locked) {
        throw new AppError(HttpStatus.CONFLICT, 'ACTIVATION_IN_PROGRESS',
          'An academic year is being started right now. Wait for it to finish, then reload the list.');
      }
      // Re-read under the lock: the state seen before it may be stale.
      const target = await tx.academicYear.findUnique({ where: { id } });
      if (!target) throw new NotFoundException('Academic year not found.');
      const previous = await tx.academicYear.findFirst({ where: { isCurrent: true } });

      if (target.status !== 'PLANNED') {
        const recorded = await this.recordedActivation(tx, id, dto);
        if (recorded) return recorded;
        throw invalidState('Only a PLANNED academic year can be activated.', { currentStatus: target.status });
      }
      if ((previous?.id ?? null) !== dto.expectedCurrentYearId) {
        throw new AppError(HttpStatus.CONFLICT, 'CURRENT_YEAR_CHANGED',
          'The current academic year changed since this request was prepared; nothing was changed.',
          { expectedCurrentYearId: dto.expectedCurrentYearId, currentYearId: previous?.id ?? null });
      }
      const now = new Date();

      if (previous) {
        await tx.academicYear.update({
          where: { id: previous.id },
          data:  { isCurrent: null, status: 'CLOSED', closedAt: now },
        });
        const toArchive = await tx.assignment.findMany({
          where:  { academicYearId: previous.id, status: { not: 'ARCHIVED' } },
          select: { id: true, status: true },
        });
        const archived = await tx.assignment.updateMany({
          where: { academicYearId: previous.id, status: { not: 'ARCHIVED' } },
          data:  { status: 'ARCHIVED', archivedAt: now },
        });
        await tx.assignmentEvent.createMany({
          data: toArchive.map((a) => ({
            assignmentId: a.id, type: 'ARCHIVED' as const, fromStatus: a.status, toStatus: 'ARCHIVED' as const,
            actorId: caller.id, note: `Academic year ${previous.name} closed`, createdAt: now,
          })),
        });
        counts.assignmentsArchived = archived.count;
      }

      await tx.academicYear.update({ where: { id }, data: { isCurrent: true, status: 'ACTIVE' } });

      // Set-based (PERF-01): one statement rolls every student over and one enrols the rest, instead
      // of 3–4 statements per student (49 s for 10,000 students locally; the 120 s transaction expired at 50,000).
      if (previous) {
        const rolled = await this.rollOver(tx, {
          previousYearId: previous.id, yearId: id, now, divisionFor,
          promote: dto.promoteStudents, deactivateGraduates: dto.deactivateGraduates ?? true,
        });
        counts.graduated = rolled.graduated;
        if (dto.promoteStudents) counts.promoted = rolled.moved;
        else counts.carriedOver = rolled.moved;
      }
      counts.newlyEnrolled = await this.enrollUnenrolled(tx, { yearId: id, now, divisionFor });

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'ACTIVATE_ACADEMIC_YEAR', entity: 'AcademicYear', entityId: id,
        metadata: {
          previousYearId: previous?.id ?? null,
          promoteStudents: dto.promoteStudents,
          deactivateGraduates: dto.deactivateGraduates ?? true,
          counts,
        },
      }, tx);
      return null;
    }, { timeout: 120_000 });

    if (replay) return { academicYear: await this.findOne(id), ...replay.counts, replayed: true };
    return { academicYear: await this.findOne(id), ...counts };
  }

  /**
   * A year that is no longer PLANNED: the outcome recorded by the start that made it current, when
   * this request repeats it (same choices; same expected current year, when given). A different
   * request for an already started year is refused with what differs.
   */
  private async recordedActivation(tx: Tx, id: string, dto: ActivateAcademicYearDto) {
    const year = await tx.academicYear.findUniqueOrThrow({ where: { id }, select: { status: true, isCurrent: true } });
    if (year.status !== 'ACTIVE' || !year.isCurrent) return null;   // CLOSED since: not a repeat any more
    const entry = await tx.auditLog.findFirst({
      where: { action: 'ACTIVATE_ACADEMIC_YEAR', entity: 'AcademicYear', entityId: id },
      orderBy: { createdAt: 'desc' }, select: { metadata: true },
    });
    const m = (entry?.metadata ?? null) as {
      previousYearId?: string | null; promoteStudents?: boolean; deactivateGraduates?: boolean;
      counts?: { promoted: number; carriedOver: number; graduated: number; newlyEnrolled: number; assignmentsArchived: number };
    } | null;
    if (!m || typeof m.promoteStudents !== 'boolean' || !m.counts) return null;
    const recorded = { promoteStudents: m.promoteStudents, deactivateGraduates: m.deactivateGraduates ?? true };
    const asked = { promoteStudents: dto.promoteStudents, deactivateGraduates: dto.deactivateGraduates ?? true };
    if (recorded.promoteStudents !== asked.promoteStudents || (asked.promoteStudents && recorded.deactivateGraduates !== asked.deactivateGraduates)) {
      throw new AppError(HttpStatus.CONFLICT, 'ACTIVATION_OPTIONS_DIFFER',
        'This academic year was already started with different choices; nothing was changed.', { recorded, requested: asked });
    }
    if ((m.previousYearId ?? null) !== dto.expectedCurrentYearId) {
      throw new AppError(HttpStatus.CONFLICT, 'CURRENT_YEAR_CHANGED',
        'This academic year was started from a different current year than this request expected; nothing was changed.',
        { expectedCurrentYearId: dto.expectedCurrentYearId, currentYearId: m.previousYearId ?? null });
    }
    return { counts: m.counts };
  }

  /**
   * Step 2 of a start, in ONE statement: every ACTIVE enrolment of the previous year whose student
   * is active rolls over. Same rules as the former per-student loop:
   *   - next grade (promote) or the same grade (carry over); no next grade (S6) → GRADUATED;
   *   - the old enrolment ends (endedAt = now) as PROMOTED, ACTIVE (carried over) or GRADUATED;
   *   - graduates are deactivated when `deactivateGraduates`;
   *   - everyone else gets an ACTIVE enrolment in the new year (an existing one is overwritten,
   *     as the former upsert did), and User.gradeLevel / divisionId / schoolId mirror it.
   * The data-modifying CTEs touch disjoint rows; the User triggers (M4, M10) fire per row as before.
   */
  private async rollOver(tx: Tx, p: {
    previousYearId: string; yearId: string; now: Date; promote: boolean; deactivateGraduates: boolean;
    divisionFor: Record<'JUNIOR' | 'SENIOR', string>;
  }): Promise<{ moved: number; graduated: number }> {
    // The grade in the new year (NULL: graduates). gradeLevel itself is not changed by the UPDATE,
    // so the expression means the same in SET and in RETURNING.
    const grade = Prisma.sql`(CASE WHEN ${p.promote}::boolean THEN ${nextGradeSql(Prisma.sql`e."gradeLevel"`)} ELSE e."gradeLevel" END)`;
    const [row] = await tx.$queryRaw<Array<{ moved: number; graduated: number }>>`
      WITH rolled AS (
        UPDATE "StudentEnrollment" AS e
           SET "status"  = CASE WHEN ${grade} IS NULL THEN 'GRADUATED'
                                WHEN ${p.promote}::boolean THEN 'PROMOTED'
                                ELSE 'ACTIVE' END::"StudentEnrollmentStatus",
               "endedAt" = ${p.now}::timestamp(3)
          FROM "User" AS u
         WHERE e."academicYearId" = ${p.previousYearId} AND e."status" = 'ACTIVE'
           AND u."id" = e."studentId" AND u."isActive"
        RETURNING e."studentId", e."schoolId", ${grade} AS "grade"
      ),
      graduates AS (
        UPDATE "User" AS u SET "isActive" = false, "updatedAt" = ${p.now}::timestamp(3)
          FROM rolled AS r
         WHERE ${p.deactivateGraduates}::boolean AND r."grade" IS NULL AND u."id" = r."studentId"
        RETURNING u."id"
      ),
      enrolled AS (
        INSERT INTO "StudentEnrollment" ("id", "studentId", "academicYearId", "divisionId", "gradeLevel", "schoolId", "status", "enrolledAt")
        SELECT gen_random_uuid()::text, r."studentId", ${p.yearId}, ${divisionSql(p.divisionFor, Prisma.sql`r."grade"`)},
               r."grade", r."schoolId", 'ACTIVE'::"StudentEnrollmentStatus", ${p.now}::timestamp(3)
          FROM rolled AS r WHERE r."grade" IS NOT NULL
        ON CONFLICT ("studentId", "academicYearId") DO UPDATE
           SET "gradeLevel" = EXCLUDED."gradeLevel", "divisionId" = EXCLUDED."divisionId",
               "schoolId" = EXCLUDED."schoolId", "status" = 'ACTIVE', "endedAt" = NULL
        RETURNING "studentId", "gradeLevel", "divisionId", "schoolId"
      ),
      placed AS (
        UPDATE "User" AS u
           SET "gradeLevel" = n."gradeLevel", "divisionId" = n."divisionId", "schoolId" = n."schoolId", "updatedAt" = ${p.now}::timestamp(3)
          FROM enrolled AS n
         WHERE u."id" = n."studentId"
        RETURNING u."id"
      )
      SELECT (SELECT count(*) FROM enrolled)::int AS "moved",
             (SELECT count(*) FROM rolled WHERE "grade" IS NULL)::int AS "graduated",
             (SELECT count(*) FROM graduates)::int AS "deactivated",
             (SELECT count(*) FROM placed)::int AS "placed"`;
    return { moved: row.moved, graduated: row.graduated };
  }

  /**
   * Step 3 of a start, in ONE statement: active students with a grade and no enrolment in the new
   * year (e.g. created before academic years existed) are enrolled at their current grade.
   *
   * A student whose LATEST enrolment (by academic year) is GRADUATED is never enrolled here: a
   * graduate kept active (deactivateGraduates=false), or a graduate whose account was reactivated
   * later, is not turned back into an ACTIVE S6 student of the new year (B-M3). Placing such a
   * student again is an explicit administrator action (an enrolment in the current year).
   */
  private async enrollUnenrolled(tx: Tx, p: {
    yearId: string; now: Date; divisionFor: Record<'JUNIOR' | 'SENIOR', string>;
  }): Promise<number> {
    const [row] = await tx.$queryRaw<Array<{ enrolled: number }>>`
      WITH candidates AS (
        SELECT u."id", u."gradeLevel", u."schoolId"
          FROM "User" AS u
         WHERE u."role" = 'STUDENT' AND u."isActive" AND u."gradeLevel" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "StudentEnrollment" AS n WHERE n."studentId" = u."id" AND n."academicYearId" = ${p.yearId})
           AND (SELECT l."status" FROM "StudentEnrollment" AS l JOIN "AcademicYear" AS y ON y."id" = l."academicYearId"
                 WHERE l."studentId" = u."id"
                 ORDER BY y."startsOn" DESC, l."enrolledAt" DESC
                 LIMIT 1) IS DISTINCT FROM 'GRADUATED'
      ),
      enrolled AS (
        INSERT INTO "StudentEnrollment" ("id", "studentId", "academicYearId", "divisionId", "gradeLevel", "schoolId", "status", "enrolledAt")
        SELECT gen_random_uuid()::text, c."id", ${p.yearId}, ${divisionSql(p.divisionFor, Prisma.sql`c."gradeLevel"`)},
               c."gradeLevel", c."schoolId", 'ACTIVE'::"StudentEnrollmentStatus", ${p.now}::timestamp(3)
          FROM candidates AS c
        ON CONFLICT ("studentId", "academicYearId") DO UPDATE
           SET "gradeLevel" = EXCLUDED."gradeLevel", "divisionId" = EXCLUDED."divisionId",
               "schoolId" = EXCLUDED."schoolId", "status" = 'ACTIVE', "endedAt" = NULL
        RETURNING "studentId", "gradeLevel", "divisionId", "schoolId"
      ),
      placed AS (
        UPDATE "User" AS u
           SET "gradeLevel" = n."gradeLevel", "divisionId" = n."divisionId", "schoolId" = n."schoolId", "updatedAt" = ${p.now}::timestamp(3)
          FROM enrolled AS n
         WHERE u."id" = n."studentId"
        RETURNING u."id"
      )
      SELECT (SELECT count(*) FROM enrolled)::int AS "enrolled", (SELECT count(*) FROM placed)::int AS "placed"`;
    return row.enrolled;
  }

  // ─── Enrolments ───────────────────────────────────────────────────────────

  async listEnrollments(yearId: string, q: ListEnrollmentsDto) {
    await this.findOne(yearId);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.StudentEnrollmentWhereInput = {
      academicYearId: yearId,
      ...(q.divisionId && { divisionId: q.divisionId }),
      ...(q.gradeLevel && { gradeLevel: q.gradeLevel }),
      ...(q.status     && { status: q.status }),
      ...(q.schoolId   && { schoolId: q.schoolId }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.studentEnrollment.findMany({
        where, skip, take,
        orderBy: [{ gradeLevel: 'asc' }, { student: { lastName: 'asc' } }],
        include: {
          student:  { select: { id: true, firstName: true, lastName: true, username: true, isActive: true } },
          division: { select: { id: true, code: true, name: true } },
          school:   { select: { id: true, name: true } },
        },
      }),
      this.prisma.studentEnrollment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Change an enrolment: correct the grade, or withdraw the student. */
  async updateEnrollment(enrollmentId: string, dto: UpdateEnrollmentDto, caller: CallerCtx) {
    const e = await this.prisma.studentEnrollment.findUnique({
      where: { id: enrollmentId }, include: { academicYear: true },
    });
    if (!e) throw new NotFoundException('Enrolment not found.');
    if (!e.academicYear.isCurrent) throw invalidState('Only enrolments of the current academic year can be changed.');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.status === 'WITHDRAWN') {
        await tx.user.update({ where: { id: e.studentId }, data: { isActive: false } });
        return tx.studentEnrollment.update({
          where: { id: enrollmentId }, data: { status: 'WITHDRAWN', endedAt: new Date() },
        });
      }
      if (dto.gradeLevel) {
        const divisionId = await tx.division.findUniqueOrThrow({
          where: { code: divisionCodeForGrade(dto.gradeLevel) }, select: { id: true },
        });
        return this.writeEnrollment(tx, e.studentId, e.academicYearId, dto.gradeLevel, divisionId.id, e.schoolId);
      }
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Provide gradeLevel or status.');
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UPDATE_ENROLLMENT', entity: 'StudentEnrollment', entityId: enrollmentId,
      metadata: {
        ...dto, studentId: e.studentId, academicYearId: e.academicYearId,
        from: { gradeLevel: e.gradeLevel, divisionId: e.divisionId, status: e.status },
        to:   { gradeLevel: updated.gradeLevel, divisionId: updated.divisionId, status: updated.status },
      },
    });
    return updated;
  }

  /**
   * Enrol (or re-place) a student in the CURRENT year at the given grade and
   * mirror the placement on the User row. Call inside the caller's transaction.
   */
  async enrollInCurrentYear(tx: Tx, studentId: string, gradeLevel: GradeLevel, schoolId: string | null) {
    const year = await this.current(tx);
    const division = await tx.division.findUniqueOrThrow({
      where: { code: divisionCodeForGrade(gradeLevel) }, select: { id: true },
    });
    return this.writeEnrollment(tx, studentId, year.id, gradeLevel, division.id, schoolId);
  }

  private async writeEnrollment(
    tx: Tx, studentId: string, academicYearId: string,
    gradeLevel: GradeLevel, divisionId: string, schoolId: string | null,
  ) {
    const enrollment = await tx.studentEnrollment.upsert({
      where:  { studentId_academicYearId: { studentId, academicYearId } },
      create: { studentId, academicYearId, gradeLevel, divisionId, schoolId, status: 'ACTIVE' },
      update: { gradeLevel, divisionId, schoolId, status: 'ACTIVE', endedAt: null },
    });
    await tx.user.update({ where: { id: studentId }, data: { gradeLevel, divisionId, schoolId } });
    return enrollment;
  }

  private assertDates(startsOn: string, endsOn: string) {
    if (new Date(endsOn) <= new Date(startsOn)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_DATE_RANGE', 'endsOn must be after startsOn.');
    }
  }
}
