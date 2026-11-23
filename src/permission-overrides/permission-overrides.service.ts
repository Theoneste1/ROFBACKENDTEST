/**
 * Individual permission overrides (P1-09; plan §6.3, §6.4, §11.3).
 *
 * Set by a Super Admin only (route permission permissions.manageOverrides),
 * validated against the approved list in code (override-policy.ts):
 *   - never for the actor themselves, never on a SUPER_ADMIN;
 *   - DENY: any default permission of the target's role (TEACHER, STUDENT,
 *     COACH, HEAD_COACH, ADMIN);
 *   - GRANT: only a teacher delegation (P1-11 — students.viewProfile,
 *     students.viewProgress, submissions.submitOnBehalf) for a TEACHER with at
 *     least one active school assignment; school scope, no course × division.
 *     Administrators may give and revoke these too (delegation mode, used by
 *     /admin/teachers/:id/delegations with users.manageTeachers) — nothing else;
 *     and users.impersonate for a HEAD_COACH ("view as", read only; global scope, owner 2026-11-23);
 *   - never grantable permissions are refused even if the list were edited.
 *   (A course × division GRANT of assignments.prepare to a TEACHER was removed from the
 *   approved list on 2026-11-14: it needed a TeacherAssignment, which does not exist under
 *   the school-based teacher design, so it was always refused. It is now refused by the
 *   policy itself — 400 OVERRIDE_NOT_ALLOWED, "not on the approved GRANT list for this role".)
 *
 * Create and revoke write their audit row in the SAME transaction as the change
 * (both happen or neither). Revocation is soft and applies on the next request
 * (overrides are read with the user on every request; nothing is cached).
 * Expiry needs no job: an override stops applying at expiresAt. The hourly job
 * only RECORDS lapsed overrides in the audit log (once each).
 */
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AuditService } from '../audit/audit.service.js';
import { DENIABLE_ROLES, GRANTABLE, TEACHER_DELEGATIONS, grantScopeOf, overrideRefusal } from '../auth/override-policy.js';
import { PermissionService } from '../auth/permission.service.js';
import { NEVER_GRANTABLE, PERMISSIONS, ROLE_GRANTS, ROLE_LABELS, type AppRole } from '../auth/permissions.js';
import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOverrideDto } from './dto/create-override.dto.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import { activeSchoolsOf, visibilityOf, type StudentScope } from '../teachers/teacher-scope.js';
import { lockSelections, OVERRIDE_LOCK_NAMESPACE } from '../teachers/teacher-student-ops.js';

const SELECT = {
  id: true, permission: true, effect: true, courseId: true, divisionId: true, reason: true, expiresAt: true,
  createdAt: true, revokedAt: true, revokeReason: true,
  // Teacher delegations: which students (TS-4), the students of a SELECTED one, and the TS-5 review flag.
  studentScope: true, reviewNeededAt: true, reviewReason: true,
  students: {
    where: { removedAt: null }, orderBy: { createdAt: 'asc' },
    select: { studentId: true, createdAt: true, student: { select: { id: true, username: true, firstName: true, lastName: true } } },
  },
  createdBy: { select: { id: true, username: true } },
  revokedBy: { select: { id: true, username: true } },
} as const;


/** Administrators' teacher-delegation mode (P1-11). */
interface DelegationMode { delegation?: boolean }

function assertTeacherTarget(target: { role: string }) {
  if (target.role !== 'TEACHER') {
    throw new AppError(HttpStatus.BAD_REQUEST, 'OVERRIDE_NOT_ALLOWED', 'This override is not allowed: teacher delegations apply to Teacher accounts only.', { reason: 'not a teacher', role: target.role });
  }
}

/** The one permission an Administrator revokes / restores per teacher (owner 2026-11-21). */
const TEST_SUBMISSION = 'tests.submitForStudents';
/**
 * Course homework for their students (owner 2026-11-23, confirmed 2026-11-24): Teacher defaults, switched off and on per
 * teacher with ONE switch like test submission — seeing the students' homework progress and handing homework in for them.
 */
const HOMEWORK_SUBMISSION = ['students.viewProgress', 'submissions.submitOnBehalf'] as const;
export type TeacherSwitch = 'TEST' | 'HOMEWORK';
const SWITCHES: Readonly<Record<TeacherSwitch, { permissions: readonly string[]; noun: string; revoked: string; restored: string }>> = {
  TEST: { permissions: [TEST_SUBMISSION], noun: 'revoking test submission', revoked: 'TEACHER_TEST_SUBMISSION_REVOKED', restored: 'TEACHER_TEST_SUBMISSION_RESTORED' },
  HOMEWORK: { permissions: HOMEWORK_SUBMISSION, noun: 'switching off course homework', revoked: 'TEACHER_HOMEWORK_SUBMISSION_REVOKED', restored: 'TEACHER_HOMEWORK_SUBMISSION_RESTORED' },
};
const activeDenyOf = (userId: string, permissions: readonly string[]) => ({
  userId, permission: { in: [...permissions] }, effect: 'DENY' as const, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});

