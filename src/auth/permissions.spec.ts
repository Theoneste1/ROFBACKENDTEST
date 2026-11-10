import {
  ADMINISTRATIVE_ROLES, ADMIN_PROHIBITED, APP_ROLES, NEVER_GRANTABLE, PERMISSIONS, ROLE_GRANTS, ROLE_LABELS,
  ROLE_PERMISSIONS, grantsForRole, permissionsFor, type AppRole, type Permission, type ScopeKind,
} from './permissions.js';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ROLES_KEY } from './decorators/roles.decorator.js';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator.js';
import { renderPermissionMatrix } from './permissions-doc.testing.js';
import { AssignmentResultsController, SubmissionsController } from '../submissions/submissions.controller.js';
import { AssignmentsController } from '../assignments/assignments.controller.js';

const ROLES = Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>;

/** Every role that holds the permission, in a stable order. */
const holders = (permission: Permission) =>
  ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(permission)).sort();

const methodRoles = (cls: Function, method: string): string[] | undefined =>
  Reflect.getMetadata(ROLES_KEY, (cls.prototype as Record<string, Function>)[method]);

const methodPermission = (cls: Function, method: string): string | undefined =>
  Reflect.getMetadata(REQUIRED_PERMISSION_KEY, (cls.prototype as Record<string, Function>)[method]);

