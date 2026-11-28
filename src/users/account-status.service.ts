/**
 * Changing an account's state (2026-11-16): ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED (rules: account-status.ts;
 * runbook: docs/operations/account-states.md). Used by POST /admin/users/:id/status-changes, by the compatible
 * PATCH /admin/users/:id/status and by bulk operations.
 *
 * One change is one transaction, under the account's row lock:
 *   - the state (isActive follows it — database trigger user_account_status_sync);
 *   - leaving ACTIVE ends every session (refresh tokens, tokensValidAfter) and voids every unused password-reset
 *     and activation link, so no old link reopens a blocked account;
 *   - a UserStatusChange row (history) and a USER_STATUS_CHANGED audit row (before, after, reason, request id,
 *     bulk operation id).
 * A Teacher leaving ACTIVE stops being any school's primary teacher (TEACHER_PRIMARY_CLEARED; owner decision 2026-11-19 —
 * the links stay, as SECONDARY, and nobody is promoted). Nothing else is touched: submissions, results, discussions, enrolments, affiliations, notifications and audit
 * history stay linked to the account in every state.
 *
 * Who may: the transition's permission (users.changeStatus / users.suspend / users.archive) AND management of the
 * account's current role (RoleAssignmentPolicy — the Super Admin rules and SUPER_ADMIN_BOUNDARY_ENABLED apply).
 * Never one's own account. The last active Super Admin stays active (service check + the M4 trigger).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { PermissionService } from '../auth/permission.service.js';
import { RoleAssignmentPolicy } from '../auth/role-assignment.policy.js';
import { TokenService } from '../auth/token.service.js';
import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { isHiddenAccount } from '../common/access/super-admin-privacy.js';
import { AppError } from '../common/errors/app-error.js';
import { paginated } from '../common/pagination.js';
import type { AccountStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { roleFlagOn } from '../auth/role-assignment.policy.js';
import type { AppRole } from '../auth/permissions.js';
import { clearPrimaryOfAccount } from '../teachers/primary-teacher.js';
import { activateNowRefusal, checkTransition, confirmationRequired, permissionFor, stillBlockedBy, type SignInBlock } from './account-status.js';
import { lockCoaches } from '../test-management/question/question-store.js';
import { endQuestionWorkIfUnauthorised } from '../test-management/question/question-withdraw.js';

export interface StatusChangeContext {
  requestId?: string | null;
  /** Set by bulk operations. */
  operationId?: string | null;
  /**
   * Run inside this OUTER transaction instead of a new one (bulk operations: the operation and item rows are already
   * locked in it, and the item's result is recorded in it — one transaction for the whole item).
   */
  tx?: Prisma.TransactionClient;
  /** Runs inside the change's transaction after it is written (bulk operations record their item there). */
  inTransaction?: (tx: Prisma.TransactionClient, result: { stillBlockedBy: SignInBlock[] }) => Promise<void>;
}

/** The account fields a status change returns. */
export const STATUS_USER_SELECT = {
  id: true, username: true, firstName: true, lastName: true, role: true,
  accountStatus: true, isActive: true, isApproved: true, activatedAt: true, updatedAt: true,
} as const;

