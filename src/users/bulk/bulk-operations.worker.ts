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
 * One transaction per item (owner review, round 2), always in this lock order — operation row → item row → user row
 * (→ e-mail outbox):
 *   1. the operation row FOR SHARE, and its status re-read under that lock; 2. the item row FOR UPDATE, and the claim
 *      re-checked; 3. a lost claim → nothing; an operation that is no longer RUNNING (CANCELLING) → the item is
 *      recorded SKIPPED (CANCELLED), with no change and no e-mail; 4. otherwise the change (AccountStatusService.change /
 *      UsersService.update run INSIDE this transaction), its result and, for a message, the EmailDelivery row.
 * A refusal (e.g. the role policy) rolls the transaction back — nothing changed — and is recorded in a second item
 * transaction under the same locks. Cancel takes the operation row FOR UPDATE (an UPDATE), so it waits for items
 * being processed, then marks the operation CANCELLING and skips the PENDING items; every item processed after that
 * sees CANCELLING under its lock. The finishing step takes the operation row FOR UPDATE, then reads the items; claims
 * lock only item rows. When no item is pending or processing the operation ends (CANCELLING → CANCELLED, or its final
 * status), once, with one BULK_OPERATION_FINISHED audit row. Counters are recomputed from the items.
 * A deadlock (40P01) of an item transaction releases the claim (the item goes back to PENDING) for a later retry.
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
import { ACTION_RULES, BATCH_SIZE, finalStatus, SKIP_CODES, statusDecision, TEACHER_STUDENT_ACTIONS, type BulkAction } from './bulk-rules.js';
import { DecisionNotificationsService } from '../../decision-notifications/decision-notifications.service.js';
import {
  activeSelectedOverride, addSelectionInTx, assignStudentInTx, endAssignmentInTx, ensureSelectedOverrideInTx, removeSelectionInTx, type ItemResult,
} from '../../teachers/teacher-student-ops.js';
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
    private readonly notices: DecisionNotificationsService,
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
    }
    try {
      await this.finishStale();
    } catch (err) {
      this.logger.error(`Bulk operations finishing sweep failed: ${(err as Error).message}`);
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
          await this.recordUnder(opId, item, 'FAILED', 'UNEXPECTED_ERROR', 'Unexpected error; nothing was changed for this account.');
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

  /** A first, unlocked look at the operation's status (a cancelled operation skips without work). A hook for tests. */
  async statusPrecheck(operationId: string): Promise<string> {
    return (await this.prisma.bulkOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true } })).status;
  }

  private async processItem(op: Op, actor: AuthUser | null, item: ClaimedItem): Promise<boolean> {
    const pre = await this.statusPrecheck(op.id);
    if (pre !== 'RUNNING' && pre !== 'PENDING') return this.recordUnder(op.id, item, 'SKIPPED', 'CANCELLED', CANCELLED_MESSAGE);

    const action = op.action as BulkAction;
    const params = (op.params ?? {}) as { role?: string; gradeLevel?: string; stepUpVerified?: boolean; teacherId?: string; permission?: string };
    if (!actor) return this.recordUnder(op.id, item, 'FAILED', 'ACTOR_NOT_AUTHORIZED', 'The administrator who started this operation can no longer run it.');
    for (const p of ['users.bulkManage', ...ACTION_RULES[action].permissions] as const) {
      if (!this.permissions.has(actor, p)) return this.recordUnder(op.id, item, 'FAILED', 'PERMISSION_REQUIRED', `The administrator no longer holds ${p}.`);
    }
    if (item.userId === actor.id) return this.recordUnder(op.id, item, 'SKIPPED', 'SELF', 'Your own account is never changed in bulk.');

    const afterCommit: Array<() => Promise<void>> = [];
    const noticeIds: Array<string | null> = [];
    try {
      const done = await this.inItemTransaction(op.id, item, async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: item.userId }, select: { id: true, role: true, accountStatus: true, gradeLevel: true, email: true },
        });
        if (!user) return this.record(tx, item, 'SKIPPED', 'NOT_FOUND', 'The account no longer exists.');
        if (ACTION_RULES[action].toStatus) {
          const d = statusDecision(action, user.accountStatus);
          if ('skip' in d) return this.record(tx, item, 'SKIPPED', d.skip, null);
          const r = await this.accountStatus.change(user.id, { toStatus: d.toStatus, reason: op.reason, confirm: action === 'restore' }, actor,
            { operationId: op.id, tx });
          return this.record(tx, item, 'SUCCEEDED', null, null, r.stillBlockedBy);
        }
        if (action === 'assignRole') {
          if (user.role === params.role) return this.record(tx, item, 'SKIPPED', 'ALREADY_SET', null);
          await this.users.update(user.id, { role: params.role } as never, actor, { stepUpVerified: params.stepUpVerified === true, tx, afterCommit });
          return this.record(tx, item, 'SUCCEEDED', null, null);
        }
        if (action === 'changeClassification') {
          if (user.role !== 'STUDENT') return this.record(tx, item, 'SKIPPED', 'NOT_APPLICABLE', 'Only students have a grade.');
          if (user.gradeLevel === params.gradeLevel) return this.record(tx, item, 'SKIPPED', 'ALREADY_SET', null);
          await this.users.update(user.id, { gradeLevel: params.gradeLevel } as never, actor, { tx, afterCommit });
          return this.record(tx, item, 'SUCCEEDED', null, null);
        }
        if (action === 'message') {
          if (user.accountStatus !== 'ACTIVE' || !user.email) return this.record(tx, item, 'SKIPPED', 'ACCOUNT_NOT_ACTIVE', 'Only active accounts are e-mailed.');
          // The outbox row is written in this transaction: a cancelled or rolled-back item never sends anything.
          await tx.emailDelivery.create({ data: { jobId: op.emailJobId!, recipientEmail: user.email, recipientId: user.id } });
          return this.record(tx, item, 'SUCCEEDED', null, null);
        }
        if (TEACHER_STUDENT_ACTIONS.includes(action)) {
          const r = await this.teacherStudentItem(tx, op, action, params, actor, user, noticeIds);
          return this.record(tx, item, r.outcome, r.code ?? null, r.message ?? null);
        }
        return this.record(tx, item, 'FAILED', 'UNKNOWN_ACTION', null);
      });
      this.notices.dispatchAfterCommit(noticeIds);
      for (const fn of afterCommit) await fn().catch((err) => this.logger.error(`Bulk item notice failed: ${(err as Error).message}`));
      return done;
    } catch (err) {
      if (isDeadlock(err)) {
        // Nothing was changed (rolled back): give the item back for a later retry.
        await this.prisma.bulkOperationItem.updateMany({
          where: { id: item.id, outcome: 'PROCESSING', claimToken: item.claimToken }, data: { outcome: 'PENDING', claimToken: null, lockedAt: null },
        });
        return false;
      }
      const e = err as { code?: string; message?: string; response?: { code?: string; message?: string } };
      const code = e.code ?? e.response?.code;
      if (!code || code === 'UNEXPECTED_ERROR' || code.startsWith('P')) throw err;
      // A refusal: the transaction was rolled back (nothing changed); record it under the same locks.
      return this.recordUnder(op.id, item, SKIP_CODES.has(code) ? 'SKIPPED' : 'FAILED', code, e.response?.message ?? e.message ?? null);
    }
  }

  /**
   * One student of a teacher–student action (TS approvals 2026-11-18), in the item's transaction. Non-students are
   * SKIPPED. The teacher's notices are deduplicated per OPERATION: one "students assigned" notice, one "permission
   * given" notice, however many items succeed or are retried.
   */
  private async teacherStudentItem(
    tx: Prisma.TransactionClient, op: Op, action: BulkAction, params: { teacherId?: string; permission?: string },
    actor: AuthUser, user: { id: string; role: string }, noticeIds: Array<string | null>,
  ): Promise<{ outcome: Outcome; code?: string; message?: string }> {
    if (user.role !== 'STUDENT') return { outcome: 'SKIPPED', code: 'NOT_A_STUDENT', message: 'Only students are linked to a teacher.' };
    const teacher = await tx.user.findUnique({
      where: { id: params.teacherId! }, select: { id: true, role: true, email: true, firstName: true, isActive: true, activatedAt: true },
    });
    if (!teacher) return { outcome: 'FAILED', code: 'TEACHER_NOT_FOUND', message: 'The teacher no longer exists.' };
    const by = { actorId: actor.id, actorRole: actor.role };
    const toOutcome = (r: ItemResult) => ({
      outcome: (r.outcome === 'SKIPPED' || r.outcome === 'FAILED' ? r.outcome : 'SUCCEEDED') as Outcome, code: r.code, message: r.message,
    });
    if (action === 'unassignTeacher') {
      const r = await endAssignmentInTx(tx, this.audit, { where: { teacherId: teacher.id, studentId: user.id }, actor: by, reason: 'BULK', operationId: op.id });
      return toOutcome(r.code === 'NOT_ASSIGNED' ? { ...r, outcome: 'SKIPPED' } : r);
    }
    if (teacher.role !== 'TEACHER' && action !== 'revokeDelegation') {
      return { outcome: 'FAILED', code: 'NOT_A_TEACHER', message: 'The account is no longer a Teacher.' };
    }
    if (action === 'assignTeacher') {
      const r = await assignStudentInTx(tx, this.audit, { teacherId: teacher.id, studentId: user.id, actor: by, source: 'BULK', reason: op.reason, operationId: op.id });
      if (r.outcome === 'ASSIGNED' || r.outcome === 'REACTIVATED') {
        noticeIds.push(await this.notices.enqueueStudentsAssigned(tx, teacher, `operation:${op.id}`));
      }
      return toOutcome(r);
    }
    if (action === 'grantDelegation') {
      const { override, created } = await ensureSelectedOverrideInTx(tx, this.audit, {
        teacher, permission: params.permission!, reason: op.reason ?? 'Bulk operation', actor: by, operationId: op.id,
      });
      if (created) noticeIds.push(await this.notices.enqueuePermissionsGranted(tx, teacher, [{ id: override.id, permission: override.permission, effect: 'GRANT' }]));
      return toOutcome(await addSelectionInTx(tx, this.audit, { override, studentId: user.id, actor: by, operationId: op.id }));
    }
    // revokeDelegation
    const override = await activeSelectedOverride(tx, teacher.id, params.permission!);
    if (!override) return { outcome: 'SKIPPED', code: 'NOT_APPLICABLE', message: 'The teacher has no delegation for selected students of this permission.' };
    return toOutcome(await removeSelectionInTx(tx, this.audit, { override, studentId: user.id, actor: by, operationId: op.id }));
  }

  /**
   * The item transaction: operation row FOR SHARE (status re-read under the lock) → item row FOR UPDATE (claim
   * re-checked). Lost claim → false, nothing done. Operation no longer RUNNING → SKIPPED (CANCELLED), nothing changed.
   * Otherwise runs `body` (the change and its result) in the same transaction.
   */
  async inItemTransaction(operationId: string, item: ClaimedItem, body: (tx: Prisma.TransactionClient) => Promise<boolean>): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const status = await this.lockOperation(tx, operationId);
      const rows = await tx.$queryRaw<Array<{ outcome: string; claimToken: string | null }>>`
        SELECT "outcome", "claimToken" FROM "BulkOperationItem" WHERE "id" = ${item.id} FOR UPDATE`;
      if (rows[0]?.outcome !== 'PROCESSING' || rows[0]?.claimToken !== item.claimToken) return false;   // claim lost
      if (status !== 'RUNNING') return this.record(tx, item, 'SKIPPED', 'CANCELLED', CANCELLED_MESSAGE);
      return body(tx);
    }, { timeout: 60_000, maxWait: 30_000 });
  }

  /** Records an outcome that involves no change, under the same locks and checks as a change. */
  private recordUnder(operationId: string, item: ClaimedItem, outcome: Outcome, code: string | null, message: string | null) {
    return this.inItemTransaction(operationId, item, (tx) => this.record(tx, item, outcome, code, message));
  }

  /** The operation row FOR SHARE, and its status as of that lock (a cancel, FOR UPDATE, waits for this item). A test hook. */
  async lockOperation(tx: Prisma.TransactionClient, operationId: string): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS status FROM "BulkOperation" WHERE "id" = ${operationId} FOR SHARE`;
    return rows[0]?.status ?? 'MISSING';
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

  /**
   * Operations still RUNNING / CANCELLING with nothing PENDING or PROCESSING: finish them. Normally finishIfDone does
   * it after the last batch; if that failed (e.g. a lock wait while another worker held the operation row), no item
   * is left to claim and nothing else would ever finish the operation — this sweep, run on every tick, does.
   */
  async finishStale(): Promise<number> {
    const stale = await this.prisma.bulkOperation.findMany({
      where: { status: { in: ['RUNNING', 'CANCELLING'] }, items: { none: { outcome: { in: ['PENDING', 'PROCESSING'] } } } },
      select: { id: true }, take: 50,
    });
    for (const op of stale) await this.finishIfDone(op.id);
    return stale.length;
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
    }, { timeout: 60_000, maxWait: 30_000 });   // waits for the operation row like an item transaction
  }
}

const CANCELLED_MESSAGE = 'The operation was cancelled before this account was processed.';

/** PostgreSQL deadlock_detected (40P01), as Prisma reports it. */
function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; message?: string; meta?: { code?: string } };
  return e?.code === 'P2034' || e?.meta?.code === '40P01' || /40P01|deadlock detected/i.test(String(e?.message ?? ''));
}
