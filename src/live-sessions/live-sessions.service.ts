/**
 * Live sessions — external meetings (Zoom, Meet, Teams …) scheduled by a
 * mentor for a course × division. The platform stores the schedule and link;
 * it does not host video.
 *
 *   SCHEDULED ──(host/admin cancels)──► CANCELLED
 *       └──────(endsAt passes; worker)──► COMPLETED
 *
 * Times are stored as UTC instants. They can be given and are always returned
 * as a date + start/end time in the programme time zone (APP_TIMEZONE).
 *
 * Validation: start in the future, end after start, at most the configured
 * length (liveSessions.maxDurationHours, default 8 hours), starting
 * within the academic year; no overlap with another scheduled session of the
 * same host or the same division (students could not attend both); a provider,
 * when given, must match the link.
 */
import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AcademicYearsService } from '../academic-years/academic-years.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import {
  DATE_PATTERN,
  DEFAULT_TIME_ZONE,
  describeZonedRange,
  fromZoned,
  toZoned,
} from '../common/time/zoned-time.js';
import type { AuthUser } from '../common/auth-user.js';
import type { LiveSessionProvider, Prisma } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import {
  CancelLiveSessionDto,
  CreateLiveSessionDto,
  ListLiveSessionsDto,
  UpdateLiveSessionDto,
} from './dto/live-session.dto.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PROVIDER_LABEL: Record<LiveSessionProvider, string> = {
  ZOOM: 'Zoom', GOOGLE_MEET: 'Google Meet', MICROSOFT_TEAMS: 'Microsoft Teams', OTHER: 'other',
};

const SESSION_SELECT = {
  id: true, title: true, description: true, startsAt: true, endsAt: true,
  provider: true, meetingUrl: true, status: true, cancelReason: true,
  courseId: true, divisionId: true, createdAt: true, updatedAt: true,
  course:   { select: { id: true, code: true, title: true } },
  division: { select: { id: true, code: true, name: true } },
  host:     { select: { id: true, firstName: true, lastName: true } },
} as const;

