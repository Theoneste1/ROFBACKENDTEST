/**
 * Bulk user operations — the pure rules (2026-11-17; unit-tested; docs/operations/bulk-user-operations.md).
 *
 *  - The actions, what each needs (permission, reason, parameters) and what it does per account.
 *  - The selection: `{ mode: 'ids', ids }` (≤ 1000) or `{ mode: 'filter', filter }` (the filters of
 *    GET /admin/users). It is always resolved on the server; the browser never loads every match.
 *  - The selection token binds a confirmation to EXACTLY what was previewed: the action, its parameters, the
 *    normalised selection and a digest of the sorted ids of every matching account. Any difference at execution
 *    time (an account added, removed, or changed so it no longer matches) → 409 SELECTION_CHANGED.
 */
import { createHash } from 'node:crypto';

import type { AccountStatus, GradeLevel } from '../../generated/prisma/client.js';
import type { Permission } from '../../auth/permissions.js';

export const BULK_ACTIONS = [
  'activate', 'deactivate', 'suspend', 'archive', 'restore', 'assignRole', 'changeClassification', 'message',
  // Teacher–student access (TS approvals 2026-11-18): the selected accounts are students; params.teacherId (+ permission).
  'assignTeacher', 'unassignTeacher', 'grantDelegation', 'revokeDelegation',
] as const;

/** Actions on the teacher–student links of the selected students (params.teacherId). */
export const TEACHER_STUDENT_ACTIONS: readonly BulkAction[] = ['assignTeacher', 'unassignTeacher', 'grantDelegation', 'revokeDelegation'];
export type BulkAction = (typeof BULK_ACTIONS)[number];

export const MAX_IDS = 1000;
/** A filter may match at most this many accounts in one operation (larger selections are split by filter). */
export const MAX_SELECTION = 50_000;
export const BATCH_SIZE = 200;
/**
 * The membership advisory lock: every write that can change bulk-filter membership takes it SHARED (database trigger
 * user_bulk_membership_guard, migration 20261207000100); creating an operation takes it EXCLUSIVELY.
 */
export const BULK_MEMBERSHIP_KEY = 8_152_026_002n;
/** The User columns a bulk / list filter reads (userListWhere): the trigger guards writes to exactly these. */
export const MEMBERSHIP_COLUMNS = [
  'role', 'divisionId', 'gradeLevel', 'schoolId', 'isApproved', 'isActive', 'accountStatus', 'activatedAt',
  'firstName', 'lastName', 'username', 'email',
] as const;
/** A claimed item whose worker vanished is claimed again after this long. */
export const CLAIM_TIMEOUT_MS = 5 * 60_000;

/** The list filters a bulk selection may use (the same names and meaning as GET /admin/users). */
export interface BulkFilter {
  role?: string; divisionId?: string; gradeLevel?: string; schoolId?: string;
  isApproved?: boolean; isActive?: boolean; accountStatus?: string; isActivated?: boolean; search?: string;
}
export type BulkSelection = { mode: 'ids'; ids: string[] } | { mode: 'filter'; filter: BulkFilter };

export interface BulkParams {
  role?: string;
  gradeLevel?: GradeLevel;
  subject?: string;
  body?: string;
  /** Teacher–student actions: the Teacher. */
  teacherId?: string;
  /** grantDelegation / revokeDelegation: students.viewProfile, students.viewProgress or submissions.submitOnBehalf. */
  permission?: string;
}

interface ActionRule {
  /** The account-state target (status actions only). */
  toStatus?: AccountStatus;
  /** States the action applies to; any other is SKIPPED (status actions only). */
  from?: readonly AccountStatus[];
  /** Permissions the caller needs, on top of users.bulkManage (and, per account, the role policy). */
  permissions: readonly Permission[];
  reason: 'required' | 'optional';
  /** One sentence for the confirmation dialog. */
  consequence: string;
}

