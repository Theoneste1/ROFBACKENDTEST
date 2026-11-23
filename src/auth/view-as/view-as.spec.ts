/**
 * "View as" (read only; owner decision 2026-11-23) — the unit-level guarantees:
 *   1. the rank rule (who may view whom);
 *   2. the read-only guard refuses EVERY non-GET route of the code with a viewing token (enumerated from the
 *      controllers, like route-declarations.spec.ts), except exactly the three routes the viewing tab needs;
 *   3. the guard is registered globally, directly after authentication;
 *   4. the database backstop refuses every write statement while viewing, and nothing otherwise.
 */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'fs';
import { join } from 'path';

import { AppError } from '../../common/errors/app-error.js';
import { SRC, discoverHandlers, type RouteHandler } from '../../common/decorators/route-discovery.testing.js';
import { allowWritesWhileViewing, markViewing, runWithRequestContext, writesBlocked } from '../../common/request-context.js';
import { isWriteStatement, readOnlyWhileViewing } from '../../prisma/read-only-while-viewing.js';
import { APP_ROLES } from '../permissions.js';
import { READ_METHODS, ViewAsReadOnlyGuard } from './view-as-read-only.guard.js';
import { VIEWABLE_ROLES, viewAsRefusal } from './view-as.rules.js';

describe('view as — who may view whom (lower roles only)', () => {
  const EXPECTED: Record<string, string[]> = {
    SUPER_ADMIN: ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN'],
    ADMIN:       ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH'],
    HEAD_COACH:  ['STUDENT', 'TEACHER', 'MENTOR'],
    MENTOR: [], TEACHER: [], STUDENT: [],
  };

  it('the table is exactly the owner decision', () => {
    expect(VIEWABLE_ROLES).toEqual({ SUPER_ADMIN: EXPECTED.SUPER_ADMIN, ADMIN: EXPECTED.ADMIN, HEAD_COACH: EXPECTED.HEAD_COACH });
  });

  it.each([...APP_ROLES])('%s views exactly the roles below it; nobody views a Super Administrator', (actor) => {
    for (const target of APP_ROLES) {
      const allowed = viewAsRefusal({ id: 'a', role: actor }, { id: 't', role: target }) === null;
      expect([actor, target, allowed]).toEqual([actor, target, EXPECTED[actor].includes(target)]);
    }
  });

  it('nobody views themselves; an unknown role views nobody and is viewed by nobody', () => {
    expect(viewAsRefusal({ id: 'x', role: 'SUPER_ADMIN' }, { id: 'x', role: 'STUDENT' })).toMatch(/yourself/);
    expect(viewAsRefusal({ id: 'a', role: 'UNKNOWN' }, { id: 't', role: 'STUDENT' })).not.toBeNull();
    expect(viewAsRefusal({ id: 'a', role: '__proto__' }, { id: 't', role: 'STUDENT' })).not.toBeNull();
    expect(viewAsRefusal({ id: 'a', role: 'SUPER_ADMIN' }, { id: 't', role: 'UNKNOWN' })).not.toBeNull();
  });
});