describe('permissions', () => {
  it('legacy lists (GET /me/permissions, decision A1) exist for exactly STUDENT, MENTOR and ADMIN', () => {
    expect([...ROLES].sort()).toEqual(['ADMIN', 'MENTOR', 'STUDENT']);
  });

  it('legacy lists are unchanged by P1-04 (A1)', () => {
    expect(ROLE_PERMISSIONS.STUDENT).toEqual([
      'courses.view', 'courses.complete', 'resources.view',
      'assignments.view', 'submissions.submit', 'submissions.viewOwn',
      'discussions.participate', 'discussions.report', 'leaderboard.view',
    ]);
    expect(ROLE_PERMISSIONS.MENTOR).toEqual([
      'courses.view', 'resources.view', 'resources.manage',
      'assignments.view', 'assignments.prepare', 'reviews.grade',
      'discussions.participate', 'discussions.report', 'analytics.course', 'leaderboard.view',
    ]);
    expect(ROLE_PERMISSIONS.ADMIN).toEqual([
      'courses.view', 'resources.view', 'resources.manage',
      'assignments.view', 'assignments.publish', 'submissions.distribute',
      'results.approve', 'results.publish',
      'discussions.participate', 'discussions.report', 'discussions.moderate',
      'analytics.course', 'leaderboard.view', 'reports.export',
      'users.manage', 'academicYears.manage', 'enrollments.manage', 'divisions.manage', 'courses.manage',
      'mentorAssignments.manage', 'mentorRequests.decide', 'settings.manage', 'email.bulkSend',
      'audit.view', 'activity.view',
    ]);
  });

  it.each(ROLES)('every %s permission is a known permission, listed once', (role) => {
    const perms = ROLE_PERMISSIONS[role];
    for (const p of perms) expect(PERMISSIONS).toContain(p);
    expect(new Set(perms).size).toBe(perms.length);
  });

  it('PERMISSIONS has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('administrators never grade; mentors do', () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('reviews.grade');
    expect(ROLE_PERMISSIONS.MENTOR).toContain('reviews.grade');
    expect(holders('reviews.grade')).toEqual(['MENTOR']);
  });

  it('only students submit work', () => {
    expect(ROLE_PERMISSIONS.STUDENT).toContain('submissions.submit');
    expect(holders('submissions.submit')).toEqual(['STUDENT']);
  });

  it('permissionsFor returns the role map (and nothing for an unknown role)', () => {
    expect(permissionsFor('MENTOR')).toBe(ROLE_PERMISSIONS.MENTOR);
    expect(permissionsFor('NOBODY' as any)).toEqual([]);
  });

  describe('consistency with route metadata (P1-06: these routes now require the permission itself)', () => {
    it.each(['startReview', 'mark', 'submitToAdmin'])(
      'SubmissionsController.%s requires reviews.grade (legacy holders: MENTOR only — administrators never grade)',
      (method) => {
        expect(methodRoles(SubmissionsController, method)).toBeUndefined();
        expect(methodPermission(SubmissionsController, method)).toBe('reviews.grade');
        expect(holders('reviews.grade')).toEqual(['MENTOR']);
      },
    );

    it('SubmissionsController.submit requires submissions.submit (STUDENT only)', () => {
      expect(methodPermission(SubmissionsController, 'submit')).toBe('submissions.submit');
      expect(holders('submissions.submit')).toEqual(['STUDENT']);
    });

    it('AssignmentsController.publish requires assignments.publish (ADMIN only among legacy roles)', () => {
      expect(methodPermission(AssignmentsController, 'publish')).toBe('assignments.publish');
      expect(holders('assignments.publish')).toEqual(['ADMIN']);
    });

    it('AssignmentResultsController: distribute / publish results require submissions.distribute / results.publish, with no class-level grant', () => {
      expect(Reflect.getMetadata(ROLES_KEY, AssignmentResultsController)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, AssignmentResultsController)).toBeUndefined();
      expect(methodPermission(AssignmentResultsController, 'distribute')).toBe('submissions.distribute');
      expect(methodPermission(AssignmentResultsController, 'publishResults')).toBe('results.publish');
      expect(holders('submissions.distribute')).toEqual(['ADMIN']);
      expect(holders('results.publish')).toEqual(['ADMIN']);
    });
  });
  // ── Six-role catalogue (P1-04; plan §5) ──────────────────────────────────
  describe('ROLE_GRANTS (six-role catalogue)', () => {
    const D = 'division', CD = 'courseDivision', P = 'programme', G = 'global', O = 'own';
    /**
     * Independent transcription of the approved matrix (plan v5.2 §5). Any change
     * to a role's grants or scopes must change this table too — on purpose.
     */
    const ADMIN_TABLE: Record<string, ScopeKind> = {
      'courses.view': G, 'resources.view': G, 'resources.manage': G,
      'assignments.view': G, 'assignments.publish': G, 'submissions.distribute': G,
      'results.approve': G, 'results.publish': G,
      'discussions.participate': G, 'discussions.report': G, 'discussions.moderate': G,
      'analytics.course': G, 'leaderboard.view': G, 'reports.export': G,
      'users.manage': G, 'academicYears.manage': G, 'enrollments.manage': G, 'divisions.manage': G,
      'courses.manage': G, 'mentorAssignments.manage': G, 'mentorRequests.decide': G,
      'settings.manage': G, 'email.bulkSend': G, 'audit.view': G, 'activity.view': G,
      'reports.view': G, 'students.viewScoped': G, 'users.view': G,
      'users.manageStudents': G, 'users.manageCoaches': G, 'users.manageTeachers': G,
      'users.manageHeadCoaches': G, 'users.manageAdmins': G,
      'programmes.manageHeads': G, 'programmes.manageMembers': G, 'coaches.monitor': G,
      'permissions.view': G, 'schools.manage': G,
    };
    const EXPECTED: Record<AppRole, Record<string, ScopeKind>> = {
      STUDENT: {
        'courses.view': D, 'resources.view': D, 'assignments.view': D,
        'courses.complete': O, 'submissions.submit': O, 'submissions.viewOwn': O,
        'discussions.participate': D, 'discussions.report': D, 'leaderboard.view': G,
      },
      TEACHER: {
        'courses.view': CD, 'resources.view': CD, 'assignments.view': CD,
        'discussions.participate': CD, 'discussions.report': CD,
        'students.viewScoped': 'school', 'leaderboard.view': G,
      },
      MENTOR: {
        'courses.view': CD, 'resources.view': CD, 'resources.manage': CD,
        'assignments.view': CD, 'assignments.prepare': CD, 'reviews.grade': CD,
        'discussions.participate': CD, 'discussions.report': CD,
        'analytics.course': CD, 'leaderboard.view': G,
      },
      HEAD_COACH: {
        'courses.view': P, 'resources.view': P, 'assignments.view': P,
        'assignments.prepare': CD, 'reviews.grade': CD,
        'discussions.participate': P, 'discussions.report': P,
        'analytics.course': P, 'leaderboard.view': G,
        'reports.view': P, 'students.viewScoped': P,
        'users.view': P, 'users.manageStudents': P, 'users.manageCoaches': P,
        'programmes.manageMembers': P, 'mentorAssignments.manage': P,
        'coaches.monitor': P, 'activity.view': P,
      },
      ADMIN: ADMIN_TABLE,
      SUPER_ADMIN: { ...ADMIN_TABLE, 'permissions.manageOverrides': G, 'settings.manageSystem': G },
    };

    it('covers exactly the six roles', () => {
      expect(Object.keys(ROLE_GRANTS).sort()).toEqual([...APP_ROLES].sort());
      expect(Object.keys(ROLE_LABELS).sort()).toEqual([...APP_ROLES].sort());
    });

    it.each(APP_ROLES)('%s matches the approved matrix (permissions and scopes)', (role) => {
      expect({ ...ROLE_GRANTS[role] }).toEqual(EXPECTED[role]);
    });

    it.each(APP_ROLES)('every %s grant is a known permission', (role) => {
      for (const p of Object.keys(ROLE_GRANTS[role])) expect(PERMISSIONS).toContain(p);
    });

    it('role labels', () => {
      expect(ROLE_LABELS).toEqual({
        STUDENT: 'Student', TEACHER: 'Teacher', MENTOR: 'Coach', HEAD_COACH: 'Head Coach',
        ADMIN: 'Administrator', SUPER_ADMIN: 'Super Administrator',
      });
    });

    it('RS1: Administrator and Super Admin hold no grading or assignment-authoring permission', () => {
      expect([...ADMINISTRATIVE_ROLES].sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
      expect([...ADMIN_PROHIBITED].sort()).toEqual(['assignments.prepare', 'reviews.grade']);
      for (const role of ADMINISTRATIVE_ROLES) {
        for (const p of ADMIN_PROHIBITED) expect(ROLE_GRANTS[role]).not.toHaveProperty(p);
      }
    });

    it('SUPER_ADMIN is written out, not the ADMIN object', () => {
      expect(ROLE_GRANTS.SUPER_ADMIN).not.toBe(ROLE_GRANTS.ADMIN);
    });

    it('A7: Administrator keeps users.manageAdmins until P1-08', () => {
      expect(ROLE_GRANTS.ADMIN['users.manageAdmins']).toBe('global');
    });

    it('Super Admin only: permissions.manageOverrides and settings.manageSystem', () => {
      for (const p of ['permissions.manageOverrides', 'settings.manageSystem'] as const) {
        expect(APP_ROLES.filter((r) => p in ROLE_GRANTS[r])).toEqual(['SUPER_ADMIN']);
      }
    });

    it('H4: Head Coach grades and prepares only at course × division scope', () => {
      expect(ROLE_GRANTS.HEAD_COACH['reviews.grade']).toBe('courseDivision');
      expect(ROLE_GRANTS.HEAD_COACH['assignments.prepare']).toBe('courseDivision');
    });

    it('H7: Head Coach does not moderate discussions', () => {
      expect(ROLE_GRANTS.HEAD_COACH).not.toHaveProperty('discussions.moderate');
    });

    it('D2: Teacher has no assignments.prepare (or grading) by default', () => {
      expect(ROLE_GRANTS.TEACHER).not.toHaveProperty('assignments.prepare');
      expect(ROLE_GRANTS.TEACHER).not.toHaveProperty('reviews.grade');
    });

    it('only coaches and head coaches grade; only students submit', () => {
      expect(APP_ROLES.filter((r) => 'reviews.grade' in ROLE_GRANTS[r])).toEqual(['MENTOR', 'HEAD_COACH']);
      expect(APP_ROLES.filter((r) => 'submissions.submit' in ROLE_GRANTS[r])).toEqual(['STUDENT']);
    });

    it('NEVER_GRANTABLE (plan §6.3) lists known permissions, including grading', () => {
      for (const p of NEVER_GRANTABLE) expect(PERMISSIONS).toContain(p);
      expect(NEVER_GRANTABLE).toContain('reviews.grade');
    });

    it('docs/PERMISSIONS.md contains exactly the catalogue matrix (documentation cannot drift)', () => {
      const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'PERMISSIONS.md'), 'utf8').replace(/\r\n/g, '\n');
      expect(doc).toContain(renderPermissionMatrix());
      for (const role of APP_ROLES) expect(doc).toContain('| `' + role + '` | ' + ROLE_LABELS[role] + ' |');
    });

    it('grantsForRole: catalogue entry for a known role, undefined otherwise', () => {
      expect(grantsForRole('MENTOR')).toBe(ROLE_GRANTS.MENTOR);
      for (const r of ['NOBODY', '', 'admin', '__proto__', 'constructor', 'toString']) {
        expect(grantsForRole(r)).toBeUndefined();
      }
    });
  });
});