const notAllowed = (reason: string, details: Record<string, unknown> = {}) =>
  new AppError(HttpStatus.BAD_REQUEST, 'OVERRIDE_NOT_ALLOWED', `This override is not allowed: ${reason}.`, { reason, ...details });

@Injectable()
export class PermissionOverridesService {
  private readonly logger = new Logger(PermissionOverridesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly config: ConfigService,
    private readonly notices: DecisionNotificationsService,
  ) {}

  async list(userId: string, opts: DelegationMode = {}) {
    const target = await this.requireUser(userId);
    if (opts.delegation) assertTeacherTarget(target);
    const rows = await this.prisma.userPermissionOverride.findMany({
      where: { userId, ...(opts.delegation && { permission: { in: [...TEACHER_DELEGATIONS] } }) }, select: SELECT, orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((r) => ({ ...r, active: r.revokedAt === null && (r.expiresAt === null || r.expiresAt.getTime() > now) }));
  }

  async create(userId: string, dto: CreateOverrideDto & { studentScope?: StudentScope; studentIds?: string[] }, actor: CallerCtx, opts: DelegationMode = {}) {
    const target = await this.requireUser(userId);
    if (target.id === actor.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'OVERRIDE_NOT_ALLOWED', 'You cannot set an override on your own account.', { reason: 'self' });
    }
    // Delegation mode (Administrators): only a teacher delegation GRANT, only on a Teacher.
    if (opts.delegation) {
      assertTeacherTarget(target);
      if (dto.effect !== 'GRANT' || !(TEACHER_DELEGATIONS as readonly string[]).includes(dto.permission)) {
        throw notAllowed('not a teacher delegation', { permission: dto.permission, effect: dto.effect, delegations: TEACHER_DELEGATIONS });
      }
    }
    if (!(PERMISSIONS as readonly string[]).includes(dto.permission)) throw notAllowed('unknown permission');
    const refusal = overrideRefusal(target.role, dto.permission, dto.effect);
    if (refusal) throw notAllowed(refusal, { role: target.role, permission: dto.permission, effect: dto.effect });

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw notAllowed('expiresAt must be in the future');

    // Every approved GRANT is a teacher delegation (school scope): no override carries a course × division.
    const courseId: string | null = null;
    const divisionId: string | null = null;
    // Teacher delegations cover students by scope (TS-4): SCHOOL (default; every student seen through the schools),
    // ASSIGNED (students assigned to the teacher) or SELECTED (the listed students). Null on every other override.
    const delegationGrant = dto.effect === 'GRANT' && grantScopeOf(dto.permission) === 'school';
    const studentScope: StudentScope | null = delegationGrant ? (dto.studentScope ?? 'SCHOOL') : null;
    const selectedIds = studentScope === 'SELECTED' ? [...new Set(dto.studentIds ?? [])].sort() : [];
    if (!delegationGrant && dto.studentScope) throw notAllowed('a student scope applies only to a teacher delegation');
    if (studentScope !== 'SELECTED' && dto.studentIds?.length) throw notAllowed('studentIds apply only to a delegation for selected students');
    if (studentScope === 'SELECTED' && selectedIds.length === 0) throw notAllowed('a delegation for selected students needs studentIds');
    if (delegationGrant) {
      // Teacher delegation: checked per student on every request, never a course × division.
      if (dto.courseId || dto.divisionId) throw notAllowed('a teacher delegation applies to the teacher\'s students; omit courseId and divisionId');
      const schools = await activeSchoolsOf(this.prisma, target.id);
      if (studentScope === 'SCHOOL' && schools.length === 0) {
        throw notAllowed('outside the user’s existing scope (the teacher has no active school assignment)');
      }
      if (studentScope === 'ASSIGNED' && schools.length === 0
          && !(await this.prisma.teacherStudentAssignment.count({ where: { teacherId: target.id, isActive: true } }))) {
        throw notAllowed('outside the user’s existing scope (the teacher has no active school and no assigned student)');
      }
      // SELECTED: the listed students are checked inside the transaction below, under the selection lock.
    } else if (dto.effect === 'GRANT' && grantScopeOf(dto.permission) === 'global') {
      // A global GRANT (users.impersonate to a Head Coach): no course × division, no students; its own rules limit it.
      if (dto.courseId || dto.divisionId) throw notAllowed('this permission applies everywhere; omit courseId and divisionId');
    } else if (dto.effect === 'GRANT') {
      // Unreachable with the approved list (every other GRANT on it is a school-scoped delegation); fail closed.
      throw notAllowed('not on the approved GRANT list for this role', { role: target.role, permission: dto.permission, effect: dto.effect });
    } else if (dto.courseId || dto.divisionId) {
      throw notAllowed('a DENY applies to the whole permission; omit courseId and divisionId');
    }

    let notice: string | null = null;
    const saved = await this.prisma.$transaction(async (tx) => {
      // Concurrency (multi-instance safe): creations for the same user are serialised by a
      // PostgreSQL transaction-scoped advisory lock, released at commit/rollback. The duplicate
      // check runs INSIDE the lock (after any concurrent creation has committed), so two
      // concurrent requests can never both pass it. (A unique index cannot express "active":
      // that depends on expiresAt > now, and an expired or revoked row must not block a new one.)
      // Selected students: the selection lock first (lock order: selection, teacher), then visibility, so no TS-5
      // sweep can interleave between the check and the insert.
      if (studentScope === 'SELECTED') await lockSelections(tx);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${OVERRIDE_LOCK_NAMESPACE}::int, hashtext(${userId}))::text`;
      if (studentScope === 'SELECTED') {
        const seen = await visibilityOf(tx, target.id, await activeSchoolsOf(tx, target.id), selectedIds);
        const outside = selectedIds.filter((id) => !seen.has(id));
        if (outside.length) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'STUDENT_NOT_IN_TEACHER_SCOPE',
            'Some students are not seen by this teacher (not verified students of their schools, and not assigned to them).', { studentIds: outside });
        }
      }
      const duplicate = await tx.userPermissionOverride.findFirst({
        where: {
          userId, permission: dto.permission, effect: dto.effect, courseId, divisionId, revokedAt: null,
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
            // A delegation without a scope (written before scopes existed) is school-wide: the same as SCHOOL.
            studentScope === 'SCHOOL' ? { OR: [{ studentScope: 'SCHOOL' }, { studentScope: null }] } : { studentScope },
          ],
        },
        select: { id: true },
      });
      if (duplicate) throw new AppError(HttpStatus.CONFLICT, 'OVERRIDE_EXISTS', 'This person already has exactly this permission change. Nothing was added.', { id: duplicate.id });
      const created = await tx.userPermissionOverride.create({
        data: {
          userId, permission: dto.permission, effect: dto.effect, courseId, divisionId, reason: dto.reason, expiresAt, createdById: actor.id, studentScope,
          ...(selectedIds.length && { students: { create: selectedIds.map((studentId) => ({ studentId, addedById: actor.id })) } }),
        },
        select: SELECT,
      });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'PERMISSION_OVERRIDE_CREATE', entity: 'UserPermissionOverride', entityId: created.id,
        metadata: {
          targetUserId: userId, targetRole: target.role, permission: dto.permission, effect: dto.effect,
          scope: courseId ? { courseId, divisionId } : grantScopeOf(dto.permission) === 'school' && dto.effect === 'GRANT' ? 'SCHOOL' : null,
          reason: dto.reason, expiresAt, previous: null, next: { active: true },
          ...(studentScope && { studentScope }), ...(selectedIds.length && { studentIds: selectedIds }),
          ...(opts.delegation && { via: 'TEACHER_DELEGATION' }),
        },
      }, tx);
      // permissions.granted (Teachers, Coaches, Head Coaches; GRANT only), written with the grant.
      notice = await this.notices.enqueuePermissionsGranted(tx, target, [{ id: created.id, permission: created.permission, effect: created.effect }]);
      return { ...created, active: true };
    });
    this.notices.dispatchAfterCommit([notice]);
    return saved;
  }

  async revoke(userId: string, overrideId: string, actor: CallerCtx, opts: DelegationMode = {}) {
    if (opts.delegation) assertTeacherTarget(await this.requireUser(userId));
    // Delegation mode: an Administrator only ever touches teacher delegations (others: not found).
    const only = opts.delegation ? { permission: { in: [...TEACHER_DELEGATIONS] } } : {};
    return this.prisma.$transaction(async (tx) => {
      // Atomic: only an UNREVOKED row is updated. A concurrent revoke waits on the row lock,
      // re-checks the condition after the first commits, updates nothing and gets 409 — so
      // exactly one request revokes and writes the audit row.
      const { count } = await tx.userPermissionOverride.updateMany({
        where: { id: overrideId, userId, revokedAt: null, ...only }, data: { revokedAt: new Date(), revokedById: actor.id },
      });
      if (count === 0) {
        const exists = await tx.userPermissionOverride.findFirst({ where: { id: overrideId, userId, ...only }, select: { id: true } });
        if (!exists) throw new NotFoundException('Override not found.');
        throw new AppError(HttpStatus.CONFLICT, 'OVERRIDE_ALREADY_REVOKED', 'This override has already been revoked.');
      }
      const updated = await tx.userPermissionOverride.findUniqueOrThrow({ where: { id: overrideId }, select: SELECT });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'PERMISSION_OVERRIDE_REVOKE', entity: 'UserPermissionOverride', entityId: overrideId,
        metadata: {
          targetUserId: userId, permission: updated.permission, effect: updated.effect, previous: { active: true }, next: { active: false },
          ...(opts.delegation && { via: 'TEACHER_DELEGATION' }),
        },
      }, tx);
      return { ...updated, active: false };
    });
  }

  // ── A teacher's test submission for students (owner, 2026-11-21) ─────────────────────────────────────────────
  // Every Teacher submits tests for the students of their school by default (tests.submitForStudents). An Administrator
  // (users.manageTeachers) may revoke that one permission for one teacher, and restore it: a DENY override of exactly
  // tests.submitForStudents, read on every request like any override. The account, the sign-in and every other teacher
  // right are untouched; students' own submissions never depend on it.

  /** Whether this teacher may submit tests for their students now, and the revocation if any. */
  async teacherTestSubmission(userId: string) {
    return this.teacherSwitch(userId, 'TEST');
  }

  /** Revoke (allowed false, reason 3–500 required) or restore (allowed true) it. Idempotent; audited when it changes. */
  async setTeacherTestSubmission(userId: string, dto: { allowed: boolean; reason?: string }, actor: CallerCtx) {
    return this.setTeacherSwitch(userId, 'TEST', dto, actor);
  }

  /**
   * Course homework (owner 2026-11-23): whether this teacher may see their students' homework progress and hand homework
   * in for them now — false as soon as either is denied (the switch denies both).
   */
  async teacherHomeworkSubmission(userId: string) {
    return this.teacherSwitch(userId, 'HOMEWORK');
  }

  /** Switch it off (reason 3–500 required; both permissions) or on again (every such DENY lifted). Idempotent; audited when it changes. */
  async setTeacherHomeworkSubmission(userId: string, dto: { allowed: boolean; reason?: string }, actor: CallerCtx) {
    return this.setTeacherSwitch(userId, 'HOMEWORK', dto, actor);
  }

  /** A Teacher default switched off for one teacher: an active DENY override of (one of) exactly its permission(s). */
  private async teacherSwitch(userId: string, which: TeacherSwitch) {
    const target = await this.requireUser(userId);
    assertTeacherTarget(target);
    const deny = await this.prisma.userPermissionOverride.findFirst({
      where: activeDenyOf(userId, SWITCHES[which].permissions),
      orderBy: { createdAt: 'desc' },
      select: { id: true, reason: true, createdAt: true, createdBy: { select: { id: true, username: true, firstName: true, lastName: true } } },
    });
    return { userId, allowed: !deny, revokedAt: deny?.createdAt ?? null, reason: deny?.reason ?? null, revokedBy: deny?.createdBy ?? null };
  }

  private async setTeacherSwitch(userId: string, which: TeacherSwitch, dto: { allowed: boolean; reason?: string }, actor: CallerCtx) {
    const { permissions, noun, revoked, restored } = SWITCHES[which];
    const target = await this.requireUser(userId);
    assertTeacherTarget(target);
    if (target.id === actor.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'OVERRIDE_NOT_ALLOWED', 'You cannot change your own permissions.', { reason: 'self' });
    }
    const reason = dto.reason?.trim() ?? '';
    if (!dto.allowed && (reason.length < 3 || reason.length > 500)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', `Give a reason (3–500 characters) for ${noun}.`);
    }
    await this.prisma.$transaction(async (tx) => {
      // The same per-user lock as every override change: a concurrent revoke and restore apply one after the other.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${OVERRIDE_LOCK_NAMESPACE}::int, hashtext(${userId}))::text`;
      const active = await tx.userPermissionOverride.findMany({ where: activeDenyOf(userId, permissions), select: { id: true, permission: true } });
      // Switching off denies every permission of the switch not denied yet (one may already be, set by a Super Admin).
      const missing = permissions.filter((p) => !active.some((a) => a.permission === p));
      if (!dto.allowed && missing.length > 0) {
        const created: Array<{ id: string }> = [];
        for (const permission of missing) {
          created.push(await tx.userPermissionOverride.create({
            data: { userId, permission, effect: 'DENY', reason, createdById: actor.id }, select: { id: true },
          }));
        }
        await this.audit.log({
          actorId: actor.id, actorRole: actor.role, action: revoked, entity: 'User', entityId: userId,
          metadata: {
            // The test switch keeps its original metadata shape (one permission, overrideId).
            ...(permissions.length === 1 ? { overrideId: created[0].id, permission: permissions[0] } : { overrideIds: created.map((c) => c.id), permissions: missing }),
            reason, previous: { allowed: active.length === 0 }, next: { allowed: false },
          },
        }, tx);
      }
      if (dto.allowed && active.length > 0) {
        await tx.userPermissionOverride.updateMany({
          where: { id: { in: active.map((a) => a.id) }, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: actor.id, ...(reason && { revokeReason: reason }) },
        });
        await this.audit.log({
          actorId: actor.id, actorRole: actor.role, action: restored, entity: 'User', entityId: userId,
          metadata: {
            overrideIds: active.map((a) => a.id),
            ...(permissions.length === 1 ? { permission: permissions[0] } : { permissions: [...new Set(active.map((a) => a.permission))].sort() }),
            ...(reason && { reason }), previous: { allowed: false }, next: { allowed: true },
          },
        }, tx);
      }
    });
    return this.teacherSwitch(userId, which);
  }