type SessionRow = Prisma.LiveSessionGetPayload<{ select: typeof SESSION_SELECT }>;
type Times = { startsAt: Date; endsAt: Date };
type TimeInput = { date?: string; startTime?: string; endTime?: string; startsAt?: string; endsAt?: string };

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
    private readonly academicYears: AcademicYearsService,
    private readonly settings:      SettingsService,
  ) {}

  private get timeZone(): string {
    return this.config.get<string>('APP_TIMEZONE') || DEFAULT_TIME_ZONE;
  }

  async create(dto: CreateLiveSessionDto, user: AuthUser) {
    const scope = { courseId: dto.courseId, divisionId: dto.divisionId };
    const course = await this.prisma.course.findUnique({ where: { id: dto.courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found.');
    await this.access.assertCanManage(user, scope);

    const times = this.resolveTimes(dto)!;
    await this.validateTimes(times);
    const year = await this.academicYears.current();
    this.assertWithinYear(times, year);
    const provider = this.resolveProvider(dto.provider, dto.meetingUrl);
    await this.assertNoConflict({ ...times, hostId: user.id, divisionId: dto.divisionId });

    const session = await this.prisma.liveSession.create({
      data: {
        ...scope,
        ...times,
        academicYearId: year.id,
        hostId:      user.id,
        title:       dto.title,
        description: dto.description,
        provider,
        meetingUrl:  dto.meetingUrl,
      },
      select: SESSION_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'SCHEDULE_LIVE_SESSION', entity: 'LiveSession', entityId: session.id, metadata: scope,
    });
    this.events.emit(Events.LiveSessionScheduled, { sessionId: session.id });
    return this.present(session, user);
  }

  async update(id: string, dto: UpdateLiveSessionDto, user: AuthUser) {
    const session = await this.requireManageable(id, user);
    if (session.status !== 'SCHEDULED') throw invalidState('Only scheduled sessions can be edited.');
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'No fields to update.');
    }
    const now = new Date();
    if (session.endsAt <= now) throw invalidState('This session has already ended.');

    const times = this.resolveTimes(dto, session);
    if (times) {
      // The link and description can still be fixed during a session, but not its time.
      if (session.startsAt <= now) throw invalidState('The time of a session that has started cannot be changed.');
      await this.validateTimes(times);
      const year = await this.prisma.academicYear.findUniqueOrThrow({ where: { id: session.academicYearId } });
      this.assertWithinYear(times, year);
      await this.assertNoConflict({ ...times, hostId: session.hostId, divisionId: session.divisionId }, id);
    }

    const meetingUrl = dto.meetingUrl ?? session.meetingUrl;
    const provider = dto.provider || dto.meetingUrl ? this.resolveProvider(dto.provider, meetingUrl) : undefined;
    const timesChanged = !!times && (+times.startsAt !== +session.startsAt || +times.endsAt !== +session.endsAt);
    const linkChanged  = meetingUrl !== session.meetingUrl;

    const updated = await this.prisma.liveSession.update({
      where: { id },
      data: {
        title:       dto.title,
        description: dto.description,
        provider,
        meetingUrl:  dto.meetingUrl,
        ...(timesChanged && { ...times, reminderSentAt: null }),
      },
      select: SESSION_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UPDATE_LIVE_SESSION', entity: 'LiveSession', entityId: id,
      metadata: { fields: Object.keys(dto).filter((k) => dto[k as keyof UpdateLiveSessionDto] !== undefined) },
    });

    // Students only need to hear about changes that affect attending.
    if (timesChanged || linkChanged) this.events.emit(Events.LiveSessionUpdated, { sessionId: id });
    return this.present(updated, user);
  }

  async cancel(id: string, dto: CancelLiveSessionDto, user: AuthUser) {
    const session = await this.requireManageable(id, user);
    if (session.status === 'SCHEDULED' && session.endsAt <= new Date()) {
      throw invalidState('This session has already ended.');
    }

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
    const row = await this.prisma.liveSession.findUniqueOrThrow({ where: { id }, select: SESSION_SELECT });
    return this.present(row, user);
  }

  /**
   * Scoped list: students see their division's sessions in published courses;
   * mentors their course × division scopes; admins everything.
   */
  async findAll(user: AuthUser, q: ListLiveSessionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const scope = await this.access.scopeFilter(user);
    const from = q.from ? this.boundary(q.from, 'start') : undefined;
    const to   = q.to   ? this.boundary(q.to, 'end')     : undefined;
    if (from && to && to <= from) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TIME_RANGE', '`to` must not be before `from`.');
    }
    const ranged   = !!(from || to);
    const upcoming = !ranged && q.upcoming !== false;

    const where: Prisma.LiveSessionWhereInput = {
      AND: [
        scope ?? {},
        q.courseId ? { courseId: q.courseId } : {},
        q.divisionId && user.role !== 'STUDENT' ? { divisionId: q.divisionId } : {},
        q.status ? { status: q.status } : {},
        upcoming ? { endsAt: { gte: new Date() } } : {},
        from ? { endsAt: { gt: from } } : {},
        to ? { startsAt: { lt: to } } : {},
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.liveSession.findMany({
        where, skip, take, select: SESSION_SELECT,
        orderBy: { startsAt: upcoming || ranged ? 'asc' : 'desc' },
      }),
      this.prisma.liveSession.count({ where }),
    ]);
    return paginated(rows.map((s) => this.present(s, user)), total, page, limit);
  }

  async findOne(id: string, user: AuthUser) {
    const session = await this.prisma.liveSession.findUnique({
      where:  { id },
      select: { ...SESSION_SELECT, course: { select: { ...SESSION_SELECT.course.select, status: true } } },
    });
    if (!session) throw new NotFoundException('Live session not found.');
    await this.access.assertCanView(user, session);
    // Like the list: students do not see sessions of unpublished courses.
    if (user.role === 'STUDENT' && session.course.status !== 'PUBLISHED') throw new NotFoundException('Live session not found.');
    const { status: _courseStatus, ...course } = session.course;
    return this.present({ ...session, course }, user);
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

  /**
   * Notify students once, shortly before a session starts
   * (notifications.liveSessionReminderMinutes; can be switched off).
   */
  async sendReminders() {
    if (!(await this.settings.get('notifications.liveSessionRemindersEnabled'))) return 0;
    const windowMs = (await this.settings.get('notifications.liveSessionReminderMinutes')) * 60_000;
    const now  = new Date();
    const soon = await this.prisma.liveSession.findMany({
      where: {
        status:         'SCHEDULED',
        reminderSentAt: null,
        startsAt:       { gt: now, lte: new Date(now.getTime() + windowMs) },
        course:         { status: 'PUBLISHED' },
      },
      select: { id: true, title: true, startsAt: true, endsAt: true, divisionId: true, courseId: true, course: { select: { title: true } } },
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
        body:     `Your ${s.course.title} live session "${s.title}" is on ${describeZonedRange(s.startsAt, s.endsAt, this.timeZone)}.`,
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

  /**
   * Turn either input form into instants. On update, fields not given keep the
   * session's current values; returns undefined when no time field was given.
   */
  private resolveTimes(dto: TimeInput, current?: Times): Times | undefined {
    const wall = dto.date !== undefined || dto.startTime !== undefined || dto.endTime !== undefined;
    const iso  = dto.startsAt !== undefined || dto.endsAt !== undefined;
    if (wall && iso) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'AMBIGUOUS_TIMES',
        'Give either date, startTime and endTime, or startsAt and endsAt — not both.');
    }
    const required = () => new AppError(HttpStatus.BAD_REQUEST, 'TIMES_REQUIRED',
      'Give the session date, startTime and endTime (or startsAt and endsAt).');
    if (!wall && !iso) {
      if (current) return undefined;
      throw required();
    }

    if (wall) {
      const tz    = this.timeZone;
      const start = current && toZoned(current.startsAt, tz);
      const end   = current && toZoned(current.endsAt, tz);
      const date      = dto.date      ?? start?.date;
      const startTime = dto.startTime ?? start?.time;
      const endTime   = dto.endTime   ?? end?.time;
      if (!date || !startTime || !endTime) throw required();
      try {
        return { startsAt: fromZoned(date, startTime, tz), endsAt: fromZoned(date, endTime, tz) };
      } catch {
        throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_DATE', `${date} is not a valid date.`);
      }
    }

    const startsAt = dto.startsAt ? new Date(dto.startsAt) : current?.startsAt;
    const endsAt   = dto.endsAt   ? new Date(dto.endsAt)   : current?.endsAt;
    if (!startsAt || !endsAt) throw required();
    return { startsAt, endsAt };
  }

  private async validateTimes({ startsAt, endsAt }: Times) {
    if (startsAt <= new Date()) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'START_IN_PAST', 'The session must start in the future.');
    }
    if (endsAt <= startsAt) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TIME_RANGE', 'The end time must be after the start time.');
    }
    const maxHours = await this.settings.get('liveSessions.maxDurationHours');
    if (endsAt.getTime() - startsAt.getTime() > maxHours * HOUR_MS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TIME_RANGE', `A session cannot last longer than ${maxHours} hours.`);
    }
  }

  /** Sessions belong to an academic year and must start before it ends. */
  private assertWithinYear({ startsAt }: Times, year: { name: string; endsOn: Date }) {
    const lastDay = year.endsOn.toISOString().slice(0, 10);
    if (toZoned(startsAt, this.timeZone).date > lastDay) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'OUTSIDE_ACADEMIC_YEAR',
        `The ${year.name} academic year ends on ${lastDay}; schedule the session before then.`);
    }
  }

  /** No double-booking a host, and no two sessions at once for one division. */
  private async assertNoConflict(s: Times & { hostId: string; divisionId: string }, excludeId?: string) {
    const clash = await this.prisma.liveSession.findFirst({
      where: {
        status:   'SCHEDULED',
        ...(excludeId && { id: { not: excludeId } }),
        startsAt: { lt: s.endsAt },
        endsAt:   { gt: s.startsAt },
        OR:       [{ hostId: s.hostId }, { divisionId: s.divisionId }],
      },
      select: { id: true, title: true, startsAt: true, endsAt: true, hostId: true },
    });
    if (!clash) return;
    throw new AppError(HttpStatus.CONFLICT, 'SCHEDULE_CONFLICT',
      clash.hostId === s.hostId
        ? `The host already has "${clash.title}" at that time.`
        : `This division already has the live session "${clash.title}" at that time.`,
      { sessionId: clash.id, title: clash.title, startsAt: clash.startsAt, endsAt: clash.endsAt });
  }

  /** The platform is read from the link; a provider given explicitly must agree with it. */
  private resolveProvider(requested: LiveSessionProvider | undefined, url: string): LiveSessionProvider {
    const detected = guessProvider(url);
    if (requested && requested !== 'OTHER' && requested !== detected) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'PROVIDER_MISMATCH',
        `meetingUrl is not a ${PROVIDER_LABEL[requested]} link.`);
    }
    return detected;
  }

  /** A `from`/`to` query value: a plain date covers that whole local day. */
  private boundary(value: string, side: 'start' | 'end'): Date {
    if (!DATE_PATTERN.test(value)) return new Date(value);
    const startOfDay = fromZoned(value, '00:00', this.timeZone);
    return side === 'start' ? startOfDay : new Date(startOfDay.getTime() + DAY_MS);
  }

  /**
   * Add the local date and times, and whether the session is on now. The
   * meeting link is withheld from students once a session is cancelled.
   */
  private present(s: SessionRow, user: AuthUser) {
    const tz    = this.timeZone;
    const start = toZoned(s.startsAt, tz);
    const end   = toZoned(s.endsAt, tz);
    const now   = new Date();
    return {
      ...s,
      date:      start.date,
      startTime: start.time,
      endTime:   end.time,
      timeZone:  tz,
      isLive:    s.status === 'SCHEDULED' && s.startsAt <= now && now < s.endsAt,
      meetingUrl: user.role === 'STUDENT' && s.status === 'CANCELLED' ? null : s.meetingUrl,
    };
  }
}

function guessProvider(url: string): LiveSessionProvider {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'ZOOM';
  if (host === 'meet.google.com') return 'GOOGLE_MEET';
  if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) return 'MICROSOFT_TEAMS';
  return 'OTHER';
}
