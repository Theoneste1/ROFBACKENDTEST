/**
 * Roles and permissions (Phase 1 plan v5.2 §5; ADR-004 as amended).
 *
 * Permissions are code, not database rows: fixed role-based defaults for the
 * six user types, with the scope each grant applies to. Individual overrides
 * (Super Admin only) arrive in P1-09; custom profiles are deferred (D3).
 *
 * Two views of the same rules live here:
 *   - ROLE_GRANTS — the six-role catalogue (permission → scope kind), used by
 *     PermissionService and the permission guard (@RequirePermission);
 *   - ROLE_PERMISSIONS — today's lists for STUDENT, MENTOR and ADMIN, returned
 *     unchanged by GET /api/v1/me/permissions (P1-04 decision A1). The new
 *     granular names are added to that response when routes start using them.
 *
 * Until routes are converted (P1-06), access is still enforced by @Roles() plus
 * scope checks (AccessService). Permission checks never replace record-level or
 * programme-scope checks; those stay in the services.
 */
import type { Role } from '../generated/prisma/client.js';

export const PERMISSIONS = [
  // Learning
  'courses.view',
  'courses.complete',
  'resources.view',
  'resources.manage',            // scoped to assigned course × division for mentors
  // Assessment
  'assignments.view',
  'assignments.prepare',         // mentors only (scoped)
  'assignments.publish',         // admins only
  'submissions.submit',          // students only
  'submissions.viewOwn',
  'submissions.distribute',      // admins only
  'reviews.grade',               // mentors only — admins never grade
  'results.approve',             // admins only
  'results.publish',             // admins only
  // Community
  'discussions.participate',
  'discussions.report',
  'discussions.moderate',        // admins only
  // Insight
  'analytics.course',            // mentors (scoped) and admins
  'leaderboard.view',
  'reports.export',              // admins only
  // Administration
  'users.manage',
  'academicYears.manage',
  'enrollments.manage',
  'divisions.manage',
  'courses.manage',
  'mentorAssignments.manage',
  'mentorRequests.decide',
  'settings.manage',
  'email.bulkSend',
  'audit.view',
  'activity.view',
  // ── Added in Phase 1 (plan §5) ────────────────────────────────────────────
  'reports.view',
  'students.viewScoped',         // name, school, grade, division (+ participation for head coaches); never grades or contacts
  'users.view',
  'users.manageStudents',
  'users.manageCoaches',
  'users.manageTeachers',
  'users.manageHeadCoaches',
  'users.manageAdmins',
  'programmes.manageHeads',
  'programmes.manageMembers',
  'coaches.monitor',
  'settings.manageSystem',       // Super Admin only
  'permissions.view',
  'permissions.manageOverrides', // Super Admin only
  // ── P1-11: teacher delegations — no role holds them by default; granted to an
  //    individual TEACHER (P1-09 override, GRANT), school scope only ─────────
  'students.viewProfile',        // a student's profile (no contact details)
  'students.viewProgress',       // assignment availability and submission history (no grades, D7)
  'submissions.submitOnBehalf',  // submit for a student; the student stays the owner
  // ── School administration: student–school verification (Administrators, Super Admins) ──
  'schools.manage',
  // ── School directory S2b: approve and apply a directory sync, resolve its conflicts (Super Admins only; never grantable) ──
  'schools.syncDirectory',
  // ── Account states (2026-11-16): Administrators and Super Admins, global; plus management of the account's role ──
  'users.viewStatusHistory',  // an account's status history (who, when, why)
  'users.changeStatus',       // deactivate / reactivate
  'users.suspend',            // suspend / lift a suspension
  'users.archive',            // archive / restore an archived account
  // ── Bulk user operations (2026-11-17): Administrators and Super Admins, global ──
  'users.bulkManage',         // run bulk actions (each action also needs its own permission; each account the role policy)
  'users.export',             // export the selected users' records (CSV; no dates of birth or phone numbers)
  // ── Form availability (registration and website forms; Administrators, Super Admins) ──
  'forms.view',                  // the administrators' view of every form, its schedule and its history
  'forms.manageAvailability',    // open, close and schedule a form
  'forms.editMessages',          // closed-form message, instructions, contact e-mail and support link
  // ── Countries (design area 1 as simplified by the owner, 2026-11-19; Administrators, Super Admins, global) ──
  'reference.manage',            // correct a country's name or calling code
  // ── Test Management (WS3, owner spec and plan approved 2026-11-19): Administrators (every subject) and Head Coaches
  //    (the subjects they head, programme scope — checked by the service on every request). Coaches, Teachers and
  //    Students hold none in Phase 1. Marking (Phase 3) is a separate permission in ADMIN_PROHIBITED (G4). ──
  'tests.view',                  // list and read tests, their questions and files (incl. the marking guide)
  'tests.manage',                // create, edit, publish, delete tests; questions; the paper and the marking guide
  'tests.manageMarkers',         // authorise / revoke coaches as markers of a subject (reason on revoke)
  // ── Test Management, Phase 2 (WS3, 2026-11-19): deadlines, extensions, submissions ──
  'tests.extensions',            // grant / edit / cancel deadline extensions (Administrators; Head Coaches: subjects they head)
  'tests.viewSubmissions',       // submission tracking and every version, with submitter and extension status (same scope)
  'tests.authorizeResubmission', // Administrators only (owner 2026-11-21): unlock a submitted (locked) answer for ONE
                                 // replacement, with a reason (audited); never a Head Coach, teacher or student (never
                                 // grantable by an individual override)
  'tests.submit',                // Students: submit / replace their own answer to a test of their division (own)
  'tests.submitForStudents',     // Teachers (G2: any teacher of the school, primary or secondary): submit for VERIFIED
                                 // students of their own schools (school). Separate from submissions.submitOnBehalf.
  // ── Test Management, Phase 3 (WS3, 2026-11-19): distribution, blind marking, second marking, review, approval, locking ──
  'tests.distribute',            // distribute submissions evenly / assign / reassign to authorised coaches; progress per coach
  'tests.review',                // review markings with identity: approve (locks), return (comment), request second marking,
                                 // unlock (reason); status history and the mark-change log
  'tests.adjustMarks',           // choose the first, second or an ADJUSTED mark (reason): the subject's Head Coach only (G4)
  'tests.mark',                  // Coaches: mark (blind) the submissions ASSIGNED to them in a subject they are AUTHORISED for
  // ── Test Management, Phase 4 (WS3, 2026-11-19): publication, results, rankings, reports ──
  'tests.publishResults',        // preview and publish the APPROVED results of a test (blocked while any is unapproved)
  'tests.overridePublication',   // Administrators only: publish although results are unapproved (mandatory reason, audited);
                                 // never a Head Coach (not in their grants; never grantable by an individual override)
  'tests.viewResults',           // results with identity, the results report and its CSV exports, the reporting overview
  'tests.viewRankings',          // internal rankings: overall, by division, by school (never students or teachers)
  'tests.viewOwnResults',        // Students: their own PUBLISHED results (marks per question, total, comments; no ranks)
  'tests.viewSchoolResults',     // Teachers: PUBLISHED results of the verified students of their own schools (no ranks)
  // ── Olympiad levels (owner 2026-11-21) ──
  'students.classifyLevel',      // set a student's Olympiad level (Junior / Middle / Senior) or return it to the grade's
                                 // suggestion, with a reason (history kept): User Managers (Administrators, global); Coaches
                                 // and Head Coaches for the students of their programmes (programme)
  // ── Custom reports (owner 2026-11-22) ──
  'reports.build',               // build custom reports (any source), see and manage every report and who may use it
                                 // (view / download / edit grants): Administrators (global). Shared reports need no
                                 // permission: their grants decide (src/custom-reports)
  // ── View as (owner 2026-11-23) ──
  'users.impersonate',           // view the platform exactly as a LOWER-ranked user sees it, READ ONLY (src/auth/view-as):
                                 // Administrators and Super Admins by default; grantable to a Head Coach by an individual
                                 // override (then Students, Teachers and Coaches only); removable per user (DENY)
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The six user types (COACH is stored as MENTOR) — exactly the Prisma Role enum (M1). */
export const APP_ROLES = ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN'] as const;
export type AppRole = (typeof APP_ROLES)[number];

// Compile-time check: APP_ROLES and the database Role enum are the same set.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const APP_ROLES_MATCH_DATABASE: Same<AppRole, Role> = true;

/** Where a grant applies. Enforced by the services (AccessService), not by the permission guard. */
export type ScopeKind = 'own' | 'division' | 'courseDivision' | 'programme' | 'school' | 'global'
  /** Test Management, Phase 3: the subjects the coach is AUTHORISED to mark (MarkerAuthorization), and only the
   *  submissions assigned to them — both checked by the service on every request. */
  | 'markerAuthorization';

export const ROLE_LABELS: Record<AppRole, string> = {
  STUDENT:     'Student',
  TEACHER:     'Teacher',
  MENTOR:      'Coach',
  HEAD_COACH:  'Head Coach',
  ADMIN:       'Administrator',
  SUPER_ADMIN: 'Super Administrator',
};

type Grants = Readonly<Partial<Record<Permission, ScopeKind>>>;

const ADMIN_GRANTS: Grants = {
  // today's 25
  'courses.view': 'global', 'resources.view': 'global', 'resources.manage': 'global',
  'assignments.view': 'global', 'assignments.publish': 'global', 'submissions.distribute': 'global',
  'results.approve': 'global', 'results.publish': 'global',
  'discussions.participate': 'global', 'discussions.report': 'global', 'discussions.moderate': 'global',
  'analytics.course': 'global', 'leaderboard.view': 'global', 'reports.export': 'global',
  'users.manage': 'global', 'academicYears.manage': 'global', 'enrollments.manage': 'global',
  'divisions.manage': 'global', 'courses.manage': 'global', 'mentorAssignments.manage': 'global',
  'mentorRequests.decide': 'global', 'settings.manage': 'global', 'email.bulkSend': 'global',
  'audit.view': 'global', 'activity.view': 'global',
  // granular names administrators already effectively hold today
  'reports.view': 'global', 'students.viewScoped': 'global', 'users.view': 'global',
  'users.manageStudents': 'global', 'users.manageCoaches': 'global', 'users.manageTeachers': 'global',
  'users.manageHeadCoaches': 'global',
  'users.manageAdmins': 'global',   // A7: kept until the Super Admin boundary (P1-08)
  'programmes.manageHeads': 'global', 'programmes.manageMembers': 'global', 'coaches.monitor': 'global',
  'permissions.view': 'global',
  'schools.manage': 'global',
  // Account states (2026-11-16)
  'users.viewStatusHistory': 'global', 'users.changeStatus': 'global', 'users.suspend': 'global', 'users.archive': 'global',
  // Bulk user operations (2026-11-17)
  'users.bulkManage': 'global', 'users.export': 'global',
  'forms.view': 'global', 'forms.manageAvailability': 'global', 'forms.editMessages': 'global',
  // Countries (owner decision 2026-11-19)
  'reference.manage': 'global',
  // Test Management (WS3, 2026-11-19): every subject
  'tests.view': 'global', 'tests.manage': 'global', 'tests.manageMarkers': 'global',
  // Test Management, Phase 2: extensions and submission tracking, every subject
  'tests.extensions': 'global', 'tests.viewSubmissions': 'global', 'tests.authorizeResubmission': 'global',
  // Test Management, Phase 3: distribution and review, every subject. Never tests.mark or tests.adjustMarks (G4).
  'tests.distribute': 'global', 'tests.review': 'global',
  // Test Management, Phase 4: publication (and its override: Administrators only), results, rankings, reports.
  'tests.publishResults': 'global', 'tests.overridePublication': 'global', 'tests.viewResults': 'global', 'tests.viewRankings': 'global',
  // Olympiad levels (owner 2026-11-21): User Managers classify every student.
  'students.classifyLevel': 'global',
  // Custom reports (owner 2026-11-22): build reports and share them.
  'reports.build': 'global',
  // View as, read only (owner 2026-11-23): lower-ranked users only (view-as.rules.ts).
  'users.impersonate': 'global',
};

/**
 * The six-role catalogue — a transcription of the approved matrix (plan §5).
 * SUPER_ADMIN is written out explicitly (RS1: no inheritance from another role).
 */
export const ROLE_GRANTS: Readonly<Record<AppRole, Grants>> = {
  STUDENT: {
    'courses.view': 'division', 'resources.view': 'division', 'assignments.view': 'division',
    'courses.complete': 'own', 'submissions.submit': 'own', 'submissions.viewOwn': 'own',
    'discussions.participate': 'division', 'discussions.report': 'division',
    'leaderboard.view': 'global',
    // Test Management, Phase 2 (2026-11-19): their own answers to tests of their division
    'tests.submit': 'own',
    // Test Management, Phase 4 (2026-11-19): their own PUBLISHED results (never a rank)
    'tests.viewOwnResults': 'own',
  },
  TEACHER: {
    // No course access (owner decision 2026-11-14): teachers are scoped by school (P1-11) and no
    // course × division teacher assignment exists, so the course × division grants courses.view,
    // resources.view, assignments.view, discussions.participate and discussions.report were removed
    // (dead grants: no service ever let a Teacher through on them).
    // P1-11 (owner decision 2026-11-10): students of the teacher's assigned schools only
    // (TeacherSchoolAssignment): name, school, grade, division — never grades or contact details.
    'students.viewScoped': 'school',
    'leaderboard.view': 'global',
    // students.viewProfile, students.viewProgress, submissions.submitOnBehalf: only by
    // an individual GRANT (Administrator or Super Admin), school scope (P1-11)
    // Test Management, Phase 2 (G2, owner decision 2026-11-19): every teacher of a school, primary or secondary, submits
    // test answers for the students of their own schools (verified or pending claim, owner 2026-11-21) — a default, not a
    // delegation; an Administrator revokes it per teacher (a DENY override) without touching the account.
    'tests.submitForStudents': 'school',
    // Test Management, Phase 4 (2026-11-19): published results of the verified students of their own schools (no ranks)
    'tests.viewSchoolResults': 'school',
  },
  MENTOR: {
    'courses.view': 'courseDivision', 'resources.view': 'courseDivision', 'resources.manage': 'courseDivision',
    'assignments.view': 'courseDivision', 'assignments.prepare': 'courseDivision', 'reviews.grade': 'courseDivision',
    'discussions.participate': 'courseDivision', 'discussions.report': 'courseDivision',
    'analytics.course': 'courseDivision', 'leaderboard.view': 'global',
    // Test Management, Phase 3 (2026-11-19): blind marking of the submissions assigned to them, in the subjects they are
    // authorised for (an interest never grants it).
    'tests.mark': 'markerAuthorization',
    // Olympiad levels (owner 2026-11-21): the students of the programmes the coach belongs to.
    'students.classifyLevel': 'programme',
  },
  HEAD_COACH: {
    'courses.view': 'programme', 'resources.view': 'programme', 'assignments.view': 'programme',
    // H4: only through a course × division assignment created by an Administrator (+ normal distribution);
    // the services require that assignment (AccessService.assertMentorOf, the review's assigned coach).
    'assignments.prepare': 'courseDivision', 'reviews.grade': 'courseDivision',
    'discussions.participate': 'programme', 'discussions.report': 'programme',
    // H7: no discussions.moderate
    'analytics.course': 'programme', 'leaderboard.view': 'global',
    'reports.view': 'programme', 'students.viewScoped': 'programme',
    'users.view': 'programme', 'users.manageStudents': 'programme', 'users.manageCoaches': 'programme',
    'programmes.manageMembers': 'programme', 'mentorAssignments.manage': 'programme',
    'coaches.monitor': 'programme', 'activity.view': 'programme',
    // Test Management (WS3, 2026-11-19): only the subjects (programmes) they head; any Head Coach of the subject may act.
    'tests.view': 'programme', 'tests.manage': 'programme', 'tests.manageMarkers': 'programme',
    'tests.extensions': 'programme', 'tests.viewSubmissions': 'programme',
    // Phase 3: distribution, review and — only the subject's Head Coaches (G4) — choosing / adjusting the mark.
    'tests.distribute': 'programme', 'tests.review': 'programme', 'tests.adjustMarks': 'programme',
    // Phase 4: publication (never the override), results, rankings and reports of the subjects they head.
    'tests.publishResults': 'programme', 'tests.viewResults': 'programme', 'tests.viewRankings': 'programme',
    // Olympiad levels (owner 2026-11-21): the students of the programmes they head.
    'students.classifyLevel': 'programme',
  },
  ADMIN: ADMIN_GRANTS,
  SUPER_ADMIN: {
    'courses.view': 'global', 'resources.view': 'global', 'resources.manage': 'global',
    'assignments.view': 'global', 'assignments.publish': 'global', 'submissions.distribute': 'global',
    'results.approve': 'global', 'results.publish': 'global',
    'discussions.participate': 'global', 'discussions.report': 'global', 'discussions.moderate': 'global',
    'analytics.course': 'global', 'leaderboard.view': 'global', 'reports.export': 'global',
    'users.manage': 'global', 'academicYears.manage': 'global', 'enrollments.manage': 'global',
    'divisions.manage': 'global', 'courses.manage': 'global', 'mentorAssignments.manage': 'global',
    'mentorRequests.decide': 'global', 'settings.manage': 'global', 'email.bulkSend': 'global',
    'audit.view': 'global', 'activity.view': 'global',
    'reports.view': 'global', 'students.viewScoped': 'global', 'users.view': 'global',
    'users.manageStudents': 'global', 'users.manageCoaches': 'global', 'users.manageTeachers': 'global',
    'users.manageHeadCoaches': 'global', 'users.manageAdmins': 'global',
    'programmes.manageHeads': 'global', 'programmes.manageMembers': 'global', 'coaches.monitor': 'global',
    'permissions.view': 'global', 'permissions.manageOverrides': 'global', 'settings.manageSystem': 'global',
    'schools.manage': 'global', 'schools.syncDirectory': 'global',
    'users.viewStatusHistory': 'global', 'users.changeStatus': 'global', 'users.suspend': 'global', 'users.archive': 'global',
    'users.bulkManage': 'global', 'users.export': 'global',
    'forms.view': 'global', 'forms.manageAvailability': 'global', 'forms.editMessages': 'global',
    'reference.manage': 'global',
    'tests.view': 'global', 'tests.manage': 'global', 'tests.manageMarkers': 'global',
    'tests.extensions': 'global', 'tests.viewSubmissions': 'global', 'tests.authorizeResubmission': 'global',
    'tests.distribute': 'global', 'tests.review': 'global',
    'tests.publishResults': 'global', 'tests.overridePublication': 'global', 'tests.viewResults': 'global', 'tests.viewRankings': 'global',
    'students.classifyLevel': 'global',
    'reports.build': 'global',
    'users.impersonate': 'global',
  },
};

/** Roles that administer and must never grade or author assignments (RS1, C7) — whatever the source of a grant. */
export const ADMINISTRATIVE_ROLES: readonly AppRole[] = ['ADMIN', 'SUPER_ADMIN'];
export const ADMIN_PROHIBITED: readonly Permission[] = [
  'reviews.grade', 'assignments.prepare',
  // Test Management, Phase 3 (G4): Administrators never mark, and never edit or adjust marks.
  'tests.mark', 'tests.adjustMarks',
];

/** Never grantable to anyone by an individual override (plan §6.3; used by P1-09). */
export const NEVER_GRANTABLE: readonly Permission[] = [
  'reviews.grade', 'results.approve', 'results.publish', 'submissions.distribute',
  'users.manageAdmins', 'permissions.view', 'permissions.manageOverrides', 'settings.manageSystem',
  'schools.syncDirectory',
  // Test Management, Phase 4 (owner spec 10.1): the publication override belongs to Administrators alone; a Head Coach can
  // never receive it, not even by an individual override.
  'tests.overridePublication',
  // Locked submissions (owner 2026-11-21): only Administrators unlock a submitted answer; nobody else may receive it.
  'tests.authorizeResubmission',
];

// ── Legacy lists, returned unchanged by GET /me/permissions (decision A1) ────

/** The roles that existed before Phase 1 (their GET /me/permissions list is frozen, A1). */
export type LegacyRole = 'STUDENT' | 'MENTOR' | 'ADMIN';

export const ROLE_PERMISSIONS: Record<LegacyRole, readonly Permission[]> = {
  STUDENT: [
    'courses.view', 'courses.complete', 'resources.view',
    'assignments.view', 'submissions.submit', 'submissions.viewOwn',
    'discussions.participate', 'discussions.report', 'leaderboard.view',
    // Appended (additive, Test Management Phase 2, 2026-11-19): students hold it (own) and the /me/tests routes require
    // it; listed so the frontend shows My tests.
    'tests.submit',
    // Appended (additive, Test Management Phase 4, 2026-11-19): their own published results (the /me/test-results routes).
    'tests.viewOwnResults',
  ],
  MENTOR: [
    'courses.view', 'resources.view', 'resources.manage',
    'assignments.view', 'assignments.prepare', 'reviews.grade',
    'discussions.participate', 'discussions.report', 'analytics.course', 'leaderboard.view',
    // Appended (additive, Test Management Phase 3, 2026-11-19): coaches hold it (authorised subjects, assigned
    // submissions) and the /marking routes require it; listed so the coach portal shows the marking queue.
    'tests.mark',
    // Appended (additive, Olympiad levels, owner 2026-11-21): coaches hold it (their programmes' students); listed so the
    // coach sees the Olympiad level control.
    'students.classifyLevel',
  ],
  ADMIN: [
    'courses.view', 'resources.view', 'resources.manage',
    'assignments.view', 'assignments.publish', 'submissions.distribute',
    'results.approve', 'results.publish',
    'discussions.participate', 'discussions.report', 'discussions.moderate',
    'analytics.course', 'leaderboard.view', 'reports.export',
    'users.manage', 'academicYears.manage', 'enrollments.manage', 'divisions.manage', 'courses.manage',
    'mentorAssignments.manage', 'mentorRequests.decide', 'settings.manage', 'email.bulkSend',
    'audit.view', 'activity.view',
    // Appended (additive): ADMIN already holds it (ADMIN_GRANTS) and 35 routes require it. Without it
    // here, GET /me/permissions under-reported what the backend allows. schools.syncDirectory is
    // Super-Admin-only and never listed for ADMIN.
    'schools.manage',
    // Appended (additive, owner decision 2026-11-13): ADMIN already holds it (ADMIN_GRANTS, global) and the
    // Teacher routes require it; without it here the frontend hid Teacher administration from ADMINs.
    'users.manageTeachers',
    // Appended (additive, owner decision D-5, 2026-11-14): Administrators manage Head Coaches within their
    // administrative responsibilities. ADMIN already holds all five (ADMIN_GRANTS, global) and the routes
    // require them (Head Coach accounts, programme heads and members, coach monitoring, scoped reports);
    // without them here the frontend hid those screens from ADMINs. users.manageAdmins, permissions.*,
    // settings.manageSystem and schools.syncDirectory are still never listed for ADMIN.
    'users.manageHeadCoaches', 'programmes.manageHeads', 'programmes.manageMembers', 'coaches.monitor', 'reports.view',
    // Appended (additive, account states 2026-11-16): ADMIN holds them (ADMIN_GRANTS) and the status routes need them.
    'users.viewStatusHistory', 'users.changeStatus', 'users.suspend', 'users.archive',
    // Appended (additive, bulk user operations 2026-11-17)
    'users.bulkManage', 'users.export',
    // Appended (additive, form availability 2026-11-15): ADMIN holds them (ADMIN_GRANTS, global) and the form routes
    // require them; listed so the frontend can show the form-management screen.
    'forms.view', 'forms.manageAvailability', 'forms.editMessages',
    // Appended (additive, countries, owner decision 2026-11-19): ADMIN holds it (ADMIN_GRANTS, global) and the country
    // administration routes require it; listed so the frontend shows the Countries screen.
    'reference.manage',
    // Appended (additive, Test Management WS3, owner-approved plan 2026-11-19): ADMIN holds them (ADMIN_GRANTS, global) and
    // the test-management routes require them; listed so the frontend shows the Tests screens.
    'tests.view', 'tests.manage', 'tests.manageMarkers',
    // Appended (additive, Test Management Phase 2, 2026-11-19): extensions and submission tracking.
    'tests.extensions', 'tests.viewSubmissions',
    // Appended (additive, Test Management Phase 3, 2026-11-19): distribution and review (never marking, G4).
    'tests.distribute', 'tests.review',
    // Appended (additive, Test Management Phase 4, 2026-11-19): publication and its override, results, rankings, reports.
    'tests.publishResults', 'tests.overridePublication', 'tests.viewResults', 'tests.viewRankings',
    // appended 2026-11-21 (owner): unlock a locked test submission for one replacement (Administrators only)
    'tests.authorizeResubmission',
    // appended 2026-11-21 (owner): Olympiad levels — User Managers classify students
    'students.classifyLevel',
    // appended 2026-11-22 (owner): custom reports — build and share
    'reports.build',
    // appended 2026-11-23 (owner): view as another (lower-ranked) user, read only
    'users.impersonate',
  ],
};

export function permissionsFor(role: LegacyRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** The catalogue entry for a stored role value, or undefined for any role the catalogue does not know. */
export function grantsForRole(role: string): Grants | undefined {
  return (APP_ROLES as readonly string[]).includes(role) ? ROLE_GRANTS[role as AppRole] : undefined;
}
