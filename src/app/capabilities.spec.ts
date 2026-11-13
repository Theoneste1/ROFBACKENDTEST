import { Role } from '../generated/prisma/enums.js';
import { AppError } from '../common/errors/app-error.js';
import { PermissionService } from '../auth/permission.service.js';
import { APP_ROLES } from '../auth/permissions.js';
import { RoleAssignmentPolicy } from '../auth/role-assignment.policy.js';
import { AppService } from './app.service.js';
import { CAPABILITIES_SCHEMA_VERSION, FEATURES, capabilitiesOf } from './capabilities.js';

const configOf = (env: Record<string, string | undefined> = {}) => {
  const read: string[] = [];
  return { read, get: (k: string) => { read.push(k); return env[k]; } };
};
const ALWAYS = ['academicYearActivation', 'permissionScopes', 'schoolAdministration', 'schoolAffiliations', 'schoolReferenceRequired'];

/**
 * FROZEN — the schemaVersion 1 feature vocabulary and each feature's gate. Append only: a new V1
 * feature is added here AND in FEATURES. Removing or renaming a feature, or changing its gate
 * (what it means), is a breaking change for clients: it requires raising
 * CAPABILITIES_SCHEMA_VERSION and a new frozen list — never an edit of this one.
 */
const V1_FEATURES: Readonly<Record<string, 'always' | 'TEACHER' | 'HEAD_COACH'>> = {
  academicYearActivation:  'always',   // appended 2026-11-13: single-flight, retry-safe year start
  headCoachAccounts:       'HEAD_COACH',
  permissionScopes:        'always',
  schoolAdministration:    'always',
  schoolAffiliations:      'always',
  schoolReferenceRequired: 'always',
  teacherAccounts:         'TEACHER',
};

