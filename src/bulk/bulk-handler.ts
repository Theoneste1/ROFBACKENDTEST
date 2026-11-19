/**
 * The bulk engine's extension contract (docs/operations/bulk-operations.md, "Engine contract").
 *
 * A record type (USER, …) is one BulkEntityHandler, registered with BulkRegistry when its module starts. The engine
 * (BulkOperationsService: preview, confirmation token, execute, progress, cancel; BulkOperationsWorker: claiming,
 * per-item transactions, recovery, finishing) is shared by every type: a handler only says WHICH records a selection
 * means, WHAT each action needs, and HOW one record is changed — by calling the same service code as the
 * single-record route, inside the item's transaction.
 */
import type { Type } from '@nestjs/common';
import type { Response } from 'express';

import type { Permission } from '../auth/permissions.js';
import type { AuthUser } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export type Db = Prisma.TransactionClient | PrismaService;

/** `{ mode: 'ids', ids }` (≤ maxIds) or `{ mode: 'filter', filter }` (the type's list filters; ≤ maxSelection matches). */
export type EngineSelection = { mode: 'ids'; ids: string[] } | { mode: 'filter'; filter: Record<string, unknown> };

export interface BulkActionMeta {
  /** Permissions the caller needs on top of users.bulkManage — the single-record route's permissions. */
  permissions: readonly Permission[];
  reason: 'required' | 'optional';
  /** One sentence for the confirmation dialog. */
  consequence: string;
}

export type ItemOutcome = 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export interface ItemResult { outcome: ItemOutcome; code?: string | null; message?: string | null; stillBlockedBy?: string[] }

export interface PreviewWarning { code: string; count: number; message: string }

/** The operation as the worker sees it. */
export interface OperationRow {
  id: string; entityType: string; action: string; params: Prisma.JsonValue; reason: string | null; actorId: string | null;
  status: string; emailJobId: string | null;
}

/** One record, inside its item transaction (the operation row is held FOR SHARE and the item row FOR UPDATE). */
export interface ItemContext {
  tx: Prisma.TransactionClient;
  op: OperationRow;
  params: Record<string, unknown>;
  actor: AuthUser;
  entityId: string;
  /** Work to run only after the item transaction committed (e-mails); never on rollback. */
  afterCommit: Array<() => Promise<void>>;
  /** Decision-notification ids enqueued in the transaction; dispatched after commit. */
  noticeIds: Array<string | null>;
}

/**
 * How creating an operation sees exactly the confirmed set at commit:
 *  - advisory: writers that can change membership take advisory lock `key` SHARED through a database trigger; the
 *    creation takes it EXCLUSIVELY (USER: trigger user_bulk_membership_guard);
 *  - tableShare: the creation takes `LOCK TABLE … IN SHARE MODE` on every table the filter reads — it waits for
 *    writes in flight and blocks new INSERT / UPDATE / DELETE on those tables until it commits (reads continue).
 */
export type MembershipGuard = { kind: 'advisory'; key: bigint } | { kind: 'tableShare'; tables: readonly string[] };

export interface BulkEntityHandler {
  /** Upper-case record type name, used in URLs (/admin/bulk/{entityType}) and stored on the operation. */
  readonly entityType: string;
  /** Plural noun for messages ("accounts", "schools"). */
  readonly noun: string;
  readonly actions: Readonly<Record<string, BulkActionMeta>>;
  readonly maxIds: number;
  readonly maxSelection: number;
  /** class-validator DTOs used to validate the generic routes' `selection` and `params` exactly like the type's own. */
  readonly selectionDto: Type<unknown>;
  readonly paramsDto: Type<unknown>;
  readonly membership: MembershipGuard;
  /** Key under which an item row carries the record's summary (USER: `user`). */
  readonly itemKey: string;
  /** Refusal codes thrown by the single-record service that mean "nothing to do" (SKIPPED) rather than FAILED. */
  readonly skipCodes: ReadonlySet<string>;

  normaliseSelection(s: EngineSelection): EngineSelection;
  normaliseParams(action: string, p: Record<string, unknown>): Record<string, unknown>;
  /** Parameter checks before anything is read (throws AppError). */
  validate(action: string, params: Record<string, unknown>, caller: AuthUser): Promise<void>;
  count(db: Db, s: EngineSelection): Promise<number>;
  /** Every matching id, sorted ascending (the order the confirmation digest uses). */
  scanIds(db: Db, s: EngineSelection): Promise<string[]>;
  preview(ids: string[], action: string, params: Record<string, unknown>, caller: AuthUser): Promise<{ sample: unknown[]; warnings: PreviewWarning[]; requiresStepUp: boolean }>;
  /** At execution, before the transaction: true when the caller's current password must be checked (assertStepUp). */
  stepUpRequired?(action: string, params: Record<string, unknown>, s: EngineSelection): Promise<boolean>;
  assertStepUp?(caller: AuthUser, currentPassword: string | undefined): Promise<void>;
  /** In the creation transaction, after the operation row (e.g. the e-mail job of a message). */
  onCreate?(tx: Prisma.TransactionClient, operationId: string, action: string, params: Record<string, unknown>, caller: AuthUser): Promise<void>;
  /** The parameters as written to the audit log (never a message body). */
  auditParams?(action: string, params: Record<string, unknown>): Record<string, unknown>;
  /** The caller's own record is never changed in bulk (SKIPPED SELF). */
  isSelf?(entityId: string, actor: AuthUser): boolean;
  processItem(ctx: ItemContext, action: string): Promise<ItemResult>;
  /** Summaries of records for the items list. */
  describe(db: Db, ids: string[]): Promise<Map<string, unknown>>;
  export?: { permission: Permission; run(ids: string[], selection: EngineSelection, caller: AuthUser, res: Response, requestId: string | null): Promise<void> };
}

/** The final status of an operation from its counts. */
export function finalStatus(c: { succeeded: number; failed: number; skipped: number; total: number }) {
  if (c.failed === 0) return 'COMPLETED' as const;
  if (c.succeeded === 0 && c.skipped === 0) return 'FAILED' as const;
  return 'COMPLETED_WITH_FAILURES' as const;
}
