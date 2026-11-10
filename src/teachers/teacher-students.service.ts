/**
 * A Teacher's view of the students of their schools (P1-11; owner decisions
 * 2026-11-10). Every method is school-scoped: only STUDENT accounts whose
 * `schoolId` is one of the teacher's ACTIVE school assignments (set by an
 * Administrator), read fresh on each request; any other student → 404 (not
 * revealed). Every registered student of those schools counts — no programme,
 * course or enrolment condition.
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
  ) {}

  /** The caller's schools; only Teachers have any (others: 403 ROLE_NOT_SUPPORTED). */
  private async schools(user: AuthUser): Promise<string[]> {
    if (isTeacher(user)) return this.access.teacherSchools(user);
    throw unsupportedRole();
  }

  /** A student of one of the teacher's schools, or 404. */
  private async requireStudent(user: AuthUser, studentId: string) {
    const schools = await this.schools(user);
    const student = await this.prisma.user.findFirst({
      where:  { id: studentId, ...this.access.schoolStudentsFilter(schools) },
      select: { ...STUDENT_SELECT, divisionId: true, isActive: true, isApproved: true, activatedAt: true, createdAt: true, lastLoginAt: true },
    });
    if (!student) throw new NotFoundException('Student not found.');
    return student;
  }

  async list(user: AuthUser, q: ListTeacherStudentsDto) {
    const schools = await this.schools(user);
    if (q.schoolId && !schools.includes(q.schoolId)) throw new NotFoundException('School not found.');
    const { page, limit, skip, take } = pageArgs(q);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.UserWhereInput = {
      ...this.access.schoolStudentsFilter(q.schoolId ? [q.schoolId] : schools),
      ...(q.gradeLevel && { gradeLevel: q.gradeLevel }),
      ...(contains && { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: STUDENT_SELECT, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }] }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  async profile(user: AuthUser, studentId: string) {
    const s = await this.requireStudent(user, studentId);
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
    const s = await this.requireStudent(user, studentId);
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
    const s = await this.requireStudent(user, studentId);
    if (!s.isActive || !s.isApproved) {
      throw new AppError(HttpStatus.CONFLICT, 'STUDENT_NOT_ACTIVE', 'This student account is not active.');
    }
    const owner: AuthUser = { id: s.id, username: s.username, role: 'STUDENT', divisionId: s.divisionId, gradeLevel: s.gradeLevel };
    const result = await this.submissions.submit(dto, owner, files, user);
    // Only the submission's state — never a score or feedback (D7).
    const saved = await this.prisma.submission.findUniqueOrThrow({
      where:  { id: result.id },
      select: { id: true, assignmentId: true, studentId: true, status: true, isLate: true, submittedAt: true, revisionCount: true },
    });
    return { ...saved, submittedBy: { id: user.id, username: user.username, role: user.role } };
  }
}
