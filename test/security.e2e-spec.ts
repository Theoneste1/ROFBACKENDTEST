/**
 * Security: authentication (token forgery, expiry, revocation, lockout),
 * role-based access for EVERY route (generated from the route metadata the
 * guards use), student and mentor data isolation, file uploads, input
 * validation, SQL-injection probes, sensitive-data exposure and HTTP headers.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { buildOpenApiDocument } from '../src/openapi.js';
import { createTestApp, login, bearer, inDays, PDF, EXE, PASSWORD, type TestContext } from './helpers.js';

const SECRET = 'e2e-test-secret-that-is-long-enough-123456';
const b64 = (o: object | string) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function jwt(payload: Record<string, unknown>, { secret = SECRET, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(payload);
  const sig = alg === 'none' ? '' : createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const now = () => Math.floor(Date.now() / 1000);

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}

describe('Security (e2e)', () => {
  let ctx: TestContext;
  let tokens: Record<'ADMIN' | 'MENTOR' | 'STUDENT', string>;
  let admin: string, mentorJ: string, mentorJ2: string, studentJ: string, studentJ2: string;

  beforeAll(async () => {
    process.env.MAX_UPLOAD_REQUEST_MB = '2';
    ctx = await createTestApp();
    [admin, mentorJ, mentorJ2, studentJ, studentJ2] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.j2', 'student.j', 'student.j2'].map((u) => login(ctx, u)),
    );
    tokens = { ADMIN: admin, MENTOR: mentorJ, STUDENT: studentJ };
  });

  afterAll(async () => {
    delete process.env.MAX_UPLOAD_REQUEST_MB;
    await ctx?.app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('role-based access on every route', () => {
    it('every non-public route refuses anonymous callers and roles it does not allow', async () => {
      const doc = buildOpenApiDocument(ctx.app);
      const failures: string[] = [];
      let checked = 0;
      for (const [path, item] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(item as Record<string, any>)) {
          if (!op?.operationId) continue;
          const roles: string[] = op['x-roles'];
          if (roles.includes('PUBLIC')) continue;
          const url = path.replace(/\{[^}]+\}/g, randomUUID());
          const call = (token?: string) => {
            const req = (ctx.http() as any)[method](url);
            return token ? req.set(bearer(token)) : req;
          };
          checked++;
          const anon = await call().send({});
          if (anon.status !== 401) failures.push(`${method.toUpperCase()} ${path} anonymous → ${anon.status}`);
          for (const role of ['STUDENT', 'MENTOR', 'ADMIN'] as const) {
            if (roles.includes(role)) continue;
            const res = await call(tokens[role]).send({});
            if (res.status !== 403) failures.push(`${method.toUpperCase()} ${path} as ${role} → ${res.status}`);
          }
        }
      }
      expect(checked).toBeGreaterThan(180);
      expect(failures).toEqual([]);
    });

    it('administrators cannot grade or write academic feedback', async () => {
      const id = randomUUID();
      for (const path of ['start-review', 'mark', 'submit-to-admin', 'request-resubmission']) {
        await ctx.http().patch(`/api/v1/submissions/${id}/${path}`).set(bearer(admin)).send({}).expect(403);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('authentication', () => {
    const me = (token: string) => ctx.http().get('/api/v1/me').set(bearer(token));

    it('rejects missing, malformed, forged, unsigned and expired tokens', async () => {
      await ctx.http().get('/api/v1/me').expect(401);
      await ctx.http().get('/api/v1/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
      await ctx.http().get('/api/v1/me').set('Authorization', `Basic ${b64('admin:x')}`).expect(401);
      const claims = { sub: ctx.ids.admin, jti: randomUUID(), iat: now(), exp: now() + 600 };
      await me(jwt(claims, { secret: 'a-different-secret-that-is-long-enough!!' })).expect(401);
      await me(jwt(claims, { alg: 'none' })).expect(401);
      await me(jwt({ ...claims, exp: now() - 10 })).expect(401);
      // A correctly signed token for a user that does not exist.
      await me(jwt({ ...claims, sub: randomUUID() })).expect(401);
      // A valid one works (proves the forging helper is right).
      await me(jwt(claims)).expect(200);
    });

    it('logout invalidates the access token; signing out everywhere invalidates every token', async () => {
      const session = await ctx.http().post('/api/v1/auth/login').send({ username: 'student.s', password: PASSWORD }).expect(200);
      const token = session.body.access_token;
      await ctx.http().post('/api/v1/auth/logout').set(bearer(token)).send({}).expect((r) => { if (r.status >= 300) throw new Error(String(r.status)); });
      await me(token).expect(401);

      const a = (await ctx.http().post('/api/v1/auth/login').send({ username: 'student.s', password: PASSWORD }).expect(200)).body.access_token;
      await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole-second issue times
      const b = (await ctx.http().post('/api/v1/auth/login').send({ username: 'student.s', password: PASSWORD }).expect(200)).body.access_token;
      await new Promise((r) => setTimeout(r, 1100));
      await ctx.http().post('/api/v1/auth/logout-all').set(bearer(b)).expect((r) => { if (r.status >= 300) throw new Error(String(r.status)); });
      await me(a).expect(401);
      await me(b).expect(401);
    });

    it('a password change ends existing sessions', async () => {
      const old = (await ctx.http().post('/api/v1/auth/login').send({ username: 'mentor.s', password: PASSWORD }).expect(200)).body.access_token;
      await new Promise((r) => setTimeout(r, 1100));
      await ctx.http().patch('/api/v1/auth/password').set(bearer(old))
        .send({ currentPassword: PASSWORD, newPassword: 'N3w!Passw0rd-2026' }).expect((r) => { if (r.status >= 300) throw new Error(JSON.stringify(r.body)); });
      await me(old).expect(401);
      await ctx.http().post('/api/v1/auth/login').send({ username: 'mentor.s', password: 'N3w!Passw0rd-2026' }).expect(200);
    });

    it('suspending an account ends its sessions at once', async () => {
      await me(studentJ2).expect(200);
      await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}/status`).set(bearer(admin)).send({ isActive: false }).expect(200);
      await me(studentJ2).expect(401);
      await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}/status`).set(bearer(admin)).send({ isActive: true }).expect(200);
      studentJ2 = await login(ctx, 'student.j2');
    });

    it('five wrong passwords lock the account for every address, without revealing it', async () => {
      const attempt = (password: string) => ctx.http().post('/api/v1/auth/login').send({ username: 'mentor.j2', password });
      for (let i = 0; i < 5; i++) {
        const r = await attempt(`wrong-${i}`).expect(401);
        expect(r.body.message).toBe('Invalid username or password.');
      }
      // Locked: even the right password gets the same answer.
      const locked = await attempt(PASSWORD).expect(401);
      expect(locked.body.message).toBe('Invalid username or password.');
      expect((await ctx.prisma.auditLog.findFirst({ where: { action: 'LOCK_ACCOUNT', entityId: ctx.ids.mentorJunior2 } }))).toBeTruthy();

      // Once the lock expires the right password works and the counter resets.
      await ctx.prisma.user.update({ where: { id: ctx.ids.mentorJunior2 }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      await attempt(PASSWORD).expect(200);
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.mentorJunior2 } })).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
      // An unknown username behaves exactly like a wrong password.
      const unknown = await ctx.http().post('/api/v1/auth/login').send({ username: 'nobody.here', password: PASSWORD }).expect(401);
      expect(unknown.body.message).toBe('Invalid username or password.');
    });

    it('password-reset requests do not reveal whether an account exists; only the newest link works', async () => {
      const known = await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'student.j@test.local' });
      const unknown = await ctx.http().post('/api/v1/auth/forgot-password').send({ email: 'nobody@test.local' });
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);

      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'student.j' }, select: { id: true, email: true } });
      await ctx.http().post('/api/v1/auth/forgot-password').send({ email: user.email });
      await ctx.http().post('/api/v1/auth/forgot-password').send({ email: user.email });
      const live = await ctx.prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } });
      expect(live).toBe(1);

      // The link is not kept in the outbox once the e-mail has gone.
      const { EmailWorker } = await import('../src/email/email.worker.js');
      const worker = ctx.app.get(EmailWorker);
      while ((await worker.processBatch()) > 0) { /* drain */ }
      const sent = await ctx.prisma.emailDelivery.findMany({ where: { recipientId: user.id, status: 'SENT' } });
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((d) => d.body === null && d.subject)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('data isolation', () => {
    let subJ: string;

    beforeAll(async () => {
      const a = await ctx.prisma.assignment.create({ data: {
        title: 'Isolation', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      } });
      subJ = (await ctx.http().post('/api/v1/submissions').set(bearer(studentJ)).field('assignmentId', a.id)
        .field('answerText', 'My private answer').attach('files', PDF, 'mine.pdf').expect(201)).body.id;
      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ2)).field('assignmentId', a.id).field('answerText', 'Other').expect(201);
      await ctx.http().patch(`/api/v1/submissions/${subJ}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
    });

    it('a student cannot reach another student\'s submission, files, history or result', async () => {
      for (const path of ['', '/file', '/history']) {
        await ctx.http().get(`/api/v1/submissions/${subJ}${path}`).set(bearer(studentJ2)).expect(404);
      }
      await ctx.http().get(`/api/v1/me/results/${subJ}`).set(bearer(studentJ2)).expect(404);
      const list = await ctx.http().get('/api/v1/me/submissions').set(bearer(studentJ2)).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('My private answer');
    });

    it('only the assigned mentor can open a submission', async () => {
      await ctx.http().get(`/api/v1/submissions/${subJ}`).set(bearer(mentorJ)).expect(200);
      await ctx.http().get(`/api/v1/submissions/${subJ}`).set(bearer(mentorJ2)).expect(404);
      await ctx.http().get(`/api/v1/submissions/${subJ}/file`).set(bearer(mentorJ2)).expect(404);
      const queue = await ctx.http().get('/api/v1/mentor/reviews').set(bearer(mentorJ2)).expect(200);
      expect(queue.body.data.map((s: any) => s.id)).not.toContain(subJ);
    });

    it('an assignment archived without ever being published stays hidden from students', async () => {
      const make = (publishedAt: Date | null) => ctx.prisma.assignment.create({ data: {
        title: 'Archived', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'ARCHIVED', publishedAt, archivedAt: new Date(),
      } });
      const neverPublished = await make(null);
      const wasPublished = await make(new Date());
      await ctx.http().get(`/api/v1/assignments/${neverPublished.id}/threads`).set(bearer(studentJ)).expect(404);
      await ctx.http().get(`/api/v1/assignments/${neverPublished.id}/file`).set(bearer(studentJ)).expect(404);
      await ctx.http().get(`/api/v1/assignments/${wasPublished.id}/threads`).set(bearer(studentJ)).expect(200);
    });

    it('notifications and profiles are private', async () => {
      const theirs = await ctx.prisma.notification.findFirst({ where: { userId: ctx.ids.studentJunior } });
      if (theirs) await ctx.http().get(`/api/v1/notifications/${theirs.id}`).set(bearer(studentJ2)).expect(404);
      await ctx.http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(studentJ2)).expect(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('file uploads', () => {
    let assignmentId: string;
    beforeAll(async () => {
      assignmentId = (await ctx.prisma.assignment.create({ data: {
        title: 'Uploads', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
        allowResubmission: true,
      } })).id;
    });
    const submit = (buffer: Buffer, name: string) => ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', assignmentId).attach('files', buffer, name);

    it('checks the real file type, not the name', async () => {
      const exe = await submit(EXE, 'solution.pdf').expect(415);
      expect(exe.body.code).toBe('FILE_TYPE_NOT_ALLOWED');
      const html = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
      const res = await submit(html, 'solution.pdf');
      if (res.status === 201) {
        // Stored as plain text at most — never served as HTML.
        const file = await ctx.http().get(`/api/v1/submissions/${res.body.id}/file`).set(bearer(studentJ)).expect(200);
        expect(file.headers['content-type']).not.toMatch(/html|svg|javascript/);
        expect(file.headers['x-content-type-options']).toBe('nosniff');
        expect(file.headers['content-disposition']).toMatch(/^attachment/);
      } else {
        expect(res.status).toBe(400);
      }
    });

    it('neutralises path-like and control-character file names', async () => {
      const res = await submit(PDF, '../../etc/passwd\r\nX-Injected: 1.pdf').expect(201);
      const file = await ctx.http().get(`/api/v1/submissions/${res.body.id}/file`).set(bearer(studentJ)).expect(200);
      expect(file.headers['x-injected']).toBeUndefined();
      const stored = await ctx.prisma.fileObject.findFirstOrThrow({ where: { uploadedById: ctx.ids.studentJunior }, orderBy: { createdAt: 'desc' } });
      expect(stored.storageKey).not.toContain('..');
      expect(stored.originalName).not.toMatch(/[\r\n]/);
    });

    it('refuses oversized requests before reading them', async () => {
      // The declared size alone is enough: the body is never read (the cap is 2 MB in this suite).
      const res = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .set('Content-Type', 'multipart/form-data; boundary=x').set('Content-Length', String(3 * 1024 * 1024)).send('--x--').expect(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('input validation and injection', () => {
    it('rejects unknown fields, bad ids, out-of-range paging and oversized text', async () => {
      const unknown = await ctx.http().patch('/api/v1/me').set(bearer(studentJ)).send({ role: 'ADMIN' }).expect(400);
      expect(unknown.body.code).toBe('VALIDATION_FAILED');
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).role).toBe('STUDENT');

      await ctx.http().get(`/api/v1/submissions/1' OR '1'='1`).set(bearer(admin)).expect(400);
      await ctx.http().get('/api/v1/notifications').query({ page: 1_000_000 }).set(bearer(studentJ)).expect(400);
      await ctx.http().get('/api/v1/notifications').query({ limit: 0 }).set(bearer(studentJ)).expect(400);
      await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
        .send({ title: 'x'.repeat(201), content: 'y' }).expect(400);
    });

    it('SQL injection attempts in searches and filters are treated as plain text', async () => {
      const payloads = [`' OR 1=1 --`, `'; DROP TABLE "User"; --`, `%' UNION SELECT "passwordHash" FROM "User" --`];
      for (const p of payloads) {
        const users = await ctx.http().get('/api/v1/admin/users').query({ search: p }).set(bearer(admin)).expect(200);
        expect(users.body.data).toEqual([]);
        const students = await ctx.http().get('/api/v1/admin/reports/students').query({ q: p }).set(bearer(admin)).expect(200);
        expect(students.body.data).toEqual([]);
        await ctx.http().get('/api/v1/schools/search').query({ q: p }).expect(200);
        await ctx.http().get('/api/v1/admin/audit-logs').query({ action: p }).set(bearer(admin)).expect(200);
        await ctx.http().get('/api/v1/admin/reports/students').query({ academicYearId: p }).set(bearer(admin)).expect(400);
      }
      expect(await ctx.prisma.user.count()).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('sensitive information', () => {
    const SECRET_KEYS = ['passwordHash', 'tokenHash', 'refreshToken', 'resetToken', 'activationToken'];

    it('no response anywhere contains password or token hashes', async () => {
      const gets: Array<[string, string]> = [
        ['/api/v1/me', studentJ], ['/api/v1/me', mentorJ], ['/api/v1/me', admin],
        ['/api/v1/admin/users', admin], [`/api/v1/admin/users/${ctx.ids.studentJunior}`, admin],
        ['/api/v1/admin/reports/students', admin], ['/api/v1/admin/reports/mentors', admin],
        ['/api/v1/admin/audit-logs', admin], ['/api/v1/admin/mentor-requests', admin],
        ['/api/v1/mentor-requests', admin], ['/api/v1/leaderboard', studentJ], ['/api/v1/submissions', admin],
        ['/api/v1/mentor/reviews', mentorJ], ['/api/v1/notifications', studentJ], ['/api/v1/admin/email/users', admin],
      ];
      for (const [path, token] of gets) {
        const res = await ctx.http().get(path).set(bearer(token));
        if (res.status !== 200) continue;
        const keys = keysOf(res.body);
        for (const k of SECRET_KEYS) expect(keys.has(k), `${path} exposes ${k}`).toBe(false);
      }
    });

    it('students never see e-mail addresses of other users', async () => {
      const thread = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ2)).send({ title: 'Hello', content: 'Hi all' }).expect(201);
      const views = [
        await ctx.http().get(`/api/v1/threads/${thread.body.id}/comments`).set(bearer(studentJ)),
        await ctx.http().get('/api/v1/leaderboard').set(bearer(studentJ)),
      ];
      for (const v of views) expect(JSON.stringify(v.body)).not.toMatch(/@test\.local/);
    });

    it('errors carry a code and a request id, never stack traces or database details', async () => {
      const res = await ctx.http().get(`/api/v1/assignments/${randomUUID()}`).set(bearer(admin)).expect(404);
      expect(Object.keys(res.body).sort()).toEqual(expect.arrayContaining(['code', 'message', 'requestId', 'statusCode']));
      expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|prisma|node_modules|stack/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('HTTP hardening', () => {
    it('sends security headers and hides the framework', async () => {
      const res = await ctx.http().get('/api/v1').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it('does not grant cross-origin access to unknown sites', async () => {
      const res = await ctx.http().get('/api/v1').set('Origin', 'https://evil.example');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
