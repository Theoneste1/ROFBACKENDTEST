/**
 * Permission equivalence (P1-04; plan §4.4, decision A4).
 *
 * 1. Catalogue equivalence: STUDENT and MENTOR hold exactly today's permissions;
 *    ADMIN holds all of today's and more (granular names it already exercises);
 *    no administrative role can hold a grading permission (RS1).
 * 2. Route equivalence: for every handler carrying @RequirePermission, the
 *    permission decision (real PermissionGuard + PermissionService) for STUDENT,
 *    MENTOR and ADMIN must equal that handler's previous decision in the P1-02
 *    guard baseline, unless listed in permission-equivalence.exceptions.ts.
 *    The route → permission mapping is the decorator metadata itself, so there is
 *    no second list to drift. In P1-04 no route is mapped (P1-06 converts them);
 *    the harness is proven on synthetic controllers below.
 */
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'fs';
import { join } from 'path';

import { Roles } from './decorators/roles.decorator.js';
import { REQUIRED_PERMISSION_KEY, RequirePermission } from './decorators/require-permission.decorator.js';
import { PermissionGuard } from './guards/permission.guard.js';
import { PermissionService } from './permission.service.js';
import {
  PERMISSION_EQUIVALENCE_EXCEPTIONS, type EquivalenceCaller, type EquivalenceDecision, type EquivalenceException,
} from './permission-equivalence.exceptions.js';
import {
  ADMINISTRATIVE_ROLES, ADMIN_PROHIBITED, APP_ROLES, ROLE_GRANTS, ROLE_PERMISSIONS, type Permission,
} from './permissions.js';
import { discoverHandlers, keyOf, type RouteHandler } from '../common/decorators/route-discovery.testing.js';
import { ADDED_SINCE_BASELINE } from '../common/decorators/route-access-additions.testing.js';
import { AppError } from '../common/errors/app-error.js';

const CALLERS: readonly EquivalenceCaller[] = ['STUDENT', 'MENTOR', 'ADMIN'];
type BaselineRow = Record<string, string>;
type Baseline = Record<string, BaselineRow>;

const BASELINE: Baseline = JSON.parse(
  readFileSync(join(__dirname, '..', 'common', 'decorators', 'route-access-baseline.json'), 'utf8'));

const service = new PermissionService({ mentorScopes: async () => [] } as never);
const guard = new PermissionGuard(new Reflector(), service);

/** The permission decision for an authenticated caller of this role. */
function permissionDecision(cls: Function, handler: Function, role: string): EquivalenceDecision {
  const ctx = {
    getHandler:   () => handler,
    getClass:     () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', username: 'u1', role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx) ? 'allow' : '403';
  } catch (err) {
    if (err instanceof AppError && err.getStatus() === 403) return '403';
    throw err;
  }
}

const isMapped = (cls: Function, handler: Function) =>
  Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler) !== undefined
  || Reflect.getMetadata(REQUIRED_PERMISSION_KEY, cls) !== undefined;

interface Mapped { key: string; cls: Function; handler: Function }

/** Unlisted differences and stale exceptions; both must be empty. */
function equivalenceReport(mapped: Mapped[], baseline: Baseline, exceptions: readonly EquivalenceException[]) {
  const differences: string[] = [];
  const used = new Set<EquivalenceException>();
  for (const { key, cls, handler } of mapped) {
    const before = baseline[key];
    if (!before) { differences.push(`${key}: not in the P1-02 baseline`); continue; }
    for (const caller of CALLERS) {
      const from = before[caller];
      const to = permissionDecision(cls, handler, caller);
      if (from === to) continue;
      const ex = exceptions.find((e) => e.key === key && e.caller === caller && e.from === from && e.to === to);
      if (ex) used.add(ex);
      else differences.push(`${key} — ${caller}: ${from} → ${to}${to === 'allow' ? ' (WIDENED)' : ' (narrowed)'}`);
    }
  }
  const stale = exceptions.filter((e) => !used.has(e)).map((e) => `${e.key} — ${e.caller}: ${e.from} → ${e.to}`);
  return { differences, stale };
}

// ── 1. Catalogue equivalence ─────────────────────────────────────────────────

