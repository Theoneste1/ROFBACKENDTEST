/**
 * NotificationsService
 *
 * - notify():     writes in-app notifications and (optionally) queues e-mails.
 * - queueEmail(): adds a transactional e-mail to the outbox (EmailDelivery).
 *
 * E-mails are never sent inline: the EmailWorker drains the outbox in the
 * background with retries, so a slow SMTP server never slows a request.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationCategory, Prisma, type Role } from '../generated/prisma/client.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';
import { AppError } from '../common/errors/app-error.js';
import { configurableTypesFor, isConfigurableType } from './notification-types.js';

export interface NotificationPayload {
  category: NotificationCategory;
  type:     string;
  title:    string;
  body:     string;
  /** Ids for deep-linking (assignmentId, submissionId, …). */
  data?:    Record<string, string>;
  /** Frontend path appended to APP_URL in e-mails, e.g. "/assignments/123". */
  link?:    string;
}

const CHUNK = 1000;

const NOTIFICATION_SELECT = {
  id: true, category: true, type: true, title: true, body: true, data: true, link: true,
  readAt: true, createdAt: true,
} as const;

type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof NOTIFICATION_SELECT }>;

export interface ListNotificationsQuery extends PaginationQueryDto {
  unreadOnly?: boolean;
  category?:   NotificationCategory;
  type?:       string;
}

