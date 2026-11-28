/**
 * E-mail delivery through the real Resend SDK: the outbox is sent to a fake
 * Resend API running inside the test (RESEND_BASE_URL), so every request the
 * SDK makes — authentication, JSON payload, idempotency key — is checked
 * without sending real e-mail. Covers the transactional e-mails (password
 * reset, activation, welcome, password changed), bulk e-mails in every
 * recipient mode, temporary and permanent provider failures, giving up after
 * the maximum attempts, and an administrator's retry.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { EmailWorker, MAX_ATTEMPTS } from '../src/email/email.worker.js';
import { MailerService } from '../src/email/mailer.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

interface Received { to: string[]; subject: string; text: string; html: string; from: string; replyTo: string | null; key: string | null }

const API_KEY = 're_test_e2e_key';

// The configuration is read when the app module is imported: switch e-mail
// from dry-run to Resend before that. The fake API's URL is set once it runs.
vi.hoisted(() => {
  Object.assign(process.env, {
    RESEND_API_KEY: 're_test_e2e_key', EMAIL_MAX_PER_SECOND: '100', EMAIL_REDIRECT_TO: '',
    EMAIL_FROM: 'Rwanda Olympiad Foundation <info@rof.test>', EMAIL_REPLY_TO: 'info@rof.test',
  });
});

describe('E-mail delivery through Resend (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  let worker: EmailWorker;
  let server: Server;
  const inbox: Received[] = [];
  /** Recipients the fake API answers with a temporary (500) or permanent (422) error. */
  const refuse = new Set<string>();
  const invalid = new Set<string>();
  /** Idempotency keys already accepted → their e-mail id. */
  const accepted = new Map<string, string>();
  let unauthorized = 0;
  /** While set, the fake API answers sends with this 429 error name (at most limitBudget times). */
  let limit: string | null = null;
  let limitBudget = Number.POSITIVE_INFINITY;
  /** Sends the fake API refused with a 429, and every send request it received. */
  let limited = 0;
  let requests = 0;

  const drain = async () => { while ((await worker.processBatch()) > 0) { /* keep sending */ } };
  const to = (address: string) => inbox.filter((m) => m.to.includes(address));

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${API_KEY}`) {
          unauthorized++;
          return reply(401, { statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' });
        }
        if (req.method !== 'POST' || req.url !== '/emails') return reply(404, { statusCode: 404, name: 'not_found', message: 'Not found' });

        requests++;
        if (limit && limitBudget > 0) {
          limitBudget--; limited++;
          return reply(429, { statusCode: 429, name: limit, message: 'Limit reached' });
        }
        const mail = JSON.parse(raw) as { to: string | string[]; subject: string; text: string; html?: string; from: string; reply_to?: string };
        const recipients = [mail.to].flat();
        if (recipients.some((r) => invalid.has(r))) {
          return reply(422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' });
        }
        if (recipients.some((r) => refuse.has(r))) {
          return reply(500, { statusCode: 500, name: 'internal_server_error', message: 'Temporarily unavailable' });
        }
        const key = (req.headers['idempotency-key'] as string | undefined) ?? null;
        if (key && accepted.has(key)) return reply(200, { id: accepted.get(key) }); // same request: not sent again
        const id = `resend-${inbox.length + 1}`;
        if (key) accepted.set(key, id);
        inbox.push({ to: recipients, subject: mail.subject, text: mail.text, html: mail.html ?? '', from: mail.from, replyTo: mail.reply_to ?? null, key });
        reply(200, { id });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    process.env.RESEND_BASE_URL = `http://127.0.0.1:${port}`; // read when the Resend client is created
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    worker = ctx.app.get(EmailWorker);
  });

  afterAll(async () => {
    for (const k of ['RESEND_API_KEY', 'RESEND_BASE_URL', 'EMAIL_REPLY_TO', 'EMAIL_MAX_PER_SECOND']) process.env[k] = '';
    await ctx?.app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers a branded password-reset e-mail whose link works once, then a password-changed notice', async () => {
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.j@test.local' }).expect(200);
    await drain();

    const [mail] = to('student.j@test.local');
    expect(mail.subject).toContain('Reset your password');
    expect(mail.from).toBe('Rwanda Olympiad Foundation <info@rof.test>');
    expect(mail.replyTo).toBe('info@rof.test');
    expect(mail.key).toMatch(/^email-delivery\//);
    const link = /http:\/\/localhost:5173\/reset-password\?token=(\S+)/.exec(mail.text);
    expect(link).toBeTruthy();
    // HTML version: branding, button with the same link, validity.
    expect(mail.html).toContain('Rwanda Olympiad Foundation');
    expect(mail.html).toContain('Reset my password');
    expect(mail.html).toContain(`href="http://localhost:5173/reset-password?token=${link![1]}"`);
    expect(mail.html).toContain('30 minutes');
    expect(unauthorized).toBe(0);

    const delivery = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'student.j@test.local', subject: { contains: 'Reset' } } });
    expect(delivery).toMatchObject({ status: 'SENT', body: null, html: null, messageId: expect.stringMatching(/^resend-/) });

    // The e-mailed link really resets the password — once.
    const token = decodeURIComponent(link![1]);
    await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Reset!Passw0rd-2026' }).expect(200);
    await ctx.http().post('/api/v1/auth/login').send({ username: 'student.j', password: 'Reset!Passw0rd-2026' }).expect(200);
    const reused = await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Another!Passw0rd-1' }).expect(400);
    expect(reused.body.code).toBe('INVALID_RESET_TOKEN');

    await drain();
    const notice = to('student.j@test.local').find((m) => m.subject.includes('Your password was changed'));
    expect(notice).toBeDefined();
    expect(notice!.text).not.toContain('Reset!Passw0rd-2026');
  });

  it('refuses expired and unknown reset links', async () => {
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.s@test.local' }).expect(200);
    await drain();
    const mail = to('student.s@test.local').find((m) => m.subject.includes('Reset your password'))!;
    const token = decodeURIComponent(/reset-password\?token=(\S+)/.exec(mail.text)![1]);
    await ctx.prisma.passwordResetToken.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const expired = await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Expired!Passw0rd-1' }).expect(400);
    expect(expired.body.code).toBe('INVALID_RESET_TOKEN');
    const unknown = await ctx.http().post('/api/v1/auth/reset-password').send({ token: 'A'.repeat(43), newPassword: 'Unknown!Passw0rd-1' }).expect(400);
    expect(unknown.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('delivers an invitation whose activation link works, then a welcome e-mail', async () => {
    await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
      firstName: 'Aline', lastName: 'Mukamana', email: 'aline.invite@example.org', gradeLevel: 'S4',
      // An existing school (PR B: invitations never create one), as before a school of its own.
      schoolId: (await ctx.prisma.school.create({ data: { name: 'Groupe Scolaire Kigali', location: 'Kigali' } })).id,
    }).expect(201);
    await drain();

    const mail = to('aline.invite@example.org').find((m) => m.subject.includes('Activate your account'))!;
    expect(mail).toBeDefined();
    expect(mail.html).toContain('Activate my account');
    expect(mail.html).toContain('7 days');
    const token = decodeURIComponent(/\/activate\?token=(\S+)/.exec(mail.text)![1]);

    const info = await ctx.http().post('/api/v1/auth/activation/inspect').send({ token }).expect(200);
    expect(info.body).toMatchObject({ purpose: 'INVITATION', requiresPassword: true });
    await ctx.http().post('/api/v1/auth/activate').send({ token, password: 'Invited!Passw0rd-1' }).expect(200);
    await ctx.http().post('/api/v1/auth/login').send({ username: 'aline.invite', password: 'Invited!Passw0rd-1' }).expect(200);

    // Used links and unknown links are refused.
    const again = await ctx.http().post('/api/v1/auth/activate').send({ token, password: 'Invited!Passw0rd-2' }).expect(400);
    expect(again.body.code).toBe('INVALID_ACTIVATION_TOKEN');
    await ctx.http().post('/api/v1/auth/activation/inspect').send({ token: 'B'.repeat(43) }).expect(400);

    await drain();
    const welcome = to('aline.invite@example.org').find((m) => m.subject.includes('Welcome'));
    expect(welcome?.html).toContain('aline.invite');
  });

  it('marks an e-mail the provider rejects as invalid FAILED at once, without retrying', async () => {
    invalid.add('mentor.s@test.local');
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'mentor.s@test.local' }).expect(200);
    await drain();
    const failed = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'mentor.s@test.local' }, orderBy: { createdAt: 'desc' } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1, body: null, html: null });
    expect(failed.errorMessage).toMatch(/422 validation_error/);
    invalid.clear();
  });

  it('administrators list failed deliveries of every kind; one-time-link e-mails are not re-sent, others are', async () => {
    const all = await ctx.http().get('/api/v1/admin/email/deliveries').query({ status: 'FAILED', kind: 'TRANSACTIONAL' }).set(bearer(admin)).expect(200);
    const resetFailure = all.body.data.find((d: any) => d.recipientEmail === 'mentor.s@test.local');
    expect(resetFailure).toMatchObject({ status: 'FAILED', kind: 'TRANSACTIONAL', jobId: null, attempts: 1 });
    for (const d of all.body.data) for (const key of ['body', 'html']) expect(key in d).toBe(false);
    // The reset link was not kept: refused with guidance, nothing re-queued.
    const refused = await ctx.http().post(`/api/v1/admin/email/deliveries/${resetFailure.id}/retry`).set(bearer(admin)).expect(409);
    expect(refused.body.code).toBe('CONTENT_NOT_KEPT');
    expect((await ctx.prisma.emailDelivery.findUniqueOrThrow({ where: { id: resetFailure.id } })).status).toBe('FAILED');

    // A failed e-mail whose content is kept (no one-time link) is re-queued once and then sent.
    const kept = await ctx.prisma.emailDelivery.create({ data: {
      recipientEmail: 'student.j@test.local', subject: 'Kept notice', body: 'Hello', status: 'FAILED', attempts: 5, errorMessage: 'gave up',
    } });
    await ctx.http().post(`/api/v1/admin/email/deliveries/${kept.id}/retry`).set(bearer(admin)).expect(201);
    await ctx.http().post(`/api/v1/admin/email/deliveries/${kept.id}/retry`).set(bearer(admin)).expect(409); // already queued
    await drain();
    expect((await ctx.prisma.emailDelivery.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe('SENT');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'RETRY_EMAIL_DELIVERY', entityId: kept.id } })).toBe(1);

    await ctx.http().get('/api/v1/admin/email/deliveries').query({ kind: 'OTHER' }).set(bearer(admin)).expect(400);
    const student = await login(ctx, 'student.j2');
    await ctx.http().get('/api/v1/admin/email/deliveries').set(bearer(student)).expect(403);
  });

  it('sends bulk e-mail to every recipient mode', async () => {
    const send = (key: string, body: Record<string, unknown>) => ctx.http().post('/api/v1/admin/email/send').set(bearer(admin))
      .send({ idempotencyKey: `resend-${key}`, subject: `Bulk ${key}`, body: 'Hello from the test.', ...body });

    const explicit = await send('explicit', { recipientMode: 'EXPLICIT', recipientUserIds: [ctx.ids.studentJunior2, ctx.ids.mentorSenior] }).expect(201);
    expect(explicit.body.totalRecipients).toBe(2);
    const role = await send('role', { recipientMode: 'ROLE', recipientRole: 'MENTOR' }).expect(201);
    expect(role.body.totalRecipients).toBe(3);
    const school = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.studentSenior } })).schoolId!;
    const bySchool = await send('school', { recipientMode: 'SCHOOL', recipientSchoolId: school }).expect(201);
    expect(bySchool.body.totalRecipients).toBe(3);
    const all = await send('all', { recipientMode: 'ALL' }).expect(201);
    expect(all.body.totalRecipients).toBe(await ctx.prisma.user.count({ where: { isActive: true, isApproved: true } }));

    await drain();
    expect(inbox.filter((m) => m.subject.endsWith('Bulk explicit')).flatMap((m) => m.to).sort())
      .toEqual(['mentor.s@test.local', 'student.j2@test.local']);
    expect(inbox.filter((m) => m.subject.endsWith('Bulk role')).length).toBe(3);
    // Each person is greeted by first name (owner 2026-11-27), in the text and the HTML.
    for (const [to, id] of [['mentor.s@test.local', ctx.ids.mentorSenior], ['student.j2@test.local', ctx.ids.studentJunior2]] as const) {
      const first = (await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).firstName;
      const mail = inbox.find((m) => m.subject.endsWith('Bulk explicit') && m.to.includes(to))!;
      expect(mail.text.startsWith(`Hello ${first},`)).toBe(true);
      expect(mail.html).toContain(`Hello ${first},`);
    }
    const job = await ctx.http().get(`/api/v1/admin/email/jobs/${all.body.id}`).set(bearer(admin)).expect(200);
    expect(job.body).toMatchObject({ status: 'COMPLETED', failedCount: 0, sentCount: all.body.totalRecipients });

    // Invalid selections are refused.
    const unknown = await send('unknown', { recipientMode: 'EXPLICIT', recipientUserIds: ['00000000-0000-4000-8000-000000000000'] }).expect(400);
    expect(unknown.body.code).toBe('RECIPIENTS_NOT_FOUND');
    const emptySchool = await ctx.prisma.school.create({ data: { name: 'Empty School', location: 'Huye' } });
    const none = await send('none', { recipientMode: 'SCHOOL', recipientSchoolId: emptySchool.id }).expect(400);
    expect(none.body.code).toBe('NO_RECIPIENTS');
    await send('nodiv', { recipientMode: 'DIVISION', recipientDivisionId: '00000000-0000-4000-8000-000000000000' }).expect(404);
  });

  it('retries temporary failures, gives up after the maximum attempts, and an administrator can retry', async () => {
    refuse.add('mentor.j2@test.local');
    const job = await ctx.http().post('/api/v1/admin/email/send').set(bearer(admin)).send({
      idempotencyKey: 'resend-failing', recipientMode: 'EXPLICIT', recipientUserIds: [ctx.ids.mentorJunior, ctx.ids.mentorJunior2],
      subject: 'Partly failing', body: 'One of these bounces.',
    }).expect(201);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await drain();
      // Skip the back-off wait so the next attempt is due now.
      await ctx.prisma.emailDelivery.updateMany({ where: { jobId: job.body.id, status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
    }
    const failed = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { jobId: job.body.id, recipientEmail: 'mentor.j2@test.local' } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    expect(failed.errorMessage).toMatch(/500|temporarily/i);
    const partial = await ctx.http().get(`/api/v1/admin/email/jobs/${job.body.id}`).set(bearer(admin)).expect(200);
    expect(partial.body).toMatchObject({ status: 'PARTIAL_FAILURE', sentCount: 1, failedCount: 1 });
    expect(to('mentor.j@test.local').some((m) => m.subject.endsWith('Partly failing'))).toBe(true);

    // The mailbox works again; the administrator retries only the failed delivery.
    refuse.clear();
    const retry = await ctx.http().post(`/api/v1/admin/email/jobs/${job.body.id}/retry`).set(bearer(admin)).expect(201);
    expect(retry.body.requeued).toBe(1);
    await drain();
    const done = await ctx.http().get(`/api/v1/admin/email/jobs/${job.body.id}`).set(bearer(admin)).expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', sentCount: 2, failedCount: 0 });
    expect(to('mentor.j@test.local').filter((m) => m.subject.endsWith('Partly failing'))).toHaveLength(1); // not sent twice
    expect(to('mentor.j2@test.local').filter((m) => m.subject.endsWith('Partly failing'))).toHaveLength(1);
  });

  it('a provider quota defers the queue without spending attempts; one-time links survive and are sent later', async () => {
    limit = 'daily_quota_exceeded';
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'mentor.j2@test.local' }).expect(200);
    const sentBefore = to('mentor.j2@test.local').length;
    await drain();
    const held = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'mentor.j2@test.local', jobId: null }, orderBy: { createdAt: 'desc' } });
    expect(held).toMatchObject({ status: 'PENDING', attempts: 0, lockedAt: null });
    expect(held.body).toContain('reset-password?token=');       // the one-time link is kept until it is sent
    expect(held.errorMessage).toMatch(/429 daily_quota_exceeded/);
    expect(held.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(worker.paused).toBe(true);
    expect(await worker.processBatch()).toBe(0);                 // nothing is claimed while paused

    // The quota resets: the pause ends and the queue drains normally, once.
    limit = null;
    (worker as unknown as { pausedUntil: number }).pausedUntil = 0;
    await ctx.prisma.emailDelivery.update({ where: { id: held.id }, data: { nextAttemptAt: new Date(0) } });
    await drain();
    const sent = await ctx.prisma.emailDelivery.findUniqueOrThrow({ where: { id: held.id } });
    expect(sent).toMatchObject({ status: 'SENT', attempts: 1, body: null });
    expect(to('mentor.j2@test.local').length).toBe(sentBefore + 1);
  });

  // ── Provider limits under stress ──────────────────────────────────────────────────────────────
  /** A worker as after a process restart: a fresh instance (no in-memory pause), same services. */
  const restartedWorker = () => new EmailWorker(
    ctx.app.get(PrismaService), ctx.app.get(MailerService), ctx.app.get(ConfigService), ctx.app.get(SettingsService),
  );
  const pauseOver = async (w: EmailWorker, ids: string[]) => {
    (w as unknown as { pausedUntil: number }).pausedUntil = 0;
    await ctx.prisma.emailDelivery.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: new Date(0) } });
  };
  const drainWith = async (w: EmailWorker) => { while ((await w.processBatch()) > 0) { /* keep sending */ } };

  it('repeated quota answers over several windows and a worker restart: activation and reset links are kept, never FAILED, then each sent exactly once', async () => {
    limit = 'daily_quota_exceeded'; limitBudget = Number.POSITIVE_INFINITY;
    const school = (await ctx.prisma.school.create({ data: { name: 'Quota Test School', location: 'Huye', source: 'ADMIN' } })).id;
    await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
      firstName: 'Quota', lastName: 'Invitee', email: 'quota.invite@example.org', gradeLevel: 'S3', schoolId: school,
    }).expect(201);
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.j@test.local' }).expect(200);
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.j2@test.local' }).expect(200);
    const rows = await ctx.prisma.emailDelivery.findMany({
      where: { recipientEmail: { in: ['quota.invite@example.org', 'student.j@test.local', 'student.j2@test.local'] }, status: 'PENDING', jobId: null },
    });
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.id);
    const inboxBefore = inbox.length;

    // Four quota windows in a row: every attempt is answered 429; nothing is spent, lost or sent.
    for (let window = 1; window <= 4; window++) {
      await pauseOver(worker, ids);
      await drainWith(worker);
      const now = await ctx.prisma.emailDelivery.findMany({ where: { id: { in: ids } } });
      for (const d of now) {
        expect(d).toMatchObject({ status: 'PENDING', attempts: 0, lockedAt: null });
        expect(d.body).toMatch(/activate|reset-password\?token=/);     // one-time links still stored
        expect(d.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
      }
      expect(worker.paused).toBe(true);
    }
    expect(inbox.length).toBe(inboxBefore);

    // A restart forgets the in-memory pause, but the rows keep their next attempt: nothing is claimed early.
    const fresh = restartedWorker();
    expect(fresh.paused).toBe(false);
    expect(await fresh.processBatch()).toBe(0);

    // The quota resets: the restarted worker delivers each e-mail exactly once.
    limit = null;
    await pauseOver(fresh, ids);
    await drainWith(fresh);
    const done = await ctx.prisma.emailDelivery.findMany({ where: { id: { in: ids } } });
    for (const d of done) expect(d).toMatchObject({ status: 'SENT', attempts: 1, body: null, html: null });
    for (const who of ['quota.invite@example.org', 'student.j@test.local', 'student.j2@test.local']) {
      expect(inbox.slice(inboxBefore).filter((m) => m.to.includes(who))).toHaveLength(1);
    }
    // The activation link that waited through the quota still works.
    const mail = inbox.slice(inboxBefore).find((m) => m.to.includes('quota.invite@example.org'))!;
    const token = /token=([A-Za-z0-9_-]{20,})/.exec(mail.text)![1];
    await ctx.http().post('/api/v1/auth/activation/inspect').send({ token }).expect(200);
  });

  it('a per-second rate limit (429) pauses sending for 60 s; the rest of the batch is not even tried; then each is sent once', async () => {
    limit = 'rate_limit_exceeded'; limitBudget = Number.POSITIVE_INFINITY; limited = 0;
    // More than one in-flight group (the worker sends 5 at a time): 8 queued reset e-mails.
    for (const email of ['mentor.j@test.local', 'student.s@test.local', 'mentor.j2@test.local', 'student.j@test.local']) {
      for (let i = 0; i < 2; i++) await ctx.http().post('/api/v1/auth/forgot-password').send({ email }).expect(200);
    }
    const rows = await ctx.prisma.emailDelivery.findMany({ where: { status: 'PENDING', jobId: null, subject: { contains: 'password' } } });
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const ids = rows.map((r) => r.id);
    const requestsBefore = requests;
    await pauseOver(worker, ids);
    await drainWith(worker);
    // Only the first in-flight group reached the provider; every later group was released untried.
    expect(limited).toBeGreaterThanOrEqual(1);
    expect(limited).toBeLessThanOrEqual(5);
    const held = await ctx.prisma.emailDelivery.findMany({ where: { id: { in: ids } } });
    for (const d of held) {
      expect(d).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(d.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect(d.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 61_000 + 5_000);
    }
    expect(requests - requestsBefore).toBe(limited);

    limit = null;
    const inboxBefore = inbox.length;
    await pauseOver(worker, ids);
    await drainWith(worker);
    const done = await ctx.prisma.emailDelivery.findMany({ where: { id: { in: ids } } });
    for (const d of done) expect(d).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(inbox.length - inboxBefore).toBe(ids.length);
  });

  it('a crash after the provider accepted an e-mail but before the outbox recorded it does not send it twice', async () => {
    // Start from an empty queue (earlier tests may have re-queued mail for this address).
    await ctx.prisma.emailDelivery.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
    await drain();
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'mentor.s@test.local' }).expect(200);
    const d = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'mentor.s@test.local', status: 'PENDING', jobId: null }, orderBy: { createdAt: 'desc' } });
    expect(await ctx.prisma.emailDelivery.count({ where: { status: 'PENDING' } })).toBe(1);
    const before = to('mentor.s@test.local').length;
    // The crashed worker: it claimed the row, sent it (accepted), and died before recording SENT.
    await ctx.app.get(MailerService).sendOne({ to: d.recipientEmail, subject: d.subject!, text: d.body!, html: d.html, idempotencyKey: `email-delivery/${d.id}` });
    await ctx.prisma.emailDelivery.update({ where: { id: d.id }, data: { attempts: 1, lockedAt: new Date(Date.now() - 6 * 60_000) } });
    expect(to('mentor.s@test.local').length).toBe(before + 1);
    // After the 5-minute lock expiry a restarted worker takes it again: same idempotency key → not sent again.
    await drainWith(restartedWorker());
    const after = await ctx.prisma.emailDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(after).toMatchObject({ status: 'SENT', attempts: 2, body: null });
    expect(to('mentor.s@test.local').length).toBe(before + 1);
  });

  it('the scheduled tick does nothing when workers are disabled on this instance', async () => {
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.s@test.local' }).expect(200);
    await worker.tick(); // WORKERS_ENABLED=false in the test environment
    expect(await ctx.prisma.emailDelivery.count({ where: { recipientEmail: 'student.s@test.local', status: 'PENDING' } })).toBe(1);
  });
});
