/**
 * BulkOperationsWorker — processes bulk operation items (2026-11-17; review fixes B and C).
 *
 * Claiming: every 5 seconds it claims up to 200 items — PENDING → PROCESSING with a claim token, `FOR UPDATE SKIP
 * LOCKED` — so several API instances can run it at once. A claim older than 5 minutes (a crashed worker) is claimed
 * again with a new token, also while the operation is cancelling, so every claimed item ends truthfully.
 *
 * Every recorded outcome equals what happened:
 *  - an item's result is written only by the claim that holds it (`outcome = PROCESSING AND claimToken = mine`);
 *  - the change and its result commit in ONE transaction, for every action: status changes (AccountStatusService),
 *    role and grade changes (UsersService.update) and e-mail deliveries. If the claim was lost (taken over after a
 *    stall), recording fails and the change is rolled back. A crash between the two is impossible: there is no
 *    "between" — after a crash the item is still PROCESSING, is claimed again, and the change is applied (once);
 *  - one item per (operation, account): an account is changed — and e-mailed — at most once per operation.
 *
 * Cancellation: cancel skips only PENDING items and marks the operation CANCELLING. Each item's transaction holds the
 * operation row FOR SHARE, so a cancel waits for an item that is being changed right now. A claimed item whose
 * processing starts after the cancel committed is recorded SKIPPED (CANCELLED) without any change. When no item is
 * pending or processing the operation ends (CANCELLING → CANCELLED, or its final status), once, under the operation's
 * row lock, with one BULK_OPERATION_FINISHED audit row. Counters are recomputed from the items.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../../audit/audit.service.js';
import { PermissionService } from '../../auth/permission.service.js';
import type { AuthUser } from '../../common/auth-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccountStatusService } from '../account-status.service.js';
import { UsersService } from '../users.service.js';
import { ACTION_RULES, BATCH_SIZE, finalStatus, SKIP_CODES, statusDecision, type BulkAction } from './bulk-rules.js';
import { refreshCounts } from './bulk-operations.service.js';

export interface ClaimedItem { id: string; operationId: string; userId: string; claimToken: string }
type Outcome = 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
type Op = { id: string; action: string; params: Prisma.JsonValue; reason: string | null; actorId: string | null; status: string; emailJobId: string | null };
type Tx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class BulkOperationsWorker {
  private readonly logger = new Logger(BulkOperationsWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly accountStatus: AccountStatusService,
    private readonly users: UsersService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {}

  @Interval('bulk-operations', 5_000)
  async tick() {
    if (this.config.get('WORKERS_ENABLED') === 'false' || this.running) return;
    this.running = true;
    const until = Date.now() + 20_000;
    try {
      while (Date.now() < until && (await this.processBatch()) > 0) { /* next batch */ }
    } catch (err) {
      this.logger.error(`Bulk operations batch failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Claims up to 200 items (PENDING → PROCESSING, one claim token) and processes them; returns how many it claimed. */
  async processBatch(): Promise<number> {
    const claimed = await this.claim();
    if (claimed.length === 0) return 0;

    const byOp = new Map<string, ClaimedItem[]>();
    for (const c of claimed) byOp.set(c.operationId, [...(byOp.get(c.operationId) ?? []), c]);

    for (const [opId, items] of byOp) {
      const op = await this.prisma.bulkOperation.findUniqueOrThrow({
        where: { id: opId }, select: { id: true, action: true, params: true, reason: true, actorId: true, status: true, emailJobId: true },
      });
      if (op.status === 'PENDING') {
        await this.prisma.bulkOperation.updateMany({ where: { id: opId, status: 'PENDING' }, data: { status: 'RUNNING', startedAt: new Date() } });
      }
      const actor = await this.loadActor(op);
      for (const item of items) {
        try {
          await this.processItem(op, actor, item);
        } catch (err) {
          // Unexpected (not a refusal): reported on the item — nothing was changed for it (the change and the result
          // share one transaction). If even that cannot be written, the claim expires and the item is retried.
          this.logger.error(`Bulk item ${item.id} failed: ${(err as Error).message}`);
          await this.record(this.prisma, item, 'FAILED', 'UNEXPECTED_ERROR', 'Unexpected error; nothing was changed for this account.');
        }
      }
      await this.finishIfDone(opId);
    }
    return claimed.length;
  }

  /** PENDING → PROCESSING (or a stale PROCESSING claim taken over), with a fresh claim token. */
  async claim(): Promise<ClaimedItem[]> {
    const token = randomUUID();
    return this.prisma.$queryRaw<ClaimedItem[]>`
      UPDATE "BulkOperationItem" i
      SET "outcome" = 'PROCESSING', "claimToken" = ${token}, "lockedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE i."id" IN (
        SELECT it."id" FROM "BulkOperationItem" it
          JOIN "BulkOperation" o ON o."id" = it."operationId"
         WHERE (it."outcome" = 'PENDING' AND o."status" IN ('PENDING', 'RUNNING'))
            OR (it."outcome" = 'PROCESSING' AND it."lockedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '5 minutes'
                AND o."status" IN ('PENDING', 'RUNNING', 'CANCELLING'))
         ORDER BY o."createdAt" ASC, it."id" ASC
         LIMIT ${BATCH_SIZE}
         FOR UPDATE OF it SKIP LOCKED
      )
      RETURNING i."id", i."operationId", i."userId", i."claimToken"`;
  }

  private async processItem(op: Op, actor: AuthUser | null, item: ClaimedItem) {
    // A cancel that committed before this item's processing started: nothing is changed for it.
    const now = await this.prisma.bulkOperation.findUniqueOrThrow({ where: { id: op.id }, select: { status: true } });
    if (now.status === 'CANCELLING' || now.status === 'CANCELLED') {
      return this.record(this.prisma, item, 'SKIPPED', 'CANCELLED', 'The operation was cancelled before this account was processed.');
    }
    const action = op.action as BulkAction;
    const params = (op.params ?? {}) as { role?: string; gradeLevel?: string; stepUpVerified?: boolean };
    if (!actor) return this.record(this.prisma, item, 'FAILED', 'ACTOR_NOT_AUTHORIZED', 'The administrator who started this operation can no longer run it.');
    for (const p of ['users.bulkManage', ...ACTION_RULES[action].permissions] as const) {
      if (!this.permissions.has(actor, p)) return this.record(this.prisma, item, 'FAILED', 'PERMISSION_REQUIRED', `The administrator no longer holds ${p}.`);
    }
    if (item.userId === actor.id) return this.record(this.prisma, item, 'SKIPPED', 'SELF', 'Your own account is never changed in bulk.');

    const user = await this.prisma.user.findUnique({
      where: { id: item.userId }, select: { id: true, role: true, accountStatus: true, gradeLevel: true, email: true },
    });
    if (!user) return this.record(this.prisma, item, 'SKIPPED', 'NOT_FOUND', 'The account no longer exists.');

    /** Records SUCCEEDED inside the change's own transaction; a lost claim rolls the change back. */
    const commitWith = (stillBlockedBy: string[] = []) => async (tx: Prisma.TransactionClient) => {
      await this.lockOperation(tx, op.id);
      if (!(await this.record(tx, item, 'SUCCEEDED', null, null, stillBlockedBy))) throw new ClaimLost();
    };

    try {
      if (ACTION_RULES[action].toStatus) {
        const d = statusDecision(action, user.accountStatus);
        if ('skip' in d) return this.record(this.prisma, item, 'SKIPPED', d.skip, null);
        await this.accountStatus.change(user.id, { toStatus: d.toStatus, reason: op.reason, confirm: action === 'restore' }, actor, {
          operationId: op.id,
          inTransaction: (tx, result) => commitWith(result.stillBlockedBy)(tx),
        });
        return true;
      }
      if (action === 'assignRole') {
        if (user.role === params.role) return this.record(this.prisma, item, 'SKIPPED', 'ALREADY_SET', null);
        await this.users.update(user.id, { role: params.role } as never, actor,
          { stepUpVerified: params.stepUpVerified === true, inTransaction: commitWith() });
        return true;
      }
      if (action === 'changeClassification') {
        if (user.role !== 'STUDENT') return this.record(this.prisma, item, 'SKIPPED', 'NOT_APPLICABLE', 'Only students have a grade.');
        if (user.gradeLevel === params.gradeLevel) return this.record(this.prisma, item, 'SKIPPED', 'ALREADY_SET', null);
        await this.users.update(user.id, { gradeLevel: params.gradeLevel } as never, actor, { inTransaction: commitWith() });
        return true;
      }
      if (action === 'message') {
        if (user.accountStatus !== 'ACTIVE' || !user.email) {
          return this.record(this.prisma, item, 'SKIPPED', 'ACCOUNT_NOT_ACTIVE', 'Only active accounts are e-mailed.');
        }
        await this.prisma.$transaction(async (tx) => {
          await commitWith()(tx);
          await tx.emailDelivery.create({ data: { jobId: op.emailJobId!, recipientEmail: user.email, recipientId: user.id } });
        });
        return true;
      }
      return this.record(this.prisma, item, 'FAILED', 'UNKNOWN_ACTION', null);
    } catch (err) {
      if (err instanceof ClaimLost) return false;   // another claim owns the item now; nothing was changed here
      const e = err as { code?: string; message?: string; response?: { code?: string; message?: string } };
      const code = e.code ?? e.response?.code;
      if (!code || code === 'UNEXPECTED_ERROR') throw err;
      return this.record(this.prisma, item, SKIP_CODES.has(code) ? 'SKIPPED' : 'FAILED', code, e.response?.message ?? e.message ?? null);
    }
  }

  /** The operation row FOR SHARE: a cancel (FOR UPDATE) waits for this item's change to commit. */
  async lockOperation(tx: Prisma.TransactionClient, operationId: string) {
    await tx.$queryRaw`SELECT 1 FROM "BulkOperation" WHERE "id" = ${operationId} FOR SHARE`;
  }

  /** Records an item's result only through the claim that holds it; false if the claim was lost. */
  async record(tx: Tx, item: ClaimedItem, outcome: Outcome, code: string | null, message: string | null, stillBlockedBy: string[] = []) {
    const { count } = await tx.bulkOperationItem.updateMany({
      where: { id: item.id, outcome: 'PROCESSING', claimToken: item.claimToken },
      data: { outcome, code, message: message?.slice(0, 500) ?? null, stillBlockedBy, processedAt: new Date(), lockedAt: null },
    });
    return count === 1;
  }

  /** The administrator, as of now (role, active overrides); null if they can no longer act. */
  private async loadActor(op: Op): Promise<AuthUser | null> {
    if (!op.actorId) return null;
    const u = await this.prisma.user.findUnique({
      where: { id: op.actorId },
      select: {
        id: true, username: true, role: true, isActive: true, isApproved: true, activatedAt: true, divisionId: true, gradeLevel: true,
        permissionOverrides: {
          where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          select: { id: true, permission: true, effect: true, courseId: true, divisionId: true, expiresAt: true },
        },
      },
    });
    if (!u || !u.isActive || !u.isApproved || !u.activatedAt) return null;
    return { id: u.id, username: u.username, role: u.role, divisionId: u.divisionId, gradeLevel: u.gradeLevel, overrides: u.permissionOverrides } as AuthUser;
  }

  /** Recomputes the counters; when nothing is pending or processing, ends the operation exactly once. */
  async finishIfDone(opId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "BulkOperation" WHERE "id" = ${opId} FOR UPDATE`;
      const c = await refreshCounts(tx, opId);
      if (c.pending > 0 || c.processing > 0) return;
      const op = await tx.bulkOperation.findUniqueOrThrow({ where: { id: opId }, select: { status: true, total: true, action: true, actorId: true, actorRole: true, emailJobId: true } });
      let status: 'CANCELLED' | ReturnType<typeof finalStatus>;
      if (op.status === 'CANCELLING') status = 'CANCELLED';
      else if (op.status === 'PENDING' || op.status === 'RUNNING') status = finalStatus({ ...c, total: op.total });
      else return;   // already finished
      await tx.bulkOperation.update({ where: { id: opId }, data: { status, finishedAt: new Date() } });
      if (op.emailJobId) {
        const deliveries = await tx.emailDelivery.count({ where: { jobId: op.emailJobId } });
        await tx.emailJob.update({ where: { id: op.emailJobId }, data: { totalRecipients: deliveries, ...(deliveries === 0 && { status: 'COMPLETED', completedAt: new Date() }) } });
      }
      await this.audit.log({
        actorId: op.actorId, actorRole: op.actorRole, action: 'BULK_OPERATION_FINISHED', entity: 'BulkOperation', entityId: opId,
        metadata: { action: op.action, status, total: op.total, succeeded: c.succeeded, failed: c.failed, skipped: c.skipped },
      }, tx);
    });
  }
}

class ClaimLost extends Error {}
