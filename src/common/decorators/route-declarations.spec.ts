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
import { ADMIN_PROHIBITED, PERMISSIONS, ROLE_GRANTS, type AppRole, type Permission } from '../../auth/permissions.js';
import { AppError } from '../errors/app-error.js';
import { ROLES_KEY, Roles } from '../../auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY, Public } from './public.decorator.js';
import { Authenticated, IS_AUTHENTICATED_KEY } from './authenticated.decorator.js';
import { SRC, discoverHandlers, keyOf, type RouteHandler } from './route-discovery.testing.js';
import { ADDED_SINCE_BASELINE } from './route-access-additions.testing.js';

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

  it('declarations add up: 17 @Public + 28 @Roles + 148 @RequirePermission + 54 @Authenticated = 247, none undeclared', () => {
    const counts: Record<string, number> = {};
    for (const h of handlers) {
      const kind = effectiveDeclaration(h.cls, h.handler) ?? 'undeclared';
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    expect(counts).toEqual({ '@Public': 17, '@Roles': 28, '@RequirePermission': 148, '@Authenticated': 54 });
  });

  it('P1-06: the converted handlers, by permission (any addition or removal must change this list on purpose)', () => {
    const byPermission: Record<string, number> = {};
    for (const h of handlers) {
      expect([keyOf(h), Reflect.getMetadata(REQUIRED_PERMISSION_KEY, h.cls)]).toEqual([keyOf(h), undefined]);   // never class level
      const p: string | undefined = Reflect.getMetadata(REQUIRED_PERMISSION_KEY, h.handler);
      if (p) byPermission[p] = (byPermission[p] ?? 0) + 1;
    }
    expect(byPermission).toEqual({
      'academicYears.manage': 5, 'enrollments.manage': 1, 'assignments.prepare': 6, 'assignments.publish': 6,
      'audit.view': 4, 'users.manage': 11, 'courses.complete': 1, 'resources.manage': 9, 'courses.manage': 4,
      'discussions.moderate': 8, 'divisions.manage': 2, 'email.bulkSend': 6, 'mentorRequests.decide': 3,
      'settings.manage': 2, 'submissions.submit': 1, 'submissions.distribute': 5, 'results.approve': 4,
      'results.publish': 3, 'reviews.grade': 7, 'submissions.viewOwn': 4, 'analytics.course': 1,
      // P1-09: individual overrides (new routes, listed in route-access-additions.testing.ts)
      'permissions.manageOverrides': 3, 'permissions.view': 2,
      // P1-10: coach assignments converted from @Roles('ADMIN', 'SUPER_ADMIN') (same decisions for every
      // baseline caller); programmes, heads and members are new routes (route-access-additions.testing.ts)
      'mentorAssignments.manage': 3, 'courses.view': 1, 'programmes.manageHeads': 2, 'programmes.manageMembers': 3,
      // P1-10 part 3: dashboard, reports and activity converted from @Roles('ADMIN', 'SUPER_ADMIN') (same decisions
      // for every baseline caller; every CSV export → reports.export); coach invitation is a new route
      'reports.view': 3, 'coaches.monitor': 2, 'reports.export': 11, 'activity.view': 2, 'users.manageCoaches': 1,
      // P1-11: teacher school assignments, delegations and the teacher's school-scoped views (new routes)
      'users.manageTeachers': 6, 'students.viewScoped': 1, 'students.viewProfile': 1, 'students.viewProgress': 1, 'submissions.submitOnBehalf': 1,
      // School administration PR A: student–school verification (new routes);
      // PR B: school records (list, get, students, create, update, activate / deactivate)
      'schools.manage': 12,
    });
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


  it('finds every route handler (211 in the baseline + 36 added since: 238 registered + 9 in the unregistered StudyGroupsController)', () => {
    expect(handlers).toHaveLength(211 + Object.keys(ADDED_SINCE_BASELINE).length);
    expect(new Set(handlers.map(keyOf)).size).toBe(handlers.length);
  });

  it('every handler × caller decision equals the baseline captured before any declaration was added', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as typeof table;
    // Every handler is either in the (untouched) baseline or listed as added since, never both.
    expect(Object.keys(baseline).filter((k) => k in ADDED_SINCE_BASELINE)).toEqual([]);
    expect(Object.keys(table).sort()).toEqual([...Object.keys(baseline), ...Object.keys(ADDED_SINCE_BASELINE)].sort());
    const differences: string[] = [];
    for (const [key, row] of Object.entries(table)) {
      const expected = baseline[key] ?? ADDED_SINCE_BASELINE[key];
      for (const caller of CALLERS) {
        if (row[caller] !== expected[caller]) differences.push(`${key} — ${caller}: ${expected[caller]} → ${row[caller]}`);
      }
    }
    expect(differences).toEqual([]);
  });

  describe('hand-written invariants (independent of the baseline and of any declaration)', () => {
    const isPublic = (h: RouteHandler) => reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [h.handler, h.cls]) === true;
    const rolesOf  = (h: RouteHandler) => reflector.getAllAndOverride<string[]>(ROLES_KEY, [h.handler, h.cls]) ?? [];
    const permissionOf = (h: RouteHandler) => reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION_KEY, [h.handler, h.cls]);
    const restricted = (h: RouteHandler) => rolesOf(h).length > 0 || permissionOf(h) !== undefined;
    /** Written from the approved catalogue (plan §5), not from the guards: holders of the permission, never an administrator for grading. */
    const holds = (role: AppRole, p: Permission) =>
      p in ROLE_GRANTS[role] && !((role === 'ADMIN' || role === 'SUPER_ADMIN') && ADMIN_PROHIBITED.includes(p));

    it('an anonymous caller is refused (401) on every non-public handler and admitted only on @Public handlers', () => {
      for (const h of handlers) expect([keyOf(h), table[keyOf(h)].anonymous]).toEqual([keyOf(h), isPublic(h) ? 'allow' : '401']);
      expect(handlers.filter(isPublic)).toHaveLength(17);   // P1-11: + GET /schools/locations
    });

    it('an unknown role is admitted only where nothing is required (public, or no @Roles / @RequirePermission), and refused (403) everywhere else', () => {
      for (const h of handlers) {
        const expected = isPublic(h) || !restricted(h) ? 'allow' : '403';
        expect([keyOf(h), table[keyOf(h)].UNKNOWN_ROLE]).toEqual([keyOf(h), expected]);
      }
      // Added routes that refuse anonymous callers (the added @Public ones are not restricted).
      const addedRestricted = Object.values(ADDED_SINCE_BASELINE).filter((d) => d.anonymous !== 'allow').length;
      expect(handlers.filter((h) => !isPublic(h) && restricted(h))).toHaveLength(141 + addedRestricted);
      expect(handlers.filter((h) => !isPublic(h) && !restricted(h))).toHaveLength(54);
    });

    it.each(['STUDENT', 'MENTOR', 'ADMIN'] as const)('%s is admitted exactly where its role is listed, it holds the required permission, or nothing is required', (role) => {
      for (const h of handlers) {
        const roles = rolesOf(h);
        const p = permissionOf(h);
        const expected = isPublic(h) || !restricted(h) || roles.includes(role) || (p !== undefined && holds(role, p)) ? 'allow' : '403';
        expect([keyOf(h), table[keyOf(h)][role]]).toEqual([keyOf(h), expected]);
      }
    });
  });
});

