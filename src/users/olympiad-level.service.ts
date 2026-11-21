/**
 * A student's Olympiad level = their DIVISION (owner 2026-11-21/22: Junior, Middle, Senior or one an Administrator
 * created), kept separate from the school grade. Courses, test eligibility, the teachers' lists and the rankings use it.
 *
 *  - It follows the grade (the active division whose suggested grades hold it: database trigger
 *    student_division_from_grade, on every write path) unless it was set by hand (`divisionManual`).
 *  - Set by hand (MANUAL, with a reason) or returned to the grade's suggestion (AUTOMATIC, with a reason) here, by a
 *    holder of students.classifyLevel: User Managers (Administrators) for every student; Coaches and Head Coaches for
 *    the students of the programmes they belong to / head. Anyone else, or a student outside the caller's programmes:
 *    404 (not revealed). Only an ACTIVE division may be chosen.
 *  - The student's row is locked; the account and its active enrolment change together; every change is kept
 *    (DivisionChange: who, when, why, from and to, the grade then) and audited (OLYMPIAD_LEVEL_CHANGED).
 *  - Results already submitted keep the division they were made in (TestSubmission.level).
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { isAdmin, isCourseWorker, unsupportedRole } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SetOlympiadLevelDto } from './dto/olympiad-level.dto.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
const DIVISION = { select: { id: true, code: true, name: true } } as const;

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'STUDENT_NOT_FOUND', 'Student not found.');

export interface LevelChangeOutcome { changed: boolean; code?: 'ALREADY_SET' }

@Injectable()
export class OlympiadLevelService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * The programmes whose students the caller may classify: 'all' for User Managers; a Coach's or Head Coach's ACTIVE
   * programme memberships (read fresh on every call). Any other role is refused.
   */
  private async scopeOf(db: Db, actor: AuthUser): Promise<'all' | string[]> {
    if (isAdmin(actor)) return 'all';
    if (isCourseWorker(actor)) {
      const rows = await db.programmeMembership.findMany({ where: { userId: actor.id, isActive: true }, select: { disciplineId: true } });
      return rows.map((r) => r.disciplineId);
    }
    throw unsupportedRole();
  }

  /** The student, if the caller may classify them; otherwise 404 (a student outside the caller's programmes is not revealed). */
  private async requireStudent(db: Db, studentId: string, actor: AuthUser) {
    const scope = await this.scopeOf(db, actor);
    const s = await db.user.findFirst({
      where: {
        id: studentId, role: 'STUDENT',
        ...(scope !== 'all' && { programmeMemberships: { some: { isActive: true, disciplineId: { in: scope } } } }),
      },
      select: { id: true, gradeLevel: true, divisionId: true, divisionManual: true, division: DIVISION },
    });
    if (!s) throw notFound();
    return s;
  }

  /** The active division the grade suggests (null: none — the divisions service keeps every grade covered). */
  private async suggestedFor(db: Db, grade: string | null) {
    if (!grade) return null;
    const [row] = await db.$queryRaw<Array<{ id: string | null }>>`SELECT division_for_grade(${grade}::text) AS id`;
    return row?.id ? db.division.findUnique({ where: { id: row.id }, ...DIVISION }) : null;
  }

  /** The division (level), whether it was set by hand, the one the grade suggests, the choices, and the history (newest first). */
  async view(studentId: string, actor: AuthUser) {
    const s = await this.requireStudent(this.prisma, studentId, actor);
    const [suggested, choices, history] = await Promise.all([
      this.suggestedFor(this.prisma, s.gradeLevel),
      this.prisma.division.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], ...DIVISION }),
      this.prisma.divisionChange.findMany({
        where: { studentId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
        select: {
          id: true, gradeLevel: true, source: true, reason: true, createdAt: true,
          fromDivision: DIVISION, toDivision: DIVISION, changedBy: PERSON,
        },
      }),
    ]);
    return {
      studentId: s.id, gradeLevel: s.gradeLevel, level: s.division, manual: s.divisionManual,
      suggestedLevel: suggested, choices, history,
    };
  }

  /** PUT …/olympiad-level: set it by hand, or return it to the grade's suggestion. Returns the new view. */
  async set(studentId: string, dto: SetOlympiadLevelDto, actor: AuthUser) {
    await this.prisma.$transaction((tx) => this.setInTx(tx, studentId, dto, actor));
    return this.view(studentId, actor);
  }

  /**
   * One change, in the caller's transaction (the route, or one bulk item). The student's row is locked first. Nothing
   * to do (the same division, set the same way) → { changed: false, code: 'ALREADY_SET' }, nothing written.
   * `dto.divisionId` (or, from bulk, `divisionCode`) chooses the division; `automatic` follows the grade again.
   */
  async setInTx(tx: Tx, studentId: string, dto: SetOlympiadLevelDto & { divisionCode?: string }, actor: AuthUser,
    extra: { operationId?: string } = {}): Promise<LevelChangeOutcome> {
    const automatic = dto.automatic === true;
    if (automatic && (dto.divisionId !== undefined || dto.divisionCode !== undefined)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'LEVEL_WITH_AUTOMATIC', 'Give either a division or automatic: true, not both.');
    }
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${studentId} FOR UPDATE`;
    const s = await this.requireStudent(tx, studentId, actor);
    let to: { id: string; code: string; name: string };
    if (automatic) {
      const suggested = await this.suggestedFor(tx, s.gradeLevel);
      if (!suggested) {
        throw new AppError(HttpStatus.CONFLICT, 'NO_SUGGESTED_LEVEL', 'No active division is suggested for this student\'s grade: choose the division.');
      }
      to = suggested;
    } else {
      const d = await tx.division.findUnique({
        where: dto.divisionId ? { id: dto.divisionId } : { code: dto.divisionCode ?? '' },
        select: { id: true, code: true, name: true, isActive: true },
      });
      if (!d || !d.isActive) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_DIVISION', 'Choose an active division.');
      to = d;
    }
    if (s.divisionId === to.id && s.divisionManual === !automatic) return { changed: false, code: 'ALREADY_SET' };
    const reason = dto.reason.trim();
    // This transaction records the change itself: the history trigger stays silent, and a division set by hand may change.
    await tx.$executeRaw`SELECT set_config('rof.division_change', 'recorded', true)`;
    await tx.user.update({ where: { id: studentId }, data: { divisionId: to.id, divisionManual: !automatic } });
    // The active enrolment mirrors the account (academic years): it moves with it.
    await tx.studentEnrollment.updateMany({ where: { studentId, status: 'ACTIVE' }, data: { divisionId: to.id } });
    await tx.divisionChange.create({ data: {
      studentId, fromDivisionId: s.divisionId, toDivisionId: to.id, gradeLevel: s.gradeLevel,
      source: automatic ? 'AUTOMATIC' : 'MANUAL', reason, changedById: actor.id,
    } });
    await this.audit.log({
      actorId: actor.id, actorRole: actor.role, action: 'OLYMPIAD_LEVEL_CHANGED', entity: 'User', entityId: studentId,
      metadata: {
        from: s.division?.code ?? null, to: to.code, manual: !automatic, gradeLevel: s.gradeLevel, reason,
        ...(extra.operationId && { operationId: extra.operationId }),
      },
    }, tx);
    await tx.$executeRaw`SELECT set_config('rof.division_change', '', true)`;
    return { changed: true };
  }
}
