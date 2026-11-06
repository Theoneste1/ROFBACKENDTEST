/**
 * Public homepage data (approved 2026-11-06).
 *
 * Statistics: aggregate counts only — no personal data — computed by the
 * server with fixed queries (no client input), cached for 5 minutes.
 * An "active registered member" is an account that is active (not
 * suspended), approved and activated (e-mail verified / password set).
 * Deleted accounts no longer exist and are never counted.
 *   students — active STUDENT accounts
 *   coaches  — active MENTOR accounts (coaches mentor ROF students)
 *   teachers — null: school teachers have no accounts on the platform yet
 *   schools  — schools with at least one active student
 *   members  — all active accounts (students, coaches, administrators)
 *
 * Contact: messages are validated, rate-limited (per IP in the controller,
 * per e-mail and duplicates here, plus a honeypot), stored, and an e-mail notice
 * is queued to platform.supportEmail when one is configured. The response says
 * which happened; it never claims an e-mail was delivered.
 */
import { createHmac } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CreateContactMessageDto, ListContactMessagesDto, UpdateContactMessageDto } from './dto/contact.dto.js';

export const ACTIVE_MEMBER: Prisma.UserWhereInput = { isActive: true, isApproved: true, activatedAt: { not: null } };

export interface PublicStatistics {
  students: number;
  coaches: number;
  teachers: number | null;
  schools: number;
  members: number;
  generatedAt: string;
}

const STATS_TTL_MS = 5 * 60_000;
/** At most this many messages per e-mail address per hour. */
export const CONTACT_PER_EMAIL_PER_HOUR = 3;

const CONTACT_ADMIN_SELECT = {
  id: true, fullName: true, email: true, subject: true, message: true, status: true,
  notification: true, handledAt: true, handledById: true, createdAt: true,
} as const;

@Injectable()
export class PublicSiteService {
  private cache: { at: number; value: PublicStatistics } | null = null;

  constructor(
    private readonly prisma:        PrismaService,
    private readonly settings:      SettingsService,
    private readonly notifications: NotificationsService,
    private readonly audit:         AuditService,
    private readonly config:        ConfigService,
  ) {}

  // ─── Statistics ─────────────────────────────────────────────────────────────

  async statistics(): Promise<PublicStatistics> {
    if (this.cache && Date.now() - this.cache.at < STATS_TTL_MS) return this.cache.value;
    const [students, coaches, members, schools] = await this.prisma.$transaction([
      this.prisma.user.count({ where: { ...ACTIVE_MEMBER, role: 'STUDENT' } }),
      this.prisma.user.count({ where: { ...ACTIVE_MEMBER, role: 'MENTOR' } }),
      this.prisma.user.count({ where: ACTIVE_MEMBER }),
      this.prisma.school.count({ where: { students: { some: { ...ACTIVE_MEMBER, role: 'STUDENT' } } } }),
    ]);
    const value: PublicStatistics = { students, coaches, teachers: null, schools, members, generatedAt: new Date().toISOString() };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Tests only: forget the cached figures. */
  clearStatisticsCache() {
    this.cache = null;
  }

  // ─── Contact ────────────────────────────────────────────────────────────────

  async contact(dto: CreateContactMessageDto, ip: string | undefined) {
    // Honeypot filled in: look like success, store and send nothing.
    if (dto.website && dto.website.trim() !== '') return { received: true, notification: 'QUEUED' as const };

    const since = new Date(Date.now() - 60 * 60_000);
    const recent = await this.prisma.contactMessage.count({ where: { email: dto.email, createdAt: { gte: since } } });
    if (recent >= CONTACT_PER_EMAIL_PER_HOUR) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'CONTACT_LIMIT', 'Too many messages from this e-mail address. Please try again later.');
    }
    const duplicate = await this.prisma.contactMessage.findFirst({
      where: { email: dto.email, subject: dto.subject, message: dto.message, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppError(HttpStatus.CONFLICT, 'DUPLICATE_MESSAGE', 'We have already received this message.');
    }

    const supportEmail = await this.settings.get('platform.supportEmail');
    const notification = supportEmail ? ('QUEUED' as const) : ('NOT_CONFIGURED' as const);
    const saved = await this.prisma.contactMessage.create({
      data: {
        fullName: dto.fullName, email: dto.email, subject: dto.subject, message: dto.message,
        notification, ipHash: this.hashIp(ip),
      },
      select: { id: true, createdAt: true },
    });

    if (supportEmail) {
      // Queued in the e-mail outbox; the worker delivers it (or logs it in DRY_RUN).
      await this.notifications.queueEmail(
        supportEmail,
        `Contact form: ${dto.subject}`,
        [`New message from the website contact form.`, '', `From: ${dto.fullName} <${dto.email}>`, `Subject: ${dto.subject}`, '', dto.message].join('\n'),
        { link: '/admin/messages' },
      );
    }
    return { received: true, id: saved.id, notification };
  }

  /** Keyed hash so the stored value cannot be reversed into an IP address. */
  private hashIp(ip: string | undefined) {
    if (!ip) return null;
    return createHmac('sha256', this.config.get<string>('JWT_SECRET') ?? 'rof').update(`contact-ip:${ip}`).digest('hex');
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  async listMessages(q: ListContactMessagesDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.ContactMessageWhereInput = q.status ? { status: q.status } : {};
    const [rows, total, open] = await this.prisma.$transaction([
      this.prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, select: CONTACT_ADMIN_SELECT }),
      this.prisma.contactMessage.count({ where }),
      this.prisma.contactMessage.count({ where: { status: 'NEW' } }),
    ]);
    return { ...paginated(rows, total, page, limit), newCount: open };
  }

  async updateMessage(id: string, dto: UpdateContactMessageDto, user: AuthUser) {
    const existing = await this.prisma.contactMessage.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!existing) throw new NotFoundException('Message not found.');
    const handled = dto.status === 'HANDLED';
    const row = await this.prisma.contactMessage.update({
      where: { id },
      data: { status: dto.status, handledAt: handled ? new Date() : null, handledById: handled ? user.id : null },
      select: CONTACT_ADMIN_SELECT,
    });
    if (existing.status !== dto.status) {
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: handled ? 'HANDLE_CONTACT_MESSAGE' : 'REOPEN_CONTACT_MESSAGE', entity: 'ContactMessage', entityId: id,
      });
    }
    return row;
  }
}
