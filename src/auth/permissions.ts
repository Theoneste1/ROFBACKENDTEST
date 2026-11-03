/**
 * Roles and permissions.
 *
 * Roles are stored on User.role (STUDENT, MENTOR, ADMIN). What each role may
 * do is defined here, in one place. The API enforces these rules with
 * @Roles() on every route plus scope checks (AccessService); this map is the
 * human- and frontend-readable statement of the same rules
 * (GET /api/v1/me/permissions), and a unit test keeps it consistent with the
 * route decorators.
 *
 * Permissions are code, not database rows: there are three fixed roles and the
 * rules are part of the academic workflow (e.g. administrators never grade).
 */
import type { Role } from '../generated/prisma/client.js';

export const PERMISSIONS = [
  // Learning
  'courses.view',
  'courses.complete',
  'resources.view',
  'resources.manage',            // scoped to assigned course × division for mentors
  'liveSessions.view',
  'liveSessions.manage',         // scoped for mentors
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  STUDENT: [
    'courses.view', 'courses.complete', 'resources.view', 'liveSessions.view',
    'assignments.view', 'submissions.submit', 'submissions.viewOwn',
    'discussions.participate', 'discussions.report', 'leaderboard.view',
  ],
  MENTOR: [
    'courses.view', 'resources.view', 'resources.manage', 'liveSessions.view', 'liveSessions.manage',
    'assignments.view', 'assignments.prepare', 'reviews.grade',
    'discussions.participate', 'discussions.report', 'analytics.course', 'leaderboard.view',
  ],
  ADMIN: [
    'courses.view', 'resources.view', 'resources.manage', 'liveSessions.view', 'liveSessions.manage',
    'assignments.view', 'assignments.publish', 'submissions.distribute',
    'results.approve', 'results.publish',
    'discussions.participate', 'discussions.report', 'discussions.moderate',
    'analytics.course', 'leaderboard.view', 'reports.export',
    'users.manage', 'academicYears.manage', 'enrollments.manage', 'divisions.manage', 'courses.manage',
    'mentorAssignments.manage', 'mentorRequests.decide', 'settings.manage', 'email.bulkSend',
    'audit.view', 'activity.view',
  ],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
