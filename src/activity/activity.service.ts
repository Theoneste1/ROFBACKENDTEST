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
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AccessService } from '../common/access/access.service.js';
import { isAdmin, isHeadCoach, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';

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

  constructor(
    private readonly prisma:  PrismaService,
    private readonly access:  AccessService,
  ) {}

  /**
   * Which activity a caller may read (activity.view). Administrators: all.
   * Head Coach (P1-10, plan §7.2): only Students and Coaches who are active
   * members of the programmes they head, and — for activity tied to a course —
   * only that programme's courses (a shared coach's other programmes stay hidden).
   */
  private async callerWhere(user: AuthUser, courseId?: string): Promise<Prisma.ActivityLogWhereInput> {
    if (isAdmin(user)) return {};
    if (isHeadCoach(user)) {
      const programmes = await this.access.headedProgrammes(user);
      const courses = (await this.prisma.course.findMany({ where: this.access.programmeCoursesFilter(programmes), select: { id: true } })).map((c) => c.id);
      if (courseId && !courses.includes(courseId)) throw new NotFoundException('Course not found.');
      return {
        user: { role: { in: ['STUDENT', 'MENTOR'] }, ...this.access.programmeMembersFilter(programmes) },
        OR:   [{ courseId: null }, { courseId: { in: courses } }],
      };
    }
    throw unsupportedRole();
  }

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

  async list(q: ListActivityDto, user: AuthUser) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.ActivityLogWhereInput = {
      AND: [await this.callerWhere(user, q.courseId)],
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
  async summary(from: Date, to: Date, user: AuthUser) {
    const scoped = await this.callerWhere(user);
    const rows = await this.prisma.activityLog.groupBy({
      by:     ['type'],
      where:  { AND: [scoped], createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    const activeUsers = await this.prisma.activityLog.findMany({
      where:    { AND: [scoped], createdAt: { gte: from, lte: to } },
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
