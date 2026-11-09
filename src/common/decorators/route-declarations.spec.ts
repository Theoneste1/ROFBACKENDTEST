/**
 * Route access — P1-02 (docs/PHASE-1-PLAN.md, Step 2).
 *
 * 1. Declaration test (§5 of the P1-02 plan): every route handler declares
 *    exactly one of @Public, @Roles or @Authenticated, at one level only
 *    (method or class), with no contradictory combination; @Authenticated is
 *    method-level only. Handlers are cross-checked against docs/api/routes.json
 *    (generated from the running application); handlers of unregistered
 *    controllers must be named individually in UNREGISTERED_HANDLERS.
 *
 * 2. Guard-decision regression test (§6.1 of the P1-02 plan): for every route
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
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../../auth/guards/permission.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { REQUIRED_PERMISSION_KEY, RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { PermissionService } from '../../auth/permission.service.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { AppError } from '../errors/app-error.js';
import { ROLES_KEY, Roles } from '../../auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY, Public } from './public.decorator.js';
import { Authenticated, IS_AUTHENTICATED_KEY } from './authenticated.decorator.js';
import { SRC, discoverHandlers, keyOf, type RouteHandler } from './route-discovery.testing.js';

// ── Discovery: route-discovery.testing.ts (shared with permission-equivalence.spec.ts)

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
/** P1-04: the fourth global guard, in the chain so the baseline proves it changes nothing. */
const permissionGuard = new PermissionGuard(reflector, new PermissionService({ mentorScopes: async () => [] } as never));

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
  if (!rolesGuard.canActivate(ctx)) return '403';
  try {
    return permissionGuard.canActivate(ctx) ? 'allow' : '403';
  } catch (err) {
    if (err instanceof AppError && err.getStatus() === 403) return '403';
    if (err instanceof ForbiddenException) return '403';
    throw err;
  }
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

// ── Declaration rules ────────────────────────────────────────────────────────

/** The declaration kinds (@RequirePermission added in P1-04). */
const DECLARATIONS = [
  { name: '@Public',            key: IS_PUBLIC_KEY,           valid: (v: unknown) => v === true },
  { name: '@Roles',             key: ROLES_KEY,               valid: (v: unknown) => Array.isArray(v) && v.length > 0 },
  { name: '@Authenticated',     key: IS_AUTHENTICATED_KEY,    valid: (v: unknown) => v === true },
  { name: '@RequirePermission', key: REQUIRED_PERMISSION_KEY, valid: (v: unknown) => typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v) },
] as const;
type DeclarationName = (typeof DECLARATIONS)[number]['name'];

/** Declaration kinds present on one target (a handler or a class), read separately per level. */
const declaredOn = (target: Function) =>
  DECLARATIONS.filter((d) => Reflect.getMetadata(d.key, target) !== undefined);

/** Every rule a handler breaks; empty when its declaration is valid. */
function declarationViolations(cls: Function, handler: Function): string[] {
  const onMethod = declaredOn(handler);
  const onClass = declaredOn(cls);
  const problems: string[] = [];
  if (onMethod.length === 0 && onClass.length === 0) problems.push('undeclared: add @Public, @Roles, @Authenticated or @RequirePermission');
  if (onMethod.length > 1) problems.push(`contradictory on the method: ${onMethod.map((d) => d.name).join(' + ')}`);
  if (onClass.length > 1) problems.push(`contradictory on the class: ${onClass.map((d) => d.name).join(' + ')}`);
  if (onMethod.length > 0 && onClass.length > 0) {
    problems.push(`declared at both levels: class ${onClass.map((d) => d.name).join(' + ')}, method ${onMethod.map((d) => d.name).join(' + ')}`);
  }
  if (onClass.some((d) => d.name === '@Authenticated')) problems.push('@Authenticated on the class (method level only)');
  if (onClass.some((d) => d.name === '@RequirePermission')) problems.push('@RequirePermission on the class (method level only)');
  for (const [level, target, present] of [['method', handler, onMethod], ['class', cls, onClass]] as const) {
    for (const d of present) {
      if (!d.valid(Reflect.getMetadata(d.key, target))) problems.push(`${d.name} on the ${level} has an invalid value (e.g. @Roles() with no role, or an unknown permission)`);
    }
  }
  return problems;
}

