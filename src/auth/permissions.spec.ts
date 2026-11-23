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
      // appended 2026-11-19 (Test Management Phase 2): granted (own) and reported, so the student portal shows My tests
      'tests.submit',
      // appended 2026-11-19 (Test Management Phase 4): granted (own) and reported, so the student portal shows My results
      'tests.viewOwnResults',
    ]);
    expect(ROLE_PERMISSIONS.MENTOR).toEqual([
      'courses.view', 'resources.view', 'resources.manage',
      'assignments.view', 'assignments.prepare', 'reviews.grade',
      'discussions.participate', 'discussions.report', 'analytics.course', 'leaderboard.view',
      // appended 2026-11-19 (Test Management Phase 3): granted (authorised subjects, assigned submissions), reported for the marking queue
      'tests.mark',
      // appended 2026-11-21 (Olympiad levels): granted (their programmes' students), reported for the level control
      'students.classifyLevel',
      // appended 2026-11-23 (owner): coaches across their programmes — the Students and Test results pages
      'students.viewProgramme', 'tests.viewProgrammeResults',
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
      'schools.manage',   // appended 2026-11-12: already granted (ADMIN_GRANTS), now reported too
      'users.manageTeachers',   // appended 2026-11-13: already granted (ADMIN_GRANTS), now reported too
      // appended 2026-11-14 (owner decision D-5): already granted (ADMIN_GRANTS), now reported too
      'users.manageHeadCoaches', 'programmes.manageHeads', 'programmes.manageMembers', 'coaches.monitor', 'reports.view',
      // appended 2026-11-16 (account states): granted (ADMIN_GRANTS) and reported, so the status screens can show
      'users.viewStatusHistory', 'users.changeStatus', 'users.suspend', 'users.archive',
      // appended 2026-11-17 (bulk user operations)
      'users.bulkManage', 'users.export',
      // appended 2026-11-15 (form availability): granted (ADMIN_GRANTS), reported so the form-management screen shows
      'forms.view', 'forms.manageAvailability', 'forms.editMessages',
      // appended 2026-11-19 (countries, owner decision): granted (ADMIN_GRANTS), reported for the Countries screen
      'reference.manage',
      // appended 2026-11-19 (Test Management WS3, owner-approved plan): granted (ADMIN_GRANTS), reported for the Tests screens
      'tests.view', 'tests.manage', 'tests.manageMarkers',
      // appended 2026-11-19 (Test Management Phase 2): extensions and submission tracking
      'tests.extensions', 'tests.viewSubmissions',
      // appended 2026-11-19 (Test Management Phase 3): distribution and review — never marking (G4)
      'tests.distribute', 'tests.review',
      // appended 2026-11-19 (Test Management Phase 4): publication and its override, results, rankings, reports
      'tests.publishResults', 'tests.overridePublication', 'tests.viewResults', 'tests.viewRankings',
      // appended 2026-11-21 (owner): locked submissions — Administrators unlock one replacement
      'tests.authorizeResubmission',
      // appended 2026-11-21 (owner): Olympiad levels — User Managers classify students
      'students.classifyLevel',
      // appended 2026-11-22 (owner): custom reports — build and share
      'reports.build',
      // appended 2026-11-23 (owner): news subscribers — the mailing list and mailings
      'subscribers.manage',
      // appended 2026-11-23 (owner): view as another (lower-ranked) user, read only
      'users.impersonate',
    ]);
  });

  it('ADMIN reports users.manageTeachers (which it holds) and nothing it does not hold; no Admin-management or Super Admin permission was added', () => {
    expect(ROLE_PERMISSIONS.ADMIN).toContain('users.manageTeachers');
    expect(ROLE_GRANTS.ADMIN['users.manageTeachers']).toBe('global');
    // The reported list never over-reports: every entry is held by ADMIN.
    for (const p of ROLE_PERMISSIONS.ADMIN) expect(ROLE_GRANTS.ADMIN[p], p).toBeDefined();
    for (const p of ['users.manageAdmins', 'permissions.manageOverrides', 'settings.manageSystem', 'schools.syncDirectory'] as const) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(p);
    }
  });

  it('D-5 (2026-11-14): ADMIN reports the Head Coach administration it holds — exactly five names appended, all global grants', () => {
    const D5 = ['users.manageHeadCoaches', 'programmes.manageHeads', 'programmes.manageMembers', 'coaches.monitor', 'reports.view'] as const;
    const AS = ['users.viewStatusHistory', 'users.changeStatus', 'users.suspend', 'users.archive', 'users.bulkManage', 'users.export'] as const;
    const FORMS = ['forms.view', 'forms.manageAvailability', 'forms.editMessages'] as const;   // form availability, after AS
    const REF = ['reference.manage'] as const;   // countries (owner decision 2026-11-19), after the forms
    const TM = ['tests.view', 'tests.manage', 'tests.manageMarkers', 'tests.extensions', 'tests.viewSubmissions', 'tests.distribute', 'tests.review',
      'tests.publishResults', 'tests.overridePublication', 'tests.viewResults', 'tests.viewRankings',
      'tests.authorizeResubmission', 'students.classifyLevel', 'reports.build', 'subscribers.manage', 'users.impersonate'] as const;   // Test Management (2026-11-19, Phases 1–4; 2026-11-21 locked submissions, Olympiad levels), after countries
    expect(ROLE_PERMISSIONS.ADMIN.slice(-TM.length)).toEqual([...TM]);
    for (const p of TM) expect([p, ROLE_GRANTS.ADMIN[p]]).toEqual([p, 'global']);
    const tail = FORMS.length + REF.length + TM.length;
    expect(ROLE_PERMISSIONS.ADMIN.slice(-(D5.length + AS.length + tail), -(AS.length + tail))).toEqual([...D5]);
    for (const p of D5) expect([p, ROLE_GRANTS.ADMIN[p]]).toEqual([p, 'global']);
    // Additive only: the 25 original entries keep their order; then 2 + D-5, the account states and bulk operations, the forms, countries.
    expect(ROLE_PERMISSIONS.ADMIN.slice(-(AS.length + tail), -tail)).toEqual([...AS]);
    for (const p of AS) expect([p, ROLE_GRANTS.ADMIN[p]]).toEqual([p, 'global']);
    expect(ROLE_PERMISSIONS.ADMIN.slice(-tail, -(REF.length + TM.length))).toEqual([...FORMS]);
    for (const p of FORMS) expect([p, ROLE_GRANTS.ADMIN[p]]).toEqual([p, 'global']);
    expect(ROLE_PERMISSIONS.ADMIN.slice(-(REF.length + TM.length), -TM.length)).toEqual([...REF]);
    for (const p of REF) expect([p, ROLE_GRANTS.ADMIN[p]]).toEqual([p, 'global']);
    expect(ROLE_PERMISSIONS.ADMIN).toHaveLength(25 + 2 + D5.length + AS.length + FORMS.length + REF.length + TM.length);
    // Never reported to ADMIN (and never granted, except users.manageAdmins / permissions.view which stay unreported).
    for (const p of ['users.manageAdmins', 'permissions.view', 'permissions.manageOverrides', 'settings.manageSystem', 'schools.syncDirectory'] as const) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(p);
    }
  });

  it('ADMIN reports schools.manage (which it holds) and never schools.syncDirectory (Super Admin only)', () => {
    expect(ROLE_PERMISSIONS.ADMIN).toContain('schools.manage');
    expect(ROLE_GRANTS.ADMIN['schools.manage']).toBe('global');
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('schools.syncDirectory');
    expect(ROLE_GRANTS.ADMIN['schools.syncDirectory']).toBeUndefined();
  });

  it.each(ROLES)('every permission in the %s list is actually granted to that role (the list never over-reports)', (role) => {
    const grants = ROLE_GRANTS[role];
    for (const p of ROLE_PERMISSIONS[role]) expect([role, p, Object.hasOwn(grants, p)]).toEqual([role, p, true]);
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
      // Account states (2026-11-16)
      'users.viewStatusHistory': G, 'users.changeStatus': G, 'users.suspend': G, 'users.archive': G,
      // Bulk user operations (2026-11-17)
      'users.bulkManage': G, 'users.export': G,
      'forms.view': G, 'forms.manageAvailability': G, 'forms.editMessages': G,
      // Countries (owner decision 2026-11-19)
      'reference.manage': G,
      // Test Management (WS3, 2026-11-19)
      'tests.view': G, 'tests.manage': G, 'tests.manageMarkers': G,
      // Test Management, Phase 2: extensions and submission tracking
      'tests.extensions': G, 'tests.viewSubmissions': G,
      // Test Management, Phase 3: distribution and review (never tests.mark / tests.adjustMarks, G4)
      'tests.distribute': G, 'tests.review': G,
      // Test Management, Phase 4: publication and its override (Administrators only), results, rankings, reports
      'tests.publishResults': G, 'tests.overridePublication': G, 'tests.viewResults': G, 'tests.viewRankings': G,
      // Locked submissions (owner 2026-11-21): unlock one replacement (Administrators only)
      'tests.authorizeResubmission': G,
      // Olympiad levels (owner 2026-11-21): User Managers classify every student
      'students.classifyLevel': G,
      // Custom reports (owner 2026-11-22): build and share
      'reports.build': G,
      // News subscribers (owner 2026-11-23): the mailing list and mailings
      'subscribers.manage': G,
      // View as, read only (owner 2026-11-23): lower-ranked users only
      'users.impersonate': G,
    };
    const EXPECTED: Record<AppRole, Record<string, ScopeKind>> = {
      STUDENT: {
        'courses.view': D, 'resources.view': D, 'assignments.view': D,
        'courses.complete': O, 'submissions.submit': O, 'submissions.viewOwn': O,
        'discussions.participate': D, 'discussions.report': D, 'leaderboard.view': G,
        // Test Management, Phase 2 (2026-11-19): their own answers
        'tests.submit': O,
        // Phase 4: their own published results (no ranks)
        'tests.viewOwnResults': O,
      },
      // 2026-11-14: no course access (the course × division grants were dead — no TeacherAssignment exists).
      TEACHER: {
        'students.viewScoped': 'school', 'leaderboard.view': G,
        // Changed on purpose — owner decision 2026-11-23 (confirmed 2026-11-24): course homework progress and handing in
        // homework for their students are Teacher defaults (were individual delegations); an Administrator switches both off.
        'students.viewProgress': 'school', 'submissions.submitOnBehalf': 'school',
        // Test Management, Phase 2 (G2): submit for the verified students of their own schools
        'tests.submitForStudents': 'school',
        // Phase 4: published results of the verified students of their own schools (no ranks)
        'tests.viewSchoolResults': 'school',
      },
      MENTOR: {
        'courses.view': CD, 'resources.view': CD, 'resources.manage': CD,
        'assignments.view': CD, 'assignments.prepare': CD, 'reviews.grade': CD,
        'discussions.participate': CD, 'discussions.report': CD,
        'analytics.course': CD, 'leaderboard.view': G,
        // Test Management, Phase 3 (2026-11-19): blind marking — authorised subjects, assigned submissions
        'tests.mark': 'markerAuthorization',
        // Olympiad levels (owner 2026-11-21): the students of the coach's programmes
        'students.classifyLevel': P,
        // Owner 2026-11-23: every Coach, across the programmes they belong to (each removable per programme)
        'students.viewProgramme': P, 'tests.viewProgrammeResults': P,
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
        // Test Management (WS3, 2026-11-19): the subjects they head
        'tests.view': P, 'tests.manage': P, 'tests.manageMarkers': P,
        'tests.extensions': P, 'tests.viewSubmissions': P,
        // Phase 3: distribution, review, and choosing / adjusting the mark (G4: Head Coaches only)
        'tests.distribute': P, 'tests.review': P, 'tests.adjustMarks': P,
        // Phase 4: publication (NEVER the override), results, rankings, reports of the subjects they head
        'tests.publishResults': P, 'tests.viewResults': P, 'tests.viewRankings': P,
        // Olympiad levels (owner 2026-11-21): the students of the programmes they head
        'students.classifyLevel': P,
      },
      ADMIN: ADMIN_TABLE,
      SUPER_ADMIN: { ...ADMIN_TABLE, 'permissions.manageOverrides': G, 'settings.manageSystem': G, 'schools.syncDirectory': G, 'registrationData.manage': G },
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
      // + Test Management Phase 3 (G4, 2026-11-19): Administrators never mark, never edit or adjust marks.
      expect([...ADMIN_PROHIBITED].sort()).toEqual(['assignments.prepare', 'reviews.grade', 'tests.adjustMarks', 'tests.mark']);
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

    it('Test Management (WS3, Phase 1): Administrators everywhere, Head Coaches in the subjects they head; no Coach, Teacher or Student; RS1 unchanged', () => {
      for (const p of ['tests.view', 'tests.manage', 'tests.manageMarkers'] as const) {
        expect([p, APP_ROLES.filter((r) => p in ROLE_GRANTS[r])]).toEqual([p, ['HEAD_COACH', 'ADMIN', 'SUPER_ADMIN']]);
        expect(ROLE_GRANTS.HEAD_COACH[p]).toBe('programme');
        expect(ADMIN_PROHIBITED).not.toContain(p);   // managing tests is not marking (G4: marks are never Administrators')
        expect(NEVER_GRANTABLE).not.toContain(p);
      }
    });

    it('Test Management (WS3, Phase 2): extensions and tracking as Phase 1; Students submit their own; every Teacher submits for their school (G2), not a delegation', () => {
      for (const p of ['tests.extensions', 'tests.viewSubmissions'] as const) {
        expect([p, APP_ROLES.filter((r) => p in ROLE_GRANTS[r])]).toEqual([p, ['HEAD_COACH', 'ADMIN', 'SUPER_ADMIN']]);
        expect(ROLE_GRANTS.HEAD_COACH[p]).toBe('programme');
      }
      expect(APP_ROLES.filter((r) => 'tests.submit' in ROLE_GRANTS[r])).toEqual(['STUDENT']);
      expect(ROLE_GRANTS.STUDENT['tests.submit']).toBe('own');
      expect(APP_ROLES.filter((r) => 'tests.submitForStudents' in ROLE_GRANTS[r])).toEqual(['TEACHER']);
      expect(ROLE_GRANTS.TEACHER['tests.submitForStudents']).toBe('school');
      // Changed on purpose — owner decision 2026-11-23 (confirmed 2026-11-24): the course-assignment on-behalf submission
      // is now a Teacher default too (was: nobody by default, delegation only), school scope, and still grantable.
      expect(APP_ROLES.filter((r) => 'submissions.submitOnBehalf' in ROLE_GRANTS[r])).toEqual(['TEACHER']);
      expect(ROLE_GRANTS.TEACHER['submissions.submitOnBehalf']).toBe('school');
      for (const p of ['tests.extensions', 'tests.viewSubmissions', 'tests.submit', 'tests.submitForStudents'] as const) {
        expect(ADMIN_PROHIBITED).not.toContain(p);
        expect(NEVER_GRANTABLE).not.toContain(p);
      }
    });

    it('Test Management (WS3, Phase 3): distribution and review for Administrators and Head Coaches; choosing / adjusting marks for Head Coaches only (G4); marking for Coaches only', () => {
      for (const p of ['tests.distribute', 'tests.review'] as const) {
        expect([p, APP_ROLES.filter((r) => p in ROLE_GRANTS[r])]).toEqual([p, ['HEAD_COACH', 'ADMIN', 'SUPER_ADMIN']]);
        expect(ROLE_GRANTS.HEAD_COACH[p]).toBe('programme');
      }
      expect(APP_ROLES.filter((r) => 'tests.adjustMarks' in ROLE_GRANTS[r])).toEqual(['HEAD_COACH']);
      expect(APP_ROLES.filter((r) => 'tests.mark' in ROLE_GRANTS[r])).toEqual(['MENTOR']);
      expect(ROLE_GRANTS.MENTOR['tests.mark']).toBe('markerAuthorization');
      for (const p of ['tests.mark', 'tests.adjustMarks'] as const) expect(ADMIN_PROHIBITED).toContain(p);
      // The course-assignment grading permissions are unchanged.
      expect(ROLE_GRANTS.MENTOR['reviews.grade']).toBe('courseDivision');
      expect(ROLE_GRANTS.ADMIN['submissions.distribute']).toBe('global');
    });

    it('Test Management (WS3, Phase 4): publication for Administrators and Head Coaches; the override for Administrators only (never a Head Coach, never by individual grant); own results for Students, school results for Teachers; rankings never for Students or Teachers', () => {
      for (const p of ['tests.publishResults', 'tests.viewResults', 'tests.viewRankings'] as const) {
        expect([p, APP_ROLES.filter((r) => p in ROLE_GRANTS[r])]).toEqual([p, ['HEAD_COACH', 'ADMIN', 'SUPER_ADMIN']]);
        expect(ROLE_GRANTS.HEAD_COACH[p]).toBe('programme');
      }
      expect(APP_ROLES.filter((r) => 'tests.overridePublication' in ROLE_GRANTS[r])).toEqual(['ADMIN', 'SUPER_ADMIN']);
      expect(NEVER_GRANTABLE).toContain('tests.overridePublication');
      expect(APP_ROLES.filter((r) => 'tests.viewOwnResults' in ROLE_GRANTS[r])).toEqual(['STUDENT']);
      expect(ROLE_GRANTS.STUDENT['tests.viewOwnResults']).toBe('own');
      expect(APP_ROLES.filter((r) => 'tests.viewSchoolResults' in ROLE_GRANTS[r])).toEqual(['TEACHER']);
      expect(ROLE_GRANTS.TEACHER['tests.viewSchoolResults']).toBe('school');
      // Coaches: nothing beyond marking.
      for (const p of ['tests.publishResults', 'tests.overridePublication', 'tests.viewResults', 'tests.viewRankings', 'tests.viewOwnResults', 'tests.viewSchoolResults'] as const) {
        expect(ROLE_GRANTS.MENTOR).not.toHaveProperty(p);
      }
      // The course-assignment result permissions are unchanged and distinct.
      expect(ROLE_GRANTS.ADMIN['results.publish']).toBe('global');
      expect(ROLE_GRANTS.HEAD_COACH).not.toHaveProperty('results.publish');
    });

    it('H7: Head Coach does not moderate discussions', () => {
      expect(ROLE_GRANTS.HEAD_COACH).not.toHaveProperty('discussions.moderate');
    });

    it('D2: Teacher has no assignments.prepare (or grading) by default', () => {
      expect(ROLE_GRANTS.TEACHER).not.toHaveProperty('assignments.prepare');
      expect(ROLE_GRANTS.TEACHER).not.toHaveProperty('reviews.grade');
    });

    it('2026-11-14: Teacher holds no course × division grant (no course, resource, assignment or discussion access)', () => {
      for (const p of ['courses.view', 'resources.view', 'assignments.view', 'discussions.participate', 'discussions.report'] as const) {
        expect(ROLE_GRANTS.TEACHER).not.toHaveProperty(p);
      }
      expect(Object.values(ROLE_GRANTS.TEACHER)).not.toContain('courseDivision');
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
