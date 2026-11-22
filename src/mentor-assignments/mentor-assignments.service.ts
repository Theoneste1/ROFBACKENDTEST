import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService, scopeForbidden } from '../common/access/access.service.js';
import { COURSE_WORK_ROLES, isAdmin, isHeadCoach, unsupportedRole } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import { OPEN_REVIEW_STATUSES } from '../submissions/submissions.constants.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { BulkMentorAssignmentDto, CreateMentorAssignmentDto, ListMentorAssignmentsDto } from './dto/mentor-assignment.dto.js';

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
    return paginated(rows.map((r) => withoutContact(r, user)), total, page, limit);
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
    if (mentor.role === 'HEAD_COACH' && isAdmin(caller)) {
      // H4: an Administrator (only) gives a Head Coach a course × division to teach and
      // grade — on a course of a programme they head (HC-A). Head Coaches never reach
      // here for a Head Coach target (403 above).
      if (course) await this.assertHeadsCourseProgramme(mentor, course);
    } else if (mentor.role !== 'MENTOR') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_MENTOR', 'Only Coaches, or Head Coaches (by an Administrator), can be assigned.');
    }
    if (!mentor.isActive) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'ACCOUNT_SUSPENDED', 'This coach account is suspended.');
    }
    if (!course)   throw new NotFoundException('Course not found.');
    if (!division) throw new NotFoundException('Division not found.');
    // Only a course the division offers (administrator-managed divisions, 2026-11-22).
    if (!(await this.prisma.courseDivision.count({ where: { courseId: dto.courseId, divisionId: dto.divisionId, isActive: true } }))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'COURSE_NOT_OFFERED', 'This division does not offer this course.');
    }

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
      return withoutContact(assignment, caller);
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
      return { ...withoutContact(updated, caller), openReviewsToReassign: openReviews };
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

  /** H4: a Head Coach is assigned (by an Administrator) only to courses of a programme they head. */
  private async assertHeadsCourseProgramme(headCoach: { id: string; role: string }, course: { disciplineId: string }) {
    if (!(await this.access.headedProgrammes(headCoach as AuthUser)).includes(course.disciplineId)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_PROGRAMME_HEAD', 'A Head Coach can only be assigned to courses of a programme they head.');
    }
  }

  /**
   * Bulk (owner 2026-11-22): a coach on many course x division pairs at once: ALL offered pairs, every course one
   * division offers, or chosen pairs. The pairs are the ACTIVE offerings (courses not archived, active divisions); a
   * Head Coach only gets the courses of programmes they head, for a Coach of those programmes (the same rules as one
   * assignment); an Administrator gives a Head Coach only courses of programmes that Head Coach heads (H4). Each pair is
   * NEW, REACTIVATE (an ended assignment) or ALREADY_ASSIGNED (nothing to do: never a duplicate). `dryRun` previews.
   * Applied in one transaction, one ASSIGN_MENTOR audit row per change (as the single route).
   */
  async bulkAssign(dto: BulkMentorAssignmentDto, caller: AuthUser) {
    if (!isAdmin(caller) && !isHeadCoach(caller)) throw unsupportedRole();
    const mentor = await this.prisma.user.findUnique({ where: { id: dto.mentorId }, select: { id: true, role: true, isActive: true, firstName: true, lastName: true } });
    if (!mentor) throw new NotFoundException('Coach not found.');
    if (isAdmin(caller) && mentor.role !== 'MENTOR' && mentor.role !== 'HEAD_COACH') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_MENTOR', 'Only Coaches, or Head Coaches (by an Administrator), can be assigned.');
    }
    if (!mentor.isActive) throw new AppError(HttpStatus.BAD_REQUEST, 'ACCOUNT_SUSPENDED', 'This coach account is suspended.');
    if (isHeadCoach(caller) && (mentor.id === caller.id || mentor.role !== 'MENTOR')) {
      throw scopeForbidden('Head Coaches assign Coaches only — never themselves, another Head Coach or an Administrator.', { role: mentor.role });
    }
    const allowedProgrammes = await this.bulkProgrammeScope(caller, mentor);

    if (dto.scope === 'DIVISION' && !(await this.prisma.division.findFirst({ where: { id: dto.divisionId, isActive: true }, select: { id: true } }))) {
      throw new NotFoundException('Division not found.');
    }
    const offerings = await this.prisma.courseDivision.findMany({
      where: {
        isActive: true, division: { isActive: true },
        course: { status: { not: 'ARCHIVED' }, ...(allowedProgrammes && { disciplineId: { in: allowedProgrammes } }) },
        ...(dto.scope === 'DIVISION' && { divisionId: dto.divisionId }),
        ...(dto.scope === 'PAIRS' && { OR: dto.pairs!.map((pr) => ({ courseId: pr.courseId, divisionId: pr.divisionId })) }),
      },
      select: { courseId: true, divisionId: true, course: { select: { id: true, code: true, title: true } }, division: { select: { id: true, code: true, name: true } } },
      orderBy: [{ division: { sortOrder: 'asc' } }, { course: { sortOrder: 'asc' } }],
    });
    // Chosen pairs not (or no longer) offered, or outside the caller's programmes: reported, never assigned.
    const notOffered = dto.scope === 'PAIRS'
      ? dto.pairs!.filter((pr) => !offerings.some((o) => o.courseId === pr.courseId && o.divisionId === pr.divisionId))
      : [];
    const existing = offerings.length ? await this.prisma.mentorAssignment.findMany({
      where: { mentorId: mentor.id, OR: offerings.map((o) => ({ courseId: o.courseId, divisionId: o.divisionId })) },
      select: { courseId: true, divisionId: true, isActive: true },
    }) : [];
    const stateOf = (o: { courseId: string; divisionId: string }) => {
      const e = existing.find((x) => x.courseId === o.courseId && x.divisionId === o.divisionId);
      return !e ? 'NEW' as const : e.isActive ? 'ALREADY_ASSIGNED' as const : 'REACTIVATE' as const;
    };
    const pairs = offerings.map((o) => ({ course: o.course, division: o.division, state: stateOf(o) }));
    const counts = {
      total: pairs.length, new: pairs.filter((x) => x.state === 'NEW').length, reactivate: pairs.filter((x) => x.state === 'REACTIVATE').length,
      alreadyAssigned: pairs.filter((x) => x.state === 'ALREADY_ASSIGNED').length, notOffered: notOffered.length,
    };
    const result = { mentor: { id: mentor.id, firstName: mentor.firstName, lastName: mentor.lastName }, scope: dto.scope, pairs, notOffered, counts };
    if (dto.dryRun) return { ...result, applied: false };

    await this.prisma.$transaction(async (tx) => {
      for (const x of pairs.filter((y) => y.state !== 'ALREADY_ASSIGNED')) {
        const a = await tx.mentorAssignment.upsert({
          where: { mentorId_courseId_divisionId: { mentorId: mentor.id, courseId: x.course.id, divisionId: x.division.id } },
          create: { mentorId: mentor.id, courseId: x.course.id, divisionId: x.division.id, assignedById: caller.id },
          update: { isActive: true, assignedById: caller.id },
          select: { id: true },
        });
        await this.audit.log({
          actorId: caller.id, actorRole: caller.role, action: 'ASSIGN_MENTOR', entity: 'MentorAssignment', entityId: a.id,
          metadata: { mentorId: mentor.id, courseId: x.course.id, divisionId: x.division.id, bulk: dto.scope },
        }, tx);
      }
    });
    return { ...result, applied: true };
  }

  /**
   * The programmes whose courses a bulk assignment may cover (null: every programme). An Administrator: every programme,
   * except for a Head Coach target, who gets only the programmes they head (H4). A Head Coach: the programmes they head
   * that the Coach belongs to. Any other role is refused.
   */
  private async bulkProgrammeScope(caller: AuthUser, mentor: { id: string; role: string }): Promise<string[] | null> {
    if (isAdmin(caller)) {
      return mentor.role === 'HEAD_COACH' ? this.access.headedProgrammes(mentor as unknown as AuthUser) : null;
    }
    if (isHeadCoach(caller)) {
      const [headed, coach] = await Promise.all([this.access.headedProgrammes(caller), this.access.programmesOf(mentor.id)]);
      return headed.filter((pr) => coach.includes(pr));
    }
    throw unsupportedRole();
  }

  /** The caller's own teaching scopes (a coach, or a Head Coach with Administrator-created assignments). */
  async findMine(mentorId: string) {
    return this.prisma.mentorAssignment.findMany({
      where:   { mentorId, isActive: true, mentor: { role: { in: [...COURSE_WORK_ROLES] } } },
      select:  { id: true, course: SELECT.course, division: SELECT.division, createdAt: true },
      orderBy: { course: { sortOrder: 'asc' } },
    });
  }
}

/**
 * Head Coaches see coaches without contact details (D7): the coach's e-mail is only for
 * administrators. Everything else in the row is unchanged.
 */
export function withoutContact<T extends { mentor: { email?: string } }>(row: T, caller: AuthUser): T {
  if (!isHeadCoach(caller)) return row;
  const { email: _email, ...mentor } = row.mentor;
  return { ...row, mentor } as T;
}
