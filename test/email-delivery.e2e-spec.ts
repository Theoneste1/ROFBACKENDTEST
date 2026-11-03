/**
 * Real SMTP delivery: the e-mail outbox is sent through Nodemailer to an SMTP
 * server running inside the test (no dry-run). Covers transactional e-mails
 * (password reset), bulk e-mails in every recipient mode, temporary failures
 * with retries, giving up after the maximum attempts, and an administrator's
 * retry of the failed deliveries.
 */
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { AddressInfo } from 'node:net';
import { EmailWorker, MAX_ATTEMPTS } from '../src/email/email.worker.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

interface Received { to: string[]; subject: string; text: string; from: string }

// The configuration is read when the app module is imported: switch e-mail
// from dry-run to SMTP before that. The port is filled in once the server runs.
vi.hoisted(() => {
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_SECURE: 'false', EMAIL_FROM: 'ROF Learning <noreply@rof.test>' });
});

describe('E-mail delivery over SMTP (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  let worker: EmailWorker;
  let server: SMTPServer;
  const inbox: Received[] = [];
  /** Recipients the server currently refuses (450, temporary). */
  const refuse = new Set<string>();

  const drain = async () => { while ((await worker.processBatch()) > 0) { /* keep sending */ } };
  const to = (address: string) => inbox.filter((m) => m.to.includes(address));

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      logger: false,
      onRcptTo(address, _session, cb) {
        if (refuse.has(address.address)) {
          const err = new Error('Mailbox temporarily unavailable') as Error & { responseCode: number };
          err.responseCode = 450;
          return cb(err);
        }
        cb();
      },
      onData(stream, _session, cb) {
        simpleParser(stream).then((mail) => {
          const addresses = [mail.to].flat().filter(Boolean).flatMap((a) => (a as { value: { address?: string }[] }).value.map((v) => v.address ?? ''));
          inbox.push({ to: addresses, subject: mail.subject ?? '', text: mail.text ?? '', from: mail.from?.text ?? '' });
          cb();
        }, cb);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.server.address() as AddressInfo;

    process.env.SMTP_PORT = String(port); // read when the SMTP transport starts
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    worker = ctx.app.get(EmailWorker);
  });

  afterAll(async () => {
    delete process.env.SMTP_HOST;
    await ctx?.app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers a password-reset e-mail with a working link and does not keep the link afterwards', async () => {
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.j@test.local' }).expect(200);
    await drain();

    const [mail] = to('student.j@test.local');
    expect(mail.subject).toContain('Reset your password');
    expect(mail.from).toContain('noreply@rof.test');
    const link = /http:\/\/localhost:5173\/reset-password\?token=(\S+)/.exec(mail.text);
    expect(link).toBeTruthy();

    const delivery = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'student.j@test.local' } });
    expect(delivery).toMatchObject({ status: 'SENT', body: null });
    expect(delivery.messageId).toBeTruthy();

    // The e-mailed link really resets the password.
    await ctx.http().post('/api/v1/auth/reset-password')
      .send({ token: decodeURIComponent(link![1]), newPassword: 'Reset!Passw0rd-2026' }).expect(200);
    await ctx.http().post('/api/v1/auth/login').send({ username: 'student.j', password: 'Reset!Passw0rd-2026' }).expect(200);
  });

  it('sends bulk e-mail to every recipient mode', async () => {
    const send = (key: string, body: Record<string, unknown>) => ctx.http().post('/api/v1/admin/email/send').set(bearer(admin))
      .send({ idempotencyKey: `smtp-${key}`, subject: `Bulk ${key}`, body: 'Hello from the test.', ...body });

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
      idempotencyKey: 'smtp-failing', recipientMode: 'EXPLICIT', recipientUserIds: [ctx.ids.mentorJunior, ctx.ids.mentorJunior2],
      subject: 'Partly failing', body: 'One of these bounces.',
    }).expect(201);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await drain();
      // Skip the back-off wait so the next attempt is due now.
      await ctx.prisma.emailDelivery.updateMany({ where: { jobId: job.body.id, status: 'PENDING' }, data: { nextAttemptAt: new Date(0) } });
    }
    const failed = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { jobId: job.body.id, recipientEmail: 'mentor.j2@test.local' } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    expect(failed.errorMessage).toMatch(/450|temporarily/i);
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

  it('the scheduled tick does nothing when workers are disabled on this instance', async () => {
    await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.s@test.local' }).expect(200);
    await worker.tick(); // WORKERS_ENABLED=false in the test environment
    expect(await ctx.prisma.emailDelivery.count({ where: { recipientEmail: 'student.s@test.local', status: 'PENDING' } })).toBe(1);
  });
});
