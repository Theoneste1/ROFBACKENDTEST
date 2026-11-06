/**
 * Public homepage endpoints (approved 2026-11-06):
 *   GET  /public/statistics          — aggregate counts, no authentication
 *   POST /public/contact             — contact form, no authentication
 *   GET  /admin/contact-messages     — administrators only
 *   PATCH /admin/contact-messages/:id
 *
 * Seed (test/helpers.ts): 1 admin, 3 mentors (coaches), 3 students at one school, all active.
 */
import { PublicSiteController } from '../src/public-site/public-site.controller.js';
import { PublicSiteService, CONTACT_PER_EMAIL_PER_HOUR } from '../src/public-site/public-site.service.js';
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';

describe('Public site (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentor: string, student: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentor, student] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  const http = () => ctx.http();
  const fresh = () => ctx.app.get(PublicSiteService).clearStatisticsCache();
  const stats = async () => {
    fresh();
    return (await http().get('/api/v1/public/statistics').expect(200)).body;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  describe('GET /public/statistics', () => {
    it('is public and returns only aggregate counts (no personal data)', async () => {
      fresh();
      const res = await http().get('/api/v1/public/statistics').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['coaches', 'generatedAt', 'members', 'schools', 'students', 'teachers']);
      expect(res.body).toMatchObject({ students: 3, coaches: 3, schools: 1, members: 7, teachers: null });
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/@|student\.j|mentor\.j|Test School|passwordHash|email/i);
    });

    it('counts only active, approved, activated accounts; schools only with an active student', async () => {
      const users = await ctx.prisma.user.findMany({ where: { role: 'STUDENT' }, orderBy: { username: 'asc' }, select: { id: true, username: true } });
      // Suspend one, un-activate one, un-approve the last: no active student remains.
      await ctx.prisma.user.update({ where: { id: users[0].id }, data: { isActive: false } });
      expect(await stats()).toMatchObject({ students: 2, members: 6, schools: 1 });
      await ctx.prisma.user.update({ where: { id: users[1].id }, data: { activatedAt: null } });
      expect(await stats()).toMatchObject({ students: 1, members: 5, schools: 1 });
      await ctx.prisma.user.update({ where: { id: users[2].id }, data: { isApproved: false } });
      expect(await stats()).toMatchObject({ students: 0, members: 4, schools: 0, coaches: 3 });
      // A suspended coach is not counted either.
      const coach = await ctx.prisma.user.findFirstOrThrow({ where: { role: 'MENTOR' }, select: { id: true } });
      await ctx.prisma.user.update({ where: { id: coach.id }, data: { isActive: false } });
      expect(await stats()).toMatchObject({ coaches: 2, members: 3 });
      // Restore.
      await ctx.prisma.user.updateMany({ where: { role: { in: ['STUDENT', 'MENTOR'] } }, data: { isActive: true, isApproved: true, activatedAt: new Date() } });
      expect(await stats()).toMatchObject({ students: 3, coaches: 3, schools: 1, members: 7 });
    });

    it('cannot be influenced by the caller (parameters ignored, other methods refused)', async () => {
      fresh();
      const plain = (await http().get('/api/v1/public/statistics').expect(200)).body;
      fresh();
      const withParams = (await http().get('/api/v1/public/statistics?students=999&role=ADMIN').expect(200)).body;
      expect({ ...withParams, generatedAt: 0 }).toEqual({ ...plain, generatedAt: 0 });
      await http().post('/api/v1/public/statistics').send({ students: 999 }).expect(404);
    });

    it('is cached briefly (a new account appears after the cache is refreshed)', async () => {
      fresh();
      const before = (await http().get('/api/v1/public/statistics').expect(200)).body.students;
      const school = await ctx.prisma.school.findFirstOrThrow();
      await ctx.prisma.user.create({ data: { username: 'stat.extra', firstName: 'S', lastName: 'X', email: 'stat.extra@test.local', role: 'STUDENT', gradeLevel: 'S2', divisionId: ctx.ids.junior, activatedAt: new Date(), schoolId: school.id } });
      expect((await http().get('/api/v1/public/statistics').expect(200)).body.students).toBe(before); // cached
      expect((await stats()).students).toBe(before + 1);
      await ctx.prisma.user.delete({ where: { username: 'stat.extra' } });
      expect((await stats()).students).toBe(before); // deleted accounts are gone
    });

    it('is rate-limited (60 per minute)', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', PublicSiteController.prototype.statistics)).toBe(60);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('POST /public/contact', () => {
    const valid = (n = 0) => ({ fullName: 'Ada Visitor', email: `ada${n}@example.org`, subject: `Question ${n}`, message: `Hello, I would like to know more (${n}).` });

    it('is public; without a support e-mail the message is stored and the response says NOT_CONFIGURED', async () => {
      const res = await http().post('/api/v1/public/contact').send(valid(1)).expect(201);
      expect(Object.keys(res.body).sort()).toEqual(['id', 'notification', 'received']);
      expect(res.body).toMatchObject({ received: true, notification: 'NOT_CONFIGURED' });
      const row = await ctx.prisma.contactMessage.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ fullName: 'Ada Visitor', email: 'ada1@example.org', status: 'NEW', notification: 'NOT_CONFIGURED' });
      expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/); // keyed hash, never the address itself
      expect(await ctx.prisma.emailDelivery.count({ where: { subject: { contains: 'Contact form' } } })).toBe(0);
    });

    it('with a support e-mail configured, an e-mail notice is queued to it (QUEUED)', async () => {
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'platform.supportEmail': 'support@rof.test' }).expect(200);
      const res = await http().post('/api/v1/public/contact').send({ ...valid(2), email: '  ADA2@Example.org ' }).expect(201);
      expect(res.body.notification).toBe('QUEUED');
      await waitForEvents();
      const mail = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'support@rof.test' }, orderBy: { createdAt: 'desc' } });
      expect(mail.subject).toContain('Contact form: Question 2');
      expect(mail.body).toContain('ada2@example.org'); // e-mail normalised
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'platform.supportEmail': null }).expect(200);
    });

    it('validates every field on the server and stores nothing when invalid', async () => {
      const before = await ctx.prisma.contactMessage.count();
      for (const body of [
        {},
        { ...valid(3), fullName: 'A' },
        { ...valid(3), email: 'not-an-email' },
        { ...valid(3), subject: 'Hi' },
        { ...valid(3), message: 'short' },
        { ...valid(3), message: 'x'.repeat(5001) },
        { ...valid(3), role: 'ADMIN' }, // unknown fields are refused
      ]) {
        const res = await http().post('/api/v1/public/contact').send(body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await ctx.prisma.contactMessage.count()).toBe(before);
    });

    it('honeypot: a filled hidden field is accepted silently but nothing is stored or sent', async () => {
      const before = await ctx.prisma.contactMessage.count();
      const res = await http().post('/api/v1/public/contact').send({ ...valid(4), website: 'http://spam.example' }).expect(201);
      expect(res.body.received).toBe(true);
      expect(await ctx.prisma.contactMessage.count()).toBe(before);
    });

    it('refuses an identical message sent again (409 DUPLICATE_MESSAGE)', async () => {
      await http().post('/api/v1/public/contact').send(valid(5)).expect(201);
      const res = await http().post('/api/v1/public/contact').send(valid(5)).expect(409);
      expect(res.body.code).toBe('DUPLICATE_MESSAGE');
    });

    it(`limits each e-mail address to ${CONTACT_PER_EMAIL_PER_HOUR} messages per hour (429 CONTACT_LIMIT)`, async () => {
      const email = 'busy@example.org';
      for (let i = 0; i < CONTACT_PER_EMAIL_PER_HOUR; i++) {
        await http().post('/api/v1/public/contact').send({ ...valid(10 + i), email }).expect(201);
      }
      const res = await http().post('/api/v1/public/contact').send({ ...valid(20), email }).expect(429);
      expect(res.body.code).toBe('CONTACT_LIMIT');
    });

    it('is rate-limited per IP (5 per hour)', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', PublicSiteController.prototype.contact)).toBe(5);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', PublicSiteController.prototype.contact)).toBe(60 * 60_000);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('admin: contact messages', () => {
    it('only administrators can read or change messages', async () => {
      await http().get('/api/v1/admin/contact-messages').expect(401);
      await http().get('/api/v1/admin/contact-messages').set(bearer(student)).expect(403);
      await http().get('/api/v1/admin/contact-messages').set(bearer(mentor)).expect(403);
      const any = await ctx.prisma.contactMessage.findFirstOrThrow({ select: { id: true } });
      await http().patch(`/api/v1/admin/contact-messages/${any.id}`).set(bearer(student)).send({ status: 'HANDLED' }).expect(403);
      await http().patch(`/api/v1/admin/contact-messages/${any.id}`).send({ status: 'HANDLED' }).expect(401);
    });

    it('lists messages newest first with the count of new ones; never exposes the IP hash', async () => {
      const res = await http().get('/api/v1/admin/contact-messages?limit=50').set(bearer(admin)).expect(200);
      const total = await ctx.prisma.contactMessage.count();
      expect(res.body.meta.total).toBe(total);
      expect(res.body.newCount).toBe(await ctx.prisma.contactMessage.count({ where: { status: 'NEW' } }));
      expect(res.body.data[0]).not.toHaveProperty('ipHash');
      const times = res.body.data.map((m: { createdAt: string }) => Date.parse(m.createdAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('marks a message handled (audited) and back to new; unknown id 404, bad status 400', async () => {
      const msg = await ctx.prisma.contactMessage.findFirstOrThrow({ where: { status: 'NEW' }, select: { id: true } });
      const done = await http().patch(`/api/v1/admin/contact-messages/${msg.id}`).set(bearer(admin)).send({ status: 'HANDLED' }).expect(200);
      expect(done.body.status).toBe('HANDLED');
      expect(done.body.handledAt).toBeTruthy();
      const filtered = await http().get('/api/v1/admin/contact-messages?status=HANDLED').set(bearer(admin)).expect(200);
      expect(filtered.body.data.map((m: { id: string }) => m.id)).toContain(msg.id);
      expect(await ctx.prisma.auditLog.count({ where: { action: 'HANDLE_CONTACT_MESSAGE', entityId: msg.id } })).toBe(1);
      const back = await http().patch(`/api/v1/admin/contact-messages/${msg.id}`).set(bearer(admin)).send({ status: 'NEW' }).expect(200);
      expect(back.body).toMatchObject({ status: 'NEW', handledAt: null, handledById: null });
      await http().patch('/api/v1/admin/contact-messages/00000000-0000-4000-8000-000000000000').set(bearer(admin)).send({ status: 'HANDLED' }).expect(404);
      await http().patch(`/api/v1/admin/contact-messages/${msg.id}`).set(bearer(admin)).send({ status: 'DELETED' }).expect(400);
    });
  });
});
