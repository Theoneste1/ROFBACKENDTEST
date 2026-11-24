import {
  DAY_MS, DAY_RESET_SLACK_MS, EmailBudgetService, MONTH_MS, MONTHLY_QUOTA_MAX_PAUSE_MS, MONTHLY_QUOTA_MIN_PAUSE_MS, nextUtcMidnight, utcDayStart,
  type BudgetSnapshot,
} from './email-budget.service.js';
import { RATE_PAUSE_MS } from './mailer.service.js';

const config = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] });
const mailer = { isDryRun: true };

/** A database with e-mails (EmailDelivery SENT) at the given times and nothing else. */
function db(sentAt: Date[] = []) {
  const inWindow = (gte: Date) => sentAt.filter((t) => t >= gte);
  return {
    emailDelivery: {
      count: vi.fn(async ({ where }: any) => (where.status === 'SENT' ? inWindow(where.attemptedAt.gte).length : 0)),
      findMany: vi.fn(async ({ where, take }: any) => inWindow(where.attemptedAt.gte).sort((a, b) => a.getTime() - b.getTime()).slice(0, take).map((t) => ({ attemptedAt: t }))),
    },
    notificationOutbox: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    emailSendingState: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
  };
}

const make = (env: Record<string, string> = {}, prisma: any = db()) =>
  new EmailBudgetService(prisma, config(env) as any, mailer as any, { log: vi.fn() } as any);

const snap = (usedDay: number, usedMonth = usedDay, now = new Date()): BudgetSnapshot =>
  ({ now, sentDay: usedDay, sentMonth: usedMonth, inFlight: 0, usedDay, usedMonth });

