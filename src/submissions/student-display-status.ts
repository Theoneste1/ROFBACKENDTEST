/**
 * Student-facing assignment display statuses.
 *
 * These are the labels shown to a student on their dashboard.
 * They are derived at query time from backend state — they are never stored.
 *
 * Mapping:
 *
 * | Display label | Condition                                                           |
 * |---------------|---------------------------------------------------------------------|
 * | New           | No view record for this (student, assignment) pair                  |
 * | Opened        | View record exists but no submission record                         |
 * | Submitted     | Submission status is SUBMITTED or ASSIGNED (not yet under review)   |
 * | In Review     | Any status between review start and publication, including REJECTED |
 * |               | (a review sent back to the mentor — the student has nothing to do)  |
 * | Marked        | Submission status is PUBLISHED                                      |
 *
 * Note: the previous "Redo" label was removed. REJECTED means the administrator
 * returned the MENTOR's review for rework; the student cannot act on it, so
 * showing "Redo" was misleading. Students resubmit only while their work is
 * still SUBMITTED/ASSIGNED, which shows as "Submitted".
 */
export type StudentDisplayStatus =
  | 'New'
  | 'Opened'
  | 'Submitted'
  | 'In Review'
  | 'Marked';

export interface DisplayStatusInput {
  /** True if there is an AssignmentView record for this student+assignment. */
  hasViewed: boolean;
  /** The internal submission status, or null if no submission exists. */
  submissionStatus: string | null;
}

/**
 * Pure function — derives the student-facing display status from backend state.
 * Contains no side effects; safe to use in map/filter chains.
 */
export function deriveStudentDisplayStatus(input: DisplayStatusInput): StudentDisplayStatus {
  const { hasViewed, submissionStatus } = input;

  if (!submissionStatus) {
    return hasViewed ? 'Opened' : 'New';
  }

  switch (submissionStatus) {
    case 'SUBMITTED':
    case 'ASSIGNED':
      return 'Submitted';

    case 'PUBLISHED':
      return 'Marked';

    case 'IN_REVIEW':
    case 'MARKED':
    case 'SUBMITTED_TO_ADMIN':
    case 'APPROVED':
    case 'REJECTED':
    default:
      return 'In Review';
  }
}
