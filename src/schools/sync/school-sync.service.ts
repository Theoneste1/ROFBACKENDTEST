/**
 * Directory sync — S2a: dry runs, reports, expiry and staging purge (school directory S2;
 * owner-approved 2026-11-11). schools.manage: Administrators and Super Admins.
 *
 * WRITE BOUNDARY (G): this service writes only the sync staging tables (SchoolSyncRun,
 * SchoolSyncItem, SchoolSyncChange) and audit entries. It never writes a school, contact,
 * education level, programme, external id or source record — those writes belong exclusively to
 * S2b's approved, locked apply (school-sync-boundary.guard.spec.ts; e2e checksums).
 *
 *   dry run   the file is read (source-file.ts), normalised (nesa-normaliser.ts) and matched
 *             (sync-matcher.ts) against ONE consistent snapshot of the directory (a REPEATABLE
 *             READ transaction, read-only for the directory); the run, its items and its proposed
 *             changes are staged in the same transaction, with the report digest and the initial
 *             decisions digest; one SCHOOL_SYNC_DRY_RUN audit entry (counts only)
 *   reports   runs, items, changes — contact values masked (C); report.csv has no contact column
 *   expiry    a PREVIEW run older than 24 h becomes EXPIRED (SCHOOL_SYNC_RUN_EXPIRED)
 *   purge     daily: staged raw / normalised values and change values of runs that ended (expired,
 *             superseded or applied) 7+ days ago are cleared; summaries, counts, digests,
 *             outcomes, decisions, reviewers and links stay; source records are never touched
 *             (SCHOOL_SYNC_STAGING_PURGED, counts only). Idempotent.
 */
import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AuditService } from '../../audit/audit.service.js';
import type { CallerCtx } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { pageArgs, paginated } from '../../common/pagination.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { toCsv } from '../../reports/csv.js';
import { sanitizeFileName } from '../import/file-name.js';
import { directoryPlaces, normaliseNesaRow, NESA_NORMALISER_VERSION, type NormalisedRow } from './nesa-normaliser.js';
import { readSourceFile } from './source-file.js';
import { SYNC_RUN_TTL_MS, SYNC_STAGING_RETENTION_MS, syncDataset } from './sync-datasets.js';
import { matchRows, type DirectorySnapshot } from './sync-matcher.js';
import { countsOf, decisionsDigest, maskChangeValue, maskNormalized, maskRaw, reconcile, reportDigest } from './sync-report.js';
import type { CreateSyncRunQueryDto, ListSyncRunsDto, SyncChangesQueryDto, SyncItemsQueryDto } from './school-sync.dto.js';

type Tx = Prisma.TransactionClient;
const CHUNK = 1000;
const json = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

const RUN_SELECT = {
  id: true, datasetKey: true, normaliserVersion: true, datasetLabel: true, fileName: true, fileSha256: true, format: true,
  rowCount: true, sourceSummary: true, reconciliation: true, counts: true, reportDigest: true, decisionsDigest: true,
  reviewGeneration: true, status: true, comparedAt: true, createdAt: true, expiresAt: true, appliedAt: true,
  supersededAt: true, supersededByRunId: true, stagedPurgedAt: true,
  dataSource: { select: { key: true, name: true } },
  createdBy: { select: { id: true, username: true } },
  appliedBy: { select: { id: true, username: true } },
} as const;

@Injectable()
export class SchoolSyncService {
  private readonly logger = new Logger('SchoolSync');
  /** The clock (tests move it to expire and purge runs). */
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── Dry run ────────────────────────────────────────────────────────────────

