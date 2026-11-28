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
  // ── Custom reports: any data, templates, protected fields (src/custom-reports) ──
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U2', code: "viewer.role === 'SUPER_ADMIN' ? {} : { [src.idField ?? 'id']: { in: [] } }",
    reason: "Reports with any data (owner 2026-11-25): a source for the Super Admin only (banking information); any other or unknown role gets a where clause matching no row — the least-privileged result.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U2', code: "isAdmin(viewer) ? {} : { [src.idField ?? 'id']: { in: [] } }",
    reason: "Reports with any data (owner 2026-11-25): an Administrators' source (schools, learning, applications, administration); anyone else (or an unknown role) gets a where clause matching no row, even for a report shared with them.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: "definitionProblems(d, viewer.role)",
    reason: "Reports with any data (owner 2026-11-25): the author's role only restricts — an Administrators' source, a Super-Admin-only source or a protected field is refused (400) for any role that is not ADMIN / SUPER_ADMIN or not SUPER_ADMIN; an unknown role is refused all three.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U4', code: "viewer.role === 'SUPER_ADMIN'",
    reason: "Report templates (owner 2026-11-25): only the Super Admin marks, changes or deletes a template; any other or unknown role is refused (403 REPORT_TEMPLATE_SUPER_ADMIN_ONLY) when a template is involved.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: "superAdmin = viewer.role === 'SUPER_ADMIN'",
    reason: "Report catalogue (owner 2026-11-25): only SUPER_ADMIN sees the Super-Admin-only sources and the protected (personal) fields; any other or unknown role does not — the least-privileged result.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: "s.scope === 'admin' ? isAdmin(viewer) : true",
    reason: "Report catalogue (owner 2026-11-25): an Administrators' source is listed only for ADMIN / SUPER_ADMIN (isAdmin); the people sources are listed for every report builder (reports.build, enforced by the route), each viewer within their own scope of accounts.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U2', code: "f.protected && viewer.role !== 'SUPER_ADMIN' ? `${f.label} (hidden: personal data)` : f.label",
    reason: "Report headers (owner 2026-11-25): a protected column is marked hidden for anyone but SUPER_ADMIN (its cells are blank for them too: cells(..., false)); an unknown role gets the hidden marking.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U1', code: "viewer.role !== 'SUPER_ADMIN' || !usesProtected(d)",
    reason: "Audit of personal data in reports (owner 2026-11-25): only a SUPER_ADMIN run can show protected fields, so only those runs are recorded; for any other role the protected cells are blank, nothing personal is shown.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: "cells(d, r, viewer.role === 'SUPER_ADMIN')",
    reason: "Report cells (owner 2026-11-25): protected (personal) values only for SUPER_ADMIN; any other or unknown role gets them blank — the least-privileged result.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: "cells(d, x, viewer.role === 'SUPER_ADMIN')",
    reason: "Report download (owner 2026-11-25): protected (personal) values only for SUPER_ADMIN; any other or unknown role gets them blank — the least-privileged result.",
  },
  // ── Banking information (src/banking) ───────────────────────────────────────
  {
    file: 'src/banking/banking.service.ts', rule: 'U6', code: 'bankingRequiredFor(user.role)',
    reason: "Banking information (owner 2026-11-25): only TEACHER, MENTOR and HEAD_COACH give bank details; any other or unknown role gets required: false and no rules or details (GET), or 403 BANKING_NOT_APPLICABLE (PUT) — the least-privileged result. The caller's own data only.",
  },
  {
    file: 'src/banking/banking.service.ts', rule: 'U6', code: 'bankingSummary(user.role, details)',
    reason: "Banking information (owner 2026-11-25): the rules are applied only after bankingRequiredFor(user.role) let the caller through (one of TEACHER, MENTOR, HEAD_COACH); anything else is refused or answers 'not required' first. The caller's own row only.",
  },
  {
    file: 'src/banking/banking.service.ts', rule: 'U6', code: 'bankRules(user.role, await this.banks())',
    reason: "Banking information (owner 2026-11-25): the rules are applied only after bankingRequiredFor(user.role) let the caller through (one of TEACHER, MENTOR, HEAD_COACH); anything else is refused or answers 'not required' first. The caller's own row only.",
  },  {
    file: 'src/banking/banking.service.ts', rule: 'U6', code: 'bankConflicts(user.role, details)',
    reason: "Banking information (owner 2026-11-25): the rules are applied only after bankingRequiredFor(user.role) let the caller through (one of TEACHER, MENTOR, HEAD_COACH); anything else is refused or answers 'not required' first. The caller's own row only.",
  },
  {
    file: 'src/banking/banking.service.ts', rule: 'U6', code: 'checkSubmission(user.role, input, before, confirmReplace, await this.banks())',
    reason: "Banking information (owner 2026-11-25): the rules are applied only after bankingRequiredFor(user.role) let the caller through (one of TEACHER, MENTOR, HEAD_COACH); anything else is refused or answers 'not required' first. The caller's own row only.",
  },
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
  // ── Student profile pictures (owner decision 2026-11-18) ──────────────────────
  // ── Teacher school scope (P1-11) ───────────────────────────────────────────
  {
    file: 'src/common/access/access.service.ts', rule: 'U4', code: 'isTeacher(user)',
    reason: 'teacherSchools(): only a TEACHER has school assignments; every other role (including an unsupported one) gets the empty list — the least-privileged result, which schoolStudentsFilter() turns into "matches nobody".',
  },
  {
    file: 'src/teacher-applications/teacher-applications.service.ts', rule: 'U6', code: 'role: caller.role',
    reason: "approve(): passes the approving Administrator's role to approveInTx(), which only writes it to the audit entry (actorRole) — attribution data, not an access decision; the route is guarded by users.manageTeachers.",
  },
  {
    file: 'src/users/student-overview.service.ts', rule: 'U6', code: '(APP_ROLES as readonly string[]).includes(viewer.role)',
    reason: 'mayView(): the first check REFUSES (returns false → 404) any caller whose role is not one of the six known roles — even for their own account; it never grants anything.',
  },
  {
    file: 'src/users/student-overview.service.ts', rule: 'U4', code: 'isCourseWorker(viewer)',
    reason: "mayView(): the Coach / Head Coach branch grants only for a student of the viewer's programmes or taught divisions; every other role (an unsupported one included) falls through to `return false` (404).",
  },
  {
    file: 'src/users/student-overview.service.ts', rule: 'U6', code: 'staff = isAdmin(viewer) || isCourseWorker(viewer) || isTeacher(viewer)',
    reason: 'overview(): decides only whether the account status is ADDED for staff viewers; any other role (students, an unsupported one) gets less data, never more. Access itself is decided by mayView().',
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: "(g) => grantLive(g) && (g.userId === viewer.id || g.role === viewer.role || (!!g.schoolId && viewer.role === 'TEACHER' && schools.has(g.schoolId)))",
    reason: "levels(): selects the LIVE grants (not revoked, not expired) that name the caller, the caller's own role, or (a Teacher only) one of the schools they are actively assigned to — the only grants that apply to them; an unknown role matches no role grant and is no Teacher, so it gets no level. Rows stay within the source's scope whatever the grant (owner 2026-11-28).",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U2', code: "viewer.role === 'TEACHER' ? await activeSchoolsOf(this.prisma, viewer.id) : []",
    reason: "schoolsOf(): the schools whose report grants apply to the caller — a Teacher's active schools; any other role (an unknown one included) gets none, so a school grant gives them nothing (owner 2026-11-28).",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U4', code: "!mine.length || viewer.role === 'STUDENT'",
    reason: 'levels(): REFUSES (no level) when no grant applies or the caller is a student — students never receive reports, whatever a grant says.',
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U4', code: 'isHeadCoach(viewer)',
    reason: "scopeFor(): a Head Coach's rows are the members of the programmes they head (none → no rows); a Coach the students of their programmes or taught divisions; every other role falls through to the Teacher branch, then to no rows.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U4', code: 'isTeacher(viewer)',
    reason: "scopeFor(): a Teacher's rows are the students of their schools (the same rule as every teacher list); any other role falls through to `{ id: { in: [] } }` — no rows.",
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: '(APP_ROLES as readonly string[]).includes(viewer.role)',
    reason: 'list(): a role grant is looked up only for one of the six known roles; an unsupported role contributes no role grant (REFUSAL by omission).',
  },
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6', code: 'viewer.role as Role',
    reason: "list(): finds the reports granted to the caller's own role (or to them, or created by them); an unknown role matches no role grant; levels() then decides every report again.",
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
    file: 'src/audit/admin-request-audit.middleware.ts', rule: 'U1', code: '!user || !actor || !isAdmin(actor)',
    reason: 'Chooses whether to WRITE an audit row after the response (ADMIN / SUPER_ADMIN state-changing requests; while viewing as someone, the viewer is the actor); every other request is unaffected. Not an access decision: guards decide.',
  },
  // ── Course resources ───────────────────────────────────────────────────────
  {
    file: 'src/courses/course-resources.service.ts', rule: 'U3', code: 'isStudent(user) && !isViewing()',
    reason: "serveFile(): records a student's resource view (activity tracking) after access was already checked by assertCanRead() — not while an administrator views as the student (read only); not an access decision.",
  },
  // ── Leaderboard ────────────────────────────────────────────────────────────
  {
    file: 'src/leaderboard/leaderboard.service.ts', rule: 'U2',
    code: 'isStaff(user) ? `${r.firstName} ${r.lastName}` : r.username',
    reason: 'Default (any non-staff role) is the username, never a name (owner 2026-11-27) — the less-privileged view. Unsupported roles are refused earlier (resolveDivision).',
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
  // ── Coach assignments ──────────────────────────────────────────────────────
  {
    file: 'src/mentor-assignments/mentor-assignments.service.ts', rule: 'U1', code: '!isHeadCoach(caller)',
    reason: 'Output shaping only (withoutContact): other callers get the row unchanged; a Head Coach gets it without the coach e-mail (D7, no contact details). Grants nothing.',
  },
  // ── Discussions ────────────────────────────────────────────────────────────
  {
    file: 'src/discussions/discussions.service.ts', rule: 'U6', code: "return isAdmin(user) && this.permissions.has(user, 'discussions.moderate');",
    reason: 'Positive test (canModerate): only administrators who still hold discussions.moderate (a DENY override removes it) act as moderators; every other caller must be the author (checked by the callers).',
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
  // ── Test Management, Phase 4: the publication override (owner spec 10.1) ─────
  {
    file: 'src/test-management/test-results.service.ts', rule: 'U6', code: 'mayOverride = isAdmin(user)',
    reason: 'preview(): only callers holding tests.publishResults reach it (Administrators, Super Admins, Head Coaches of the subject). The value only ADDS the override option for an Administrator; every other role (including an unsupported one) gets false — the less-privileged result (blocked).',
  },
  {
    file: 'src/test-management/test-results.service.ts', rule: 'U6', code: 'mayOverride: isAdmin(user)',
    reason: 'doPublish(): decidePublication refuses an override unless this is true (403 OVERRIDE_NOT_ALLOWED) and blocks unapproved results without it; any role other than ADMIN / SUPER_ADMIN gets false — the restrictive branch. The override route also requires tests.overridePublication (Administrators only, NEVER_GRANTABLE).',
  },
  // ── Coaches across their programmes (owner 2026-11-23) ──────────────────────
  {
    file: 'src/custom-reports/custom-reports.service.ts', rule: 'U6',
    code: "...(viewer.role === 'MENTOR' && { discipline: { coachRestrictions: { none: { coachId: viewer.id, capability: 'STUDENTS', liftedAt: null } } } })",
    reason: 'scopeFor(): only NARROWS a Coach (a programme where seeing the students was taken away is dropped). Every other role keeps its unchanged scope: a Head Coach heads the programme (restrictions are coach-only), and the branch is reached only for Coaches and Head Coaches.',
  },
  {
    file: 'src/users/student-overview.service.ts', rule: 'U6',
    code: "...(viewer.role === 'MENTOR' && { discipline: { coachRestrictions: { none: { coachId: viewer.id, capability: 'STUDENTS', liftedAt: null } } } })",
    reason: 'mayView(): only NARROWS a Coach (see the entry above); the branch is reached only for course workers (Coaches, Head Coaches), and a Head Coach keeps the programmes they belong to.',
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
  {
    file: 'src/coach-access/coach-access.service.ts', rule: 'U6', code: "role: actor.role",
    reason: 'Question-level marking (Rev 5.2): the actor role is only recorded in the task events of a MARKING restriction (who ended the claims); it grants nothing — the route already required its permission.',
  },
  {
    file: 'src/test-management/test-markers.service.ts', rule: 'U6', code: "role: user.role",
    reason: 'Question-level marking (Rev 5.2): the role of whoever revoked a marker authorisation is only recorded in the task events of the claims it ended; it grants nothing.',
  },
  {
    file: 'src/test-management/question/question-marker.service.ts', rule: 'U6', code: "role: user.role",
    reason: 'Question-level marking (Rev 5.2): the coach actor (role recorded in task events) is built only after isCoach(user) refused every other role; it grants nothing.',
  },
  {
    file: 'src/test-management/question/question-marking.service.ts', rule: 'U6', code: "role: user.role",
    reason: 'Question-level marking (Rev 5.2): the staff actor role is only recorded in task events and decisions; every staff route already required its permission and scope (loadInScope).',
  },
  {
    file: 'src/test-management/question/question-marking.service.ts', rule: 'U6', code: "allowedActions(task.status as TaskStatus, second?.status as TaskStatus | undefined, user.role)",
    reason: 'Question-level marking (Rev 5.2): only hints which buttons to show; decide is offered to HEAD_COACH only (any other or unknown role: false), and the server checks tests.adjustMarks again on the action itself.',
  },
  {
    file: 'src/users/account-status.service.ts', rule: 'U6', code: "role: caller.role",
    reason: 'Question-level marking (Rev 5.2): the role of whoever changed the account status is only recorded in the task events of the question claims it ended; it grants nothing.',
  },
  {
    file: 'src/users/users.service.ts', rule: 'U6', code: "role: caller.role",
    reason: 'Question-level marking (Rev 5.2): the role of whoever changed a coach role is only recorded in the task events of the question claims it ended; it grants nothing.',
  },
  {
    file: 'src/programmes/programmes.service.ts', rule: 'U6', code: "role: caller.role",
    reason: 'Question-level marking (Rev 5.2): the role of whoever ended the programme membership is only recorded in the task events of the question claims it ended; it grants nothing.',
  },
];