describe('view as — the read-only guard on every route of the code', () => {
  const guard = new ViewAsReadOnlyGuard(new Reflector());
  const viewingUser = {
    id: 'student', username: 'student', role: 'STUDENT', divisionId: null, gradeLevel: null,
    viewAs: { sessionId: 's', actor: { id: 'admin', name: 'Ada Admin', role: 'ADMIN' }, target: { id: 'student', name: 'Sam Student', role: 'STUDENT' }, expiresAt: new Date() },
  };
  const claimOnly = `Bearer h.${Buffer.from(JSON.stringify({ sub: 'student', va: { actorId: 'admin', sessionId: 's' } })).toString('base64url')}.sig`;
  /** The only non-GET routes a viewing token may call (ending the session, signing out of the tab, a new ticket). */
  const ALLOWED_WHILE_VIEWING = ['POST /api/v1/auth/logout', 'POST /api/v1/auth/view-as/end', 'POST /api/v1/auth/view-as/exchange'];

  const decide = (h: RouteHandler, req: Record<string, unknown>): string => {
    const ctx = { getHandler: () => h.handler, getClass: () => h.cls, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    try {
      return guard.canActivate(ctx) ? 'allow' : 'refused';
    } catch (err) {
      if (err instanceof AppError && err.getStatus() === 403) return err.code;
      throw err;
    }
  };

  let handlers: RouteHandler[];
  beforeAll(async () => { handlers = await discoverHandlers(); }, 60_000);

  it('every non-GET route is refused with VIEW_AS_READ_ONLY for a viewing token (signed-in or merely claimed), except the three listed', () => {
    const writes = handlers.filter((h) => !READ_METHODS.has(h.route.split(' ')[0]));
    expect(writes.length).toBeGreaterThan(200);
    const passed: string[] = [];
    for (const h of writes) {
      const method = h.route.split(' ')[0];
      const asUser = decide(h, { method, user: viewingUser, headers: {} });
      const asClaim = decide(h, { method, headers: { authorization: claimOnly } });
      expect([h.route, asClaim]).toEqual([h.route, asUser]);
      if (asUser === 'allow') passed.push(h.route);
      else expect([h.route, asUser]).toEqual([h.route, 'VIEW_AS_READ_ONLY']);
    }
    expect(passed.sort()).toEqual(ALLOWED_WHILE_VIEWING);
  });

  it('the refusal names the viewed user in plain words', () => {
    const h = handlers.find((x) => x.route === 'PATCH /api/v1/me')!;
    const ctx = { getHandler: () => h.handler, getClass: () => h.cls, switchToHttp: () => ({ getRequest: () => ({ method: 'PATCH', user: viewingUser, headers: {} }) }) } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow('You are viewing the platform as Sam Student. Nothing can be changed in this view. Return to your own account to make changes.');
  });

  it('reads pass with a viewing token; nothing changes for a normal request', () => {
    for (const h of handlers) {
      const method = h.route.split(' ')[0];
      if (READ_METHODS.has(method)) expect(decide(h, { method, user: viewingUser, headers: {} })).toBe('allow');
      expect(decide(h, { method, user: { ...viewingUser, viewAs: undefined }, headers: { authorization: 'Bearer a.b.c' } })).toBe('allow');
    }
  });

  it('is registered globally, directly after authentication (JwtAuthGuard), so no route can forget it', () => {
    const text = readFileSync(join(SRC, 'app', 'app.module.ts'), 'utf8');
    const guards = [...text.matchAll(/provide: APP_GUARD, useClass: (\w+)/g)].map((m) => m[1]);
    expect(guards.indexOf('ViewAsReadOnlyGuard')).toBe(guards.indexOf('JwtAuthGuard') + 1);
    expect(text).toMatch(/consumer\.apply\(RequestContextMiddleware,/);
  });
});

describe('view as — the database refuses writes while viewing', () => {
  it.each([
    'INSERT INTO "public"."User" ("id") VALUES ($1) RETURNING "id"',
    'UPDATE "public"."Notification" SET "readAt" = $1 WHERE "id" = $2',
    '  DELETE FROM "public"."Submission" WHERE "id" = $1',
    '/* c */ insert into x values (1)',
    'WITH t AS (UPDATE "public"."User" SET "x" = 1 RETURNING *) SELECT * FROM t',
    'WITH t AS (DELETE FROM x RETURNING *) SELECT 1',
    'TRUNCATE "x"', 'CREATE TABLE x (id int)', 'ALTER TABLE x ADD c int', 'DROP TABLE x', 'LOCK TABLE x', 'COPY x FROM stdin', 'DO $$ BEGIN END $$',
  ])('a write: %s', (sql) => expect(isWriteStatement(sql)).toBe(true));

  it.each([
    'SELECT "id" FROM "public"."User" WHERE "id" = $1',
    'SELECT 1 FROM "User" WHERE "id" = $1 FOR UPDATE',
    'WITH t AS (SELECT 1) SELECT * FROM t',
    'SELECT pg_advisory_xact_lock($1::int, hashtext($2))::text',
    'SELECT "updatedAt", "deletedAt" FROM "x"',
  ])('a read: %s', (sql) => expect(isWriteStatement(sql)).toBe(false));

  const fakeFactory = () => {
    const calls: string[] = [];
    const tx = { queryRaw: async (q: { sql: string }) => { calls.push(`tx:${q.sql}`); return 'r'; }, executeRaw: async (q: { sql: string }) => { calls.push(`tx:${q.sql}`); return 1; }, commit: async () => 'ok' };
    const adapter = {
      provider: 'postgres',
      queryRaw:   async (q: { sql: string }) => { calls.push(q.sql); return 'r'; },
      executeRaw: async (q: { sql: string }) => { calls.push(q.sql); return 1; },
      executeScript: async (s: string) => { calls.push(s); },
      startTransaction: async () => tx,
    };
    const factory = { provider: 'postgres', adapterName: 'x', connect: async () => adapter };
    return { factory: readOnlyWhileViewing(factory as never) as unknown as typeof factory, calls };
  };
  const viewing = { sessionId: 's', actorId: 'a', actorRole: 'ADMIN', targetId: 't' };

  it('while viewing: writes are refused before reaching the database (also inside a transaction); reads pass', async () => {
    const { factory, calls } = fakeFactory();
    const adapter = await factory.connect();
    await runWithRequestContext(async () => {
      markViewing(viewing);
      expect(writesBlocked()).toBe(true);
      await expect(adapter.queryRaw({ sql: 'SELECT 1' })).resolves.toBe('r');
      await expect(adapter.queryRaw({ sql: 'INSERT INTO x VALUES (1) RETURNING *' })).rejects.toMatchObject({ code: 'VIEW_AS_READ_ONLY' });
      await expect(adapter.executeRaw({ sql: 'UPDATE x SET a = 1' })).rejects.toMatchObject({ code: 'VIEW_AS_READ_ONLY' });
      await expect(adapter.executeScript('DELETE FROM x')).rejects.toMatchObject({ code: 'VIEW_AS_READ_ONLY' });
      const tx = await adapter.startTransaction();
      await expect(tx.executeRaw({ sql: 'DELETE FROM x' })).rejects.toMatchObject({ code: 'VIEW_AS_READ_ONLY' });
      await expect(tx.commit()).resolves.toBe('ok');
      // The viewing session's own bookkeeping and audit rows only.
      await allowWritesWhileViewing(() => adapter.executeRaw({ sql: 'UPDATE "ViewAsSession" SET "endedAt" = now()' }));
    });
    expect(calls).toEqual(['SELECT 1', 'UPDATE "ViewAsSession" SET "endedAt" = now()']);
  });

  it('a normal request (and code outside any request) is untouched', async () => {
    const { factory, calls } = fakeFactory();
    const adapter = await factory.connect();
    await runWithRequestContext(() => adapter.executeRaw({ sql: 'UPDATE x SET a = 1' }));
    await adapter.executeRaw({ sql: 'DELETE FROM x' });
    expect(calls).toEqual(['UPDATE x SET a = 1', 'DELETE FROM x']);
    expect(factory.provider).toBe('postgres');
  });
});
