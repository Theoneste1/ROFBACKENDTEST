/**
 * Reading the audit trail (administrators only): filtered, paginated lists,
 * single entries, the actions in use, and CSV export. Read-only — nothing here
 * writes or changes audit records.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { AppError } from '../common/errors/app-error.js';
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

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(q: AuditQuery) {
    const where = this.where(q);
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take, select: SELECT }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(rows.map(present), total, page, limit);
  }

  async findOne(id: string) {
    const row = await this.prisma.auditLog.findUnique({ where: { id }, select: SELECT });
    if (!row) throw new NotFoundException('Audit entry not found.');
    return present(row);
  }

  /** Every action recorded (or known), with its category and how often it occurs. */
  async actions() {
    const counts = await this.prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true } });
    const byAction = new Map(counts.map((c) => [c.action, c._count._all]));
    const all = [...new Set([...KNOWN_ACTIONS, ...byAction.keys()])].sort();
    return all.map((action) => ({ action, category: categoryOf(action), count: byAction.get(action) ?? 0 }));
  }

  /** Every matching entry, newest first, streamed in batches (no row limit; was 50,000). */
  async csv(q: AuditQuery): Promise<CsvExport> {
    const where = this.where(q);   // validates the date range before anything is sent
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

  private where(q: AuditQuery): Prisma.AuditLogWhereInput {
    const from = q.from ? this.boundary(q.from, 'start') : undefined;
    const to   = q.to   ? this.boundary(q.to, 'end')     : undefined;
    if (from && to && to <= from) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_DATE_RANGE', '`from` must be before `to`.');
    }

    const categoryActions = q.category && q.category !== 'OTHER' ? [...AUDIT_CATEGORIES[q.category]] : undefined;
    return {
      ...(q.actorId   && { actorId: q.actorId }),
      ...(q.actorRole && { actorRole: q.actorRole }),
      ...(q.entity    && { entity: q.entity }),
      ...(q.entityId  && { entityId: q.entityId }),
      ...(q.action    && { action: { contains: q.action, mode: 'insensitive' as const } }),
      ...(categoryActions && { AND: [{ action: { in: categoryActions } }] }),
      ...(q.category === 'OTHER' && { AND: [{ action: { notIn: KNOWN_ACTIONS } }] }),
      ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lt: to }) } }),
    };
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
