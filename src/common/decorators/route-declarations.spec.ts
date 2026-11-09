/**
 * Route access — P1-02 (docs/PHASE-1-PLAN.md, Step 2).
 *
 * Guard-decision regression test (§6.1 of the P1-02 plan): for every route
 * handler in the code, the REAL global guards (JwtAuthGuard → RolesGuard)
 * decide for five callers — anonymous, STUDENT, MENTOR, ADMIN and an unknown
 * role — and the result must equal `route-access-baseline.json`, which was
 * captured from the unchanged code before any route declaration was added.
 * Only Passport's token check is stubbed (rejects the anonymous caller,
 * accepts the signed-in ones); the guards' own logic runs unmodified.
 *
 * Re-capture the baseline only deliberately, when an access change has been
 * approved: CAPTURE_ROUTE_ACCESS_BASELINE=1 npx vitest run src/common/decorators/route-declarations.spec.ts
 */
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

// ── Discovery ────────────────────────────────────────────────────────────────

const SRC = resolve(__dirname, '../..');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const API_PREFIX = /export const API_PREFIX = '([^']+)'/.exec(readFileSync(join(SRC, 'main.ts'), 'utf8'))![1];
const PREFIX_EXCLUDED = ['health'];   // main.ts: setGlobalPrefix(API_PREFIX, { exclude: ['health'] })

interface RouteHandler {
  /** e.g. "GET /api/v1/courses/:id" */
  route:      string;
  /** e.g. "CoursesController.findOne" */
  name:       string;
  file:       string;
  cls:        Function;
  handler:    Function;
  methodName: string;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'generated' ? [] : controllerFiles(path);
    return path.endsWith('.controller.ts') ? [path] : [];
  });
}

const joinPath = (...parts: Array<string | undefined>) =>
  '/' + parts.flatMap((p) => (p ?? '').split('/')).filter(Boolean).join('/');

async function discoverHandlers(): Promise<RouteHandler[]> {
  const handlers: RouteHandler[] = [];
  for (const file of controllerFiles(SRC).sort()) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      const cls = value as Function;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, cls);
      if (base === undefined) continue;
      const basePath = Array.isArray(base) ? base[0] : (base as string);
      for (const methodName of Object.getOwnPropertyNames(cls.prototype)) {
        if (methodName === 'constructor') continue;
        const handler = (cls.prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        const verb: number | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
        if (verb === undefined) continue;
        const sub: unknown = Reflect.getMetadata(PATH_METADATA, handler);
        const subPath = Array.isArray(sub) ? sub[0] : (sub as string | undefined);
        const prefixed = !PREFIX_EXCLUDED.includes(basePath.replace(/^\/+/, ''));
        const path = prefixed ? joinPath(API_PREFIX, basePath, subPath) : joinPath(basePath, subPath);
        handlers.push({
          route: `${HTTP_METHODS[verb]} ${path}`,
          name:  `${exportName}.${methodName}`,
          file:  relative(resolve(SRC, '..'), file).replace(/\\/g, '/'),
          cls, handler: handler as Function, methodName,
        });
      }
    }
  }
  return handlers.sort((a, b) => a.route.localeCompare(b.route) || a.name.localeCompare(b.name));
}

/** Key used in the baseline: route plus handler, so two handlers can never collide. */
const keyOf = (h: RouteHandler) => `${h.route}  ${h.name}`;

// ── Real guard decisions ─────────────────────────────────────────────────────

const CALLERS = ['anonymous', 'STUDENT', 'MENTOR', 'ADMIN', 'UNKNOWN_ROLE'] as const;
type Caller = (typeof CALLERS)[number];
type Decision = 'allow' | '401' | '403';

/** Passport's token check, the only stubbed step: anonymous has no valid token, everyone else has. */
const passportCanActivate = vi
  .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: (ctx: ExecutionContext) => unknown }, 'canActivate')
  .mockImplementation(function (this: unknown, ctx: ExecutionContext) {
    const { user } = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    if (!user) throw new UnauthorizedException();
    return true;
  });

const reflector = new Reflector();
const jwtGuard = new JwtAuthGuard(reflector);
const rolesGuard = new RolesGuard(reflector);

