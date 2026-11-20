/**
 * The COACH_APPLICATION record type of the bulk engine (mentor requests) — the pure rules (2026-11-20;
 * docs/operations/bulk-operations.md).
 *
 *   approve → MentorRequestsService.approveInTx   (PATCH /mentor-requests/:id/approve; creates the Coach account; the
 *                                                  picture is NEVER approved in bulk — approvePicture false, so a
 *                                                  picture sent with the application is discarded)
 *   reject  → MentorRequestsService.rejectInTx    (PATCH /mentor-requests/:id/reject; the reason is optional, as on the
 *                                                  single route, and e-mailed to the applicant when given)
 *
 * Each needs mentorRequests.decide (the single routes' permission) on top of users.bulkManage.
 */
import type { BulkActionMeta, PreviewWarning } from '../../bulk/bulk-handler.js';

export const COACH_APPLICATION_BULK_ACTIONS = ['approve', 'reject'] as const;
export type CoachApplicationBulkAction = (typeof COACH_APPLICATION_BULK_ACTIONS)[number];

export const COACH_APPLICATION_TARGET: Readonly<Record<CoachApplicationBulkAction, 'APPROVED' | 'REJECTED'>> = { approve: 'APPROVED', reject: 'REJECTED' };

export const COACH_APPLICATION_ACTIONS: Readonly<Record<CoachApplicationBulkAction, BulkActionMeta>> = {
  approve: { permissions: ['mentorRequests.decide'], reason: 'optional',
             consequence: 'Creates a Coach account for each pending application (with e-mail verification on, the applicant confirms the address first) and sends the approval notice. Pictures sent with the applications are discarded: approve one by one to keep a picture. Applications already decided are skipped; a username or e-mail already in use fails.' },
  reject:  { permissions: ['mentorRequests.decide'], reason: 'optional',
             consequence: 'Rejects each pending application: no account is created, the stored password and picture are discarded, and the applicant is e-mailed (with the reason, if given). Applications already decided are skipped.' },
};

/** The table GET /mentor-requests's filter reads. */
export const COACH_APPLICATION_MEMBERSHIP_TABLES = ['MentorRequest'] as const;

/** The single routes' "already processed" refusal (decided meanwhile) means nothing to do. */
export const COACH_APPLICATION_SKIP_CODES: ReadonlySet<string> = new Set(['INVALID_STATE_TRANSITION']);

export interface CoachApplicationState { status: string; hasPicture: boolean }

/** Preview warnings: decided applications are skipped; approve discards the pictures of pending ones. */
export function coachApplicationWarnings(action: CoachApplicationBulkAction, rows: readonly CoachApplicationState[]): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  const warn = (code: string, count: number, message: string) => { if (count > 0) out.push({ code, count, message }); };
  const target = COACH_APPLICATION_TARGET[action];
  warn('ALREADY_IN_STATE', rows.filter((r) => r.status === target).length, `Applications already ${target.toLowerCase()} will be skipped.`);
  warn('ALREADY_DECIDED', rows.filter((r) => r.status !== target && r.status !== 'PENDING').length, 'Applications already decided the other way will be skipped.');
  if (action === 'approve') {
    warn('PICTURE_DISCARDED', rows.filter((r) => r.status === 'PENDING' && r.hasPicture).length,
      'These applications came with a picture; bulk approval discards it. Approve them one by one to keep a picture.');
  }
  return out;
}