describe('permission equivalence — catalogue (A4)', () => {
  const held = (role: string) => [...service.effective({ id: 'u', username: 'u', role } as never).keys()].sort();

  it('STUDENT holds exactly today\'s permissions', () => {
    expect(held('STUDENT')).toEqual([...ROLE_PERMISSIONS.STUDENT].sort());
  });

  it('MENTOR (Coach) holds exactly today\'s permissions', () => {
    expect(held('MENTOR')).toEqual([...ROLE_PERMISSIONS.MENTOR].sort());
  });

  it('ADMIN keeps every permission it holds today (and only adds granular names)', () => {
    const admin = held('ADMIN');
    expect(ROLE_PERMISSIONS.ADMIN.filter((p) => !admin.includes(p))).toEqual([]);
    expect(admin.filter((p) => !ROLE_PERMISSIONS.ADMIN.includes(p as Permission)).sort()).toEqual([
      'coaches.monitor', 'permissions.view', 'programmes.manageHeads', 'programmes.manageMembers',
      'reports.view', 'schools.manage', 'students.viewScoped', 'users.manageAdmins', 'users.manageCoaches',
      'users.manageHeadCoaches', 'users.manageStudents', 'users.manageTeachers', 'users.view',
    ]);
  });

  it('SUPER_ADMIN holds everything ADMIN holds plus the two Super-Admin-only permissions, and nothing prohibited', () => {
    const sa = held('SUPER_ADMIN');
    expect(sa).toEqual([...held('ADMIN'), 'permissions.manageOverrides', 'settings.manageSystem'].sort());
    for (const p of ADMIN_PROHIBITED) expect(sa).not.toContain(p);
  });

  it('every one of the six roles is accounted for (no role left unhandled)', () => {
    for (const role of APP_ROLES) expect([role, held(role).length > 0]).toEqual([role, true]);
    expect(held('UNKNOWN_ROLE')).toEqual([]);
  });

  it('RS1: no administrative role can hold grading permissions, by any route through the service', () => {
    for (const role of ADMINISTRATIVE_ROLES) {
      for (const p of ADMIN_PROHIBITED) {
        expect(service.has({ id: 'u', role } as never, p)).toBe(false);
        expect(ROLE_GRANTS[role]).not.toHaveProperty(p);
      }
    }
  });
});

// ── 2. Route equivalence ─────────────────────────────────────────────────────

