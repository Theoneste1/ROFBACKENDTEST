/**
 * The COACH_APPLICATION record type of the bulk engine — mentor requests (2026-11-20; docs/operations/bulk-operations.md).
 * Every action calls the same code as the single route, inside the item transaction:
 *   approve → MentorRequestsService.approveInTx   (PATCH /mentor-requests/:id/approve; approvePicture always false; the
 *             approval notice is enqueued in the transaction and dispatched after commit, the activation e-mail sent
 *             after commit)
 *   reject  → MentorRequestsService.rejectInTx    (PATCH /mentor-requests/:id/reject; the applicant's e-mail after commit)
 * The selection is GET /mentor-requests's filter (mentorRequestListWhere); membership is guarded by a SHARE lock on
 * MentorRequest.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';

import { ActivationService } from '../../auth/activation.service.js';
import { DECISION_MAX_IDS, DECISION_MAX_SELECTION, decisionSkip, inChunks, normaliseFilterSelection, NoBulkParamsDto } from '../../bulk/bulk-decisions.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext, ItemResult } from '../../bulk/bulk-handler.js';
import { BulkRegistry } from '../../bulk/bulk-registry.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { mentorRequestListWhere, MentorRequestsService } from '../mentor-requests.service.js';
import { CoachApplicationBulkSelectionDto } from './coach-application-bulk.dto.js';
import {
  COACH_APPLICATION_ACTIONS, COACH_APPLICATION_MEMBERSHIP_TABLES, COACH_APPLICATION_SKIP_CODES, COACH_APPLICATION_TARGET,
  coachApplicationWarnings, type CoachApplicationBulkAction,
} from './coach-application-bulk.rules.js';

const SAMPLE_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true, status: true, createdAt: true, country: true, olympiadInterests: true,
} as const;

@Injectable()
export class CoachApplicationBulkHandler implements BulkEntityHandler, OnModuleInit {
  readonly entityType = 'COACH_APPLICATION';
  readonly noun = 'coach applications';
  readonly actions = COACH_APPLICATION_ACTIONS;
  readonly maxIds = DECISION_MAX_IDS;
  readonly maxSelection = DECISION_MAX_SELECTION;
  readonly selectionDto = CoachApplicationBulkSelectionDto;
  readonly paramsDto = NoBulkParamsDto;
  readonly membership = { kind: 'tableShare', tables: COACH_APPLICATION_MEMBERSHIP_TABLES } as const;
  readonly itemKey = 'application';
  readonly skipCodes = COACH_APPLICATION_SKIP_CODES;

  constructor(
    private readonly registry: BulkRegistry,
    private readonly prisma: PrismaService,
    private readonly requests: MentorRequestsService,
    private readonly settings: SettingsService,
    private readonly activation: ActivationService,
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

  private whereOf(s: EngineSelection): Prisma.MentorRequestWhereInput {
    return s.mode === 'ids' ? { id: { in: s.ids } } : mentorRequestListWhere(s.filter as { status?: never });
  }

  count(db: Db, s: EngineSelection) {
    return db.mentorRequest.count({ where: this.whereOf(s) });
  }

  async scanIds(db: Db, s: EngineSelection) {
    return (await db.mentorRequest.findMany({ where: this.whereOf(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  }

  async preview(ids: string[], action: string) {
    const [sample, rows] = await Promise.all([
      this.prisma.mentorRequest.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      inChunks(ids, (chunk) => this.prisma.mentorRequest.findMany({ where: { id: { in: chunk } }, select: { status: true, avatarFileId: true } })),
    ]);
    const states = rows.map((r) => ({ status: r.status, hasPicture: r.avatarFileId !== null }));
    return { sample, warnings: coachApplicationWarnings(action as CoachApplicationBulkAction, states), requiresStepUp: false };
  }

  describe(db: Db, ids: string[]) {
    return db.mentorRequest.findMany({ where: { id: { in: ids } }, select: SAMPLE_SELECT })
      .then((rows) => new Map<string, unknown>(rows.map((r) => [r.id, r])));
  }

  async processItem(ctx: ItemContext, actionName: string): Promise<ItemResult> {
    const { tx, op, actor, entityId, afterCommit, noticeIds } = ctx;
    const action = actionName as CoachApplicationBulkAction;
    // The application row first, FOR UPDATE (approve's first lock): its state is then exactly what the decision sees.
    const [row] = await tx.$queryRaw<Array<{ status: string; email: string; firstName: string }>>`
      SELECT "status"::text AS "status", "email", "firstName" FROM "MentorRequest" WHERE "id" = ${entityId} FOR UPDATE`;
    if (!row) return { outcome: 'SKIPPED', code: 'NOT_FOUND', message: 'The application no longer exists.' };
    const skip = decisionSkip(row.status, COACH_APPLICATION_TARGET[action], ['PENDING'], 'ALREADY_DECIDED');
    if (skip) return skip;
    const by = { operationId: op.id };
    if (action === 'approve') {
      const verify = await this.settings.get('registration.requireEmailVerification');
      // Never the picture in bulk: an Administrator approves a picture only after seeing it, one application at a time.
      const { issued, notice } = await this.requests.approveInTx(tx, entityId, actor, { approvePicture: false }, verify, by);
      noticeIds.push(notice);
      if (issued) afterCommit.push(async () => { await this.activation.send(issued); });
      return { outcome: 'SUCCEEDED' };
    }
    const reason = op.reason ?? undefined;
    await this.requests.rejectInTx(tx, entityId, actor, reason, by);
    afterCommit.push(async () => this.requests.rejectionNotice(row, reason));
    return { outcome: 'SUCCEEDED' };
  }
}
