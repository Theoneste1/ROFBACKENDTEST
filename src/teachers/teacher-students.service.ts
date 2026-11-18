/**
 * A Teacher's view of their students (P1-11; owner decisions 2026-11-10; TS-1…TS-6 2026-11-18). Visible: approved,
 * activated students who are VERIFIED students of one of the teacher's ACTIVE schools, or explicitly ASSIGNED to the
 * teacher by an Administrator (teacher-scope.ts) — read fresh on each request; any other student → 404 (not
 * revealed). Students of the teacher's schools still pending verification are only counted (summary), never named.
 * A delegation applies to a visible student only when its student scope covers them (SCHOOL / ASSIGNED / SELECTED):
 * otherwise 403 DELEGATION_NOT_FOR_STUDENT.
 *
 *   list      students.viewScoped (Teacher default): name, username, grade, division, school
 *   profile   students.viewProfile (delegation): + account and enrolment status
 *   progress  students.viewProgress (delegation): assignment availability and
 *             submission history — never scores, feedback or reviews (D7)
 *   submit    submissions.submitOnBehalf (delegation): the student stays the
 *             owner; the teacher is recorded as submitter, uploader and audit actor
 *
 * Never returned: e-mail, phone, home location, grades, marks, feedback. No
 * route here changes a student's account or password (those need users.manage*,
 * which no teacher holds and no override can grant).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PermissionService } from '../auth/permission.service.js';
import { AccessService } from '../common/access/access.service.js';
import { isTeacher, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateSubmissionDto } from '../submissions/dto/create-submission.dto.js';
import { SubmissionsService } from '../submissions/submissions.service.js';
import { ListTeacherStudentsDto } from './dto/teacher.dto.js';
import { TEACHER_DELEGATIONS } from '../auth/override-policy.js';
import { activeGrantsOf, assignedStudentsWhere, delegationCovers, teacherStudentsWhere, visibilityOf } from './teacher-scope.js';
import { schoolStudentsWhere } from '../common/access/access.service.js';

/** The three delegations, by the short names the list returns. */
const DELEGATION_KEYS = { 'students.viewProfile': 'viewProfile', 'students.viewProgress': 'viewProgress', 'submissions.submitOnBehalf': 'submitOnBehalf' } as const;

/** The default list (students.viewScoped): name, username, grade, division, school — nothing else. */
const STUDENT_SELECT = {
  id: true, username: true, firstName: true, lastName: true, gradeLevel: true,
  division: { select: { id: true, code: true, name: true } },
  school:   { select: { id: true, name: true, location: true } },
} as const;

@Injectable()
export class TeacherStudentsService {
  constructor(
    private readonly prisma:       PrismaService,
    private readonly access:       AccessService,
    private readonly submissions:  SubmissionsService,
    private readonly permissions:  PermissionService,
  ) {}

  /** The caller's schools; only Teachers have any (others: 403 ROLE_NOT_SUPPORTED). */
  private async schools(user: AuthUser): Promise<string[]> {
    if (isTeacher(user)) return this.access.teacherSchools(user);
    throw unsupportedRole();
  }

  /**
   * A student visible to the teacher (404 otherwise) whom the route's delegation covers (403
   * DELEGATION_NOT_FOR_STUDENT otherwise: a delegation limited to assigned or selected students).
   */
  private async requireStudent(user: AuthUser, studentId: string, permission: (typeof TEACHER_DELEGATIONS)[number]) {
    const schools = await this.schools(user);
    const student = await this.prisma.user.findFirst({
      where:  { id: studentId, ...teacherStudentsWhere(user.id, schools) },
      select: { ...STUDENT_SELECT, divisionId: true, isActive: true, isApproved: true, activatedAt: true, createdAt: true, lastLoginAt: true },
    });
    if (!student) throw new NotFoundException('Student not found.');
    const seen = (await visibilityOf(this.prisma, user.id, schools, [studentId])).get(studentId) ?? { viaSchool: false, viaAssignment: false };
    const grants = await activeGrantsOf(this.prisma, user.id, [permission]);
    if (!delegationCovers(grants, { id: studentId, ...seen })) {
      throw new AppError(HttpStatus.FORBIDDEN, 'DELEGATION_NOT_FOR_STUDENT', 'Your permission does not cover this student.', { permission });
    }
    return student;
  }

