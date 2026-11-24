/**
 * Mailings to news subscribers (owner 2026-11-23): an Administrator writes a subject and a plain-text body, chooses an
 * audience (interests, kinds, countries; empty = every active subscriber), sees how many it reaches, may send a test to
 * themself, and sends.
 *
 * Delivery goes through the e-mail outbox (EmailJob + one EmailDelivery per recipient with subscriberId), so the
 * worker's rate limits, retries and delivery tracking apply; the worker renders each e-mail for its subscriber with the
 * unsubscribe link in the footer and the List-Unsubscribe headers, and never sends to someone who unsubscribed in the
 * meantime. Deliveries wait MAILING_SEND_DELAY_MS before they can be sent, so a mistaken mailing can be cancelled.
 * The body is never written to the audit log.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { loadEmailBrand } from '../email/email-brand.js';
import { renderEmail } from '../email/templates.js';
import { EmailWorker } from '../email/email.worker.js';
import type { AuthUser } from '../common/auth-user.js';
import { Prisma, type MailingStatus } from '../generated/prisma/client.js';
import { MAILING_SEND_DELAY_MS, audienceWhere, greetingFor, normaliseAudience, type Audience } from './subscriber-rules.js';
import type { CreateMailingDto, ListMailingsDto, MailingAudienceDto, TestMailingDto } from './subscribers.dto.js';

const MAILING_SELECT = {
  id: true, subject: true, audience: true, status: true, recipientCount: true, sentCount: true, failedCount: true,
  cancelledCount: true, emailJobId: true, createdAt: true, sentAt: true, cancelledAt: true,
  createdBy: { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;

type MailingRow = Prisma.MailingGetPayload<{ select: typeof MAILING_SELECT }>;

const CHUNK = 1000;
const FINAL: readonly MailingStatus[] = ['SENT', 'FAILED', 'CANCELLED'];

/** A mailing's status from its deliveries' counts. */
export function mailingStatus(current: MailingStatus, counts: { pending: number; sent: number; failed: number }): MailingStatus {
  if (current === 'CANCELLED') return 'CANCELLED';
  if (counts.pending > 0) return counts.sent + counts.failed === 0 ? 'QUEUED' : 'SENDING';
  return counts.sent === 0 && counts.failed > 0 ? 'FAILED' : 'SENT';
}

@Injectable()
export class MailingsService {
  constructor(
    private readonly prisma:   PrismaService,
    private readonly settings: SettingsService,
    private readonly audit:    AuditService,
    private readonly config:   ConfigService,
    private readonly worker:   EmailWorker,
  ) {}

  /** How many active subscribers an audience reaches. */
  async preview(dto: MailingAudienceDto) {
    const audience = normaliseAudience(dto.audience);
    return { audience, recipients: await this.prisma.subscriber.count({ where: audienceWhere(audience) }) };
  }

