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
import { RoleAssignmentPolicy } from '../auth/role-assignment.policy.js';
import { ensureDefaultMembership } from '../programmes/programme-membership.js';
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
    private readonly roles:     RoleAssignmentPolicy,
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
    await this.roles.assertCanAssign(caller, data.role ?? 'STUDENT');
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
      await ensureDefaultMembership(tx, { id: created.id, role }, caller.id);   // students and coaches (P1-07, K6)
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
        isActive: true, activatedAt: true,
      },
    });
    if (!existing) throw new NotFoundException(`User ${id} not found.`);
    await this.roles.assertCanManage(caller, existing.role);

    if (Object.keys(data).filter((k) => k !== 'currentPassword').length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }
    if (id === caller.id && data.role && data.role !== existing.role) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
    }
    const roleChange = !!data.role && data.role !== existing.role;
    if (roleChange) await this.roles.assertCanAssign(caller, data.role!, 'roleChange');
    if (roleChange && (PRIVILEGED.includes(existing.role) || PRIVILEGED.includes(data.role!))) {
      await this.assertStepUp(caller, data.currentPassword);
    }
    if (roleChange && data.role === 'SUPER_ADMIN' && (existing.role !== 'ADMIN' || !existing.isActive || !existing.activatedAt)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_ASSIGNABLE',
        'Only an active, activated Administrator can be promoted to Super Administrator.', { role: 'SUPER_ADMIN' });
    }
    if (roleChange && existing.role === 'SUPER_ADMIN') await this.assertNotLastSuperAdmin(id);
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

      // Heading a programme = HEAD_COACH role + active membership (P1-10). A change
      // to or from HEAD_COACH ends every active membership in the same transaction,
      // so a promoted Student/Coach never inherits a programme to head, and a former
      // head keeps no membership; heads are then set explicitly (PUT …/heads).
      if (existing.role !== role && (existing.role === 'HEAD_COACH' || role === 'HEAD_COACH')) {
        const memberships = await tx.programmeMembership.findMany({ where: { userId: id, isActive: true }, select: { disciplineId: true } });
        if (memberships.length) {
          await tx.programmeMembership.updateMany({
            where: { userId: id, isActive: true }, data: { isActive: false, endedAt: new Date(), endedById: caller.id },
          });
          await this.audit.log({
            ...actor, action: 'PROGRAMME_MEMBERSHIPS_ENDED', entity: 'User', entityId: id,
            metadata: { reason: 'ROLE_CHANGE', from: existing.role, to: role, disciplineIds: memberships.map((m) => m.disciplineId) },
          }, tx);
        }
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
        if (existing.role === 'SUPER_ADMIN' || updated.role === 'SUPER_ADMIN') {
          await this.audit.log({
            ...actor, action: updated.role === 'SUPER_ADMIN' ? 'SUPER_ADMIN_PROMOTE' : 'SUPER_ADMIN_DEMOTE',
            entity: 'User', entityId: id, metadata: { from: existing.role, to: updated.role, stepUp: true },
          }, tx);
        }
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
    }).catch(lastSuperAdminConflict);

    if (roleChange && (existing.role === 'SUPER_ADMIN' || data.role === 'SUPER_ADMIN')) {
      await this.notifySuperAdminChange(data.role === 'SUPER_ADMIN' ? 'Promotion to Super Administrator' : 'Super Administrator role removed', existing.username, caller.id);
    }
    return user;
  }

  // ─── Suspend / activate / approve ───────────────────────────────────────────
  async updateStatus(id: string, data: UpdateUserStatusDto, caller: CallerCtx) {
    if (id === caller.id && data.isActive === false) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own account.');
    }
    const before = await this.findOne(id);
    await this.roles.assertCanManage(caller, before.role);
    if (before.role === 'SUPER_ADMIN' && before.isActive && data.isActive === false) await this.assertNotLastSuperAdmin(id);

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where:  { id },
        data:   { isActive: data.isActive, isApproved: data.isApproved },
        select: SAFE_SELECT,
      }).catch(lastSuperAdminConflict);
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
    await this.roles.assertCanManage(caller, user.role);
    if (user.role === 'SUPER_ADMIN' && user.isActive) await this.assertNotLastSuperAdmin(id);

    try {
      await this.prisma.user.delete({ where: { id } });
    } catch (err: any) {
      if (isLastSuperAdminError(err)) throw lastSuperAdmin();
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

  // ─── Super Admin safeguards (P1-08, plan §8.2) ───────────────────────────────

  /** Step-up: the acting user re-enters their own password (403 STEP_UP_REQUIRED). */
  private async assertStepUp(caller: CallerCtx, currentPassword: string | undefined) {
    const me = await this.prisma.user.findUnique({ where: { id: caller.id }, select: { passwordHash: true } });
    const ok = !!currentPassword && !!me?.passwordHash && (await bcrypt.compare(currentPassword, me.passwordHash));
    if (!ok) {
      throw new AppError(HttpStatus.FORBIDDEN, 'STEP_UP_REQUIRED',
        'Confirm with your current password to change an Administrator or Super Administrator role.');
    }
  }

  /** 409 LAST_SUPER_ADMIN when no OTHER active Super Admin would remain (the M4 trigger re-checks atomically). */
  private async assertNotLastSuperAdmin(targetId: string) {
    const others = await this.prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true, id: { not: targetId } } });
    if (others === 0) throw lastSuperAdmin();
  }

  private async notifySuperAdminChange(action: string, targetUsername: string, actorId: string) {
    const actor = await this.prisma.user.findUnique({ where: { id: actorId }, select: { username: true } });
    await this.accountEmails.superAdminChanged({ action, targetUsername, actorUsername: actor?.username ?? null });
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

/** Accounts whose role changes need step-up (plan §10.1). */
const PRIVILEGED: readonly string[] = ['ADMIN', 'SUPER_ADMIN'];

function lastSuperAdmin() {
  return new AppError(HttpStatus.CONFLICT, 'LAST_SUPER_ADMIN', 'At least one active Super Administrator must remain.');
}

const isLastSuperAdminError = (err: unknown) => String((err as Error)?.message ?? '').includes('LAST_SUPER_ADMIN');

/** The database trigger (M4) refuses the change → the same 409 as the service rule. */
function lastSuperAdminConflict(err: unknown): never {
  if (isLastSuperAdminError(err)) throw lastSuperAdmin();
  throw err;
}