  async dryRun(file: Express.Multer.File | undefined, q: CreateSyncRunQueryDto, caller: CallerCtx) {
    const dataset = syncDataset(q.dataset);
    if (!dataset) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SYNC_DATASET', 'Unknown dataset.');
    if (dataset.normaliserVersion !== NESA_NORMALISER_VERSION) throw new Error(`No normaliser ${dataset.normaliserVersion}`);
    const fileName = sanitizeFileName(file?.originalname);
    const parsed = await readSourceFile(dataset, file);
    const fileSha256 = createHash('sha256').update(file!.buffer).digest('hex');
    const source = await this.prisma.schoolDataSource.findUnique({ where: { key: dataset.dataSourceKey }, select: { id: true } });
    if (!source) throw new AppError(HttpStatus.CONFLICT, 'SYNC_SOURCE_MISSING', `The data source ${dataset.dataSourceKey} is not configured.`);

    const runId = await this.prisma.$transaction(async (tx) => {
      const { snap, places } = await this.snapshot(tx, source.id);
      const dir = directoryPlaces(places);
      const inputs = parsed.rows.map((r) => ({ ...r, n: normaliseNesaRow(r.raw, dir) }));
      const { items, changes } = matchRows(inputs, snap);
      const rowOf = (i: number | null) => (i === null ? null : items[i].rowNumber);
      const digest = reportDigest(items, changes.map((c) => ({ ...c, rowNumber: rowOf(c.itemIndex) })));
      const decisions = decisionsDigest(changes.map((c) => ({ ...c, rowNumber: rowOf(c.itemIndex), decision: 'PENDING' })));
      const counts = countsOf(items, changes);
      const reconciliation = reconcile(parsed.summary, inputs.map((x) => x.n));
      const now = this.now();

      const run = await tx.schoolSyncRun.create({
        data: {
          datasetKey: dataset.key, normaliserVersion: dataset.normaliserVersion, dataSourceId: source.id,
          datasetLabel: q.label ?? `${dataset.name} — ${fileName}`, fileName, fileSha256, format: parsed.format,
          rowCount: parsed.rows.length, sourceSummary: json(parsed.summary), reconciliation, counts,
          reportDigest: digest, decisionsDigest: decisions, comparedAt: now, createdAt: now,
          expiresAt: new Date(now.getTime() + SYNC_RUN_TTL_MS), createdById: caller.id,
        },
        select: { id: true },
      });
      const itemIds = items.map(() => randomUUID());
      for (let i = 0; i < items.length; i += CHUNK) {
        await tx.schoolSyncItem.createMany({
          data: items.slice(i, i + CHUNK).map((it) => ({
            id: itemIds[it.index], runId: run.id, rowNumber: it.rowNumber, sourceRef: it.sourceRef,
            raw: json(it.raw), normalized: json(it.normalized), outcome: it.outcome, schoolId: it.schoolId,
            matchedBy: it.matchedBy, conflictGroup: it.conflictGroup, details: json(it.details),
            issues: it.issues as unknown as Prisma.InputJsonValue, issueCount: it.issues.length,
            conflictState: it.outcome === 'CONFLICT' ? 'OPEN' : null,
          })),
        });
      }
      for (let i = 0; i < changes.length; i += CHUNK) {
        await tx.schoolSyncChange.createMany({
          data: changes.slice(i, i + CHUNK).map((c) => ({
            runId: run.id, itemId: c.itemIndex === null ? null : itemIds[c.itemIndex], schoolId: c.schoolId,
            kind: c.kind, field: c.field, currentValue: json(c.currentValue), publishedValue: json(c.publishedValue),
          })),
        });
      }
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_DRY_RUN', entity: 'SchoolSyncRun', entityId: run.id,
        metadata: { datasetKey: dataset.key, fileName, fileSha256, format: parsed.format, rows: parsed.rows.length, counts, reconciliationMismatches: reconciliation.mismatches },
      }, tx);
      return run.id;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 180_000, maxWait: 10_000 });

    return this.get(runId);
  }

  /** One consistent read of the directory (inside the dry run's REPEATABLE READ transaction). */
  private async snapshot(tx: Tx, dataSourceId: string): Promise<{ snap: DirectorySnapshot; places: Array<{ province: string | null; district: string | null; sector: string | null }> }> {
    const schools = await tx.school.findMany({
      select: {
        id: true, name: true, nameKey: true, code: true, countryCode: true, province: true, district: true, sector: true,
        cell: true, village: true, accommodation: true, ownership: true, source: true, isActive: true,
      },
    });
    const externalIds = await tx.schoolExternalId.findMany({ where: { dataSourceId }, select: { externalKey: true, schoolId: true } });
    // Read only to avoid proposing a contact a school already has; never returned unmasked.
    const contacts = await tx.schoolContact.findMany({ where: { removedAt: null }, select: { schoolId: true, type: true, value: true } });
    const levels = await tx.schoolEducationLevel.findMany({ select: { schoolId: true, levelCode: true } });
    const links = await tx.schoolProgramme.findMany({ select: { schoolId: true, programmeId: true } });
    const programmes = await tx.programme.findMany({ select: { id: true, code: true, name: true, category: true, needsReview: true } });
    const group = <T>(rows: T[], key: (r: T) => string, value: (r: T) => string) => {
      const m = new Map<string, Set<string>>();
      for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(value(r)); }
      return m;
    };
    return {
      snap: {
        schools: schools.map((s) => ({ ...s, accommodation: s.accommodation ?? null, source: s.source })),
        externalIds: new Map(externalIds.map((e) => [e.externalKey, e.schoolId])),
        contacts: group(contacts, (c) => c.schoolId, (c) => `${c.type}|${c.value}`),
        levels: group(levels, (l) => l.schoolId, (l) => l.levelCode),
        programmeLinks: group(links, (l) => l.schoolId, (l) => l.programmeId),
        programmes,
      },
      places: schools.filter((s) => s.source === 'OFFICIAL_LIST' && s.countryCode === 'RW'),
    };
  }

  // ─── Reports ────────────────────────────────────────────────────────────────

  async list(q: ListSyncRunsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SchoolSyncRunWhereInput = { ...(q.datasetKey && { datasetKey: q.datasetKey }), ...(q.status && { status: q.status }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.schoolSyncRun.findMany({ where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: RUN_SELECT }),
      this.prisma.schoolSyncRun.count({ where }),
    ]);
    return paginated(rows.map((r) => this.view(r)), total, page, limit);
  }

  async get(id: string) {
    const run = await this.prisma.schoolSyncRun.findUnique({ where: { id }, select: RUN_SELECT });
    if (!run) throw new NotFoundException('Sync run not found.');
    return this.view(run);
  }

  async items(id: string, q: SyncItemsQueryDto) {
    await this.get(id);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SchoolSyncItemWhereInput = { runId: id, ...(q.outcome && { outcome: q.outcome }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.schoolSyncItem.findMany({
        where, skip, take, orderBy: [{ rowNumber: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        select: {
          id: true, rowNumber: true, sourceRef: true, raw: true, normalized: true, outcome: true, schoolId: true, matchedBy: true,
          conflictGroup: true, details: true, issues: true, issueCount: true, conflictState: true, sourceRecordId: true,
        },
      }),
      this.prisma.schoolSyncItem.count({ where }),
    ]);
    return paginated(rows.map((r) => ({ ...r, raw: maskRaw(r.raw), normalized: maskNormalized(r.normalized) })), total, page, limit);
  }

  async changes(id: string, q: SyncChangesQueryDto) {
    await this.get(id);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SchoolSyncChangeWhereInput = { runId: id, ...(q.kind && { kind: q.kind }), ...(q.decision && { decision: q.decision }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.schoolSyncChange.findMany({
        where, skip, take, orderBy: [{ kind: 'asc' }, { item: { rowNumber: 'asc' } }, { id: 'asc' }],
        select: {
          id: true, kind: true, field: true, schoolId: true, currentValue: true, publishedValue: true, decision: true,
          decidedAt: true, decidedBy: { select: { id: true, username: true } }, decisionNote: true, appliedAt: true,
          item: { select: { id: true, rowNumber: true, sourceRef: true, outcome: true } },
        },
      }),
      this.prisma.schoolSyncChange.count({ where }),
    ]);
    return paginated(rows.map((r) => ({
      ...r, currentValue: maskChangeValue(r.kind, r.currentValue), publishedValue: maskChangeValue(r.kind, r.publishedValue),
    })), total, page, limit);
  }

  /** The run as CSV: one line per item — no contact column (D6: contacts are never exported). */
  async reportCsv(id: string) {
    const run = await this.get(id);
    const items = await this.prisma.schoolSyncItem.findMany({
      where: { runId: id }, orderBy: [{ rowNumber: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      select: { id: true, rowNumber: true, sourceRef: true, normalized: true, outcome: true, schoolId: true, matchedBy: true, details: true, issues: true },
    });
    const changes = await this.prisma.schoolSyncChange.groupBy({ by: ['itemId', 'kind'], where: { runId: id }, _count: { _all: true } });
    const byItem = new Map<string, string[]>();
    for (const c of changes) if (c.itemId) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), `${c.kind}×${c._count._all}`]);
    const lines = items.map((it) => {
      const n = it.normalized as NormalisedRow | null;
      const d = (it.details ?? {}) as Record<string, unknown>;
      const issues = (it.issues as Array<{ code: string }>).map((x) => x.code);
      return [
        it.rowNumber, it.sourceRef, it.outcome, it.matchedBy, it.schoolId,
        n?.rawCode ?? (d.code as string | undefined) ?? null, n?.name ?? (d.name as string | undefined) ?? null,
        n?.province ?? null, n?.district ?? (d.district as string | undefined) ?? null, n?.sector ?? (d.sector as string | undefined) ?? null,
        (byItem.get(it.id) ?? []).sort().join('; '),
        n ? n.contacts.length : null,
        [...new Set(issues)].join('; '),
      ];
    });
    return {
      fileName: `school-sync-${run.id}.csv`,
      csv: toCsv(['Row', 'Source ref', 'Outcome', 'Matched by', 'School id', 'Code (as published)', 'Name (as published)', 'Province', 'District', 'Sector',
        'Proposed changes', 'Usable contacts (count only)', 'Issues'], lines),
    };
  }

  private view<T extends { status: string; expiresAt: Date; stagedPurgedAt: Date | null }>(run: T) {
    return { ...run, expired: run.status === 'PREVIEW' && run.expiresAt.getTime() <= this.now().getTime(), stagedPurged: run.stagedPurgedAt !== null };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** PREVIEW runs past their 24 hours → EXPIRED (each audited). */
  async expireRuns(): Promise<number> {
    const now = this.now();
    const due = await this.prisma.schoolSyncRun.findMany({ where: { status: 'PREVIEW', expiresAt: { lte: now } }, select: { id: true, datasetKey: true } });
    let expired = 0;
    for (const run of due) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.schoolSyncRun.updateMany({ where: { id: run.id, status: 'PREVIEW', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
        if (!count) return;
        expired++;
        await this.audit.log({ action: 'SCHOOL_SYNC_RUN_EXPIRED', entity: 'SchoolSyncRun', entityId: run.id, metadata: { datasetKey: run.datasetKey } }, tx);
      });
    }
    return expired;
  }

  /**
   * Staged raw / normalised values and change values of runs that ended 7+ days ago — expired,
   * superseded or applied — are cleared. Only staging columns are written; summaries, counts,
   * digests, outcomes, decisions, reviewers and links stay; source records and the directory are
   * never touched. Idempotent (a purged run is skipped).
   */
  async purgeStaging(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - SYNC_STAGING_RETENTION_MS);
    const due = await this.prisma.schoolSyncRun.findMany({
      where: {
        stagedPurgedAt: null,
        OR: [
          { status: 'EXPIRED', expiresAt: { lte: cutoff } },
          { status: 'SUPERSEDED', supersededAt: { lte: cutoff } },
          { status: 'APPLIED', appliedAt: { lte: cutoff } },
        ],
      },
      select: { id: true, status: true, datasetKey: true },
    });
    let purged = 0;
    for (const run of due) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.schoolSyncRun.updateMany({ where: { id: run.id, stagedPurgedAt: null }, data: { stagedPurgedAt: this.now() } });
        if (!count) return;
        const items = await tx.schoolSyncItem.updateMany({ where: { runId: run.id }, data: { raw: Prisma.DbNull, normalized: Prisma.DbNull } });
        const changes = await tx.schoolSyncChange.updateMany({ where: { runId: run.id }, data: { currentValue: Prisma.DbNull, publishedValue: Prisma.DbNull } });
        purged++;
        await this.audit.log({
          action: 'SCHOOL_SYNC_STAGING_PURGED', entity: 'SchoolSyncRun', entityId: run.id,
          metadata: { datasetKey: run.datasetKey, status: run.status, items: items.count, changes: changes.count },
        }, tx);
      });
    }
    return purged;
  }

  /** Daily: expire, then purge. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'school-sync-staging-purge' })
  async daily() {
    try {
      const expired = await this.expireRuns();
      const purged = await this.purgeStaging();
      if (expired || purged) this.logger.log(`School sync: ${expired} run(s) expired, ${purged} run(s) purged of staged data.`);
    } catch (err) {
      this.logger.error('School sync expiry / purge failed', err instanceof Error ? err.stack : String(err));
    }
  }
}
