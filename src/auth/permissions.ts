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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The six user types (COACH is stored as MENTOR) — exactly the Prisma Role enum (M1). */
export const APP_ROLES = ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN'] as const;
export type AppRole = (typeof APP_ROLES)[number];

// Compile-time check: APP_ROLES and the database Role enum are the same set.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const APP_ROLES_MATCH_DATABASE: Same<AppRole, Role> = true;

/** Where a grant applies. Enforced by the services (AccessService), not by the permission guard. */
export type ScopeKind = 'own' | 'division' | 'courseDivision' | 'programme' | 'school' | 'global';

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
  },
  TEACHER: {
    'courses.view': 'courseDivision', 'resources.view': 'courseDivision', 'assignments.view': 'courseDivision',
    'discussions.participate': 'courseDivision', 'discussions.report': 'courseDivision',
    // P1-11 (owner decision 2026-11-10): students of the teacher's assigned schools only
    // (TeacherSchoolAssignment): name, school, grade, division — never grades or contact details.
    'students.viewScoped': 'school',
    'leaderboard.view': 'global',
    // assignments.prepare: only by individual override (D2, P1-09)
    // students.viewProfile, students.viewProgress, submissions.submitOnBehalf: only by
    // an individual GRANT (Administrator or Super Admin), school scope (P1-11)
  },
  MENTOR: {
    'courses.view': 'courseDivision', 'resources.view': 'courseDivision', 'resources.manage': 'courseDivision',
    'assignments.view': 'courseDivision', 'assignments.prepare': 'courseDivision', 'reviews.grade': 'courseDivision',
    'discussions.participate': 'courseDivision', 'discussions.report': 'courseDivision',
    'analytics.course': 'courseDivision', 'leaderboard.view': 'global',
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
    'schools.manage': 'global',
  },
};

/** Roles that administer and must never grade or author assignments (RS1, C7) — whatever the source of a grant. */
export const ADMINISTRATIVE_ROLES: readonly AppRole[] = ['ADMIN', 'SUPER_ADMIN'];
export const ADMIN_PROHIBITED: readonly Permission[] = ['reviews.grade', 'assignments.prepare'];

/** Never grantable to anyone by an individual override (plan §6.3; used by P1-09). */
export const NEVER_GRANTABLE: readonly Permission[] = [
  'reviews.grade', 'results.approve', 'results.publish', 'submissions.distribute',
  'users.manageAdmins', 'permissions.view', 'permissions.manageOverrides', 'settings.manageSystem',
];

// ── Legacy lists, returned unchanged by GET /me/permissions (decision A1) ────

/** The roles that existed before Phase 1 (their GET /me/permissions list is frozen, A1). */
export type LegacyRole = 'STUDENT' | 'MENTOR' | 'ADMIN';

export const ROLE_PERMISSIONS: Record<LegacyRole, readonly Permission[]> = {
  STUDENT: [
    'courses.view', 'courses.complete', 'resources.view',
    'assignments.view', 'submissions.submit', 'submissions.viewOwn',
    'discussions.participate', 'discussions.report', 'leaderboard.view',
  ],
  MENTOR: [
    'courses.view', 'resources.view', 'resources.manage',
    'assignments.view', 'assignments.prepare', 'reviews.grade',
    'discussions.participate', 'discussions.report', 'analytics.course', 'leaderboard.view',
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
  ],
};

export function permissionsFor(role: LegacyRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** The catalogue entry for a stored role value, or undefined for any role the catalogue does not know. */
export function grantsForRole(role: string): Grants | undefined {
  return (APP_ROLES as readonly string[]).includes(role) ? ROLE_GRANTS[role as AppRole] : undefined;
}
