/**
 * The ASSIGNMENT record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md). Every action calls
 * the same code as the single-assignment route, inside the item transaction:
 *   publish → AssignmentsService.publishInTx   (PATCH /assignments/:id/publish; AssignmentPublished after the commit)
 *   close   → AssignmentsService.closeInTx     (PATCH /assignments/:id/close)
 *   archive → AssignmentsService.archiveInTx   (PATCH /assignments/:id/archive)
 * The selection is GET /assignments's filters for an Administrator (assignmentListWhere); membership is guarded by a
 * SHARE lock on the Assignment table.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { DECISION_MAX_IDS, DECISION_MAX_SELECTION, decisionSkip, inChunks, normaliseFilterSelection, NoBulkParamsDto } from '../../bulk/bulk-decisions.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext, ItemResult } from '../../bulk/bulk-handler.js';
import { BulkRegistry } from '../../bulk/bulk-registry.js';
import type { AssignmentStatus, Prisma } from '../../generated/prisma/client.js';
import { Events } from '../../notifications/events.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AssignmentsService, assignmentListWhere, type AssignmentListFilter } from '../assignments.service.js';
import { AssignmentBulkSelectionDto } from './assignment-bulk.dto.js';
import {
  ASSIGNMENT_ACTIONS, ASSIGNMENT_FROM, ASSIGNMENT_MEMBERSHIP_TABLES, ASSIGNMENT_SKIP_CODES, ASSIGNMENT_TARGET, assignmentWarnings,
  type AssignmentBulkAction,
} from './assignment-bulk.rules.js';

const SAMPLE_SELECT = {
  id: true, title: true, status: true, deadline: true,
  course: { select: { id: true, code: true, title: true } },
  division: { select: { id: true, name: true } },
} as const;

@Injectable()
export class AssignmentBulkHandler implements BulkEntityHandler, OnModuleInit {
  readonly entityType = 'ASSIGNMENT';
  readonly noun = 'assignments';
  readonly actions = ASSIGNMENT_ACTIONS;
  readonly maxIds = DECISION_MAX_IDS;
  readonly maxSelection = DECISION_MAX_SELECTION;
  readonly selectionDto = AssignmentBulkSelectionDto;
  readonly paramsDto = NoBulkParamsDto;
  readonly membership = { kind: 'tableShare', tables: ASSIGNMENT_MEMBERSHIP_TABLES } as const;
  readonly itemKey = 'assignment';
  readonly skipCodes = ASSIGNMENT_SKIP_CODES;

  constructor(
    private readonly registry: BulkRegistry,
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentsService,
    private readonly events: EventEmitter2,
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

  private whereOf(s: EngineSelection): Prisma.AssignmentWhereInput {
    return s.mode === 'ids' ? { id: { in: s.ids } } : assignmentListWhere(s.filter as AssignmentListFilter);
  }

  count(db: Db, s: EngineSelection) {
    return db.assignment.count({ where: this.whereOf(s) });
  }

  async scanIds(db: Db, s: EngineSelection) {
    return (await db.assignment.findMany({ where: this.whereOf(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  }

  async preview(ids: string[], action: string) {
    const [sample, states] = await Promise.all([
      this.prisma.assignment.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ deadline: 'asc' }, { id: 'asc' }] }),
      inChunks(ids, (chunk) => this.prisma.assignment.findMany({ where: { id: { in: chunk } }, select: { status: true, deadline: true } })),
    ]);
    return { sample, warnings: assignmentWarnings(action as AssignmentBulkAction, states), requiresStepUp: false };
  }

  describe(db: Db, ids: string[]) {
    return db.assignment.findMany({ where: { id: { in: ids } }, select: SAMPLE_SELECT })
      .then((rows) => new Map<string, unknown>(rows.map((a) => [a.id, a])));
  }

  async processItem(ctx: ItemContext, actionName: string): Promise<ItemResult> {
    const { tx, op, actor, entityId, afterCommit } = ctx;
    const action = actionName as AssignmentBulkAction;
    // The assignment row first, FOR UPDATE (the single routes' only lock): its status is then exactly what the change sees.
    const [row] = await tx.$queryRaw<Array<{ status: AssignmentStatus }>>`
      SELECT "status" FROM "Assignment" WHERE "id" = ${entityId} FOR UPDATE`;
    if (!row) return { outcome: 'SKIPPED', code: 'NOT_FOUND', message: 'The assignment no longer exists.' };
    const skip = decisionSkip(row.status, ASSIGNMENT_TARGET[action], ASSIGNMENT_FROM[action]);
    if (skip) return skip;
    const by = { operationId: op.id };
    if (action === 'publish') {
      await this.assignments.publishInTx(tx, entityId, actor, by);
      afterCommit.push(async () => { this.events.emit(Events.AssignmentPublished, { assignmentId: entityId }); });
    } else if (action === 'close') {
      await this.assignments.closeInTx(tx, entityId, { ...(op.reason && { note: op.reason }) }, actor, by);
    } else {
      await this.assignments.archiveInTx(tx, entityId, actor, { ...by, ...(op.reason && { note: op.reason }) });
    }
    return { outcome: 'SUCCEEDED' };
  }
}
