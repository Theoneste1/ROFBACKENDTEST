/**
 * Directory sync — S2b review (owner-approved 2026-11-11). Writes ONLY the sync staging tables
 * and audit entries; the directory is written exclusively by SchoolSyncApplyService.
 *
 *   summary      per-run counts by outcome, change kind × decision, manual review (CONFLICT,
 *                POSSIBLE_DUPLICATE) and what still blocks an apply; who uploaded, decided,
 *                approved and applied
 *   categories   per category kind: counts and the digest of exactly the list (category approval
 *                is bound to it)
 *   decisions    individual / category decisions (sync-decisions.ts rules); RESOLVE_CONFLICT only
 *                by a Super Admin; deciding a resolution triggers a recompare
 *   proposal     an Administrator proposes how a CONFLICT / POSSIBLE_DUPLICATE row is resolved
 *                (LINK to a school — a listed candidate for a possible duplicate — or CREATE, with
 *                an optional verified code); before apply it becomes a RESOLVE_CONFLICT change a
 *                Super Admin decides; after apply it waits for the Super Admin resolve endpoint
 *   recompare    REPEATABLE READ snapshot, run row locked first, whole-transaction retry (3, only
 *                P2034 / 40001; then 409 RECOMPARE_CONFLICT); a decision is kept only for a change
 *                identical in kind, field, current and published value — others retire and new
 *                ones are PENDING; new digests; review generation + 1 (every token invalid)
 *   approve      Super Admin: approvedBy / approvedAt / approvedGeneration and a signed apply token
 *                (30 min, bound to run, file, both digests, generation, approver); the run keeps
 *                only the token id, the audit log only its SHA-256
 *
 * Every write: the run row FOR UPDATE first; PREVIEW and not expired, or 409 RUN_NOT_APPLICABLE;
 * any decision or proposal change bumps the review generation and invalidates an approval.
 */
import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService } from '../../../audit/audit.service.js';
import { PermissionService } from '../../../auth/permission.service.js';
import type { AuthUser, CallerCtx } from '../../../common/auth-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { codeProblems } from '../../school-rules.js';
import { changeKey, compareRows, loadDirectorySnapshot, stagedRows } from '../sync-compare.js';
import type { SyncResolution } from '../sync-matcher.js';
import { APPROVAL_TTL_MS, approvalKey, signApproval, tokenSha256 } from './approval-token.js';
import { CATEGORY_KINDS, categoryListDigest, decide, decisionsDigestOf, unmetDependencies, type Decision, type ReviewChange, type ReviewItem } from './sync-decisions.js';
import { withSerializationRetry } from './sync-retry.js';
import type { ProposeResolutionDto, SyncDecisionsDto } from './school-sync-review.dto.js';

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const MANUAL = new Set(['CONFLICT', 'POSSIBLE_DUPLICATE']);

export function notApplicable(run: { status: string; expiresAt: Date }, now: Date) {
  return new AppError(HttpStatus.CONFLICT, 'RUN_NOT_APPLICABLE',
    run.status !== 'PREVIEW' ? `The run is ${run.status} and can no longer be reviewed or applied.` : 'The run has expired (24 hours); upload the file again.',
    { status: run.status, expired: run.status === 'PREVIEW' && run.expiresAt.getTime() <= now.getTime() });
}

/** The run row FOR UPDATE (the first lock of every review write), then the run. */
export async function lockRun(tx: Tx, runId: string) {
  await tx.$queryRaw`SELECT 1 FROM "SchoolSyncRun" WHERE "id" = ${runId} FOR UPDATE`;
  const run = await tx.schoolSyncRun.findUnique({ where: { id: runId } });
  if (!run) throw new NotFoundException('Sync run not found.');
  return run;
}

export function assertOpen(run: { status: string; expiresAt: Date }, now: Date) {
  if (run.status !== 'PREVIEW' || run.expiresAt.getTime() <= now.getTime()) throw notApplicable(run, now);
}

