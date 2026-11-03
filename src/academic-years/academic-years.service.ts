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
import { DivisionsService } from '../divisions/divisions.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { divisionCodeForGrade, nextGrade } from '../common/grade-levels.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { GradeLevel, Prisma } from '../generated/prisma/client.js';
import {
  ActivateAcademicYearDto,
  CreateAcademicYearDto,
  ListEnrollmentsDto,
  UpdateAcademicYearDto,
  UpdateEnrollmentDto,
} from './dto/academic-year.dto.js';

type Tx = Prisma.TransactionClient;

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
      include: { _count: { select: { enrollments: true, assignments: true, liveSessions: true } } },
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
      action: 'UPDATE_ACADEMIC_YEAR', entity: 'AcademicYear', entityId: id, metadata: { ...dto },
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
   *   3. Active students without an enrolment are enrolled at their current grade.
   */
  async activate(id: string, dto: ActivateAcademicYearDto, caller: CallerCtx) {
    const target = await this.findOne(id);
    if (target.status !== 'PLANNED') throw invalidState('Only a PLANNED academic year can be activated.');

    // Resolve outside the transaction: only `tx` may be used inside it.
    const divisionFor = {
      JUNIOR: await this.divisions.idForCode('JUNIOR'),
      SENIOR: await this.divisions.idForCode('SENIOR'),
    };
    const counts = { promoted: 0, carriedOver: 0, graduated: 0, newlyEnrolled: 0, assignmentsArchived: 0 };

    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.academicYear.findFirst({ where: { isCurrent: true } });
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

      const previousEnrollments = previous
        ? await tx.studentEnrollment.findMany({
            where:   { academicYearId: previous.id, status: 'ACTIVE', student: { isActive: true } },
            select:  { id: true, studentId: true, gradeLevel: true, schoolId: true },
          })
        : [];

      for (const e of previousEnrollments) {
        const grade = dto.promoteStudents ? nextGrade(e.gradeLevel) : e.gradeLevel;
        if (!grade) {
          await tx.studentEnrollment.update({ where: { id: e.id }, data: { status: 'GRADUATED', endedAt: now } });
          if (dto.deactivateGraduates ?? true) {
            await tx.user.update({ where: { id: e.studentId }, data: { isActive: false } });
          }
          counts.graduated++;
          continue;
        }
        await tx.studentEnrollment.update({
          where: { id: e.id },
          data:  { status: dto.promoteStudents ? 'PROMOTED' : 'ACTIVE', endedAt: now },
        });
        await this.writeEnrollment(tx, e.studentId, id, grade, divisionFor[divisionCodeForGrade(grade)], e.schoolId);
        if (dto.promoteStudents) counts.promoted++;
        else counts.carriedOver++;
      }

      // Active students who had no enrolment (e.g. created before years existed).
      const unenrolled = await tx.user.findMany({
        where: {
          role: 'STUDENT', isActive: true, gradeLevel: { not: null },
          studentEnrollments: { none: { academicYearId: id } },
        },
        select: { id: true, gradeLevel: true, schoolId: true },
      });
      for (const s of unenrolled) {
        await this.writeEnrollment(tx, s.id, id, s.gradeLevel!, divisionFor[divisionCodeForGrade(s.gradeLevel!)], s.schoolId);
        counts.newlyEnrolled++;
      }

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'ACTIVATE_ACADEMIC_YEAR', entity: 'AcademicYear', entityId: id,
        metadata: { previousYearId: previous?.id ?? null, ...dto, counts },
      }, tx);
    }, { timeout: 120_000 });

    return { academicYear: await this.findOne(id), ...counts };
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