const present = (n: NotificationRow) => ({ ...n, isRead: n.readAt !== null });

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma:   PrismaService,
    private readonly settings: SettingsService,
    private readonly config:   ConfigService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Sending
  // ═══════════════════════════════════════════════════════════════════════════

  async notify(userIds: string[], payload: NotificationPayload, opts: { email?: boolean } = {}) {
    let recipients = [...new Set(userIds)];
    if (recipients.length === 0) return;

    // Admins and mentors may have switched this type off (in-app and/or e-mail).
    const off = isConfigurableType(payload.type) ? await this.switchedOff(recipients, payload.type) : undefined;
    const inApp = off ? recipients.filter((id) => !off.inApp.has(id)) : recipients;

    for (let i = 0; i < inApp.length; i += CHUNK) {
      await this.prisma.notification.createMany({
        data: inApp.slice(i, i + CHUNK).map((userId) => ({
          userId,
          category: payload.category,
          type:     payload.type,
          title:    payload.title,
          body:     payload.body,
          data:     (payload.data as Prisma.InputJsonValue) ?? undefined,
          link:     payload.link ?? null,
        })),
      });
    }

    if (opts.email === false) return;
    if (off) recipients = recipients.filter((id) => !off.email.has(id));
    if (recipients.length === 0) return;

    const isAccount = payload.category === 'ACCOUNT';
    if (!isAccount && !(await this.settings.get('notifications.emailEnabled'))) return;

    // Respect per-category opt-outs (account e-mails cannot be turned off).
    const optedOut = isAccount
      ? new Set<string>()
      : new Set(
          (
            await this.prisma.notificationPreference.findMany({
              where:  { userId: { in: recipients }, category: payload.category, emailEnabled: false },
              select: { userId: true },
            })
          ).map((p) => p.userId),
        );

    const users = await this.prisma.user.findMany({
      where:  { id: { in: recipients.filter((id) => !optedOut.has(id)) }, isActive: true },
      select: { id: true, email: true, firstName: true },
    });

    const subject = await this.subject(payload.title);
    for (let i = 0; i < users.length; i += CHUNK) {
      await this.prisma.emailDelivery.createMany({
        data: await Promise.all(
          users.slice(i, i + CHUNK).map(async (u) => ({
            recipientEmail: u.email,
            recipientId:    u.id,
            subject,
            body:           await this.composeBody(u.firstName, payload.body, payload.link),
          })),
        ),
      });
    }
  }

  /** Queue a transactional e-mail to an address that may not belong to a user. */
  async queueEmail(to: string, title: string, body: string, opts: { firstName?: string; link?: string; recipientId?: string } = {}) {
    await this.prisma.emailDelivery.create({
      data: {
        recipientEmail: to,
        recipientId:    opts.recipientId ?? null,
        subject:        await this.subject(title),
        body:           await this.composeBody(opts.firstName ?? null, body, opts.link),
      },
    });
  }

  /** Recipients who switched a type off, per channel. Only "off" rows exist to read. */
  private async switchedOff(recipients: string[], type: string) {
    const inApp = new Set<string>();
    const email = new Set<string>();
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const rows = await this.prisma.notificationSetting.findMany({
        where:  { type, userId: { in: recipients.slice(i, i + CHUNK) }, OR: [{ inAppEnabled: false }, { emailEnabled: false }] },
        select: { userId: true, inAppEnabled: true, emailEnabled: true },
      });
      for (const r of rows) {
        if (!r.inAppEnabled) inApp.add(r.userId);
        if (!r.emailEnabled) email.add(r.userId);
      }
    }
    return { inApp, email };
  }

  /** Active admins — recipients for coordination events. */
  async adminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where:  { role: 'ADMIN', isActive: true },
      select: { id: true },
    });
    return admins.map((a) => a.id);
  }

  /** Active, approved students in a division. */
  async studentIdsInDivision(divisionId: string): Promise<string[]> {
    const students = await this.prisma.user.findMany({
      where:  { role: 'STUDENT', divisionId, isActive: true, isApproved: true },
      select: { id: true },
    });
    return students.map((s) => s.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reading (current user)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The caller's own notifications, newest first. Every query is scoped by
   * userId, so nobody can read or change another user's notifications.
   */
  async list(userId: string, query: ListNotificationsQuery) {
    const { page, limit, skip, take } = pageArgs(query);
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unreadOnly && { readAt: null }),
      ...(query.category   && { category: query.category }),
      ...(query.type       && { type: query.type }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, select: NOTIFICATION_SELECT }),
      this.prisma.notification.count({ where }),
    ]);
    return paginated(rows.map(present), total, page, limit);
  }

  async findOne(userId: string, id: string) {
    const row = await this.prisma.notification.findFirst({ where: { id, userId }, select: NOTIFICATION_SELECT });
    // Someone else's notification is indistinguishable from a missing one.
    if (!row) throw new NotFoundException('Notification not found.');
    return present(row);
  }

  /** Total unread, and unread per category (for badges). */
  async unreadCount(userId: string) {
    const groups = await this.prisma.notification.groupBy({
      by: ['category'], where: { userId, readAt: null }, _count: { _all: true },
    });
    const byCategory = Object.fromEntries(
      Object.values(NotificationCategory).map((c) => [c, groups.find((g) => g.category === c)?._count._all ?? 0]),
    ) as Record<NotificationCategory, number>;
    return { unread: groups.reduce((n, g) => n + g._count._all, 0), byCategory };
  }

  async markRead(userId: string, id: string) {
    // Scoped by userId: marking someone else's notification is a silent no-op.
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data:  { readAt: new Date() },
    });
    return { updated: count };
  }

  /** Mark several of the caller's notifications read at once (ids of others are ignored). */
  async markManyRead(userId: string, ids: string[]) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId, readAt: null },
      data:  { readAt: new Date() },
    });
    return { updated: count };
  }

  async markUnread(userId: string, id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: { not: null } },
      data:  { readAt: null },
    });
    return { updated: count };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data:  { readAt: new Date() },
    });
    return { updated: count };
  }

  async getPreferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const byCategory = new Map(rows.map((r) => [r.category, r.emailEnabled]));
    return Object.values(NotificationCategory).map((category) => ({
      category,
      emailEnabled: category === 'ACCOUNT' ? true : (byCategory.get(category) ?? true),
      locked:       category === 'ACCOUNT',
    }));
  }

  async updatePreferences(userId: string, prefs: Array<{ category: NotificationCategory; emailEnabled: boolean }>) {
    await this.prisma.$transaction(
      prefs
        .filter((p) => p.category !== 'ACCOUNT')
        .map((p) =>
          this.prisma.notificationPreference.upsert({
            where:  { userId_category: { userId, category: p.category } },
            create: { userId, category: p.category, emailEnabled: p.emailEnabled },
            update: { emailEnabled: p.emailEnabled },
          }),
        ),
    );
    return this.getPreferences(userId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Notification settings (admins and mentors, per type)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The notifications the caller's role receives, each with its in-app and
   * e-mail switch. `emailAvailable: false` marks in-app-only types. E-mail is
   * also subject to the category e-mail preference (`categoryEmailEnabled`).
   */
  async getSettings(user: { id: string; role: Role }) {
    const types = configurableTypesFor(user.role);
    const [rows, categoryPrefs] = await this.prisma.$transaction([
      this.prisma.notificationSetting.findMany({ where: { userId: user.id } }),
      this.prisma.notificationPreference.findMany({ where: { userId: user.id } }),
    ]);
    const byType = new Map(rows.map((r) => [r.type, r]));
    const categoryEmail = new Map(categoryPrefs.map((p) => [p.category, p.emailEnabled]));

    return {
      settings: types.map((t) => {
        const row = byType.get(t.type);
        return {
          type:                 t.type,
          category:             t.category,
          label:                t.label,
          description:          t.description,
          inAppEnabled:         row?.inAppEnabled ?? true,
          emailAvailable:       t.email,
          emailEnabled:         t.email ? (row?.emailEnabled ?? true) : false,
          categoryEmailEnabled: categoryEmail.get(t.category) ?? true,
        };
      }),
    };
  }

  /** Switch types on or off. Only types the caller's role receives can be changed. */
  async updateSettings(
    user: { id: string; role: Role },
    changes: Array<{ type: string; inAppEnabled?: boolean; emailEnabled?: boolean }>,
  ) {
    const allowed = new Map(configurableTypesFor(user.role).map((t) => [t.type, t]));
    const seen = new Set<string>();
    for (const c of changes) {
      const info = allowed.get(c.type);
      if (!info) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_NOTIFICATION_TYPE',
          `"${c.type}" is not a notification you can configure.`);
      }
      if (seen.has(c.type)) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'DUPLICATE_NOTIFICATION_TYPE', `"${c.type}" is listed more than once.`);
      }
      seen.add(c.type);
      if (c.inAppEnabled === undefined && c.emailEnabled === undefined) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', `Give inAppEnabled and/or emailEnabled for "${c.type}".`);
      }
      if (c.emailEnabled !== undefined && !info.email) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'EMAIL_NOT_AVAILABLE', `"${info.label}" is only shown in the app, never e-mailed.`);
      }
    }

    await this.prisma.$transaction(
      changes.map((c) => {
        const data = {
          ...(c.inAppEnabled !== undefined && { inAppEnabled: c.inAppEnabled }),
          ...(c.emailEnabled !== undefined && { emailEnabled: c.emailEnabled }),
        };
        return this.prisma.notificationSetting.upsert({
          where:  { userId_type: { userId: user.id, type: c.type } },
          create: { userId: user.id, type: c.type, ...data },
          update: data,
        });
      }),
    );
    return this.getSettings(user);
  }

  /** Back to the defaults: everything on. */
  async resetSettings(user: { id: string; role: Role }) {
    await this.prisma.notificationSetting.deleteMany({ where: { userId: user.id } });
    return this.getSettings(user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // E-mail composition (plain text — no HTML injection surface)
  // ═══════════════════════════════════════════════════════════════════════════

  private async subject(title: string) {
    return `[${await this.settings.get('platform.name')}] ${title}`.slice(0, 200);
  }

  private async composeBody(firstName: string | null, body: string, link?: string) {
    const platform = await this.settings.get('platform.name');
    const support  = await this.settings.get('platform.supportEmail');
    const appUrl   = this.config.get<string>('APP_URL');
    const lines = [
      firstName ? `Hello ${firstName},` : 'Hello,',
      '',
      body,
    ];
    if (link && appUrl) lines.push('', `Open: ${appUrl.replace(/\/$/, '')}${link}`);
    lines.push('', '—', platform);
    if (support) lines.push(`Questions? ${support}`);
    return lines.join('\n');
  }
}
