/**
 * Reviewed exceptions for the role-check scanner (role-checks.spec.ts).
 *
 * Each entry is a caller-role decision whose default branch is NOT a refusal,
 * accepted because that default is the less-privileged outcome (or the value
 * is used safely). `code` is the normalised source text of the flagged node:
 * if the code changes, the entry stops matching and must be reviewed again.
 * Entries that match nothing fail the test (no stale exceptions).
 */
export type RoleRule = 'U1' | 'U2' | 'U3' | 'U4' | 'U5' | 'U6';

export interface AllowlistEntry {
  /** Path relative to the repository root. */
  file:   string;
  rule:   RoleRule;
  code:   string;
  /** Why the default is safe. */
  reason: string;
}

export const ROLE_CHECK_ALLOWLIST: readonly AllowlistEntry[] = [
  // ── Permission layer (/me/permissions) ─────────────────────────────────────
  {
    file: 'src/auth/permission.service.ts', rule: 'U6', code: 'return user.role;',
    reason: "roleOf(): the single place PermissionService reads the role. Every use maps an unknown role to least privilege: grantsForRole() → no grants, permissionsFor() → [], roleLabel → null, isAdministrative() → false; describe() returns the caller's own role to the caller.",
  },
  {
    file: 'src/auth/permission.service.ts', rule: 'U4', code: 'isCourseWorker(user)',
    reason: 'courseDivisions(): only a coach or Head Coach (H4) has course × division teaching scopes; every other role (including an unsupported one) gets the empty list — the least-privileged result. Informational only; no access decision.',
  },
  // ── Programme scope (P1-10) ────────────────────────────────────────────────
  {
    file: 'src/common/access/access.service.ts', rule: 'U4', code: 'isHeadCoach(user)',
    reason: 'headedProgrammes(): only a HEAD_COACH heads programmes; every other role (including an unsupported one) heads none — the empty list, the least-privileged result. Callers that make access decisions (programmeScope(), the mentor-assignment filter) dispatch positively and refuse other roles.',
  },
  {
    file: 'src/users/user-provisioning.service.ts', rule: 'U6', code: 'pendingApproval = isHeadCoach(caller)',
    reason: "inviteCoachToProgramme(): only callers holding users.manageCoaches reach this line (permission guard, then assertCanInviteCoach) — Administrators (global, approved at once) or a Head Coach (programme scope, pending). The value only makes a Head Coach's invitation MORE restricted; no other role can get here.",
  },
  // ── Teacher school scope (P1-11) ───────────────────────────────────────────
  {
    file: 'src/common/access/access.service.ts', rule: 'U4', code: 'isTeacher(user)',
    reason: 'teacherSchools(): only a TEACHER has school assignments; every other role (including an unsupported one) gets the empty list — the least-privileged result, which schoolStudentsFilter() turns into "matches nobody".',
  },
  {
    file: 'src/submissions/submissions.service.ts', rule: 'U6', code: 'submittedByRole: actor.role',
    reason: 'submit(): records WHO submitted on a student\'s behalf (P1-11) in the activity metadata — attribution data, not an access decision.',
  },
  {
    file: 'src/teachers/teacher-students.service.ts', rule: 'U6', code: 'role: user.role',
    reason: "submit(): returns the submitting teacher's own role in submittedBy (P1-11) — attribution data echoed to the caller, not an access decision.",
  },
  // ── Administrator request audit (P1-08) ────────────────────────────────────
  {
    file: 'src/audit/admin-request-audit.middleware.ts', rule: 'U1', code: '!user || !isAdmin(user)',
    reason: 'Chooses whether to WRITE an audit row after the response (ADMIN / SUPER_ADMIN state-changing requests); every other request is unaffected. Not an access decision: guards decide.',
  },
  // ── Course resources ───────────────────────────────────────────────────────
  {
    file: 'src/courses/course-resources.service.ts', rule: 'U3', code: 'isStudent(user)',
    reason: "serveFile(): records a student's resource view (activity tracking) after access was already checked by assertCanRead(); not an access decision.",
  },
  // ── Leaderboard ────────────────────────────────────────────────────────────
  {
    file: 'src/leaderboard/leaderboard.service.ts', rule: 'U2',
    code: 'isStaff(user) ? `${r.firstName} ${r.lastName}` : `${r.firstName} ${r.lastName.charAt(0)}.`',
    reason: 'Default (any non-staff role) is the anonymised name — the less-privileged view. Unsupported roles are refused earlier (resolveDivision).',
  },
  // ── Submissions ────────────────────────────────────────────────────────────
  {
    file: 'src/submissions/submissions.service.ts', rule: 'U6', code: '...(isStaff(user) && { by: e.actor })',
    reason: 'attemptHistory(): only staff see who requested a resubmission; every other role gets the entry without the actor.',
  },
  {
    file: 'src/submissions/submissions.service.ts', rule: 'U2',
    code: 'isStaff(user) ? (s.currentReview ?? s.publishedReview) : s.publishedReview',
    reason: 'serveFeedbackFile(): default is the published review only (what a student may see); callers were already restricted by loadForCaller().',
  },
  {
    file: 'src/submissions/submissions.service.ts', rule: 'U6',
    code: 'allowed = s && (isAdmin(user) || (isStudent(user) && s.studentId === user.id) || (isCourseWorker(user) && s.currentReview?.mentor.id === user.id))',
    reason: 'loadForCaller(): positive membership test per role; anything else leaves allowed false, which throws 404.',
  },
  // ── Discussions ────────────────────────────────────────────────────────────
  {
    file: 'src/discussions/discussions.service.ts', rule: 'U6', code: 'asModerator = isAdmin(user) && !isAuthor',
    reason: 'Positive test: only administrators act as moderators; every other role must be the author (checked right after).',
  },
  {
    file: 'src/discussions/discussions.service.ts', rule: 'U2',
    code: 'isStudent(user) ? this.access.studentDivision(user) : divisionId',
    reason: 'courseTarget(): unsupported roles are refused (404) just before; staff use the requested division, which assertCanView() then checks.',
  },
  {
    file: 'src/discussions/discussions.service.ts', rule: 'U2', code: "isAdmin(user) ? 'ADMIN' : 'OTHER'",
    reason: 'Default (any non-admin role) is the restricted list of thread statuses (OPEN, LOCKED).',
  },
  {
    file: 'src/discussions/discussions.service.ts', rule: 'U2',
    code: "isAdmin(user) ? { status: { in: ['ACTIVE', 'HIDDEN'] } } : { status: 'ACTIVE' }",
    reason: 'Default (any non-admin role) sees ACTIVE comments only — the restricted view.',
  },
  {
    file: 'src/discussions/discussions.service.ts', rule: 'U4',
    code: "isStaff(viewer) || author.role !== 'STUDENT' || author.id === viewer.id",
    reason: 'publicAuthor(): the fall-through is the anonymised student name — the less-privileged result for any other viewer.',
  },
  // ── Study groups (module not registered; unchanged by decision P3-4) ───────
  {
    file: 'src/study-groups/study-groups.service.ts', rule: 'U1', code: "caller.role !== 'ADMIN'",
    reason: 'Restrictive: non-admins must be group members or get 403. Dormant module, left unchanged (P3-4, Phase 9).',
  },
  {
    file: 'src/study-groups/study-groups.service.ts', rule: 'U3', code: "caller.role !== 'ADMIN'",
    reason: 'Same restrictive membership check as the U1 entry above (no else branch; the body refuses non-members).',
  },
];