/** The original manual-review outcome of an item (a resolved item keeps it in details.resolvedFrom). */
export function manualOutcome(item: { outcome: string; details: unknown }): string | null {
  const from = (item.details as { resolvedFrom?: string } | null)?.resolvedFrom;
  if (from && MANUAL.has(from)) return from;
  return MANUAL.has(item.outcome) ? item.outcome : null;
}

/** Approved resolutions of a run's active RESOLVE_CONFLICT changes, by source row. */
export function approvedResolutions(changes: ReadonlyArray<{ kind: string; decision: string; itemId: string | null; publishedValue: unknown }>,
  rowOf: ReadonlyMap<string, number | null>): Map<number, SyncResolution> {
  const out = new Map<number, SyncResolution>();
  for (const c of changes) {
    if (c.kind !== 'RESOLVE_CONFLICT' || c.decision !== 'APPROVED' || !c.itemId) continue;
    const row = rowOf.get(c.itemId);
    if (row !== null && row !== undefined) out.set(row, c.publishedValue as SyncResolution);
  }
  return out;
}

@Injectable()
export class SchoolSyncReviewService {
  /** The clock (tests move it). */
  now = () => new Date();
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    config: ConfigService,
  ) {
    this.key = approvalKey(config.getOrThrow<string>('JWT_SECRET'));
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  async summary(runId: string) {
    const run = await this.prisma.schoolSyncRun.findUnique({
      where: { id: runId },
      select: {
        id: true, datasetKey: true, status: true, expiresAt: true, reviewGeneration: true, approvalTokenId: true, approvedGeneration: true,
        createdAt: true, approvedAt: true, appliedAt: true, comparedAt: true,
        createdBy: { select: { id: true, username: true } }, approvedBy: { select: { id: true, username: true } }, appliedBy: { select: { id: true, username: true } },
      },
    });
    if (!run) throw new NotFoundException('Sync run not found.');
    const [items, changes, deciders] = await this.prisma.$transaction([
      this.prisma.schoolSyncItem.findMany({ where: { runId }, select: { id: true, outcome: true, conflictState: true, normalized: true, details: true } }),
      this.prisma.schoolSyncChange.findMany({ where: { runId, retiredAt: null }, select: { id: true, kind: true, field: true, itemId: true, schoolId: true, currentValue: true, publishedValue: true, decision: true } }),
      this.prisma.schoolSyncChange.findMany({ where: { runId, decidedById: { not: null } }, distinct: ['decidedById'], select: { decidedBy: { select: { id: true, username: true } } } }),
    ]);
    const outcomes: Record<string, number> = {};
    for (const i of items) outcomes[i.outcome] = (outcomes[i.outcome] ?? 0) + 1;
    const kinds: Record<string, Record<Decision, number>> = {};
    for (const c of changes) { kinds[c.kind] ??= { PENDING: 0, APPROVED: 0, REJECTED: 0 }; kinds[c.kind][c.decision]++; }
    const manual = items.filter((i) => manualOutcome(i));
    const manualReview = {
      total: manual.length,
      conflicts: manual.filter((i) => manualOutcome(i) === 'CONFLICT').length,
      possibleDuplicates: manual.filter((i) => manualOutcome(i) === 'POSSIBLE_DUPLICATE').length,
      byState: Object.fromEntries(['OPEN', 'PROPOSED', 'RESOLVED'].map((s) => [s, manual.filter((i) => (i.conflictState ?? 'OPEN') === s).length])),
    };
    const now = this.now();
    return {
      run: { ...run, expired: run.status === 'PREVIEW' && run.expiresAt.getTime() <= now.getTime(), approvalTokenId: undefined,
        approvalCurrent: run.status === 'PREVIEW' && run.approvalTokenId !== null && run.approvedGeneration === run.reviewGeneration },
      decidedBy: deciders.map((d) => d.decidedBy),
      outcomes, changes: kinds, manualReview,
      blockers: run.status === 'PREVIEW' ? this.blockers(items as ReviewItem[], changes as ReviewChange[], run, now) : [],
    };
  }

  async categories(runId: string) {
    await this.exists(runId);
    const changes = await this.prisma.schoolSyncChange.findMany({
      where: { runId, retiredAt: null, kind: { in: [...CATEGORY_KINDS] } },
      select: { id: true, kind: true, field: true, itemId: true, schoolId: true, currentValue: true, publishedValue: true, decision: true },
    });
    return CATEGORY_KINDS.map((kind) => {
      const of = changes.filter((c) => c.kind === kind);
      return {
        kind, total: of.length,
        pending: of.filter((c) => c.decision === 'PENDING').length, approved: of.filter((c) => c.decision === 'APPROVED').length,
        rejected: of.filter((c) => c.decision === 'REJECTED').length,
        listDigest: categoryListDigest(changes as ReviewChange[], kind),
      };
    });
  }

  // ─── Decisions ──────────────────────────────────────────────────────────────

  async decide(runId: string, dto: SyncDecisionsDto, caller: AuthUser) {
    const superAdmin = this.permissions.has(caller, 'schools.syncDirectory');
    const result = await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const run = await lockRun(tx, runId);
      assertOpen(run, now);
      const changes = await tx.schoolSyncChange.findMany({
        where: { runId, retiredAt: null },
        select: { id: true, kind: true, field: true, itemId: true, schoolId: true, currentValue: true, publishedValue: true, decision: true },
      }) as ReviewChange[];
      const items = await tx.schoolSyncItem.findMany({ where: { runId }, select: { id: true, outcome: true, normalized: true } }) as ReviewItem[];
      const out = decide(changes, items, { decisions: dto.decisions ?? [], categories: dto.categories ?? [] }, { superAdmin });
      if (out.problems.length) {
        const first = out.problems[0].code;
        const status = first === 'SUPER_ADMIN_ONLY' ? HttpStatus.FORBIDDEN : first === 'UNKNOWN_CHANGE' || first === 'NOT_A_CATEGORY_KIND' ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT;
        throw new AppError(status, first, 'The decisions were not recorded.', { problems: out.problems });
      }
      if (out.updates.size === 0) return { changed: false, blocked: out.blocked, reverted: [], resolutions: false, generation: run.reviewGeneration };

      const categoryDigest = new Map((dto.categories ?? []).map((c) => [c.kind, c.listDigest]));
      const byId = new Map(changes.map((c) => [c.id, c]));
      const individual = new Set((dto.decisions ?? []).map((d) => d.changeId));
      for (const decision of ['PENDING', 'APPROVED', 'REJECTED'] as const) {
        const ids = [...out.updates].filter(([, d]) => d === decision).map(([id]) => id);
        for (const kind of new Set(ids.map((id) => byId.get(id)!.kind))) {
          const of = ids.filter((id) => byId.get(id)!.kind === kind);
          const viaCategory = of.filter((id) => !individual.has(id) && !out.reverted.includes(id));
          const rest = of.filter((id) => !viaCategory.includes(id));
          if (viaCategory.length) {
            await tx.schoolSyncChange.updateMany({ where: { id: { in: viaCategory } }, data: { decision, decidedById: caller.id, decidedAt: now, decisionNote: dto.note ?? null, categoryApprovalDigest: categoryDigest.get(kind) ?? null } });
          }
          if (rest.length) {
            await tx.schoolSyncChange.updateMany({ where: { id: { in: rest } }, data: { decision, decidedById: caller.id, decidedAt: now, decisionNote: dto.note ?? null, categoryApprovalDigest: null } });
          }
        }
      }
      const after = changes.map((c) => ({ id: c.id, decision: out.updates.get(c.id) ?? c.decision }));
      const generation = run.reviewGeneration + 1;
      await tx.schoolSyncRun.update({ where: { id: runId }, data: { reviewGeneration: generation, decisionsDigest: decisionsDigestOf(after), approvalTokenId: null, approvedGeneration: null } });
      if (run.approvalTokenId) await this.invalidated(tx, runId, run.approvalTokenId, 'DECISIONS_CHANGED', caller);
      const decided = [...out.updates].map(([id, decision]) => ({ changeId: id, kind: byId.get(id)!.kind, field: byId.get(id)!.field, decision }));
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_DECISIONS', entity: 'SchoolSyncRun', entityId: runId,
        metadata: {
          generation, decided, reverted: out.reverted, blocked: out.blocked,
          categories: (dto.categories ?? []).map((c) => ({ kind: c.kind, listDigest: c.listDigest })), note: dto.note ?? null,
        },
      }, tx);
      return { changed: true, blocked: out.blocked, reverted: out.reverted, generation, resolutions: decided.some((d) => d.kind === 'RESOLVE_CONFLICT') };
    });
    // Deciding a resolution (re)links or (re)creates its row: recompare at once.
    if (result.resolutions) return { ...result, recompare: await this.recompare(runId, caller, 'RESOLUTION_DECIDED') };
    return result;
  }

  // ─── Proposals ──────────────────────────────────────────────────────────────

  async propose(runId: string, itemId: string, dto: ProposeResolutionDto, caller: CallerCtx) {
    const result = await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const run = await lockRun(tx, runId);
      const applied = run.status === 'APPLIED';
      if (!applied) assertOpen(run, now);
      if (applied && dto.action !== 'LINK') {
        throw new AppError(HttpStatus.CONFLICT, 'RUN_NOT_APPLICABLE', 'After a run is applied, a row can only be linked to an existing school.', { status: run.status });
      }
      const item = await tx.schoolSyncItem.findFirst({ where: { id: itemId, runId } });
      if (!item) throw new NotFoundException('Row not found in this run.');
      const manual = manualOutcome(item);
      if (!manual) throw new AppError(HttpStatus.CONFLICT, 'NOT_A_MANUAL_REVIEW_ROW', 'Only CONFLICT and POSSIBLE_DUPLICATE rows are resolved by review.');
      if (item.conflictState === 'RESOLVED') throw new AppError(HttpStatus.CONFLICT, 'ALREADY_RESOLVED', 'This row is already resolved.');
      const n = (item.normalized ?? null) as { province?: string | null } | null;
      const details = (item.details ?? {}) as { candidates?: Array<{ id: string }> };

      let schoolId: string | null = null;
      if (dto.action === 'LINK') {
        if (!dto.schoolId) throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_REQUIRED', 'A link needs the school (schoolId).');
        const school = await tx.school.findUnique({ where: { id: dto.schoolId }, select: { id: true, countryCode: true } });
        if (!school || school.countryCode !== 'RW') throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL', 'No such school in Rwanda\'s directory.');
        if (manual === 'POSSIBLE_DUPLICATE' && !(details.candidates ?? []).some((c) => c.id === school.id)) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_CANDIDATE', 'A possible duplicate can only be linked to one of its listed candidates.');
        }
        schoolId = school.id;
      }
      if (dto.code) {
        if (applied) throw new AppError(HttpStatus.BAD_REQUEST, 'CODE_NOT_ALLOWED', 'After apply a link records identifiers only; set a code with the audited school edit.');
        const problems = codeProblems(dto.code, n?.province ?? null);
        if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCHOOL', problems.join(' '), { problems });
        const holder = await tx.school.findUnique({ where: { code: dto.code }, select: { id: true } });
        if (holder && holder.id !== schoolId) throw new AppError(HttpStatus.CONFLICT, 'SCHOOL_CODE_TAKEN', 'A school with this code already exists.', { schoolId: holder.id });
      }
      const proposal = { action: dto.action, ...(schoolId && { schoolId }), ...(dto.code && { code: dto.code }), note: dto.note ?? null };
      await tx.schoolSyncItem.update({ where: { id: item.id }, data: { proposal, proposedById: caller.id, proposedAt: now, conflictState: 'PROPOSED' } });

      let retiredApproved = false;
      let generation = run.reviewGeneration;
      if (!applied) {
        const previous = await tx.schoolSyncChange.findMany({ where: { runId, itemId: item.id, kind: 'RESOLVE_CONFLICT', retiredAt: null }, select: { id: true, decision: true } });
        retiredApproved = previous.some((p) => p.decision === 'APPROVED');
        if (previous.length) await tx.schoolSyncChange.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { retiredAt: now } });
        await tx.schoolSyncChange.create({ data: {
          runId, itemId: item.id, schoolId, kind: 'RESOLVE_CONFLICT', field: null, currentValue: Prisma.DbNull,
          publishedValue: { action: dto.action, ...(schoolId && { schoolId }), ...(dto.code && { code: dto.code }) },
        } });
        const active = await tx.schoolSyncChange.findMany({ where: { runId, retiredAt: null }, select: { id: true, decision: true } });
        generation = run.reviewGeneration + 1;
        await tx.schoolSyncRun.update({ where: { id: runId }, data: { reviewGeneration: generation, decisionsDigest: decisionsDigestOf(active), approvalTokenId: null, approvedGeneration: null } });
        if (run.approvalTokenId) await this.invalidated(tx, runId, run.approvalTokenId, 'RESOLUTION_PROPOSED', caller);
      }
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_RESOLUTION_PROPOSED', entity: 'SchoolSyncItem', entityId: item.id,
        metadata: { runId, row: item.rowNumber, outcome: manual, proposal, afterApply: applied, generation },
      }, tx);
      return { itemId: item.id, proposal, afterApply: applied, generation, retiredApproved };
    });
    // Replacing an approved resolution undoes its effect on the comparison.
    if (result.retiredApproved) return { ...result, recompare: await this.recompare(runId, caller, 'RESOLUTION_REPLACED') };
    return result;
  }

  // ─── Recompare ──────────────────────────────────────────────────────────────

  async recompare(runId: string, caller: CallerCtx, reason = 'REQUESTED') {
    return withSerializationRetry((attempt) => this.prisma.$transaction(async (tx) => {
      // The run row is locked by the FIRST statement (it fixes the snapshot); a concurrent change of
      // the row then raises 40001 / P2034 and the whole transaction is retried.
      await tx.$queryRaw`SELECT 1 FROM "SchoolSyncRun" WHERE "id" = ${runId} FOR UPDATE`;
      const now = this.now();
      const run = await tx.schoolSyncRun.findUnique({ where: { id: runId } });
      if (!run) throw new NotFoundException('Sync run not found.');
      assertOpen(run, now);
      const items = await tx.schoolSyncItem.findMany({ where: { runId } });
      const changes = await tx.schoolSyncChange.findMany({ where: { runId, retiredAt: null } });
      const rowOf = new Map(items.map((i) => [i.id, i.rowNumber]));
      const itemByRow = new Map(items.filter((i) => i.rowNumber !== null).map((i) => [i.rowNumber!, i]));
      const { snap, places } = await loadDirectorySnapshot(tx, run.dataSourceId);
      const cmp = compareRows(stagedRows(items), snap, places, approvedResolutions(changes, rowOf));

      // Items: the fresh comparison (staged raw is unchanged).
      for (const fresh of cmp.items) {
        if (fresh.rowNumber === null) continue;
        const it = itemByRow.get(fresh.rowNumber)!;
        const manual = fresh.outcome === 'CONFLICT' || fresh.outcome === 'POSSIBLE_DUPLICATE' || (fresh.details as { resolvedFrom?: string } | null)?.resolvedFrom;
        await tx.schoolSyncItem.update({
          where: { id: it.id },
          data: {
            outcome: fresh.outcome, schoolId: fresh.schoolId, matchedBy: fresh.matchedBy, conflictGroup: fresh.conflictGroup,
            details: json(fresh.details), normalized: json(fresh.normalized), issues: fresh.issues as unknown as Prisma.InputJsonValue, issueCount: fresh.issues.length,
            conflictState: manual ? (it.conflictState ?? 'OPEN') : it.conflictState,
          },
        });
      }
      const missingNow = new Set(cmp.items.filter((i) => i.outcome === 'MISSING_FROM_SOURCE').map((i) => i.schoolId!));
      const missingBefore = new Map(items.filter((i) => i.outcome === 'MISSING_FROM_SOURCE').map((i) => [i.schoolId!, i]));
      for (const fresh of cmp.items.filter((i) => i.outcome === 'MISSING_FROM_SOURCE' && !missingBefore.has(i.schoolId!))) {
        await tx.schoolSyncItem.create({ data: { runId, outcome: 'MISSING_FROM_SOURCE', schoolId: fresh.schoolId, details: json(fresh.details), issues: [], issueCount: 0 } });
      }
      for (const [schoolId, it] of missingBefore) {
        if (!missingNow.has(schoolId)) await tx.schoolSyncItem.update({ where: { id: it.id }, data: { details: { ...(it.details as object), noLongerMissing: true } } });
      }

      // Changes: identical ones keep their decision; others retire; new ones are PENDING.
      const staged = changes.filter((c) => c.kind !== 'RESOLVE_CONFLICT');
      const stagedKeys = new Map(staged.map((c) => [changeKey({ ...c, rowNumber: c.itemId ? rowOf.get(c.itemId) ?? null : null }), c]));
      const freshKeys = new Map(cmp.changes.map((c) => [changeKey({ ...c, rowNumber: c.itemIndex === null ? null : cmp.items[c.itemIndex].rowNumber }), c]));
      const retire = [...stagedKeys].filter(([k]) => !freshKeys.has(k)).map(([, c]) => c.id);
      const add = [...freshKeys].filter(([k]) => !stagedKeys.has(k)).map(([, c]) => c);
      if (retire.length) await tx.schoolSyncChange.updateMany({ where: { id: { in: retire } }, data: { retiredAt: now } });
      for (let i = 0; i < add.length; i += 1000) {
        await tx.schoolSyncChange.createMany({
          data: add.slice(i, i + 1000).map((c) => ({
            runId, itemId: c.itemIndex === null ? null : itemByRow.get(cmp.items[c.itemIndex].rowNumber!)?.id ?? null,
            schoolId: c.schoolId, kind: c.kind, field: c.field, currentValue: json(c.currentValue), publishedValue: json(c.publishedValue),
          })),
        });
      }
      // A kept decision whose dependency is no longer approved returns to PENDING.
      const active = await tx.schoolSyncChange.findMany({
        where: { runId, retiredAt: null },
        select: { id: true, kind: true, field: true, itemId: true, schoolId: true, currentValue: true, publishedValue: true, decision: true },
      }) as ReviewChange[];
      const freshItems = await tx.schoolSyncItem.findMany({ where: { runId }, select: { id: true, outcome: true, normalized: true } }) as ReviewItem[];
      let reverted: string[] = [];
      for (let unmet = unmetDependencies(active, freshItems); unmet.length; unmet = unmetDependencies(active, freshItems)) {
        await tx.schoolSyncChange.updateMany({ where: { id: { in: unmet } }, data: { decision: 'PENDING', decidedById: caller.id, decidedAt: now } });
        for (const c of active) if (unmet.includes(c.id)) c.decision = 'PENDING';
        reverted = [...reverted, ...unmet];
      }
      const generation = run.reviewGeneration + 1;
      await tx.schoolSyncRun.update({
        where: { id: runId },
        data: {
          reportDigest: cmp.reportDigest, decisionsDigest: decisionsDigestOf(active), counts: cmp.counts as unknown as Prisma.InputJsonValue,
          comparedAt: now, reviewGeneration: generation, approvalTokenId: null, approvedGeneration: null,
        },
      });
      if (run.approvalTokenId) await this.invalidated(tx, runId, run.approvalTokenId, 'RECOMPARED', caller);
      const summary = { reason, generation, kept: staged.length - retire.length, retired: retire.length, added: add.length, reverted: reverted.length, attempt };
      await this.audit.log({ actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_RECOMPARED', entity: 'SchoolSyncRun', entityId: runId, metadata: summary }, tx);
      return summary;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 180_000, maxWait: 10_000 }),
    () => new AppError(HttpStatus.CONFLICT, 'RECOMPARE_CONFLICT', 'The run kept changing while it was being recompared; try again.'));
  }

  // ─── Approval ───────────────────────────────────────────────────────────────

  async approve(runId: string, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const run = await lockRun(tx, runId);
      assertOpen(run, now);
      const items = await tx.schoolSyncItem.findMany({ where: { runId }, select: { id: true, outcome: true, normalized: true, details: true, conflictState: true } });
      const changes = await tx.schoolSyncChange.findMany({
        where: { runId, retiredAt: null },
        select: { id: true, kind: true, field: true, itemId: true, schoolId: true, currentValue: true, publishedValue: true, decision: true },
      }) as ReviewChange[];
      const blockers = this.blockers(items as unknown as ReviewItem[], changes, run, now);
      if (blockers.length) throw new AppError(HttpStatus.CONFLICT, 'SYNC_REVIEW_INCOMPLETE', 'The review is not complete.', { blockers });

      const decisionsDigest = decisionsDigestOf(changes);
      const tokenId = randomUUID();
      const exp = Math.min(now.getTime() + APPROVAL_TTL_MS, run.expiresAt.getTime());
      const token = signApproval(this.key, {
        v: 1, run: run.id, file: run.fileSha256, report: run.reportDigest, decisions: decisionsDigest, gen: run.reviewGeneration, jti: tokenId, sub: caller.id, exp,
      });
      await tx.schoolSyncRun.update({
        where: { id: runId },
        data: { decisionsDigest, approvedAt: now, approvedById: caller.id, approvedGeneration: run.reviewGeneration, approvalTokenId: tokenId },
      });
      if (run.approvalTokenId) await this.invalidated(tx, runId, run.approvalTokenId, 'NEW_APPROVAL', caller);
      const approved: Record<string, number> = {};
      for (const c of changes) if (c.decision === 'APPROVED') approved[c.kind] = (approved[c.kind] ?? 0) + 1;
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_APPROVED', entity: 'SchoolSyncRun', entityId: runId,
        metadata: { tokenId, tokenSha256: tokenSha256(token), expiresAt: new Date(exp).toISOString(), reviewGeneration: run.reviewGeneration, approved },
      }, tx);
      return { runId, token, tokenId, expiresAt: new Date(exp).toISOString(), reviewGeneration: run.reviewGeneration, approved };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** What prevents an apply now (empty: nothing). */
  blockers(items: ReadonlyArray<ReviewItem & { details?: unknown; conflictState?: string | null }>, changes: readonly ReviewChange[],
    run: { status: string; expiresAt: Date }, now: Date) {
    const out: Array<{ code: string; count: number; ids?: string[] }> = [];
    if (run.status !== 'PREVIEW' || run.expiresAt.getTime() <= now.getTime()) out.push({ code: 'RUN_NOT_APPLICABLE', count: 1 });
    const unmet = unmetDependencies(changes, items);
    if (unmet.length) out.push({ code: 'DEPENDENCY_NOT_APPROVED', count: unmet.length, ids: unmet.slice(0, 50) });
    const approvedResolution = new Set(changes.filter((c) => c.kind === 'RESOLVE_CONFLICT' && c.decision === 'APPROVED').map((c) => c.itemId));
    const ineffective = items.filter((i) => approvedResolution.has(i.id) && (i.outcome === 'CONFLICT' || i.outcome === 'POSSIBLE_DUPLICATE')).map((i) => i.id);
    if (ineffective.length) out.push({ code: 'RESOLUTION_NOT_EFFECTIVE', count: ineffective.length, ids: ineffective.slice(0, 50) });
    const pendingResolutions = changes.filter((c) => c.kind === 'RESOLVE_CONFLICT' && c.decision === 'PENDING').map((c) => c.id);
    if (pendingResolutions.length) out.push({ code: 'RESOLUTION_PENDING', count: pendingResolutions.length, ids: pendingResolutions.slice(0, 50) });
    return out;
  }

  private async invalidated(tx: Tx, runId: string, tokenId: string, reason: string, caller: CallerCtx) {
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_TOKEN_INVALIDATED', entity: 'SchoolSyncRun', entityId: runId,
      metadata: { tokenId, reason },
    }, tx);
  }

  private async exists(runId: string) {
    if (!(await this.prisma.schoolSyncRun.findUnique({ where: { id: runId }, select: { id: true } }))) throw new NotFoundException('Sync run not found.');
  }
}
