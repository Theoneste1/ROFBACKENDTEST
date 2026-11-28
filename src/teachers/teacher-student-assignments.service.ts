/**
 * Administrators' management of which students a Teacher works with (users.manageTeachers; owner approvals
 * TS-1…TS-6, 2026-11-18):
 *
 *   - explicit teacher–student assignments (several teachers per student; a student outside the teacher's verified
 *     schools only with a reason; ending keeps the row as history; re-assigning re-activates it);
 *   - the School Access view: a school's teachers (with their delegations and how many of the school's students are
 *     assigned to each) and its students (with their current claim and assigned teachers);
 *   - the students listed on a SELECTED delegation (add, remove, mark reviewed).
 *
 * One request is ONE transaction: every student is processed and reported (assigned / re-activated / skipped /
 * failed with a code) and the audit rows and the teacher's notice commit with the changes. Larger selections use the
 * bulk operations (assignTeacher, unassignTeacher, grantDelegation, revokeDelegation). Teachers never reach these
 * routes (they hold neither users.manageTeachers nor permissions.manageOverrides).
 */
import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { TEACHER_DELEGATIONS } from '../auth/override-policy.js';
import { schoolStudentsWhere } from '../common/access/access.service.js';
import type { CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { isHiddenAccount } from '../common/access/super-admin-privacy.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AssignTeacherStudentsDto, DelegationStudentsDto, ListTeacherStudentAssignmentsDto, ReassignTeacherStudentsDto, SchoolAccessStudentsDto,
} from './dto/teacher.dto.js';
import {
  addSelectionInTx, assignStudentInTx, countOutcomes, endAssignmentInTx, removeSelectionInTx, type Actor, type ItemResult,
} from './teacher-student-ops.js';

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;

