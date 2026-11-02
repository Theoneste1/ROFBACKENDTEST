/**
 * NotificationsService
 *
 * - notify():     writes in-app notifications and (optionally) queues e-mails.
 * - queueEmail(): adds a transactional e-mail to the outbox (EmailDelivery).
 *
 * E-mails are never sent inline: the EmailWorker drains the outbox in the
 * background with retries, so a slow SMTP server never slows a request.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationCategory, Prisma } from '../generated/prisma/client.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';

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
    const recipients = [...new Set(userIds)];
    if (recipients.length === 0) return;

    for (let i = 0; i < recipients.length; i += CHUNK) {
      await this.prisma.notification.createMany({
        data: recipients.slice(i, i + CHUNK).map((userId) => ({
          userId,
          category: payload.category,
          type:     payload.type,
          title:    payload.title,
          body:     payload.body,
          data:     (payload.data as Prisma.InputJsonValue) ?? undefined,
        })),
      });
    }

    if (opts.email === false) return;

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

  async list(userId: string, query: PaginationQueryDto & { unreadOnly?: boolean }) {
    const { page, limit, skip, take } = pageArgs(query);
    const where = { userId, ...(query.unreadOnly && { readAt: null }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.notification.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  async unreadCount(userId: string) {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id: string) {
    // Scoped by userId: marking someone else's notification is a silent no-op.
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data:  { readAt: new Date() },
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
