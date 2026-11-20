import { homePlaceText, resolveHomePlace, sendsHomePlace } from '../common/home-place.js';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { TokenService } from '../auth/token.service.js';
import { AccountEmailsService } from '../notifications/account-emails.service.js';
import { BCRYPT_COST, PROFILE_SELECT, withProfileSteps } from '../auth/auth.service.js';
import { maskContacts } from './contact-masking.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { GradeLevel, Prisma } from '../generated/prisma/client.js';
import { AcademicYearsService } from '../academic-years/academic-years.service.js';
import { endCoachAssignments } from '../mentor-assignments/end-coach-assignments.js';
import { endTeacherSchools, revokeTeacherDelegations } from '../teachers/teacher-schools.service.js';
import { endAssignmentsOfUser } from '../teachers/teacher-student-ops.js';
import { SchoolAffiliationService } from '../schools/affiliations/school-affiliation.service.js';
import { resolveSchoolReference } from '../schools/school-reference.js';
import { RoleAssignmentPolicy } from '../auth/role-assignment.policy.js';
import type { AuthUser } from '../common/auth-user.js';
import { AccountStatusService } from './account-status.service.js';
import { ensureDefaultMembership } from '../programmes/programme-membership.js';
import { canonicalInterests } from './olympiad-interests.js';
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
  accountStatus: true,
  activatedAt: true,
  updatedAt:  true,
} as const;

/**
 * The filters of GET /admin/users, as a where clause — also used by bulk operations' filter selections.
 * Every User column read here must be in MEMBERSHIP_COLUMNS (src/users/bulk/bulk-rules.ts) and in the trigger
 * user_bulk_membership_guard (migration 20261207000100) — checked by bulk-rules.spec.ts.
 */
export function userListWhere(q: Omit<ListUsersQueryDto, 'page' | 'limit'>): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {
    ...(q.role       && { role: q.role }),
    ...(q.divisionId && { divisionId: q.divisionId }),
    ...(q.gradeLevel && { gradeLevel: q.gradeLevel }),
    ...(q.schoolId   && { schoolId: q.schoolId }),
    ...(q.isApproved !== undefined && { isApproved: q.isApproved }),
    ...(q.isActive   !== undefined && { isActive: q.isActive }),
    ...(q.accountStatus && { accountStatus: q.accountStatus }),
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
  return where;
}

