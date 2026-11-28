/**
 * Teacher school assignments (P1-11; owner decision 2026-11-10: school-based
 * teacher scope). Managed by Administrators (users.manageTeachers): a Teacher
 * sees only students whose school is one of their ACTIVE assignments. Ending an
 * assignment applies on the teacher's next request (read fresh each time).
 * Every change is audited in the same transaction.
 *
 * Each link carries `role` (owner decision 2026-11-19): PRIMARY — the school's designated main contact, at most one
 * active per school — or SECONDARY. The same rights either way. Rules: primary-teacher.ts.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { TEACHER_DELEGATIONS } from '../auth/override-policy.js';
import type { CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { isHiddenAccount } from '../common/access/super-admin-privacy.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { lockSchoolsForUse } from '../schools/school-usage.js';
import { CreateTeacherSchoolDto, ListTeacherSchoolsDto } from './dto/teacher.dto.js';
import { lockSchoolPrimary, lockTeacherAccount, roleForNewLink } from './primary-teacher.js';
import { dropStaleSelections } from './teacher-student-ops.js';

const SELECT = {
  id: true, isActive: true, role: true, createdAt: true, endedAt: true,
  teacher:    { select: { id: true, username: true, firstName: true, lastName: true } },
  school:     { select: { id: true, name: true, location: true } },
  assignedBy: { select: { id: true, username: true } },
  endedBy:    { select: { id: true, username: true } },
} as const;

@Injectable()
export class TeacherSchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  async list(q: ListTeacherSchoolsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.TeacherSchoolAssignmentWhereInput = {
      ...(q.teacherId && { teacherId: q.teacherId }),
      ...(q.schoolId && { schoolId: q.schoolId }),
      ...(q.isActive !== undefined && { isActive: q.isActive }),
      ...(q.role && { role: q.role }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teacherSchoolAssignment.findMany({ where, select: SELECT, skip, take, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.teacherSchoolAssignment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * Assign (or re-activate). Only TEACHER accounts; 409 when already active. The link is PRIMARY when the school has
   * no active primary and the account is ACTIVE, else SECONDARY (decided under the school's primary lock).
   */
  async assign(dto: CreateTeacherSchoolDto, actor: CallerCtx) {
    const [teacher, school] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.teacherId }, select: { id: true, role: true } }),
      this.prisma.school.findUnique({ where: { id: dto.schoolId }, select: { id: true } }),
    ]);
    // A Super Administrator does not exist for anyone else (Super Administrator privacy): as for an unknown id.
    if (!teacher || isHiddenAccount(actor, teacher)) throw new NotFoundException('Teacher not found.');
    if (teacher.role !== 'TEACHER') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_TEACHER', 'Only users with the TEACHER role can be assigned to a school.', { role: teacher.role });
    }
    if (!school) throw new NotFoundException('School not found.');

    return this.prisma.$transaction(async (tx) => {
      // A new (or re-activated) assignment needs an ACTIVE school, locked until commit (PR B):
      // a concurrent deactivation waits for it, and one committed first makes this 409 SCHOOL_INACTIVE.
      await lockSchoolsForUse(tx, [dto.schoolId]);
      const existing = await tx.teacherSchoolAssignment.findUnique({
        where: { teacherId_schoolId: { teacherId: dto.teacherId, schoolId: dto.schoolId } }, select: { id: true, isActive: true },
      });
      if (existing?.isActive) throw alreadyAssigned();
      // One primary decision per school at a time (the account row first, then the school's primary lock); the partial
      // unique index is the backstop.
      const accountStatus = await lockTeacherAccount(tx, dto.teacherId);
      await lockSchoolPrimary(tx, [dto.schoolId]);
      const role = await roleForNewLink(tx, dto.schoolId, accountStatus);
      let id: string;
      if (existing) {
        const { count } = await tx.teacherSchoolAssignment.updateMany({
          where: { id: existing.id, isActive: false },
          data:  { isActive: true, endedAt: null, endedById: null, assignedById: actor.id, role },
        });
        if (count === 0) throw alreadyAssigned();
        id = existing.id;
      } else {
        id = (await tx.teacherSchoolAssignment.create({
          data: { teacherId: dto.teacherId, schoolId: dto.schoolId, assignedById: actor.id, role }, select: { id: true },
        }).catch((e: unknown) => { throw (e as { code?: string })?.code === 'P2002' ? alreadyAssigned() : e; })).id;
      }
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'ASSIGN_TEACHER_SCHOOL', entity: 'TeacherSchoolAssignment', entityId: id,
        metadata: { teacherId: dto.teacherId, schoolId: dto.schoolId, reactivated: !!existing, role },
      }, tx);
      return tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
  }

  /**
   * End an assignment (kept as history). Atomic: a second end gets 409. An ended link is SECONDARY: when it was the
   * school's primary, the school has no primary until an Administrator chooses one (nobody is promoted).
   */
  async end(id: string, actor: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.teacherSchoolAssignment.findUnique({ where: { id }, select: { id: true, teacherId: true, schoolId: true } });
      if (!existing) throw new NotFoundException('Teacher school assignment not found.');
      await lockSchoolPrimary(tx, [existing.schoolId]);
      const was = await tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: { role: true } });
      const { count } = await tx.teacherSchoolAssignment.updateMany({
        where: { id, isActive: true }, data: { isActive: false, endedAt: new Date(), endedById: actor.id, role: 'SECONDARY' },
      });
      if (count === 0) throw new AppError(HttpStatus.CONFLICT, 'ASSIGNMENT_ENDED', 'This teacher school assignment has already ended.');
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'UNASSIGN_TEACHER_SCHOOL', entity: 'TeacherSchoolAssignment', entityId: id,
        metadata: { teacherId: existing.teacherId, schoolId: existing.schoolId, wasPrimary: was.role === 'PRIMARY' },
      }, tx);
      // Students of that school the teacher no longer sees leave the teacher's selected-student delegations (TS-5).
      await dropStaleSelections(tx, this.audit, { teacherId: existing.teacherId }, { actorId: actor.id, actorRole: actor.role }, 'SCHOOL_ASSIGNMENT_ENDED');
      return tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
  }

  /**
   * Make this link the school's primary teacher (users.manageTeachers). The previous primary (if any) becomes
   * SECONDARY in the same transaction; one TEACHER_PRIMARY_ASSIGNED audit row. Only an ACTIVE link of an ACTIVE
   * account: 409 ASSIGNMENT_ENDED, TEACHER_ACCOUNT_NOT_ACTIVE, ALREADY_PRIMARY. No permission changes.
   */
  async makePrimary(id: string, actor: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const link = await tx.teacherSchoolAssignment.findUnique({ where: { id }, select: { id: true, schoolId: true, teacherId: true } });
      if (!link) throw new NotFoundException('Teacher school assignment not found.');
      // The account row first, then the school's primary lock (the same order as an account-state change).
      const accountStatus = await lockTeacherAccount(tx, link.teacherId);
      await lockSchoolPrimary(tx, [link.schoolId]);
      const current = await tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: { isActive: true, role: true, teacherId: true } });
      if (!current.isActive) throw new AppError(HttpStatus.CONFLICT, 'ASSIGNMENT_ENDED', 'This teacher school assignment has ended.');
      if (accountStatus !== 'ACTIVE') {
        throw new AppError(HttpStatus.CONFLICT, 'TEACHER_ACCOUNT_NOT_ACTIVE', 'Only a teacher with an active account can be the primary teacher.',
          { accountStatus });
      }
      if (current.role === 'PRIMARY') throw new AppError(HttpStatus.CONFLICT, 'ALREADY_PRIMARY', 'This teacher is already the primary teacher of this school.');
      const previous = await tx.teacherSchoolAssignment.findFirst({
        where: { schoolId: link.schoolId, isActive: true, role: 'PRIMARY' }, select: { id: true, teacherId: true },
      });
      if (previous) await tx.teacherSchoolAssignment.update({ where: { id: previous.id }, data: { role: 'SECONDARY' } });
      await tx.teacherSchoolAssignment.update({ where: { id }, data: { role: 'PRIMARY' } });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'TEACHER_PRIMARY_ASSIGNED', entity: 'TeacherSchoolAssignment', entityId: id,
        metadata: {
          schoolId: link.schoolId, teacherId: current.teacherId,
          previousAssignmentId: previous?.id ?? null, previousTeacherId: previous?.teacherId ?? null,
        },
      }, tx);
      return tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
  }
}

