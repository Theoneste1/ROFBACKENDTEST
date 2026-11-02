import type { SubmissionStatus } from '../generated/prisma/client.js';

/**
 * Submission status groups used across the review workflow.
 *
 * (Upload type/size rules now live in common/storage/file-rules.ts and are
 * enforced on the detected file content.)
 */

/** A student may still replace their work (before the mentor starts reviewing). */
export const RESUBMITTABLE: SubmissionStatus[] = ['SUBMITTED', 'ASSIGNED'];

/** Review is the mentor's responsibility in these states — counts as mentor workload. */
export const OPEN_REVIEW: SubmissionStatus[] = ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED'];

/** An admin may move the review to a different mentor. */
export const REASSIGNABLE: SubmissionStatus[] = ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED'];

/** The mentor may start (or restart) reviewing. */
export const REVIEW_STARTABLE: SubmissionStatus[] = ['ASSIGNED', 'REJECTED'];

/** The mentor may save a score and feedback (re-marking before returning is allowed). */
export const MARKABLE: SubmissionStatus[] = ['IN_REVIEW', 'MARKED'];

export enum DistributionStrategy {
  /** Each submission goes to the eligible mentor with the fewest open reviews. */
  BALANCED    = 'BALANCED',
  /** Submissions are dealt to eligible mentors in turn. */
  ROUND_ROBIN = 'ROUND_ROBIN',
}