function contextFor(h: RouteHandler, caller: Caller): ExecutionContext {
  const user = caller === 'anonymous' ? undefined : { id: 'u1', username: 'u1', role: caller };
  return {
    getHandler:   () => h.handler,
    getClass:     () => h.cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

async function decide(h: RouteHandler, caller: Caller): Promise<Decision> {
  const ctx = contextFor(h, caller);
  try {
    if (!(await jwtGuard.canActivate(ctx))) return '401';
  } catch (err) {
    if (err instanceof UnauthorizedException) return '401';
    throw err;
  }
  return rolesGuard.canActivate(ctx) ? 'allow' : '403';
}

async function decisionTable(handlers: RouteHandler[]) {
  const table: Record<string, Record<Caller, Decision>> = {};
  for (const h of handlers) {
    const row = {} as Record<Caller, Decision>;
    for (const caller of CALLERS) row[caller] = await decide(h, caller);
    table[keyOf(h)] = row;
  }
  return table;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const BASELINE_FILE = join(__dirname, 'route-access-baseline.json');

describe('route access — guard-decision regression (P1-02 §6.1)', () => {
  let handlers: RouteHandler[];
  let table: Awaited<ReturnType<typeof decisionTable>>;

  beforeAll(async () => {
    handlers = await discoverHandlers();
    table = await decisionTable(handlers);
    if (process.env.CAPTURE_ROUTE_ACCESS_BASELINE === '1') {
      writeFileSync(BASELINE_FILE, JSON.stringify(table, null, 2) + '\n');
    }
  }, 60_000);

  afterAll(() => passportCanActivate.mockRestore());

  it('finds every route handler (211 on develop @ 16b095a: 202 registered + 9 in the unregistered StudyGroupsController)', () => {
    expect(handlers).toHaveLength(211);
    expect(new Set(handlers.map(keyOf)).size).toBe(handlers.length);
  });

  it('every handler × caller decision equals the baseline captured before any declaration was added', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as typeof table;
    expect(Object.keys(table).sort()).toEqual(Object.keys(baseline).sort());
    const differences: string[] = [];
    for (const [key, row] of Object.entries(table)) {
      for (const caller of CALLERS) {
        if (row[caller] !== baseline[key][caller]) differences.push(`${key} — ${caller}: ${baseline[key][caller]} → ${row[caller]}`);
      }
    }
    expect(differences).toEqual([]);
  });

  describe('hand-written invariants (independent of the baseline and of any declaration)', () => {
    const isPublic = (h: RouteHandler) => reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [h.handler, h.cls]) === true;
    const rolesOf  = (h: RouteHandler) => reflector.getAllAndOverride<string[]>(ROLES_KEY, [h.handler, h.cls]) ?? [];

    it('an anonymous caller is refused (401) on every non-public handler and admitted only on @Public handlers', () => {
      for (const h of handlers) expect([keyOf(h), table[keyOf(h)].anonymous]).toEqual([keyOf(h), isPublic(h) ? 'allow' : '401']);
      expect(handlers.filter(isPublic)).toHaveLength(16);
    });

    it('an unknown role is admitted only where no role is required (public or no @Roles), and refused (403) on every @Roles handler', () => {
      for (const h of handlers) {
        const expected = isPublic(h) || rolesOf(h).length === 0 ? 'allow' : '403';
        expect([keyOf(h), table[keyOf(h)].UNKNOWN_ROLE]).toEqual([keyOf(h), expected]);
      }
      expect(handlers.filter((h) => !isPublic(h) && rolesOf(h).length > 0)).toHaveLength(141);
      expect(handlers.filter((h) => !isPublic(h) && rolesOf(h).length === 0)).toHaveLength(54);
    });

    it.each(['STUDENT', 'MENTOR', 'ADMIN'] as const)('%s is admitted exactly where its role is listed or no role is required', (role) => {
      for (const h of handlers) {
        const roles = rolesOf(h);
        const expected = isPublic(h) || roles.length === 0 || roles.includes(role) ? 'allow' : '403';
        expect([keyOf(h), table[keyOf(h)][role]]).toEqual([keyOf(h), expected]);
      }
    });
  });
});
