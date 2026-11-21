/**
 * The SCHOOL_AFFILIATION record type of the bulk engine — students' school claims; the pure rules (2026-11-20;
 * docs/operations/bulk-operations.md).
 *
 *   verify → SchoolAffiliationService.verifyInTx   (POST /admin/school-affiliations/:id/verify; the reason is its note)
 *   reject → SchoolAffiliationService.rejectInTx   (POST /admin/school-affiliations/:id/reject; reason required, shown
 *                                                   to the student)
 *
 * Each needs schools.manage (the single routes' permission) on top of users.bulkManage. Only a current PENDING claim is
 * decided; the selection is GET /admin/school-affiliations's filters (affiliationListWhere; default: current claims).
 */
import type { BulkActionMeta, PreviewWarning } from '../../../bulk/bulk-handler.js';

export const AFFILIATION_BULK_ACTIONS = ['verify', 'reject'] as const;
export type AffiliationBulkAction = (typeof AFFILIATION_BULK_ACTIONS)[number];

export const AFFILIATION_TARGET: Readonly<Record<AffiliationBulkAction, 'VERIFIED' | 'REJECTED'>> = { verify: 'VERIFIED', reject: 'REJECTED' };

export const AFFILIATION_ACTIONS: Readonly<Record<AffiliationBulkAction, BulkActionMeta>> = {
  verify: { permissions: ['schools.manage'], reason: 'optional',
            consequence: 'Confirms that each student belongs to the claim\'s school (the reason, if given, is the internal note). Only current pending claims are verified; others are skipped. Claims without a school, or for an inactive school, fail.' },
  reject: { permissions: ['schools.manage'], reason: 'required',
            consequence: 'Rejects each current pending claim; the student sees the reason. Claims already decided or replaced are skipped.' },
};

/** The table GET /admin/school-affiliations's filters read. */
export const AFFILIATION_MEMBERSHIP_TABLES = ['StudentSchoolAffiliation'] as const;

/**
 * Refusals of the single routes that mean "nothing to do": the claim was replaced by a newer one, or decided meanwhile.
 * A claim without a school (AFFILIATION_SCHOOL_REQUIRED) or for an inactive school (SCHOOL_INACTIVE) fails.
 */
export const AFFILIATION_SKIP_CODES: ReadonlySet<string> = new Set(['AFFILIATION_SUPERSEDED', 'AFFILIATION_STATUS_CONFLICT']);

export interface ClaimState { status: string; current: boolean; hasSchool: boolean; schoolActive: boolean | null }

/** Preview warnings: what will be skipped and, for verify, what will fail. */
export function affiliationWarnings(action: AffiliationBulkAction, rows: readonly ClaimState[]): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  const warn = (code: string, count: number, message: string) => { if (count > 0) out.push({ code, count, message }); };
  const target = AFFILIATION_TARGET[action];
  warn('AFFILIATION_SUPERSEDED', rows.filter((r) => !r.current).length, 'Claims replaced by a newer one will be skipped.');
  const current = rows.filter((r) => r.current);
  warn('ALREADY_IN_STATE', current.filter((r) => r.status === target).length, `Claims already ${target.toLowerCase()} will be skipped.`);
  warn('NOT_APPLICABLE', current.filter((r) => r.status !== target && r.status !== 'PENDING').length, 'Only pending claims are decided; the others will be skipped.');
  if (action === 'verify') {
    const pending = current.filter((r) => r.status === 'PENDING');
    warn('AFFILIATION_SCHOOL_REQUIRED', pending.filter((r) => !r.hasSchool).length, 'Claims without a school (match them first) will fail.');
    warn('SCHOOL_INACTIVE', pending.filter((r) => r.hasSchool && r.schoolActive === false).length, 'Claims for an inactive school will fail.');
  }
  return out;
}