/** The reason recorded when PATCH /admin/users/:id/status suspends an account (that route takes no reason). */
export const LEGACY_SUSPEND_REASON = 'Suspended by an administrator (status switch).';

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
    private readonly affiliations: SchoolAffiliationService,
    private readonly accountStatus: AccountStatusService,
  ) {}

  // ─── List users with optional filters ──────────────────────────────────────
  async findAll(q: ListUsersQueryDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = userListWhere(q);

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: SAFE_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.user.count({ where }),
    ]);

    // Primary teacher (owner decision 2026-11-19): each TEACHER row says whether the teacher is the primary teacher of a
    // school (PRIMARY), only a secondary one (SECONDARY) or linked to no school (null). One grouped query per page.
    const teacherIds = users.filter((u) => u.role === 'TEACHER').map((u) => u.id);
    const roles = new Map<string, 'PRIMARY' | 'SECONDARY'>();
    if (teacherIds.length > 0) {
      const groups = await this.prisma.teacherSchoolAssignment.groupBy({
        by: ['teacherId', 'role'], where: { teacherId: { in: teacherIds }, isActive: true }, _count: { _all: true },
      });
      for (const g of groups) if (g.role === 'PRIMARY' || !roles.has(g.teacherId)) roles.set(g.teacherId, g.role);
    }

    // Lists show phone numbers masked (ACC-16): the full numbers only on one account (GET /admin/users/:id).
    // Data minimisation (ACC-16 / SEC-03): phones masked and no date of birth in a list; GET /admin/users/:id has both.
    return paginated(users.map(({ dateOfBirth: _dob, ...row }) => maskContacts(
      row.role === 'TEACHER' ? { ...row, teacherSchoolRole: roles.get(row.id) ?? null } : row,
    )), total, page, limit);
  }


  // ─── Create a user (admin) ─────────────────────────────────────────────────
  async create(data: CreateUserDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, data.role ?? 'STUDENT');
    await this.assertIdentityFree(data.username, data.email);

    const role = data.role ?? 'STUDENT';
    // An existing, active school by id or code (PR B); the claim re-checks it under a row lock.
    if (role === 'STUDENT') data = { ...data, schoolId: (await this.schoolFromReference(data, true)) ?? undefined };
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
        // An Administrator's choice of school is a claim too: PENDING until verified.
        if (data.schoolId) {
          await this.affiliations.claim(tx, {
            studentId: created.id, schoolId: data.schoolId, source: 'ADMIN', reason: 'NEW_CLAIM', actor: { actorId: caller.id, actorRole: caller.role },
          });
        }
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
  /**
   * `opts.stepUpVerified`: the caller's password was already checked for this request (bulk role assignment checks it
   * once when the operation is created and never stores it). `opts.inTransaction` runs inside the update's transaction,
   * after the change is written (bulk operations record their item result there, so both commit or neither does).
   */
  async update(
    id: string, data: UpdateUserDto, caller: CallerCtx,
    opts: {
      stepUpVerified?: boolean;
      inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
      /** Run inside this OUTER transaction (bulk operations); post-commit notices are then queued in afterCommit. */
      tx?: Prisma.TransactionClient;
      afterCommit?: Array<() => Promise<void>>;
    } = {},
  ) {
    const existing = await this.prisma.user.findUnique({ where: { id }, select: EDIT_STATE_SELECT });
    if (!existing) throw new NotFoundException(`User ${id} not found.`);
    await this.roles.assertCanManage(caller, existing.role);

    if (Object.keys(data).filter((k) => k !== 'currentPassword').length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }
    // The shared seeded account is never promoted to Super Admin, nor renamed out of that rule (P1-08 hardening).
    this.roles.assertSharedAccountRules(existing, { role: data.role, username: data.username });
    // Subject interests are edited here for Coach accounts only (coachOlympiadInterests); students edit theirs on PATCH /me.
    if (data.olympiadInterests !== undefined && (data.role ?? existing.role) !== 'MENTOR') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INTERESTS_COACH_ONLY', 'Olympiad interests can be edited here for Coach accounts only.');
    }
    // schoolCode → the school's id (PR B). Not required to be active here: re-sending a student's
    // current school creates no claim; a NEW claim for an inactive school is refused by claim().
    if (data.schoolCode !== undefined) {
      if (data.schoolId === null) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_REFERENCE_MISMATCH', 'schoolId: null clears the school; do not send a schoolCode with it.');
      }
      const { schoolCode: _code, ...rest } = data;
      data = { ...rest, schoolId: (await this.schoolFromReference(data, false))! };
    }
    if (id === caller.id && data.role && data.role !== existing.role) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
    }
    const roleChange = !!data.role && data.role !== existing.role;
    if (roleChange) await this.roles.assertCanAssign(caller, data.role!, 'roleChange');
    if (roleChange && (PRIVILEGED.includes(existing.role) || PRIVILEGED.includes(data.role!))) {
      if (!opts.stepUpVerified) await this.assertStepUp(caller, data.currentPassword);
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
      // Stored in the fixed order, like the coach's own edit (PATCH /me); information only.
      ...(data.olympiadInterests !== undefined && { olympiadInterests: canonicalInterests(data.olympiadInterests) }),
      // Home location (homeLocationRules), any role.
      ...(await this.homeUpdate(data)),
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
      // Mentors and admins carry no student data (their home location, homeLocationRules, is kept).
      Object.assign(updateData, { gradeLevel: null, divisionId: null, schoolId: null,
        ...(data.homeLocation !== undefined && { homeLocation: data.homeLocation }) });
    }

    const placementChanged =
      role !== existing.role || (grade && grade !== existing.gradeLevel) || data.schoolId !== undefined;

    const actor = { actorId: caller.id, actorRole: caller.role };
    const endsSessions = Boolean(data.password || data.role);
    const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => (opts.tx ? fn(opts.tx) : this.prisma.$transaction(fn));
    const user = await inTx(async (tx) => {
      // Lock the user row, then re-read it. Everything above — authorization, the role rules,
      // step-up, and the update itself (role, grade, division, school) — was prepared from
      // `existing`, read before this transaction. If another edit committed in between, writing
      // this one would silently restore stale values (e.g. a demoted Administrator's role), so it
      // is refused instead; the caller reloads and retries. Concurrent edits of this user wait here.
      // A role or password change ends the user's sessions below: take the session lock FIRST
      // (lock order sessions → User row, token.service.ts), or a refresh of this user — which holds
      // the session lock and needs a KEY SHARE lock on this row — would deadlock with this edit.
      if (endsSessions) await this.tokens.lockSessions(tx, id);
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${id} FOR UPDATE`;
      const locked = await tx.user.findUnique({ where: { id }, select: EDIT_STATE_SELECT });
      if (!locked) throw new NotFoundException(`User ${id} not found.`);
      if (changedSince(existing, locked)) {
        throw new AppError(HttpStatus.CONFLICT, 'USER_CHANGED_CONCURRENTLY',
          'This user was changed by someone else in the meantime. Reload the user and try again.');
      }
      // The coach's interests before this edit (read under the row lock), for the audit entry.
      const interestsBefore = data.olympiadInterests !== undefined
        ? (await tx.user.findUniqueOrThrow({ where: { id }, select: { olympiadInterests: true } })).olympiadInterests
        : undefined;

      // School affiliation follows the student's school and role, in this transaction:
      //   leaving STUDENT            → the current claim is superseded (ROLE_CHANGE);
      //   becoming STUDENT, a school → a new PENDING claim;
      //   another school             → the current claim is superseded and a new PENDING one created;
      //   the same school            → nothing changes (a VERIFIED claim stays VERIFIED).
      // The old claim ends BEFORE the User row changes and the new one is created after it, so
      // every statement leaves the student consistent (M10).
      // The student's school after this edit: omitted → the locked (committed) school is kept;
      // an id → that school; explicit null → cleared.
      const nextSchoolId = role !== 'STUDENT' ? null : data.schoolId !== undefined ? data.schoolId : locked.schoolId;
      const nextClaim = roleChange || data.schoolId !== undefined
        ? await this.affiliations.beginUserChange(tx, {
            id, isStudent: role === 'STUDENT', becameStudent: role === 'STUDENT' && existing.role !== 'STUDENT', schoolId: nextSchoolId,
          }, actor)
        : null;

      const updated = await tx.user.update({
        where: { id }, data: updateData,
        select: { role: true, gradeLevel: true, divisionId: true, schoolId: true, firstName: true, lastName: true, username: true, email: true, homeLocation: true, olympiadInterests: true },
      });
      if (nextClaim) await this.affiliations.claim(tx, nextClaim);
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

      // A coach or Head Coach who changes role keeps no course × division scope:
      // their assignments are deactivated (kept as history) in the same transaction
      // (a former coach's assignments never become a Head Coach's, H4).
      if ((existing.role === 'MENTOR' || existing.role === 'HEAD_COACH') && role !== existing.role) {
        await endCoachAssignments(tx, this.audit, id, actor, { from: existing.role, to: role });
      }


      // A Teacher who changes role keeps no school scope (P1-11): their school assignments end here.
      if (existing.role === 'TEACHER' && role !== 'TEACHER') {
        await endTeacherSchools(tx, this.audit, id, actor, { from: existing.role, to: role });
      }
      // Teacher–student assignments of a Teacher or Student whose role changes end too (kept as history).
      if ((existing.role === 'TEACHER' || existing.role === 'STUDENT') && role !== existing.role) {
        await endAssignmentsOfUser(tx, this.audit, id, actor);
      }
      // Any role change revokes the user's teacher delegations (P1-11): a later return to
      // TEACHER never brings old grants back — an Administrator grants them again explicitly.
      if (existing.role !== role) {
        await revokeTeacherDelegations(tx, this.audit, id, actor, { from: existing.role, to: role });
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
      const changes: Record<string, { from: unknown; to: unknown }> =
        diff(existing, updated, ['firstName', 'lastName', 'username', 'email', 'role', 'gradeLevel', 'divisionId', 'schoolId', 'homeLocation']);
      if (interestsBefore && interestsBefore.join() !== updated.olympiadInterests.join()) {
        changes.olympiadInterests = { from: interestsBefore, to: updated.olympiadInterests };
      }

      // A new e-mail address: links already e-mailed to the old address (invitation, e-mail
      // verification, password reset) stop working, in this transaction. Otherwise whoever holds
      // the old (e.g. mistyped) address could still activate the account or set its password.
      // The administrator re-sends an invitation or reset, which goes to the new address.
      const linksRevoked = changes.email ? await revokeEmailedLinks(tx, id) : undefined;
      await this.audit.log({
        ...actor, action: 'UPDATE_USER', entity: 'User', entityId: id,
        metadata: { changes, passwordChanged: !!data.password, ...(linksRevoked && { linksRevoked }) },
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
      if (endsSessions) await this.tokens.revokeAllForUser(id, tx);
      if (opts.inTransaction) await opts.inTransaction(tx);
      return tx.user.findUniqueOrThrow({ where: { id }, select: SAFE_SELECT });
    }).catch(lastSuperAdminConflict);

    if (roleChange && (existing.role === 'SUPER_ADMIN' || data.role === 'SUPER_ADMIN')) {
      const notice = () => this.notifySuperAdminChange(data.role === 'SUPER_ADMIN' ? 'Promotion to Super Administrator' : 'Super Administrator role removed', existing.username, caller.id);
      // Inside an outer transaction the notice must wait until that transaction has committed.
      if (opts.tx) opts.afterCommit?.push(notice); else await notice();
    }
    return user;
  }

  // ─── Suspend / activate / approve ───────────────────────────────────────────
  async updateStatus(id: string, data: UpdateUserStatusDto, caller: CallerCtx, requestId?: string | null) {
    if (id === caller.id && data.isActive === false) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own account.');
    }
    const before = await this.findOne(id);
    await this.roles.assertCanManage(caller, before.role);
    if (before.role === 'SUPER_ADMIN' && before.isActive && data.isActive === false) await this.assertNotLastSuperAdmin(id);

    // isActive is the compatible view of the account states: false → SUSPENDED, true → ACTIVE (from SUSPENDED or
    // DEACTIVATED; an archived account is restored with POST /admin/users/:id/status-changes). Recorded in the
    // status history like any change (AccountStatusService).
    if (data.isActive !== undefined && data.isActive !== before.isActive) {
      if (data.isActive && before.accountStatus === 'ARCHIVED') {
        throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATUS_TRANSITION',
          'An archived account is restored with POST /admin/users/:id/status-changes (with a reason).', { from: 'ARCHIVED', to: 'ACTIVE' });
      }
      await this.accountStatus.change(id,
        { toStatus: data.isActive ? 'ACTIVE' : 'SUSPENDED', reason: data.isActive ? null : LEGACY_SUSPEND_REASON },
        caller as AuthUser, { requestId });
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where:  { id },
        data:   { isApproved: data.isApproved },
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
    // Account states (2026-11-16): accounts are never deleted through the API — archive them instead (their
    // submissions, results, discussions, enrolments, affiliations, notifications and audit history are kept).
    throw new AppError(HttpStatus.CONFLICT, 'PERMANENT_DELETION_DISABLED',
      'Accounts are not deleted. Archive the account instead (POST /admin/users/:id/status-changes with toStatus ARCHIVED).');
  }

  // (Annual promotion moved to AcademicYearsService.activate, which also keeps
  //  per-year enrolment history.)

  // ─── Self-service profile ───────────────────────────────────────────────────
  async getMe(userId: string) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    if (!me) throw new NotFoundException('User not found.');
    return withProfileSteps(me);
  }

  /**
   * An Administrator corrects a student's date of birth (owner approval 2026-11-18). users.manage and the right to
   * manage the account; STUDENT accounts only (the date-of-birth rules are the students'). The row is locked, so two
   * corrections never interleave; the audit row DATE_OF_BIRTH_CORRECTED records the old and new dates, the reason and
   * the Administrator, in the same transaction (both or neither). 409 DATE_OF_BIRTH_UNCHANGED for the same date.
   */
  async correctDateOfBirth(id: string, dto: { dateOfBirth: string; reason: string }, caller: AuthUser) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!target) throw new NotFoundException('User not found.');
    await this.roles.assertCanManage(caller, target.role);
    if (target.role !== 'STUDENT') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_STUDENT', 'Only a student\'s date of birth is recorded.');
    }
    const next = new Date(`${dto.dateOfBirth}T00:00:00Z`);
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ dob: Date | null }[]>`SELECT "dateOfBirth" AS dob FROM "User" WHERE "id" = ${id} FOR UPDATE`;
      const from = row?.dob ? row.dob.toISOString().slice(0, 10) : null;
      if (from === dto.dateOfBirth) {
        throw new AppError(HttpStatus.CONFLICT, 'DATE_OF_BIRTH_UNCHANGED', 'This is already the recorded date of birth.');
      }
      await tx.user.update({ where: { id }, data: { dateOfBirth: next } });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'DATE_OF_BIRTH_CORRECTED', entity: 'User', entityId: id,
        metadata: { from, to: dto.dateOfBirth, reason: dto.reason },
      }, tx);
    });
    return this.prisma.user.findUniqueOrThrow({ where: { id }, select: SAFE_SELECT });
  }

  /**
   * The date-of-birth history of an account (users.manage): every Administrator correction (old and new date, reason,
   * who, when) and when the student gave it at first sign-in (no value is recorded for that event). Newest first.
   */
  async dateOfBirthHistory(id: string, caller: AuthUser) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!target) throw new NotFoundException('User not found.');
    await this.roles.assertCanManage(caller, target.role);
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'User', entityId: id, action: { in: ['DATE_OF_BIRTH_CORRECTED', 'DATE_OF_BIRTH_ADDED'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, action: true, actorId: true, actorRole: true, metadata: true, createdAt: true },
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((a): a is string => !!a))];
    const actors = new Map((await this.prisma.user.findMany({
      where: { id: { in: actorIds } }, select: { id: true, username: true, firstName: true, lastName: true },
    })).map((u) => [u.id, u]));
    return rows.map((r) => {
      const m = (r.metadata ?? {}) as { from?: string | null; to?: string; reason?: string };
      return r.action === 'DATE_OF_BIRTH_CORRECTED'
        ? { kind: 'CORRECTED' as const, at: r.createdAt, from: m.from ?? null, to: m.to ?? null, reason: m.reason ?? null, by: r.actorId ? actors.get(r.actorId) ?? { id: r.actorId } : null, byRole: r.actorRole }
        : { kind: 'GIVEN_AT_FIRST_SIGN_IN' as const, at: r.createdAt, by: r.actorId ? actors.get(r.actorId) ?? { id: r.actorId } : null, byRole: r.actorRole };
    });
  }

  /**
   * First-sign-in date of birth (owner decision 9.3): a STUDENT without one gives it once (the registration rules:
   * a real past date, age 5–30 in Rwanda). 409 DATE_OF_BIRTH_ALREADY_SET when it is already recorded — it is not
   * changed here (an Administrator corrects it). Audited without the value.
   */
  async setOwnDateOfBirth(user: AuthUser, dateOfBirth: string) {
    const { count } = await this.prisma.user.updateMany({
      where: { id: user.id, role: 'STUDENT', dateOfBirth: null },
      data:  { dateOfBirth: new Date(`${dateOfBirth}T00:00:00Z`) },
    });
    if (count === 0) {
      throw new AppError(HttpStatus.CONFLICT, 'DATE_OF_BIRTH_ALREADY_SET', 'Your date of birth is already recorded. An administrator can correct it.');
    }
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'DATE_OF_BIRTH_ADDED', entity: 'User', entityId: user.id,
      metadata: { source: 'FIRST_SIGN_IN', dateOfBirthGiven: true },
    });
    return this.getMe(user.id);
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
    const { olympiadInterests, homeCountry: _c, homeProvince: _p, homeDistrict: _d, homeSector: _s, ...rest } = data;
    const home = await this.homeUpdate(data);
    return this.prisma.user.update({
      where: { id: userId },
      // Olympiad interests are stored in the fixed order (owner decision 8; information only).
      data:  { ...rest, ...home, ...(olympiadInterests !== undefined && { olympiadInterests: canonicalInterests(olympiadInterests) }) },
      select: PROFILE_SELECT,
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * The home-location columns of a profile edit (homeLocationRules), or {} when none is sent: the home country with,
   * for Rwanda, the official place ("Sector, District" kept in homeLocation unless sent); another country clears the
   * place. A place without the home country: 400 HOME_COUNTRY_REQUIRED.
   */
  private async homeUpdate(data: { homeCountry?: string; homeProvince?: string; homeDistrict?: string; homeSector?: string; homeLocation?: string }) {
    if (data.homeCountry === undefined) {
      if (sendsHomePlace(data)) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'HOME_COUNTRY_REQUIRED', 'Send the home country together with the home province, district and sector.');
      }
      return {};
    }
    const cols = await resolveHomePlace(this.prisma, data.homeCountry, data);
    return { ...cols, homeLocation: data.homeLocation ?? homePlaceText(cols) };
  }

  /** The id of the existing school a create / edit names by schoolId and/or schoolCode (null: none). */
  private async schoolFromReference(data: { schoolId?: string | null; schoolCode?: string }, requireActive: boolean) {
    const school = await resolveSchoolReference(this.prisma, { schoolId: data.schoolId, schoolCode: data.schoolCode }, { requireActive });
    return school?.id ?? null;
  }

  /** Student placement fields. `schoolId`: omitted → unchanged; an id → that (existing) school; null → cleared. */
  private async studentFields(gradeLevel: GradeLevel, schoolId?: string | null) {
    if (schoolId) {
      const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException('School not found.');
    }
    return {
      gradeLevel,
      divisionId: await this.divisions.idForGrade(gradeLevel),
      ...(schoolId !== undefined && { schoolId }),
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
  async assertStepUp(caller: CallerCtx, currentPassword: string | undefined) {
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

/** What an Administrator edit is prepared from (and re-checked against under the row lock). */
const EDIT_STATE_SELECT = {
  id: true, role: true, gradeLevel: true, username: true, email: true,
  firstName: true, lastName: true, divisionId: true, schoolId: true, homeLocation: true,
  isActive: true, activatedAt: true,
} as const;
type EditState = Prisma.UserGetPayload<{ select: typeof EDIT_STATE_SELECT }>;

/** True when any field the edit was prepared from differs from the locked, committed row. */
function changedSince(before: EditState, now: EditState): boolean {
  return (Object.keys(EDIT_STATE_SELECT) as Array<keyof EditState>).some((k) => {
    const a = before[k], b = now[k];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
}

const isLastSuperAdminError = (err: unknown) => String((err as Error)?.message ?? '').includes('LAST_SUPER_ADMIN');

/** The database trigger (M4) refuses the change → the same 409 as the service rule. */
function lastSuperAdminConflict(err: unknown): never {
  if (isLastSuperAdminError(err)) throw lastSuperAdmin();
  throw err;
}

/**
 * Retire every unused link e-mailed to a user: activation (invitation / e-mail verification)
 * tokens are revoked, password-reset tokens marked used (as a newer reset link does). Returns how
 * many of each were still usable, for the audit entry.
 */
export async function revokeEmailedLinks(tx: Prisma.TransactionClient, userId: string) {
  const now = new Date();
  const activation = await tx.accountActivationToken.updateMany({
    where: { userId, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data:  { revokedAt: now },
  });
  // Expired ones cannot be used anyway; retire them too so nothing stays open, without counting them.
  await tx.accountActivationToken.updateMany({ where: { userId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const passwordReset = await tx.passwordResetToken.updateMany({
    where: { userId, usedAt: null, expiresAt: { gt: now } },
    data:  { usedAt: now },
  });
  await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  return { activation: activation.count, passwordReset: passwordReset.count };
}
