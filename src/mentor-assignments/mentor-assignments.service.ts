import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CreateMentorAssignmentDto, ListMentorAssignmentsDto } from './dto/mentor-assignment.dto.js';

const SELECT = {
  id: true, isActive: true, createdAt: true, updatedAt: true,
  mentor:     { select: { id: true, firstName: true, lastName: true, username: true, email: true } },
  course:     { select: { id: true, code: true, title: true } },
  division:   { select: { id: true, code: true, name: true } },
  assignedBy: { select: { id: true, username: true } },
} as const;

@Injectable()
export class MentorAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  async findAll(q: ListMentorAssignmentsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.MentorAssignmentWhereInput = {
      ...(q.mentorId   && { mentorId: q.mentorId }),
      ...(q.courseId   && { courseId: q.courseId }),
      ...(q.divisionId && { divisionId: q.divisionId }),
      ...(q.isActive !== undefined && { isActive: q.isActive }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mentorAssignment.findMany({
        where, select: SELECT, skip, take,
        orderBy: [{ course: { sortOrder: 'asc' } }, { createdAt: 'asc' }],
      }),
      this.prisma.mentorAssignment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Assign (or re-activate) a mentor for a course × division. Idempotent. */
  async assign(dto: CreateMentorAssignmentDto, caller: CallerCtx) {
    const [mentor, course, division] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.mentorId }, select: { role: true, isActive: true } }),
      this.prisma.course.findUnique({ where: { id: dto.courseId }, select: { id: true } }),
      this.prisma.division.findUnique({ where: { id: dto.divisionId }, select: { id: true } }),
    ]);
    if (!mentor) throw new NotFoundException('Coach not found.');
    if (mentor.role !== 'MENTOR') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_MENTOR', 'Only users with the MENTOR role can be assigned.');
    }
    if (!mentor.isActive) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'ACCOUNT_SUSPENDED', 'This coach account is suspended.');
    }
    if (!course)   throw new NotFoundException('Course not found.');
    if (!division) throw new NotFoundException('Division not found.');

    const assignment = await this.prisma.mentorAssignment.upsert({
      where: {
        mentorId_courseId_divisionId: {
          mentorId: dto.mentorId, courseId: dto.courseId, divisionId: dto.divisionId,
        },
      },
      create: { ...dto, assignedById: caller.id },
      update: { isActive: true, assignedById: caller.id },
      select: SELECT,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'ASSIGN_MENTOR', entity: 'MentorAssignment', entityId: assignment.id, metadata: { ...dto },
    });
    return assignment;
  }

  /**
   * Deactivate an assignment. Submissions already distributed to the mentor
   * stay with them until an admin reassigns them.
   */
  async unassign(id: string, caller: CallerCtx) {
    const existing = await this.prisma.mentorAssignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Coach course access not found.');

    const updated = await this.prisma.mentorAssignment.update({
      where: { id }, data: { isActive: false }, select: SELECT,
    });

    // The mentor's still-open review cycles in this scope (current cycles only).
    const openReviews = await this.prisma.mentorReview.count({
      where: {
        mentorId:   existing.mentorId,
        status:     { in: OPEN_REVIEW_STATUSES },
        currentFor: { isNot: null },
        submission: { assignment: { courseId: existing.courseId, divisionId: existing.divisionId } },
      },
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UNASSIGN_MENTOR', entity: 'MentorAssignment', entityId: id,
      metadata: { openReviewsToReassign: openReviews },
    });
    return { ...updated, openReviewsToReassign: openReviews };
  }

  /** The current mentor's teaching scopes. */
  async findMine(mentorId: string) {
    return this.prisma.mentorAssignment.findMany({
      where:   { mentorId, isActive: true },
      select:  { id: true, course: SELECT.course, division: SELECT.division, createdAt: true },
      orderBy: { course: { sortOrder: 'asc' } },
    });
  }
}
