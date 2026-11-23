/**
 * News subscribers and mailings (owner 2026-11-23):
 *   POST /public/subscribe, /public/unsubscribe, /public/unsubscribe/one-click — public, rate-limited
 *   /admin/subscribers… — subscribers.manage (Administrators, Super Admins)
 *
 * The outbox is sent to a fake Resend API inside the test (as in email-delivery.e2e-spec.ts), so the rendered mailing,
 * its unsubscribe link and the List-Unsubscribe headers are checked exactly as the provider receives them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EmailWorker } from '../src/email/email.worker.js';
import { PublicSubscribersController } from '../src/subscribers/subscribers.controller.js';
import { SUBSCRIBE_ANSWER } from '../src/subscribers/subscribers.service.js';
import { MAILING_SEND_DELAY_MS, unsubscribeToken } from '../src/subscribers/subscriber-rules.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

interface Received { to: string[]; subject: string; text: string; html: string; headers: Record<string, string> }

vi.hoisted(() => {
  Object.assign(process.env, {
    RESEND_API_KEY: 're_test_subscribers', EMAIL_MAX_PER_SECOND: '100', EMAIL_REDIRECT_TO: '',
    EMAIL_FROM: 'Rwanda Olympiad Foundation <info@rof.test>', EMAIL_REPLY_TO: 'info@rof.test',
    API_PUBLIC_URL: 'https://api.rof.test',
  });
});

describe('News subscribers (e2e)', () => {
  let ctx: TestContext;
  let server: Server;
  let worker: EmailWorker;
  let admin: string, superAdmin: string, teacher: string, coach: string, headCoach: string, student: string;
  const inbox: Received[] = [];
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const A = '/api/v1/admin/subscribers';
  const SECRET = 'e2e-test-secret-that-is-long-enough-123456';   // test/setup-env.ts JWT_SECRET
  const drain = async () => { while ((await worker.processBatch()) > 0) { /* keep sending */ } };
  /** Mailing deliveries wait MAILING_SEND_DELAY_MS; the tests make them due at once. */
  const dueNow = () => p().emailDelivery.updateMany({ where: { status: 'PENDING' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const sub = (email: string) => p().subscriber.findUniqueOrThrow({ where: { email } });
  const audits = (action: string) => p().auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/emails') return res.writeHead(404).end('{}');
        const mail = JSON.parse(raw) as { to: string | string[]; subject: string; text: string; html?: string; headers?: Record<string, string> };
        inbox.push({ to: [mail.to].flat(), subject: mail.subject, text: mail.text, html: mail.html ?? '', headers: mail.headers ?? {} });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `resend-${inbox.length}` }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.RESEND_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    worker = ctx.app.get(EmailWorker);
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    for (const [username, role] of [['subs.teacher', 'TEACHER'], ['subs.hc', 'HEAD_COACH'], ['subs.super', 'SUPER_ADMIN']] as const) {
      await p().user.create({ data: { username, firstName: 'S', lastName: role, email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
    }
    [admin, superAdmin, teacher, coach, headCoach, student] = await Promise.all(
      ['admin', 'subs.super', 'subs.teacher', 'mentor.j', 'subs.hc', 'student.j'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    for (const k of ['RESEND_API_KEY', 'RESEND_BASE_URL', 'EMAIL_REPLY_TO', 'EMAIL_MAX_PER_SECOND', 'EMAIL_FROM', 'API_PUBLIC_URL']) process.env[k] = '';
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('POST /public/subscribe', () => {
    it('a new address: 202, stored normalised (source WEBSITE), audited, and a welcome e-mail with the unsubscribe link', async () => {
      const res = await http().post('/api/v1/public/subscribe')
        .send({ email: '  Parent.One@Example.ORG ', fullName: 'Grace Parent', kind: 'PARENT', interests: ['PHYSICS', 'MATHEMATICS'], country: 'rw' })
        .expect(202);
      expect(res.body).toEqual(SUBSCRIBE_ANSWER);
      const row = await sub('parent.one@example.org');
      expect(row).toMatchObject({ fullName: 'Grace Parent', kind: 'PARENT', interests: ['MATHEMATICS', 'PHYSICS'], country: 'RW', source: 'WEBSITE', status: 'ACTIVE', userId: null });
      expect((await audits('SUBSCRIBER_SUBSCRIBED')).map((a) => a.entityId)).toEqual([row.id]);

      await drain();
      const [welcome] = inbox.filter((m) => m.to.includes('parent.one@example.org'));
      expect(welcome.subject).toBe('You are subscribed to Rwanda Olympiad Foundation news');
      expect(welcome.text).toContain('Hello Grace,');
      const link = `http://localhost:5173/unsubscribe?s=${row.id}&t=${unsubscribeToken(SECRET, row.id)}`;
      expect(welcome.text).toContain(`Unsubscribe: ${link}`);
      expect(welcome.headers).toEqual({
        'List-Unsubscribe': `<https://api.rof.test/api/v1/public/unsubscribe/one-click?s=${row.id}&t=${unsubscribeToken(SECRET, row.id)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('links the account with the same e-mail (informative only)', async () => {
      await http().post('/api/v1/public/subscribe').send({ email: 'STUDENT.J@test.local' }).expect(202);
      expect((await sub('student.j@test.local')).userId).toBe(ctx.ids.studentJunior);
    });

    it('no enumeration: an address already listed gets exactly the same answer; nothing is overwritten, no second welcome', async () => {
      const before = await sub('parent.one@example.org');
      const welcomes = await p().emailDelivery.count({ where: { subscriberId: before.id } });
      const res = await http().post('/api/v1/public/subscribe')
        .send({ email: 'parent.one@example.org', fullName: 'Somebody Else', kind: 'SCHOOL', interests: ['COMPUTING'] }).expect(202);
      expect(res.body).toEqual(SUBSCRIBE_ANSWER);
      const after = await sub('parent.one@example.org');
      expect(after).toMatchObject({ fullName: 'Grace Parent', kind: 'PARENT', interests: ['COMPUTING', 'MATHEMATICS', 'PHYSICS'], status: 'ACTIVE' });
      expect(await p().emailDelivery.count({ where: { subscriberId: before.id } })).toBe(welcomes);
      expect(await p().subscriber.count({ where: { email: 'parent.one@example.org' } })).toBe(1);
    });

    it('validation: a bad e-mail, unknown interest, kind or country, or an unknown field is refused (400)', async () => {
      for (const body of [
        { email: 'not-an-email' }, {}, { email: 'a@b.rw', interests: ['CHEMISTRY'] }, { email: 'a@b.rw', kind: 'ALIEN' },
        { email: 'a@b.rw', country: 'XX' }, { email: 'a@b.rw', fullName: 'A' }, { email: 'a@b.rw', isAdmin: true },
      ]) {
        expect([body, (await http().post('/api/v1/public/subscribe').send(body)).status]).toEqual([body, 400]);
      }
      expect(await p().subscriber.count({ where: { email: 'a@b.rw' } })).toBe(0);
    });

    it('the honeypot: same answer, nothing stored, nothing sent', async () => {
      const res = await http().post('/api/v1/public/subscribe').send({ email: 'bot@spam.test', website: 'http://spam' }).expect(202);
      expect(res.body).toEqual(SUBSCRIBE_ANSWER);
      expect(await p().subscriber.count({ where: { email: 'bot@spam.test' } })).toBe(0);
    });

    it('is rate-limited per IP (10 per hour); unsubscribe 30 per hour', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', PublicSubscribersController.prototype.subscribe)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', PublicSubscribersController.prototype.subscribe)).toBe(60 * 60_000);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', PublicSubscribersController.prototype.unsubscribe)).toBe(30);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', PublicSubscribersController.prototype.oneClick)).toBe(30);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('unsubscribe', () => {
    let id: string;
    beforeAll(async () => {
      await http().post('/api/v1/public/subscribe').send({ email: 'leaver@example.org', fullName: 'Lee Leaver' }).expect(202);
      id = (await sub('leaver@example.org')).id;
    });

    it('an invalid or foreign token: 400 with plain words, nothing changes', async () => {
      const other = (await sub('parent.one@example.org')).id;
      for (const body of [
        { id, token: 'x'.repeat(43) },
        { id, token: unsubscribeToken(SECRET, other) },
        { id: 'not-a-subscriber', token: unsubscribeToken(SECRET, id) },
        { id, token: unsubscribeToken('another-secret-that-is-long-enough-0000000', id) },
      ]) {
        const res = await http().post('/api/v1/public/unsubscribe').send(body).expect(400);
        expect(res.body.code).toBe('INVALID_UNSUBSCRIBE_LINK');
        expect(res.body.message).toMatch(/not valid.*most recent e-mail/);
      }
      expect((await sub('leaver@example.org')).status).toBe('ACTIVE');
    });

    it('a valid link unsubscribes (reason kept, audited); repeating it is harmless', async () => {
      const token = unsubscribeToken(SECRET, id);
      expect((await http().post('/api/v1/public/unsubscribe').send({ id, token, reason: 'Too many e-mails' }).expect(200)).body).toEqual({ unsubscribed: true });
      expect(await sub('leaver@example.org')).toMatchObject({ status: 'UNSUBSCRIBED', unsubscribeReason: 'Too many e-mails' });
      expect((await sub('leaver@example.org')).unsubscribedAt).toBeInstanceOf(Date);
      expect((await http().post('/api/v1/public/unsubscribe').send({ id, token }).expect(200)).body).toEqual({ unsubscribed: true });
      const rows = (await audits('SUBSCRIBER_UNSUBSCRIBED')).filter((a) => a.entityId === id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: null, metadata: { via: 'PAGE' } });
    });

    it('subscribing again from the website makes the address active again (same public answer)', async () => {
      const res = await http().post('/api/v1/public/subscribe').send({ email: 'Leaver@example.org', interests: ['COMPUTING'] }).expect(202);
      expect(res.body).toEqual(SUBSCRIBE_ANSWER);
      expect(await sub('leaver@example.org')).toMatchObject({ status: 'ACTIVE', unsubscribedAt: null, unsubscribeReason: null, interests: ['COMPUTING'], fullName: 'Lee Leaver' });
      expect((await audits('SUBSCRIBER_SUBSCRIBED')).filter((a) => a.entityId === id).map((a) => (a.metadata as any).again)).toEqual([false, true]);
    });

    it('RFC 8058 one-click: POST with the query string from List-Unsubscribe; invalid → 400', async () => {
      const t = unsubscribeToken(SECRET, id);
      await http().post(`/api/v1/public/unsubscribe/one-click?s=${id}&t=bad`).type('form').send('List-Unsubscribe=One-Click').expect(400);
      await http().post(`/api/v1/public/unsubscribe/one-click?s=${id}&t=${t}`).type('form').send('List-Unsubscribe=One-Click').expect(200);
      expect((await sub('leaver@example.org')).status).toBe('UNSUBSCRIBED');
      expect((await audits('SUBSCRIBER_UNSUBSCRIBED')).filter((a) => a.entityId === id).at(-1)?.metadata).toEqual({ via: 'ONE_CLICK' });
    });

    it('a subscriber who was erased: a valid old link still answers "unsubscribed" (idempotent)', async () => {
      await http().post('/api/v1/public/subscribe').send({ email: 'gone@example.org' }).expect(202);
      const gone = (await sub('gone@example.org')).id;
      await http().delete(`${A}/${gone}`).set(bearer(admin)).expect(200);
      await http().post('/api/v1/public/unsubscribe').send({ id: gone, token: unsubscribeToken(SECRET, gone) }).expect(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('administrators', () => {
    it('permissions: 401 anonymous; 403 Teacher, Coach, Head Coach, Student; Administrators and Super Admins allowed', async () => {
      const routes: Array<[string, string]> = [
        ['get', A], ['get', `${A}/summary`], ['get', `${A}/export`], ['post', A], ['get', `${A}/mailings`], ['post', `${A}/mailings/preview`],
      ];
      for (const [m, url] of routes) {
        expect([url, (await (http() as any)[m](url)).status]).toEqual([url, 401]);
        for (const token of [teacher, coach, headCoach, student]) expect([url, (await (http() as any)[m](url).set(bearer(token))).status]).toEqual([url, 403]);
      }
      await http().get(A).set(bearer(admin)).expect(200);
      await http().get(A).set(bearer(superAdmin)).expect(200);
      const perms = (await http().get('/api/v1/me/permissions').set(bearer(admin)).expect(200)).body;
      expect(JSON.stringify(perms)).toContain('subscribers.manage');
    });

    it('list: filters (q, status, interest, kind, source, country), paging and sorting', async () => {
      const list = async (q: string) => (await http().get(`${A}?${q}`).set(bearer(admin)).expect(200)).body;
      const all = await list('limit=100');
      expect(all.meta.total).toBe(await p().subscriber.count());
      expect(Object.keys(all.data[0]).sort()).toEqual(['country', 'createdAt', 'email', 'fullName', 'id', 'interests', 'kind', 'source', 'status', 'subscribedAt', 'unsubscribeReason', 'unsubscribedAt', 'updatedAt', 'userId']);
      expect((await list('q=GRACE')).data.map((r: any) => r.email)).toEqual(['parent.one@example.org']);
      expect((await list('q=example.org&status=UNSUBSCRIBED')).data.map((r: any) => r.email)).toEqual(['leaver@example.org']);
      expect((await list('interest=PHYSICS')).data.map((r: any) => r.email)).toEqual(['parent.one@example.org']);
      expect((await list('kind=PARENT&country=rw')).data.map((r: any) => r.email)).toEqual(['parent.one@example.org']);
      expect((await list('source=ADMIN')).meta.total).toBe(0);
      const oldest = await list('sort=oldest&limit=1');
      expect(oldest.data[0].email).toBe('parent.one@example.org');
      expect(oldest.meta).toMatchObject({ limit: 1, page: 1 });
      const byEmail = (await list('sort=email')).data.map((r: any) => r.email);
      expect(byEmail).toEqual([...byEmail].sort());
      await http().get(`${A}?sort=random`).set(bearer(admin)).expect(400);
      await http().get(`${A}?status=MAYBE`).set(bearer(admin)).expect(400);
    });

    it('add one (source ADMIN, audited); a listed or unsubscribed address is refused with plain words (409)', async () => {
      const res = await http().post(A).set(bearer(admin)).send({ email: 'Head.Teacher@School.rw', fullName: 'Head Teacher', kind: 'SCHOOL', interests: ['MATHEMATICS'], country: 'RW' }).expect(201);
      expect(res.body).toMatchObject({ email: 'head.teacher@school.rw', source: 'ADMIN', status: 'ACTIVE', kind: 'SCHOOL' });
      expect((await audits('SUBSCRIBER_ADDED')).map((a) => [a.entityId, a.actorId])).toEqual([[res.body.id, ctx.ids.admin]]);
      expect((await http().post(A).set(bearer(admin)).send({ email: 'head.teacher@school.rw' }).expect(409)).body.code).toBe('SUBSCRIBER_EXISTS');
      const gone = await http().post(A).set(bearer(admin)).send({ email: 'leaver@example.org' }).expect(409);
      expect(gone.body.code).toBe('SUBSCRIBER_UNSUBSCRIBED');
      expect(gone.body.message).toMatch(/unsubscribed on \d{4}-\d{2}-\d{2}.*reason is required/);
      // Admin-added people get no welcome e-mail.
      expect(await p().emailDelivery.count({ where: { subscriberId: res.body.id } })).toBe(0);
    });

    it('edit, unsubscribe (reason optional) and subscribe again (reason required); each audited', async () => {
      const id = (await sub('head.teacher@school.rw')).id;
      const edited = await http().patch(`${A}/${id}`).set(bearer(admin)).send({ fullName: 'Head of School', interests: ['PHYSICS'], kind: null }).expect(200);
      expect(edited.body).toMatchObject({ fullName: 'Head of School', interests: ['PHYSICS'], kind: null });
      expect((await audits('SUBSCRIBER_UPDATED')).at(-1)?.metadata).toEqual({ changed: ['fullName', 'kind', 'interests'] });

      await http().patch(`${A}/${id}`).set(bearer(admin)).send({ status: 'UNSUBSCRIBED' }).expect(200);
      expect(await sub('head.teacher@school.rw')).toMatchObject({ status: 'UNSUBSCRIBED', unsubscribeReason: 'Unsubscribed by an administrator.' });
      const refused = await http().patch(`${A}/${id}`).set(bearer(admin)).send({ status: 'ACTIVE' }).expect(400);
      expect(refused.body.code).toBe('REASON_REQUIRED');
      await http().patch(`${A}/${id}`).set(bearer(admin)).send({ status: 'ACTIVE', reason: 'Asked by phone on 23 November' }).expect(200);
      expect((await sub('head.teacher@school.rw')).status).toBe('ACTIVE');
      expect((await audits('SUBSCRIBER_RESUBSCRIBED')).map((a) => a.metadata)).toEqual([{ reason: 'Asked by phone on 23 November' }]);
      await http().patch(`${A}/00000000-0000-4000-8000-000000000000`).set(bearer(admin)).send({ fullName: 'Nobody Here' }).expect(404);
    });

    it('summary counts', async () => {
      const s = (await http().get(`${A}/summary`).set(bearer(admin)).expect(200)).body;
      expect(s.active).toBe(await p().subscriber.count({ where: { status: 'ACTIVE' } }));
      expect(s.unsubscribed).toBe(1);
      expect(s.byInterest).toMatchObject({ MATHEMATICS: 1, PHYSICS: 2, COMPUTING: 1 });
      expect(s.bySource).toMatchObject({ WEBSITE: s.active - 1, ADMIN: 1 });
    });

    it('export: CSV of the filtered list, formula-safe, audited', async () => {
      await http().post(A).set(bearer(admin)).send({ email: 'formula@example.org', fullName: '=HYPERLINK("x")' }).expect(201);
      const res = await http().get(`${A}/export?sort=email`).set(bearer(admin)).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="subscribers-\d{4}-\d{2}-\d{2}\.csv"/);
      const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('Email,Name,Kind,Interests,Country,Source,Status,Subscribed at,Unsubscribed at,Unsubscribe reason,Has an account');
      expect(lines).toHaveLength(1 + (await p().subscriber.count()));
      expect(lines.find((l) => l.startsWith('formula@'))).toContain(`"'=HYPERLINK(""x"")"`);
      expect(lines.find((l) => l.startsWith('student.j@'))).toMatch(/All subjects.*Yes$/);
      const unsub = await http().get(`${A}/export?status=UNSUBSCRIBED`).set(bearer(admin)).expect(200);
      expect(unsub.text.trim().split('\r\n')).toHaveLength(2);
      expect((await audits('SUBSCRIBERS_EXPORTED')).length).toBe(2);
    });

    it('import: dry run reports per line; the import adds only new valid addresses and never re-adds someone who unsubscribed', async () => {
      const csv = [
        'Email,Name,Kind,Interests,Country',
        'new.one@example.org,New One,parent,Mathematics; Physics,rw',
        'NEW.ONE@example.org,Again,,,',
        'not-an-email,X,,,',
        'leaver@example.org,Lee,,,',
        'parent.one@example.org,Grace,,,',
        'new.two@example.org,,alien,,',
        'new.three@example.org,,,chemistry,',
        'new.four@example.org,,,,XX',
        'new.five@example.org,,,all,',
      ].join('\n');
      const dry = (await http().post(`${A}/import?dryRun=true`).set(bearer(admin)).attach('file', Buffer.from(csv), 'list.csv').expect(200)).body;
      expect(dry).toMatchObject({ dryRun: true, rows: 9, wouldAdd: 2, alreadyListed: 1, unsubscribed: 1, invalid: 5 });
      expect(dry.problems.map((x: any) => x.line)).toEqual([3, 4, 5, 7, 8, 9]);
      expect(dry.problems[0].problem).toMatch(/Repeated.*line 2/);
      expect(await p().subscriber.count({ where: { email: 'new.one@example.org' } })).toBe(0);

      const done = (await http().post(`${A}/import`).set(bearer(admin)).attach('file', Buffer.from(csv), 'list.csv').expect(201)).body;
      expect(done).toMatchObject({ dryRun: false, added: 2 });
      expect(await sub('new.one@example.org')).toMatchObject({ source: 'IMPORT', kind: 'PARENT', interests: ['MATHEMATICS', 'PHYSICS'], country: 'RW', fullName: 'New One' });
      expect((await sub('new.five@example.org')).interests).toEqual([]);
      expect((await sub('leaver@example.org')).status).toBe('UNSUBSCRIBED');
      expect((await audits('SUBSCRIBERS_IMPORTED')).map((a) => (a.metadata as any).added)).toEqual([2]);

      expect((await http().post(`${A}/import`).set(bearer(admin)).attach('file', Buffer.from('name\nX'), 'x.csv').expect(400)).body.code).toBe('EMAIL_COLUMN_REQUIRED');
      expect((await http().post(`${A}/import`).set(bearer(admin)).expect(400)).body.code).toBe('FILE_REQUIRED');
    });

    it('erase: the row is gone, audited without the address', async () => {
      const id = (await sub('new.five@example.org')).id;
      await http().delete(`${A}/${id}`).set(bearer(admin)).expect(200);
      expect(await p().subscriber.count({ where: { id } })).toBe(0);
      const row = (await audits('SUBSCRIBER_DELETED')).find((a) => a.entityId === id)!;
      expect(JSON.stringify(row.metadata)).not.toContain('@');
      await http().delete(`${A}/${id}`).set(bearer(admin)).expect(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('mailings', () => {
    let mailingId: string;
    const body = 'The 2027 Mathematics Olympiad opens on 1 February.\n\nRegister on the website.';

    it('preview counts only ACTIVE subscribers of the audience (no interest = every subject)', async () => {
      const count = async (audience: object) => (await http().post(`${A}/mailings/preview`).set(bearer(admin)).send({ audience }).expect(200)).body.recipients;
      expect(await count({})).toBe(await p().subscriber.count({ where: { status: 'ACTIVE' } }));
      const physicsOrAll = await p().subscriber.count({ where: { status: 'ACTIVE', OR: [{ interests: { has: 'PHYSICS' } }, { interests: { isEmpty: true } }] } });
      expect(await count({ interests: ['PHYSICS'] })).toBe(physicsOrAll);
      expect(await count({ kinds: ['PARENT'], countries: ['rw'] })).toBe(2);
      await http().post(`${A}/mailings/preview`).set(bearer(admin)).send({ audience: { interests: ['CHEMISTRY'] } }).expect(400);
    });

    it('test to me: one e-mail to the caller only, rendered as subscribers see it', async () => {
      const before = await p().emailDelivery.count();
      expect((await http().post(`${A}/mailings/test`).set(bearer(admin)).send({ subject: 'Olympiad 2027', body }).expect(202)).body).toEqual({ sentTo: 'admin@test.local' });
      expect(await p().emailDelivery.count()).toBe(before + 1);
      await drain();
      const mail = inbox.filter((m) => m.to.includes('admin@test.local')).at(-1)!;
      expect(mail.subject).toBe('[Test] Olympiad 2027');
      expect(mail.text).toContain('Register on the website.');
      expect(mail.text).toContain('Unsubscribe: http://localhost:5173/unsubscribe');
      expect(await audits('MAILING_TEST_SENT')).toHaveLength(1);
    });

    it('send: deliveries queued only to ACTIVE matching subscribers, after the cancel delay; idempotent; audited without the body', async () => {
      const expected = await p().subscriber.findMany({
        where: { status: 'ACTIVE', AND: [{ OR: [{ interests: { has: 'MATHEMATICS' } }, { interests: { isEmpty: true } }] }] }, select: { email: true },
      });
      const started = Date.now();
      const res = await http().post(`${A}/mailings`).set(bearer(admin))
        .send({ subject: 'Olympiad 2027', body, audience: { interests: ['MATHEMATICS'] }, idempotencyKey: 'mailing-e2e-0001' }).expect(201);
      mailingId = res.body.id;
      expect(res.body).toMatchObject({ status: 'QUEUED', recipientCount: expected.length, sentCount: 0, failedCount: 0, alreadyExisted: false, audience: { interests: ['MATHEMATICS'] } });
      const deliveries = await p().emailDelivery.findMany({ where: { jobId: res.body.emailJobId } });
      expect(deliveries.map((d) => d.recipientEmail).sort()).toEqual(expected.map((e) => e.email).sort());
      expect(deliveries.map((d) => d.recipientEmail)).not.toContain('leaver@example.org');
      expect(deliveries.every((d) => d.subscriberId && d.status === 'PENDING' && d.nextAttemptAt.getTime() >= started + MAILING_SEND_DELAY_MS - 1000)).toBe(true);
      // Not yet due: the worker sends nothing.
      expect(await worker.processBatch()).toBe(0);

      const again = await http().post(`${A}/mailings`).set(bearer(admin))
        .send({ subject: 'Olympiad 2027', body, audience: { interests: ['MATHEMATICS'] }, idempotencyKey: 'mailing-e2e-0001' }).expect(201);
      expect(again.body).toMatchObject({ id: mailingId, alreadyExisted: true });
      expect(await p().mailing.count()).toBe(1);
      const [audit] = await audits('MAILING_CREATED');
      expect(audit.metadata).toMatchObject({ recipients: expected.length, audience: { interests: ['MATHEMATICS'] } });
      expect(JSON.stringify(audit.metadata)).not.toContain('Register on the website');

      const none = await http().post(`${A}/mailings`).set(bearer(admin)).send({ subject: 'Nobody', body, audience: { kinds: ['TEACHER'] }, idempotencyKey: 'mailing-e2e-none' }).expect(400);
      expect(none.body.code).toBe('NO_RECIPIENTS');
    });

    it('each e-mail is personal: greeting, the subscriber\'s own unsubscribe link and List-Unsubscribe headers; someone who unsubscribes meanwhile gets nothing', async () => {
      const grace = await sub('parent.one@example.org');
      const quitter = await sub('new.one@example.org');
      await http().post('/api/v1/public/unsubscribe').send({ id: quitter.id, token: unsubscribeToken(SECRET, quitter.id) }).expect(200);
      const sentBefore = inbox.length;
      await dueNow();
      await drain();
      const mails = inbox.slice(sentBefore).filter((m) => m.subject === 'Olympiad 2027');
      const toGrace = mails.find((m) => m.to.includes('parent.one@example.org'))!;
      const t = unsubscribeToken(SECRET, grace.id);
      expect(toGrace.text).toContain('Hello Grace,');
      expect(toGrace.text).toContain('The 2027 Mathematics Olympiad opens on 1 February.');
      expect(toGrace.text).toContain(`Unsubscribe: http://localhost:5173/unsubscribe?s=${grace.id}&t=${t}`);
      expect(toGrace.html).toContain(`unsubscribe?s=${grace.id}&amp;t=${t}`);
      expect(toGrace.headers['List-Unsubscribe']).toBe(`<https://api.rof.test/api/v1/public/unsubscribe/one-click?s=${grace.id}&t=${t}>`);
      expect(toGrace.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(mails.some((m) => m.to.includes('new.one@example.org'))).toBe(false);
      // Every recipient got their own link (no two e-mails share one).
      expect(new Set(mails.map((m) => m.headers['List-Unsubscribe'])).size).toBe(mails.length);

      const detail = (await http().get(`${A}/mailings/${mailingId}`).set(bearer(admin)).expect(200)).body;
      expect(detail).toMatchObject({ status: 'SENT', sentCount: mails.length, failedCount: 1, pendingCount: 0, body });
      expect(detail.sentAt).not.toBeNull();
      const list = (await http().get(`${A}/mailings`).set(bearer(admin)).expect(200)).body;
      expect(list.data.map((m: any) => [m.id, m.status])).toEqual([[mailingId, 'SENT']]);
      expect(list.data[0]).not.toHaveProperty('body');
      await http().post(`${A}/mailings/${mailingId}/cancel`).set(bearer(admin)).expect(409);
    });

    it('cancel while queued: the waiting deliveries are withdrawn and nothing is sent; audited', async () => {
      const res = await http().post(`${A}/mailings`).set(bearer(superAdmin))
        .send({ subject: 'Oops', body: 'Sent by mistake, please ignore.', idempotencyKey: 'mailing-e2e-0002' }).expect(201);
      expect(res.body.status).toBe('QUEUED');
      const cancelled = (await http().post(`${A}/mailings/${res.body.id}/cancel`).set(bearer(superAdmin)).expect(200)).body;
      expect(cancelled).toMatchObject({ status: 'CANCELLED', withdrawn: res.body.recipientCount, cancelledCount: res.body.recipientCount, sentCount: 0 });
      expect(await p().emailDelivery.count({ where: { jobId: res.body.emailJobId } })).toBe(0);
      const sentBefore = inbox.length;
      await dueNow();
      await drain();
      expect(inbox.slice(sentBefore).filter((m) => m.subject === 'Oops')).toHaveLength(0);
      expect((await audits('MAILING_CANCELLED')).map((a) => a.metadata)).toEqual([{ withdrawn: res.body.recipientCount }]);
      await http().post(`${A}/mailings/${res.body.id}/cancel`).set(bearer(superAdmin)).expect(409);
      await http().get(`${A}/mailings/00000000-0000-4000-8000-000000000000`).set(bearer(admin)).expect(404);
    });

    it('validation: subject and body are required; unknown fields refused', async () => {
      for (const b of [
        { body, idempotencyKey: 'mailing-e2e-v1' }, { subject: 'Hi', body, idempotencyKey: 'mailing-e2e-v2' },
        { subject: 'Subject', body: 'short', idempotencyKey: 'mailing-e2e-v3' }, { subject: 'Subject', body },
        { subject: 'Subject', body, idempotencyKey: 'mailing-e2e-v4', html: '<b>x</b>' },
      ]) {
        expect((await http().post(`${A}/mailings`).set(bearer(admin)).send(b)).status).toBe(400);
      }
    });
  });
});
