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
    // The course × division pairs reported: explicit assignments and (a Coach, 2026-11-23) their programmes' courses.
    courseScopes: async (u: { id: string }) => { calls.push(u.id); return SCOPES.map((s) => ({ ...s, extra: 'x' })); },
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

  describe('course homework by teachers (owner 2026-11-24): defaults, the switch (DENY) and older delegations (GRANT)', () => {
    const o = (permission: string, effect: 'GRANT' | 'DENY') => ({ id: `${permission}-${effect}`, permission, effect, courseId: null, divisionId: null, expiresAt: null });
    const teacher = (...overrides: ReturnType<typeof o>[]) => ({ ...user('TEACHER'), overrides });
    const HW = ['students.viewProgress', 'submissions.submitOnBehalf'] as const;

    it('every Teacher holds both by default, school scope; the profile stays a delegation', () => {
      for (const p of HW) expect([p, service.scopeOf(teacher(), p)]).toEqual([p, 'school']);
      expect(service.has(teacher(), 'students.viewProfile')).toBe(false);
    });

    it('switched off (a DENY of each): neither is held — whatever the order of an older or newer delegation of the same permission', () => {
      const denied = HW.map((p) => o(p, 'DENY'));
      const granted = HW.map((p) => o(p, 'GRANT'));
      for (const overrides of [[...denied], [...granted, ...denied], [...denied, ...granted]]) {
        for (const p of HW) expect([p, overrides.map((x) => x.effect).join(','), service.has(teacher(...overrides), p)]).toEqual([p, overrides.map((x) => x.effect).join(','), false]);
      }
    });

    it('a DENY of one leaves the other; an expired DENY no longer applies', () => {
      expect(service.has(teacher(o('submissions.submitOnBehalf', 'DENY')), 'students.viewProgress')).toBe(true);
      expect(service.has(teacher(o('submissions.submitOnBehalf', 'DENY')), 'submissions.submitOnBehalf')).toBe(false);
      const expired = { ...o('submissions.submitOnBehalf', 'DENY'), expiresAt: new Date(Date.now() - 1000) };
      expect(service.has(teacher(expired), 'submissions.submitOnBehalf')).toBe(true);
    });

    it('a delegation of the profile still adds it (unchanged)', () => {
      expect(service.has(teacher(o('students.viewProfile', 'GRANT')), 'students.viewProfile')).toBe(true);
    });
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

    it('ADMIN: the list reports schools.manage, which the guard grants, and never schools.syncDirectory', async () => {
      const { service: svc } = make();
      const { permissions } = await svc.describe(user('ADMIN'));
      expect(permissions).toContain('schools.manage');
      expect(svc.has(user('ADMIN'), 'schools.manage')).toBe(true);
      expect(permissions).not.toContain('schools.syncDirectory');
      expect(svc.has(user('ADMIN'), 'schools.syncDirectory')).toBe(false);
    });

    it('ADMIN: the list reports users.manageTeachers, which the guard grants', async () => {
      const { service: svc } = make();
      const { permissions } = await svc.describe(user('ADMIN'));
      expect(permissions).toContain('users.manageTeachers');
      expect(svc.has(user('ADMIN'), 'users.manageTeachers')).toBe(true);
    });

    it('ADMIN (D-5): the list reports the Head Coach administration the guard grants; never Admin or Super Admin management', async () => {
      const { service: svc } = make();
      const { permissions } = await svc.describe(user('ADMIN'));
      for (const p of ['users.manageHeadCoaches', 'programmes.manageHeads', 'programmes.manageMembers', 'coaches.monitor', 'reports.view'] as const) {
        expect([p, permissions.includes(p), svc.has(user('ADMIN'), p)]).toEqual([p, true, true]);
      }
      for (const p of ['users.manageAdmins', 'permissions.manageOverrides', 'settings.manageSystem', 'schools.syncDirectory'] as const) {
        expect(permissions).not.toContain(p);
      }
    });

    it('TEACHER: no course grants are listed (2026-11-14) — only the school-scoped student list and the leaderboard', async () => {
      const { service: svc } = make();
      const { permissions } = await svc.describe(user('TEACHER'));
      // + tests.submitForStudents (Test Management Phase 2, G2: a default, school scope); + tests.viewSchoolResults (Phase 4)
      // + students.viewProgress, submissions.submitOnBehalf: changed on purpose — owner decision 2026-11-23 (confirmed
      //   2026-11-24): teachers hand in course homework for their students by default, like tests (no delegation needed).
      expect(permissions).toEqual([
        'leaderboard.view', 'students.viewScoped', 'students.viewProgress', 'submissions.submitOnBehalf', 'tests.submitForStudents', 'tests.viewSchoolResults',
      ]);
    });

    it('SUPER_ADMIN keeps its full effective list, including schools.manage and schools.syncDirectory', async () => {
      const { service: svc } = make();
      const { permissions } = await svc.describe(user('SUPER_ADMIN'));
      expect(permissions).toEqual(PERMISSIONS.filter((p) => Object.hasOwn(ROLE_GRANTS.SUPER_ADMIN, p)));
      expect(permissions).toEqual(expect.arrayContaining(['schools.manage', 'schools.syncDirectory', 'permissions.manageOverrides', 'settings.manageSystem']));
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