  async list(user: AuthUser, q: ListTeacherStudentsDto) {
    const schools = await this.schools(user);
    if (q.schoolId && !schools.includes(q.schoolId)) throw new NotFoundException('School not found.');
    const { page, limit, skip, take } = pageArgs(q);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const inScope = q.access === 'SCHOOL' ? schoolStudentsWhere(q.schoolId ? [q.schoolId] : schools)
      : q.access === 'ASSIGNED' ? assignedStudentsWhere(user.id)
      : teacherStudentsWhere(user.id, q.schoolId ? [q.schoolId] : schools);
    const where: Prisma.UserWhereInput = {
      AND: [
        inScope,
        ...(q.schoolId ? [{ schoolId: q.schoolId }] : []),
        ...(q.gradeLevel ? [{ gradeLevel: q.gradeLevel }] : []),
        ...(contains ? [{ OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }] : []),
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: STUDENT_SELECT, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }] }),
      this.prisma.user.count({ where }),
    ]);
    // How the teacher sees each student and what each delegation lets them do for that student.
    const seen = await visibilityOf(this.prisma, user.id, schools, rows.map((r) => r.id));
    const grants = await activeGrantsOf(this.prisma, user.id, TEACHER_DELEGATIONS);
    return paginated(rows.map((r) => {
      const v = seen.get(r.id) ?? { viaSchool: false, viaAssignment: false };
      const can = Object.fromEntries(TEACHER_DELEGATIONS.map((p) => [
        DELEGATION_KEYS[p as keyof typeof DELEGATION_KEYS], delegationCovers(grants.filter((g) => g.permission === p), { id: r.id, ...v }),
      ]));
      return { ...r, access: { school: v.viaSchool, assigned: v.viaAssignment }, can };
    }), total, page, limit);
  }

  /**
   * Counts for My Students: students the teacher sees (through the schools, through assignments) and students of
   * their schools still waiting for an Administrator to verify the school — a number only, never who (TS-1).
   */
  async summary(user: AuthUser) {
    const schools = await this.schools(user);
    const [viaSchool, viaAssignment, visible, pendingVerification] = await Promise.all([
      this.prisma.user.count({ where: schoolStudentsWhere(schools) }),
      this.prisma.user.count({ where: assignedStudentsWhere(user.id) }),
      this.prisma.user.count({ where: teacherStudentsWhere(user.id, schools) }),
      schools.length === 0 ? 0 : this.prisma.studentSchoolAffiliation.count({
        where: { schoolId: { in: schools }, supersededAt: null, status: 'PENDING', student: { role: 'STUDENT' } },
      }),
    ]);
    return { schools: schools.length, students: visible, viaSchool, viaAssignment, pendingVerification };
  }

  async profile(user: AuthUser, studentId: string) {
    const s = await this.requireStudent(user, studentId, 'students.viewProfile');
    const enrolment = await this.prisma.studentEnrollment.findFirst({
      where:   { studentId, academicYear: { isCurrent: true } },
      select:  { status: true, gradeLevel: true, academicYear: { select: { id: true, name: true } } },
    });
    return {
      id: s.id, username: s.username, firstName: s.firstName, lastName: s.lastName, gradeLevel: s.gradeLevel,
      division: s.division, school: s.school,
      account: { isActive: s.isActive, isApproved: s.isApproved, activated: s.activatedAt !== null, registeredAt: s.createdAt, lastLoginAt: s.lastLoginAt },
      currentEnrolment: enrolment,
    };
  }

  /** Assignments available to the student (their division, published courses) with their submission history — no scores or feedback. */
  async progress(user: AuthUser, studentId: string) {
    const s = await this.requireStudent(user, studentId, 'students.viewProgress');
    if (!s.divisionId) return { student: { id: s.id, username: s.username }, assignments: [] };
    const assignments = await this.prisma.assignment.findMany({
      where:   { divisionId: s.divisionId, status: { in: ['PUBLISHED', 'CLOSED'] }, course: { status: 'PUBLISHED' } },
      orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
      select:  {
        id: true, title: true, status: true, deadline: true, allowResubmission: true, maxResubmissions: true, allowLateSubmission: true,
        course: { select: { id: true, code: true, title: true } },
        submissions: {
          where:  { studentId },
          select: {
            id: true, status: true, isLate: true, submittedAt: true, revisionCount: true,
            revisions: {
              orderBy: { revisionNumber: 'asc' },
              select:  {
                revisionNumber: true, submittedAt: true, isLate: true,
                submittedBy: { select: { id: true, username: true, role: true } },
                _count: { select: { attachments: true } },
              },
            },
          },
        },
      },
    });
    return {
      student: { id: s.id, username: s.username },
      assignments: assignments.map(({ submissions, ...a }) => {
        const sub = submissions[0];
        return {
          ...a,
          submission: sub ? {
            id: sub.id, status: sub.status, isLate: sub.isLate, submittedAt: sub.submittedAt, revisionCount: sub.revisionCount,
            attempts: sub.revisions.map(({ _count, ...r }) => ({ ...r, files: _count.attachments })),
          } : null,
        };
      }),
    };
  }

  /** Submit (or resubmit) for the student. All normal deadline and resubmission rules apply. */
  async submit(user: AuthUser, studentId: string, dto: CreateSubmissionDto, files: Express.Multer.File[]) {
    const s = await this.requireStudent(user, studentId, 'submissions.submitOnBehalf');
    if (!s.isActive || !s.isApproved) {
      throw new AppError(HttpStatus.CONFLICT, 'STUDENT_NOT_ACTIVE', 'This student account is not active.');
    }
    // The student's own permission decides, exactly as for their own submission: their
    // active individual overrides are loaded (same rule as on every request), so a DENY of
    // submissions.submit on the student also stops a teacher submitting for them.
    const overrides = await this.prisma.userPermissionOverride.findMany({
      where:  { userId: s.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true, permission: true, effect: true, courseId: true, divisionId: true, expiresAt: true },
    });
    const owner: AuthUser = { id: s.id, username: s.username, role: 'STUDENT', divisionId: s.divisionId, gradeLevel: s.gradeLevel, overrides };
    if (!this.permissions.has(owner, 'submissions.submit')) {
      throw new AppError(HttpStatus.FORBIDDEN, 'STUDENT_SUBMISSION_DENIED', 'This student is not allowed to submit work, so it cannot be submitted on their behalf.');
    }
    const result = await this.submissions.submit(dto, owner, files, user);
    // Only the submission's state — never a score or feedback (D7).
    const saved = await this.prisma.submission.findUniqueOrThrow({
      where:  { id: result.id },
      select: { id: true, assignmentId: true, studentId: true, status: true, isLate: true, submittedAt: true, revisionCount: true },
    });
    return { ...saved, submittedBy: { id: user.id, username: user.username, role: user.role } };
  }
}
