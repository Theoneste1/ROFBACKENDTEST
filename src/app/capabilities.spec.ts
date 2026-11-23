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
const ALWAYS = ['academicYearActivation', 'accountStates', 'adminDivisions', 'applicationDetails', 'applicationPictureReview', 'bulkOperationsGeneric', 'bulkUserOperations', 'coachApplicationDetails', 'coachOlympiadInterests', 'coachProgrammeAccess', 'countries', 'customReports', 'dateOfBirthCorrection', 'formAvailability', 'formEmailVerification', 'genderStep', 'homeLocationRules', 'notificationDeliveries', 'olympiadInterestOther', 'olympiadLevels', 'permissionScopes', 'primaryTeacher', 'profilePictures', 'registrationAvatar', 'registrationData', 'registrationGender', 'reportExportFilters', 'reviewQueueFilters', 'schoolAdministration', 'schoolAffiliations', 'schoolCodeAtRegistration', 'schoolDirectorySync', 'schoolListFilters', 'schoolReferenceRequired', 'schoolsTable', 'studentAssignmentFilters', 'studentDateOfBirthStep', 'studentOlympiadInterests', 'studentOverview', 'studentRegistrationDetails', 'subscribers', 'tableLayouts', 'teacherAssignedTestStudents', 'teacherHomeworkDefault', 'teacherStudentAccess', 'teacherUnlistedSchoolDetails', 'testManagement', 'testMarking', 'testResults', 'testSubmissionLock', 'testSubmissions', 'viewAs'];

/**
 * FROZEN — the schemaVersion 1 feature vocabulary and each feature's gate. Append only: a new V1
 * feature is added here AND in FEATURES. Removing or renaming a feature, or changing its gate
 * (what it means), is a breaking change for clients: it requires raising
 * CAPABILITIES_SCHEMA_VERSION and a new frozen list — never an edit of this one.
 */
