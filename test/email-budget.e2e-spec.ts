/**
 * E-mail within the Resend Free plan (owner decision 2026-11-24: 100 e-mails a day, 3,000 a month, never upgrade).
 *
 * The real defaults (EMAIL_DAILY_LIMIT 100, EMAIL_MONTHLY_LIMIT 3000, margins 5 / 100 → 95 / 2,900; NORMAL 80 %, BULK
 * 50 %) against a real database. The mailer is mocked (spied, dry run): no e-mail ever leaves the machine. Covered: the
 * daily and monthly budget (nothing sent, rows PENDING, attempts untouched), sending resuming by itself as the rolling
 * window moves, priority order and the CRITICAL reserve, dead links discarded (expired reset, already-activated account,
 * superseded reset), a fresh reset sent and usable, transient / permanent failures, provider quota deferrals, no
 * duplicate sends, decision notifications under the budget and the 429 bug, rows queued before this release, the
 * recovery of quota-failed rows, and GET /admin/email/usage (numbers, permissions).
 */
import type { MockInstance } from 'vitest';
import { createTestApp, login, bearer, pendingTeacherApplication, waitForEvents, type TestContext } from './helpers.js';
import { EmailWorker, MAX_ATTEMPTS } from '../src/email/email.worker.js';
import { MailerService, type OutgoingEmail, type SendResult } from '../src/email/mailer.service.js';
import { EmailBudgetService, DAY_MS, DAY_RESET_SLACK_MS, MONTH_MS, nextUtcMidnight, utcDayStart } from '../src/email/email-budget.service.js';
import { ActivationService } from '../src/auth/activation.service.js';
import { DecisionNotificationsService } from '../src/decision-notifications/decision-notifications.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../src/settings/settings.service.js';
import { DiscardReasons } from '../src/email/email-links.js';
import { hashToken } from '../src/auth/token.service.js';

vi.hoisted(() => {
  // The real Free-plan defaults (setup-env.ts gives the other suites a budget they never reach).
  Object.assign(process.env, {
    EMAIL_DAILY_LIMIT: '100', EMAIL_MONTHLY_LIMIT: '3000', EMAIL_DAILY_SAFETY_MARGIN: '', EMAIL_MONTHLY_SAFETY_MARGIN: '',
    EMAIL_NORMAL_SHARE_PERCENT: '', EMAIL_BULK_SHARE_PERCENT: '', TEACHERS_ENABLED: 'true',
  });
});

const HOUR = 3_600_000;
/** An age (ms) that is earlier TODAY in UTC — the daily budget is the UTC calendar day (up to 1 h ago, never yesterday). */
const today = () => Math.max(0, Math.min(HOUR, Date.now() - utcDayStart(new Date()).getTime() - 1_000));
/** Just after the next 00:00 UTC: when the daily budget resets. */
const dayReset = () => nextUtcMidnight(new Date()).getTime() + DAY_RESET_SLACK_MS;
const ACCEPTED: SendResult = { accepted: true, messageId: 'msg', error: null, permanent: false };