/** The effective declaration, resolved like the guards: method first, then class. */
function effectiveDeclaration(cls: Function, handler: Function): DeclarationName | undefined {
  return (declaredOn(handler)[0] ?? declaredOn(cls)[0])?.name;
}

/**
 * Handlers present in the code but not registered in the application
 * (StudyGroupsModule is intentionally not registered — src/app/app.module.ts).
 * Named one by one: a handler of an unregistered controller that is not listed
 * here fails the test, and every listed handler must still be declared.
 */
const UNREGISTERED_HANDLERS: Record<string, DeclarationName> = {
  'GET /api/v1/study-groups/:id  StudyGroupsController.findOne':                                  '@Authenticated',
  'GET /api/v1/study-groups/my/groups  StudyGroupsController.findMyGroups':                       '@Authenticated',
  'GET /api/v1/study-groups  StudyGroupsController.findAll':                                      '@Roles',
  'POST /api/v1/study-groups  StudyGroupsController.create':                                      '@Roles',
  'PATCH /api/v1/study-groups/:id  StudyGroupsController.update':                                 '@Roles',
  'POST /api/v1/study-groups/:id/members  StudyGroupsController.addMember':                       '@Roles',
  'DELETE /api/v1/study-groups/:id/members/:userId  StudyGroupsController.removeMember':          '@Roles',
  'PATCH /api/v1/study-groups/:id/members/:userId/role  StudyGroupsController.updateMemberRole':  '@Roles',
  'GET /api/v1/study-groups/:id/members/history  StudyGroupsController.getMembershipHistory':     '@Roles',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('route declarations (P1-02 §5)', () => {
  let handlers: RouteHandler[];
  beforeAll(async () => { handlers = await discoverHandlers(); }, 60_000);

  it('every route handler declares exactly one of @Public, @Roles, @Authenticated or @RequirePermission, at one level, without contradictions', () => {
    const failures = handlers.flatMap((h) =>
      declarationViolations(h.cls, h.handler).map((problem) => `${h.route} (${h.name}, ${h.file}): ${problem}`));
    expect(failures).toEqual([]);
  });

  it('declarations add up: 16 @Public + 141 @Roles + 54 @Authenticated = 211, none undeclared', () => {
    const counts: Record<string, number> = {};
    for (const h of handlers) {
      const kind = effectiveDeclaration(h.cls, h.handler) ?? 'undeclared';
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts).toEqual({ '@Public': 16, '@Roles': 141, '@Authenticated': 54 });
  });

  it('P1-04: no real route uses @RequirePermission yet (routes are converted in P1-06)', () => {
    const using = handlers.filter((h) =>
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, h.handler) !== undefined
      || Reflect.getMetadata(REQUIRED_PERMISSION_KEY, h.cls) !== undefined).map(keyOf);
    expect(using).toEqual([]);
  });

  it('matches the running application\'s routes (docs/api/routes.json); unregistered handlers are named individually', () => {
    const documented = (JSON.parse(readFileSync(join(SRC, '..', 'docs/api/routes.json'), 'utf8')) as Array<{ method: string; path: string }>)
      .map((r) => `${r.method} ${r.path.replace(/\{(\w+)\}/g, ':$1')}`);
    const routesInCode = new Set(handlers.map((h) => h.route));
    // every registered route is found in the code (no controller escapes the scan)
    expect(documented.filter((r) => !routesInCode.has(r))).toEqual([]);
    // every handler in the code is registered, or listed by name as unregistered
    const documentedSet = new Set(documented);
    const unexplained = handlers.filter((h) => !documentedSet.has(h.route) && !(keyOf(h) in UNREGISTERED_HANDLERS)).map(keyOf);
    expect(unexplained).toEqual([]);
    // every listed unregistered handler exists, is still unregistered, and has the expected declaration
    for (const [key, expected] of Object.entries(UNREGISTERED_HANDLERS)) {
      const h = handlers.find((x) => keyOf(x) === key);
      expect([key, h ? 'exists' : 'missing']).toEqual([key, 'exists']);
      expect([key, documentedSet.has(h!.route)]).toEqual([key, false]);
      expect([key, effectiveDeclaration(h!.cls, h!.handler)]).toEqual([key, expected]);
    }
  });

  describe('the checker itself (synthetic controllers)', () => {
    class Plain {
      undeclared() {}
      @Public() pub() {}
      @Roles('ADMIN') admin() {}
      @Authenticated() signedIn() {}
      @Authenticated() @Roles('ADMIN') authAndRoles() {}
      @Public() @Roles('ADMIN') publicAndRoles() {}
      @Roles() emptyRoles() {}
      @RequirePermission('users.manage') permission() {}
      @RequirePermission('users.manage') @Roles('ADMIN') permissionAndRoles() {}
      @RequirePermission('users.manage') @Public() permissionAndPublic() {}
      @RequirePermission('users.manage') @Authenticated() permissionAndAuthenticated() {}
      @RequirePermission('no.such' as never) unknownPermission() {}
    }
    @RequirePermission('users.manage') class ClassPermission {
      covered() {}
    }
    @Roles('ADMIN') class ClassRolesWithPermission {
      @RequirePermission('users.manage') permissionUnderClassRoles() {}
    }
    @Roles('ADMIN') class ClassRoles {
      inherited() {}
      @Authenticated() authUnderClassRoles() {}
      @Roles('MENTOR') rolesOverride() {}
    }
    @Public() class ClassPublic {
      @Roles('ADMIN') rolesUnderClassPublic() {}
    }
    @Authenticated() class ClassAuthenticated {
      covered() {}
    }
    const check = (cls: Function, m: string) => declarationViolations(cls, (cls.prototype as Record<string, Function>)[m]);

    it.each([
      [Plain, 'pub'], [Plain, 'admin'], [Plain, 'signedIn'], [ClassRoles, 'inherited'], [Plain, 'permission'],
    ] as const)('accepts a valid declaration (%o.%s)', (cls, m) => {
      expect(check(cls, m)).toEqual([]);
    });

    it.each([
      [Plain, 'undeclared', /undeclared/],
      [Plain, 'authAndRoles', /contradictory on the method/],
      [Plain, 'publicAndRoles', /contradictory on the method/],
      [Plain, 'emptyRoles', /invalid value/],
      [ClassRoles, 'authUnderClassRoles', /declared at both levels/],
      [ClassRoles, 'rolesOverride', /declared at both levels/],
      [ClassPublic, 'rolesUnderClassPublic', /declared at both levels/],
      [ClassAuthenticated, 'covered', /@Authenticated on the class/],
      [Plain, 'permissionAndRoles', /contradictory on the method/],
      [Plain, 'permissionAndPublic', /contradictory on the method/],
      [Plain, 'permissionAndAuthenticated', /contradictory on the method/],
      [Plain, 'unknownPermission', /invalid value/],
      [ClassPermission, 'covered', /@RequirePermission on the class/],
      [ClassRolesWithPermission, 'permissionUnderClassRoles', /declared at both levels/],
    ] as const)('rejects %o.%s', (cls, m, reason) => {
      expect(check(cls, m).join('; ')).toMatch(reason);
    });

    it('full guard chain: @RequirePermission decides by permission; @Public does not bypass it (fails closed)', async () => {
      const synthetic = (m: string): RouteHandler => ({
        route: `GET /synthetic/${m}`, name: `Plain.${m}`, file: 'synthetic', cls: Plain,
        handler: (Plain.prototype as unknown as Record<string, Function>)[m], methodName: m,
      });
      const row = async (m: string) => Object.fromEntries(
        await Promise.all(CALLERS.map(async (c) => [c, await decide(synthetic(m), c)] as const)));
      expect(await row('permission')).toEqual({ anonymous: '401', STUDENT: '403', MENTOR: '403', ADMIN: 'allow', UNKNOWN_ROLE: '403' });
      // This harness attaches a user to every non-anonymous caller. In the running
      // app a @Public route is never authenticated, so no request carries a user
      // and every caller gets the anonymous result: 403, never 'allow'.
      expect(await row('permissionAndPublic')).toEqual({ anonymous: '403', STUDENT: '403', MENTOR: '403', ADMIN: 'allow', UNKNOWN_ROLE: '403' });
    });
  });
});

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
