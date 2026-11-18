/**
 * SEC-05 — no sensitive data in URLs, public responses or logs: an automated scan.
 *
 *  1. Contract: no route takes a token, password or secret in its URL (path or query) — the generated OpenAPI is the
 *     source. One allowed exception, explained below.
 *  2. Logs: while sign-in (right and wrong password), password reset, session refresh and an expired applicant link run,
 *     everything the server writes to stdout / stderr is captured; no password, reset token, refresh token or access token
 *     may appear in it.
 *  3. Responses: no response carries a password hash, and an error's echoed `path` never contains a token.
 */
import { readFileSync } from 'fs';
import { Logger } from '@nestjs/common';
import { createTestApp, type TestContext } from './helpers.js';

const URL_SECRET = /token|password|secret|passcode|otp/i;
/**
 * reviewToken (POST /admin/schools/import): an Administrator-only, short-lived confirmation that a dry-run import was
 * reviewed — not a credential (the route needs an Administrator session); kept in the query by design.
 */
const ALLOWED_QUERY = new Set(['POST /api/v1/admin/schools/import ?reviewToken']);
/** Route NAMES that contain "password" or "token" but carry no secret in the URL (the secret is in the body). */
const NAME_ONLY = /\/(forgot-password|reset-password|password|send-password-reset)$/;

describe('SEC-05: no sensitive data in URLs, public responses or logs (automated scan)', () => {
  test('contract: no route carries a token, password or secret in its path parameters or query', () => {
    const doc = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8')) as { paths: Record<string, Record<string, { parameters?: Array<{ in: string; name: string }> }>> };
    const findings: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const where = `${method.toUpperCase()} ${path}`;
        for (const p of op.parameters ?? []) {
          if ((p.in === 'path' || p.in === 'query') && URL_SECRET.test(p.name) && !ALLOWED_QUERY.has(`${where} ?${p.name}`)) findings.push(`${where} ${p.in} ${p.name}`);
        }
        if (URL_SECRET.test(path.replace(NAME_ONLY, '')) && /\{[^}]*\}/.test(path)) findings.push(`${where}: secret-like path segment`);
      }
    }
    expect(findings).toEqual([]);
  });

  describe('runtime', () => {
    let ctx: TestContext;
    let out = '';
    const original = { stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) };
    const capture = (stream: 'stdout' | 'stderr') => (chunk: unknown, ...rest: unknown[]) => {
      out += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return (original[stream] as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    const http = () => ctx.http();

    // Everything the application logs, at every level (the test app normally logs errors only), plus direct console
    // output and raw stdout / stderr writes.
    const text = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? `${p.message}\n${p.stack}` : JSON.stringify(p))).join(' ');
    const sink = Object.fromEntries((['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((level) =>
      [level, (...parts: unknown[]) => { out += `${level}: ${text(parts)}\n`; }]));
    const consoleSpies: Array<{ mockRestore: () => void }> = [];

    beforeAll(async () => {
      ctx = await createTestApp();
      ctx.app.useLogger(sink as unknown as Parameters<typeof ctx.app.useLogger>[0]);
      Logger.overrideLogger(sink as unknown as Parameters<typeof Logger.overrideLogger>[0]);
      for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
        consoleSpies.push(vi.spyOn(console, m).mockImplementation((...parts: unknown[]) => { out += `console.${m}: ${text(parts)}\n`; }));
      }
      process.stdout.write = capture('stdout') as typeof process.stdout.write;
      process.stderr.write = capture('stderr') as typeof process.stderr.write;
    });
    afterAll(async () => {
      process.stdout.write = original.stdout as typeof process.stdout.write;
      process.stderr.write = original.stderr as typeof process.stderr.write;
      for (const s of consoleSpies) s.mockRestore();
      Logger.overrideLogger(['error']);
      await ctx?.app.close();
    });

    test('sign-in, password reset, refresh and an expired applicant link leave no secret in logs or responses', async () => {
      const secrets: string[] = [];
      const bodies: string[] = [];
      const record = (r: { body: unknown; text?: string }) => { bodies.push(r.text ?? JSON.stringify(r.body)); return r; };

      // Wrong, then right password (the wrong one is a secret too: users mistype real passwords).
      const WRONG = 'Not-My-Pass-41!';
      secrets.push(WRONG);
      record(await http().post('/api/v1/auth/login').send({ username: 'mentor.j', password: WRONG }).expect(401));

      // Password reset: the e-mailed token and the new password.
      record(await http().post('/api/v1/auth/forgot-password').send({ email: 'mentor.j@test.local' }).expect(200));
      const mail = await ctx.prisma.emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'mentor.j@test.local' }, orderBy: { createdAt: 'desc' } });
      const resetToken = decodeURIComponent(/token=([^\s"&]+)/.exec(mail.body!)![1]);
      const NEW_PASSWORD = 'Brand-New-Pass-2026!';
      secrets.push(resetToken, NEW_PASSWORD);
      record(await http().post('/api/v1/auth/reset-password').send({ token: resetToken, newPassword: NEW_PASSWORD }).expect(200));
      record(await http().post('/api/v1/auth/reset-password').send({ token: resetToken, newPassword: 'Other-Pass-2026!' }).expect(400));

      // Sign in and refresh: both tokens are secrets.
      const signIn = record(await http().post('/api/v1/auth/login').send({ username: 'mentor.j', password: NEW_PASSWORD }).expect(200));
      const { access_token: access, refresh_token: refresh } = signIn.body as { access_token: string; refresh_token: string };
      secrets.push(access, refresh);
      const renewed = record(await http().post('/api/v1/auth/refresh').send({ refreshToken: refresh }).expect(200));
      secrets.push((renewed.body as { refresh_token: string }).refresh_token, (renewed.body as { access_token: string }).access_token);
      record(await http().post('/api/v1/auth/refresh').send({ refreshToken: refresh }).expect(401));   // reuse → refused

      // An applicant link that does not exist: the error echoes the path, which carries no token.
      const fakeLink = 'expired-link-token-0123456789abcdef';
      secrets.push(fakeLink);
      const gone = record(await http().post('/api/v1/applications/info-requests/view').send({ token: fakeLink }).expect(410));
      expect((gone.body as { path: string }).path).toBe('/api/v1/applications/info-requests/view');

      // A signed-in request's error also never echoes the bearer token.
      record(await http().get('/api/v1/admin/users').set('Authorization', `Bearer ${(renewed.body as { access_token: string }).access_token}`).expect(403));

      // Control: the capture really sees the server's log output.
      new Logger('Sec05Scan').log('sec05-capture-marker');
      expect(out).toContain('sec05-capture-marker');

      for (const s of secrets) {
        expect.soft(out.includes(s), `a secret (${s.slice(0, 4)}…) appeared in the server's output`).toBe(false);
        for (const b of bodies) if (s !== access && s !== refresh && !b.includes('access_token')) expect.soft(b.includes(s), `a secret (${s.slice(0, 4)}…) appeared in a response`).toBe(false);
      }
      for (const b of bodies) expect(b).not.toMatch(/passwordHash|\$2[aby]\$\d\d\$/);
    });
  });
});
