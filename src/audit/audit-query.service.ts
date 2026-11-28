/**
 * Reading the audit trail (administrators only): filtered, paginated lists,
 * single entries, the actions in use, and CSV export. Read-only — nothing here
 * writes or changes audit records.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import { HIDDEN_ROLE, seesSuperAdmins } from '../common/access/super-admin-privacy.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';
import { DATE_PATTERN, DEFAULT_TIME_ZONE, fromZoned } from '../common/time/zoned-time.js';
import type { Prisma, Role } from '../generated/prisma/client.js';
import { AUDIT_CATEGORIES, categoryOf, KNOWN_ACTIONS, type AuditCategory } from './audit-categories.js';
import { keysetBatches, mapBatches, type CsvExport } from '../reports/csv.js';

export interface AuditQuery extends PaginationQueryDto {
  category?:  AuditCategory;
  action?:    string;
  actorId?:   string;
  actorRole?: Role;
  entity?:    string;
  entityId?:  string;
  from?:      string;
  to?:        string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SELECT = {
  id: true, createdAt: true, action: true, entity: true, entityId: true, metadata: true,
  actorId: true, actorRole: true, actorUsername: true,
  actor: { select: { id: true, username: true, firstName: true, lastName: true, role: true } },
} as const satisfies Prisma.AuditLogSelect;

type Row = Prisma.AuditLogGetPayload<{ select: typeof SELECT }>;

/** The actions whose metadata always names the account acted on as `targetUserId` (written by their services). */
export const TARGET_USER_ACTIONS = [
  'VIEW_AS_STARTED', 'VIEW_AS_ENDED', 'PERMISSION_OVERRIDE_CREATE', 'PERMISSION_OVERRIDE_REVOKE', 'PERMISSION_OVERRIDE_EXPIRED',
] as const;

/** A where clause that matches no entry (a filter a viewer may not use answers "nothing", never an error). */
const NOTHING: Prisma.AuditLogWhereInput = { id: { in: [] } };

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(q: AuditQuery, viewer: CallerCtx) {
    const where = await this.where(q, viewer);
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take, select: SELECT }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(rows.map(present), total, page, limit);
  }

  async findOne(id: string, viewer: CallerCtx) {
    const row = await this.prisma.auditLog.findFirst({ where: { AND: [{ id }, await this.visibleWhere(viewer)] }, select: SELECT });
    if (!row) throw new NotFoundException('Audit entry not found.');
    return present(row);
  }

  /** Every action recorded (or known), with its category and how often it occurs. */
  async actions(viewer: CallerCtx) {
    const counts = await this.prisma.auditLog.groupBy({ by: ['action'], where: await this.visibleWhere(viewer), _count: { _all: true } });
    const byAction = new Map(counts.map((c) => [c.action, c._count._all]));
    const all = [...new Set([...KNOWN_ACTIONS, ...byAction.keys()])].sort();
    return all.map((action) => ({ action, category: categoryOf(action), count: byAction.get(action) ?? 0 }));
  }

  /** Every matching entry, newest first, streamed in batches (no row limit; was 50,000). */
  async csv(q: AuditQuery, viewer: CallerCtx): Promise<CsvExport> {
    const where = await this.where(q, viewer);   // validates the date range before anything is sent
    const pages = keysetBatches((page) => this.prisma.auditLog.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: SELECT, ...page,
    }));
    return {
      headers: ['Time', 'Category', 'Action', 'Actor', 'Actor role', 'Record type', 'Record id', 'Details'],
      batches: mapBatches(pages, (rows) => rows.map(present).map((r) => [
        r.createdAt, r.category, r.action, r.actorUsername, r.actorRole, r.entity, r.entityId,
        r.metadata === null ? null : JSON.stringify(r.metadata),
      ])),
    };
  }

  /**
   * Super Administrator privacy (owner 2026-11-28): for anyone but a Super Administrator, an entry whose actor is (or was,
   * when it was written) a Super Administrator, or whose subject is a Super Administrator's account (entity User, or
   * metadata.targetUserId), does not exist. Written in positive OR form so that NULL columns never drop other entries.
   */
  private async visibleWhere(viewer: CallerCtx): Promise<Prisma.AuditLogWhereInput> {
    if (seesSuperAdmins(viewer)) return {};
    const ids = (await this.prisma.user.findMany({ where: { role: HIDDEN_ROLE }, select: { id: true } })).map((u) => u.id);
    return {
      AND: [
        { OR: [{ actorRole: null }, { actorRole: { not: HIDDEN_ROLE } }] },
        { OR: [{ actorId: null }, { actor: { is: { role: { not: HIDDEN_ROLE } } } }] },
        ...(ids.length === 0 ? [] : [
          { OR: [{ entity: { not: 'User' } }, { entityId: null }, { entityId: { notIn: ids } }] },
          // These actions always carry metadata.targetUserId, so the JSON comparison is never NULL for them.
          { OR: [{ action: { notIn: [...TARGET_USER_ACTIONS] } }, { NOT: { OR: ids.map((id) => ({ metadata: { path: ['targetUserId'], equals: id } })) } }] },
        ]),
      ],
    };
  }

  private async where(q: AuditQuery, viewer: CallerCtx): Promise<Prisma.AuditLogWhereInput> {
    const from = q.from ? this.boundary(q.from, 'start') : undefined;
    const to   = q.to   ? this.boundary(q.to, 'end')     : undefined;
    if (from && to && to <= from) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_DATE_RANGE', 'The start date must be before the end date.');
    }
    // A Super-Administrator-only filter (their role, their category) matches nothing for anyone else.
    if (!seesSuperAdmins(viewer) && (q.actorRole === HIDDEN_ROLE || q.category === 'SUPER_ADMIN')) return NOTHING;

    const categoryActions = q.category && q.category !== 'OTHER' ? [...AUDIT_CATEGORIES[q.category]] : undefined;
    const filters: Prisma.AuditLogWhereInput = {
      ...(q.actorId   && { actorId: q.actorId }),
      ...(q.actorRole && { actorRole: q.actorRole }),
      ...(q.entity    && { entity: q.entity }),
      ...(q.entityId  && { entityId: q.entityId }),
      ...(q.action    && { action: { contains: q.action, mode: 'insensitive' as const } }),
      ...(categoryActions && { AND: [{ action: { in: categoryActions } }] }),
      ...(q.category === 'OTHER' && { AND: [{ action: { notIn: KNOWN_ACTIONS } }] }),
      ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lt: to }) } }),
    };
    return seesSuperAdmins(viewer) ? filters : { AND: [await this.visibleWhere(viewer), filters] };
  }

  /** A plain date covers that whole day in the programme time zone. */
  private boundary(value: string, side: 'start' | 'end'): Date {
    if (!DATE_PATTERN.test(value)) return new Date(value);
    const tz = this.config.get<string>('APP_TIMEZONE') || DEFAULT_TIME_ZONE;
    let start: Date;
    try {
      start = fromZoned(value, '00:00', tz);
    } catch {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', `${value} is not a valid date.`);
    }
    return side === 'start' ? start : new Date(start.getTime() + DAY_MS);
  }
}

/** Who acted: the live account when it still exists, the recorded username otherwise. */
function present(r: Row) {
  return {
    id:            r.id,
    createdAt:     r.createdAt,
    category:      categoryOf(r.action),
    action:        r.action,
    entity:        r.entity,
    entityId:      r.entityId,
    actor:         r.actor,
    actorUsername: r.actorUsername ?? r.actor?.username ?? null,
    actorRole:     r.actorRole,
    metadata:      r.metadata,
  };
}