  /** The e-mail exactly as a subscriber gets it, to the caller's own address only (an inactive sample unsubscribe link). */
  async sendTest(dto: TestMailingDto, user: AuthUser) {
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true, firstName: true } });
    const appUrl = this.config.get<string>('APP_URL');
    const mail = renderEmail({
      heading: dto.subject, body: dto.body, greeting: greetingFor(me.firstName),
      unsubscribeUrl: appUrl ? `${appUrl.replace(/\/+$/, '')}/unsubscribe` : null,
    }, await loadEmailBrand(this.settings, this.config));
    await this.prisma.emailDelivery.create({
      data: { recipientEmail: me.email, recipientId: user.id, subject: `[Test] ${dto.subject}`, body: mail.text, html: mail.html, kind: 'MAILING_TEST', priority: 'NORMAL' },
    });
    await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'MAILING_TEST_SENT', entity: 'Mailing' });
    return { sentTo: me.email };
  }

  async create(dto: CreateMailingDto, user: AuthUser) {
    const again = await this.prisma.mailing.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, select: { id: true } });
    if (again) return { ...(await this.get(again.id)), alreadyExisted: true };

    const audience = normaliseAudience(dto.audience);
    const recipients = await this.prisma.subscriber.findMany({ where: audienceWhere(audience), select: { id: true, email: true }, orderBy: { id: 'asc' } });
    // Addresses are unique already; kept as a guard should two rows ever share one.
    const seen = new Set<string>();
    const unique = recipients.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)));
    if (unique.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_RECIPIENTS', 'No active subscriber matches this audience. Remove some filters and try again.');
    }

    const sendAfter = new Date(Date.now() + MAILING_SEND_DELAY_MS);
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const job = await tx.emailJob.create({
          data: {
            idempotencyKey: `mailing:${dto.idempotencyKey}`, subject: dto.subject, body: dto.body, status: 'PENDING',
            totalRecipients: unique.length, createdById: user.id,
          },
          select: { id: true },
        });
        for (let i = 0; i < unique.length; i += CHUNK) {
          await tx.emailDelivery.createMany({
            data: unique.slice(i, i + CHUNK).map((r) => ({ jobId: job.id, recipientEmail: r.email, subscriberId: r.id, nextAttemptAt: sendAfter, kind: 'MAILING', priority: 'BULK' as const })),
          });
        }
        const mailing = await tx.mailing.create({
          data: {
            idempotencyKey: dto.idempotencyKey, subject: dto.subject, body: dto.body, audience: audience as Prisma.InputJsonValue,
            recipientCount: unique.length, emailJobId: job.id, createdById: user.id,
          },
          select: { id: true },
        });
        await this.audit.log({
          actorId: user.id, actorRole: user.role, action: 'MAILING_CREATED', entity: 'Mailing', entityId: mailing.id,
          // subject and body deliberately omitted
          metadata: { recipients: unique.length, audience, emailJobId: job.id },
        }, tx);
        return mailing.id;
      }, { timeout: 60_000 });
    } catch (err) {
      // The same request twice at once: return the mailing the other one created.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.mailing.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, select: { id: true } });
        if (raced) return { ...(await this.get(raced.id)), alreadyExisted: true };
      }
      throw err;
    }
    return { ...(await this.get(id)), alreadyExisted: false };
  }

  async list(q: ListMailingsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mailing.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take, select: MAILING_SELECT }),
      this.prisma.mailing.count(),
    ]);
    return paginated(await Promise.all(rows.map((r) => this.refresh(r))), total, page, limit);
  }

  async get(id: string) {
    const row = await this.prisma.mailing.findUnique({ where: { id }, select: { ...MAILING_SELECT, body: true } });
    if (!row) throw new NotFoundException('This mailing does not exist.');
    const { body, ...rest } = row;
    return { ...(await this.refresh(rest)), body };
  }

  /** Withdraw the deliveries not sent yet. Possible while the mailing is QUEUED or SENDING; what was sent stays sent. */
  async cancel(id: string, user: AuthUser) {
    const row = await this.prisma.mailing.findUnique({ where: { id }, select: MAILING_SELECT });
    if (!row) throw new NotFoundException('This mailing does not exist.');
    const current = await this.refresh(row);
    if (FINAL.includes(current.status)) {
      throw invalidState(current.status === 'CANCELLED' ? 'This mailing is already cancelled.' : 'This mailing has already been sent; it can no longer be cancelled.');
    }
    const withdrawn = await this.prisma.$transaction(async (tx) => {
      // Only deliveries no worker holds right now: one being sent at this moment is left to finish.
      const { count } = await tx.emailDelivery.deleteMany({ where: { jobId: row.emailJobId!, status: 'PENDING', lockedAt: null } });
      await tx.emailJob.update({ where: { id: row.emailJobId! }, data: { totalRecipients: { decrement: count } } });
      await tx.mailing.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledCount: { increment: count }, cancelledAt: new Date(), cancelledById: user.id },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'MAILING_CANCELLED', entity: 'Mailing', entityId: id, metadata: { withdrawn: count },
      }, tx);
      return count;
    });
    await this.worker.refreshJob(row.emailJobId!);
    return { ...(await this.get(id)), withdrawn };
  }

  /** Counts and status from the deliveries (never incremented, so retries cannot double-count); saved when changed. */
  private async refresh(row: MailingRow) {
    if (!row.emailJobId) return { ...row, pendingCount: 0, sendsAfter: null };
    const groups = await this.prisma.emailDelivery.groupBy({ by: ['status'], where: { jobId: row.emailJobId }, _count: { _all: true } });
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const counts = { pending: count('PENDING'), sent: count('SENT'), failed: count('FAILED') };
    const status = mailingStatus(row.status, counts);
    const finished = status === 'SENT' || status === 'FAILED';
    if (status !== row.status || counts.sent !== row.sentCount || counts.failed !== row.failedCount || (finished && !row.sentAt)) {
      const sentAt = finished ? (row.sentAt ?? new Date()) : row.sentAt;
      await this.prisma.mailing.update({ where: { id: row.id }, data: { status, sentCount: counts.sent, failedCount: counts.failed, sentAt } });
      Object.assign(row, { status, sentCount: counts.sent, failedCount: counts.failed, sentAt });
    }
    return {
      ...row,
      audience: row.audience as Audience,
      pendingCount: counts.pending,
      /** Until then the mailing can be cancelled before anything is sent. */
      sendsAfter: new Date(row.createdAt.getTime() + MAILING_SEND_DELAY_MS),
    };
  }
}
