/**
 * The TEACHER_APPLICATION record type of the bulk engine — the pure rules (2026-11-20; docs/operations/bulk-operations.md).
 *
 *   reject → TeacherApplicationsService.rejectInTx   (POST /admin/teacher-applications/:id/reject; reason required,
 *                                                     e-mailed to the applicant after commit)
 *
 * Needs users.manageTeachers (the single route's permission) on top of users.bulkManage, and — like every route of
 * /admin/teacher-applications — the right to give the TEACHER role with the role enabled (RoleAssignmentPolicy).
 * There is deliberately NO bulk approve: an approval needs a per-application school decision.
 */
import type { BulkActionMeta, PreviewWarning } from '../../bulk/bulk-handler.js';

export const TEACHER_APPLICATION_BULK_ACTIONS = ['reject'] as const;
export type TeacherApplicationBulkAction = (typeof TEACHER_APPLICATION_BULK_ACTIONS)[number];

export const TEACHER_APPLICATION_ACTIONS: Readonly<Record<TeacherApplicationBulkAction, BulkActionMeta>> = {
  reject: { permissions: ['users.manageTeachers'], reason: 'required',
            consequence: 'Rejects each pending Teacher application: no account is created, the stored password and picture are discarded, an open request for more information ends, and the applicant is e-mailed the reason. Applications already decided are skipped.' },
};

/** The table GET /admin/teacher-applications's filter reads. */
export const TEACHER_APPLICATION_MEMBERSHIP_TABLES = ['TeacherApplication'] as const;

/** The single route's "already decided" refusal (decided meanwhile) means nothing to do. */
export const TEACHER_APPLICATION_SKIP_CODES: ReadonlySet<string> = new Set(['APPLICATION_ALREADY_DECIDED']);

/** Preview warnings: applications already rejected, or approved, are skipped. */
export function teacherApplicationWarnings(statuses: readonly string[]): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  const rejected = statuses.filter((s) => s === 'REJECTED').length;
  const approved = statuses.filter((s) => s === 'APPROVED').length;
  if (rejected) out.push({ code: 'ALREADY_IN_STATE', count: rejected, message: 'Applications already rejected will be skipped.' });
  if (approved) out.push({ code: 'ALREADY_DECIDED', count: approved, message: 'Approved applications cannot be rejected; they will be skipped.' });
  return out;
}
