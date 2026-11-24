/**
 * EmailBudgetService — keeps the platform inside the Resend Free plan (owner decision 2026-11-24: 100 e-mails a day,
 * 3,000 a month, never upgrade). See docs/EMAIL.md §10.
 *
 * Counted: every e-mail handed to the provider — EmailDelivery rows SENT (by attemptedAt) and NotificationOutbox rows
 * SENT (by sentAt) — plus the ones being sent right now (claimed EmailDelivery rows, SENDING outbox rows). Each row has
 * exactly one recipient (no CC/BCC), so one row = one e-mail as Resend counts it.
 *   DAY:   the current UTC calendar day — Resend's daily quota resets at 00:00 UTC (docs: account quotas and limits).
 *   MONTH: a ROLLING 31 days — whatever Resend's monthly period is (calendar month or billing cycle, at most 31 days),
 *          it lies inside some 31-day window, so 2,900 in any 31 days is never more than 2,900 in Resend's month.
 * A limit of 0 means "no limit" for that window (e.g. Pro: EMAIL_DAILY_LIMIT=0, EMAIL_MONTHLY_LIMIT=50000).
 *
 * Budget = limit − safety margin (95 a day, 2,900 a month by default). CRITICAL e-mails may use all of it; NORMAL ones
 * only while less than EMAIL_NORMAL_SHARE_PERCENT (80 %) of it is used, BULK ones while less than
 * EMAIL_BULK_SHARE_PERCENT (50 %) is used — the rest is kept for password resets, invitations and other CRITICAL mail.
 *
 * Both senders (EmailWorker, DecisionNotificationsService) check the budget and claim under ONE transaction-scoped
 * advisory lock, so several API instances can never together exceed it. Nothing is sent and nothing is failed while the
 * budget is used up: rows stay queued, attempts untouched, until nextFreeAt() — just after 00:00 UTC for the day, or
 * when the oldest e-mail leaves the 31-day window.
 *
 * A provider limit answer (429) pauses every sender through EmailSendingState (key "provider"): a daily quota until just
 * after the next 00:00 UTC, a monthly quota 12–24 hours, a per-second rate limit 60 seconds.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { EmailPriority, Prisma } from '../generated/prisma/client.js';
import { MailerService, RATE_PAUSE_MS, type ProviderLimit } from './mailer.service.js';
import { PRIORITIES, decisionPriority } from './email-kinds.js';

type Db = Prisma.TransactionClient | PrismaService;

export const DAY_MS = 24 * 60 * 60_000;
/** The monthly window: rolling 31 days (contains any calendar month or billing cycle). */
export const MONTH_MS = 31 * DAY_MS;
/** Sending resumes this long after 00:00 UTC (clock differences with the provider). */
export const DAY_RESET_SLACK_MS = 60_000;
/** The start of the UTC calendar day of `t`. */
export const utcDayStart = (t: Date) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
/** The next 00:00 UTC after `t`. */
export const nextUtcMidnight = (t: Date) => new Date(utcDayStart(t).getTime() + DAY_MS);
/** A claimed EmailDelivery counts as "being sent" for this long (the worker's lock expiry). */
export const CLAIM_LOCK_MS = 5 * 60_000;
/** After a monthly-quota answer: at least this long, and at most MONTHLY_QUOTA_MAX_PAUSE_MS, before trying again. */
export const MONTHLY_QUOTA_MIN_PAUSE_MS = 12 * 60 * 60_000;
export const MONTHLY_QUOTA_MAX_PAUSE_MS = 24 * 60 * 60_000;
/** The decision sweep gives up automatic retries after this many attempts (decision-notifications MAX_ATTEMPTS). */
const OUTBOX_MAX_ATTEMPTS = 5;
const PROVIDER_KEY = 'provider';
/** The one advisory lock both senders take while they check the budget and claim. */
const LOCK_KEY = 'rof-email-budget';
/** Provider errors recorded for a 429 limit answer (mailer: "Resend 429 <name>: <message>"). */
export const QUOTA_ERROR_PREFIX = 'Resend 429 ';

