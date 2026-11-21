/**
 * Divisions (owner 2026-11-21/22: administrator-managed). A division is an Olympiad level — Junior, Middle, Senior or
 * one an Administrator creates — and what a student's courses, tests and rankings are scoped by.
 *
 *  - Create: a stable code (2–30 capitals, digits or underscores; never ALL; never changed), name, description,
 *    suggested grades, display order.
 *  - Edit: name, description, suggested grades, order, active or not. Never deleted (history, students, courses and
 *    tests keep pointing at it).
 *  - Every grade S1–S6 stays suggested by exactly ONE active division (division-rules.coverageProblems; grades given
 *    to a division are taken from the one that had them), so every
 *    student always has a division to follow. Changing the suggested grades moves no existing student: it applies to
 *    new students and to grade changes (a Coach or User Manager moves existing students, alone or in bulk).
 *  - Deactivating is refused while students are in the division or a test for it is still open (move them first).
 *  - Writes are serialized (advisory lock) so two Administrators never break the coverage rule together. Audited.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { auditChanges } from '../audit/audit-changes.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { GradeLevel, Prisma } from '../generated/prisma/client.js';
import { coverageProblems, divisionIdForGrade } from './division-rules.js';
import { CreateDivisionDto, UpdateDivisionDto } from './dto/update-division.dto.js';

/** Advisory lock serializing division writes. */
const DIVISIONS_LOCK = 8_152_026_024n;

const VIEW = { id: true, code: true, name: true, description: true, isActive: true, suggestedGrades: true, sortOrder: true } as const;

type Tx = Prisma.TransactionClient;

@Injectable()
export class DivisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  /** Every division, in display order; `gradeLevels` = the suggested grades (kept for older clients). */
  async findAll(includeCounts = false) {
    const divisions = await this.prisma.division.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: {
        ...VIEW,
        ...(includeCounts && {
          _count: { select: { students: true, mentorAssignments: true } },
        }),
      },
    });
    return divisions.map((d) => ({ ...d, gradeLevels: d.suggestedGrades }));
  }

  /** The id of the active division a grade suggests (read fresh: Administrators change it). */
  async idForGrade(grade: GradeLevel): Promise<string> {
    return divisionIdForGrade(this.prisma, grade);
  }

  /** The division with this code; 503 if missing (the seed creates JUNIOR, MIDDLE and SENIOR). */
  async idForCode(code: string): Promise<string> {
    const d = await this.prisma.division.findUnique({ where: { code }, select: { id: true } });
    if (!d) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'DIVISIONS_NOT_SEEDED', 'Divisions are not configured. Run the database seed.');
    return d.id;
  }

  async requireDivision(id: string) {
    const d = await this.prisma.division.findUnique({ where: { id }, select: VIEW });
    if (!d) throw new NotFoundException('Division not found.');
    return d;
  }

  /** Is `code` ALL or an ACTIVE division? (tests are for one of these). 400 UNKNOWN_DIVISION otherwise. */
  async assertTestLevel(code: string): Promise<void> {
    if (code === 'ALL') return;
    const d = await this.prisma.division.findUnique({ where: { code }, select: { isActive: true } });
    if (!d || !d.isActive) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_DIVISION', 'Choose ALL or an active division.', { division: code });
    }
  }

  /**
   * Grades given to a division are TAKEN from the divisions that had them (one step: e.g. S3–S4 to Middle leaves Junior
   * S1–S2 and Senior S5–S6), so an Administrator never passes through an invalid state.
   */
  private async takeGrades(tx: Tx, keepId: string, grades: readonly GradeLevel[]) {
    if (!grades.length) return;
    const holders = await tx.division.findMany({ where: { id: { not: keepId }, suggestedGrades: { hasSome: [...grades] } }, select: { id: true, suggestedGrades: true } });
    for (const h of holders) {
      await tx.division.update({ where: { id: h.id }, data: { suggestedGrades: h.suggestedGrades.filter((g) => !grades.includes(g)) } });
    }
  }

  /** Locks division writes, runs `write`, then checks the coverage rule for the divisions as they now are. */
  private async checkedWrite<T>(write: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DIVISIONS_LOCK})`;
      const result = await write(tx);
      const problems = coverageProblems(await tx.division.findMany({ select: { code: true, isActive: true, suggestedGrades: true } }));
      if (problems.length) {
        throw new AppError(HttpStatus.CONFLICT, 'GRADES_NOT_COVERED',
          'Every grade S1–S6 must be suggested by exactly one active division.', { problems });
      }
      return result;
    });
  }

  /** Admin: a new division (its code is permanent). */
  async create(dto: CreateDivisionDto, caller: CallerCtx) {
    if (await this.prisma.division.findUnique({ where: { code: dto.code }, select: { id: true } })) {
      throw new AppError(HttpStatus.CONFLICT, 'DIVISION_CODE_TAKEN', 'A division with this code already exists.', { code: dto.code });
    }
    const created = await this.checkedWrite(async (tx) => {
      const d = await tx.division.create({
        data: {
          code: dto.code, name: dto.name, description: dto.description ?? null, isActive: dto.isActive ?? true,
          suggestedGrades: [...new Set(dto.suggestedGrades ?? [])], sortOrder: dto.sortOrder ?? 0,
        },
        select: VIEW,
      });
      if (d.isActive) await this.takeGrades(tx, d.id, d.suggestedGrades);
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'CREATE_DIVISION', entity: 'Division', entityId: d.id,
        metadata: { code: d.code, name: d.name, isActive: d.isActive, suggestedGrades: d.suggestedGrades, sortOrder: d.sortOrder },
      }, tx);
      return d;
    });
    return { ...created, gradeLevels: created.suggestedGrades };
  }

  /** Admin: edit name, description, suggested grades, order, active flag. */
  async update(id: string, dto: UpdateDivisionDto, caller: CallerCtx) {
    const before = await this.requireDivision(id);
    const updated = await this.checkedWrite(async (tx) => {
      if (dto.isActive === false && before.isActive) await this.assertCanDeactivate(tx, before);
      const d = await tx.division.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.suggestedGrades !== undefined && { suggestedGrades: [...new Set(dto.suggestedGrades)] }),
          ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        },
        select: VIEW,
      });
      if (d.isActive && dto.suggestedGrades !== undefined) await this.takeGrades(tx, id, d.suggestedGrades);
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'UPDATE_DIVISION', entity: 'Division', entityId: id,
        metadata: { ...dto, code: before.code, changes: auditChanges(before, d, ['name', 'description', 'isActive', 'suggestedGrades', 'sortOrder']) },
      }, tx);
      return d;
    });
    return { ...updated, gradeLevels: updated.suggestedGrades };
  }

  /** 409 while students are in the division or a test for it is still open. */
  private async assertCanDeactivate(tx: Tx, d: { id: string; code: string }) {
    const [students, openTests] = await Promise.all([
      tx.user.count({ where: { role: 'STUDENT', divisionId: d.id, accountStatus: { not: 'ARCHIVED' } } }),
      tx.test.count({ where: { division: d.code, status: { in: ['DRAFT', 'PUBLISHED'] }, closesAt: { gt: new Date() } } }),
    ]);
    if (students > 0) {
      throw new AppError(HttpStatus.CONFLICT, 'DIVISION_HAS_STUDENTS',
        'Students are in this division: move them to another division first (one by one or in bulk).', { students });
    }
    if (openTests > 0) {
      throw new AppError(HttpStatus.CONFLICT, 'DIVISION_HAS_OPEN_TESTS', 'Tests for this division are still open.', { openTests });
    }
  }
}