const V1_FEATURES: Readonly<Record<string, 'always' | 'TEACHER' | 'HEAD_COACH'>> = {
  academicYearActivation:  'always',   // appended 2026-11-13: single-flight, retry-safe year start
  coachApplicationDetails: 'always',   // appended 2026-11-15: coach application country, occupation, education, interests
  applicationDetails:      'always',
  registrationAvatar:      'always',   // appended 2026-11-18: optional profile picture at registration (REG-02)
  teacherStudentAccess:    'always',   // appended 2026-11-18: teacher–student assignments, school access, delegation student scope (TS-1…TS-6)
  applicationPictureReview: 'always',  // appended 2026-11-18: application pictures reviewed before they go live (owner approval)
  dateOfBirthCorrection:   'always',   // appended 2026-11-18: Administrator date-of-birth corrections with a reason (owner approval)
  countries:               'always',   // appended 2026-11-19: countries reference list (owner decision, simplified area 1)
  primaryTeacher:          'always',   // appended 2026-11-19: primary / secondary teacher of a school (owner decision)
  schoolListFilters:       'always',   // appended 2026-11-23: school list filters on every NESA field (owner)
  formEmailVerification:   'always',   // appended 2026-11-23: e-mail activation per sign-up form, off by default (owner)
  schoolsTable:            'always',   // appended 2026-11-19: schools table sort (name, verified students) and primary teacher
  testManagement:          'always',   // appended 2026-11-19: Test Management Phase 1 (tests, questions, files, marker authorisations)
  testSubmissions:         'always',   // appended 2026-11-19: Test Management Phase 2 (deadlines, extensions, submissions)
  testMarking:             'always',   // appended 2026-11-19: Test Management Phase 3 (distribution, blind marking, review)
  testResults:             'always',   // appended 2026-11-19: Test Management Phase 4 (publication, results, rankings, reports, dashboards)
  formAvailability:        'always',   // appended 2026-11-15: form availability (open, close, schedule, closed messages)
  headCoachAccounts:       'HEAD_COACH',
  notificationDeliveries:  'always',   // appended 2026-11-14: decision-notification delivery log (owner approval pending)
  profilePictures:         'always',   // appended 2026-11-15: profile pictures (upload, replace, remove, view)
  accountStates:           'always',   // appended 2026-11-16: account states, status history, no permanent deletion
  bulkUserOperations:      'always',   // appended 2026-11-17: bulk user operations
  bulkOperationsGeneric:   'always',   // appended 2026-11-19: generic bulk engine, /admin/bulk/*, signed 15-minute confirmation
  permissionScopes:        'always',
  reportExportFilters:     'always',   // appended 2026-11-14: results.csv period/year/course/division, enrolment by course
  reviewQueueFilters:      'always',   // appended 2026-11-14: coach review queue search, groups, sort, scope, counts
  schoolAdministration:    'always',
  schoolAffiliations:      'always',
  schoolDirectorySync:     'always',   // appended 2026-11-14: official-directory sync released (owner decision)
  schoolReferenceRequired: 'always',
  studentAssignmentFilters: 'always',  // appended 2026-11-14: My Assignments progress/sort, staff list statuses
  studentDateOfBirthStep:   'always',  // appended 2026-11-18: first-sign-in date of birth for staff-created students (decision 9.3)
  studentOlympiadInterests: 'always',  // appended 2026-11-14: students' Olympiad interests (owner decision 8)
  studentRegistrationDetails: 'always', // appended 2026-11-15: date of birth, phones, own country, official home place
  teacherAccounts:         'TEACHER',
  teacherSelfRegistration: 'TEACHER',  // appended 2026-11-13: teacher applications (owner-approved)
  coachOlympiadInterests:  'always',   // appended 2026-11-19: coach subject interests required on applications, coach / admin edit (Option A)
  registrationGender:      'always',   // appended 2026-11-20: gender required at every sign-up (owner)
  homeLocationRules:       'always',
  olympiadInterestOther:   'always',   // appended 2026-11-21: "Other" Olympiad interest in words beside the three subjects (owner)
  testSubmissionLock:      'always',   // appended 2026-11-21: teacher self-service, automatic school discovery, locked submissions (owner)
  olympiadLevels:          'always',
  adminDivisions:          'always',   // appended 2026-11-22: divisions created by Administrators, their courses, bulk coach assignment
  studentOverview:         'always',   // appended 2026-11-22: the Student Profile Overview
  customReports:           'always',   // appended 2026-11-22: custom reports with grants
  teacherUnlistedSchoolDetails: 'always', // appended 2026-11-22: unlisted school's official details; one-step approval creates it
  teacherAssignedTestStudents: 'always', // appended 2026-11-23: teachers submit for (and follow) their assigned students' tests
  registrationData:        'always',   // appended 2026-11-23: registration data for Super Administrators
  schoolCodeAtRegistration: 'always',  // appended 2026-11-23: a codeless school's code given at registration
  coachProgrammeAccess:    'always',   // appended 2026-11-23: coaches across their programmes, every level (removable)
  subscribers:             'always',   // appended 2026-11-23: news subscribers and mailings
  viewAs:                  'always',   // appended 2026-11-23: view as a lower-ranked user, read only (owner)
  teacherHomeworkDefault:  'always',   // appended 2026-11-24: teachers hand in course homework for their students by default (owner)
  tableLayouts:            'always',   // appended 2026-11-22: saved table layouts; sortable Users list   // appended 2026-11-21: Junior / Middle / Senior Olympiad levels, separate from the grade (owner)
  genderStep:              'always',   // appended 2026-11-20: existing accounts give their gender once (owner)   // appended 2026-11-20: home country required, Rwanda place only for Rwanda (owner)
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
      expect(capabilitiesOf(configOf({ TEACHERS_ENABLED: 'true' })).features).toEqual([...ALWAYS, 'teacherAccounts', 'teacherSelfRegistration'].sort());
      expect(capabilitiesOf(configOf({ HEAD_COACHES_ENABLED: 'true' })).features).toEqual([...ALWAYS, 'headCoachAccounts'].sort());
      expect(capabilitiesOf(configOf({ TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' })).features)
        .toEqual([...ALWAYS, 'headCoachAccounts', 'teacherAccounts', 'teacherSelfRegistration'].sort());
      for (const v of ['false', 'TRUE', 'True', '1', 'yes', '', ' true']) {
        expect(capabilitiesOf(configOf({ TEACHERS_ENABLED: v, HEAD_COACHES_ENABLED: v })).features).toEqual(ALWAYS);
      }
    });

    it('a flag-gated feature agrees with what the API enforces (the same check)', async () => {
      const permissions = new PermissionService({ mentorScopes: async () => [] } as never);
      const prisma = { user: { count: vi.fn().mockResolvedValue(0) } };
      const cases: Array<[Record<string, string>, string, 'teacherAccounts' | 'teacherSelfRegistration' | 'headCoachAccounts']> = [
        [{}, 'TEACHER', 'teacherAccounts'], [{ TEACHERS_ENABLED: 'true' }, 'TEACHER', 'teacherAccounts'],
        [{}, 'TEACHER', 'teacherSelfRegistration'], [{ TEACHERS_ENABLED: 'true' }, 'TEACHER', 'teacherSelfRegistration'],
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

    it('the official-directory sync is advertised under every flag combination (owner decision 2026-11-14; not before)', () => {
      for (const env of [{}, { TEACHERS_ENABLED: 'true' }, { HEAD_COACHES_ENABLED: 'true' }, { TEACHERS_ENABLED: 'true', HEAD_COACHES_ENABLED: 'true' }]) {
        const { features } = capabilitiesOf(configOf(env));
        expect(features).toContain('schoolDirectorySync');
        expect(features.every((f) => Object.hasOwn(V1_FEATURES, f))).toBe(true);
      }
      expect(FEATURES.schoolDirectorySync).toBe('always');
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
