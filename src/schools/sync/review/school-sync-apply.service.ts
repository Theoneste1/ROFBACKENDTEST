/**
 * Directory sync — S2b apply (owner-approved 2026-11-11). The ONLY code that writes the directory
 * for a sync, and only here:
 *
 *   apply                  Super Admin, with the apply token of the run's current approval
 *   resolveAfterApply      Super Admin: an applied run's open CONFLICT / POSSIBLE_DUPLICATE row
 *                          linked to a school — identifiers, source-record link and
 *                          lastSourceSyncAt only; no school field is changed
 *
 * One READ COMMITTED transaction, lock first:
 *   1. the directory lock EXCLUSIVE (school-locks.ts) — every school write waits;
 *   2. the run row FOR UPDATE: PREVIEW and not expired, or 409 RUN_NOT_APPLICABLE; the token's id,
 *      generation and digests equal the run's, or 409 SYNC_REVIEW_OUTDATED;
 *   3. every school row it reads for its writes, FOR UPDATE in ascending id order (as student
 *      claims lock schools: no deadlock);
 *   4. the comparison recomputed from the staged rows (sync-compare.ts) must give the reviewed
 *      report digest; approved changes must have their dependencies approved; every resulting
 *      place must be known or an approved new place (409 SYNC_PLACE_INCONSISTENT); codes free;
 *   5. approved changes only — schools created (OFFICIAL_LIST, the Super Admin as creator) or
 *      updated field by field; contacts (ADMIN_ONLY, unverified), levels, programmes (new ones
 *      needsReview); NESA external ids for code and fingerprint (an earlier fingerprint kept as
 *      superseded); a source record for EVERY row (conflicts and invalid rows included);
 *      lastSourceSyncAt; one audit entry per change (contact values masked); earlier open runs of
 *      the dataset SUPERSEDED; the run APPLIED with its metrics.
 * Whole-transaction retry: 3 attempts, only P2034 / 40001, then 409 SYNC_APPLY_CONFLICT. Any error
 * rolls back everything — directory writes and audit entries; a refusal is then audited on its own.
 * Never: deactivating a school, overwriting an unapproved field, deleting anything, using a
 * disputed code. Idempotent: what exists (source records, contacts, levels, programme links,
 * external ids) is not created again.
 */
import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditService, type AuditEntry } from '../../../audit/audit.service.js';
import type { CallerCtx } from '../../../common/auth-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { maskContact } from '../../directory/school-contacts.js';
import { schoolKey } from '../../school-key.js';
import { lockSchoolDirectory } from '../../school-locks.js';
import { directoryPlaces, normaliseNesaRow, NESA_NORMALISER_VERSION, type NormalisedRow } from '../nesa-normaliser.js';
import { canonicalJson, compareRows, loadDirectorySnapshot, stagedRows } from '../sync-compare.js';
import type { SyncResolutionAction } from '../sync-matcher.js';
import { approvalKey, checkApproval, tokenSha256, type ApprovalClaims } from './approval-token.js';
import { approvedResolutions, lockRun, manualOutcome, notApplicable } from './school-sync-review.service.js';
import type { ApplySyncRunDto, ResolveAfterApplyDto } from './school-sync-review.dto.js';
import { decisionsDigestOf, placeKey, unmetDependencies, type ReviewChange, type ReviewItem } from './sync-decisions.js';
import { withSerializationRetry } from './sync-retry.js';

type Tx = Prisma.TransactionClient;
const CHUNK = 1000;
const FIELD_KINDS = new Set(['FILL_EMPTY', 'CHANGE', 'NAME_RESTORE']);
const REFUSALS = new Set(['RUN_NOT_APPLICABLE', 'SYNC_REVIEW_OUTDATED', 'SYNC_PLACE_INCONSISTENT', 'SYNC_APPLY_CONFLICT']);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

