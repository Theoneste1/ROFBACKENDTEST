/**
 * EmailWorker — drains the EmailDelivery outbox.
 *
 * Every 10 seconds it claims a batch of due PENDING deliveries with
 * `FOR UPDATE SKIP LOCKED`, so several API instances can run it at once
 * without sending anything twice. Each claim sets `lockedAt`; a claim older
 * than 5 minutes (crashed worker) is picked up again.
 *
 * A provider limit (429: per-second rate, daily or monthly quota) is not a
 * failure: the delivery goes back to the queue without spending an attempt and
 * the worker stops sending until the pause ends, so a quota never makes mail
 * FAILED (nor wipes a one-time link that was never sent).
 *
 * Failures are retried with exponential backoff (1, 2, 4, 8 minutes) and
 * marked FAILED after MAX_ATTEMPTS; errors that retrying cannot fix (an
 * invalid address) fail at once. Each delivery's id is sent to Resend as an
 * idempotency key, so a crash between sending and recording cannot send twice. Bulk-job counters are recomputed from the
 * delivery rows (never incremented), so retries cannot double-count.
 *
 * Resend Free plan (docs/EMAIL.md §10): rows are claimed in priority order (CRITICAL, NORMAL, BULK) and only as many as
 * the budget (UTC calendar day, rolling 31 days) lets each priority send (EmailBudgetService, under the shared budget lock). When the
 * budget is used up nothing is claimed — rows stay PENDING, attempts untouched — and when not even a CRITICAL e-mail may
 * go, the worker sleeps until the next slot (just after 00:00 UTC, or when the 31-day window frees one). Account e-mails with a one-time link are checked just
 * before sending (and swept every minute): a dead link is DISCARDED, never sent. Rows queued before priorities existed
 * are classified first (src/email/email-links.ts).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MailerService } from './mailer.service.js';
import { loadEmailBrand } from './email-brand.js';
import { renderEmail, type EmailBrand } from './templates.js';
import { greetingFor, listUnsubscribeHeaders, unsubscribeLinks } from '../subscribers/subscriber-rules.js';
import { EmailBudgetService } from './email-budget.service.js';
import { LINK_KINDS, LINK_TTL_MS, PRIORITIES } from './email-kinds.js';
import { DiscardReasons, classifyLegacyRows, deadLinkReason, discardDelivery, isLinkKind, refreshResetLink } from './email-links.js';

export const MAX_ATTEMPTS = 5;
/** How often the queued link e-mails are swept for dead links (also checked one by one just before sending). */
export const LINK_SWEEP_MS = 60_000;

interface ClaimedDelivery {
  id:             string;
  jobId:          string | null;
  recipientEmail: string;
  subject:        string | null;
  body:           string | null;
  html:           string | null;
  attempts:       number;
  subscriberId:   string | null;
  kind:           string | null;
  recipientId:    string | null;
  linkExpiresAt:  Date | null;
  linkTokenId:    string | null;
  createdAt:      Date;
}

interface SubscriberOfDelivery {
  id:       string;
  status:   string;
  fullName: string | null;
}

@Injectable()
export class EmailWorker {
  private readonly logger = new Logger(EmailWorker.name);
  private running = false;
  /** Sending is paused until this time after a provider-limit answer (per instance; deferred rows also keep it as nextAttemptAt). */
  private pausedUntil = 0;
  /** Not even a CRITICAL e-mail fits the budget before this time: no claim is tried until then (per instance). */
  private budgetWaitUntil = 0;
  private lastLinkSweep = 0;

  /** Whether a provider limit currently pauses sending on this instance. */
  get paused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  constructor(
    private readonly prisma:  PrismaService,
    private readonly mailer:   MailerService,
    private readonly config:   ConfigService,
    private readonly settings: SettingsService,
    private readonly budget:   EmailBudgetService,
  ) {}

  /** When this instance next tries to claim, if the budget is used up (null: not waiting). */
  get budgetWait(): Date | null {
    return this.budgetWaitUntil > Date.now() ? new Date(this.budgetWaitUntil) : null;
  }

