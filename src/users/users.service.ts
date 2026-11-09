import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { TokenService } from '../auth/token.service.js';
import { AccountEmailsService } from '../notifications/account-emails.service.js';
import { BCRYPT_COST, PROFILE_SELECT } from '../auth/auth.service.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { GradeLevel, Prisma } from '../generated/prisma/client.js';
import { AcademicYearsService } from '../academic-years/academic-years.service.js';
import { endCoachAssignments } from '../mentor-assignments/end-coach-assignments.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import {
  ListUsersQueryDto,
  UpdateMeDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './dto/update-user.dto.js';

/** Fields that are safe to return to admins — passwordHash is never included. */
const SAFE_SELECT = {
  ...PROFILE_SELECT,
  provider:   true,
  isApproved: true,
  isActive:   true,
  activatedAt: true,
  updatedAt:  true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly divisions: DivisionsService,
    private readonly tokens:    TokenService,
    private readonly academicYears: AcademicYearsService,
    private readonly accountEmails: AccountEmailsService,
  ) {}

  // ─── List users with optional filters ──────────────────────────────────────
  async findAll(q: ListUsersQueryDto) {
    const { page, limit, skip, take } = pageArgs(q);

    const where: Prisma.UserWhereInput = {
      ...(q.role       && { role: q.role }),
      ...(q.divisionId && { divisionId: q.divisionId }),
      ...(q.gradeLevel && { gradeLevel: q.gradeLevel }),
      ...(q.schoolId   && { schoolId: q.schoolId }),
      ...(q.isApproved !== undefined && { isApproved: q.isApproved }),
      ...(q.isActive   !== undefined && { isActive: q.isActive }),
      ...(q.isActivated !== undefined && { activatedAt: q.isActivated ? { not: null } : null }),
      ...(q.search && {
        OR: [
          { firstName: { contains: q.search, mode: 'insensitive' } },
          { lastName:  { contains: q.search, mode: 'insensitive' } },
          { username:  { contains: q.search, mode: 'insensitive' } },
          { email:     { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: SAFE_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(users, total, page, limit);
  }

  // ─── Create a user (admin) ─────────────────────────────────────────────────
  async create(data: CreateUserDto, caller: CallerCtx) {
    await this.assertIdentityFree(data.username, data.email);

    const role = data.role ?? 'STUDENT';
    const studentFields = role === 'STUDENT' ? await this.studentFields(data.gradeLevel!, data.schoolId) : {};
    const passwordHash  = await bcrypt.hash(data.password, BCRYPT_COST);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          firstName:    data.firstName,
          lastName:     data.lastName,
          username:     data.username,
          email:        data.email,
          passwordHash,
          role,
          activatedAt:  new Date(), // the admin set the password
          homeLocation: role === 'STUDENT' ? data.homeLocation : null,
          ...studentFields,
        },
        select: { id: true },
      });
      if (role === 'STUDENT') {
        await this.academicYears.enrollInCurrentYear(tx, created.id, data.gradeLevel!, data.schoolId ?? null);
      }
      return tx.user.findUniqueOrThrow({ where: { id: created.id }, select: SAFE_SELECT });
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'CREATE_USER', entity: 'User', entityId: user.id,
      metadata: { role, username: user.username },
    });

    return user;
  }

  // ─── Get a single user ──────────────────────────────────────────────────────
  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    return user;
  }

  // ─── Update a user (admin) ──────────────────────────────────────────────────
  async update(id: string, data: UpdateUserDto, caller: CallerCtx) {
    const existing = await this.prisma.user.findUnique({
      where:  { id },
      select: {
        id: true, role: true, gradeLevel: true, username: true, email: true,
        firstName: true, lastName: true, divisionId: true, schoolId: true, homeLocation: true,
      },
    });
    if (!existing) throw new NotFoundException(`User ${id} not found.`);

    if (Object.keys(data).length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }
    if (id === caller.id && data.role && data.role !== existing.role) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
    }
    if ((data.username && data.username !== existing.username) || (data.email && data.email !== existing.email)) {
      await this.assertIdentityFree(
        data.username !== existing.username ? data.username : undefined,
        data.email    !== existing.email    ? data.email    : undefined,
      );
    }

    const role = data.role ?? existing.role;
    const updateData: Prisma.UserUncheckedUpdateInput = {
      firstName: data.firstName,
      lastName:  data.lastName,
      username:  data.username,
      email:     data.email,
      role,
      ...(data.password && { passwordHash: await bcrypt.hash(data.password, BCRYPT_COST) }),
    };

    const grade = role === 'STUDENT' ? (data.gradeLevel ?? existing.gradeLevel) : null;
    if (role === 'STUDENT') {
      if (!grade) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'GRADE_REQUIRED', 'Students must have a grade level.');
      }
      Object.assign(updateData, await this.studentFields(grade, data.schoolId), {
        ...(data.homeLocation !== undefined && { homeLocation: data.homeLocation }),
      });
    } else {
      // Mentors and admins carry no student data.
      Object.assign(updateData, { gradeLevel: null, divisionId: null, schoolId: null, homeLocation: null });
    }

    const placementChanged =
      role !== existing.role || (grade && grade !== existing.gradeLevel) || data.schoolId !== undefined;

    const actor = { actorId: caller.id, actorRole: caller.role };
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id }, data: updateData,
        select: { role: true, gradeLevel: true, divisionId: true, schoolId: true, firstName: true, lastName: true, username: true, email: true, homeLocation: true },
      });
      let enrollment: 'PLACED' | 'WITHDRAWN' | null = null;
      if (placementChanged && role === 'STUDENT') {
        // Keep the current-year enrolment in step with the new placement.
        await this.academicYears.enrollInCurrentYear(tx, id, grade!, updated.schoolId);
        enrollment = 'PLACED';
      } else if (existing.role === 'STUDENT' && role !== 'STUDENT') {
        await tx.studentEnrollment.updateMany({
          where: { studentId: id, status: 'ACTIVE' },
          data:  { status: 'WITHDRAWN', endedAt: new Date() },
        });
        enrollment = 'WITHDRAWN';
      }

      // A coach who changes role keeps no coach scope: their course × division
      // assignments are deactivated (kept as history) in the same transaction.
      if (existing.role === 'MENTOR' && role !== 'MENTOR') {
        await endCoachAssignments(tx, this.audit, id, actor, { from: existing.role, to: role });
      }

      // The audit entries commit with the change: what changed, from what, to what.
      const changes = diff(existing, updated, ['firstName', 'lastName', 'username', 'email', 'role', 'gradeLevel', 'divisionId', 'schoolId', 'homeLocation']);
      await this.audit.log({
        ...actor, action: 'UPDATE_USER', entity: 'User', entityId: id,
        metadata: { changes, passwordChanged: !!data.password },
      }, tx);
      if (existing.role !== updated.role) {
        await this.audit.log({
          ...actor, action: 'CHANGE_USER_ROLE', entity: 'User', entityId: id,
          metadata: { from: existing.role, to: updated.role },
        }, tx);
      }
      if (enrollment && (changes.gradeLevel || changes.divisionId || changes.schoolId || changes.role)) {
        await this.audit.log({
          ...actor, action: 'CHANGE_STUDENT_ENROLLMENT', entity: 'User', entityId: id,
          metadata: {
            change: enrollment,
            from: { gradeLevel: existing.gradeLevel, divisionId: existing.divisionId, schoolId: existing.schoolId },
            to:   { gradeLevel: updated.gradeLevel, divisionId: updated.divisionId, schoolId: updated.schoolId },
          },
        }, tx);
      }
      // Sessions end in the same transaction as the role / password change (last
      // statement before commit): the new role and the revocation become visible
      // together, so an old token can never authenticate with the new role.
      if (data.password || data.role) await this.tokens.revokeAllForUser(id, tx);
      return tx.user.findUniqueOrThrow({ where: { id }, select: SAFE_SELECT });
    });

    return user;
  }

  // ─── Suspend / activate / approve ───────────────────────────────────────────
  async updateStatus(id: string, data: UpdateUserStatusDto, caller: CallerCtx) {
    if (id === caller.id && data.isActive === false) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own account.');
    }
    const before = await this.findOne(id);

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where:  { id },
        data:   { isActive: data.isActive, isApproved: data.isApproved },
        select: SAFE_SELECT,
      });
      // Deactivation / reactivation / approval, with the previous state.
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'UPDATE_USER_STATUS', entity: 'User', entityId: id,
        metadata: {
          ...data,
          changes: diff(before, updated, ['isActive', 'isApproved']),
          ...(before.isActive && updated.isActive === false && { deactivated: true }),
          ...(!before.isActive && updated.isActive && { reactivated: true }),
        },
      }, tx);
      return updated;
    });

    if (data.isActive === false) await this.tokens.revokeAllForUser(id);
    if (!before.isApproved && user.isApproved && user.isActive) await this.accountEmails.approved(id);
    return user;
  }

  // ─── Delete a user ──────────────────────────────────────────────────────────
  /**
   * Hard delete is only possible for accounts without academic history
   * (submissions, assignments, reviews …). Otherwise suspend the account.
   */
  async delete(id: string, caller: CallerCtx) {
    if (id === caller.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_DELETE_SELF', 'You cannot delete your own account.');
    }
    const user = await this.findOne(id);

    try {
      await this.prisma.user.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2003') {
        throw new AppError(
          HttpStatus.CONFLICT,
          'USER_HAS_HISTORY',
          'This account has academic history and cannot be deleted. Suspend it instead.',
        );
      }
      throw err;
    }

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'DELETE_USER', entity: 'User', entityId: id, metadata: { username: user.username },
    });
    return { message: `User ${id} deleted successfully.` };
  }

  // (Annual promotion moved to AcademicYearsService.activate, which also keeps
  //  per-year enrolment history.)

  // ─── Self-service profile ───────────────────────────────────────────────────
  async getMe(userId: string) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    if (!me) throw new NotFoundException('User not found.');
    return me;
  }

  async getMyEnrollments(userId: string) {
    return this.prisma.studentEnrollment.findMany({
      where:   { studentId: userId },
      orderBy: { enrolledAt: 'desc' },
      select:  {
        id: true, gradeLevel: true, status: true, enrolledAt: true, endedAt: true,
        academicYear: { select: { id: true, name: true, isCurrent: true } },
        division:     { select: { id: true, code: true, name: true } },
        school:       { select: { id: true, name: true } },
      },
    });
  }

  async updateMe(userId: string, data: UpdateMeDto) {
    if (Object.keys(data).length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }
    return this.prisma.user.update({ where: { id: userId }, data, select: PROFILE_SELECT });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async studentFields(gradeLevel: GradeLevel, schoolId?: string) {
    if (schoolId) {
      const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException('School not found.');
    }
    return {
      gradeLevel,
      divisionId: await this.divisions.idForGrade(gradeLevel),
      ...(schoolId && { schoolId }),
    };
  }

  private async assertIdentityFree(username?: string, email?: string) {
    const or = [
      ...(username ? [{ username }] : []),
      ...(email ? [{ email }] : []),
    ];
    if (or.length === 0) return;
    const existing = await this.prisma.user.findFirst({ where: { OR: or }, select: { id: true } });
    if (existing) {
      throw new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');
    }
  }
}

/** `{ field: { from, to } }` for the fields whose value changed. */
function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>, fields: Array<keyof T & string>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (f in after && before[f] !== after[f]) out[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return out;
}