@Injectable()
export class SchoolSyncApplyService {
  /** The clock (tests move it). */
  now = () => new Date();
  private readonly key: Buffer;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.key = approvalKey(config.getOrThrow<string>('JWT_SECRET'));
    this.timeoutMs = Number(config.get<string>('SYNC_APPLY_TIMEOUT_MS') ?? 120_000);
  }

  // ─── Apply ──────────────────────────────────────────────────────────────────

  async apply(runId: string, dto: ApplySyncRunDto, caller: CallerCtx) {
    const tokenHash = tokenSha256(dto.token);
    const check = checkApproval(this.key, dto.token, { run: runId, sub: caller.id, now: this.now().getTime() });
    if (!check.ok) {
      await this.refused(runId, caller, `TOKEN_${check.reason}`, { tokenSha256: tokenHash });
      if (check.reason === 'EXPIRED') throw new AppError(HttpStatus.CONFLICT, 'SYNC_REVIEW_OUTDATED', 'The approval has expired; approve the run again.', { reason: 'TOKEN_EXPIRED' });
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_APPROVAL_TOKEN', 'This approval token is not valid for this run and this Super Admin.', { reason: check.reason });
    }
    const started = Date.now();
    try {
      return await withSerializationRetry(
        (attempt) => this.prisma.$transaction((tx) => this.applyOnce(tx, runId, check.claims, tokenHash, caller, attempt, started), { timeout: this.timeoutMs, maxWait: 10_000 }),
        () => new AppError(HttpStatus.CONFLICT, 'SYNC_APPLY_CONFLICT', 'The directory kept changing while the run was being applied; nothing was applied. Try again.'),
      );
    } catch (err) {
      if (err instanceof AppError && REFUSALS.has(err.code)) {
        await this.refused(runId, caller, err.code, { tokenId: check.claims.jti, tokenSha256: tokenHash, details: err.details ?? null });
      }
      throw err;
    }
  }

  private async applyOnce(tx: Tx, runId: string, claims: ApprovalClaims, tokenHash: string, caller: CallerCtx, attempt: number, started: number) {
    const now = this.now();
    let memoryPeak = process.memoryUsage().rss;
    const sample = () => { memoryPeak = Math.max(memoryPeak, process.memoryUsage().rss); };
    const lockStart = Date.now();
    await lockSchoolDirectory(tx, 'exclusive');
    const lockWaitMs = Date.now() - lockStart;
    const run = await lockRun(tx, runId);
    if (run.status !== 'PREVIEW' || run.expiresAt.getTime() <= now.getTime()) throw notApplicable(run, now);
    const stale = (reason: string, extra: Record<string, unknown> = {}) =>
      new AppError(HttpStatus.CONFLICT, 'SYNC_REVIEW_OUTDATED', 'The review is out of date: recompare, review and approve again. Nothing was applied.', { reason, ...extra });
    if (claims.jti !== run.approvalTokenId) throw stale('TOKEN_REPLACED');
    if (run.approvedGeneration !== run.reviewGeneration || claims.gen !== run.reviewGeneration) throw stale('REVIEW_CHANGED');
    if (claims.file !== run.fileSha256 || claims.report !== run.reportDigest || claims.decisions !== run.decisionsDigest) throw stale('DIGEST_MISMATCH');

    const items = await tx.schoolSyncItem.findMany({ where: { runId } });
    const changes = await tx.schoolSyncChange.findMany({ where: { runId, retiredAt: null } });
    if (decisionsDigestOf(changes) !== run.decisionsDigest) throw stale('DECISIONS_CHANGED');
    if (unmetDependencies(changes as unknown as ReviewChange[], items as unknown as ReviewItem[]).length) throw stale('DEPENDENCY_NOT_APPROVED');
    const rowOf = new Map(items.map((i) => [i.id, i.rowNumber]));
    const resolutions = approvedResolutions(changes, rowOf);
    const approved = changes.filter((c) => c.decision === 'APPROVED');

    // Ordered row locks: every school this apply reads for its writes, ascending id.
    const lockIds = new Set<string>();
    for (const it of items) if (it.schoolId) lockIds.add(it.schoolId);
    for (const c of approved) if (c.schoolId) lockIds.add(c.schoolId);
    for (const r of resolutions.values()) if (r.action === 'LINK') lockIds.add(r.schoolId);
    const sorted = [...lockIds].sort();
    for (let i = 0; i < sorted.length; i += 500) {
      await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ANY(${sorted.slice(i, i + 500)}::text[]) ORDER BY "id" FOR UPDATE`;
    }

    // The reviewed comparison must still be the comparison.
    const { snap, places } = await loadDirectorySnapshot(tx, run.dataSourceId);
    const cmp = compareRows(stagedRows(items), snap, places, resolutions);
    if (cmp.reportDigest !== run.reportDigest) throw stale('DIRECTORY_CHANGED');
    sample();

    const schoolById = new Map(snap.schools.map((s) => [s.id, s]));
    const itemById = new Map(items.map((i) => [i.id, i]));
    const itemByRow = new Map(items.filter((i) => i.rowNumber !== null).map((i) => [i.rowNumber!, i]));
    const known = new Set(places.map((p) => placeKey(p)));
    for (const c of approved) if (c.kind === 'NEW_PLACE') known.add(placeKey(c.publishedValue as object));

    // New schools.
    const createdFor = new Map<string, string>();   // itemId → new school id
    const creates = approved.filter((c) => c.kind === 'CREATE_SCHOOL').map((c) => {
      const v = c.publishedValue as Record<string, string | null>;
      const id = randomUUID();
      createdFor.set(c.itemId!, id);
      return { change: c, id, v };
    });
    // Field updates, per school.
    const updates = new Map<string, { data: Record<string, unknown>; changes: typeof approved }>();
    for (const c of approved.filter((x) => FIELD_KINDS.has(x.kind))) {
      const u = updates.get(c.schoolId!) ?? { data: {}, changes: [] };
      u.data[c.field!] = c.publishedValue;
      u.changes.push(c);
      updates.set(c.schoolId!, u);
    }
    // Places: every resulting place is known or an approved new place.
    const badPlaces: Array<Record<string, unknown>> = [];
    for (const { change, v } of creates) if (!known.has(placeKey(v))) badPlaces.push({ changeId: change.id, place: placeKey(v) });
    for (const [schoolId, u] of updates) {
      if (!['province', 'district', 'sector'].some((f) => f in u.data)) continue;
      const result = { ...schoolById.get(schoolId)!, ...u.data };
      if (!known.has(placeKey(result))) badPlaces.push({ schoolId, place: placeKey(result) });
    }
    if (badPlaces.length) {
      throw new AppError(HttpStatus.CONFLICT, 'SYNC_PLACE_INCONSISTENT', 'Approved changes would leave schools in a place that is not in the directory (approve the place, or every part of the move). Nothing was applied.', { schools: badPlaces.slice(0, 50) });
    }
    // Codes: free, and each assigned once.
    const finalCode = new Map<string, string | null>(snap.schools.map((s) => [s.id, s.code]));
    const assigned = new Map<string, string>();
    const holderOf = new Map(snap.schools.filter((s) => s.code).map((s) => [s.code!, s.id]));
    const assign = (code: string | null | undefined, schoolId: string) => {
      if (!code) return;
      const holder = holderOf.get(code);
      if ((holder && holder !== schoolId) || (assigned.has(code) && assigned.get(code) !== schoolId)) throw stale('CODE_TAKEN', { code });
      assigned.set(code, schoolId);
      finalCode.set(schoolId, code);
    };
    for (const { id, v } of creates) assign(v.code, id);
    for (const [schoolId, u] of updates) if ('code' in u.data) assign(u.data.code as string, schoolId);

    // ── Writes ──
    const entries: AuditEntry[] = [];
    const auditOf = new Map<string, string>();   // changeId → audit id
    const log = (changeId: string | null, e: Omit<AuditEntry, 'id' | 'actorId' | 'actorRole'>) => {
      const id = randomUUID();
      entries.push({ ...e, id, actorId: caller.id, actorRole: caller.role });
      if (changeId) auditOf.set(changeId, id);
      return id;
    };
    const rowOfChange = (c: { itemId: string | null }) => (c.itemId ? rowOf.get(c.itemId) ?? null : null);

    for (const part of chunks(creates)) {
      await tx.school.createMany({
        data: part.map(({ id, v }) => ({
          id, name: v.name!, nameKey: schoolKey(v.name!), code: v.code ?? null, countryCode: 'RW',
          province: v.province, district: v.district, sector: v.sector, cell: v.cell, village: v.village,
          location: `${v.sector}, ${v.district}`, ownership: v.ownership, accommodation: v.accommodation as never,
          source: 'OFFICIAL_LIST', isActive: true, createdById: caller.id, lastSourceSyncAt: now,
        })),
      });
    }
    for (const { change, id, v } of creates) {
      log(change.id, {
        action: 'CREATE_SCHOOL', entity: 'School', entityId: id,
        metadata: { via: 'SYNC', runId, changeId: change.id, row: rowOfChange(change), school: { ...v, newPlace: undefined, countryCode: 'RW', source: 'OFFICIAL_LIST', isActive: true } },
      });
    }
    for (const [schoolId, u] of updates) {
      await tx.school.update({ where: { id: schoolId }, data: { ...u.data, ...(typeof u.data.name === 'string' && { nameKey: schoolKey(u.data.name) }) } });
      for (const c of u.changes) {
        log(c.id, {
          action: 'UPDATE_SCHOOL', entity: 'School', entityId: schoolId,
          metadata: { via: 'SYNC', runId, changeId: c.id, kind: c.kind, row: rowOfChange(c), changes: { [c.field!]: { from: c.currentValue ?? null, to: c.publishedValue ?? null } } },
        });
      }
    }
    for (const c of approved.filter((x) => x.kind === 'NEW_PLACE')) {
      log(c.id, { action: 'SCHOOL_DIRECTORY_PLACE_APPROVED', entity: 'SchoolSyncRun', entityId: runId, metadata: { changeId: c.id, place: c.publishedValue } });
    }
    sample();

    // Additions.
    const targetOf = (c: { schoolId: string | null; itemId: string | null }) => c.schoolId ?? (c.itemId ? createdFor.get(c.itemId) ?? null : null);
    const contactRows: Prisma.SchoolContactCreateManyInput[] = [];
    const contactSeen = new Set<string>();
    for (const c of approved.filter((x) => x.kind === 'ADD_CONTACT')) {
      const v = c.publishedValue as { type: 'EMAIL' | 'PHONE'; value: string };
      const schoolId = targetOf(c)!;
      const k = `${schoolId}|${v.type}|${v.value}`;
      const present = snap.contacts.get(schoolId)?.has(`${v.type}|${v.value}`) || contactSeen.has(k);
      const id = randomUUID();
      if (!present) { contactSeen.add(k); contactRows.push({ id, schoolId, type: v.type, value: v.value, dataSourceId: run.dataSourceId }); }
      log(c.id, {
        action: 'UPDATE_SCHOOL_CONTACTS', entity: 'School', entityId: schoolId,
        metadata: { via: 'SYNC', runId, changeId: c.id, row: rowOfChange(c), ...(present ? { skipped: 'ALREADY_PRESENT', type: v.type } : { added: [{ id, type: v.type, masked: maskContact(v.type, v.value), visibility: 'ADMIN_ONLY', verified: false }] }) },
      });
    }
    for (const part of chunks(contactRows)) await tx.schoolContact.createMany({ data: part });

    const levelRows: Prisma.SchoolEducationLevelCreateManyInput[] = [];
    for (const c of approved.filter((x) => x.kind === 'ADD_LEVEL')) {
      const v = c.publishedValue as { code: string; qualifier: string | null; sourceToken: string };
      const schoolId = targetOf(c)!;
      levelRows.push({ schoolId, levelCode: v.code, qualifier: v.qualifier, sourceToken: v.sourceToken, dataSourceId: run.dataSourceId });
      log(c.id, { action: 'UPDATE_SCHOOL_OFFERINGS', entity: 'School', entityId: schoolId, metadata: { via: 'SYNC', runId, changeId: c.id, row: rowOfChange(c), levels: { added: [{ code: v.code, qualifier: v.qualifier }] } } });
    }
    for (const part of chunks(levelRows)) await tx.schoolEducationLevel.createMany({ data: part, skipDuplicates: true });

    const programmes = [...snap.programmes];
    const newProgrammes: Prisma.ProgrammeCreateManyInput[] = [];
    const linkRows: Prisma.SchoolProgrammeCreateManyInput[] = [];
    for (const c of approved.filter((x) => x.kind === 'ADD_PROGRAMME')) {
      const v = c.publishedValue as { programmeId: string | null; code: string | null; name: string; category: 'A_LEVEL_COMBINATION' | 'TVET_TRADE' | 'OTHER'; tvetLevel: number | null; sourceToken: string };
      let ref = (v.programmeId && programmes.find((p) => p.id === v.programmeId))
        || programmes.find((p) => (v.code && p.code && p.code.toUpperCase() === v.code.toUpperCase()) || (!v.code && p.category === v.category && p.name.toUpperCase() === v.name.toUpperCase()));
      let created = false;
      if (!ref) {
        const id = randomUUID();
        newProgrammes.push({ id, code: v.code, name: v.name, category: v.category, tvetLevel: v.tvetLevel, needsReview: true });
        ref = { id, code: v.code, name: v.name, category: v.category, needsReview: true };
        programmes.push(ref);
        created = true;
      }
      const schoolId = targetOf(c)!;
      linkRows.push({ schoolId, programmeId: ref.id, sourceToken: v.sourceToken, dataSourceId: run.dataSourceId });
      log(c.id, { action: 'UPDATE_SCHOOL_OFFERINGS', entity: 'School', entityId: schoolId, metadata: { via: 'SYNC', runId, changeId: c.id, row: rowOfChange(c), programmes: { added: [ref.id], createdProgramme: created, needsReview: ref.needsReview } } });
    }
    for (const part of chunks(newProgrammes)) await tx.programme.createMany({ data: part });
    for (const part of chunks(linkRows)) await tx.schoolProgramme.createMany({ data: part, skipDuplicates: true });
    sample();

    // The school of each source row after apply.
    const schoolOfItem = (it: (typeof items)[number]): string | null => {
      if (it.schoolId) return it.schoolId;
      if (it.outcome === 'NEW') return createdFor.get(it.id) ?? null;
      if (it.outcome === 'DUPLICATE_ROW') {
        const first = itemByRow.get((it.details as { duplicateOfRow?: number } | null)?.duplicateOfRow ?? -1);
        return first ? first.schoolId ?? createdFor.get(first.id) ?? null : null;
      }
      return null;
    };

    // External ids (NESA): the code (never a disputed one) and the fingerprint of every linked row.
    const owners = new Map(snap.externalIds);
    const newIds: Prisma.SchoolExternalIdCreateManyInput[] = [];
    const seen = new Set<string>();
    const newFingerprints = new Map<string, Set<string>>();   // schoolId → its fingerprint keys now
    for (const it of items) {
      if (it.rowNumber === null || !['MATCHED', 'NEW', 'DUPLICATE_ROW'].includes(it.outcome)) continue;
      const schoolId = schoolOfItem(it);
      const n = it.normalized as NormalisedRow | null;
      if (!schoolId || !n) continue;
      const d = (it.details ?? {}) as { codeDisputed?: boolean };
      const res = resolutions.get(it.rowNumber);
      const codeKey = res?.code ?? (!d.codeDisputed && n.codeStatus === 'VALID' ? n.code : null);
      const keys: Array<[string, 'CODE' | 'FINGERPRINT']> = [];
      if (codeKey && finalCode.get(schoolId) === codeKey) keys.push([codeKey, 'CODE']);
      if (n.fingerprint) keys.push([n.fingerprint, 'FINGERPRINT']);
      for (const [key, kind] of keys) {
        const owner = owners.get(key);
        if (owner && owner !== schoolId) throw stale('EXTERNAL_ID_TAKEN', { kind });
        if (kind === 'FINGERPRINT') newFingerprints.set(schoolId, new Set([...(newFingerprints.get(schoolId) ?? []), key]));
        if (owner) { seen.add(key); continue; }
        owners.set(key, schoolId);
        newIds.push({ id: randomUUID(), dataSourceId: run.dataSourceId, externalKey: key, kind, schoolId, firstSeenAt: now, lastSeenAt: now });
      }
    }
    for (const part of chunks(newIds)) await tx.schoolExternalId.createMany({ data: part });
    if (seen.size) await tx.schoolExternalId.updateMany({ where: { dataSourceId: run.dataSourceId, externalKey: { in: [...seen] } }, data: { lastSeenAt: now } });
    // A school's earlier fingerprints stay (superseded): a later export with the old name or place still finds it.
    const older = [...snap.externalIds].filter(([key, schoolId]) => key.startsWith('fp1|') && newFingerprints.has(schoolId) && !newFingerprints.get(schoolId)!.has(key)).map(([key]) => key);
    if (older.length) await tx.schoolExternalId.updateMany({ where: { dataSourceId: run.dataSourceId, externalKey: { in: older }, supersededAt: null }, data: { supersededAt: now } });

    // A permanent source record for EVERY row (never twice for the same file and row).
    const existing = new Map((await tx.schoolSourceRecord.findMany({
      where: { dataSourceId: run.dataSourceId, datasetSha256: run.fileSha256 }, select: { id: true, sourceRef: true, schoolId: true },
    })).map((r) => [r.sourceRef, r]));
    const records: Prisma.SchoolSourceRecordCreateManyInput[] = [];
    const itemRecord: Array<[string, string]> = [];
    for (const it of items) {
      if (it.rowNumber === null || !it.sourceRef) continue;
      const schoolId = schoolOfItem(it);
      const found = existing.get(it.sourceRef);
      if (found) {
        if (!found.schoolId && schoolId) await tx.schoolSourceRecord.update({ where: { id: found.id }, data: { schoolId, matchedBy: it.matchedBy ?? 'CREATED' } });
        continue;
      }
      const id = randomUUID();
      const issues = (it.issues ?? []) as Prisma.InputJsonValue;
      records.push({
        id, dataSourceId: run.dataSourceId, datasetLabel: run.datasetLabel, datasetSha256: run.fileSha256, sourceRef: it.sourceRef,
        raw: it.raw as Prisma.InputJsonValue, rowHash: sha256(canonicalJson(it.raw)), schoolId,
        matchedBy: schoolId ? (it.matchedBy ?? (createdFor.has(it.id) ? 'CREATED' : null)) : null,
        issues, issueCount: Array.isArray(it.issues) ? it.issues.length : 0, syncRunId: runId,
      });
      itemRecord.push([it.id, id]);
    }
    for (const part of chunks(records)) await tx.schoolSourceRecord.createMany({ data: part });
    for (const part of chunks(itemRecord)) {
      await tx.$executeRaw`UPDATE "SchoolSyncItem" AS i SET "sourceRecordId" = v.r FROM unnest(${part.map((p) => p[0])}::text[], ${part.map((p) => p[1])}::text[]) AS v(id, r) WHERE i."id" = v.id`;
    }
    sample();

    // Every school compared with the source (matched or created).
    const synced = [...new Set(items.filter((it) => it.outcome === 'MATCHED' || it.outcome === 'DUPLICATE_ROW').map(schoolOfItem).filter((x): x is string => !!x && !createdFor.has(x)))];
    for (const part of chunks(synced)) await tx.school.updateMany({ where: { id: { in: part } }, data: { lastSourceSyncAt: now } });

    // Resolutions.
    for (const c of approved.filter((x) => x.kind === 'RESOLVE_CONFLICT')) {
      const it = itemById.get(c.itemId!)!;
      const auditId = log(c.id, { action: 'SCHOOL_SYNC_CONFLICT_RESOLVED', entity: 'SchoolSyncItem', entityId: it.id, metadata: { runId, changeId: c.id, row: it.rowNumber, resolution: c.publishedValue, schoolId: schoolOfItem(it) } });
      await tx.schoolSyncItem.update({ where: { id: it.id }, data: { conflictState: 'RESOLVED', resolution: c.publishedValue as Prisma.InputJsonValue, resolvedById: caller.id, resolvedAt: now, auditLogId: auditId } });
    }

    // Earlier open runs of the dataset are superseded (never an applied one; never a later one).
    const earlier = await tx.schoolSyncRun.findMany({
      where: { datasetKey: run.datasetKey, id: { not: runId }, status: { in: ['PREVIEW', 'EXPIRED'] }, createdAt: { lt: run.createdAt } },
      select: { id: true, approvalTokenId: true },
    });
    if (earlier.length) {
      await tx.schoolSyncRun.updateMany({ where: { id: { in: earlier.map((r) => r.id) }, status: { in: ['PREVIEW', 'EXPIRED'] } }, data: { status: 'SUPERSEDED', supersededAt: now, supersededByRunId: runId } });
      for (const r of earlier) {
        log(null, { action: 'SCHOOL_SYNC_RUN_SUPERSEDED', entity: 'SchoolSyncRun', entityId: r.id, metadata: { supersededByRunId: runId } });
        if (r.approvalTokenId) log(null, { action: 'SCHOOL_SYNC_TOKEN_INVALIDATED', entity: 'SchoolSyncRun', entityId: r.id, metadata: { tokenId: r.approvalTokenId, reason: 'SUPERSEDED' } });
      }
    }

    // The audit trail of the changes, then the run.
    const counts = {
      schoolsCreated: creates.length, fieldsUpdated: approved.filter((c) => c.kind === 'FILL_EMPTY' || c.kind === 'CHANGE').length,
      namesRestored: approved.filter((c) => c.kind === 'NAME_RESTORE').length, placesApproved: approved.filter((c) => c.kind === 'NEW_PLACE').length,
      contactsAdded: contactRows.length, levelsAdded: levelRows.length, programmeLinks: linkRows.length, programmesCreated: newProgrammes.length,
      resolutions: approved.filter((c) => c.kind === 'RESOLVE_CONFLICT').length, externalIdsCreated: newIds.length, fingerprintsSuperseded: older.length,
      sourceRecordsCreated: records.length, schoolsSynced: synced.length, runsSuperseded: earlier.length, auditEntries: entries.length + 1,
    };
    const appliedIds = [...auditOf.keys()];
    for (let i = 0; i < appliedIds.length; i += CHUNK) {
      const ids = appliedIds.slice(i, i + CHUNK);
      await tx.$executeRaw`UPDATE "SchoolSyncChange" AS c SET "appliedAt" = ${now}, "auditLogId" = v.a FROM unnest(${ids}::text[], ${ids.map((id) => auditOf.get(id)!)}::text[]) AS v(id, a) WHERE c."id" = v.id`;
    }
    for (const part of chunks(entries)) await this.audit.logMany(part, tx);
    sample();
    const metrics = { durationMs: Date.now() - started, lockWaitMs, attempt, memoryPeakMb: Math.round(memoryPeak / (1024 * 1024)), rows: counts };
    await tx.schoolSyncRun.update({ where: { id: runId }, data: { status: 'APPLIED', appliedAt: now, appliedById: caller.id, metrics } });
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_APPLIED', entity: 'SchoolSyncRun', entityId: runId,
      metadata: { tokenId: claims.jti, tokenSha256: tokenHash, reviewGeneration: run.reviewGeneration, counts, metrics },
    }, tx);
    return { runId, status: 'APPLIED', appliedAt: now.toISOString(), counts, metrics };
  }

  // ─── After apply ────────────────────────────────────────────────────────────

  /** Link an applied run's open CONFLICT / POSSIBLE_DUPLICATE row to a school: identifiers only. */
  async resolveAfterApply(runId: string, itemId: string, dto: ResolveAfterApplyDto, caller: CallerCtx) {
    return withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      const now = this.now();
      await lockSchoolDirectory(tx, 'exclusive');
      const run = await lockRun(tx, runId);
      if (run.status !== 'APPLIED') {
        throw new AppError(HttpStatus.CONFLICT, 'RUN_NOT_APPLICABLE', 'Only an applied run\'s open rows are resolved here (before apply: propose, then decide).', { status: run.status });
      }
      if (run.normaliserVersion !== NESA_NORMALISER_VERSION) throw new AppError(HttpStatus.CONFLICT, 'RUN_NOT_APPLICABLE', 'This run was read with another normaliser.', { normaliserVersion: run.normaliserVersion });
      await tx.$queryRaw`SELECT 1 FROM "SchoolSyncItem" WHERE "id" = ${itemId} AND "runId" = ${runId} FOR UPDATE`;
      const item = await tx.schoolSyncItem.findFirst({ where: { id: itemId, runId } });
      if (!item) throw new NotFoundException('Row not found in this run.');
      const manual = manualOutcome(item);
      if (!manual) throw new AppError(HttpStatus.CONFLICT, 'NOT_A_MANUAL_REVIEW_ROW', 'Only CONFLICT and POSSIBLE_DUPLICATE rows are resolved by review.');
      if (item.conflictState === 'RESOLVED') throw new AppError(HttpStatus.CONFLICT, 'ALREADY_RESOLVED', 'This row is already resolved.');
      await tx.$queryRaw`SELECT 1 FROM "School" WHERE "id" = ${dto.schoolId} FOR UPDATE`;
      const school = await tx.school.findUnique({ where: { id: dto.schoolId }, select: { id: true, code: true, countryCode: true } });
      if (!school || school.countryCode !== 'RW') throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL', 'No such school in Rwanda\'s directory.');
      if (manual === 'POSSIBLE_DUPLICATE' && !(((item.details ?? {}) as { candidates?: Array<{ id: string }> }).candidates ?? []).some((c) => c.id === school.id)) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_CANDIDATE', 'A possible duplicate can only be linked to one of its listed candidates.');
      }
      const record = item.sourceRecordId
        ? await tx.schoolSourceRecord.findUnique({ where: { id: item.sourceRecordId } })
        : await tx.schoolSourceRecord.findUnique({ where: { dataSourceId_datasetSha256_sourceRef: { dataSourceId: run.dataSourceId, datasetSha256: run.fileSha256, sourceRef: item.sourceRef ?? '' } } });
      if (!record) throw new AppError(HttpStatus.CONFLICT, 'SOURCE_RECORD_MISSING', 'The row has no source record.');
      if (record.schoolId && record.schoolId !== school.id) throw new AppError(HttpStatus.CONFLICT, 'SOURCE_RECORD_LINKED', 'The row\'s source record is already linked to another school.', { schoolId: record.schoolId });

      const places = await tx.school.findMany({ where: { source: 'OFFICIAL_LIST', countryCode: 'RW' }, select: { province: true, district: true, sector: true }, distinct: ['province', 'district', 'sector'] });
      const n = normaliseNesaRow(record.raw as Record<string, string>, directoryPlaces(places));
      const keys: Array<[string, 'CODE' | 'FINGERPRINT']> = [];
      if (n.fingerprint) keys.push([n.fingerprint, 'FINGERPRINT']);
      if (manual === 'POSSIBLE_DUPLICATE' && n.codeStatus === 'VALID' && school.code === n.code) keys.push([n.code!, 'CODE']);   // never a disputed code
      const externalIds: Array<{ kind: string; created: boolean }> = [];
      for (const [externalKey, kind] of keys) {
        const found = await tx.schoolExternalId.findUnique({ where: { dataSourceId_externalKey: { dataSourceId: run.dataSourceId, externalKey } } });
        if (found && found.schoolId !== school.id) throw new AppError(HttpStatus.CONFLICT, 'EXTERNAL_ID_TAKEN', 'This row\'s identity in the source already belongs to another school.', { kind });
        if (found) await tx.schoolExternalId.update({ where: { id: found.id }, data: { lastSeenAt: now } });
        else await tx.schoolExternalId.create({ data: { dataSourceId: run.dataSourceId, externalKey, kind, schoolId: school.id, firstSeenAt: now, lastSeenAt: now } });
        externalIds.push({ kind, created: !found });
      }
      if (!record.schoolId) await tx.schoolSourceRecord.update({ where: { id: record.id }, data: { schoolId: school.id, matchedBy: 'REVIEW' } });
      await tx.school.update({ where: { id: school.id }, data: { lastSourceSyncAt: now } });   // no other field
      const auditId = randomUUID();
      const link: SyncResolutionAction = 'LINK';
      const resolution = { action: link, schoolId: school.id, afterApply: true, note: dto.note ?? null };
      await tx.schoolSyncItem.update({ where: { id: item.id }, data: { conflictState: 'RESOLVED', resolution, resolvedById: caller.id, resolvedAt: now, auditLogId: auditId } });
      await this.audit.log({
        id: auditId, actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_CONFLICT_RESOLVED', entity: 'SchoolSyncItem', entityId: item.id,
        metadata: { runId, row: item.rowNumber, outcome: manual, schoolId: school.id, afterApply: true, sourceRecordId: record.id, externalIds },
      }, tx);
      return { itemId: item.id, schoolId: school.id, sourceRecordId: record.id, externalIds };
    }), () => new AppError(HttpStatus.CONFLICT, 'SYNC_APPLY_CONFLICT', 'The directory kept changing; nothing was changed. Try again.'));
  }

  private async refused(runId: string, caller: CallerCtx, reason: string, metadata: Record<string, unknown>) {
    await this.audit.log({ actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_SYNC_REFUSED', entity: 'SchoolSyncRun', entityId: runId, metadata: { reason, ...metadata } });
  }
}
