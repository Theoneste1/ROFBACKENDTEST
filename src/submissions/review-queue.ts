/**
 * The coach's review queue (GET /mentor/reviews): status groups, sort orders and totals.
 * Pure functions (tested in review-queue.spec.ts); the query itself is in submissions.service.ts.
 */
import type { Prisma, SubmissionStatus } from '../generated/prisma/client.js';
import type { ReviewQueueQueryDto, ReviewQueueSort } from './dto/list-submissions.dto.js';

/** Without `status` or `group`: the queue as it always was. */
export const DEFAULT_QUEUE_STATUSES: readonly SubmissionStatus[] =
  ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED', 'SUBMITTED_TO_ADMIN', 'RESUBMISSION_REQUESTED'];
/** Still with the coach (a requested resubmission comes back to the same coach). */
export const OPEN_REVIEW_STATUSES: readonly SubmissionStatus[] =
  ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED', 'RESUBMISSION_REQUESTED'];
/** The coach's part is finished. */
export const DONE_REVIEW_STATUSES: readonly SubmissionStatus[] = ['SUBMITTED_TO_ADMIN', 'APPROVED', 'PUBLISHED'];

/** The status condition: an explicit `status` wins; then the group; else the default queue. Undefined = any. */
export function reviewQueueStatus(q: Pick<ReviewQueueQueryDto, 'status' | 'group'>): Prisma.SubmissionWhereInput['status'] {
  if (q.status) return q.status;
  if (q.group === 'all') return undefined;
  if (q.group === 'open') return { in: [...OPEN_REVIEW_STATUSES] };
  if (q.group === 'done') return { in: [...DONE_REVIEW_STATUSES] };
  return { in: [...DEFAULT_QUEUE_STATUSES] };
}

/** Database order; every order ends with the id so that pages never overlap or skip rows. */
export function reviewQueueOrder(sort: ReviewQueueSort | undefined): Prisma.SubmissionOrderByWithRelationInput[] {
  switch (sort) {
    case 'recent':
      return [{ submittedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }];
    case 'name':
      return [{ student: { firstName: 'asc' } }, { student: { lastName: 'asc' } }, { id: 'asc' }];
    case 'score':
      return [{ currentReview: { score: { sort: 'desc', nulls: 'last' } } }, { submittedAt: 'asc' }, { id: 'asc' }];
    default:
      return [{ submittedAt: 'asc' }, { id: 'asc' }];
  }
}

/** Totals of the scope (without search or status filter) by group. */
export function reviewQueueCounts(byStatus: Array<{ status: SubmissionStatus; count: number }>) {
  let open = 0, done = 0, all = 0;
  for (const { status, count } of byStatus) {
    all += count;
    if (OPEN_REVIEW_STATUSES.includes(status)) open += count;
    else if (DONE_REVIEW_STATUSES.includes(status)) done += count;
  }
  return { open, done, all };
}
