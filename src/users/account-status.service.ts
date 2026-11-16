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
 * Nothing else is touched: submissions, results, discussions, enrolments, affiliations, notifications and audit
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
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { paginated } from '../common/pagination.js';
import type { AccountStatus, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { roleFlagOn } from '../auth/role-assignment.policy.js';
import type { AppRole } from '../auth/permissions.js';
import { checkTransition, confirmationRequired, permissionFor, stillBlockedBy, type SignInBlock } from './account-status.js';

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
    if (!target) throw new NotFoundException(`User ${targetId} not found.`);
    await this.roles.assertCanManage(caller, target.role);
    this.assertAllowed(target.accountStatus, input.toStatus, input.reason, caller, input.confirm);
    const reason = input.reason?.trim() || null;

    try {
      const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => (ctx.tx ? fn(ctx.tx) : this.prisma.$transaction(fn));
      return await inTx(async (tx) => {
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
        if (ctx.inTransaction) await ctx.inTransaction(tx, { stillBlockedBy: blocks });
        return { user, change, stillBlockedBy: blocks };
      });
    } catch (err) {
      if (isLastSuperAdminError(err) && !(err instanceof AppError)) throw lastSuperAdmin();
      throw err;
    }
  }

  /** The account's state changes, newest first. */
  async history(targetId: string, query: { page?: number; limit?: number }) {
    const exists = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true, accountStatus: true } });
    if (!exists) throw new NotFoundException(`User ${targetId} not found.`);
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
        'Restoring an archived account must be confirmed explicitly (confirm: true).', { from, to });
    }
    const needed = permissionFor(from, to);
    if (!this.permissions.has(caller, needed)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission: needed });
    }
  }
}
