/**
 * The SCHOOL_AFFILIATION record type of the bulk engine — students' school claims (2026-11-20;
 * docs/operations/bulk-operations.md). Every action calls the same code as the single-claim route, inside the item
 * transaction, with its locks (the claim row, then — for a verification — the school FOR SHARE):
 *   verify → SchoolAffiliationService.verifyInTx   (POST /admin/school-affiliations/:id/verify; the decision notice is
 *                                                   enqueued in the transaction and dispatched after commit)
 *   reject → SchoolAffiliationService.rejectInTx   (POST /admin/school-affiliations/:id/reject)
 * The selection is GET /admin/school-affiliations's filters (affiliationListWhere); membership is guarded by a SHARE
 * lock on StudentSchoolAffiliation.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';

import { DECISION_MAX_IDS, DECISION_MAX_SELECTION, decisionSkip, inChunks, normaliseFilterSelection, NoBulkParamsDto } from '../../../bulk/bulk-decisions.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext, ItemResult } from '../../../bulk/bulk-handler.js';
import { BulkRegistry } from '../../../bulk/bulk-registry.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { affiliationListWhere, SchoolAffiliationService, type AffiliationListFilter } from '../school-affiliation.service.js';
import { AffiliationBulkSelectionDto } from './affiliation-bulk.dto.js';
import {
  AFFILIATION_ACTIONS, AFFILIATION_MEMBERSHIP_TABLES, AFFILIATION_SKIP_CODES, AFFILIATION_TARGET, affiliationWarnings, type AffiliationBulkAction,
} from './affiliation-bulk.rules.js';

const SAMPLE_SELECT = {
  id: true, status: true, supersededAt: true, claimedName: true, claimedCountry: true, createdAt: true,
  student: { select: { id: true, username: true, firstName: true, lastName: true } },
  school:  { select: { id: true, name: true, code: true, isActive: true } },
} as const;

@Injectable()
export class AffiliationBulkHandler implements BulkEntityHandler, OnModuleInit {
  readonly entityType = 'SCHOOL_AFFILIATION';
  readonly noun = 'school claims';
  readonly actions = AFFILIATION_ACTIONS;
  readonly maxIds = DECISION_MAX_IDS;
  readonly maxSelection = DECISION_MAX_SELECTION;
  readonly selectionDto = AffiliationBulkSelectionDto;
  readonly paramsDto = NoBulkParamsDto;
  readonly membership = { kind: 'tableShare', tables: AFFILIATION_MEMBERSHIP_TABLES } as const;
  readonly itemKey = 'affiliation';
  readonly skipCodes = AFFILIATION_SKIP_CODES;

  constructor(
    private readonly registry: BulkRegistry,
    private readonly prisma: PrismaService,
    private readonly affiliations: SchoolAffiliationService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  normaliseSelection(s: EngineSelection) {
    return normaliseFilterSelection(s);
  }

  normaliseParams() {
    return {};
  }

  async validate() { /* no parameters */ }

  private whereOf(s: EngineSelection): Prisma.StudentSchoolAffiliationWhereInput {
    return s.mode === 'ids' ? { id: { in: s.ids } } : affiliationListWhere(s.filter as AffiliationListFilter);
  }

  count(db: Db, s: EngineSelection) {
    return db.studentSchoolAffiliation.count({ where: this.whereOf(s) });
  }

  async scanIds(db: Db, s: EngineSelection) {
    return (await db.studentSchoolAffiliation.findMany({ where: this.whereOf(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  }

  async preview(ids: string[], action: string) {
    const [sample, rows] = await Promise.all([
      this.prisma.studentSchoolAffiliation.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      inChunks(ids, (chunk) => this.prisma.studentSchoolAffiliation.findMany({
        where: { id: { in: chunk } }, select: { status: true, supersededAt: true, schoolId: true, school: { select: { isActive: true } } },
      })),
    ]);
    const states = rows.map((r) => ({ status: r.status, current: r.supersededAt === null, hasSchool: r.schoolId !== null, schoolActive: r.school?.isActive ?? null }));
    return { sample, warnings: affiliationWarnings(action as AffiliationBulkAction, states), requiresStepUp: false };
  }

  describe(db: Db, ids: string[]) {
    return db.studentSchoolAffiliation.findMany({ where: { id: { in: ids } }, select: SAMPLE_SELECT })
      .then((rows) => new Map<string, unknown>(rows.map((a) => [a.id, a])));
  }

  async processItem(ctx: ItemContext, actionName: string): Promise<ItemResult> {
    const { tx, op, actor, entityId, noticeIds } = ctx;
    const action = actionName as AffiliationBulkAction;
    // The claim row first, FOR UPDATE (the single route's first lock): its state is then exactly what the decision sees.
    const [row] = await tx.$queryRaw<Array<{ status: string; supersededAt: Date | null }>>`
      SELECT "status"::text AS "status", "supersededAt" FROM "StudentSchoolAffiliation" WHERE "id" = ${entityId} FOR UPDATE`;
    if (!row) return { outcome: 'SKIPPED', code: 'NOT_FOUND', message: 'The claim no longer exists.' };
    if (row.supersededAt) return { outcome: 'SKIPPED', code: 'AFFILIATION_SUPERSEDED', message: 'This claim has been replaced by a newer one.' };
    const skip = decisionSkip(row.status, AFFILIATION_TARGET[action], ['PENDING']);
    if (skip) return skip;
    const by = { operationId: op.id };
    if (action === 'verify') {
      const { notice } = await this.affiliations.verifyInTx(tx, entityId, actor, op.reason ?? undefined, by);
      noticeIds.push(notice);
    } else {
      await this.affiliations.rejectInTx(tx, entityId, actor, op.reason ?? '', by);
    }
    return { outcome: 'SUCCEEDED' };
  }
}
