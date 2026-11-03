/**
 * Student-facing submission statuses.
 *
 * These are the labels shown to a student for each assignment. They are
 * derived at query time from backend state — they are never stored.
 *
 * Mapping:
 *
 * | Display label          | Condition                                                        |
 * |------------------------|------------------------------------------------------------------|
 * | Not Started            | No submission yet (whether the assignment was opened is reported |
 * |                        | separately as `viewedAt`)                                        |
 * | Submitted              | SUBMITTED or ASSIGNED — the student may still replace the work   |
 * |                        | if the assignment allows it                                      |
 * | Pending Review         | Under review: IN_REVIEW, MARKED, SUBMITTED_TO_ADMIN, APPROVED,   |
 * |                        | REJECTED (the admin sent the mentor's review back — nothing for  |
 * |                        | the student to do)                                               |
 * | Resubmission Requested | RESUBMISSION_REQUESTED — the mentor asked for a new attempt      |
 * | Reviewed               | PUBLISHED — score and feedback are available                     |
 *
 * Lifecycle: Not Started → Submitted → Pending Review → Reviewed, with
 * Pending Review → Resubmission Requested → (student resubmits) → Submitted.
 */
export type StudentDisplayStatus =
  | 'Not Started'
  | 'Submitted'
  | 'Pending Review'
  | 'Resubmission Requested'
  | 'Reviewed';

export interface DisplayStatusInput {
  /** The internal submission status, or null if no submission exists. */
  submissionStatus: string | null;
}

/**
 * Pure function — derives the student-facing display status from backend state.
 * Contains no side effects; safe to use in map/filter chains.
 */
export function deriveStudentDisplayStatus(input: DisplayStatusInput): StudentDisplayStatus {
  switch (input.submissionStatus) {
    case null:
      return 'Not Started';

    case 'SUBMITTED':
    case 'ASSIGNED':
      return 'Submitted';

    case 'RESUBMISSION_REQUESTED':
      return 'Resubmission Requested';

    case 'PUBLISHED':
      return 'Reviewed';

    case 'IN_REVIEW':
    case 'MARKED':
    case 'SUBMITTED_TO_ADMIN':
    case 'APPROVED':
    case 'REJECTED':
    default:
      return 'Pending Review';
  }
}
