/**
 * Domain events emitted by feature services after their changes commit.
 * NotificationListener turns them into in-app notifications and e-mails, so
 * feature modules never depend on the notification module.
 */
import type { ModerationActionType } from '../generated/prisma/client.js';

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
  ResubmissionRequested:        'submission.resubmission_requested',
  ResubmissionRequestWithdrawn: 'submission.resubmission_request_withdrawn',
  ResourcePublished:            'resource.published',
  MentorRequestDecided:         'mentor_request.decided',
  StudentRegistered:            'registration.student',
  MentorRequestSubmitted:       'registration.mentor_request',
  TeacherApplicationSubmitted:  'registration.teacher_application',
  DiscussionThreadCreated:      'discussion.thread_created',
  DiscussionCommentPosted:      'discussion.comment_posted',
  ContentReported:              'moderation.content_reported',
  ContentModerated:             'moderation.content_moderated',
  ReportsResolved:              'moderation.reports_resolved',
} as const;

export interface AssignmentEvent        { assignmentId: string; note?: string }
export interface SubmissionEvent        { submissionId: string; reason?: string }
/** A published result withdrawn for correction; previousReviewId identifies this withdrawal (one notice each). */
export interface ResultReopenedEvent    { submissionId: string; reason?: string; previousReviewId: string }
/** A new student account (self-registration). */
export interface StudentRegisteredEvent { userId: string; requiresApproval: boolean }
/** A coach application submitted (or re-submitted after a rejection); submittedAt identifies this submission. */
export interface MentorRequestSubmittedEvent { requestId: string; submittedAt: string; reapplication: boolean }
/** A Teacher self-registration application submitted (each application is its own row: one notice each). */
export interface TeacherApplicationSubmittedEvent { applicationId: string }
export interface SubmissionsAssignedEvent { assignmentId: string; byMentor: Record<string, number> }
export interface ResultsPublishedEvent  { submissionIds: string[] }
export interface ResourceEvent          { resourceId: string }
export interface DiscussionThreadEvent  { threadId: string }
export interface DiscussionCommentEvent { commentId: string }
export interface ContentReportedEvent   { reportId: string }
export interface ContentModeratedEvent {
  action:     ModerationActionType;
  threadId?:  string;
  commentId?: string;
  reason?:    string;
}
export interface ReportsResolvedEvent   { reportIds: string[]; actionTaken: boolean }
export interface MentorRequestDecidedEvent {
  email:     string;
  firstName: string;
  approved:  boolean;
  /** A rejection's reason, e-mailed to the applicant (REG-10). */
  reason?:   string;
}
