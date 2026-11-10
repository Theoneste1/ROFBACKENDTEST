import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService, scopeForbidden } from '../common/access/access.service.js';
import { isAdmin, isHeadCoach, unsupportedRole } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
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
    private readonly access: AccessService,
  ) {}

  /**
   * Where a caller may see and change coach assignments: administrators
   * everywhere (no restriction); a Head Coach only Coaches' (MENTOR) assignments
   * on courses of programmes they head (none → matches nothing).
   */
  private async callerFilter(user: AuthUser): Promise<Prisma.MentorAssignmentWhereInput> {
    if (isAdmin(user)) return {};
    if (isHeadCoach(user)) {
      const programmes = await this.access.headedProgrammes(user);
      return { course: this.access.programmeCoursesFilter(programmes), mentor: { role: 'MENTOR' } };
    }
    throw unsupportedRole();
  }

  async findAll(q: ListMentorAssignmentsDto, user: AuthUser) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.MentorAssignmentWhereInput = {
      AND: [await this.callerFilter(user)],
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
  async assign(dto: CreateMentorAssignmentDto, caller: AuthUser) {
    const [mentor, course, division] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: dto.mentorId }, select: { id: true, role: true, isActive: true } }),
      this.prisma.course.findUnique({ where: { id: dto.courseId }, select: { id: true, disciplineId: true } }),
      this.prisma.division.findUnique({ where: { id: dto.divisionId }, select: { id: true } }),
    ]);
    if (isHeadCoach(caller)) await this.assertHeadCoachMayAssign(caller, mentor, course);
    else if (!isAdmin(caller)) throw unsupportedRole();
    if (!mentor) throw new NotFoundException('Coach not found.');
    if (mentor.role !== 'MENTOR') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_MENTOR', 'Only users with the MENTOR role can be assigned.');
    }
    if (!mentor.isActive) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'ACCOUNT_SUSPENDED', 'This coach account is suspended.');
    }
    if (!course)   throw new NotFoundException('Course not found.');
    if (!division) throw new NotFoundException('Division not found.');

    // The change and its audit record commit together: if the audit write fails, nothing changes.
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.mentorAssignment.upsert({
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
      }, tx);
      return assignment;
    });
  }

  /**
   * Deactivate an assignment. Submissions already distributed to the mentor
   * stay with them until an admin reassigns them.
   */
  async unassign(id: string, caller: AuthUser) {
    const scope = await this.callerFilter(caller);
    // Read, change, open-review count and audit record in one transaction:
    // if the audit write fails, the assignment stays active.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.mentorAssignment.findFirst({ where: { AND: [{ id }, scope] } });
      if (!existing) throw new NotFoundException('Coach course access not found.');

      const updated = await tx.mentorAssignment.update({
        where: { id }, data: { isActive: false }, select: SELECT,
      });

      // The mentor's still-open review cycles in this scope (current cycles only).
      const openReviews = await tx.mentorReview.count({
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
      }, tx);
      return { ...updated, openReviewsToReassign: openReviews };
    });
  }

  /**
   * Head Coach rules (plan §7.2, §11.2; H3, H4). Course outside the programmes
   * they head → 404. Assignee themselves, another Head Coach, an Administrator
   * or a Super Admin → 403 SCOPE_FORBIDDEN (an Administrator action). A Coach
   * who is not a member of the course's programme → 404 (not visible to them).
   */
  private async assertHeadCoachMayAssign(
    caller: AuthUser,
    mentor: { id: string; role: string } | null,
    course: { id: string; disciplineId: string } | null,
  ) {
    const programmes = await this.access.headedProgrammes(caller);
    if (!course || !programmes.includes(course.disciplineId)) throw new NotFoundException('Course not found.');
    if (mentor && (mentor.id === caller.id || ['HEAD_COACH', 'ADMIN', 'SUPER_ADMIN'].includes(mentor.role))) {
      throw scopeForbidden('Head Coaches assign Coaches only — never themselves, another Head Coach or an Administrator.', { role: mentor.role });
    }
    if (!mentor || mentor.role !== 'MENTOR' || !(await this.access.isProgrammeMember(mentor.id, course.disciplineId))) {
      throw new NotFoundException('Coach not found.');
    }
  }

  /** The current mentor's teaching scopes. */
  async findMine(mentorId: string) {
    return this.prisma.mentorAssignment.findMany({
      where:   { mentorId, isActive: true, mentor: { role: 'MENTOR' } },
      select:  { id: true, course: SELECT.course, division: SELECT.division, createdAt: true },
      orderBy: { course: { sortOrder: 'asc' } },
    });
  }
}