const alreadyAssigned = () => new AppError(HttpStatus.CONFLICT, 'ALREADY_ASSIGNED', 'This teacher is already assigned to this school.');

/**
 * Revokes every unrevoked teacher delegation (students.viewProfile, students.viewProgress,
 * submissions.submitOnBehalf) of a user whose role changes — inside the role-change
 * transaction, one PERMISSION_OVERRIDE_REVOKE audit row each (reason ROLE_CHANGE).
 * Expired grants are revoked too, so none can apply again later.
 */
export async function revokeTeacherDelegations(
  tx: Prisma.TransactionClient, audit: AuditService, userId: string,
  actor: { actorId: string; actorRole: string }, context: { from: string; to: string },
) {
  const open = await tx.userPermissionOverride.findMany({
    where: { userId, revokedAt: null, effect: 'GRANT', permission: { in: [...TEACHER_DELEGATIONS] } }, select: { id: true, permission: true },
  });
  if (open.length === 0) return;
  await tx.userPermissionOverride.updateMany({
    where: { id: { in: open.map((o) => o.id) }, revokedAt: null },
    data:  { revokedAt: new Date(), revokedById: actor.actorId, revokeReason: 'ROLE_CHANGE' },
  });
  for (const o of open) {
    await audit.log({
      ...actor, action: 'PERMISSION_OVERRIDE_REVOKE', entity: 'UserPermissionOverride', entityId: o.id,
      metadata: { targetUserId: userId, permission: o.permission, effect: 'GRANT', reason: 'ROLE_CHANGE', from: context.from, to: context.to, previous: { active: true }, next: { active: false } },
    }, tx);
  }
}

/**
 * Ends every active school assignment of a user who is no longer a Teacher —
 * called inside the role-change transaction (same pattern as coach assignments).
 * Ended links are SECONDARY: a school whose primary this was has none (nobody is promoted).
 */
export async function endTeacherSchools(
  tx: Prisma.TransactionClient, audit: AuditService, teacherId: string,
  actor: { actorId: string; actorRole: string }, context: { from: string; to: string },
) {
  const active = await tx.teacherSchoolAssignment.findMany({ where: { teacherId, isActive: true }, select: { id: true, schoolId: true, role: true } });
  if (active.length === 0) return;
  await tx.teacherSchoolAssignment.updateMany({
    where: { id: { in: active.map((a) => a.id) } }, data: { isActive: false, endedAt: new Date(), endedById: actor.actorId, role: 'SECONDARY' },
  });
  for (const a of active) {
    await audit.log({
      ...actor, action: 'UNASSIGN_TEACHER_SCHOOL', entity: 'TeacherSchoolAssignment', entityId: a.id,
      metadata: { reason: 'ROLE_CHANGE', from: context.from, to: context.to, teacherId, schoolId: a.schoolId, wasPrimary: a.role === 'PRIMARY' },
    }, tx);
  }
}
