/**
 * Live sessions — external meetings (Zoom, Meet, Teams …) scheduled by a
 * mentor for a course × division. The platform stores the schedule and link;
 * it does not host video.
 *
 *   SCHEDULED ──(host/admin cancels)──► CANCELLED
 *       └──────(endsAt passes; worker)──► COMPLETED
 */
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import {
  CancelLiveSessionDto,
  CreateLiveSessionDto,
  ListLiveSessionsDto,
  UpdateLiveSessionDto,
} from './dto/live-session.dto.js';

const MAX_DURATION_MS = 8 * 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 60 * 60 * 1000;

const SESSION_SELECT = {
  id: true, title: true, description: true, startsAt: true, endsAt: true,
  provider: true, meetingUrl: true, status: true, cancelReason: true,
  courseId: true, divisionId: true, createdAt: true, updatedAt: true,
  course:   { select: { id: true, code: true, title: true } },
  division: { select: { id: true, code: true, name: true } },
  host:     { select: { id: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class LiveSessionsService {
  private readonly logger = new Logger(LiveSessionsService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly audit:         AuditService,
    private readonly access:        AccessService,
    private readonly events:        EventEmitter2,
    private readonly notifications: NotificationsService,
    private readonly config:        ConfigService,
  ) {}

  async create(dto: CreateLiveSessionDto, user: AuthUser) {
    const scope = { courseId: dto.courseId, divisionId: dto.divisionId };
    const course = await this.prisma.course.findUnique({ where: { id: dto.courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found.');
    await this.access.assertCanManage(user, scope);

    const { startsAt, endsAt } = this.validateTimes(dto.startsAt, dto.endsAt);

    const session = await this.prisma.liveSession.create({
      data: {
        ...scope,
        hostId:      user.id,
        title:       dto.title,
        description: dto.description,
        startsAt,
        endsAt,
        provider:    dto.provider ?? guessProvider(dto.meetingUrl),
        meetingUrl:  dto.meetingUrl,
      },
      select: SESSION_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'SCHEDULE_LIVE_SESSION', entity: 'LiveSession', entityId: session.id, metadata: scope,
    });
    this.events.emit(Events.LiveSessionScheduled, { sessionId: session.id });
    return session;
  }

  async update(id: string, dto: UpdateLiveSessionDto, user: AuthUser) {
    const session = await this.requireManageable(id, user);
    if (session.status !== 'SCHEDULED') throw invalidState('Only scheduled sessions can be edited.');
    if (Object.keys(dto).length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'No fields to update.');
    }

    const times = dto.startsAt || dto.endsAt
      ? this.validateTimes(dto.startsAt ?? session.startsAt.toISOString(), dto.endsAt ?? session.endsAt.toISOString())
      : undefined;

    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: {
        title:       dto.title,
        description: dto.description,
        provider:    dto.provider,
        meetingUrl:  dto.meetingUrl,
        ...(times && { ...times, reminderSentAt: null }),
      },
      select: SESSION_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UPDATE_LIVE_SESSION', entity: 'LiveSession', entityId: id, metadata: { fields: Object.keys(dto) },
    });

    // Students only need to hear about changes that affect attending.
    if (times || dto.meetingUrl) this.events.emit(Events.LiveSessionUpdated, { sessionId: id });
    return updated;
  }

  async cancel(id: string, dto: CancelLiveSessionDto, user: AuthUser) {
    await this.requireManageable(id, user);

    const { count } = await this.prisma.liveSession.updateMany({
      where: { id, status: 'SCHEDULED' },
      data:  { status: 'CANCELLED', cancelReason: dto.reason ?? null },
    });
    if (count === 0) throw invalidState('Only scheduled sessions can be cancelled.');

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'CANCEL_LIVE_SESSION', entity: 'LiveSession', entityId: id,
    });
    this.events.emit(Events.LiveSessionCancelled, { sessionId: id });
    return this.prisma.liveSession.findUniqueOrThrow({ where: { id }, select: SESSION_SELECT });
  }

  /** Scoped list: students see their division; mentors their scopes; admins everything. */
  async findAll(user: AuthUser, q: ListLiveSessionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const scope = await this.access.scopeFilter(user);

    const where: Prisma.LiveSessionWhereInput = {
      AND: [
        scope ?? {},
        q.courseId ? { courseId: q.courseId } : {},
        q.divisionId && user.role !== 'STUDENT' ? { divisionId: q.divisionId } : {},
        q.status ? { status: q.status } : {},
        q.upcoming !== false ? { endsAt: { gte: new Date() } } : {},
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.liveSession.findMany({
        where, skip, take, select: SESSION_SELECT,
        orderBy: { startsAt: q.upcoming !== false ? 'asc' : 'desc' },
      }),
      this.prisma.liveSession.count({ where }),
    ]);
    return paginated(rows.map((s) => this.forViewer(s, user)), total, page, limit);
  }

  async findOne(id: string, user: AuthUser) {
    const session = await this.prisma.liveSession.findUnique({ where: { id }, select: SESSION_SELECT });
    if (!session) throw new NotFoundException('Live session not found.');
    await this.access.assertCanView(user, session);
    return this.forViewer(session, user);
  }

  // ─── Background: reminders and completion ─────────────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'live-session-maintenance' })
  async maintain() {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;
    try {
      await this.completeEnded();
      await this.sendReminders();
    } catch (err) {
      this.logger.error(`Live session maintenance failed: ${(err as Error).message}`);
    }
  }

  async completeEnded() {
    const { count } = await this.prisma.liveSession.updateMany({
      where: { status: 'SCHEDULED', endsAt: { lt: new Date() } },
      data:  { status: 'COMPLETED' },
    });
    return count;
  }

  /** Notify students once, about an hour before a session starts. */
  async sendReminders() {
    const now  = new Date();
    const soon = await this.prisma.liveSession.findMany({
      where: {
        status:         'SCHEDULED',
        reminderSentAt: null,
        startsAt:       { gt: now, lte: new Date(now.getTime() + REMINDER_WINDOW_MS) },
        course:         { status: 'PUBLISHED' },
      },
      select: { id: true, title: true, startsAt: true, divisionId: true, courseId: true, course: { select: { title: true } } },
    });

    for (const s of soon) {
      // Claim first so a parallel instance cannot send the same reminder.
      const { count } = await this.prisma.liveSession.updateMany({
        where: { id: s.id, reminderSentAt: null },
        data:  { reminderSentAt: now },
      });
      if (count === 0) continue;

      await this.notifications.notify(await this.notifications.studentIdsInDivision(s.divisionId), {
        category: 'LIVE_SESSIONS',
        type:     'live_session.reminder',
        title:    `Starting soon: ${s.title}`,
        body:     `Your ${s.course.title} live session "${s.title}" starts at ${s.startsAt.toUTCString()}.`,
        data:     { sessionId: s.id, courseId: s.courseId },
        link:     `/live-sessions/${s.id}`,
      });
    }
    return soon.length;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async requireManageable(id: string, user: AuthUser) {
    const session = await this.prisma.liveSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException('Live session not found.');
    await this.access.assertCanManage(user, session);
    return session;
  }

  private validateTimes(startsAtIso: string, endsAtIso: string) {
    const startsAt = new Date(startsAtIso);
    const endsAt   = new Date(endsAtIso);
    if (startsAt <= new Date()) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'START_IN_PAST', 'The session must start in the future.');
    }
    if (endsAt <= startsAt) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TIME_RANGE', 'endsAt must be after startsAt.');
    }
    if (endsAt.getTime() - startsAt.getTime() > MAX_DURATION_MS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TIME_RANGE', 'A session cannot last longer than 8 hours.');
    }
    return { startsAt, endsAt };
  }

  /** The meeting link is withheld from students once a session is cancelled. */
  private forViewer<T extends { status: string; meetingUrl: string }>(s: T, user: AuthUser) {
    if (user.role === 'STUDENT' && s.status === 'CANCELLED') return { ...s, meetingUrl: null };
    return s;
  }
}

function guessProvider(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith('zoom.us')) return 'ZOOM' as const;
  if (host === 'meet.google.com') return 'GOOGLE_MEET' as const;
  if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) return 'MICROSOFT_TEAMS' as const;
  return 'OTHER' as const;
}
