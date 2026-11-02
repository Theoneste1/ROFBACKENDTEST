/**
 * Student-facing assignment display statuses.
 *
 * These are the six labels shown to a student on their dashboard.
 * They are derived at query time from backend state — they are never stored.
 *
 * Mapping:
 *
 * | Display label | Condition                                                              |
 * |---------------|------------------------------------------------------------------------|
 * | New           | No view record for this (student, assignment) pair                     |
 * | Opened        | View record exists but no submission record                            |
 * | Submitted     | Submission exists with status SUBMITTED or ASSIGNED                    |
 * | In Review     | Submission status is IN_REVIEW / MARKED / SUBMITTED_TO_ADMIN / APPROVED|
 * | Marked        | Submission status is PUBLISHED                                         |
 * | Redo          | Submission status is REJECTED AND deadline not passed                  |
 *                  AND assignment allows resubmission                               |
 *                  (if deadline passed or resubmission disallowed → "In Review")   |
 */
export type StudentDisplayStatus =
  | 'New'
  | 'Opened'
  | 'Submitted'
  | 'In Review'
  | 'Marked'
  | 'Redo';

export interface DisplayStatusInput {
  /** True if there is an AssignmentView record for this student+assignment. */
  hasViewed: boolean;
  /** The internal submission status, or null if no submission exists. */
  submissionStatus: string | null;
  /** The assignment deadline. */
  deadline: Date;
  /** Whether this assignment permits resubmissions. */
  allowResubmission: boolean;
}

/**
 * Pure function — derives the student-facing display status from backend state.
 * Contains no side effects; safe to use in map/filter chains.
 */
export function deriveStudentDisplayStatus(input: DisplayStatusInput): StudentDisplayStatus {
  const { hasViewed, submissionStatus, deadline, allowResubmission } = input;

  // ── No submission yet ────────────────────────────────────────────────────
  if (!submissionStatus) {
    return hasViewed ? 'Opened' : 'New';
  }

  // ── Submission exists ────────────────────────────────────────────────────
  switch (submissionStatus) {
    case 'SUBMITTED':
    case 'ASSIGNED':
      return 'Submitted';

    case 'REJECTED': {
      // "Redo" only if the student can actually act: deadline not passed
      // AND the assignment allows resubmission.
      const deadlinePassed = new Date() > deadline;
      if (!deadlinePassed && allowResubmission) {
        return 'Redo';
      }
      // Deadline passed or resubmission not allowed → stays In Review
      // (the marking correction cycle is still happening, student can't act).
      return 'In Review';
    }

    case 'IN_REVIEW':
    case 'MARKED':
    case 'SUBMITTED_TO_ADMIN':
    case 'APPROVED':
      return 'In Review';

    case 'PUBLISHED':
      return 'Marked';

    default:
      // Defensive fallback — should never be reached with a valid status.
      return 'In Review';
  }
}