export interface BudgetLimits {
  /** 0 = no daily limit. */
  dailyLimit:          number;
  /** 0 = no monthly limit. */
  monthlyLimit:        number;
  dailySafetyMargin:   number;
  monthlySafetyMargin: number;
  /** limit − margin (Infinity when the limit is 0 = none). */
  dailyBudget:         number;
  monthlyBudget:       number;
  normalSharePercent:  number;
  bulkSharePercent:    number;
  /** What each priority may use of each window (CRITICAL = the whole budget). */
  caps: Record<EmailPriority, { day: number; month: number }>;
}

export interface BudgetSnapshot {
  now:       Date;
  /** Sent since 00:00 UTC today. */
  sentDay:   number;
  /** Sent in the last 31 days. */
  sentMonth: number;
  /** Claimed / SENDING right now (counted against both windows). */
  inFlight:  number;
  usedDay:   number;
  usedMonth: number;
}

export type PauseReason = 'DAILY_QUOTA' | 'MONTHLY_QUOTA' | 'RATE_LIMIT';

const finite = (n: number) => (n === Infinity ? null : n);

const int = (raw: unknown, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && String(raw ?? '').trim() !== '' ? Math.min(Math.max(Math.floor(n), min), max) : fallback;
};

@Injectable()
export class EmailBudgetService {
  private readonly logger = new Logger(EmailBudgetService.name);
  readonly limits: BudgetLimits;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mailer: MailerService,
    private readonly audit:  AuditService,
  ) {
    // 0 = no limit for that window (e.g. Resend Pro has no daily limit).
    const dailyLimit   = int(config.get('EMAIL_DAILY_LIMIT'), 100, 0, 1_000_000);
    const monthlyLimit = int(config.get('EMAIL_MONTHLY_LIMIT'), 3000, 0, 100_000_000);
    const dailyMargin   = dailyLimit === 0 ? 0 : int(config.get('EMAIL_DAILY_SAFETY_MARGIN'), 5, 0, dailyLimit - 1);
    const monthlyMargin = monthlyLimit === 0 ? 0 : int(config.get('EMAIL_MONTHLY_SAFETY_MARGIN'), 100, 0, monthlyLimit - 1);
    const normal = int(config.get('EMAIL_NORMAL_SHARE_PERCENT'), 80, 0, 100);
    const bulk   = Math.min(int(config.get('EMAIL_BULK_SHARE_PERCENT'), 50, 0, 100), normal);
    const day   = dailyLimit === 0 ? Infinity : dailyLimit - dailyMargin;
    const month = monthlyLimit === 0 ? Infinity : monthlyLimit - monthlyMargin;
    const share = (budget: number, percent: number) => (budget === Infinity ? Infinity : Math.floor((budget * percent) / 100));
    this.limits = {
      dailyLimit, monthlyLimit, dailySafetyMargin: dailyMargin, monthlySafetyMargin: monthlyMargin,
      dailyBudget: day, monthlyBudget: month, normalSharePercent: normal, bulkSharePercent: bulk,
      caps: {
        CRITICAL: { day, month },
        NORMAL:   { day: share(day, normal), month: share(month, normal) },
        BULK:     { day: share(day, bulk), month: share(month, bulk) },
      },
    };
  }

  // ─── Counting ────────────────────────────────────────────────────────────────

  async snapshot(db: Db = this.prisma, now = new Date()): Promise<BudgetSnapshot> {
    const dayStart = utcDayStart(now), monthAgo = new Date(now.getTime() - MONTH_MS);
    const lockFloor = new Date(now.getTime() - CLAIM_LOCK_MS);
    const [mailDay, outDay, mailMonth, outMonth, claimed, sending] = await Promise.all([
      db.emailDelivery.count({ where: { status: 'SENT', attemptedAt: { gte: dayStart } } }),
      db.notificationOutbox.count({ where: { status: 'SENT', sentAt: { gte: dayStart } } }),
      db.emailDelivery.count({ where: { status: 'SENT', attemptedAt: { gte: monthAgo } } }),
      db.notificationOutbox.count({ where: { status: 'SENT', sentAt: { gte: monthAgo } } }),
      db.emailDelivery.count({ where: { status: 'PENDING', lockedAt: { gte: lockFloor } } }),
      db.notificationOutbox.count({ where: { status: 'SENDING' } }),
    ]);
    const inFlight = claimed + sending;
    const sentDay = mailDay + outDay, sentMonth = mailMonth + outMonth;
    return { now, sentDay, sentMonth, inFlight, usedDay: sentDay + inFlight, usedMonth: sentMonth + inFlight };
  }

  /** How many more e-mails of this priority may be handed to the provider now. */
  room(s: BudgetSnapshot, priority: EmailPriority): number {
    const cap = this.limits.caps[priority];
    const room = Math.min(cap.day - s.usedDay, cap.month - s.usedMonth);
    return room === Infinity ? Number.MAX_SAFE_INTEGER : Math.max(0, room);
  }

  /** Which window stops this priority now: 'DAY', 'MONTH' or null (room left). */
  blockedBy(s: BudgetSnapshot, priority: EmailPriority): 'DAY' | 'MONTH' | null {
    const cap = this.limits.caps[priority];
    if (cap.month - s.usedMonth <= 0) return 'MONTH';
    if (cap.day - s.usedDay <= 0) return 'DAY';
    return null;
  }

  /**
   * When this priority gets room again: just after the next 00:00 UTC for the day; for the month, the moment enough sent
   * e-mails leave the 31-day window. Null when it has room now. Rows being sent right now are not in the window list yet:
   * if they are what fills it, one minute.
   */
  async nextFreeAt(s: BudgetSnapshot, priority: EmailPriority, db: Db = this.prisma): Promise<Date | null> {
    const cap = this.limits.caps[priority];
    const times: number[] = [];
    if (s.usedDay >= cap.day) times.push(nextUtcMidnight(s.now).getTime() + DAY_RESET_SLACK_MS);
    if (s.usedMonth >= cap.month) times.push(await this.freesAt(db, s, MONTH_MS, s.usedMonth - cap.month));
    return times.length ? new Date(Math.max(...times)) : null;
  }

  /** The time the (k+1)-th oldest e-mail sent within `windowMs` leaves the window. */
  private async freesAt(db: Db, s: BudgetSnapshot, windowMs: number, k: number): Promise<number> {
    const since = new Date(s.now.getTime() - windowMs);
    const [mail, out] = await Promise.all([
      db.emailDelivery.findMany({ where: { status: 'SENT', attemptedAt: { gte: since } }, orderBy: { attemptedAt: 'asc' }, take: k + 1, select: { attemptedAt: true } }),
      db.notificationOutbox.findMany({ where: { status: 'SENT', sentAt: { gte: since } }, orderBy: { sentAt: 'asc' }, take: k + 1, select: { sentAt: true } }),
    ]);
    const sorted = [...mail.map((m) => m.attemptedAt!.getTime()), ...out.map((o) => o.sentAt!.getTime())].sort((a, b) => a - b);
    const oldest = sorted[k];
    return oldest === undefined ? s.now.getTime() + 60_000 : oldest + windowMs + 1_000;
  }

  /**
   * Runs `fn` in a transaction holding the budget lock, with a fresh snapshot: check the budget and claim inside it, so
   * two senders (or instances) can never both take the last slot.
   */
  withBudgetLock<T>(fn: (tx: Prisma.TransactionClient, s: BudgetSnapshot) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY})::bigint)`;
      return fn(tx, await this.snapshot(tx));
    }, { timeout: 30_000 });
  }

  /**
   * One e-mail of this priority, claimed by `claim` (inside the budget lock) only when the budget and the provider allow
   * it now; otherwise not claimed, with the time it may be tried again.
   */
  admit(priority: EmailPriority, claim: (tx: Prisma.TransactionClient) => Promise<boolean>):
    Promise<{ admitted: true; claimed: boolean } | { admitted: false; until: Date }> {
    return this.withBudgetLock(async (tx, s) => {
      const pause = await this.providerPause(tx, s.now);
      if (pause) return { admitted: false as const, until: pause.until };
      if (this.room(s, priority) === 0) {
        return { admitted: false as const, until: (await this.nextFreeAt(s, priority, tx)) ?? new Date(s.now.getTime() + 60_000) };
      }
      return { admitted: true as const, claimed: await claim(tx) };
    });
  }

  // ─── Provider pause (429) ────────────────────────────────────────────────────

  /** The active provider pause, or null. */
  async providerPause(db: Db = this.prisma, now = new Date()) {
    const row = await db.emailSendingState.findUnique({ where: { key: PROVIDER_KEY } });
    return row?.pausedUntil && row.pausedUntil > now ? { until: row.pausedUntil, reason: row.pauseReason as PauseReason, lastProviderError: row.lastProviderError } : null;
  }

  /** The last recorded provider answer (active or not), for the usage page. */
  private providerState() {
    return this.prisma.emailSendingState.findUnique({ where: { key: PROVIDER_KEY } });
  }

  /**
   * Record a provider limit answer; returns when sending may start again. Daily quota: just after the next 00:00 UTC
   * (when Resend resets it); monthly: 12–24 hours; rate limit: 60 seconds. It replaces the previous answer.
   */
  async pauseForProvider(limit: ProviderLimit, error: string | null, now = new Date()): Promise<Date> {
    let until: number;
    if (limit === 'RATE_LIMIT') {
      until = now.getTime() + RATE_PAUSE_MS;
    } else if (limit === 'DAILY_QUOTA') {
      until = nextUtcMidnight(now).getTime() + DAY_RESET_SLACK_MS;
    } else {
      const s = await this.snapshot(this.prisma, now);
      const frees = await this.freesAt(this.prisma, s, MONTH_MS, 0);
      until = Math.min(Math.max(frees, now.getTime() + MONTHLY_QUOTA_MIN_PAUSE_MS), now.getTime() + MONTHLY_QUOTA_MAX_PAUSE_MS);
    }
    const current = await this.providerPause(this.prisma, now);
    const pausedUntil = new Date(Math.max(until, current?.until.getTime() ?? 0));
    const reason = current && current.until.getTime() >= until ? current.reason : limit;
    const data = { pausedUntil, pauseReason: reason, lastProviderError: (error ?? '').slice(0, 500) || null };
    await this.prisma.emailSendingState.upsert({ where: { key: PROVIDER_KEY }, create: { key: PROVIDER_KEY, ...data }, update: data });
    this.logger.warn(`E-mail sending paused until ${pausedUntil.toISOString()} (${reason}).`);
    return pausedUntil;
  }

  /** The provider accepted an e-mail: a recorded pause is over (kept as the last answer for the usage page). */
  async providerAccepted() {
    await this.prisma.emailSendingState.updateMany({ where: { key: PROVIDER_KEY, pausedUntil: { not: null } }, data: { pausedUntil: null } });
  }

  // ─── Administrators: GET /admin/email/usage ──────────────────────────────────

  async usage(now = new Date()) {
    const s = await this.snapshot(this.prisma, now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const sentSince = async (since: Date) => (await Promise.all([
      this.prisma.emailDelivery.count({ where: { status: 'SENT', attemptedAt: { gte: since } } }),
      this.prisma.notificationOutbox.count({ where: { status: 'SENT', sentAt: { gte: since } } }),
    ])).reduce((a, b) => a + b, 0);

    const [last24h, thisMonth, queuedMail, queuedOutbox, failedMail, failedOutbox, discarded, discardedReasons, provider, recoverable] = await Promise.all([
      sentSince(new Date(now.getTime() - DAY_MS)),
      sentSince(monthStart),
      this.prisma.emailDelivery.groupBy({ by: ['priority'], where: { status: 'PENDING' }, _count: { _all: true } }),
      this.prisma.notificationOutbox.groupBy({
        by: ['type'], _count: { _all: true },
        where: { OR: [{ status: { in: ['PENDING', 'SENDING'] } }, { status: 'FAILED', nextAttemptAt: { not: null }, attempts: { lt: OUTBOX_MAX_ATTEMPTS } }] },
      }),
      this.prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
      this.prisma.notificationOutbox.count({ where: { status: 'FAILED', OR: [{ nextAttemptAt: null }, { attempts: { gte: OUTBOX_MAX_ATTEMPTS } }] } }),
      this.prisma.emailDelivery.count({ where: { status: 'DISCARDED' } }),
      this.prisma.emailDelivery.groupBy({
        by: ['errorMessage'], where: { status: 'DISCARDED' }, _count: { _all: true },
        orderBy: { _count: { errorMessage: 'desc' } }, take: 10,
      }),
      this.providerState(),
      this.quotaFailures(),
    ]);

    const queued: Record<EmailPriority, number> = { CRITICAL: 0, NORMAL: 0, BULK: 0 };
    // Rows queued before the priority column are classified by the worker within a minute; until then: NORMAL.
    for (const g of queuedMail) queued[g.priority ?? 'NORMAL'] += g._count._all;
    for (const g of queuedOutbox) queued[decisionPriority(g.type)] += g._count._all;

    const priorities = await Promise.all(PRIORITIES.map(async (p) => ({
      priority:  p,
      capDay:    finite(this.limits.caps[p].day),
      capMonth:  finite(this.limits.caps[p].month),
      remaining: this.room(s, p) === Number.MAX_SAFE_INTEGER ? null : this.room(s, p),
      blockedBy: this.blockedBy(s, p),
      nextFreeAt: await this.nextFreeAt(s, p),
      queued:    queued[p],
    })));

    const pause = provider?.pausedUntil && provider.pausedUntil > now ? provider : null;
    // Sending is held back by the budget when something waits that its priority may not send now.
    const held = priorities.find((p) => p.queued > 0 && p.remaining === 0);
    const left = (budget: number, used: number) => (budget === Infinity ? null : Math.max(0, budget - used));
    const status = pause
      ? { paused: true, reason: `PROVIDER_${pause.pauseReason ?? 'DAILY_QUOTA'}`, until: pause.pausedUntil }
      : held
        ? { paused: true, reason: held.blockedBy === 'MONTH' ? 'MONTHLY_LIMIT' : 'DAILY_LIMIT', until: held.nextFreeAt }
        : { paused: false, reason: null, until: null };
    const waiting = queued.CRITICAL + queued.NORMAL + queued.BULK;

    return {
      generatedAt: now,
      dryRun:      this.mailer.isDryRun,
      limits: {
        dailyLimit: this.limits.dailyLimit, monthlyLimit: this.limits.monthlyLimit,
        dailySafetyMargin: this.limits.dailySafetyMargin, monthlySafetyMargin: this.limits.monthlySafetyMargin,
        // null: no limit for that window.
        dailyBudget: finite(this.limits.dailyBudget), monthlyBudget: finite(this.limits.monthlyBudget),
        dayWindow: 'UTC_CALENDAR_DAY', monthWindow: 'ROLLING_31_DAYS',
        normalSharePercent: this.limits.normalSharePercent, bulkSharePercent: this.limits.bulkSharePercent,
      },
      // today: since 00:00 UTC (the daily budget); last31d: the monthly budget; the other two for information.
      sent: { today: s.sentDay, last31d: s.sentMonth, sendingNow: s.inFlight, last24h, thisMonthUtc: thisMonth },
      dayResetsAt: nextUtcMidnight(now),
      remaining: { today: left(this.limits.dailyBudget, s.usedDay), month: left(this.limits.monthlyBudget, s.usedMonth) },
      // The next moment the most urgent waiting e-mail can go (null: nothing is held back).
      nextFreeAt: status.until ?? null,
      priorities,
      queued: { ...queued, total: waiting },
      failed: { total: failedMail + failedOutbox, emails: failedMail, decisionNotices: failedOutbox },
      discarded: { total: discarded, reasons: discardedReasons.map((r) => ({ reason: r.errorMessage ?? 'Not sent.', count: r._count._all })) },
      status: {
        ...status,
        lastProviderError: provider?.lastProviderError ?? null,
        lastProviderPauseAt: provider?.updatedAt ?? null,
      },
      recoverableQuotaFailures: recoverable.emails.length + recoverable.notices.length,
    };
  }

  // ─── Recovery of e-mails that FAILED only because of a provider limit (before this release) ───────────────

  /**
   * FAILED rows whose only recorded failure is a provider limit answer (429: daily/monthly quota, rate limit) and that are
   * still meaningful: the recipient account still exists and is active; a bulk/mailing row's content still exists; an
   * application decision still stands. Account e-mails with a one-time link are re-queued too: the worker checks the link
   * again just before sending and discards it when it is dead.
   */
  async quotaFailures() {
    const mails = await this.prisma.emailDelivery.findMany({
      where:  { status: 'FAILED', errorMessage: { startsWith: QUOTA_ERROR_PREFIX } },
      select: { id: true, jobId: true, body: true, recipientId: true, subscriberId: true },
    });
    const notices = await this.prisma.notificationOutbox.findMany({
      where:  { status: 'FAILED', lastError: { startsWith: QUOTA_ERROR_PREFIX } },
      select: { id: true, type: true, recipientUserId: true, entityType: true, entityId: true },
    });
    const userIds = [...new Set([...mails.map((m) => m.recipientId), ...notices.map((n) => n.recipientUserId)].filter((id): id is string => !!id))];
    const active = new Set((await this.prisma.user.findMany({ where: { id: { in: userIds }, isActive: true }, select: { id: true } })).map((u) => u.id));
    const subscriberIds = mails.map((m) => m.subscriberId).filter((id): id is string => !!id);
    const subscribed = new Set((await this.prisma.subscriber.findMany({ where: { id: { in: subscriberIds }, status: 'ACTIVE' }, select: { id: true } })).map((s) => s.id));

    const emails = mails.filter((m) =>
      (m.jobId !== null || m.body !== null)
      && (m.recipientId === null || active.has(m.recipientId))
      && (m.subscriberId === null || subscribed.has(m.subscriberId)));
    const kept: string[] = [];
    for (const n of notices) {
      if (n.recipientUserId !== null && !active.has(n.recipientUserId)) continue;
      if (await this.decisionStands(n)) kept.push(n.id);
    }
    return { emails: emails.map((m) => m.id), notices: kept };
  }

  /** Whether the decision a notice reports is still in force. */
  private async decisionStands(n: { type: string; entityType: string; entityId: string }): Promise<boolean> {
    switch (n.type) {
      case 'teacher.application.approved':
        return (await this.prisma.teacherApplication.count({ where: { id: n.entityId, status: 'APPROVED' } })) > 0;
      case 'coach.application.approved':
        return (await this.prisma.mentorRequest.count({ where: { id: n.entityId, status: 'APPROVED' } })) > 0;
      case 'permissions.granted':
        return (await this.prisma.userPermissionOverride.count({ where: { id: n.entityId } })) > 0;
      case 'school.request.verified':
        return n.entityType === 'TeacherApplication'
          ? (await this.prisma.teacherApplication.count({ where: { id: n.entityId } })) > 0
          : (await this.prisma.studentSchoolAffiliation.count({ where: { id: n.entityId } })) > 0;
      default:
        return true;
    }
  }

  /** POST /admin/email/usage/recover: re-queue the rows above (attempts reset), audited. Idempotent. */
  async recoverQuotaFailures(caller: CallerCtx) {
    const { emails, notices } = await this.quotaFailures();
    if (emails.length === 0 && notices.length === 0) {
      throw new AppError(HttpStatus.CONFLICT, 'NOTHING_TO_RECOVER', 'No e-mail failed only because of the e-mail limit. There is nothing to send again.');
    }
    const note = 'Queued again: it had failed only because of the e-mail provider\'s limit.';
    const result = await this.prisma.$transaction(async (tx) => {
      // The status/error conditions are repeated: a row that changed meanwhile is left alone.
      const m = await tx.emailDelivery.updateMany({
        where: { id: { in: emails }, status: 'FAILED', errorMessage: { startsWith: QUOTA_ERROR_PREFIX } },
        data:  { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedAt: null, errorMessage: note },
      });
      const n = await tx.notificationOutbox.updateMany({
        where: { id: { in: notices }, status: 'FAILED', lastError: { startsWith: QUOTA_ERROR_PREFIX } },
        data:  { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: note },
      });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'RECOVER_QUOTA_FAILED_EMAILS', entity: 'EmailDelivery',
        metadata: { emails: m.count, decisionNotices: n.count },
      }, tx);
      return { emails: m.count, decisionNotices: n.count };
    });
    return { requeued: result.emails + result.decisionNotices, ...result };
  }
}
