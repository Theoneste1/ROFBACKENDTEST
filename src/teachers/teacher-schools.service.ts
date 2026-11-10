/**
 * Teacher school assignments (P1-11; owner decision 2026-11-10: school-based
 * teacher scope). Managed by Administrators (users.manageTeachers): a Teacher
 * sees only students whose school is one of their ACTIVE assignments. Ending an
 * assignment applies on the teacher's next request (read fresh each time).
 * Every change is audited in the same transaction.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateTeacherSchoolDto, ListTeacherSchoolsDto } from './dto/teacher.dto.js';

const SELECT = {
  id: true, isActive: true, createdAt: true, endedAt: true,
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
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teacherSchoolAssignment.findMany({ where, select: SELECT, skip, take, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.teacherSchoolAssignment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Assign (or re-activate). Only TEACHER accounts; 409 when already active. */
  async assign(dto: CreateTeacherSchoolDto, actor: CallerCtx) {
    const [teacher, school] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.teacherId }, select: { id: true, role: true } }),
      this.prisma.school.findUnique({ where: { id: dto.schoolId }, select: { id: true } }),
    ]);
    if (!teacher) throw new NotFoundException('Teacher not found.');
    if (teacher.role !== 'TEACHER') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_TEACHER', 'Only users with the TEACHER role can be assigned to a school.', { role: teacher.role });
    }
    if (!school) throw new NotFoundException('School not found.');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.teacherSchoolAssignment.findUnique({
        where: { teacherId_schoolId: { teacherId: dto.teacherId, schoolId: dto.schoolId } }, select: { id: true, isActive: true },
      });
      if (existing?.isActive) throw alreadyAssigned();
      let id: string;
      if (existing) {
        const { count } = await tx.teacherSchoolAssignment.updateMany({
          where: { id: existing.id, isActive: false },
          data:  { isActive: true, endedAt: null, endedById: null, assignedById: actor.id },
        });
        if (count === 0) throw alreadyAssigned();
        id = existing.id;
      } else {
        id = (await tx.teacherSchoolAssignment.create({
          data: { teacherId: dto.teacherId, schoolId: dto.schoolId, assignedById: actor.id }, select: { id: true },
        }).catch((e: unknown) => { throw (e as { code?: string })?.code === 'P2002' ? alreadyAssigned() : e; })).id;
      }
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'ASSIGN_TEACHER_SCHOOL', entity: 'TeacherSchoolAssignment', entityId: id,
        metadata: { teacherId: dto.teacherId, schoolId: dto.schoolId, reactivated: !!existing },
      }, tx);
      return tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
  }

  /** End an assignment (kept as history). Atomic: a second end gets 409. */
  async end(id: string, actor: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.teacherSchoolAssignment.findUnique({ where: { id }, select: { id: true, teacherId: true, schoolId: true } });
      if (!existing) throw new NotFoundException('Teacher school assignment not found.');
      const { count } = await tx.teacherSchoolAssignment.updateMany({
        where: { id, isActive: true }, data: { isActive: false, endedAt: new Date(), endedById: actor.id },
      });
      if (count === 0) throw new AppError(HttpStatus.CONFLICT, 'ASSIGNMENT_ENDED', 'This teacher school assignment has already ended.');
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'UNASSIGN_TEACHER_SCHOOL', entity: 'TeacherSchoolAssignment', entityId: id,
        metadata: { teacherId: existing.teacherId, schoolId: existing.schoolId },
      }, tx);
      return tx.teacherSchoolAssignment.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
  }
}

const alreadyAssigned = () => new AppError(HttpStatus.CONFLICT, 'ALREADY_ASSIGNED', 'This teacher is already assigned to this school.');

/**
 * Ends every active school assignment of a user who is no longer a Teacher —
 * called inside the role-change transaction (same pattern as coach assignments).
 */
export async function endTeacherSchools(
  tx: Prisma.TransactionClient, audit: AuditService, teacherId: string,
  actor: { actorId: string; actorRole: string }, context: { from: string; to: string },
) {
  const active = await tx.teacherSchoolAssignment.findMany({ where: { teacherId, isActive: true }, select: { id: true, schoolId: true } });
  if (active.length === 0) return;
  await tx.teacherSchoolAssignment.updateMany({
    where: { id: { in: active.map((a) => a.id) } }, data: { isActive: false, endedAt: new Date(), endedById: actor.actorId },
  });
  for (const a of active) {
    await audit.log({
      ...actor, action: 'UNASSIGN_TEACHER_SCHOOL', entity: 'TeacherSchoolAssignment', entityId: a.id,
      metadata: { reason: 'ROLE_CHANGE', from: context.from, to: context.to, teacherId, schoolId: a.schoolId },
    }, tx);
  }
}