const HISTORY_SELECT = {
  id: true, fromStatus: true, toStatus: true, reason: true, actorRole: true, operationId: true, requestId: true, createdAt: true,
  actor: { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;

const isLastSuperAdminError = (err: unknown) => String((err as Error)?.message ?? '').includes('LAST_SUPER_ADMIN');
const lastSuperAdmin = () => new AppError(HttpStatus.CONFLICT, 'LAST_SUPER_ADMIN', 'At least one active Super Administrator must remain.');

@Injectable()
export class AccountStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly roles: RoleAssignmentPolicy,
    private readonly config: ConfigService,
  ) {}

  /** Moves the account to `toStatus`. Throws a refusal (nothing changed) or returns the account and the history row. */
  async change(
    targetId: string,
    input: { toStatus: AccountStatus; reason?: string | null; confirm?: boolean },
    caller: AuthUser,
    ctx: StatusChangeContext = {},
  ): Promise<{ user: Record<string, unknown>; change: Record<string, unknown>; stillBlockedBy: SignInBlock[] }> {
    if (targetId === caller.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_CHANGE_OWN_STATUS', 'You cannot change the status of your own account.');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, accountStatus: true } });
    // A Super Administrator does not exist for anyone else (Super Administrator privacy): the same 404.
    if (!target || isHiddenAccount(caller, target)) throw new NotFoundException(`User ${targetId} not found.`);
    await this.roles.assertCanManage(caller, target.role);
    this.assertAllowed(target.accountStatus, input.toStatus, input.reason, caller, input.confirm);
    const reason = input.reason?.trim() || null;

    try {
      const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => (ctx.tx ? fn(ctx.tx) : this.prisma.$transaction(fn));
      return await inTx(async (tx) => {
        // Question-level marking lock order (L1 coach → User row): a claim holds L1 and then a KEY SHARE on the coach's row.
        await lockCoaches(tx, [targetId]);
        // Row lock: concurrent changes of the same account are serialised and re-checked against the current state.
        // FOR NO KEY UPDATE (not FOR UPDATE): it serialises every update of the row just the same, but does not conflict
        // with the KEY SHARE locks foreign-key inserts take (e.g. a bulk operation's creation referencing this account).
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${targetId} FOR NO KEY UPDATE`;
        const current = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { role: true, accountStatus: true } });
        if (current.role !== target.role) await this.roles.assertCanManage(caller, current.role);
        this.assertAllowed(current.accountStatus, input.toStatus, input.reason, caller, input.confirm);
        if (current.role === 'SUPER_ADMIN' && current.accountStatus === 'ACTIVE' && input.toStatus !== 'ACTIVE') {
          const others = await tx.user.count({ where: { role: 'SUPER_ADMIN', isActive: true, id: { not: targetId } } });
          if (others === 0) throw lastSuperAdmin();
        }

        // Only the state changes: activation, approval, the failed-login lock and the role are never touched.
        const updated = await tx.user.update({
          where: { id: targetId },
          data: { accountStatus: input.toStatus, isActive: input.toStatus === 'ACTIVE' },
          select: { ...STATUS_USER_SELECT, lockedUntil: true },
        });
        const { lockedUntil, ...user } = updated;
        const blocks = input.toStatus === 'ACTIVE'
          ? stillBlockedBy({ activatedAt: updated.activatedAt, isApproved: updated.isApproved, lockedUntil }, roleFlagOn(updated.role as AppRole, this.config))
          : [];
        if (input.toStatus !== 'ACTIVE') {
          const now = new Date();
          await this.tokens.revokeAllForUser(targetId, tx);
          await tx.passwordResetToken.updateMany({ where: { userId: targetId, usedAt: null }, data: { usedAt: now } });
          await tx.accountActivationToken.updateMany({ where: { userId: targetId, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
        }
        const change = await tx.userStatusChange.create({
          data: {
            userId: targetId, fromStatus: current.accountStatus, toStatus: input.toStatus, reason,
            actorId: caller.id, actorRole: caller.role, operationId: ctx.operationId ?? null, requestId: ctx.requestId ?? null,
          },
          select: HISTORY_SELECT,
        });
        await this.audit.log({
          actorId: caller.id, actorRole: caller.role, action: 'USER_STATUS_CHANGED', entity: 'User', entityId: targetId,
          metadata: {
            before: { accountStatus: current.accountStatus }, after: { accountStatus: input.toStatus },
            reason, requestId: ctx.requestId ?? null, operationId: ctx.operationId ?? null, statusChangeId: change.id,
            sessionsEnded: input.toStatus !== 'ACTIVE',
            ...(input.toStatus === 'ACTIVE' && { stillBlockedBy: blocks }),
            ...(input.confirm === true && { confirmed: true }),
          },
        }, tx);
        // Primary teacher (owner decision 2026-11-19): an account that is not ACTIVE is never a school's primary teacher.
        // Its schools are left without one (nobody is promoted; an Administrator chooses); reactivation restores nothing.
        if (input.toStatus !== 'ACTIVE' && current.role === 'TEACHER') {
          await clearPrimaryOfAccount(tx, this.audit, targetId, { actorId: caller.id, actorRole: caller.role },
            { reason: 'ACCOUNT_STATUS', toStatus: input.toStatus, statusChangeId: change.id });
        }
        // A coach whose account is no longer ACTIVE may not mark: their open question claims and reserved returns end now.
        if (input.toStatus !== 'ACTIVE' && current.role === 'MENTOR') {
          await endQuestionWorkIfUnauthorised(tx, targetId, { id: caller.id, role: caller.role }, `Account ${input.toStatus.toLowerCase()}`);
        }
        if (ctx.inTransaction) await ctx.inTransaction(tx, { stillBlockedBy: blocks });
        return { user, change, stillBlockedBy: blocks };
      });
    } catch (err) {
      if (isLastSuperAdminError(err) && !(err instanceof AppError)) throw lastSuperAdmin();
      throw err;
    }
  }

  /**
   * "Activate now" (owner 2026-11-24; POST /admin/users/:id/activate-now and bulk action activateNow): an account that
   * is ACTIVE but never activated (activatedAt null — "Awaiting setup") and has its own password becomes activated, so
   * the person signs in without confirming their e-mail. Needs users.changeStatus and the right to manage the account's
   * role (the same rules as a status change). In one transaction under the account's row lock: activatedAt = now; the
   * account's unused activation links (EMAIL_VERIFICATION, INVITATION) are revoked, never deleted; audit ACTIVATE_ACCOUNT
   * { via: 'admin', activatedBy, … } with the administrator as the actor. No e-mail is sent.
   * Refusals (409, nothing changed): ACCOUNT_NOT_ACTIVE, ALREADY_ACTIVATED, NO_PASSWORD_YET (account-status.ts).
   */
  async activateNow(
    targetId: string,
    caller: AuthUser,
    ctx: Pick<StatusChangeContext, 'requestId' | 'operationId' | 'tx'> = {},
  ): Promise<{ user: Record<string, unknown>; stillBlockedBy: SignInBlock[]; message: string }> {
    if (targetId === caller.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_CHANGE_OWN_STATUS', 'You cannot activate your own account.');
    }
    const db = ctx.tx ?? this.prisma;
    const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, role: true } });
    if (!target || isHiddenAccount(caller, target)) throw new NotFoundException(`User ${targetId} not found.`);
    await this.roles.assertCanManage(caller, target.role);
    if (!this.permissions.has(caller, 'users.changeStatus')) {
      throw new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission: 'users.changeStatus' });
    }

    const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => (ctx.tx ? fn(ctx.tx) : this.prisma.$transaction(fn));
    return inTx(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${targetId} FOR NO KEY UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: targetId }, select: { role: true, accountStatus: true, activatedAt: true, passwordHash: true },
      });
      if (current.role !== target.role) await this.roles.assertCanManage(caller, current.role);
      const refusal = activateNowRefusal({ accountStatus: current.accountStatus, activatedAt: current.activatedAt, hasPassword: current.passwordHash !== null });
      if (refusal) throw new AppError(HttpStatus.CONFLICT, refusal.code, refusal.message, { accountStatus: current.accountStatus });

      const now = new Date();
      const updated = await tx.user.update({
        where: { id: targetId }, data: { activatedAt: now }, select: { ...STATUS_USER_SELECT, lockedUntil: true },
      });
      const { lockedUntil, ...user } = updated;
      const revoked = await tx.accountActivationToken.updateMany({
        where: { userId: targetId, usedAt: null, revokedAt: null, purpose: { in: ['EMAIL_VERIFICATION', 'INVITATION'] } },
        data: { revokedAt: now },
      });
      const blocks = stillBlockedBy({ activatedAt: updated.activatedAt, isApproved: updated.isApproved, lockedUntil }, roleFlagOn(updated.role as AppRole, this.config));
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'ACTIVATE_ACCOUNT', entity: 'User', entityId: targetId,
        metadata: {
          via: 'admin', activatedBy: caller.id, linksRevoked: revoked.count,
          requestId: ctx.requestId ?? null, operationId: ctx.operationId ?? null, stillBlockedBy: blocks,
        },
      }, tx);
      const message = blocks.length === 0
        ? 'The account is active. The person can sign in now.'
        : 'The account is activated. Something else still stops the person signing in: see stillBlockedBy.';
      return { user, stillBlockedBy: blocks, message };
    });
  }

  /** The account's state changes, newest first. A Super Administrator's only for a Super Administrator viewer (privacy). */
  async history(targetId: string, query: { page?: number; limit?: number }, viewer: CallerCtx) {
    const exists = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, accountStatus: true } });
    if (!exists || isHiddenAccount(viewer, exists)) throw new NotFoundException(`User ${targetId} not found.`);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.UserStatusChangeWhereInput = { userId: targetId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.userStatusChange.findMany({ where, select: HISTORY_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.userStatusChange.count({ where }),
    ]);
    return { ...paginated(rows, total, page, limit), accountStatus: exists.accountStatus };
  }

  private assertAllowed(from: AccountStatus, to: AccountStatus, reason: string | null | undefined, caller: AuthUser, confirm?: boolean) {
    const refusal = checkTransition(from, to, reason);
    if (refusal) {
      throw new AppError(refusal.code === 'REASON_REQUIRED' ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT, refusal.code, refusal.message,
        { from, to });
    }
    if (confirmationRequired(from, to) && confirm !== true) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CONFIRMATION_REQUIRED',
        'Please confirm that you want to restore this archived account.', { from, to });
    }
    const needed = permissionFor(from, to);
    if (!this.permissions.has(caller, needed)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission: needed });
    }
  }
}
