/**
 * Olympiad levels (owner 2026-11-21): a student's Olympiad level — JUNIOR, MIDDLE or SENIOR — kept separate from the
 * school grade. Test eligibility, the teachers' lists and the rankings use the level, never the grade.
 *
 *  - Suggested from the grade (S1–S2 Junior, S3–S4 Middle, S5–S6 Senior) by the database trigger
 *    `olympiad_level_from_grade` whenever a student is created or their grade changes — every write path (sign-up, an
 *    Administrator, bulk, a new academic year) — unless the level was set by hand (olympiadLevelManual).
 *  - Set by hand (MANUAL, with a reason) or returned to the grade's suggestion (AUTOMATIC, with a reason) here, by a
 *    holder of students.classifyLevel: User Managers (Administrators) for every student; Coaches and Head Coaches for
 *    the students of the programmes they belong to / head. Anyone else, or a student outside the caller's programmes:
 *    404 (not revealed).
 *  - Every change is kept (OlympiadLevelChange: who, when, why, from what, the grade then) and audited
 *    (OLYMPIAD_LEVEL_CHANGED). The student's row is locked for the change, so two classifiers never interleave.
 *  - Existing submissions keep the level they were made at (TestSubmission.level): a change never moves a result.
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { isAdmin, isCourseWorker, unsupportedRole } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import type { OlympiadLevel, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { suggestedLevel } from '../test-management/submission-rules.js';
import type { SetOlympiadLevelDto } from './dto/olympiad-level.dto.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;

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
      select: { id: true, gradeLevel: true, olympiadLevel: true, olympiadLevelManual: true },
    });
    if (!s) throw notFound();
    return s;
  }

  /** The level, whether it was set by hand, what the grade suggests, and every change (newest first). */
  async view(studentId: string, actor: AuthUser) {
    const s = await this.requireStudent(this.prisma, studentId, actor);
    const history = await this.prisma.olympiadLevelChange.findMany({
      where: { studentId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
      select: { id: true, fromLevel: true, toLevel: true, gradeLevel: true, source: true, reason: true, createdAt: true, changedBy: PERSON },
    });
    return {
      studentId: s.id, gradeLevel: s.gradeLevel, level: s.olympiadLevel, manual: s.olympiadLevelManual,
      suggestedLevel: suggestedLevel(s.gradeLevel), history,
    };
  }

  /** PUT …/olympiad-level: set it by hand, or return it to the grade's suggestion. Returns the new view. */
  async set(studentId: string, dto: SetOlympiadLevelDto, actor: AuthUser) {
    await this.prisma.$transaction((tx) => this.setInTx(tx, studentId, dto, actor));
    return this.view(studentId, actor);
  }

  /**
   * One change, in the caller's transaction (the route, or one bulk item). The student's row is locked first. Nothing
   * to do (the same level, set the same way) → { changed: false, code: 'ALREADY_SET' }, nothing written.
   */
  async setInTx(tx: Tx, studentId: string, dto: SetOlympiadLevelDto, actor: AuthUser, extra: { operationId?: string } = {}): Promise<LevelChangeOutcome> {
    if (dto.automatic === true && dto.level !== undefined) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'LEVEL_WITH_AUTOMATIC', 'Give either a level or automatic: true, not both.');
    }
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${studentId} FOR UPDATE`;
    const s = await this.requireStudent(tx, studentId, actor);
    const automatic = dto.automatic === true;
    let to: OlympiadLevel;
    if (automatic) {
      const suggested = suggestedLevel(s.gradeLevel);
      if (!suggested) {
        throw new AppError(HttpStatus.CONFLICT, 'NO_SUGGESTED_LEVEL', 'This student has no school grade, so there is no suggested level: choose the level.');
      }
      to = suggested;
    } else {
      to = dto.level!;
    }
    if (s.olympiadLevel === to && s.olympiadLevelManual === !automatic) return { changed: false, code: 'ALREADY_SET' };
    const reason = dto.reason.trim();
    await tx.user.update({ where: { id: studentId }, data: { olympiadLevel: to, olympiadLevelManual: !automatic } });
    await tx.olympiadLevelChange.create({ data: {
      studentId, fromLevel: s.olympiadLevel, toLevel: to, gradeLevel: s.gradeLevel,
      source: automatic ? 'AUTOMATIC' : 'MANUAL', reason, changedById: actor.id,
    } });
    await this.audit.log({
      actorId: actor.id, actorRole: actor.role, action: 'OLYMPIAD_LEVEL_CHANGED', entity: 'User', entityId: studentId,
      metadata: {
        from: s.olympiadLevel, to, manual: !automatic, gradeLevel: s.gradeLevel, reason,
        ...(extra.operationId && { operationId: extra.operationId }),
      },
    }, tx);
    return { changed: true };
  }
}
