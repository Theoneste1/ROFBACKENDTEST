/**
 * The bulk operations engine (2026-11-17, generalised 2026-11-19; docs/operations/bulk-operations.md).
 *
 *   preview  → the exact records the selection matches now (count, a small sample, warnings, consequences) and a
 *              signed, 15-minute confirmation token bound to the administrator, the record type, the action, its
 *              parameters, the selection and those exact records (src/bulk/confirmation-token.ts);
 *   execute  → checks the token (signature, administrator, expiry), then — under the type's membership guard —
 *              re-resolves the selection and refuses (409 SELECTION_CHANGED) unless the records, and the total, are
 *              exactly the confirmed ones; creates the operation with one item per record (the snapshot),
 *              idempotently per (administrator, idempotencyKey); BulkOperationsWorker processes the items;
 *   progress, items, list, cancel; export (where the type has one).
 *
 * Every record type is a BulkEntityHandler (BulkRegistry). Authorization is enforced here on every call, never only in
 * the frontend: users.bulkManage (the gate, necessary but never sufficient) plus the action's own permission(s) — the
 * single-record route's — at preview and execute; and, per record at processing time, the same services and policies
 * as a single change (the handler calls them inside the item transaction).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { PermissionService } from '../auth/permission.service.js';
import type { Permission } from '../auth/permissions.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { isHiddenAccount, seesSuperAdmins } from '../common/access/super-admin-privacy.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BulkEntityHandler, EngineSelection } from './bulk-handler.js';
import { BulkRegistry } from './bulk-registry.js';
import {
  bindingMatches, checkConfirmation, confirmationKey, signConfirmation, type ConfirmationBinding, type ConfirmationClaims,
} from './confirmation-token.js';

export const OPERATION_SELECT = {
  id: true, entityType: true, action: true, params: true, selection: true, reason: true, status: true, total: true, succeeded: true,
  failed: true, skipped: true, idempotencyKey: true, emailJobId: true, requestId: true, createdAt: true, startedAt: true,
  finishedAt: true, cancelledAt: true, actorRole: true,
  actor: { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;
const REASON_MIN = 3;
const REASON_MAX = 500;

export interface PreviewInput { action: string; params?: object; selection: object }
export interface ExecuteInput extends PreviewInput {
  selectionToken: string; expectedTotal: number; confirm: boolean; idempotencyKey: string; reason?: string; currentPassword?: string;
}
export interface ListInput { page?: number; limit?: number; status?: string; entityType?: string }
export interface ItemsInput { page?: number; limit?: number; outcome?: string }

@Injectable()
export class BulkOperationsService {
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly registry: BulkRegistry,
    config: ConfigService,
  ) {
    this.key = confirmationKey(config.getOrThrow<string>('JWT_SECRET'));
  }

  // ─── Preview ────────────────────────────────────────────────────────────────

  async preview(entityType: string, dto: PreviewInput, caller: AuthUser) {
    const handler = this.registry.get(entityType);
    const { action, params, selection } = await this.prepare(handler, dto, caller);
    const ids = await this.matchingIds(handler, this.prisma, selection, caller);
    const pv = await handler.preview(ids, action, params, caller);
    const rule = handler.actions[action];
    const { token, expiresAt } = this.signToken({ actorId: caller.id, entityType: handler.entityType, action, params, selection, ids });
    return {
      action, params, selection,
      total: ids.length,
      ...(pv.willApply !== undefined && { willApply: pv.willApply }),
      sample: pv.sample,
      warnings: pv.warnings,
      consequences: [rule.consequence],
      requiresReason: rule.reason === 'required',
      requiresStepUp: pv.requiresStepUp,
      selectionToken: token,
      entityType: handler.entityType,
      confirmationExpiresAt: expiresAt,
    };
  }

  /** Signs a confirmation (a separate method so tests can sign one that is already expired). */
  signToken(binding: ConfirmationBinding, now: Date = new Date()) {
    return signConfirmation(this.key, binding, now);
  }

  // ─── Execute ────────────────────────────────────────────────────────────────

  async execute(entityType: string, dto: ExecuteInput, caller: AuthUser, requestId: string | null) {
    const handler = this.registry.get(entityType);
    const existing = await this.prisma.bulkOperation.findUnique({
      where: { actorId_idempotencyKey: { actorId: caller.id, idempotencyKey: dto.idempotencyKey } }, select: OPERATION_SELECT,
    });
    if (existing) return this.sameKey(existing, handler);

    const { action, params, selection } = await this.prepare(handler, dto, caller);
    if (dto.confirm !== true) throw new AppError(HttpStatus.BAD_REQUEST, 'CONFIRMATION_REQUIRED', 'Please confirm this action before it is applied to the selected records.');
    const reason = dto.reason?.trim() || null;
    if (handler.actions[action].reason === 'required' && (!reason || reason.length < REASON_MIN || reason.length > REASON_MAX)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', `Give a reason (${REASON_MIN}–${REASON_MAX} characters).`);
    }
    const claims = this.checkToken(dto.selectionToken, caller);
    await this.assertTokenUnused(this.prisma, dto);

    // Step-up first (outside the transaction: bcrypt is slow and must not hold row locks). The records are checked
    // again under the guard below; a different set fails the token check anyway.
    const stepUp = (await handler.stepUpRequired?.(action, params, selection, caller)) ?? false;
    if (stepUp) await handler.assertStepUp!(caller, dto.currentPassword);   // checked once; the password is never stored

    for (let attempt = 1; ; attempt++) {
    try {
      const operation = await this.prisma.$transaction(async (tx) => {
        // The confirmed set is validated and the operation created atomically (owner review, round 2):
        //   1. the membership guard (USER: the advisory lock EXCLUSIVELY — every write that can change filter membership
        //      holds it SHARED through trigger user_bulk_membership_guard; other types: SHARE locks on the tables the
        //      filter reads), so this waits for membership writes in flight and holds new ones until it commits;
        //   2. one scan of the matching records; 3. compare with the confirmed token (and total) — any difference →
        //      409 SELECTION_CHANGED, nothing created; 4. insert; 5. scan again and verify (cannot differ under the guard).
        // So the items equal the exact filter membership at the moment the operation commits.
        await this.guardMembership(tx, handler);
        const ids = await this.matchingIds(handler, tx, selection, caller);
        if (!bindingMatches(claims, { actorId: caller.id, entityType: handler.entityType, action, params, selection, ids }) || ids.length !== dto.expectedTotal) {
          throw new AppError(HttpStatus.CONFLICT, 'SELECTION_CHANGED',
            `The selected ${handler.noun} changed since the preview. Preview the action again and confirm the new selection.`,
            { total: ids.length, expectedTotal: dto.expectedTotal });
        }
        if (ids.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_SELECTION', `No ${singular(handler.noun)} matches the selection. Change the filters or tick at least one row.`);
        // Single use, re-checked under the guard (the partial unique index BulkOperation_selectionToken_v2_key enforces it).
        await this.assertTokenUnused(tx, dto);

        const op = await tx.bulkOperation.create({
          data: {
            entityType: handler.entityType, actorId: caller.id, actorRole: caller.role, action, reason, requestId,
            params: { ...params, ...(stepUp && { stepUpVerified: true }) } as Prisma.InputJsonValue,
            selection: selection as unknown as Prisma.InputJsonValue,
            selectionToken: dto.selectionToken, total: ids.length, idempotencyKey: dto.idempotencyKey,
          },
          select: { id: true },
        });
        // One set-based INSERT per 10 000 records (the guard is held: keep it short). USER items also carry userId.
        const isUser = handler.entityType === 'USER';
        for (let i = 0; i < ids.length; i += 10_000) {
          await tx.$executeRaw`
            INSERT INTO "BulkOperationItem" ("id", "operationId", "entityId", "userId")
            SELECT gen_random_uuid()::text, ${op.id}, e, CASE WHEN ${isUser} THEN e ELSE NULL END FROM unnest(${ids.slice(i, i + 10_000)}::text[]) AS e
            ON CONFLICT ("operationId", "entityId") DO NOTHING`;
        }
        await handler.onCreate?.(tx, op.id, action, params, caller);
        await this.audit.log({
          actorId: caller.id, actorRole: caller.role, action: 'BULK_OPERATION_STARTED', entity: 'BulkOperation', entityId: op.id,
          metadata: {
            entityType: handler.entityType, action, params: (handler.auditParams?.(action, params) ?? params) as Prisma.InputJsonValue,
            selection: auditSelection(selection), total: ids.length, reason, requestId, stepUpVerified: stepUp,
          },
        }, tx);
        // The invariant, checked at the end of the transaction: the items equal a fresh scan of the filter.
        const final = await handler.scanIds(tx, selection, caller);
        if (final.length !== ids.length || final.some((id, i) => id !== ids[i])) {
          throw new AppError(HttpStatus.CONFLICT, 'SELECTION_CHANGED', `The selected ${handler.noun} changed. Preview the action again.`);
        }
        return tx.bulkOperation.findUniqueOrThrow({ where: { id: op.id }, select: OPERATION_SELECT });
      }, { timeout: 120_000, maxWait: 30_000 });
      return { operation, alreadyExisted: false };
    } catch (err) {
      // A deadlock (rare: e.g. the administrator's own row deleted by direct SQL meanwhile) → retry a bounded number
      // of times; then ask to retry later. Nothing was created by the failed attempt.
      if (isDeadlock(err)) {
        if (attempt < 3) continue;
        throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'BULK_BUSY', `The ${handler.noun} are busy. Try again in a moment.`);
      }
      // The same key raced in: return the operation the other request created (nothing created twice).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.bulkOperation.findUnique({
          where: { actorId_idempotencyKey: { actorId: caller.id, idempotencyKey: dto.idempotencyKey } }, select: OPERATION_SELECT,
        });
        if (raced) return this.sameKey(raced, handler);
        // Not the key: the same confirmation raced in with another key (unique index on v2 selectionToken).
        await this.assertTokenUnused(this.prisma, dto);
      }
      throw err;
    }
    }
  }

  // ─── Progress, items, list, cancel ──────────────────────────────────────────

  /** `entityType` restricts the lookup (the /admin/users/bulk routes see USER operations only). */
  async get(id: string, caller: AuthUser, entityType?: string) {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id }, select: { ...OPERATION_SELECT, actorId: true } });
    if (!op || !(await this.canSee(caller, op.actorId)) || (entityType && op.entityType !== entityType)) throw new NotFoundException('Bulk operation not found.');
    const [pending, processing] = await Promise.all([
      this.prisma.bulkOperationItem.count({ where: { operationId: id, outcome: 'PENDING' } }),
      this.prisma.bulkOperationItem.count({ where: { operationId: id, outcome: 'PROCESSING' } }),
    ]);
    const { actorId: _a, ...rest } = op;
    return { ...rest, pending, processing, processed: op.total - pending - processing };
  }

  async items(id: string, q: ItemsInput, caller: AuthUser, entityType?: string) {
    const op = await this.get(id, caller, entityType);
    const handler = this.registry.get(op.entityType);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.BulkOperationItemWhereInput = { operationId: id, ...(q.outcome && { outcome: q.outcome as never }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bulkOperationItem.findMany({
        where, orderBy: { id: 'asc' }, skip, take,
        select: { entityId: true, userId: true, outcome: true, code: true, message: true, stillBlockedBy: true, processedAt: true },
      }),
      this.prisma.bulkOperationItem.count({ where }),
    ]);
    const described = await handler.describe(this.prisma, rows.map((r) => r.entityId), caller);
    return paginated(rows.map((r) => ({ ...r, [handler.itemKey]: described.get(r.entityId) ?? null })), total, page, limit);
  }

  async list(q: ListInput, caller: AuthUser) {
    const { page, limit, skip, take } = pageArgs(q);
    // Everyone sees their own operations; administrators who read the audit trail see all.
    // A Super Administrator's operations are not shown to anyone else (Super Administrator privacy, like the audit log).
    const where: Prisma.BulkOperationWhereInput = {
      ...(!this.permissions.has(caller, 'audit.view') && { actorId: caller.id }),
      ...(!seesSuperAdmins(caller) && { OR: [{ actorId: null }, { actor: { is: { role: { not: 'SUPER_ADMIN' } } } }] }),
      ...(q.status && { status: q.status as never }),
      ...(q.entityType && { entityType: q.entityType }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bulkOperation.findMany({ where, select: OPERATION_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.bulkOperation.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * Stops an operation (review fix C). Only items still PENDING are skipped (CANCELLED). Items a worker has already
   * claimed (PROCESSING) finish truthfully; until they have, the operation is CANCELLING, then CANCELLED. The operation
   * row is locked first: a worker's per-item transaction holds it FOR SHARE, so a cancel waits for an item that is
   * being changed right now, and the worker's finishing step (FOR UPDATE) waits for the cancel.
   */
  async cancel(id: string, caller: AuthUser, entityType?: string) {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id }, select: { actorId: true, status: true, entityType: true } });
    if (!op || !(await this.canSee(caller, op.actorId)) || (entityType && op.entityType !== entityType)) throw new NotFoundException('Bulk operation not found.');
    if (op.actorId !== caller.id && !this.permissions.has(caller, 'audit.view')) throw new NotFoundException('Bulk operation not found.');
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.bulkOperation.updateMany({
        where: { id, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLING', cancelledAt: now },
      });
      if (count === 0) return false;
      await tx.bulkOperationItem.updateMany({
        where: { operationId: id, outcome: 'PENDING' }, data: { outcome: 'SKIPPED', code: 'CANCELLED', message: 'The operation was cancelled.', processedAt: now },
      });
      const c = await refreshCounts(tx, id);
      if (c.processing === 0) await tx.bulkOperation.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: now } });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'BULK_OPERATION_CANCELLED', entity: 'BulkOperation', entityId: id, metadata: {},
      }, tx);
      return true;
    });
    if (!done) throw new AppError(HttpStatus.CONFLICT, 'OPERATION_FINISHED', 'This bulk action has already finished; its results are in the bulk actions history.');
    return this.get(id, caller, entityType);
  }

  // ─── Export ─────────────────────────────────────────────────────────────────

  /** CSV of the selected records (safe fields only; the type decides which). Audited by the type. */
  async export(entityType: string, dto: { selection: object }, caller: AuthUser, res: Response, requestId: string | null) {
    const handler = this.registry.get(entityType);
    if (!handler.export) throw new AppError(HttpStatus.NOT_FOUND, 'BULK_EXPORT_UNAVAILABLE', 'These records cannot be exported together. Export them one at a time.');
    this.assertPermissions(caller, [handler.export.permission]);
    const selection = handler.normaliseSelection(dto.selection as EngineSelection);
    const ids = await this.matchingIds(handler, this.prisma, selection, caller);
    await handler.export.run(ids, selection, caller, res, requestId);
  }

  // ─── What the caller may run ────────────────────────────────────────────────

  /** The record types and actions the caller may run now (effective permissions), with what each needs. */
  actionsFor(caller: AuthUser) {
    const may = (perms: readonly Permission[]) => perms.every((p) => this.permissions.has(caller, p));
    return {
      gate: 'users.bulkManage',
      entityTypes: may(['users.bulkManage']) ? this.registry.all().map((h) => ({
        entityType: h.entityType,
        maxIds: h.maxIds,
        maxSelection: h.maxSelection,
        export: h.export && may([h.export.permission]) ? { permission: h.export.permission } : null,
        actions: Object.entries(h.actions).filter(([, a]) => may(a.permissions)).map(([name, a]) => ({
          action: name, permissions: ['users.bulkManage', ...a.permissions], requiresReason: a.reason === 'required', consequence: a.consequence,
        })),
      })).filter((t) => t.actions.length > 0 || t.export) : [],
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async prepare(handler: BulkEntityHandler, dto: PreviewInput, caller: AuthUser) {
    const action = dto.action;
    const rule = this.registry.action(handler, action);
    this.assertPermissions(caller, ['users.bulkManage', ...rule.permissions]);
    const params = handler.normaliseParams(action, (dto.params ?? {}) as Record<string, unknown>);
    await handler.validate(action, params, caller);
    return { action, params, selection: handler.normaliseSelection(dto.selection as EngineSelection) };
  }

  /** Signature, administrator, expiry. The binding (action, parameters, selection, records) is checked under the guard. */
  private checkToken(token: string, caller: AuthUser): ConfirmationClaims {
    const r = checkConfirmation(this.key, token, caller.id);
    if (r.ok) return r.claims;
    if (r.reason === 'EXPIRED') {
      throw new AppError(HttpStatus.GONE, 'CONFIRMATION_EXPIRED', 'This confirmation has expired (15 minutes). Preview the action again and confirm.');
    }
    if (r.reason === 'WRONG_ACTOR') {
      throw new AppError(HttpStatus.FORBIDDEN, 'CONFIRMATION_WRONG_ADMINISTRATOR', 'This confirmation was issued to another administrator. Preview the action yourself.');
    }
    throw new AppError(HttpStatus.BAD_REQUEST, 'CONFIRMATION_INVALID', 'The confirmation is not valid. Preview the action again and confirm.');
  }

  /**
   * A confirmation creates at most one operation: used already (with another idempotencyKey) → 409 CONFIRMATION_USED.
   * The same key is not refused here: it returns the existing operation (idempotency).
   */
  private async assertTokenUnused(db: Prisma.TransactionClient | PrismaService, dto: ExecuteInput) {
    const used = await db.bulkOperation.findFirst({
      where: { selectionToken: { equals: dto.selectionToken, startsWith: 'v2.' } }, select: { idempotencyKey: true },
    });
    if (used && used.idempotencyKey !== dto.idempotencyKey) {
      throw new AppError(HttpStatus.CONFLICT, 'CONFIRMATION_USED', 'This confirmation was already used; preview again.');
    }
  }

  /** The same idempotency key: the same operation — never a second one, and never another record type's. */
  private sameKey<T extends { entityType: string }>(op: T, handler: BulkEntityHandler) {
    if (op.entityType !== handler.entityType) {
      throw new AppError(HttpStatus.CONFLICT, 'IDEMPOTENCY_KEY_REUSED', 'This action was already started as a different kind of bulk action. Refresh the page and start it again.');
    }
    return { operation: op, alreadyExisted: true };
  }

  private assertPermissions(caller: AuthUser, needed: readonly Permission[]) {
    for (const p of needed) {
      if (!this.permissions.has(caller, p)) {
        throw new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission: p });
      }
    }
  }

  private async guardMembership(tx: Prisma.TransactionClient, handler: BulkEntityHandler) {
    const g = handler.membership;
    if (g.kind === 'advisory' && handler.entityType === 'USER') return this.acquireMembershipLock(tx);
    if (g.kind === 'advisory') return void (await tx.$executeRaw`SELECT pg_advisory_xact_lock(${g.key})`);
    return this.lockTables(tx, g.tables);
  }

  /**
   * The USER membership lock, EXCLUSIVE, for the rest of the creation transaction (BULK_MEMBERSHIP_KEY; writers take it
   * SHARED through the trigger user_bulk_membership_guard). A separate method so tests can pause here.
   */
  async acquireMembershipLock(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_MEMBERSHIP_KEY})`;
  }

  /** SHARE locks on the tables a non-USER filter reads (names are the handler's constants). A test hook. */
  async lockTables(tx: Prisma.TransactionClient, tables: readonly string[]): Promise<void> {
    for (const t of [...tables].sort()) {
      if (!/^[A-Za-z]+$/.test(t)) throw new Error(`Invalid table name ${t}`);
      await tx.$executeRawUnsafe(`LOCK TABLE "${t}" IN SHARE MODE`);
    }
  }

  /** The ids of every record the selection matches now, sorted, within the type's size limit. */
  private async matchingIds(handler: BulkEntityHandler, db: Prisma.TransactionClient | PrismaService, selection: EngineSelection, caller: AuthUser): Promise<string[]> {
    const n = await handler.count(db, selection, caller);
    if (n > handler.maxSelection) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SELECTION_TOO_LARGE',
        `The selection matches ${n} ${handler.noun}; at most ${handler.maxSelection} can be changed in one operation. Narrow the filters.`, { total: n });
    }
    return handler.scanIds(db, selection, caller);
  }

  /** Own operations; all of them with audit.view — except a Super Administrator's, for anyone else (privacy: 404). */
  private async canSee(caller: AuthUser, actorId: string | null) {
    if (actorId === caller.id) return true;
    if (!this.permissions.has(caller, 'audit.view')) return false;
    if (!actorId || seesSuperAdmins(caller)) return true;
    const actor = await this.prisma.user.findUnique({ where: { id: actorId }, select: { role: true } });
    return !isHiddenAccount(caller, actor);
  }
}

/** The USER membership advisory key (bulk-rules BULK_MEMBERSHIP_KEY; migration 20261207000100). */
export const USER_MEMBERSHIP_KEY = 8_152_026_002n;

const singular = (noun: string) => (noun === 'accounts' ? 'account' : noun.replace(/ies$/, 'y').replace(/s$/, ''));

/** The counters are recomputed from the items (never incremented), so retries and concurrent workers cannot double-count. */
export async function refreshCounts(tx: Prisma.TransactionClient | PrismaService, operationId: string) {
  const groups = await tx.bulkOperationItem.groupBy({ by: ['outcome'], where: { operationId }, _count: { _all: true } });
  const n = (o: string) => groups.find((g) => g.outcome === o)?._count._all ?? 0;
  const counts = { succeeded: n('SUCCEEDED'), failed: n('FAILED'), skipped: n('SKIPPED') };
  await tx.bulkOperation.update({ where: { id: operationId }, data: counts });
  return { ...counts, pending: n('PENDING'), processing: n('PROCESSING') };
}

/** Audit metadata: the selection criteria (the filter, or the number of chosen ids) — the item rows hold the records. */
export function auditSelection(s: EngineSelection) {
  return s.mode === 'ids' ? { mode: 'ids', count: s.ids.length } : { mode: 'filter', filter: s.filter };
}

/** PostgreSQL deadlock_detected (40P01), as Prisma reports it. */
export function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; message?: string; meta?: { code?: string } };
  return e?.code === 'P2034' || e?.meta?.code === '40P01' || /40P01|deadlock detected/i.test(String(e?.message ?? ''));
}
