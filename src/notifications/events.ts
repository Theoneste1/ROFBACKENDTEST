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
  DiscussionThreadCreated:      'discussion.thread_created',
  DiscussionCommentPosted:      'discussion.comment_posted',
  ContentReported:              'moderation.content_reported',
  ContentModerated:             'moderation.content_moderated',
  ReportsResolved:              'moderation.reports_resolved',
} as const;

export interface AssignmentEvent        { assignmentId: string; note?: string }
export interface SubmissionEvent        { submissionId: string; reason?: string }
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
}