describe('E-mail within the Resend Free plan (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  let worker: EmailWorker;
  let budget: EmailBudgetService;
  let notices: DecisionNotificationsService;
  let send: MockInstance<MailerService['sendOne']>;
  const p = () => ctx.prisma;
  const sent = () => send.mock.calls.map((c) => c[0] as OutgoingEmail);
  const drain = async (w = worker) => { while ((await w.processBatch()) > 0) { /* keep sending */ } };

  /** `n` e-mails already sent `ageMs` ago (they fill the rolling windows). */
  const seedSent = async (n: number, ageMs: number) => {
    const attemptedAt = new Date(Date.now() - ageMs);
    for (let i = 0; i < n; i += 1000) {
      await p().emailDelivery.createMany({ data: Array.from({ length: Math.min(1000, n - i) }, () => ({
        recipientEmail: 'earlier@test.local', subject: 'Earlier', status: 'SENT' as const, attempts: 1, attemptedAt, kind: 'NOTIFICATION', priority: 'NORMAL' as const,
      })) });
    }
  };
  const notice = (to: string, subject = 'A notice') => p().emailDelivery.create({
    data: { recipientEmail: to, subject, body: 'Hello', html: '<p>Hello</p>', kind: 'NOTIFICATION', priority: 'NORMAL' },
  });
  const bulkJob = async (count: number) => {
    const job = await p().emailJob.create({ data: { idempotencyKey: `budget-${Date.now()}-${Math.random()}`, subject: 'Bulk news', body: 'News', status: 'PENDING', totalRecipients: count, createdById: ctx.ids.admin } });
    await p().emailDelivery.createMany({ data: Array.from({ length: count }, (_, i) => ({ jobId: job.id, recipientEmail: `bulk${i}@test.local`, kind: 'BULK_EMAIL', priority: 'BULK' as const })) });
    return job.id;
  };
  const forgot = (email: string) => ctx.http().post('/api/v1/auth/forgot-password').send({ email }).expect(200);
  const resetRows = (email: string) => p().emailDelivery.findMany({ where: { recipientEmail: email, kind: 'PASSWORD_RESET' }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    worker = ctx.app.get(EmailWorker);
    budget = ctx.app.get(EmailBudgetService);
    notices = ctx.app.get(DecisionNotificationsService);
    send = vi.spyOn(ctx.app.get(MailerService), 'sendOne');
  });

  beforeEach(async () => {
    await p().emailDelivery.deleteMany();
    await p().emailJob.deleteMany();
    await p().notificationOutbox.deleteMany();
    await p().emailSendingState.deleteMany();
    send.mockReset();
    send.mockResolvedValue(ACCEPTED);
    worker.wakeUp();
    (worker as unknown as { pausedUntil: number }).pausedUntil = 0;
  });

  afterAll(async () => {
    process.env.TEACHERS_ENABLED = '';
    await ctx?.app.close();
  });

  it('the defaults: 95 a day and 2,900 a month (limits 100 / 3,000 minus the safety margin), NORMAL 76, BULK 47', () => {
    expect(budget.limits).toMatchObject({ dailyLimit: 100, monthlyLimit: 3000, dailyBudget: 95, monthlyBudget: 2900 });
    expect(budget.limits.caps).toEqual({ CRITICAL: { day: 95, month: 2900 }, NORMAL: { day: 76, month: 2320 }, BULK: { day: 47, month: 1450 } });
  });

  it('daily budget reached: nothing more is sent; the e-mails stay PENDING with their attempts untouched; the worker sleeps until the window frees', async () => {
    await seedSent(95, today());
    await forgot('student.j@test.local');
    const n = await notice('student.s@test.local');
    await drain();
    expect(send).not.toHaveBeenCalled();
    const waiting = await p().emailDelivery.findMany({ where: { status: 'PENDING' } });
    expect(waiting).toHaveLength(2);
    for (const d of waiting) expect(d).toMatchObject({ attempts: 0, lockedAt: null });
    expect(waiting.find((d) => d.id === n.id)!.body).toBe('Hello');
    // The next slot: just after 00:00 UTC, when Resend's daily quota resets.
    expect(worker.budgetWait!.getTime()).toBe(dayReset());
    // Asleep: no claim is even tried before then.
    expect(await worker.processBatch()).toBe(0);
  });

  it('monthly budget reached: nothing is sent even with a fresh day', async () => {
    await seedSent(2900, 10 * DAY_MS);
    await forgot('student.j@test.local');
    await drain();
    expect(send).not.toHaveBeenCalled();
    expect(await p().emailDelivery.count({ where: { status: 'PENDING', attempts: 0 } })).toBe(1);
    const usage = (await ctx.http().get('/api/v1/admin/email/usage').set(bearer(admin)).expect(200)).body;
    expect(usage.sent).toMatchObject({ today: 0, last31d: 2900 });
    expect(usage.status).toMatchObject({ paused: true, reason: 'MONTHLY_LIMIT' });
    // The oldest of them leaves the rolling 31 days in 21 days.
    expect(new Date(usage.nextFreeAt).getTime()).toBeGreaterThan(Date.now() + MONTH_MS - 10 * DAY_MS - 60_000);
  });

  it('sending resumes by itself right after 00:00 UTC (the clock moved to the next UTC day)', async () => {
    await seedSent(95, today());
    // A notice (a reset link would rightly be discarded once the clock jumps hours ahead).
    const waiting = await notice('next.day@test.local');
    await drain();
    expect(send).not.toHaveBeenCalled();
    const wake = worker.budgetWait!.getTime();
    expect(wake).toBe(dayReset());
    // Before the reset nothing is tried; just after it the queue drains by itself (only the application clock moves:
    // the database keeps its own time, so due rows stay due).
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(wake - 1_000);
      expect(await worker.processBatch()).toBe(0);
      vi.setSystemTime(wake + 1_000);
      await drain();
    } finally {
      vi.useRealTimers();
    }
    expect(send).toHaveBeenCalledOnce();
    expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'SENT', attempts: 1 });
  });

  it('priority order: the most urgent e-mail is claimed first, even when it was queued last', async () => {
    // 75 used: NORMAL has one slot left (76), CRITICAL twenty.
    await seedSent(75, today());
    const older = [await notice('first@test.local'), await notice('second@test.local')];
    await forgot('student.j@test.local');
    await drain();
    // Claimed in queue order, a notice would have taken the last NORMAL slot; CRITICAL goes first and uses it.
    expect(sent().map((m) => m.to)).toEqual(['student.j@test.local']);
    for (const n of older) expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('the CRITICAL reserve: a mailing never uses the reserved part; a reset still goes out when only the reserve is left', async () => {
    await seedSent(46, today());
    const job = await bulkJob(5);
    for (let i = 0; i < 3; i++) await notice(`normal${i}@test.local`);
    await forgot('student.j@test.local');
    await drain();
    // CRITICAL (47 used) and NORMAL (50 used) go; BULK may only use the first 47 of the day: none of the five goes.
    expect(sent().map((m) => m.to).sort()).toEqual(['normal0@test.local', 'normal1@test.local', 'normal2@test.local', 'student.j@test.local']);
    expect(await p().emailDelivery.count({ where: { jobId: job, status: 'PENDING', attempts: 0 } })).toBe(5);

    // Only the reserve is left (80 used: above NORMAL's 76): a notice waits, a reset goes.
    await seedSent(30, today());
    send.mockClear();
    const waiting = await notice('normal9@test.local');
    await forgot('student.s@test.local');
    await drain();
    expect(sent().map((m) => m.to)).toEqual(['student.s@test.local']);
    expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('an expired reset link is discarded, never sent; the reason is plain and the link is wiped', async () => {
    await seedSent(95, today());
    await forgot('student.j@test.local');
    const [row] = await resetRows('student.j@test.local');
    // 31 minutes later: the token and the stored link expiry have passed while it waited for the budget.
    await p().passwordResetToken.update({ where: { id: row.linkTokenId! }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await p().emailDelivery.update({ where: { id: row.id }, data: { linkExpiresAt: new Date(Date.now() - 60_000) } });
    await p().emailDelivery.deleteMany({ where: { status: 'SENT' } });   // capacity is back
    worker.wakeUp();
    await drain();
    expect(send).not.toHaveBeenCalled();
    expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'DISCARDED', errorMessage: DiscardReasons.resetExpired, body: null, html: null,
    });
    expect(DiscardReasons.resetExpired).toMatch(/expired before it could be sent.*request a new link/);
  });

  it('a confirmation e-mail for an account an administrator already activated is discarded, not sent', async () => {
    const u = await p().user.create({ data: { username: 'late.confirm', firstName: 'Late', lastName: 'Confirm', email: 'late.confirm@test.local', role: 'MENTOR', passwordHash: 'x' } });
    await ctx.app.get(ActivationService).issueAndSend(u.id, 'EMAIL_VERIFICATION', null);
    const row = await p().emailDelivery.findFirstOrThrow({ where: { recipientId: u.id } });
    expect(row).toMatchObject({ kind: 'EMAIL_VERIFICATION', priority: 'CRITICAL', status: 'PENDING' });
    expect(row.linkTokenId).toBeTruthy();
    await p().user.update({ where: { id: u.id }, data: { activatedAt: new Date() } });
    await drain();
    expect(send).not.toHaveBeenCalled();
    expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'DISCARDED', errorMessage: DiscardReasons.activated, body: null });
  });

  it('a newer reset request supersedes the older unsent one; only the newest is sent, and its link works (30 minutes from sending)', async () => {
    await seedSent(95, today());
    await forgot('student.j2@test.local');
    await forgot('student.j2@test.local');
    const [older, newer] = await resetRows('student.j2@test.local');
    expect(older).toMatchObject({ status: 'DISCARDED', errorMessage: DiscardReasons.resetReplaced, body: null, html: null });
    expect(newer).toMatchObject({ status: 'PENDING' });

    // The budget frees; the newest is sent once.
    await p().emailDelivery.deleteMany({ where: { status: 'SENT' } });
    worker.wakeUp();
    const before = Date.now();
    await drain();
    expect(sent()).toHaveLength(1);
    const token = decodeURIComponent(/reset-password\?token=(\S+)/.exec(sent()[0].text)![1]);
    const stored = await p().passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(stored.id).toBe(newer.linkTokenId);
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1_000);
    await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Budget!Passw0rd-2026' }).expect(200);
    await ctx.http().post('/api/v1/auth/login').send({ username: 'student.j2', password: 'Budget!Passw0rd-2026' }).expect(200);
    // The answer to "forgot password" never says whether the account exists.
    const unknown = await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'nobody@test.local' }).expect(200);
    const known = await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.j@test.local' }).expect(200);
    expect(unknown.body).toEqual(known.body);
  });

  it('a temporary failure is retried with back-off and becomes FAILED after the maximum attempts, with a plain reason', async () => {
    send.mockResolvedValue({ accepted: false, messageId: null, error: 'Resend 500 internal_server_error: Temporarily unavailable', permanent: false });
    const n = await notice('retry@test.local');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await drain();
      const row = await p().emailDelivery.findUniqueOrThrow({ where: { id: n.id } });
      expect(row.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(row.status).toBe('PENDING');
        // 1, 2, 4, 8 minutes.
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000 * 2 ** (attempt - 1) - 5_000);
        await p().emailDelivery.update({ where: { id: n.id }, data: { nextAttemptAt: new Date(0) } });
      }
    }
    const failed = await p().emailDelivery.findUniqueOrThrow({ where: { id: n.id } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    expect(failed.errorMessage).toMatch(/^Not sent after 5 attempts\. Last error: Resend 500/);
    expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('a permanent failure (invalid address) fails at once', async () => {
    send.mockResolvedValue({ accepted: false, messageId: null, error: 'Resend 422 validation_error: Invalid `to` field.', permanent: true });
    const n = await notice('not-an-address@test.local');
    await drain();
    const row = await p().emailDelivery.findUniqueOrThrow({ where: { id: n.id } });
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(row.errorMessage).toMatch(/^Not sent: the e-mail provider refused this e-mail \(check the address\)\. Resend 422/);
  });

  it('a provider quota answer (429) defers without spending an attempt, never FAILED; the pause is shared and shown', async () => {
    send.mockResolvedValue({
      accepted: false, messageId: null, permanent: false, deferMs: HOUR, limit: 'DAILY_QUOTA',
      error: 'Resend 429 daily_quota_exceeded: You have reached your daily email sending quota.',
    });
    await forgot('student.j@test.local');
    for (let i = 0; i < 3; i++) {
      (worker as unknown as { pausedUntil: number }).pausedUntil = 0;
      await p().emailDelivery.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
      await drain();
    }
    const [row] = await resetRows('student.j@test.local');
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0, lockedAt: null });
    expect(row.body).toContain('reset-password?token=');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    const state = await p().emailSendingState.findUniqueOrThrow({ where: { key: 'provider' } });
    expect(state).toMatchObject({ pauseReason: 'DAILY_QUOTA' });
    const usage = (await ctx.http().get('/api/v1/admin/email/usage').set(bearer(admin)).expect(200)).body;
    expect(usage.status).toMatchObject({ paused: true, reason: 'PROVIDER_DAILY_QUOTA', lastProviderError: expect.stringContaining('daily_quota_exceeded') });
    // An accepted e-mail ends the shared pause.
    send.mockResolvedValue(ACCEPTED);
    (worker as unknown as { pausedUntil: number }).pausedUntil = 0;
    await p().emailDelivery.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
    await drain();
    expect((await resetRows('student.j@test.local'))[0]).toMatchObject({ status: 'SENT', attempts: 1 });
    expect((await p().emailSendingState.findUniqueOrThrow({ where: { key: 'provider' } })).pausedUntil).toBeNull();
  });

  it('no duplicate sends: two workers at once claim each row once; a crashed claim is taken again with the same idempotency key', async () => {
    for (let i = 0; i < 12; i++) await notice(`dup${i}@test.local`);
    const second = new EmailWorker(ctx.app.get(PrismaService), ctx.app.get(MailerService), ctx.app.get(ConfigService), ctx.app.get(SettingsService), budget);
    await Promise.all([drain(), drain(second)]);
    const keys = sent().map((m) => m.idempotencyKey);
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    expect(await p().emailDelivery.count({ where: { status: 'SENT', attempts: 1 } })).toBe(12);

    // A worker died after claiming (lock older than 5 minutes): the row is claimed again and sent with the SAME key.
    const crashed = await notice('crash@test.local');
    await p().emailDelivery.update({ where: { id: crashed.id }, data: { attempts: 1, lockedAt: new Date(Date.now() - 6 * 60_000) } });
    send.mockClear();
    await drain(second);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].idempotencyKey).toBe(`email-delivery/${crashed.id}`);
    expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: crashed.id } })).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  describe('decision notifications (NotificationOutbox)', () => {
    const outboxRow = (type = 'teacher.application.approved', over: Record<string, unknown> = {}) => p().notificationOutbox.create({ data: {
      type, dedupeKey: `${type}:${Math.random()}`, recipientEmail: 'decided@test.local', firstName: 'Decided',
      entityType: 'User', entityId: ctx.ids.admin, payload: { activated: true }, ...over,
    } });

    it('respect the budget: held PENDING (attempts untouched) while it is used up, sent once capacity returns — never lost', async () => {
      await seedSent(95, today());
      const row = await outboxRow('coach.application.approved');
      await expect(notices.dispatch(row.id)).resolves.toBe('DEFERRED');
      expect(send).not.toHaveBeenCalled();
      const held = await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
      expect(held).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(held.nextAttemptAt!.getTime()).toBe(dayReset());
      // The sweep does not touch it before then.
      expect((await notices.sweep(new Date())).processed).toBe(0);

      await p().emailDelivery.deleteMany({ where: { status: 'SENT' } });
      await p().notificationOutbox.update({ where: { id: row.id }, data: { nextAttemptAt: new Date() } });
      expect((await notices.sweep(new Date(Date.now() + 1_000))).sent).toBe(1);
      expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(sent()).toHaveLength(1);
    });

    it('count against the same budget as the outbox: decision e-mails sent today leave less room for account e-mails', async () => {
      await seedSent(90, today());
      for (let i = 0; i < 5; i++) await p().notificationOutbox.create({ data: {
        type: 'permissions.granted', dedupeKey: `seed:${i}`, recipientEmail: 'x@test.local', firstName: 'X', entityType: 'User', entityId: ctx.ids.admin,
        payload: {}, status: 'SENT', sentAt: new Date(Date.now() - today()), attempts: 1, nextAttemptAt: null,
      } });
      await forgot('student.j@test.local');
      await drain();
      expect(send).not.toHaveBeenCalled();
      const usage = (await ctx.http().get('/api/v1/admin/email/usage').set(bearer(admin)).expect(200)).body;
      expect(usage.sent.today).toBe(95);
    });

    it('a provider quota answer leaves the row PENDING with its attempts unchanged (the production bug), then it is sent', async () => {
      send.mockResolvedValueOnce({
        accepted: false, messageId: null, permanent: false, deferMs: HOUR, limit: 'DAILY_QUOTA',
        error: 'Resend 429 daily_quota_exceeded: You have reached your daily email sending quota.',
      });
      const row = await outboxRow();
      await expect(notices.dispatch(row.id)).resolves.toBe('DEFERRED');
      const held = await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
      expect(held).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(held.lastError).toMatch(/429 daily_quota_exceeded/);
      // While the provider pause lasts, nothing is even tried.
      await p().notificationOutbox.update({ where: { id: row.id }, data: { nextAttemptAt: new Date() } });
      await expect(notices.dispatch(row.id)).resolves.toBe('DEFERRED');
      expect(send).toHaveBeenCalledOnce();
      // The pause ends: sent exactly once.
      await p().emailSendingState.updateMany({ data: { pausedUntil: new Date(Date.now() - 1_000) } });
      await expect(notices.dispatch(row.id)).resolves.toBe('SENT');
      expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SENT', attempts: 1 });
    });
  });

  it('rows queued before this release (no kind, no expiry) are classified from their subject and createdAt', async () => {
    const legacy = async (data: Record<string, unknown>) => p().emailDelivery.create({ data: { body: 'Old body', html: '<p>Old</p>', ...data } as never });
    const activated = await p().user.create({ data: { username: 'legacy.active', firstName: 'L', lastName: 'A', email: 'legacy.active@test.local', role: 'MENTOR', passwordHash: 'x', activatedAt: new Date() } });
    const waiting = await p().user.create({ data: { username: 'legacy.wait', firstName: 'L', lastName: 'W', email: 'legacy.wait@test.local', role: 'MENTOR', passwordHash: 'x' } });
    const oneHourAgo = new Date(Date.now() - HOUR);
    const token = await p().accountActivationToken.create({ data: { userId: waiting.id, purpose: 'EMAIL_VERIFICATION', tokenHash: 'legacy-hash', expiresAt: new Date(oneHourAgo.getTime() + 48 * HOUR), createdAt: oneHourAgo } });

    const confirmActivated = await legacy({ recipientEmail: activated.email, recipientId: activated.id, subject: '[ROF LMS] Confirm your e-mail address', createdAt: oneHourAgo });
    const confirmWaiting = await legacy({ recipientEmail: waiting.email, recipientId: waiting.id, subject: '[ROF LMS] Confirm your e-mail address', createdAt: oneHourAgo });
    const oldReset = await legacy({ recipientEmail: 'test-reset@resend.dev', subject: '[ROF LMS] Reset your password', createdAt: new Date(Date.now() - 3 * HOUR) });
    const welcome = await legacy({ recipientEmail: 'welcome@resend.dev', subject: '[ROF LMS] Welcome to ROF LMS', createdAt: oneHourAgo });
    const teacher = await legacy({ recipientEmail: 'teacher@test.local', subject: '[ROF LMS] Your teacher application', createdAt: oneHourAgo });
    const subscribed = await legacy({ recipientEmail: 'sub@resend.dev', subject: 'You are subscribed to Rwanda Olympiad Foundation news', createdAt: oneHourAgo });

    await drain();
    const get = (id: string) => p().emailDelivery.findUniqueOrThrow({ where: { id } });
    expect(await get(confirmActivated.id)).toMatchObject({ kind: 'EMAIL_VERIFICATION', priority: 'CRITICAL', status: 'DISCARDED', errorMessage: DiscardReasons.activated, body: null });
    expect(await get(oldReset.id)).toMatchObject({ kind: 'PASSWORD_RESET', status: 'DISCARDED', errorMessage: DiscardReasons.resetExpired, body: null });
    expect(await get(confirmWaiting.id)).toMatchObject({ kind: 'EMAIL_VERIFICATION', status: 'SENT', linkTokenId: token.id });
    expect((await get(confirmWaiting.id)).linkExpiresAt!.getTime()).toBe(oneHourAgo.getTime() + 48 * HOUR);
    expect(await get(welcome.id)).toMatchObject({ kind: 'WELCOME', priority: 'NORMAL', status: 'SENT' });
    expect(await get(teacher.id)).toMatchObject({ kind: 'APPLICATION_DECISION', priority: 'NORMAL', status: 'SENT' });
    expect(await get(subscribed.id)).toMatchObject({ kind: 'SUBSCRIBER_WELCOME', priority: 'NORMAL', status: 'SENT' });
    expect(sent()).toHaveLength(4);
  });

  it('recovery: e-mails and decision notices that FAILED only because of the provider limit are re-queued once, if still meaningful (audited)', async () => {
    const quota = 'Resend 429 daily_quota_exceeded: You have reached your daily email sending quota.';
    // Teacher-registration notices are only sent while teacher self-registration is on (decision 10).
    await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': true }).expect(200);
    const school = (await p().school.create({ data: { name: 'Recovery School', code: '229901', nameKey: 'recovery school', location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } })).id;
    const body = (u: string) => ({ firstName: 'Rec', lastName: 'Teacher', username: u, email: `${u}@test.local`, schoolId: school, schoolProvince: 'Southern Province', schoolDistrict: 'Huye' });
    const standing = await pendingTeacherApplication(ctx, body('rec.t1'));
    const reversed = await pendingTeacherApplication(ctx, body('rec.t2'));
    await p().teacherApplication.update({ where: { id: standing }, data: { status: 'APPROVED' } });
    const lost = (entityId: string, email: string) => p().notificationOutbox.create({ data: {
      type: 'teacher.application.approved', dedupeKey: `lost:${entityId}`, recipientEmail: email, firstName: 'Rec',
      entityType: 'TeacherApplication', entityId, payload: { activated: true }, status: 'FAILED', attempts: 5, lastError: quota, nextAttemptAt: null,
    } });
    const keep = await lost(standing, 'rec.t1@test.local');
    const skip = await lost(reversed, 'rec.t2@test.local');                 // the application is no longer approved
    const otherFailure = await p().notificationOutbox.create({ data: {
      type: 'teacher.application.approved', dedupeKey: 'other', recipientEmail: 'o@test.local', firstName: 'O', entityType: 'TeacherApplication',
      entityId: standing, payload: { activated: true }, status: 'FAILED', attempts: 5, lastError: 'Resend 403 validation_error: domain not verified', nextAttemptAt: null,
    } });
    const mail = await p().emailDelivery.create({ data: { recipientEmail: 'student.s@test.local', recipientId: ctx.ids.studentSenior, subject: 'Kept', body: 'Hi', kind: 'NOTIFICATION', priority: 'NORMAL', status: 'FAILED', attempts: 5, errorMessage: quota } });
    const inactive = await p().user.create({ data: { username: 'rec.gone', firstName: 'G', lastName: 'G', email: 'rec.gone@test.local', role: 'MENTOR', passwordHash: 'x', isActive: false } });
    const gone = await p().emailDelivery.create({ data: { recipientEmail: inactive.email, recipientId: inactive.id, subject: 'Gone', body: 'Hi', status: 'FAILED', attempts: 5, errorMessage: quota } });

    const before = (await ctx.http().get('/api/v1/admin/email/usage').set(bearer(admin)).expect(200)).body;
    expect(before.recoverableQuotaFailures).toBe(2);
    const student = await login(ctx, 'student.j');
    await ctx.http().post('/api/v1/admin/email/usage/recover').set(bearer(student)).expect(403);
    const done = await ctx.http().post('/api/v1/admin/email/usage/recover').set(bearer(admin)).expect(201);
    expect(done.body).toEqual({ requeued: 2, emails: 1, decisionNotices: 1 });
    expect(await p().auditLog.count({ where: { action: 'RECOVER_QUOTA_FAILED_EMAILS' } })).toBe(1);
    expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
    for (const id of [skip.id, otherFailure.id]) expect((await p().notificationOutbox.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
    expect((await p().emailDelivery.findUniqueOrThrow({ where: { id: gone.id } })).status).toBe('FAILED');
    // Idempotent: nothing left to recover.
    expect((await ctx.http().post('/api/v1/admin/email/usage/recover').set(bearer(admin)).expect(409)).body.code).toBe('NOTHING_TO_RECOVER');

    await drain();
    await notices.sweep(new Date(Date.now() + 1_000));
    await waitForEvents();
    expect(await p().emailDelivery.findUniqueOrThrow({ where: { id: mail.id } })).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({ status: 'SENT' });
    expect(sent().filter((m) => m.to === 'rec.t1@test.local')).toHaveLength(1);
  });

  it('GET /admin/email/usage: the numbers, nothing secret; Administrators only (403 others, 401 anonymous)', async () => {
    await seedSent(62, today());
    await seedSent(10, 3 * DAY_MS);           // in the 31 days, not today
    for (let i = 0; i < 9; i++) await notice(`wait${i}@test.local`);
    await forgot('student.j@test.local');
    await forgot('student.s@test.local');
    await forgot('mentor.j@test.local');
    await p().emailDelivery.create({ data: { recipientEmail: 'x@test.local', subject: 'Dropped', status: 'DISCARDED', errorMessage: DiscardReasons.activated } });
    await p().emailDelivery.create({ data: { recipientEmail: 'y@test.local', subject: 'Broken', status: 'FAILED', attempts: 5, errorMessage: 'Not sent after 5 attempts.' } });

    const res = await ctx.http().get('/api/v1/admin/email/usage').set(bearer(admin)).expect(200);
    const u = res.body;
    expect(u.limits).toEqual({
      dailyLimit: 100, monthlyLimit: 3000, dailySafetyMargin: 5, monthlySafetyMargin: 100, dailyBudget: 95, monthlyBudget: 2900,
      dayWindow: 'UTC_CALENDAR_DAY', monthWindow: 'ROLLING_31_DAYS', normalSharePercent: 80, bulkSharePercent: 50,
    });
    expect(u.sent).toMatchObject({ today: 62, last31d: 72, sendingNow: 0 });
    expect(new Date(u.dayResetsAt).getTime()).toBe(nextUtcMidnight(new Date()).getTime());
    expect(u.remaining).toEqual({ today: 33, month: 2828 });
    expect(u.queued).toEqual({ CRITICAL: 3, NORMAL: 9, BULK: 0, total: 12 });
    expect(u.priorities.find((x: any) => x.priority === 'BULK')).toMatchObject({ capDay: 47, remaining: 0, blockedBy: 'DAY' });
    expect(u.priorities.find((x: any) => x.priority === 'NORMAL')).toMatchObject({ capDay: 76, remaining: 14, nextFreeAt: null });
    expect(u.status).toMatchObject({ paused: false, reason: null });
    expect(u.failed).toMatchObject({ total: 1, emails: 1, decisionNotices: 0 });
    expect(u.discarded).toEqual({ total: 1, reasons: [{ reason: DiscardReasons.activated, count: 1 }] });
    expect(u.dryRun).toBe(true);
    const raw = JSON.stringify(u);
    for (const secret of ['token=', 'Hello', '@test.local', 're_', 'body', 'html']) expect(raw).not.toContain(secret);

    for (const who of ['student.j', 'mentor.j']) {
      await ctx.http().get('/api/v1/admin/email/usage').set(bearer(await login(ctx, who))).expect(403);
    }
    await ctx.http().get('/api/v1/admin/email/usage').expect(401);
    await ctx.http().post('/api/v1/admin/email/usage/recover').expect(401);

    // Deliveries list: DISCARDED with its reason, and what each e-mail is.
    const list = await ctx.http().get('/api/v1/admin/email/deliveries').query({ status: 'DISCARDED' }).set(bearer(admin)).expect(200);
    expect(list.body.data[0]).toMatchObject({ status: 'DISCARDED', errorMessage: DiscardReasons.activated });
    const resets = await ctx.http().get('/api/v1/admin/email/deliveries').query({ status: 'PENDING' }).set(bearer(admin)).expect(200);
    expect(resets.body.data.find((d: any) => d.recipientEmail === 'student.j@test.local')).toMatchObject({ emailKind: 'PASSWORD_RESET', priority: 'CRITICAL', kind: 'TRANSACTIONAL' });
  });
});