  /** Of these Teacher ids, the ones whose test submission is revoked now (the Users list shows it). */
  async teachersWithoutTestSubmission(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.userPermissionOverride.findMany({
      where: { ...activeDenyOf('', [TEST_SUBMISSION]), userId: { in: [...ids] } },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /** GET /admin/users/:id/permissions — what the user can do now (role defaults ± active overrides). */
  async effectiveFor(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, role: true, divisionId: true, gradeLevel: true,
        permissionOverrides: {
          where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          select: { id: true, permission: true, effect: true, courseId: true, divisionId: true, expiresAt: true },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found.');
    const subject: AuthUser = { id: user.id, username: user.username, role: user.role, divisionId: user.divisionId, gradeLevel: user.gradeLevel, overrides: user.permissionOverrides };
    const effective = [...this.permissions.effective(subject)].map(([permission, scope]) => ({ permission, scope }));
    return {
      userId: user.id, role: user.role,
      roleLabel: Object.hasOwn(ROLE_LABELS, user.role) ? ROLE_LABELS[user.role as AppRole] : null,
      permissions: effective,
      overrides: user.permissionOverrides,
    };
  }

  /** GET /admin/permissions/catalogue — the code-defined catalogue and override policy. */
  catalogue() {
    return {
      permissions: [...PERMISSIONS],
      roles: Object.fromEntries(Object.entries(ROLE_GRANTS).map(([role, grants]) => [role, { label: ROLE_LABELS[role as AppRole], grants }])),
      overridePolicy: { grantable: GRANTABLE, deniableRoles: DENIABLE_ROLES, neverGrantable: [...NEVER_GRANTABLE] },
    };
  }

  /** Hourly: record (once) each override that has lapsed. Record only — it stopped applying at expiresAt. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'override-expiry-record' })
  async hourly() {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;
    try { await this.recordExpired(); } catch (err) { this.logger.error(`Override expiry record failed: ${(err as Error).message}`); }
  }

  async recordExpired(now = new Date()): Promise<number> {
    const lapsed = await this.prisma.userPermissionOverride.findMany({
      where: { revokedAt: null, expiryRecordedAt: null, expiresAt: { lte: now } },
      select: { id: true, userId: true, permission: true, effect: true, expiresAt: true },
    });
    for (const o of lapsed) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.userPermissionOverride.updateMany({ where: { id: o.id, expiryRecordedAt: null }, data: { expiryRecordedAt: now } });
        if (count === 0) return;   // recorded meanwhile by another instance
        await this.audit.log({
          actorId: null, actorRole: 'SYSTEM', action: 'PERMISSION_OVERRIDE_EXPIRED', entity: 'UserPermissionOverride', entityId: o.id,
          metadata: { targetUserId: o.userId, permission: o.permission, effect: o.effect, expiresAt: o.expiresAt },
        }, tx);
      });
    }
    return lapsed.length;
  }

  private async requireUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id }, select: { id: true, role: true, email: true, firstName: true, isActive: true, activatedAt: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }
}
