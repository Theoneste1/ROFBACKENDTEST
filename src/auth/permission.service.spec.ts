import { PermissionService } from './permission.service.js';
import {
  ADMIN_PROHIBITED, APP_ROLES, PERMISSIONS, ROLE_GRANTS, ROLE_PERMISSIONS, type Permission,
} from './permissions.js';

const SCOPES = [
  { courseId: 'c1', divisionId: 'd1' },
  { courseId: 'c2', divisionId: 'd2' },
];

function make() {
  const calls: string[] = [];
  const access = {
    mentorScopes: async (id: string) => { calls.push(id); return SCOPES.map((s) => ({ ...s, extra: 'x' })); },
    headedProgrammes: async (u: { id: string; role: string }) => {
      if (u.role !== 'HEAD_COACH') return [];
      calls.push(`programmes:${u.id}`);
      return ['prog-maths'];
    },
  };
  return { service: new PermissionService(access as any), calls };
}

const user = (role: string) => ({ id: 'u1', username: 'u', role, divisionId: null, gradeLevel: null }) as any;

describe('PermissionService', () => {
  const { service } = make();

  it.each(APP_ROLES)('effective(%s) equals the catalogue (no administrative role has a prohibited grant)', (role) => {
    expect(Object.fromEntries(service.effective(user(role)))).toEqual({ ...ROLE_GRANTS[role] });
  });

  it('an unsupported role has no permissions', () => {
    for (const role of ['UNKNOWN_ROLE', '', 'admin', '__proto__', 'constructor']) {
      expect(service.effective(user(role)).size).toBe(0);
      for (const p of PERMISSIONS) expect(service.has(user(role), p)).toBe(false);
      expect(service.isAdministrative(user(role))).toBe(false);
    }
  });

  it('has / scopeOf', () => {
    expect(service.has(user('MENTOR'), 'reviews.grade')).toBe(true);
    expect(service.scopeOf(user('MENTOR'), 'reviews.grade')).toBe('courseDivision');
    expect(service.scopeOf(user('HEAD_COACH'), 'users.view')).toBe('programme');
    expect(service.scopeOf(user('STUDENT'), 'courses.view')).toBe('division');
    expect(service.has(user('STUDENT'), 'users.manage')).toBe(false);
    expect(service.scopeOf(user('STUDENT'), 'users.manage')).toBeNull();
  });

  it('isAdministrative: ADMIN and SUPER_ADMIN only', () => {
    expect(APP_ROLES.filter((r) => service.isAdministrative(user(r)))).toEqual(['ADMIN', 'SUPER_ADMIN']);
  });

  it('A4: STUDENT, MENTOR and ADMIN keep every permission they hold today', () => {
    for (const role of ['STUDENT', 'MENTOR', 'ADMIN'] as const) {
      for (const p of ROLE_PERMISSIONS[role]) expect(service.has(user(role), p)).toBe(true);
    }
  });

  it('RS1: prohibited grants are removed for ADMIN and SUPER_ADMIN even if the catalogue held them', () => {
    const saved = { admin: { ...ROLE_GRANTS.ADMIN }, sa: { ...ROLE_GRANTS.SUPER_ADMIN } };
    const a = ROLE_GRANTS.ADMIN as Record<string, string>;
    const s = ROLE_GRANTS.SUPER_ADMIN as Record<string, string>;
    try {
      for (const p of ADMIN_PROHIBITED) { a[p] = 'global'; s[p] = 'global'; }
      for (const role of ['ADMIN', 'SUPER_ADMIN']) {
        for (const p of ADMIN_PROHIBITED) expect(service.has(user(role), p as Permission)).toBe(false);
      }
      // Coaches are unaffected.
      expect(service.has(user('MENTOR'), 'reviews.grade')).toBe(true);
    } finally {
      for (const p of ADMIN_PROHIBITED) { delete a[p]; delete s[p]; }
      expect({ ...ROLE_GRANTS.ADMIN }).toEqual(saved.admin);
      expect({ ...ROLE_GRANTS.SUPER_ADMIN }).toEqual(saved.sa);
    }
  });

  describe('describe() — GET /me/permissions', () => {
    it.each(['STUDENT', 'ADMIN'] as const)('%s: legacy list, label, no course × division scopes', async (role) => {
      const { service: svc, calls } = make();
      await expect(svc.describe(user(role))).resolves.toEqual({
        role,
        roleLabel: role === 'STUDENT' ? 'Student' : 'Administrator',
        permissions: ROLE_PERMISSIONS[role],
        scopes: { courseDivisions: [], programmes: [] },
        overrides: [],
      });
      expect(calls).toEqual([]);
    });

    it("MENTOR: legacy list, 'Coach', and its active course × division assignments", async () => {
      const { service: svc, calls } = make();
      await expect(svc.describe(user('MENTOR'))).resolves.toEqual({
        role: 'MENTOR', roleLabel: 'Coach', permissions: ROLE_PERMISSIONS.MENTOR,
        scopes: { courseDivisions: SCOPES, programmes: [] }, overrides: [],
      });
      expect(calls).toEqual(['u1']);
    });

    it.each([
      ['TEACHER', 'Teacher'], ['HEAD_COACH', 'Head Coach'], ['SUPER_ADMIN', 'Super Administrator'],
    ] as const)('%s (no legacy list; storable after M1): label and its effective catalogue permissions', async (role, label) => {
      const { service: svc, calls } = make();
      const r = await svc.describe(user(role));
      expect(r.role).toBe(role);
      expect(r.roleLabel).toBe(label);
      expect([...r.permissions].sort()).toEqual(Object.keys(ROLE_GRANTS[role]).sort());
      expect(r.permissions).toEqual(PERMISSIONS.filter((p) => p in ROLE_GRANTS[role]));   // catalogue order
      // Only a Head Coach has programme scope (the programmes they head) and, like a coach,
      // the course × division assignments an Administrator created for them (H4) — read fresh.
      const hc = role === 'HEAD_COACH';
      expect(r.scopes).toEqual({ courseDivisions: hc ? SCOPES : [], programmes: hc ? ['prog-maths'] : [] });
      expect(calls).toEqual(hc ? ['u1', 'programmes:u1'] : []);
    });

    it("SUPER_ADMIN's list never contains a prohibited grading permission", async () => {
      const r = await make().service.describe(user('SUPER_ADMIN'));
      for (const p of ADMIN_PROHIBITED) expect(r.permissions).not.toContain(p);
    });

    it.each(['UNKNOWN_ROLE', '__proto__', 'constructor', 'toString'])('unsupported role %s: no label, no permissions, no scopes, no lookup', async (role) => {
      const { service: svc, calls } = make();
      await expect(svc.describe(user(role))).resolves.toEqual({
        role, roleLabel: null, permissions: [], scopes: { courseDivisions: [], programmes: [] }, overrides: [],
      });
      expect(calls).toEqual([]);
    });
  });
});