describe('permission equivalence — routes (A4)', () => {
  let handlers: RouteHandler[];
  beforeAll(async () => { handlers = await discoverHandlers(); }, 60_000);

  it('real routes: every @RequirePermission handler decides as before for STUDENT, MENTOR and ADMIN (P1-06: 93 converted, P1-10: 3 + 18 more; no exception; routes added later are checked against their listed decisions)', () => {
    const mapped = handlers.filter((h) => isMapped(h.cls, h.handler) && !(keyOf(h) in ADDED_SINCE_BASELINE))
      .map((h) => ({ key: keyOf(h), cls: h.cls, handler: h.handler }));
    expect(mapped).toHaveLength(114);
    // Added routes that declare a permission (the permission layer only; every added route's full
    // guard decision — @Roles ones included — is checked in route-declarations.spec.ts).
    for (const h of handlers.filter((x) => keyOf(x) in ADDED_SINCE_BASELINE && isMapped(x.cls, x.handler))) {
      for (const c of CALLERS) expect([keyOf(h), c, permissionDecision(h.cls, h.handler, c)]).toEqual([keyOf(h), c, ADDED_SINCE_BASELINE[keyOf(h)][c]]);
    }
    expect(PERMISSION_EQUIVALENCE_EXCEPTIONS).toEqual([]);
    expect(equivalenceReport(mapped, BASELINE, PERMISSION_EQUIVALENCE_EXCEPTIONS)).toEqual({ differences: [], stale: [] });
  });

  it('the baseline it compares against is the committed P1-02 baseline (211 handlers, every caller decided)', () => {
    expect(Object.keys(BASELINE)).toHaveLength(211);
    for (const row of Object.values(BASELINE)) {
      for (const c of CALLERS) expect(['allow', '401', '403']).toContain(row[c]);
    }
  });

  describe('the harness itself (synthetic controllers)', () => {
    class Synthetic {
      @Roles('ADMIN') @RequirePermission('users.manage') adminEquivalent() {}
      @Roles('ADMIN') @RequirePermission('courses.view') adminWidened() {}
      @Roles('ADMIN') @RequirePermission('permissions.manageOverrides') adminNarrowed() {}
      @Roles('MENTOR') @RequirePermission('reviews.grade') gradeEquivalent() {}
      @Roles('MENTOR') @RequirePermission('reviews.grade') gradeAdminAllowedBefore() {}
    }
    const ADMIN_ONLY = { anonymous: '401', STUDENT: '403', MENTOR: '403', ADMIN: 'allow', UNKNOWN_ROLE: '403' };
    const MENTOR_ONLY = { anonymous: '401', STUDENT: '403', MENTOR: 'allow', ADMIN: '403', UNKNOWN_ROLE: '403' };
    const SYNTHETIC_BASELINE: Baseline = {
      'S adminEquivalent': ADMIN_ONLY, 'S adminWidened': ADMIN_ONLY, 'S adminNarrowed': ADMIN_ONLY,
      'S gradeEquivalent': MENTOR_ONLY,
      // a (hypothetical) route where admins were previously allowed to grade
      'S gradeAdminAllowedBefore': { ...MENTOR_ONLY, ADMIN: 'allow' },
    };
    const m = (name: keyof Synthetic): Mapped =>
      ({ key: `S ${name}`, cls: Synthetic, handler: Synthetic.prototype[name] as Function });
    const run = (names: Array<keyof Synthetic>, ex: EquivalenceException[] = []) =>
      equivalenceReport(names.map(m), SYNTHETIC_BASELINE, ex);

    it('equivalent mapping → passes', () => {
      expect(run(['adminEquivalent', 'gradeEquivalent'])).toEqual({ differences: [], stale: [] });
    });

    it('widened mapping → fails', () => {
      expect(run(['adminWidened']).differences).toEqual([
        'S adminWidened — STUDENT: 403 → allow (WIDENED)',
        'S adminWidened — MENTOR: 403 → allow (WIDENED)',
      ]);
    });

    it('narrowed mapping → fails', () => {
      expect(run(['adminNarrowed']).differences).toEqual(['S adminNarrowed — ADMIN: allow → 403 (narrowed)']);
    });

    it('listed exception → passes', () => {
      const ex: EquivalenceException = { key: 'S adminNarrowed', caller: 'ADMIN', from: 'allow', to: '403', reason: 'C2 boundary' };
      expect(run(['adminNarrowed'], [ex])).toEqual({ differences: [], stale: [] });
    });

    it('stale exception → fails', () => {
      const ex: EquivalenceException = { key: 'S adminEquivalent', caller: 'ADMIN', from: 'allow', to: '403', reason: 'stale' };
      expect(run(['adminEquivalent'], [ex])).toEqual({ differences: [], stale: ['S adminEquivalent — ADMIN: allow → 403'] });
    });

    it('a handler missing from the baseline → fails', () => {
      const missing: Mapped = { key: 'S nowhere', cls: Synthetic, handler: Synthetic.prototype.adminEquivalent };
      expect(equivalenceReport([missing], SYNTHETIC_BASELINE, []).differences).toEqual(['S nowhere: not in the P1-02 baseline']);
    });

    it('RS1: a grading permission refuses ADMIN and SUPER_ADMIN, even where ADMIN was allowed before', () => {
      expect(permissionDecision(Synthetic, Synthetic.prototype.gradeEquivalent, 'ADMIN')).toBe('403');
      expect(permissionDecision(Synthetic, Synthetic.prototype.gradeEquivalent, 'SUPER_ADMIN')).toBe('403');
      expect(permissionDecision(Synthetic, Synthetic.prototype.gradeEquivalent, 'MENTOR')).toBe('allow');
      expect(run(['gradeAdminAllowedBefore']).differences).toEqual(['S gradeAdminAllowedBefore — ADMIN: allow → 403 (narrowed)']);
    });
  });
});