  /** Forget the budget wait (an administrator re-queued e-mails; tests). The budget is still checked on the next claim. */
  wakeUp() {
    this.budgetWaitUntil = 0;
    this.lastLinkSweep = 0;
  }

  @Interval('email-outbox', 10_000)
  async tick() {
    if (this.config.get('WORKERS_ENABLED') === 'false' || this.running) return;
    this.running = true;
    try {
      // Keep going while full batches are found (bounded per tick).
      for (let i = 0; i < 20; i++) {
        const processed = await this.processBatch();
        if (processed < this.mailer.batchSize) break;
      }
    } catch (err) {
      this.logger.error(`Outbox processing failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Claim and send one batch. Returns the number of deliveries processed. */
  async processBatch(): Promise<number> {
    // Rows queued before priorities existed get their kind, priority and link expiry first (none after the first run).
    await classifyLegacyRows(this.prisma);
    if (Date.now() - this.lastLinkSweep >= LINK_SWEEP_MS) await this.sweepDeadLinks();
    if (this.paused || Date.now() < this.budgetWaitUntil) return 0;

    const claimed = await this.claim();
    if (claimed.length === 0) return 0;

    // Bulk-job deliveries take subject/body from their job.
    const jobIds = [...new Set(claimed.map((c) => c.jobId).filter((id): id is string => !!id))];
    const jobs = new Map(
      (await this.prisma.emailJob.findMany({
        where:  { id: { in: jobIds } },
        select: { id: true, subject: true, body: true },
      })).map((j) => [j.id, j]),
    );

    // E-mails to news subscribers: who they are now (a mailing is never sent to someone who unsubscribed meanwhile).
    const subscriberIds = [...new Set(claimed.map((c) => c.subscriberId).filter((id): id is string => !!id))];
    const subscribers = new Map<string, SubscriberOfDelivery>(
      subscriberIds.length === 0 ? [] : (await this.prisma.subscriber.findMany({
        where:  { id: { in: subscriberIds } },
        select: { id: true, status: true, fullName: true },
      })).map((s) => [s.id, s]),
    );

    // Bulk e-mails get the branded layout at send time.
    const brand = jobIds.length > 0 ? await loadEmailBrand(this.settings, this.config) : null;

    // Bounded concurrency; the mailer also paces requests to Resend's rate limit.
    const CONCURRENCY = 5;
    for (let i = 0; i < claimed.length; i += CONCURRENCY) {
      await Promise.all(claimed.slice(i, i + CONCURRENCY).map((d) =>
        this.deliver(d, d.jobId ? jobs.get(d.jobId) : undefined, brand, d.subscriberId ? subscribers.get(d.subscriberId) ?? null : undefined)));
    }

    for (const jobId of jobIds) await this.refreshJob(jobId);
    return claimed.length;
  }

  /**
   * Claim due PENDING rows in priority order, each priority only up to the budget it may still use (under the budget
   * lock, so concurrent workers and the decision sender never share out the same slot). Claiming spends an attempt;
   * deferring gives it back.
   */
  private claim(): Promise<ClaimedDelivery[]> {
    return this.budget.withBudgetLock(async (tx, snapshot) => {
      const claimed: ClaimedDelivery[] = [];
      for (const priority of PRIORITIES) {
        const take = Math.min(this.budget.room(snapshot, priority) - claimed.length, this.mailer.batchSize - claimed.length);
        if (take <= 0) continue;
        // The timestamps are TIMESTAMP WITHOUT TIME ZONE written in UTC by Prisma, so "now" is taken in
        // UTC explicitly: comparing with NOW() would shift every back-off, pause and lock expiry by the
        // database's TimeZone offset (on a UTC+2 server a delivery deferred by 1 h would count as due).
        claimed.push(...await tx.$queryRaw<ClaimedDelivery[]>`
          UPDATE "EmailDelivery" d
          SET "lockedAt" = (NOW() AT TIME ZONE 'UTC'), "attempts" = d."attempts" + 1
          WHERE d."id" IN (
            SELECT "id" FROM "EmailDelivery"
            WHERE "status" = 'PENDING'
              AND "priority" = ${priority}::"EmailPriority"
              AND "nextAttemptAt" <= (NOW() AT TIME ZONE 'UTC')
              AND ("lockedAt" IS NULL OR "lockedAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '5 minutes')
            ORDER BY "createdAt" ASC
            LIMIT ${take}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING d."id", d."jobId", d."recipientEmail", d."subject", d."body", d."html", d."attempts", d."subscriberId",
                    d."kind", d."recipientId", d."linkExpiresAt", d."linkTokenId", d."createdAt"`);
      }
      if (claimed.length === 0 && this.budget.room(snapshot, 'CRITICAL') === 0) {
        // Nothing at all may be sent before the next slot frees: sleep until then (no polling meanwhile).
        const next = await this.budget.nextFreeAt(snapshot, 'CRITICAL', tx);
        this.budgetWaitUntil = next?.getTime() ?? 0;
        if (next) this.logger.warn(`E-mail budget used up (${snapshot.usedDay} today UTC, ${snapshot.usedMonth} in 31 days); next slot ${next.toISOString()}.`);
      }
      return claimed;
    });
  }

  /** Discard queued link e-mails whose link is already dead (every LINK_SWEEP_MS; keeps the waiting count honest). */
  async sweepDeadLinks(now = new Date()): Promise<number> {
    this.lastLinkSweep = Date.now();
    const rows = await this.prisma.emailDelivery.findMany({
      where:  {
        status: 'PENDING', kind: { in: [...LINK_KINDS] },
        OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - 5 * 60_000) } }],
      },
      select: { id: true, kind: true, recipientId: true, linkExpiresAt: true, linkTokenId: true, createdAt: true },
      orderBy: { createdAt: 'asc' }, take: 500,
    });
    let discarded = 0;
    for (const row of rows) {
      const reason = await deadLinkReason(this.prisma, row, now);
      if (reason && await discardDelivery(this.prisma, row.id, reason, now)) discarded++;
    }
    return discarded;
  }

  /**
   * `subscriber`: undefined for e-mails to accounts and addresses; for an e-mail to a news subscriber, that subscriber
   * (null when they no longer exist). A mailing is rendered for its subscriber (greeting, unsubscribe link in the
   * footer) and both carry the List-Unsubscribe headers.
   */
  private async deliver(d: ClaimedDelivery, job: { subject: string; body: string } | undefined, brand: EmailBrand | null, subscriber?: SubscriberOfDelivery | null) {
    let headers: Record<string, string> | undefined;
    let personal: { text: string; html: string } | null = null;
    if (subscriber !== undefined) {
      if (d.jobId && subscriber?.status !== 'ACTIVE') {
        await this.prisma.emailDelivery.update({
          where: { id: d.id },
          data:  { status: 'FAILED', errorMessage: 'Not sent: the subscriber unsubscribed before it was sent.', lockedAt: null, attemptedAt: new Date() },
        });
        return;
      }
      const links = unsubscribeLinks({
        secret: this.config.get<string>('JWT_SECRET') ?? '', appUrl: this.config.get<string>('APP_URL'), apiPublicUrl: this.config.get<string>('API_PUBLIC_URL'),
      }, d.subscriberId!);
      headers = listUnsubscribeHeaders(links);
      if (job && brand && d.body === null) {
        personal = renderEmail({ heading: job.subject, body: job.body, greeting: greetingFor(subscriber?.fullName), unsubscribeUrl: links.pageUrl }, brand);
      }
    }
    const subject = d.subject ?? job?.subject;
    const body    = d.body    ?? personal?.text ?? job?.body;
    const html    = d.html    ?? personal?.html ?? (job && brand ? renderEmail({ heading: job.subject, body: job.body }, brand).html : null);

    if (!subject || !body) {
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        data:  { status: 'FAILED', errorMessage: 'Missing subject or body.', lockedAt: null, attemptedAt: new Date() },
      });
      return;
    }

    // Paused by a limit met earlier in this batch: back to the queue, attempt not spent.
    if (this.paused) return this.defer(d, this.pausedUntil, null);

    // Never send a dead link: checked again right before sending (the link may have died while the e-mail waited).
    if (isLinkKind(d.kind)) {
      const dead = await deadLinkReason(this.prisma, d);
      // A reset link's 30 minutes start now, when it is sent (email-links.ts refreshResetLink).
      const usable = !dead && await refreshResetLink(this.prisma, d, LINK_TTL_MS.PASSWORD_RESET!);
      if (dead || !usable) {
        await discardDelivery(this.prisma, d.id, dead ?? (await deadLinkReason(this.prisma, d)) ?? DiscardReasons.resetExpired);
        return;
      }
    }

    const result = await this.mailer.sendOne({
      to: d.recipientEmail, subject, text: body, html, idempotencyKey: `email-delivery/${d.id}`, ...(headers && { headers }),
    });

    if (result.deferMs) {
      // Daily quota: until just after 00:00 UTC; monthly: 12-24 h; rate limit: 60 s.
      const until = await this.budget.pauseForProvider(result.limit ?? 'DAILY_QUOTA', result.error).catch(() => new Date(Date.now() + result.deferMs!));
      this.pausedUntil = Math.max(this.pausedUntil, until.getTime());
      return this.defer(d, this.pausedUntil, result.error);
    }

    if (result.accepted) {
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        // Individual e-mails may carry one-time links (password reset,
        // activation): their text is not kept once delivered.
        data:  { status: 'SENT', messageId: result.messageId, errorMessage: null, lockedAt: null, attemptedAt: new Date(), ...(!d.jobId && { body: null, html: null }) },
      });
      await this.budget.providerAccepted();
      return;
    }

    const giveUp = result.permanent || d.attempts >= MAX_ATTEMPTS;
    const backoffMs = 60_000 * 2 ** (d.attempts - 1);
    // A plain reason for administrators on the final failure; the provider's answer is kept after it.
    const error = result.error ?? 'The e-mail provider did not accept the e-mail.';
    const message = !giveUp ? error
      : result.permanent ? `Not sent: the e-mail provider refused this e-mail (check the address). ${error}`
      : `Not sent after ${MAX_ATTEMPTS} attempts. Last error: ${error}`;
    await this.prisma.emailDelivery.update({
      where: { id: d.id },
      data: {
        status:        giveUp ? 'FAILED' : 'PENDING',
        ...(giveUp && !d.jobId && { body: null, html: null }),
        errorMessage:  message.slice(0, 1000),
        lockedAt:      null,
        attemptedAt:   new Date(),
        nextAttemptAt: new Date(Date.now() + backoffMs),
      },
    });
  }

  /** Re-queue a claimed delivery without counting the attempt. */
  private async defer(d: ClaimedDelivery, until: number, error: string | null) {
    await this.prisma.emailDelivery.update({
      where: { id: d.id },
      data:  {
        status: 'PENDING', attempts: Math.max(d.attempts - 1, 0), lockedAt: null, nextAttemptAt: new Date(until),
        ...(error && { errorMessage: error.slice(0, 1000) }),
      },
    });
  }

  /** Recompute a bulk job's counters and status from its deliveries. */
  async refreshJob(jobId: string) {
    const groups = await this.prisma.emailDelivery.groupBy({
      by:     ['status'],
      where:  { jobId },
      _count: { _all: true },
    });
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const sent = count('SENT'), failed = count('FAILED'), pending = count('PENDING');

    const status =
      pending > 0          ? 'IN_PROGRESS' :
      failed === 0         ? 'COMPLETED'   :
      sent === 0           ? 'FAILED'      :
                             'PARTIAL_FAILURE';

    await this.prisma.emailJob.update({
      where: { id: jobId },
      data:  {
        sentCount:   sent,
        failedCount: failed,
        status,
        completedAt: pending === 0 ? new Date() : null,
      },
    });
  }
}