describe('EmailBudgetService (Resend Free plan)', () => {
  it('defaults: 100 a day and 3,000 a month, minus a 5 / 100 safety margin; NORMAL 80 %, BULK 50 % of the budget', () => {
    const { limits } = make();
    expect(limits).toMatchObject({ dailyLimit: 100, monthlyLimit: 3000, dailySafetyMargin: 5, monthlySafetyMargin: 100, dailyBudget: 95, monthlyBudget: 2900 });
    expect(limits.caps).toEqual({
      CRITICAL: { day: 95, month: 2900 },
      NORMAL:   { day: 76, month: 2320 },
      BULK:     { day: 47, month: 1450 },
    });
  });

  it('every number is configurable; nonsense falls back to the safe default; BULK never above NORMAL', () => {
    const { limits } = make({ EMAIL_DAILY_LIMIT: '200', EMAIL_DAILY_SAFETY_MARGIN: '10', EMAIL_MONTHLY_LIMIT: 'lots', EMAIL_NORMAL_SHARE_PERCENT: '60', EMAIL_BULK_SHARE_PERCENT: '90' });
    expect(limits).toMatchObject({ dailyBudget: 190, monthlyBudget: 2900, normalSharePercent: 60, bulkSharePercent: 60 });
    // A margin as large as the limit would leave nothing: at least one e-mail a day remains.
    expect(make({ EMAIL_DAILY_SAFETY_MARGIN: '500' }).limits.dailyBudget).toBe(1);
  });

  it('a limit of 0 means no limit for that window (Resend Pro: EMAIL_DAILY_LIMIT=0, EMAIL_MONTHLY_LIMIT=50000)', () => {
    const b = make({ EMAIL_DAILY_LIMIT: '0', EMAIL_MONTHLY_LIMIT: '50000' });
    expect(b.limits).toMatchObject({ dailyLimit: 0, dailyBudget: Infinity, monthlyBudget: 49900 });
    expect(b.room(snap(5000, 100), 'BULK')).toBe(Math.floor(49900 / 2) - 100);
    expect(b.blockedBy(snap(5000, 100), 'CRITICAL')).toBeNull();
    expect(b.room(snap(0, 49900), 'CRITICAL')).toBe(0);
    const none = make({ EMAIL_DAILY_LIMIT: '0', EMAIL_MONTHLY_LIMIT: '0' });
    expect(none.room(snap(10 ** 6), 'BULK')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('room per priority: BULK stops at 47, NORMAL at 76, CRITICAL at 95 e-mails a UTC day (the reserve)', () => {
    const b = make();
    expect(b.room(snap(0), 'BULK')).toBe(47);
    expect(b.room(snap(47), 'BULK')).toBe(0);
    expect(b.room(snap(47), 'NORMAL')).toBe(29);
    expect(b.room(snap(76), 'NORMAL')).toBe(0);
    expect(b.room(snap(76), 'CRITICAL')).toBe(19);
    expect(b.room(snap(95), 'CRITICAL')).toBe(0);
    expect(b.blockedBy(snap(95), 'CRITICAL')).toBe('DAY');
    // The 31-day window binds too.
    expect(b.room(snap(10, 2900), 'CRITICAL')).toBe(0);
    expect(b.blockedBy(snap(10, 2900), 'CRITICAL')).toBe('MONTH');
    expect(b.room(snap(10, 1450), 'BULK')).toBe(0);
    expect(b.room(snap(10, 1450), 'NORMAL')).toBe(66);
  });

  it('the day is the UTC calendar day: e-mails sent before 00:00 UTC do not count; the next slot is just after 00:00 UTC', async () => {
    const now = new Date('2026-11-24T21:30:00Z');   // 23:30 in Kigali
    const yesterday = new Date('2026-11-23T23:59:00Z');
    const today = new Date('2026-11-24T00:01:00Z');
    const b = make({}, db([...Array.from({ length: 50 }, () => yesterday), ...Array.from({ length: 95 }, () => today)]));
    const s = await b.snapshot(undefined, now);
    expect(s).toMatchObject({ sentDay: 95, sentMonth: 145 });
    expect(b.room(s, 'CRITICAL')).toBe(0);
    expect(await b.nextFreeAt(s, 'CRITICAL')).toEqual(new Date(Date.parse('2026-11-25T00:00:00Z') + DAY_RESET_SLACK_MS));
    expect(await b.nextFreeAt(snap(3), 'CRITICAL')).toBeNull();
    expect(utcDayStart(now)).toEqual(new Date('2026-11-24T00:00:00Z'));
    expect(nextUtcMidnight(now)).toEqual(new Date('2026-11-25T00:00:00Z'));
  });

  it('the month is a rolling 31 days (contains any calendar month or billing cycle): the next slot is when the oldest leaves it', async () => {
    const now = Date.now();
    const oldest = new Date(now - MONTH_MS + 5 * 3_600_000);
    const b = make({}, db([oldest, ...Array.from({ length: 2899 }, () => new Date(now - 10 * DAY_MS))]));
    const s = await b.snapshot(undefined, new Date(now));
    expect(s.sentMonth).toBe(2900);
    const next = (await b.nextFreeAt(s, 'CRITICAL'))!.getTime();
    expect(next).toBeGreaterThanOrEqual(oldest.getTime() + MONTH_MS);
    expect(next).toBeLessThan(oldest.getTime() + MONTH_MS + 5_000);
  });

  it('provider pauses: daily quota until just after 00:00 UTC, monthly 12-24 h, rate limit 60 s; never a secret', async () => {
    const now = new Date('2026-11-24T19:39:00Z');
    const prisma = db();
    const b = make({}, prisma);
    const daily = await b.pauseForProvider('DAILY_QUOTA', 'Resend 429 daily_quota_exceeded: quota', now);
    expect(daily).toEqual(new Date(Date.parse('2026-11-25T00:00:00Z') + DAY_RESET_SLACK_MS));
    expect(prisma.emailSendingState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ key: 'provider', pauseReason: 'DAILY_QUOTA', lastProviderError: 'Resend 429 daily_quota_exceeded: quota' }),
    }));
    const monthly = (await b.pauseForProvider('MONTHLY_QUOTA', null, now)).getTime();
    expect(monthly).toBeGreaterThanOrEqual(now.getTime() + MONTHLY_QUOTA_MIN_PAUSE_MS);
    expect(monthly).toBeLessThanOrEqual(now.getTime() + MONTHLY_QUOTA_MAX_PAUSE_MS);
    expect((await b.pauseForProvider('RATE_LIMIT', null, now)).getTime()).toBe(now.getTime() + RATE_PAUSE_MS);
  });
});
