/**
 * The SCHOOL record type of the bulk engine — the pure rules (2026-11-20; docs/operations/bulk-operations.md).
 *
 *   activate / deactivate → AdminSchoolsService.setActiveInTx   (PATCH /admin/schools/:id/active; reason required)
 *   verify                → AdminSchoolsService.verifyInTx      (POST /admin/schools/:id/verify; the reason is its note)
 *
 * Each needs schools.manage (the single routes' permission) on top of users.bulkManage. The selection is
 * GET /admin/schools's filters (schoolListWhere).
 */
import type { BulkActionMeta, PreviewWarning } from '../../bulk/bulk-handler.js';

export const SCHOOL_BULK_ACTIONS = ['activate', 'deactivate', 'verify'] as const;
export type SchoolBulkAction = (typeof SCHOOL_BULK_ACTIONS)[number];

export const SCHOOL_ACTIONS: Readonly<Record<SchoolBulkAction, BulkActionMeta>> = {
  activate:   { permissions: ['schools.manage'], reason: 'required',
                consequence: 'The schools become active again: they accept new registrations, claims, verifications and Teacher assignments. Schools already active are skipped. History is never rewritten.' },
  deactivate: { permissions: ['schools.manage'], reason: 'required',
                consequence: 'The schools accept no new registrations, claims, verifications or Teacher assignments. Existing students, verified claims, enrolments and Teacher access are kept. Schools already inactive are skipped.' },
  verify:     { permissions: ['schools.manage'], reason: 'optional',
                consequence: 'Records that you checked each school\'s name and place (the reason, if given, is the note). Schools already verified are skipped; inactive schools and schools outside Rwanda fail.' },
};

/** The tables GET /admin/schools's filters read (name, code, place, flags; levels, programmes, source records). */
export const SCHOOL_MEMBERSHIP_TABLES = ['School', 'SchoolEducationLevel', 'SchoolProgramme', 'SchoolSourceRecord'] as const;

/**
 * Refusals of the single routes that mean "nothing to do". None: an inactive school (SCHOOL_INACTIVE) or one outside
 * Rwanda (SCHOOL_DIRECTORY_RWANDA_ONLY) cannot be verified — reported as FAILED.
 */
export const SCHOOL_SKIP_CODES: ReadonlySet<string> = new Set<string>();

export interface SchoolState { isActive: boolean; countryCode: string; lastVerifiedAt: Date | null }

/** Whether the action has nothing to do for a school in this state (SKIPPED ALREADY_IN_STATE). */
export function schoolAlreadyDone(action: SchoolBulkAction, s: Pick<SchoolState, 'isActive' | 'lastVerifiedAt'>): boolean {
  if (action === 'activate') return s.isActive;
  if (action === 'deactivate') return !s.isActive;
  return s.lastVerifiedAt !== null;
}

/** Preview warnings: what will be skipped, and (verify) what will fail. */
export function schoolWarnings(action: SchoolBulkAction, rows: readonly SchoolState[]): PreviewWarning[] {
  const out: PreviewWarning[] = [];
  const warn = (code: string, count: number, message: string) => { if (count > 0) out.push({ code, count, message }); };
  const done = rows.filter((r) => schoolAlreadyDone(action, r)).length;
  if (action === 'activate') warn('ALREADY_IN_STATE', done, 'Schools already active will be skipped.');
  if (action === 'deactivate') warn('ALREADY_IN_STATE', done, 'Schools already inactive will be skipped.');
  if (action === 'verify') {
    warn('ALREADY_IN_STATE', done, 'Schools already verified will be skipped.');
    const todo = rows.filter((r) => !schoolAlreadyDone(action, r));
    warn('SCHOOL_INACTIVE', todo.filter((r) => !r.isActive).length, 'Inactive schools cannot be verified; they will fail.');
    warn('SCHOOL_DIRECTORY_RWANDA_ONLY', todo.filter((r) => r.isActive && r.countryCode !== 'RW').length,
      'Only schools of the Rwandan directory are verified; the others will fail.');
  }
  return out;
}
