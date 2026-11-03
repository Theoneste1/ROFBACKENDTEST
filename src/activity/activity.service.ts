/**
 * Learning-activity log (logins, course opens, resource views, submissions,
 * discussion posts …) for analytics and engagement reporting.
 *
 * This is NOT the audit log: AuditLog records security- and governance-
 * relevant changes (who changed what); ActivityLog records what learners do.
 *
 * Writes are fire-and-forget: a failure is logged and never affects the
 * request that triggered it.
 */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { ActivityType, Prisma } from '../generated/prisma/client.js';
import { ListActivityDto } from './dto/list-activity.dto.js';

export interface ActivityContext {
  courseId?:   string;
  entityType?: string;
  entityId?:   string;
  metadata?:   Record<string, unknown>;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Record an activity without blocking or failing the caller. */
  record(userId: string, type: ActivityType, ctx: ActivityContext = {}): void {
    this.prisma.activityLog
      .create({
        data: {
          userId,
          type,
          courseId:   ctx.courseId,
          entityType: ctx.entityType,
          entityId:   ctx.entityId,
          metadata:   (ctx.metadata as Prisma.InputJsonValue) ?? undefined,
        },
      })
      .catch((err: Error) => this.logger.warn(`Could not record ${type}: ${err.message}`));
  }

  async list(q: ListActivityDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.ActivityLogWhereInput = {
      ...(q.userId   && { userId: q.userId }),
      ...(q.courseId && { courseId: q.courseId }),
      ...(q.type     && { type: q.type }),
      ...((q.from || q.to) && {
        createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) },
      }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityLog.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, username: true, firstName: true, lastName: true, role: true } } },
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Activity counts per type for a period (dashboard). */
  async summary(from: Date, to: Date) {
    const rows = await this.prisma.activityLog.groupBy({
      by:     ['type'],
      where:  { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    const activeUsers = await this.prisma.activityLog.findMany({
      where:    { createdAt: { gte: from, lte: to } },
      distinct: ['userId'],
      select:   { userId: true },
    });
    return {
      from, to,
      activeUsers: activeUsers.length,
      byType: Object.fromEntries(rows.map((r) => [r.type, r._count._all])),
    };
  }
}
