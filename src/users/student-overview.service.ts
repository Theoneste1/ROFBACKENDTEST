/**
 * The Student Profile Overview (owner 2026-11-22): the basic, non-sensitive identity of a student — photo, full name,
 * username, country, school, grade, Olympiad level (division) and Olympiad subjects — the same for every screen that
 * opens a student. It replaces the 2026-11-18 rule that hid students' pictures from everyone but the student,
 * Administrators and delegated Teachers: the picture is now visible to everyone who may view the student's profile.
 *
 * Who may view a student's overview (and so their picture):
 *  - the student; Administrators and Super Administrators (every student);
 *  - another student: any ACTIVE student (the community already sees names on leaderboards and discussions);
 *  - a Teacher: the students of their schools (verified or pending claim) and those assigned to them (TS rules);
 *  - a Coach or Head Coach: the students of the programmes they belong to, or of the divisions of their course
 *    assignments;
 *  - anyone else: 404 (the same answer as an unknown student).
 * Never in the overview: contact data (e-mail, phones, guardian), date of birth, home address, academic records.
 * The account status is shown to staff only (Administrators, Coaches, Head Coaches, Teachers), never to students.
 */
import { Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../common/auth-user.js';
import { isAdmin, isCourseWorker, isStudent, isTeacher } from '../common/access/roles.js';
import { APP_ROLES } from '../auth/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { activeSchoolsOf, visibilityOf } from '../teachers/teacher-scope.js';

const OVERVIEW_SELECT = {
  id: true, role: true, firstName: true, lastName: true, username: true, avatarUrl: true, country: true, gradeLevel: true,
  accountStatus: true, olympiadInterests: true, olympiadInterestOther: true, divisionId: true,
  school: { select: { id: true, name: true } },
  division: { select: { id: true, code: true, name: true } },
} as const;

@Injectable()
export class StudentOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** Whether `viewer` may view this student's overview and picture (see the file header). */
  async mayView(viewer: AuthUser, student: { id: string; accountStatus: string; divisionId: string | null }): Promise<boolean> {
    // An unsupported role sees nothing — not even its own account (least privilege).
    if (!(APP_ROLES as readonly string[]).includes(viewer.role)) return false;
    if (viewer.id === student.id || isAdmin(viewer)) return true;
    if (isStudent(viewer)) return student.accountStatus === 'ACTIVE';
    if (isTeacher(viewer)) {
      const seen = await visibilityOf(this.prisma, viewer.id, await activeSchoolsOf(this.prisma, viewer.id), [student.id]);
      return seen.has(student.id);
    }
    if (isCourseWorker(viewer)) {
      const [programmes, divisions] = await Promise.all([
        // A Coach's programmes where seeing the students was not taken away (owner 2026-11-23: CoachProgrammeRestriction).
        this.prisma.programmeMembership.findMany({
          where: { userId: viewer.id, isActive: true, ...(viewer.role === 'MENTOR' && { discipline: { coachRestrictions: { none: { coachId: viewer.id, capability: 'STUDENTS', liftedAt: null } } } }) },
          select: { disciplineId: true },
        }),
        this.prisma.mentorAssignment.findMany({ where: { mentorId: viewer.id, isActive: true }, select: { divisionId: true } }),
      ]);
      if (student.divisionId && divisions.some((d) => d.divisionId === student.divisionId)) return true;
      if (!programmes.length) return false;
      return (await this.prisma.programmeMembership.count({
        where: { userId: student.id, isActive: true, disciplineId: { in: programmes.map((x) => x.disciplineId) } },
      })) > 0;
    }
    return false;
  }

  /** GET /students/:id/overview — 404 for an unknown account, a non-student, or a student the viewer may not view. */
  async overview(id: string, viewer: AuthUser) {
    const s = await this.prisma.user.findUnique({ where: { id }, select: OVERVIEW_SELECT });
    if (!s || s.role !== 'STUDENT' || !(await this.mayView(viewer, s))) throw new NotFoundException('Student not found.');
    const staff = isAdmin(viewer) || isCourseWorker(viewer) || isTeacher(viewer);
    return {
      id: s.id, firstName: s.firstName, lastName: s.lastName, username: s.username, avatarUrl: s.avatarUrl, country: s.country,
      school: s.school, gradeLevel: s.gradeLevel, olympiadLevel: s.division,
      olympiadInterests: s.olympiadInterests, olympiadInterestOther: s.olympiadInterestOther,
      ...(staff && { accountStatus: s.accountStatus }),
    };
  }
}
