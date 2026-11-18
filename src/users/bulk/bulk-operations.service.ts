/**
 * Bulk user operations (2026-11-17; docs/operations/bulk-user-operations.md).
 *
 *   preview  → the exact accounts the selection matches now (count, a small sample, warnings, consequences) and a
 *              selectionToken binding the action, its parameters, the selection and those exact accounts;
 *   execute  → re-resolves the selection; refuses (409 SELECTION_CHANGED) unless the token — and the total — still
 *              match; creates the operation with one item per account (the snapshot), idempotently per
 *              (administrator, idempotencyKey); a worker processes the items (BulkOperationsWorker);
 *   progress, items, list, cancel; export (CSV of the selection, streamed; safe fields only).
 *
 * Authorization is enforced here on every call, never only in the frontend: users.bulkManage plus the action's own
 * permission(s); and, per account at processing time, the same services and policies as a single change
 * (AccountStatusService, UsersService.update → RoleAssignmentPolicy, the Super Admin rules and the boundary flag).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../../audit/audit.service.js';
import { PermissionService } from '../../auth/permission.service.js';
import type { Permission } from '../../auth/permissions.js';
import type { AuthUser } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { pageArgs, paginated } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sendCsvExport } from '../../reports/csv-stream.js';
import { idBatches, mapBatches } from '../../reports/csv.js';
import { userListWhere, UsersService } from '../users.service.js';
import {
  ACTION_RULES, BULK_MEMBERSHIP_KEY, MAX_SELECTION, normaliseParams, normaliseSelection, selectionToken, TEACHER_STUDENT_ACTIONS,
  type BulkAction, type BulkParams, type BulkSelection,
} from './bulk-rules.js';
import type { BulkExecuteDto, BulkExportDto, BulkPreviewDto, ListBulkItemsDto, ListBulkOperationsDto } from './bulk.dto.js';

const SAMPLE_SELECT = { id: true, username: true, firstName: true, lastName: true, role: true, accountStatus: true } as const;
const OPERATION_SELECT = {
  id: true, action: true, params: true, selection: true, reason: true, status: true, total: true, succeeded: true,
  failed: true, skipped: true, idempotencyKey: true, emailJobId: true, requestId: true, createdAt: true, startedAt: true,
  finishedAt: true, cancelledAt: true, actorRole: true,
  actor: { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;
const REASON_MIN = 3;
const REASON_MAX = 500;

@Injectable()
export class BulkOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  // ─── Preview ────────────────────────────────────────────────────────────────

  async preview(dto: BulkPreviewDto, caller: AuthUser) {
    const { action, params, selection } = await this.prepare(dto, caller);
    const ids = await this.matchingIds(selection);
    const [sample, groups] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
      ids.length ? this.groupByRoleAndStatus(ids) : Promise.resolve([]),
    ]);
    const count = (pred: (g: { role: string; accountStatus: string }) => boolean) => groups.filter(pred).reduce((n, g) => n + g.n, 0);
    const warnings: Array<{ code: string; count: number; message: string }> = [];
    const warn = (code: string, n: number, message: string) => { if (n > 0) warnings.push({ code, count: n, message }); };

    warn('INCLUDES_YOURSELF', ids.includes(caller.id) ? 1 : 0, 'Your own account is in the selection; it will be skipped.');
    const privileged = count((g) => g.role === 'ADMIN' || g.role === 'SUPER_ADMIN');
    warn('INCLUDES_ADMINISTRATORS', privileged, 'Administrator or Super Administrator accounts are selected: only actions your role allows on them will be applied; the others fail and are reported.');
    const rule = ACTION_RULES[action];
    if (rule.toStatus) {
      warn('ALREADY_IN_STATE', count((g) => g.accountStatus === rule.toStatus), `Accounts already ${rule.toStatus.toLowerCase()} will be skipped.`);
      warn('NOT_APPLICABLE', count((g) => g.accountStatus !== rule.toStatus && !rule.from!.includes(g.accountStatus as never)),
        'Accounts in a state this action does not apply to will be skipped.');
    }
    if (action === 'assignRole') warn('ALREADY_IN_ROLE', count((g) => g.role === params.role), 'Accounts that already have this role will be skipped.');
    if (action === 'changeClassification') warn('NOT_STUDENTS', count((g) => g.role !== 'STUDENT'), 'Only students have a grade; other accounts will be skipped.');
    if (action === 'message') warn('BLOCKED_ACCOUNTS', count((g) => g.accountStatus !== 'ACTIVE'), 'Accounts that are not active will not be e-mailed.');
    if (TEACHER_STUDENT_ACTIONS.includes(action)) warn('NOT_STUDENTS', count((g) => g.role !== 'STUDENT'), 'Only students are linked to a teacher; other accounts will be skipped.');

    return {
      action, params, selection,
      total: ids.length,
      sample,
      warnings,
      consequences: [rule.consequence],
      requiresReason: rule.reason === 'required',
      requiresStepUp: this.requiresStepUp(action, params, privileged),
      selectionToken: selectionToken(action, params, selection, ids),
    };
  }

  // ─── Execute ────────────────────────────────────────────────────────────────

  async execute(dto: BulkExecuteDto, caller: AuthUser, requestId: string | null) {
    const existing = await this.prisma.bulkOperation.findUnique({
      where: { actorId_idempotencyKey: { actorId: caller.id, idempotencyKey: dto.idempotencyKey } }, select: OPERATION_SELECT,
    });
    if (existing) return { operation: existing, alreadyExisted: true };

    const { action, params, selection } = await this.prepare(dto, caller);
    if (dto.confirm !== true) throw new AppError(HttpStatus.BAD_REQUEST, 'CONFIRMATION_REQUIRED', 'Confirm the bulk action (confirm: true).');
    const reason = dto.reason?.trim() || null;
    if (ACTION_RULES[action].reason === 'required' && (!reason || reason.length < REASON_MIN || reason.length > REASON_MAX)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', `Give a reason (${REASON_MIN}–${REASON_MAX} characters).`);
    }

    // Step-up first (outside the transaction: bcrypt is slow and must not hold row locks). The selected Administrators
    // are counted again under the locks below; a different set fails the token check anyway.
    const privilegedNow = action === 'assignRole' ? await this.prisma.user.count({ where: { AND: [this.whereOf(selection), { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }] } }) : 0;
    const stepUp = this.requiresStepUp(action, params, privilegedNow);
    if (stepUp) await this.users.assertStepUp(caller, dto.currentPassword);   // checked once; the password is never stored

    for (let attempt = 1; ; attempt++) {
    try {
      const operation = await this.prisma.$transaction(async (tx) => {
        // The confirmed set is validated and the operation created atomically (owner review, round 2):
        //   1. take the membership lock EXCLUSIVELY — every write that can change filter membership (INSERT, DELETE, or
        //      an UPDATE of a filtered column, by anyone: database trigger user_bulk_membership_guard) holds it SHARED,
        //      so this waits for membership writes in flight, and holds new ones until this transaction commits;
        //   2. one scan of the matching accounts; 3. compare with the confirmed token (and total) — any difference →
        //      409 SELECTION_CHANGED, nothing created; 4. insert; 5. scan again and verify (cannot differ under the lock).
        // So the items equal the exact filter membership at the moment the operation commits.
        await this.acquireMembershipLock(tx);
        const ids = await this.matchingIdsIn(tx, selection);
        if (selectionToken(action, params, selection, ids) !== dto.selectionToken || ids.length !== dto.expectedTotal) {
          throw new AppError(HttpStatus.CONFLICT, 'SELECTION_CHANGED',
            'The selected accounts changed since the preview. Preview the action again and confirm the new selection.',
            { total: ids.length, expectedTotal: dto.expectedTotal });
        }
        if (ids.length === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_SELECTION', 'No account matches the selection.');

        const op = await tx.bulkOperation.create({
          data: {
            actorId: caller.id, actorRole: caller.role, action, reason, requestId,
            params: { ...params, ...(stepUp && { stepUpVerified: true }) } as Prisma.InputJsonValue,
            selection: selection as unknown as Prisma.InputJsonValue,
            selectionToken: dto.selectionToken, total: ids.length, idempotencyKey: dto.idempotencyKey,
          },
          select: { id: true },
        });
        // One set-based INSERT per 10 000 accounts (the membership lock is held: keep it short).
        for (let i = 0; i < ids.length; i += 10_000) {
          await tx.$executeRaw`
            INSERT INTO "BulkOperationItem" ("id", "operationId", "userId")
            SELECT gen_random_uuid()::text, ${op.id}, u FROM unnest(${ids.slice(i, i + 10_000)}::text[]) AS u
            ON CONFLICT ("operationId", "userId") DO NOTHING`;
        }
        if (action === 'message') {
          // One bulk e-mail job; each delivery is created with its account's item (BulkOperationsWorker), so an
          // account is e-mailed at most once per operation, whatever retries or workers do.
          const job = await tx.emailJob.create({
            data: { idempotencyKey: `bulk-operation/${op.id}`, subject: params.subject!, body: params.body!, status: 'PENDING', totalRecipients: 0, createdById: caller.id },
            select: { id: true },
          });
          await tx.bulkOperation.update({ where: { id: op.id }, data: { emailJobId: job.id } });
        }
        await this.audit.log({
          actorId: caller.id, actorRole: caller.role, action: 'BULK_OPERATION_STARTED', entity: 'BulkOperation', entityId: op.id,
          metadata: {
            action, params: auditParams(action, params), selection: auditSelection(selection), total: ids.length,
            reason, requestId, stepUpVerified: stepUp,
          },
        }, tx);
        // The invariant, checked at the end of the transaction: the items equal a fresh scan of the filter.
        const final = await scanIds(tx, this.whereOf(selection));
        if (final.length !== ids.length || final.some((id, i) => id !== ids[i])) {
          throw new AppError(HttpStatus.CONFLICT, 'SELECTION_CHANGED', 'The selected accounts changed. Preview the action again.');
        }
        return tx.bulkOperation.findUniqueOrThrow({ where: { id: op.id }, select: OPERATION_SELECT });
      }, { timeout: 120_000, maxWait: 30_000 });
      return { operation, alreadyExisted: false };
    } catch (err) {
      // A deadlock (rare: e.g. the administrator's own row deleted by direct SQL meanwhile) → retry a bounded number
      // of times; then ask to retry later. Nothing was created by the failed attempt.
      if (isDeadlock(err)) {
        if (attempt < 3) continue;
        throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'BULK_BUSY', 'The accounts are busy. Try again in a moment.');
      }
      // The same key raced in: return the operation the other request created (nothing created twice).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.bulkOperation.findUnique({
          where: { actorId_idempotencyKey: { actorId: caller.id, idempotencyKey: dto.idempotencyKey } }, select: OPERATION_SELECT,
        });
        if (raced) return { operation: raced, alreadyExisted: true };
      }
      throw err;
    }
    }
  }

  // ─── Progress, items, list, cancel ──────────────────────────────────────────

  async get(id: string, caller: AuthUser) {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id }, select: { ...OPERATION_SELECT, actorId: true } });
    if (!op || !this.canSee(caller, op.actorId)) throw new NotFoundException('Bulk operation not found.');
    const [pending, processing] = await Promise.all([
      this.prisma.bulkOperationItem.count({ where: { operationId: id, outcome: 'PENDING' } }),
      this.prisma.bulkOperationItem.count({ where: { operationId: id, outcome: 'PROCESSING' } }),
    ]);
    const { actorId: _a, ...rest } = op;
    return { ...rest, pending, processing, processed: op.total - pending - processing };
  }

  async items(id: string, q: ListBulkItemsDto, caller: AuthUser) {
    await this.get(id, caller);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.BulkOperationItemWhereInput = { operationId: id, ...(q.outcome && { outcome: q.outcome }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.bulkOperationItem.findMany({
        where, orderBy: { id: 'asc' }, skip, take,
        select: { userId: true, outcome: true, code: true, message: true, stillBlockedBy: true, processedAt: true },
      }),
      this.prisma.bulkOperationItem.count({ where }),
    ]);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: SAMPLE_SELECT })).map((u) => [u.id, u]));
    return paginated(rows.map((r) => ({ ...r, user: users.get(r.userId) ?? null })), total, page, limit);
  }

  async list(q: ListBulkOperationsDto, caller: AuthUser) {
    const { page, limit, skip, take } = pageArgs(q);
    // Everyone sees their own operations; administrators who read the audit trail see all.
    const where: Prisma.BulkOperationWhereInput = {
      ...(!this.permissions.has(caller, 'audit.view') && { actorId: caller.id }),
      ...(q.status && { status: q.status }),
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
  async cancel(id: string, caller: AuthUser) {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id }, select: { actorId: true, status: true } });
    if (!op || !this.canSee(caller, op.actorId)) throw new NotFoundException('Bulk operation not found.');
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
    if (!done) throw new AppError(HttpStatus.CONFLICT, 'OPERATION_FINISHED', 'This bulk operation has already finished.');
    return this.get(id, caller);
  }

  // ─── Export ─────────────────────────────────────────────────────────────────

  /** CSV of the selected accounts: name, username, e-mail, role, state, school, grade, created — never dates of birth or phone numbers. */
  async export(dto: BulkExportDto, caller: AuthUser, res: Response, requestId: string | null) {
    this.assertPermissions(caller, ['users.export']);
    const selection = normaliseSelection(dto.selection as BulkSelection);
    const ids = await this.matchingIds(selection);
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role, action: 'USERS_EXPORTED', entity: 'User', entityId: null,
      metadata: { selection: auditSelection(selection), total: ids.length, requestId, fields: EXPORT_HEADERS },
    });
    const batches = mapBatches(
      idBatches(ids, (chunk) => this.prisma.user.findMany({
        where: { id: { in: chunk } },
        select: {
          id: true, firstName: true, lastName: true, username: true, email: true, role: true, accountStatus: true,
          gradeLevel: true, createdAt: true, school: { select: { name: true } },
        },
        orderBy: { id: 'asc' },
      })),
      (users) => users.map((u) => [u.firstName, u.lastName, u.username, u.email, u.role, u.accountStatus, u.school?.name ?? '', u.gradeLevel ?? '', u.createdAt]),
    );
    await sendCsvExport(res as never, `users-${new Date().toISOString().slice(0, 10)}.csv`, { headers: [...EXPORT_HEADERS], batches });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async prepare(dto: BulkPreviewDto, caller: AuthUser) {
    const action = dto.action;
    this.assertPermissions(caller, ['users.bulkManage', ...ACTION_RULES[action].permissions]);
    const params = normaliseParams(action, dto.params ?? {});
    if (action === 'assignRole') {
      if (!params.role) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'params.role is required.');
      if (params.role === 'SUPER_ADMIN') {
        throw new AppError(HttpStatus.BAD_REQUEST, 'ROLE_NOT_ALLOWED_IN_BULK', 'The Super Administrator role is never assigned in bulk.');
      }
    }
    if (action === 'changeClassification' && !params.gradeLevel) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'params.gradeLevel is required.');
    }
    if (action === 'message' && (!params.subject || !params.body)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'params.subject and params.body are required.');
    }
    if (TEACHER_STUDENT_ACTIONS.includes(action)) {
      if (!params.teacherId) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'params.teacherId is required.');
      if ((action === 'grantDelegation' || action === 'revokeDelegation') && !params.permission) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'params.permission is required.');
      }
      const teacher = await this.prisma.user.findUnique({ where: { id: params.teacherId }, select: { role: true } });
      if (!teacher) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Teacher not found.');
      if (teacher.role !== 'TEACHER' && action !== 'unassignTeacher' && action !== 'revokeDelegation') {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_TEACHER', 'Only users with the TEACHER role can be given students.', { role: teacher.role });
      }
    }
    return { action, params, selection: normaliseSelection(dto.selection as BulkSelection) };
  }

  private assertPermissions(caller: AuthUser, needed: readonly Permission[]) {
    for (const p of needed) {
      if (!this.permissions.has(caller, p)) {
        throw new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission: p });
      }
    }
  }

  private whereOf(selection: BulkSelection): Prisma.UserWhereInput {
    return selection.mode === 'ids' ? { id: { in: selection.ids } } : userListWhere(selection.filter as never);
  }

  /**
   * The membership lock, EXCLUSIVE, for the rest of the creation transaction (BULK_MEMBERSHIP_KEY; writers take it
   * SHARED through the trigger user_bulk_membership_guard). A separate method so tests can pause here.
   */
  async acquireMembershipLock(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BULK_MEMBERSHIP_KEY})`;
  }

  /** Inside the creation transaction (membership lock held): the matching ids, sorted, within the size limit. */
  private async matchingIdsIn(tx: Prisma.TransactionClient, selection: BulkSelection): Promise<string[]> {
    const where = this.whereOf(selection);
    const n = await tx.user.count({ where });
    if (n > MAX_SELECTION) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SELECTION_TOO_LARGE',
        `The selection matches ${n} accounts; at most ${MAX_SELECTION} can be changed in one operation. Narrow the filters.`, { total: n });
    }
    return scanIds(tx, where);
  }

  /** The ids of every account the selection matches now, sorted. Never sent to the browser in full. */
  private async matchingIds(selection: BulkSelection): Promise<string[]> {
    const where = this.whereOf(selection);
    const n = await this.prisma.user.count({ where });
    if (n > MAX_SELECTION) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SELECTION_TOO_LARGE',
        `The selection matches ${n} accounts; at most ${MAX_SELECTION} can be changed in one operation. Narrow the filters.`, { total: n });
    }
    const rows = await this.prisma.user.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
    return rows.map((r) => r.id);
  }

  private async groupByRoleAndStatus(ids: string[]) {
    const out = new Map<string, { role: string; accountStatus: string; n: number }>();
    for (let i = 0; i < ids.length; i += 5000) {
      const g = await this.prisma.user.groupBy({ by: ['role', 'accountStatus'], where: { id: { in: ids.slice(i, i + 5000) } }, _count: { _all: true } });
      for (const r of g) {
        const k = `${r.role}|${r.accountStatus}`;
        const cur = out.get(k) ?? { role: r.role, accountStatus: r.accountStatus, n: 0 };
        cur.n += r._count._all;
        out.set(k, cur);
      }
    }
    return [...out.values()];
  }

  /** Step-up (the administrator's current password) when a role change involves Administrator-level roles. */
  private requiresStepUp(action: BulkAction, params: BulkParams, privilegedSelected: number) {
    return action === 'assignRole' && (params.role === 'ADMIN' || privilegedSelected > 0);
  }

  private canSee(caller: AuthUser, actorId: string | null) {
    return actorId === caller.id || this.permissions.has(caller, 'audit.view');
  }
}

export const EXPORT_HEADERS = ['firstName', 'lastName', 'username', 'email', 'role', 'accountStatus', 'school', 'gradeLevel', 'createdAt'] as const;

/** The counters are recomputed from the items (never incremented), so retries and concurrent workers cannot double-count. */
export async function refreshCounts(tx: Prisma.TransactionClient | PrismaService, operationId: string) {
  const groups = await tx.bulkOperationItem.groupBy({ by: ['outcome'], where: { operationId }, _count: { _all: true } });
  const n = (o: string) => groups.find((g) => g.outcome === o)?._count._all ?? 0;
  const counts = { succeeded: n('SUCCEEDED'), failed: n('FAILED'), skipped: n('SKIPPED') };
  await tx.bulkOperation.update({ where: { id: operationId }, data: counts });
  return { ...counts, pending: n('PENDING'), processing: n('PROCESSING') };
}

/** Audit metadata: the selection criteria (the filter, or the number of chosen ids) — the item rows hold the accounts. */
export function auditSelection(s: BulkSelection) {
  return s.mode === 'ids' ? { mode: 'ids', count: s.ids.length } : { mode: 'filter', filter: s.filter };
}
/** Audit metadata never holds a message body (only its subject). */
function auditParams(action: BulkAction, p: BulkParams) {
  return action === 'message' ? { subject: p.subject } : p;
}

async function scanIds(tx: Prisma.TransactionClient, where: Prisma.UserWhereInput): Promise<string[]> {
  return (await tx.user.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
}

/** PostgreSQL deadlock_detected (40P01), as Prisma reports it. */
function isDeadlock(err: unknown): boolean {
  const e = err as { code?: string; message?: string; meta?: { code?: string } };
  return e?.code === 'P2034' || e?.meta?.code === '40P01' || /40P01|deadlock detected/i.test(String(e?.message ?? ''));
}
