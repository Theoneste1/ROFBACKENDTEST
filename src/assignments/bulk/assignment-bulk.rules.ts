/**
 * The ASSIGNMENT record type of the bulk engine — the pure rules (2026-11-20; docs/operations/bulk-operations.md).
 *
 *   publish → AssignmentsService.publishInTx   (PATCH /assignments/:id/publish; PENDING_APPROVAL → PUBLISHED)
 *   close   → AssignmentsService.closeInTx     (PATCH /assignments/:id/close;   PUBLISHED → CLOSED; reason = note)
 *   archive → AssignmentsService.archiveInTx   (PATCH /assignments/:id/archive; any status but ARCHIVED → ARCHIVED)
 *
 * Each needs assignments.publish (the single routes' permission) on top of users.bulkManage. Archiving cannot be undone,
 * so in bulk it needs a reason (kept as the history note). An assignment in another status is SKIPPED (the owner's
 * rule for every record type: wrong-state records are skipped, not failed); publishing one whose deadline has passed
 * FAILS with DEADLINE_IN_PAST, as the single route refuses it.
 */
import type { BulkActionMeta, PreviewWarning } from '../../bulk/bulk-handler.js';
import type { AssignmentStatus } from '../../generated/prisma/client.js';
import { ARCHIVABLE_STATUSES } from '../assignments.service.js';

export const ASSIGNMENT_BULK_ACTIONS = ['publish', 'close', 'archive'] as const;
export type AssignmentBulkAction = (typeof ASSIGNMENT_BULK_ACTIONS)[number];

export const ASSIGNMENT_ACTIONS: Readonly<Record<AssignmentBulkAction, BulkActionMeta>> = {
  publish: { permissions: ['assignments.publish'], reason: 'optional',
             consequence: 'Publishes each assignment waiting for approval: students of its course and division see it and are notified. Assignments in another status are skipped; one whose deadline has passed fails (reject it so the coach sets a new deadline).' },
  close:   { permissions: ['assignments.publish'], reason: 'optional',
             consequence: 'Stops accepting submissions for each published assignment now (the reason, if given, is the note). Reviews and results carry on. Assignments in another status are skipped; reopen one by one.' },
  archive: { permissions: ['assignments.publish'], reason: 'required',
             consequence: 'Archives each assignment: it becomes read-only and accepts no new submissions; reviews in progress can be finished and published results stay visible. This cannot be undone. Assignments already archived are skipped.' },
};

/** The status each action leaves an assignment in, and the statuses it applies to. */
export const ASSIGNMENT_TARGET: Readonly<Record<AssignmentBulkAction, AssignmentStatus>> = { publish: 'PUBLISHED', close: 'CLOSED', archive: 'ARCHIVED' };
export const ASSIGNMENT_FROM: Readonly<Record<AssignmentBulkAction, readonly AssignmentStatus[]>> = {
  publish: ['PENDING_APPROVAL'],
  close: ['PUBLISHED'],
  archive: ARCHIVABLE_STATUSES,
};

/** The table GET /assignments's filters read (title, description, instructions, status, course, division, author, year, deadline). */
export const ASSIGNMENT_MEMBERSHIP_TABLES = ['Assignment'] as const;

/** Refusals of the single routes that mean "nothing to do": none (wrong statuses are skipped before the call). */
export const ASSIGNMENT_SKIP_CODES: ReadonlySet<string> = new Set<string>();

export interface AssignmentState { status: AssignmentStatus; deadline: Date }

/** Preview warnings: what will be skipped, and (publish) what will fail. */
export function assignmentWarnings(action: AssignmentBulkAction, rows: readonly AssignmentState[], now = new Date()): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  const warn = (code: string, count: number, message: string) => { if (count > 0) out.push({ code, count, message }); };
  const target = ASSIGNMENT_TARGET[action];
  const from = ASSIGNMENT_FROM[action];
  warn('ALREADY_IN_STATE', rows.filter((r) => r.status === target).length, `Assignments already ${target.toLowerCase()} will be skipped.`);
  warn('NOT_APPLICABLE', rows.filter((r) => r.status !== target && !from.includes(r.status)).length,
    `Only ${from.map((s) => s.toLowerCase().replace('_', ' ')).join(' or ')} assignments can be ${action === 'close' ? 'closed' : `${action}ed`}; the others will be skipped.`);
  if (action === 'publish') {
    warn('DEADLINE_IN_PAST', rows.filter((r) => from.includes(r.status) && r.deadline <= now).length,
      'Assignments whose deadline has passed cannot be published; they will fail.');
  }
  return out;
}
