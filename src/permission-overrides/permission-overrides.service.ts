/**
 * Individual permission overrides (P1-09; plan §6.3, §6.4, §11.3).
 *
 * Set by a Super Admin only (route permission permissions.manageOverrides),
 * validated against the approved list in code (override-policy.ts):
 *   - never for the actor themselves, never on a SUPER_ADMIN;
 *   - DENY: any default permission of the target's role (TEACHER, STUDENT,
 *     COACH, HEAD_COACH, ADMIN);
 *   - GRANT: only assignments.prepare for a TEACHER, only for a course ×
 *     division where the teacher already has an active TeacherAssignment.
 *     TeacherAssignment arrives with P1-11 (M6); until then no teacher has one,
 *     so every GRANT is refused (400 OVERRIDE_NOT_ALLOWED);
 *   - never grantable permissions are refused even if the list were edited.
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
import { DENIABLE_ROLES, GRANTABLE, overrideRefusal } from '../auth/override-policy.js';
import { PermissionService } from '../auth/permission.service.js';
import { NEVER_GRANTABLE, PERMISSIONS, ROLE_GRANTS, ROLE_LABELS, type AppRole } from '../auth/permissions.js';
import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateOverrideDto } from './dto/create-override.dto.js';

const SELECT = {
  id: true, permission: true, effect: true, courseId: true, divisionId: true, reason: true, expiresAt: true,
  createdAt: true, revokedAt: true, revokeReason: true,
  createdBy: { select: { id: true, username: true } },
  revokedBy: { select: { id: true, username: true } },
} as const;

/** Namespace of the per-user advisory lock taken while creating overrides (any fixed int, unique to this purpose). */
const OVERRIDE_LOCK_NAMESPACE = 4209;

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
  ) {}

  async list(userId: string) {
    await this.requireUser(userId);
    const rows = await this.prisma.userPermissionOverride.findMany({ where: { userId }, select: SELECT, orderBy: { createdAt: 'desc' } });
    const now = Date.now();
    return rows.map((r) => ({ ...r, active: r.revokedAt === null && (r.expiresAt === null || r.expiresAt.getTime() > now) }));
  }

  async create(userId: string, dto: CreateOverrideDto, actor: CallerCtx) {
    const target = await this.requireUser(userId);
    if (target.id === actor.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'OVERRIDE_NOT_ALLOWED', 'You cannot set an override on your own account.', { reason: 'self' });
    }
    if (!(PERMISSIONS as readonly string[]).includes(dto.permission)) throw notAllowed('unknown permission');
    const refusal = overrideRefusal(target.role, dto.permission, dto.effect);
    if (refusal) throw notAllowed(refusal, { role: target.role, permission: dto.permission, effect: dto.effect });

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw notAllowed('expiresAt must be in the future');

    let courseId: string | null = null;
    let divisionId: string | null = null;
    if (dto.effect === 'GRANT') {
      if (!dto.courseId || !dto.divisionId) throw notAllowed('a GRANT needs the course × division it applies to');
      // Only inside the teacher's existing scope: an active TeacherAssignment for this
      // course × division. TeacherAssignment (M6) arrives with P1-11; none exists yet.
      if (!(await this.hasActiveTeacherAssignment(target.id, dto.courseId, dto.divisionId))) {
        throw notAllowed('outside the user’s existing scope (no active teacher assignment for this course × division)');
      }
      courseId = dto.courseId; divisionId = dto.divisionId;
    } else if (dto.courseId || dto.divisionId) {
      throw notAllowed('a DENY applies to the whole permission; omit courseId and divisionId');
    }

    return this.prisma.$transaction(async (tx) => {
      // Concurrency (multi-instance safe): creations for the same user are serialised by a
      // PostgreSQL transaction-scoped advisory lock, released at commit/rollback. The duplicate
      // check runs INSIDE the lock (after any concurrent creation has committed), so two
      // concurrent requests can never both pass it. (A unique index cannot express "active":
      // that depends on expiresAt > now, and an expired or revoked row must not block a new one.)
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${OVERRIDE_LOCK_NAMESPACE}::int, hashtext(${userId}))::text`;
      const duplicate = await tx.userPermissionOverride.findFirst({
        where: {
          userId, permission: dto.permission, effect: dto.effect, courseId, divisionId, revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      });
      if (duplicate) throw new AppError(HttpStatus.CONFLICT, 'OVERRIDE_EXISTS', 'An identical active override already exists.', { id: duplicate.id });
      const created = await tx.userPermissionOverride.create({
        data: { userId, permission: dto.permission, effect: dto.effect, courseId, divisionId, reason: dto.reason, expiresAt, createdById: actor.id },
        select: SELECT,
      });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'PERMISSION_OVERRIDE_CREATE', entity: 'UserPermissionOverride', entityId: created.id,
        metadata: {
          targetUserId: userId, targetRole: target.role, permission: dto.permission, effect: dto.effect,
          scope: courseId ? { courseId, divisionId } : null, reason: dto.reason, expiresAt,
          previous: null, next: { active: true },
        },
      }, tx);
      return { ...created, active: true };
    });
  }

  async revoke(userId: string, overrideId: string, actor: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      // Atomic: only an UNREVOKED row is updated. A concurrent revoke waits on the row lock,
      // re-checks the condition after the first commits, updates nothing and gets 409 — so
      // exactly one request revokes and writes the audit row.
      const { count } = await tx.userPermissionOverride.updateMany({
        where: { id: overrideId, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedById: actor.id },
      });
      if (count === 0) {
        const exists = await tx.userPermissionOverride.findFirst({ where: { id: overrideId, userId }, select: { id: true } });
        if (!exists) throw new NotFoundException('Override not found.');
        throw new AppError(HttpStatus.CONFLICT, 'OVERRIDE_ALREADY_REVOKED', 'This override has already been revoked.');
      }
      const updated = await tx.userPermissionOverride.findUniqueOrThrow({ where: { id: overrideId }, select: SELECT });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'PERMISSION_OVERRIDE_REVOKE', entity: 'UserPermissionOverride', entityId: overrideId,
        metadata: { targetUserId: userId, permission: updated.permission, effect: updated.effect, previous: { active: true }, next: { active: false } },
      }, tx);
      return { ...updated, active: false };
    });
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
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  /** TeacherAssignment arrives with P1-11 (M6). Until then no teacher has an assignment. */
  private async hasActiveTeacherAssignment(_userId: string, _courseId: string, _divisionId: string): Promise<boolean> {
    return false;
  }
}