export const ACTION_RULES: Readonly<Record<BulkAction, ActionRule>> = {
  activate:   { toStatus: 'ACTIVE', from: ['DEACTIVATED', 'SUSPENDED'], permissions: ['users.changeStatus', 'users.suspend'], reason: 'optional',
                consequence: 'Deactivated and suspended accounts become active again. Archived accounts are skipped: use restore. Other blocks (not activated, not approved, locked) stay.' },
  deactivate: { toStatus: 'DEACTIVATED', from: ['ACTIVE'], permissions: ['users.changeStatus'], reason: 'required',
                consequence: 'The accounts can no longer sign in; every session ends at once. Nothing is deleted.' },
  suspend:    { toStatus: 'SUSPENDED', from: ['ACTIVE', 'DEACTIVATED'], permissions: ['users.suspend'], reason: 'required',
                consequence: 'The accounts are blocked by an administrative restriction; every session ends at once. Nothing is deleted.' },
  archive:    { toStatus: 'ARCHIVED', from: ['ACTIVE', 'DEACTIVATED', 'SUSPENDED'], permissions: ['users.archive'], reason: 'required',
                consequence: 'The accounts are kept for history only and can no longer sign in; every session ends. Submissions, results and records stay linked.' },
  restore:    { toStatus: 'ACTIVE', from: ['DEACTIVATED', 'SUSPENDED', 'ARCHIVED'], permissions: ['users.changeStatus', 'users.suspend', 'users.archive'], reason: 'required',
                consequence: 'The accounts become active again. Restoring never clears another block (not activated, not approved, locked, a disabled role): those are reported per account.' },
  assignRole: { permissions: [], reason: 'optional',
                consequence: 'Each account gets the new role, if you may manage both its current and the new role. Sessions of changed accounts end.' },
  changeClassification: { permissions: [], reason: 'optional',
                consequence: 'Students move to the new grade, and so to its division (S1–S3 Junior, S4–S6 Senior), re-enrolled for the current year. Other roles are skipped.' },
  message:    { permissions: ['email.bulkSend'], reason: 'optional',
                consequence: 'Each active account in the selection is e-mailed once. Blocked accounts are skipped.' },
  assignTeacher:    { permissions: ['users.manageTeachers'], reason: 'optional',
                      consequence: 'Each selected student is assigned to the teacher (students already assigned are skipped). A student who is not a verified student of the teacher\'s schools needs a reason, otherwise it fails. Other accounts are skipped. The teacher is told once; students are not notified.' },
  unassignTeacher:  { permissions: ['users.manageTeachers'], reason: 'optional',
                      consequence: 'Each selected student\'s assignment to the teacher ends (kept as history). If the teacher then no longer sees a student, that student is taken off the teacher\'s delegations for selected students, which are flagged for review.' },
  grantDelegation:  { permissions: ['users.manageTeachers'], reason: 'required',
                      consequence: 'The teacher\'s permission is given for each selected student (a delegation for selected students, created if the teacher has none). Students the teacher does not see fail. The teacher is told about a new delegation.' },
  revokeDelegation: { permissions: ['users.manageTeachers'], reason: 'optional',
                      consequence: 'Each selected student is taken off the teacher\'s delegation for selected students (kept as history). Delegations for the whole school or assigned students are not changed: revoke those on the teacher\'s page.' },
};

/** Status of an account before a status action: SKIPPED (with why), or the transition to make. */
export function statusDecision(action: BulkAction, current: AccountStatus): { skip: string } | { toStatus: AccountStatus } {
  const rule = ACTION_RULES[action];
  if (!rule.toStatus) throw new Error(`${action} is not a status action`);
  if (current === rule.toStatus) return { skip: 'ALREADY_IN_STATE' };
  if (action === 'activate' && current === 'ARCHIVED') return { skip: 'USE_RESTORE' };
  if (!rule.from!.includes(current)) return { skip: 'NOT_APPLICABLE' };
  return { toStatus: rule.toStatus };
}

const sortKeys = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null).sort(([a], [b]) => a.localeCompare(b)));

/** The canonical selection: ids deduplicated and sorted; filter keys sorted, empty values dropped. */
export function normaliseSelection(s: BulkSelection): BulkSelection {
  if (s.mode === 'ids') return { mode: 'ids', ids: [...new Set(s.ids)].sort() };
  return { mode: 'filter', filter: sortKeys({ ...s.filter }) as BulkFilter };
}

/** The canonical parameters of an action (only the ones it uses). */
export function normaliseParams(action: BulkAction, p: BulkParams): BulkParams {
  switch (action) {
    case 'assignRole': return { role: p.role };
    case 'changeClassification': return { gradeLevel: p.gradeLevel };
    case 'message': return { subject: p.subject?.trim(), body: p.body };
    case 'assignTeacher':
    case 'unassignTeacher': return { teacherId: p.teacherId };
    case 'grantDelegation':
    case 'revokeDelegation': return { teacherId: p.teacherId, permission: p.permission };
    default: return {};
  }
}

/**
 * The selection token: sha256 over the action, its parameters, the normalised selection and the sorted ids of every
 * matching account. Recomputed at execution; any difference means the administrator did not confirm this set.
 */
export function selectionToken(action: BulkAction, params: BulkParams, selection: BulkSelection, matchingIds: readonly string[]): string {
  const ids = [...matchingIds].sort();
  const h = createHash('sha256');
  h.update(JSON.stringify({ v: 1, action, params: sortKeys({ ...params }), selection: normaliseSelection(selection) }));
  h.update('\n');
  for (const id of ids) h.update(id + ',');
  return `v1.${ids.length}.${h.digest('hex')}`;
}

/** The final status of an operation from its counts. */
export function finalStatus(c: { succeeded: number; failed: number; skipped: number; total: number }) {
  if (c.failed === 0) return 'COMPLETED' as const;
  if (c.succeeded === 0 && c.skipped === 0) return 'FAILED' as const;
  return 'COMPLETED_WITH_FAILURES' as const;
}

/** Refusal codes that mean "nothing to do for this account" rather than a failure. */
export const SKIP_CODES: ReadonlySet<string> = new Set(['STATUS_UNCHANGED', 'INVALID_STATUS_TRANSITION', 'CANNOT_CHANGE_OWN_STATUS']);
