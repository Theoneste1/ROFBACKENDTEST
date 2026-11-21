/**
 * The SCHOOL record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md). Every action calls the
 * same code as the single-school route, inside the item transaction, with its locks (school-locks.ts):
 *   activate / deactivate → AdminSchoolsService.setActiveInTx   (PATCH /admin/schools/:id/active)
 *   verify                → AdminSchoolsService.verifyInTx      (POST /admin/schools/:id/verify)
 * The selection is GET /admin/schools's filters (schoolListWhere); membership is guarded by SHARE locks on the tables
 * those filters read.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';

import { DECISION_MAX_IDS, DECISION_MAX_SELECTION, inChunks, normaliseFilterSelection, NoBulkParamsDto } from '../../bulk/bulk-decisions.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext, ItemResult } from '../../bulk/bulk-handler.js';
import { BulkRegistry } from '../../bulk/bulk-registry.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminSchoolsService, schoolListWhere, type SchoolListFilter } from '../admin-schools.service.js';
import { SchoolBulkSelectionDto } from './school-bulk.dto.js';
import {
  SCHOOL_ACTIONS, SCHOOL_MEMBERSHIP_TABLES, SCHOOL_SKIP_CODES, schoolAlreadyDone, schoolWarnings, type SchoolBulkAction,
} from './school-bulk.rules.js';

const SAMPLE_SELECT = {
  id: true, name: true, code: true, countryCode: true, district: true, sector: true, isActive: true, lastVerifiedAt: true,
} as const;

@Injectable()
export class SchoolBulkHandler implements BulkEntityHandler, OnModuleInit {
  readonly entityType = 'SCHOOL';
  readonly noun = 'schools';
  readonly actions = SCHOOL_ACTIONS;
  readonly maxIds = DECISION_MAX_IDS;
  readonly maxSelection = DECISION_MAX_SELECTION;
  readonly selectionDto = SchoolBulkSelectionDto;
  readonly paramsDto = NoBulkParamsDto;
  readonly membership = { kind: 'tableShare', tables: SCHOOL_MEMBERSHIP_TABLES } as const;
  readonly itemKey = 'school';
  readonly skipCodes = SCHOOL_SKIP_CODES;

  constructor(
    private readonly registry: BulkRegistry,
    private readonly prisma: PrismaService,
    private readonly schools: AdminSchoolsService,
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

  private whereOf(s: EngineSelection): Prisma.SchoolWhereInput {
    return s.mode === 'ids' ? { id: { in: s.ids } } : schoolListWhere(s.filter as SchoolListFilter);
  }

  count(db: Db, s: EngineSelection) {
    return db.school.count({ where: this.whereOf(s) });
  }

  async scanIds(db: Db, s: EngineSelection) {
    return (await db.school.findMany({ where: this.whereOf(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  }

  async preview(ids: string[], action: string) {
    const [sample, states] = await Promise.all([
      this.prisma.school.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      inChunks(ids, (chunk) => this.prisma.school.findMany({ where: { id: { in: chunk } }, select: { isActive: true, countryCode: true, lastVerifiedAt: true } })),
    ]);
    return { sample, warnings: schoolWarnings(action as SchoolBulkAction, states), requiresStepUp: false };
  }

  describe(db: Db, ids: string[]) {
    return db.school.findMany({ where: { id: { in: ids } }, select: SAMPLE_SELECT })
      .then((rows) => new Map<string, unknown>(rows.map((s) => [s.id, s])));
  }

  async processItem(ctx: ItemContext, actionName: string): Promise<ItemResult> {
    const { tx, op, actor, entityId } = ctx;
    const action = actionName as SchoolBulkAction;
    const exists = await tx.school.findUnique({ where: { id: entityId }, select: { id: true } });
    if (!exists) return { outcome: 'SKIPPED', code: 'NOT_FOUND', message: 'The school no longer exists.' };
    const by = { operationId: op.id };
    if (action === 'activate' || action === 'deactivate') {
      // setActiveInTx takes the directory lock, then the school row, then its name lock — and reads the state under
      // them: a school already in the requested state changes nothing and writes no audit row (as the single route).
      const r = await this.schools.setActiveInTx(tx, entityId, { isActive: action === 'activate', reason: op.reason ?? '' }, actor, by);
      if (!r.changed) return { outcome: 'SKIPPED', code: 'ALREADY_IN_STATE', message: `The school is already ${action === 'activate' ? 'active' : 'inactive'}.` };
      return { outcome: 'SUCCEEDED' };
    }
    // verify: the school row first (the single route's only lock), then its state under that lock.
    const [row] = await tx.$queryRaw<Array<{ lastVerifiedAt: Date | null; isActive: boolean }>>`
      SELECT "lastVerifiedAt", "isActive" FROM "School" WHERE "id" = ${entityId} FOR UPDATE`;
    if (schoolAlreadyDone('verify', row)) return { outcome: 'SKIPPED', code: 'ALREADY_IN_STATE', message: 'The school is already verified.' };
    await this.schools.verifyInTx(tx, entityId, { note: op.reason ?? undefined }, actor, by);
    return { outcome: 'SUCCEEDED' };
  }
}
