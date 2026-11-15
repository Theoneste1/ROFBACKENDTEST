/**
 * BulkOperationsWorker — processes bulk operation items (2026-11-17).
 *
 * Every 5 seconds it claims up to 200 PENDING items (`FOR UPDATE SKIP LOCKED`; a claim older than 5 minutes — a
 * crashed worker — is claimed again), so several API instances can run it at once and never process an item twice.
 * Each account is processed in its own transaction(s), so one failure never rolls back the others.
 *
 * Exactly once, in the database (not in memory), across retries, restarts and concurrent workers:
 *  - an item is recorded only while it is still PENDING (`updateMany … WHERE outcome = 'PENDING'`). Status changes and
 *    e-mail deliveries record their item INSIDE the same transaction as the change: if another worker (or a cancel)
 *    got there first, the change is rolled back;
 *  - a bulk e-mail delivery is created only with its item, and (operation, user) is unique: one e-mail per account.
 *  - role and grade changes run through UsersService.update (its own transaction) and are recorded right after; a
 *    crash in between leaves the item to be retried, which finds the account already changed and records SKIPPED
 *    ALREADY_SET — the change itself is never applied twice.
 * Counters are recomputed from the items; the operation finishes once, with one BULK_OPERATION_FINISHED audit row.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import { AuditService } from '../../audit/audit.service.js';
import { PermissionService } from '../../auth/permission.service.js';
import type { AuthUser } from '../../common/auth-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AccountStatusService } from '../account-status.service.js';
import { UsersService } from '../users.service.js';
import { ACTION_RULES, BATCH_SIZE, finalStatus, SKIP_CODES, statusDecision, type BulkAction } from './bulk-rules.js';
import { refreshCounts } from './bulk-operations.service.js';

interface ClaimedItem { id: string; operationId: string; userId: string }
type Outcome = 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
type Op = { id: string; action: string; params: Prisma.JsonValue; reason: string | null; actorId: string | null; status: string; emailJobId: string | null };

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

  /** Claims and processes one batch; returns how many items it claimed. */
  async processBatch(): Promise<number> {
    const claimed = await this.prisma.$queryRaw<ClaimedItem[]>`
      UPDATE "BulkOperationItem" i
      SET "lockedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE i."id" IN (
        SELECT it."id" FROM "BulkOperationItem" it
          JOIN "BulkOperation" o ON o."id" = it."operationId"
         WHERE it."outcome" = 'PENDING' AND o."status" IN ('PENDING', 'RUNNING')
           AND (it."lockedAt" IS NULL OR it."lockedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '5 minutes')
         ORDER BY o."createdAt" ASC, it."id" ASC
         LIMIT ${BATCH_SIZE}
         FOR UPDATE OF it SKIP LOCKED
      )
      RETURNING i."id", i."operationId", i."userId"`;
    if (claimed.length === 0) return 0;

    const byOp = new Map<string, ClaimedItem[]>();
    for (const c of claimed) byOp.set(c.operationId, [...(byOp.get(c.operationId) ?? []), c]);

    for (const [opId, items] of byOp) {
      const op = await this.prisma.bulkOperation.findUnique({
        where: { id: opId }, select: { id: true, action: true, params: true, reason: true, actorId: true, status: true, emailJobId: true },
      });
      if (!op || (op.status !== 'PENDING' && op.status !== 'RUNNING')) continue;
      if (op.status === 'PENDING') {
        await this.prisma.bulkOperation.updateMany({ where: { id: opId, status: 'PENDING' }, data: { status: 'RUNNING', startedAt: new Date() } });
      }
      const actor = await this.loadActor(op);
      for (const item of items) {
        try {
          await this.processItem(op, actor, item);
        } catch (err) {
          // Unexpected (not a refusal): reported on the item, never silent; the others continue.
          this.logger.error(`Bulk item ${item.id} failed: ${(err as Error).message}`);
          await this.record(this.prisma, item.id, 'FAILED', 'UNEXPECTED_ERROR', 'Unexpected error; nothing was changed for this account.');
        }
      }
      await this.finishIfDone(opId);
    }
    return claimed.length;
  }

  private async processItem(op: Op, actor: AuthUser | null, item: ClaimedItem) {
    const action = op.action as BulkAction;
    const params = (op.params ?? {}) as { role?: string; gradeLevel?: string; stepUpVerified?: boolean };
    if (!actor) return this.record(this.prisma, item.id, 'FAILED', 'ACTOR_NOT_AUTHORIZED', 'The administrator who started this operation can no longer run it.');
    for (const p of ['users.bulkManage', ...ACTION_RULES[action].permissions] as const) {
      if (!this.permissions.has(actor, p)) return this.record(this.prisma, item.id, 'FAILED', 'PERMISSION_REQUIRED', `The administrator no longer holds ${p}.`);
    }
    if (item.userId === actor.id) return this.record(this.prisma, item.id, 'SKIPPED', 'SELF', 'Your own account is never changed in bulk.');

    const user = await this.prisma.user.findUnique({
      where: { id: item.userId }, select: { id: true, role: true, accountStatus: true, gradeLevel: true, email: true },
    });
    if (!user) return this.record(this.prisma, item.id, 'SKIPPED', 'NOT_FOUND', 'The account no longer exists.');

    try {
      if (ACTION_RULES[action].toStatus) {
        const d = statusDecision(action, user.accountStatus);
        if ('skip' in d) return this.record(this.prisma, item.id, 'SKIPPED', d.skip, null);
        let recorded = true;
        await this.accountStatus.change(user.id, { toStatus: d.toStatus, reason: op.reason, confirm: action === 'restore' }, actor, {
          operationId: op.id,
          inTransaction: async (tx, result) => {
            recorded = await this.record(tx, item.id, 'SUCCEEDED', null, null, result.stillBlockedBy);
            if (!recorded) throw new AlreadyRecorded();   // another worker or a cancel got there first: roll this change back
          },
        });
        return recorded;
      }
      if (action === 'assignRole') {
        if (user.role === params.role) return this.record(this.prisma, item.id, 'SKIPPED', 'ALREADY_SET', null);
        await this.users.update(user.id, { role: params.role } as never, actor, { stepUpVerified: params.stepUpVerified === true });
        return this.record(this.prisma, item.id, 'SUCCEEDED', null, null);
      }
      if (action === 'changeClassification') {
        if (user.role !== 'STUDENT') return this.record(this.prisma, item.id, 'SKIPPED', 'NOT_APPLICABLE', 'Only students have a grade.');
        if (user.gradeLevel === params.gradeLevel) return this.record(this.prisma, item.id, 'SKIPPED', 'ALREADY_SET', null);
        await this.users.update(user.id, { gradeLevel: params.gradeLevel } as never, actor);
        return this.record(this.prisma, item.id, 'SUCCEEDED', null, null);
      }
      if (action === 'message') {
        if (user.accountStatus !== 'ACTIVE' || !user.email) {
          return this.record(this.prisma, item.id, 'SKIPPED', 'ACCOUNT_NOT_ACTIVE', 'Only active accounts are e-mailed.');
        }
        return this.prisma.$transaction(async (tx) => {
          if (!(await this.record(tx, item.id, 'SUCCEEDED', null, null))) return false;
          await tx.emailDelivery.create({ data: { jobId: op.emailJobId!, recipientEmail: user.email, recipientId: user.id } });
          return true;
        });
      }
      return this.record(this.prisma, item.id, 'FAILED', 'UNKNOWN_ACTION', null);
    } catch (err) {
      if (err instanceof AlreadyRecorded) return false;
      const e = err as { code?: string; message?: string; response?: { code?: string; message?: string } };
      const code = e.code ?? e.response?.code ?? 'ERROR';
      const message = e.response?.message ?? e.message ?? null;
      if (code === 'ERROR' || code === 'UNEXPECTED_ERROR') throw err;
      return this.record(this.prisma, item.id, SKIP_CODES.has(code) ? 'SKIPPED' : 'FAILED', code, message);
    }
  }

  /** Records an item's result only while it is still PENDING; false if it was already recorded (by anyone). */
  private async record(tx: Prisma.TransactionClient | PrismaService, itemId: string, outcome: Outcome, code: string | null, message: string | null, stillBlockedBy: string[] = []) {
    const { count } = await tx.bulkOperationItem.updateMany({
      where: { id: itemId, outcome: 'PENDING' },
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

  /** Recomputes the counters; when no item is pending, finishes the operation exactly once (one audit row). */
  private async finishIfDone(opId: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await refreshCounts(tx, opId);
      if (c.pending > 0) return;
      const op = await tx.bulkOperation.findUniqueOrThrow({ where: { id: opId }, select: { total: true, action: true, actorId: true, actorRole: true, emailJobId: true } });
      const status = finalStatus({ ...c, total: op.total });
      const { count } = await tx.bulkOperation.updateMany({
        where: { id: opId, status: { in: ['PENDING', 'RUNNING'] }, finishedAt: null }, data: { status, finishedAt: new Date() },
      });
      if (count === 0) return;   // already finished (or cancelled) by someone else
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

class AlreadyRecorded extends Error {}
