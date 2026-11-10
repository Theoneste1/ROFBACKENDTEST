/**
 * AccessService — the single place that answers "may this user touch content
 * in course C for division D?".
 *
 * Content (resources, assignments, discussions) is scoped to a
 * (course × division) pair:
 *
 *   ADMIN   — every scope.
 *   MENTOR  — only scopes they are actively assigned to (MentorAssignment).
 *   STUDENT — only their own division, and only for PUBLISHED courses.
 *
 * Students who are out of scope get 404 (existence is not revealed);
 * mentors get 403 with an explicit code. Any other role gets least privilege:
 * 404 for a record, 403 ROLE_NOT_SUPPORTED for a list (see roles.ts).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../errors/app-error.js';
import type { AuthUser } from '../auth-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { isAdmin, isCoach, isStudent, unsupportedRole } from './roles.js';

export interface Scope {
  courseId:   string;
  divisionId: string;
}

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active (course, division) pairs a mentor is assigned to. */
  async mentorScopes(mentorId: string): Promise<Scope[]> {
    return this.prisma.mentorAssignment.findMany({
      where:  { mentorId, isActive: true, mentor: { role: 'MENTOR' } },
      select: { courseId: true, divisionId: true },
    });
  }

  async isAssignedMentor(mentorId: string, scope: Scope): Promise<boolean> {
    const found = await this.prisma.mentorAssignment.findFirst({
      where:  { mentorId, courseId: scope.courseId, divisionId: scope.divisionId, isActive: true, mentor: { role: 'MENTOR' } },
      select: { id: true },
    });
    return found !== null;
  }

  /** The student's division, or an error if the profile is incomplete. */
  studentDivision(user: AuthUser): string {
    if (!user.divisionId) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NO_DIVISION', 'Your account has no division. Contact an administrator.');
    }
    return user.divisionId;
  }

  /** May the user READ content in this scope? */
  async assertCanView(user: AuthUser, scope: Scope): Promise<void> {
    switch (user.role) {
      case 'ADMIN':
      case 'SUPER_ADMIN':
        return;
      case 'MENTOR':
        if (await this.isAssignedMentor(user.id, scope)) return;
        throw notAssigned();
      case 'STUDENT': {
        if (user.divisionId !== scope.divisionId) throw new NotFoundException('Not found.');
        const course = await this.prisma.course.findUnique({
          where:  { id: scope.courseId },
          select: { status: true },
        });
        if (course?.status !== 'PUBLISHED') throw new NotFoundException('Not found.');
        return;
      }
      default:
        throw new NotFoundException('Not found.');
    }
  }

  /** May the user CREATE/EDIT content in this scope? (admin or assigned mentor) */
  async assertCanManage(user: AuthUser, scope: Scope): Promise<void> {
    if (isAdmin(user)) return;
    if (isCoach(user) && (await this.isAssignedMentor(user.id, scope))) return;
    throw notAssigned();
  }

  /** Mentor-only variant: admins are NOT allowed (e.g. preparing assignments). */
  async assertMentorOf(user: AuthUser, scope: Scope): Promise<void> {
    if (isCoach(user) && (await this.isAssignedMentor(user.id, scope))) return;
    throw notAssigned();
  }

  /**
   * Prisma `where` fragment restricting a list to the scopes a user can see.
   * Returns `undefined` for admins (no restriction). Any other role is
   * refused — in particular it never inherits coach scope from
   * MentorAssignment rows left over from an earlier role.
   */
  async scopeFilter(user: AuthUser): Promise<Record<string, unknown> | undefined> {
    if (isAdmin(user)) return undefined;
    if (isStudent(user)) {
      return { divisionId: this.studentDivision(user), course: { status: 'PUBLISHED' } };
    }
    if (isCoach(user)) {
      const scopes = await this.mentorScopes(user.id);
      // No scopes → match nothing.
      if (scopes.length === 0) return { id: { in: [] } };
      return { OR: scopes.map((s) => ({ courseId: s.courseId, divisionId: s.divisionId })) };
    }
    throw unsupportedRole();
  }

  // ─── Programme scope helpers (P1-07, plan §7.2; decision K8) ──────────────
  // Read-only building blocks for Head Coach and Teacher scope (P1-10/P1-11).
  // Not called by any route yet, and never by student or coach access above:
  // student access stays division-based, coach access MentorAssignment-based.

  /** The programmes (discipline ids) a user is an ACTIVE member of. */
  async programmesOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.programmeMembership.findMany({
      where:   { userId, isActive: true },
      select:  { disciplineId: true },
      orderBy: { disciplineId: 'asc' },
    });
    return rows.map((r) => r.disciplineId);
  }

  /** Whether the user is an ACTIVE member of this programme. */
  async isProgrammeMember(userId: string, disciplineId: string): Promise<boolean> {
    const found = await this.prisma.programmeMembership.findFirst({
      where:  { userId, disciplineId, isActive: true },
      select: { id: true },
    });
    return found !== null;
  }

  /** `User` filter: active members of any of these programmes (none → matches nobody). */
  programmeMembersFilter(disciplineIds: readonly string[]): Prisma.UserWhereInput {
    if (disciplineIds.length === 0) return { id: { in: [] } };
    return { programmeMemberships: { some: { disciplineId: { in: [...disciplineIds] }, isActive: true } } };
  }

  /** `Course` filter: courses belonging to any of these programmes (none → matches nothing). */
  programmeCoursesFilter(disciplineIds: readonly string[]): Prisma.CourseWhereInput {
    if (disciplineIds.length === 0) return { id: { in: [] } };
    return { disciplineId: { in: [...disciplineIds] } };
  }
}

function notAssigned() {
  return new AppError(
    HttpStatus.FORBIDDEN,
    'NOT_ASSIGNED_TO_SCOPE',
    'You are not assigned to this course and division.',
  );
}