const ASSIGNMENT_SELECT = {
  id: true, isActive: true, source: true, crossSchool: true, reason: true, createdAt: true, endedAt: true, endReason: true,
  teacher:    PERSON,
  student:    { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
  assignedBy: { select: { id: true, username: true } },
  endedBy:    { select: { id: true, username: true } },
} as const;

const TEACHER_NOTICE_SELECT = { id: true, role: true, email: true, firstName: true, isActive: true, activatedAt: true } as const;

/** One request: up to 200 students, each in the same transaction. */
const TX_OPTIONS = { timeout: 60_000, maxWait: 15_000 } as const;

@Injectable()
export class TeacherStudentAssignmentsService {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly audit:   AuditService,
    private readonly notices: DecisionNotificationsService,
  ) {}

  // ─── Assignments ───────────────────────────────────────────────────────────

  async list(q: ListTeacherStudentAssignmentsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.TeacherStudentAssignmentWhereInput = {
      ...(q.teacherId && { teacherId: q.teacherId }),
      ...(q.studentId && { studentId: q.studentId }),
      ...(q.schoolId && { student: { schoolId: q.schoolId } }),
      ...(q.isActive !== undefined && { isActive: q.isActive }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teacherStudentAssignment.findMany({ where, select: ASSIGNMENT_SELECT, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      this.prisma.teacherStudentAssignment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Assign students to a teacher. The teacher is told once (TS-6) when at least one student is newly assigned. */
  async assign(dto: AssignTeacherStudentsDto, caller: CallerCtx) {
    const teacher = await this.requireTeacher(dto.teacherId, caller);
    const actor = actorOf(caller);
    const ids = [...new Set(dto.studentIds)].sort();
    let notice: string | null = null;
    const results = await this.prisma.$transaction(async (tx) => {
      const out: ItemResult[] = [];
      for (const studentId of ids) {
        out.push(await assignStudentInTx(tx, this.audit, { teacherId: teacher.id, studentId, actor, source: 'ADMIN', reason: dto.reason }));
      }
      const added = out.filter((r) => r.outcome === 'ASSIGNED' || r.outcome === 'REACTIVATED').length;
      notice = await this.notices.enqueueStudentsAssigned(tx, teacher, `request:${randomUUID()}`, added);
      return out;
    }, TX_OPTIONS);
    this.notices.dispatchAfterCommit([notice]);
    return { teacherId: teacher.id, counts: countOutcomes(results), results };
  }

  /** End one assignment (kept as history). 409 ASSIGNMENT_ENDED when already ended. */
  async end(id: string, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const r = await endAssignmentInTx(tx, this.audit, { where: { id }, actor: actorOf(caller), reason: 'ADMIN' });
      if (r.code === 'NOT_ASSIGNED') throw new NotFoundException('Teacher–student assignment not found.');
      if (r.code === 'ASSIGNMENT_ENDED') throw new AppError(HttpStatus.CONFLICT, 'ASSIGNMENT_ENDED', 'This assignment has already ended.');
      return tx.teacherStudentAssignment.findUniqueOrThrow({ where: { id }, select: ASSIGNMENT_SELECT });
    });
  }

  /**
   * Move students from one teacher to another: for each student, the old assignment ends and the new one starts in
   * the same transaction — or, when the new one is refused (e.g. a reason is needed), nothing changes for that student.
   */
  async reassign(dto: ReassignTeacherStudentsDto, caller: CallerCtx) {
    if (dto.fromTeacherId === dto.toTeacherId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SAME_TEACHER', 'Choose a different teacher to move the students to.');
    }
    const [, to] = await Promise.all([this.requireTeacher(dto.fromTeacherId, caller, { anyRole: true }), this.requireTeacher(dto.toTeacherId, caller)]);
    const actor = actorOf(caller);
    const ids = [...new Set(dto.studentIds)].sort();
    let notice: string | null = null;
    const results = await this.prisma.$transaction(async (tx) => {
      const out: ItemResult[] = [];
      for (const studentId of ids) {
        const current = await tx.teacherStudentAssignment.findUnique({
          where: { teacherId_studentId: { teacherId: dto.fromTeacherId, studentId } }, select: { isActive: true },
        });
        if (!current?.isActive) {
          out.push({ studentId, outcome: 'FAILED', code: 'NOT_ASSIGNED', message: 'This student is not assigned to the first teacher.' });
          continue;
        }
        // The new assignment first (inside a savepoint-free check: an ordinary refusal changes nothing).
        const added = await assignStudentInTx(tx, this.audit, {
          teacherId: to.id, studentId, actor, source: 'ADMIN', reason: dto.reason, reassignedFrom: dto.fromTeacherId,
        });
        if (added.outcome === 'FAILED') { out.push(added); continue; }
        await endAssignmentInTx(tx, this.audit, { where: { teacherId: dto.fromTeacherId, studentId }, actor, reason: 'REASSIGNED' });
        out.push(added.outcome === 'SKIPPED' ? { ...added, outcome: 'ENDED', code: 'ALREADY_ASSIGNED_TO_NEW_TEACHER' } : added);
      }
      const n = out.filter((r) => r.outcome === 'ASSIGNED' || r.outcome === 'REACTIVATED').length;
      notice = await this.notices.enqueueStudentsAssigned(tx, to, `request:${randomUUID()}`, n);
      return out;
    }, TX_OPTIONS);
    this.notices.dispatchAfterCommit([notice]);
    return { fromTeacherId: dto.fromTeacherId, toTeacherId: to.id, counts: countOutcomes(results), results };
  }

  // ─── School Access ─────────────────────────────────────────────────────────

  /** A school's teachers and their access, and the counts an Administrator needs (no student list: see students()). */
  async schoolAccess(schoolId: string) {
    const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, name: true, location: true, isActive: true } });
    if (!school) throw new NotFoundException('School not found.');
    const now = new Date();
    const teachers = await this.prisma.teacherSchoolAssignment.findMany({
      where: { schoolId, isActive: true },
      orderBy: [{ teacher: { lastName: 'asc' } }, { teacher: { firstName: 'asc' } }, { id: 'asc' }],
      select: {
        id: true, createdAt: true, role: true,
        teacher: {
          select: {
            id: true, username: true, firstName: true, lastName: true, accountStatus: true,
            permissionOverrides: {
              where: { effect: 'GRANT', permission: { in: [...TEACHER_DELEGATIONS] }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              select: {
                id: true, permission: true, studentScope: true, expiresAt: true, reviewNeededAt: true, reviewReason: true,
                _count: { select: { students: { where: { removedAt: null } } } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    const teacherIds = teachers.map((t) => t.teacher.id);
    const [assignedCounts, verified, pending, unassigned] = await Promise.all([
      this.prisma.teacherStudentAssignment.groupBy({
        by: ['teacherId'], where: { teacherId: { in: teacherIds }, isActive: true, student: { schoolId } }, _count: { _all: true },
      }),
      // "Verified" counts stay exactly that: the shared rule also admits PENDING claims (owner 2026-11-21), counted apart.
      this.prisma.user.count({ where: { ...schoolStudentsWhere([schoolId]), ...verifiedAt(schoolId) } }),
      this.prisma.studentSchoolAffiliation.count({ where: { schoolId, supersededAt: null, status: 'PENDING', student: { role: 'STUDENT' } } }),
      this.prisma.user.count({ where: { ...schoolStudentsWhere([schoolId]), ...verifiedAt(schoolId), teacherStudentsAsStudent: { none: { isActive: true } } } }),
    ]);
    const assignedOf = new Map(assignedCounts.map((c) => [c.teacherId, c._count._all]));
    const rows = teachers.map((t) => ({
      teacherSchoolAssignmentId: t.id, since: t.createdAt, role: t.role,
      teacher: { id: t.teacher.id, username: t.teacher.username, firstName: t.teacher.firstName, lastName: t.teacher.lastName, accountStatus: t.teacher.accountStatus },
      assignedStudents: assignedOf.get(t.teacher.id) ?? 0,
      delegations: t.teacher.permissionOverrides.map(({ _count, ...d }) => ({ ...d, selectedStudents: d.studentScope === 'SELECTED' ? _count.students : null })),
    }));
    return {
      school,
      teachers: rows,
      counts: { verifiedStudents: verified, pendingStudents: pending, verifiedWithoutTeacher: unassigned },
      attention: {
        delegationsNeedingReview: rows.flatMap((r) => r.delegations.filter((d) => d.reviewNeededAt).map((d) => ({ teacherId: r.teacher.id, overrideId: d.id, permission: d.permission, reviewReason: d.reviewReason }))),
      },
    };
  }

  /** The school's students (current claim at this school, any state) with their assigned teachers. Never contact data. */
  async schoolStudents(schoolId: string, q: SchoolAccessStudentsDto) {
    if (!(await this.prisma.school.count({ where: { id: schoolId } }))) throw new NotFoundException('School not found.');
    const { page, limit, skip, take } = pageArgs(q);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.UserWhereInput = {
      role: 'STUDENT',
      schoolAffiliations: { some: { schoolId, supersededAt: null, ...(q.verification ? { status: q.verification } : { status: { in: ['VERIFIED', 'PENDING'] } }) } },
      ...(q.gradeLevel && { gradeLevel: q.gradeLevel }),
      ...(contains && { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }),
      ...(q.teacherId
        ? { teacherStudentsAsStudent: { some: { isActive: true, teacherId: q.teacherId } } }
        : q.assigned === true ? { teacherStudentsAsStudent: { some: { isActive: true } } }
        : q.assigned === false ? { teacherStudentsAsStudent: { none: { isActive: true } } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, username: true, firstName: true, lastName: true, gradeLevel: true, accountStatus: true, isApproved: true, activatedAt: true,
          schoolAffiliations: { where: { schoolId, supersededAt: null }, select: { id: true, status: true }, take: 1 },
          teacherStudentsAsStudent: { where: { isActive: true }, select: { id: true, crossSchool: true, teacher: PERSON }, orderBy: { createdAt: 'asc' } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(rows.map(({ schoolAffiliations, teacherStudentsAsStudent, activatedAt, ...s }) => ({
      ...s, activated: activatedAt !== null,
      claim: schoolAffiliations[0] ?? null,
      teachers: teacherStudentsAsStudent.map((a) => ({ assignmentId: a.id, crossSchool: a.crossSchool, ...a.teacher })),
    })), total, page, limit);
  }

  // ─── Students of a SELECTED delegation ─────────────────────────────────────

  async addDelegationStudents(teacherId: string, overrideId: string, dto: DelegationStudentsDto, caller: CallerCtx) {
    const actor = actorOf(caller);
    const ids = [...new Set(dto.studentIds)].sort();
    const results = await this.prisma.$transaction(async (tx) => {
      const override = await this.requireSelected(tx, teacherId, overrideId);
      const out: ItemResult[] = [];
      for (const studentId of ids) out.push(await addSelectionInTx(tx, this.audit, { override, studentId, actor }));
      return out;
    }, TX_OPTIONS);
    return { overrideId, counts: countOutcomes(results), results };
  }

  async removeDelegationStudent(teacherId: string, overrideId: string, studentId: string, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const override = await this.requireSelected(tx, teacherId, overrideId, { includeRevoked: true });
      const r = await removeSelectionInTx(tx, this.audit, { override, studentId, actor: actorOf(caller) });
      if (r.outcome !== 'REMOVED') throw new NotFoundException('This student is not covered by this delegation.');
      return r;
    });
  }

  /** An Administrator has looked at a delegation flagged by TS-5: the flag is cleared (audited). */
  async markReviewed(teacherId: string, overrideId: string, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.userPermissionOverride.findFirst({
        where: { id: overrideId, userId: teacherId, permission: { in: [...TEACHER_DELEGATIONS] } }, select: { id: true, reviewReason: true, permission: true },
      });
      if (!found) throw new NotFoundException('Delegation not found.');
      const { count } = await tx.userPermissionOverride.updateMany({
        where: { id: overrideId, reviewNeededAt: { not: null } }, data: { reviewNeededAt: null, reviewReason: null },
      });
      if (count === 0) throw new AppError(HttpStatus.CONFLICT, 'NO_REVIEW_NEEDED', 'This delegation is not waiting for a review.');
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'DELEGATION_REVIEWED', entity: 'UserPermissionOverride', entityId: overrideId,
        metadata: { teacherId, permission: found.permission, from: found.reviewReason, to: null },
      }, tx);
      return { overrideId, reviewNeededAt: null };
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async requireTeacher(id: string, caller: CallerCtx, opts: { anyRole?: boolean } = {}) {
    const teacher = await this.prisma.user.findUnique({ where: { id }, select: TEACHER_NOTICE_SELECT });
    // A Super Administrator does not exist for anyone else (Super Administrator privacy): as for an unknown id.
    if (!teacher || isHiddenAccount(caller, teacher)) throw new NotFoundException('Teacher not found.');
    if (!opts.anyRole && teacher.role !== 'TEACHER') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_TEACHER', 'Only users with the TEACHER role can be given students.', { role: teacher.role });
    }
    return teacher;
  }

  private async requireSelected(tx: Prisma.TransactionClient, teacherId: string, overrideId: string, opts: { includeRevoked?: boolean } = {}) {
    const o = await tx.userPermissionOverride.findFirst({
      where: { id: overrideId, userId: teacherId, effect: 'GRANT', permission: { in: [...TEACHER_DELEGATIONS] } },
      select: { id: true, userId: true, permission: true, studentScope: true, revokedAt: true, expiresAt: true },
    });
    if (!o) throw new NotFoundException('Delegation not found.');
    if (o.studentScope !== 'SELECTED') {
      throw new AppError(HttpStatus.CONFLICT, 'NOT_SELECTED_SCOPE', 'Students can be listed only on a delegation for selected students.', { studentScope: o.studentScope });
    }
    if (!opts.includeRevoked && (o.revokedAt || (o.expiresAt && o.expiresAt.getTime() <= Date.now()))) {
      throw new AppError(HttpStatus.CONFLICT, 'OVERRIDE_INACTIVE', 'This delegation has been revoked or has expired.');
    }
    return { id: o.id, userId: o.userId, permission: o.permission };
  }
}

const actorOf = (c: CallerCtx): Actor => ({ actorId: c.id, actorRole: c.role });

/** A CURRENT VERIFIED claim for this school (narrows schoolStudentsWhere, which also admits PENDING claims). */
const verifiedAt = (schoolId: string) => ({ schoolAffiliations: { some: { schoolId, supersededAt: null, status: 'VERIFIED' as const } } });
