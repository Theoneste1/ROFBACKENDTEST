/**
 * The TEACHER_APPLICATION record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md):
 *   reject → TeacherApplicationsService.rejectInTx   (POST /admin/teacher-applications/:id/reject), inside the item
 *            transaction; the rejection e-mail is queued after it committed, as on the single route.
 * No bulk approve (an approval needs a per-application school decision). The selection is
 * GET /admin/teacher-applications's filter (teacherApplicationListWhere); membership is guarded by a SHARE lock on
 * TeacherApplication. Like the single routes, the caller must be allowed to give the TEACHER role with the role enabled
 * (RoleAssignmentPolicy): checked at preview / execute and again for every record.
 */
import { Injectable, OnModuleInit } from '@nestjs/common';

import { RoleAssignmentPolicy } from '../../auth/role-assignment.policy.js';
import { DECISION_MAX_IDS, DECISION_MAX_SELECTION, decisionSkip, inChunks, normaliseFilterSelection, NoBulkParamsDto } from '../../bulk/bulk-decisions.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext, ItemResult } from '../../bulk/bulk-handler.js';
import { BulkRegistry } from '../../bulk/bulk-registry.js';
import type { AuthUser } from '../../common/auth-user.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { teacherApplicationListWhere, TeacherApplicationsService } from '../teacher-applications.service.js';
import { TeacherApplicationBulkSelectionDto } from './teacher-application-bulk.dto.js';
import {
  TEACHER_APPLICATION_ACTIONS, TEACHER_APPLICATION_MEMBERSHIP_TABLES, TEACHER_APPLICATION_SKIP_CODES, teacherApplicationWarnings,
} from './teacher-application-bulk.rules.js';

const SAMPLE_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true, status: true, createdAt: true, proposedSchoolName: true,
  school: { select: { id: true, name: true, code: true } },
} as const;

@Injectable()
export class TeacherApplicationBulkHandler implements BulkEntityHandler, OnModuleInit {
  readonly entityType = 'TEACHER_APPLICATION';
  readonly noun = 'teacher applications';
  readonly actions = TEACHER_APPLICATION_ACTIONS;
  readonly maxIds = DECISION_MAX_IDS;
  readonly maxSelection = DECISION_MAX_SELECTION;
  readonly selectionDto = TeacherApplicationBulkSelectionDto;
  readonly paramsDto = NoBulkParamsDto;
  readonly membership = { kind: 'tableShare', tables: TEACHER_APPLICATION_MEMBERSHIP_TABLES } as const;
  readonly itemKey = 'application';
  readonly skipCodes = TEACHER_APPLICATION_SKIP_CODES;

  constructor(
    private readonly registry: BulkRegistry,
    private readonly prisma: PrismaService,
    private readonly applications: TeacherApplicationsService,
    private readonly roles: RoleAssignmentPolicy,
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

  /** The single routes' check: the caller may give the TEACHER role, and the role is enabled (403 otherwise). */
  async validate(_action: string, _params: Record<string, unknown>, caller: AuthUser) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
  }

  private whereOf(s: EngineSelection): Prisma.TeacherApplicationWhereInput {
    return s.mode === 'ids' ? { id: { in: s.ids } } : teacherApplicationListWhere(s.filter as { status?: never });
  }

  count(db: Db, s: EngineSelection) {
    return db.teacherApplication.count({ where: this.whereOf(s) });
  }

  async scanIds(db: Db, s: EngineSelection) {
    return (await db.teacherApplication.findMany({ where: this.whereOf(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id);
  }

  async preview(ids: string[]) {
    const [sample, rows] = await Promise.all([
      this.prisma.teacherApplication.findMany({ where: { id: { in: ids.slice(0, 10) } }, select: SAMPLE_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      inChunks(ids, (chunk) => this.prisma.teacherApplication.findMany({ where: { id: { in: chunk } }, select: { status: true } })),
    ]);
    return { sample, warnings: teacherApplicationWarnings(rows.map((r) => r.status)), requiresStepUp: false };
  }

  describe(db: Db, ids: string[]) {
    return db.teacherApplication.findMany({ where: { id: { in: ids } }, select: SAMPLE_SELECT })
      .then((rows) => new Map<string, unknown>(rows.map((a) => [a.id, a])));
  }

  async processItem(ctx: ItemContext): Promise<ItemResult> {
    const { tx, op, actor, entityId, afterCommit } = ctx;
    // The single route's check, for this administrator as of now (403 ROLE_NOT_ASSIGNABLE / TEACHERS_DISABLED → FAILED).
    await this.roles.assertCanAssign(actor, 'TEACHER');
    const [row] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status"::text AS "status" FROM "TeacherApplication" WHERE "id" = ${entityId} FOR UPDATE`;
    if (!row) return { outcome: 'SKIPPED', code: 'NOT_FOUND', message: 'The application no longer exists.' };
    const skip = decisionSkip(row.status, 'REJECTED', ['PENDING'], 'ALREADY_DECIDED');
    if (skip) return skip;
    const reason = op.reason ?? '';
    const rejected = await this.applications.rejectInTx(tx, entityId, { reason }, actor, { operationId: op.id });
    afterCommit.push(() => this.applications.rejectionEmail(rejected, reason));
    return { outcome: 'SUCCEEDED' };
  }
}
