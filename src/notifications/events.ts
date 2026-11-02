/**
 * Domain events emitted by feature services after their changes commit.
 * NotificationListener turns them into in-app notifications and e-mails, so
 * feature modules never depend on the notification module.
 */
export const Events = {
  AssignmentSubmittedForReview: 'assignment.submitted_for_review',
  AssignmentPublished:          'assignment.published',
  AssignmentRejected:           'assignment.rejected',
  SubmissionReceived:           'submission.received',
  SubmissionsAssigned:          'submissions.assigned',
  ReviewReturned:               'review.returned',
  ReviewRejected:               'review.rejected',
  ResultsPublished:             'results.published',
  ResultReopened:               'result.reopened',
  ResourcePublished:            'resource.published',
  LiveSessionScheduled:         'live_session.scheduled',
  LiveSessionUpdated:           'live_session.updated',
  LiveSessionCancelled:         'live_session.cancelled',
  MentorRequestDecided:         'mentor_request.decided',
} as const;

export interface AssignmentEvent        { assignmentId: string; note?: string }
export interface SubmissionEvent        { submissionId: string; reason?: string }
export interface SubmissionsAssignedEvent { assignmentId: string; byMentor: Record<string, number> }
export interface ResultsPublishedEvent  { submissionIds: string[] }
export interface ResourceEvent          { resourceId: string }
export interface LiveSessionEvent       { sessionId: string }
export interface MentorRequestDecidedEvent {
  email:     string;
  firstName: string;
  approved:  boolean;
}
