import type { ReviewStatus, SubmissionStatus } from '../generated/prisma/client.js';

/**
 * Status groups used across the review workflow.
 *
 * (Upload type/size rules live in common/storage/file-rules.ts and are
 * enforced on the detected file content.)
 */

/** A student may still replace their work (before the mentor starts reviewing). */
export const RESUBMITTABLE: SubmissionStatus[] = ['SUBMITTED', 'ASSIGNED'];

/** Review cycles that count as a mentor's open workload. */
export const OPEN_REVIEW_STATUSES: ReviewStatus[] = ['ASSIGNED', 'IN_PROGRESS', 'MARKED', 'SENT_BACK'];

export enum DistributionStrategy {
  /** Each submission goes to the eligible mentor with the fewest open reviews. */
  BALANCED    = 'BALANCED',
  /** Submissions are dealt to eligible mentors in turn. */
  ROUND_ROBIN = 'ROUND_ROBIN',
}