describe('six-role guard matrix (P1-06): TEACHER, HEAD_COACH and SUPER_ADMIN on every handler', () => {
  let handlers: RouteHandler[];
  beforeAll(async () => { handlers = await discoverHandlers(); }, 60_000);

  const NEW_ROLES = ['TEACHER', 'HEAD_COACH', 'SUPER_ADMIN'] as const;
  const permissionOf = (h: RouteHandler) => reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION_KEY, [h.handler, h.cls]);
  const rolesOf = (h: RouteHandler) => reflector.getAllAndOverride<string[]>(ROLES_KEY, [h.handler, h.cls]) ?? [];
  const isPublic = (h: RouteHandler) => reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [h.handler, h.cls]) === true;
  /** From the approved catalogue (plan §5): holds the grant; administrators never for grading/authoring (RS1). */
  const holds = (role: AppRole, p: Permission) =>
    p in ROLE_GRANTS[role] && !((role === 'ADMIN' || role === 'SUPER_ADMIN') && ADMIN_PROHIBITED.includes(p));

  it.each(NEW_ROLES)('%s: admitted on a permission route iff the catalogue grants it; never on a @Roles route; always where only sign-in is required', async (role) => {
    const wrong: string[] = [];
    for (const h of handlers) {
      const p = permissionOf(h);
      const expected = isPublic(h) ? 'allow'
        : p !== undefined ? (holds(role, p) ? 'allow' : '403')
        : rolesOf(h).length > 0 ? (rolesOf(h).includes(role) ? 'allow' : '403')
        : 'allow';
      const actual = await decide(h, role as unknown as Caller);
      if (actual !== expected) wrong.push(`${keyOf(h)}: expected ${expected}, got ${actual}`);
    }
    expect(wrong).toEqual([]);
  });

  it('SUPER_ADMIN and ADMIN are refused on every grading and assignment-authoring route (RS1)', async () => {
    const grading = handlers.filter((h) => ADMIN_PROHIBITED.includes(permissionOf(h) as Permission));
    expect(grading.length).toBe(13);   // 6 assignments.prepare + 7 reviews.grade
    for (const h of grading) {
      for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
        expect([keyOf(h), role, await decide(h, role as unknown as Caller)]).toEqual([keyOf(h), role, '403']);
      }
    }
  });

  it('SUPER_ADMIN passes every handler ADMIN passes (P1-08, plan §11.4) and is refused on every grading / authoring handler', async () => {
    const missing: string[] = [];
    // Registered routes only (the unregistered StudyGroupsController cannot be called).
    for (const h of handlers.filter((x) => !(keyOf(x) in UNREGISTERED_HANDLERS))) {
      if ((await decide(h, 'ADMIN')) === 'allow' && (await decide(h, 'SUPER_ADMIN' as unknown as Caller)) !== 'allow') missing.push(keyOf(h));
    }
    expect(missing).toEqual([]);
    for (const h of handlers.filter((x) => ADMIN_PROHIBITED.includes(permissionOf(x) as Permission))) {
      expect([keyOf(h), await decide(h, 'SUPER_ADMIN' as unknown as Caller)]).toEqual([keyOf(h), '403']);
    }
  });

  it('HEAD_COACH passes the guard only on its catalogue grants — no global administrative route', async () => {
    const admitted = [];
    const byRole: string[] = [];
    for (const h of handlers) {
      if (isPublic(h) || (permissionOf(h) === undefined && rolesOf(h).length === 0)) continue;
      if ((await decide(h, 'HEAD_COACH' as unknown as Caller)) !== 'allow') continue;
      if (permissionOf(h) === undefined) byRole.push(keyOf(h));
      else admitted.push(permissionOf(h));
    }
    // H4 (P1-10): the three read-only course-work views listing HEAD_COACH in @Roles;
    // each service then requires an assigned scope or the caller's own review cycles.
    expect(byRole.sort()).toEqual([
      'GET /api/v1/assignments/:id/history  AssignmentsController.history',
      'GET /api/v1/me/teaching  MyTeachingController.findMine',
      'GET /api/v1/submissions/:id/reviews  SubmissionsController.reviews',
    ]);
    // Course-work grants (services still require an Administrator-created coach
    // assignment, H4) and the programme-scoped ones whose services restrict a Head Coach
    // to the programmes they head (P1-10) — none of the global administration permissions
    // (no reports.export, users.manage*, audit, settings, e-mail, approvals).
    expect([...new Set(admitted)].sort()).toEqual([
      'activity.view', 'analytics.course', 'assignments.prepare', 'coaches.monitor', 'courses.view', 'mentorAssignments.manage',
      'programmes.manageMembers', 'reports.view', 'reviews.grade', 'students.viewScoped', 'users.manageCoaches',
    ]);
    // students.viewScoped (programme scope) reaches only GET /teacher/students, whose service serves Teachers only (403 for a Head Coach).
  });
});

// The Passport stub serves every describe block above; restore it once, at the end of the file.
afterAll(() => passportCanActivate.mockRestore());