describe('GET /api/v1 capabilities', () => {
  describe('legacy-compatible fields', () => {
    it('the four original fields keep their exact values; capabilities is the only addition', () => {
      const info = new AppService(configOf() as never).getInfo();
      expect(Object.keys(info)).toEqual(['name', 'version', 'docs', 'health', 'capabilities']);
      expect({ name: info.name, version: info.version, docs: info.docs, health: info.health }).toEqual({
        name: 'ROF LMS API', version: '1.0.0', docs: '/api/docs', health: '/health',
      });
    });
  });

  describe('values', () => {
    it('flags off (the production default): the always-available features only, sorted', () => {
      expect(capabilitiesOf(configOf())).toEqual({ schemaVersion: 1, roles: [...APP_ROLES], features: ALWAYS });
    });

    it('a role-gated feature is listed only while its flag is exactly "true"', () => {
      expect(capabilitiesOf(configOf({ TEACHERS_ENABLED: 'true' })).features).toEqual([...ALWAYS, 'teacherAccounts'].sort());
      expect(capabilitiesOf(configOf({ HEAD_COACHES_ENABLED: 'true' })).features).toEqual([...ALWAYS, 'headCoachAccounts'].sort());
      expect(capabilitiesOf(configOf({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' })).features)
        .toEqual([...ALWAYS, 'headCoachAccounts', 'teacherAccounts'].sort());
      for (const v of ['false', 'TRUE', 'True', '1', 'yes', '', ' true']) {
        expect(capabilitiesOf(configOf({ TEACHERS_ENABLED: v, HEAD_COACHES_ENABLED: v })).features).toEqual(ALWAYS);
      }
    });

    it('a flag-gated feature agrees with what the API enforces (the same check)', async () => {
      const permissions = new PermissionService({ mentorScopes: async () => [] } as never);
      const prisma = { user: { count: vi.fn().mockResolvedValue(0) } };
      const cases: Array<[Record<string, string>, string, 'teacherAccounts' | 'headCoachAccounts']> = [
        [{}, 'TEACHER', 'teacherAccounts'], [{ TEACHERS_ENABLED: 'true' }, 'TEACHER', 'teacherAccounts'],
        [{}, 'HEAD_COACH', 'headCoachAccounts'], [{ HEAD_COACHES_ENABLED: 'true' }, 'HEAD_COACH', 'headCoachAccounts'],
      ];
      for (const [env, role, feature] of cases) {
        const policy = new RoleAssignmentPolicy(permissions, configOf(env) as never, prisma as never);
        let assignable = true;
        try { await policy.assertCanAssign({ id: 'a', role: 'ADMIN' } as never, role); } catch (e) {
          expect(e).toBeInstanceOf(AppError);
          assignable = false;
        }
        expect(capabilitiesOf(configOf(env)).features.includes(feature)).toBe(assignable);
      }
    });

    it('roles = every value of the database Role enum (the frontend must handle each)', () => {
      expect([...capabilitiesOf(configOf()).roles].sort()).toEqual(Object.values(Role).sort());
    });

    it('every feature has a gate; the role gates name real roles', () => {
      for (const gate of Object.values(FEATURES)) {
        expect(gate === 'always' || (APP_ROLES as readonly string[]).includes(gate)).toBe(true);
      }
    });
  });

  describe('frozen V1 vocabulary', () => {
    it('while schemaVersion is 1, every frozen V1 feature still exists with the same gate (none silently removed, renamed or redefined)', () => {
      expect(CAPABILITIES_SCHEMA_VERSION).toBe(1);
      for (const [name, gate] of Object.entries(V1_FEATURES)) {
        expect([name, (FEATURES as Record<string, string>)[name]]).toEqual([name, gate]);
      }
    });

    it('today the advertisable features are exactly the frozen V1 list (a new feature must be added to it deliberately)', () => {
      expect(Object.keys(FEATURES).sort()).toEqual(Object.keys(V1_FEATURES).sort());
    });

    it('the official-directory sync is never advertised, under any flag combination (owner decision 2026-11-12)', () => {
      for (const env of [{}, { TEACHERS_ENABLED: 'true' }, { HEAD_COACHES_ENABLED: 'true' }, { TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' }]) {
        const { features } = capabilitiesOf(configOf(env));
        expect(features).not.toContain('schoolDirectorySync');
        expect(features.every((f) => Object.hasOwn(V1_FEATURES, f))).toBe(true);
      }
      expect(Object.hasOwn(FEATURES, 'schoolDirectorySync')).toBe(false);
    });
  });

  describe('stability and exposure', () => {
    it('the structure is exactly schemaVersion, roles, features (schemaVersion 1)', () => {
      const c = capabilitiesOf(configOf());
      expect(Object.keys(c)).toEqual(['schemaVersion', 'roles', 'features']);
      expect(c.schemaVersion).toBe(CAPABILITIES_SCHEMA_VERSION);
      expect(CAPABILITIES_SCHEMA_VERSION).toBe(1);
    });

    it('is computed per call (a flag change takes effect) and the result is not shared', () => {
      const env: Record<string, string> = {};
      const service = new AppService(configOf(env) as never);
      const a = service.getInfo().capabilities;
      a.features.push('teacherAccounts');
      a.roles.length = 0;
      expect(service.getInfo().capabilities).toEqual({ schemaVersion: 1, roles: [...APP_ROLES], features: ALWAYS });
      env.TEACHERS_ENABLED = 'true';
      expect(service.getInfo().capabilities.features).toContain('teacherAccounts');
      expect(APP_ROLES).toHaveLength(6);
    });

    it('reads only the two role flags from the configuration, and returns no configuration value', () => {
      const secrets = {
        TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true', SUPER_ADMIN_BOUNDARY_ENABLED: 'true',
        DATABASE_URL: 'postgresql://u:p@db.internal/x', JWT_SECRET: 's'.repeat(48), RESEND_API_KEY: 're_secret',
      };
      const config = configOf(secrets);
      const json = JSON.stringify(new AppService(config as never).getInfo());
      expect([...new Set(config.read)].sort()).toEqual(['HEAD_COACHES_ENABLED', 'TEACHERS_ENABLED']);
      for (const s of [...Object.keys(secrets), ...Object.values(secrets), 'ENABLED', 'process', 'env']) {
        expect(json).not.toContain(s);
      }
      // Nothing beyond role names, feature names and the fixed legacy strings.
      expect(json).toMatch(/^[\w{}[\]":,./ -]+$/);
    });
  });
});
