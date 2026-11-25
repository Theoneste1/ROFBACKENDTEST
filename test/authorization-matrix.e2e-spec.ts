/**
 * The authorization documentation matches the guards for every role (review of PR #101, 2026-11-25).
 *
 * docs/AUTHORIZATION.md and docs/API.md are generated from each operation's `x-roles` (src/openapi.ts). The security
 * e2e (test/security.e2e-spec.ts) calls every route as STUDENT, MENTOR and ADMIN; this one does the same for the other
 * three roles — TEACHER, HEAD_COACH and SUPER_ADMIN: wherever `x-roles` leaves a role out, that role is refused (403)
 * by the guards. And the banking routes are documented for exactly Teachers, Coaches and Head Coaches.
 */
import { randomUUID } from 'node:crypto';
import { buildOpenApiDocument } from '../src/openapi.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Authorization documentation, the other three roles (e2e)', () => {
  let ctx: TestContext;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    for (const [username, role] of [['matrix.teacher', 'TEACHER'], ['matrix.hc', 'HEAD_COACH'], ['matrix.super', 'SUPER_ADMIN']] as const) {
      await ctx.prisma.user.create({ data: { username, firstName: 'Matrix', lastName: role, email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), gender: 'FEMALE' } });
      tokens[role] = await login(ctx, username);
    }
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('the banking routes are documented for Teachers, Coaches and Head Coaches only', () => {
    const doc = buildOpenApiDocument(ctx.app);
    for (const method of ['get', 'put'] as const) {
      expect([method, [...(doc.paths['/api/v1/me/banking'] as any)[method]['x-roles']].sort()]).toEqual([method, ['HEAD_COACH', 'MENTOR', 'TEACHER']]);
    }
  });

  it('every non-public route refuses TEACHER, HEAD_COACH and SUPER_ADMIN wherever its x-roles leaves them out', async () => {
    const doc = buildOpenApiDocument(ctx.app);
    const failures: string[] = [];
    let checked = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!op?.operationId) continue;
        const roles: string[] = op['x-roles'];
        if (roles.includes('PUBLIC')) continue;
        const url = path.replace(/\{[^}]+\}/g, randomUUID());
        for (const role of ['TEACHER', 'HEAD_COACH', 'SUPER_ADMIN'] as const) {
          if (roles.includes(role)) continue;
          checked++;
          const res = await (ctx.http() as any)[method](url).set(bearer(tokens[role])).send({});
          if (res.status !== 403) failures.push(`${method.toUpperCase()} ${path} as ${role} → ${res.status}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(failures).toEqual([]);
  }, 300_000);
});
