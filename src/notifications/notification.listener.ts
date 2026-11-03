/**
 * Turns domain events into notifications.
 *
 * Handlers run asynchronously after the HTTP response; a failure here is
 * logged and never affects the action that emitted the event.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import {
  Events,
  type AssignmentEvent,
  type ContentModeratedEvent,
  type ContentReportedEvent,
  type DiscussionCommentEvent,
  type DiscussionThreadEvent,
  type LiveSessionEvent,
  type ReportsResolvedEvent,
  type MentorRequestDecidedEvent,
  type ResourceEvent,
  type ResultsPublishedEvent,
  type SubmissionEvent,
  type SubmissionsAssignedEvent,
} from './events.js';

const ASYNC = { async: true, suppressErrors: false } as const;

@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Assignments ──────────────────────────────────────────────────────────

  @OnEvent(Events.AssignmentSubmittedForReview, ASYNC)
  async onAssignmentSubmitted(e: AssignmentEvent) {
    await this.safe('assignment submitted', async () => {
      const a = await this.assignment(e.assignmentId);
      if (!a) return;
      await this.notifications.notify(await this.notifications.adminIds(), {
        category: 'ASSIGNMENTS',
        type:     Events.AssignmentSubmittedForReview,
        title:    'Assignment awaiting publication',
        body:     `"${a.title}" (${a.course.title} · ${a.division.name}) was submitted for review.`,
        data:     { assignmentId: a.id },
        link:     `/admin/assignments/${a.id}`,
      });
    });
  }

  @OnEvent(Events.AssignmentPublished, ASYNC)
  async onAssignmentPublished(e: AssignmentEvent) {
    await this.safe('assignment published', async () => {
      const a = await this.assignment(e.assignmentId);
      if (!a || a.course.status !== 'PUBLISHED') return;
      const students = await this.notifications.studentIdsInDivision(a.divisionId);
      await this.notifications.notify(students, {
        category: 'ASSIGNMENTS',
        type:     Events.AssignmentPublished,
        title:    `New assignment: ${a.title}`,
        body:     `A new ${a.course.title} assignment is available. Deadline: ${a.deadline.toUTCString()}.`,
        data:     { assignmentId: a.id, courseId: a.courseId },
        link:     `/assignments/${a.id}`,
      });
      await this.notifications.notify([a.createdById], {
        category: 'ASSIGNMENTS',
        type:     Events.AssignmentPublished,
        title:    'Your assignment was published',
        body:     `"${a.title}" is now visible to ${a.division.name} students.`,
        data:     { assignmentId: a.id },
        link:     `/mentor/assignments/${a.id}`,
      });
    });
  }

  @OnEvent(Events.AssignmentRejected, ASYNC)
  async onAssignmentRejected(e: AssignmentEvent) {
    await this.safe('assignment rejected', async () => {
      const a = await this.assignment(e.assignmentId);
      if (!a) return;
      await this.notifications.notify([a.createdById], {
        category: 'ASSIGNMENTS',
        type:     Events.AssignmentRejected,
        title:    'Assignment returned for changes',
        body:     `"${a.title}" was not published. Note from the administrator: ${e.note ?? '—'}`,
        data:     { assignmentId: a.id },
        link:     `/mentor/assignments/${a.id}`,
      });
    });
  }

  // ─── Submissions & reviews ────────────────────────────────────────────────

  @OnEvent(Events.SubmissionReceived, ASYNC)
  async onSubmissionReceived(e: SubmissionEvent) {
    await this.safe('submission received', async () => {
      const s = await this.submission(e.submissionId);
      if (!s) return;
      await this.notifications.notify([s.studentId], {
        category: 'SUBMISSIONS',
        type:     Events.SubmissionReceived,
        title:    'Submission received',
        body:     `We received your work for "${s.assignment.title}"${s.isLate ? ' (after the deadline)' : ''}.`,
        data:     { submissionId: s.id, assignmentId: s.assignmentId },
        link:     `/assignments/${s.assignmentId}`,
      }, { email: false });
    });
  }

  @OnEvent(Events.SubmissionsAssigned, ASYNC)
  async onSubmissionsAssigned(e: SubmissionsAssignedEvent) {
    await this.safe('submissions assigned', async () => {
      const a = await this.assignment(e.assignmentId);
      if (!a) return;
      for (const [mentorId, count] of Object.entries(e.byMentor)) {
        await this.notifications.notify([mentorId], {
          category: 'REVIEWS',
          type:     Events.SubmissionsAssigned,
          title:    `${count} submission(s) to review`,
          body:     `You have been assigned ${count} submission(s) for "${a.title}".`,
          data:     { assignmentId: a.id },
          link:     `/mentor/reviews?assignmentId=${a.id}`,
        });
      }
    });
  }

  @OnEvent(Events.ReviewReturned, ASYNC)
  async onReviewReturned(e: SubmissionEvent) {
    await this.safe('review returned', async () => {
      const s = await this.submission(e.submissionId);
      if (!s) return;
      await this.notifications.notify(await this.notifications.adminIds(), {
        category: 'REVIEWS',
        type:     Events.ReviewReturned,
        title:    'Review ready for approval',
        body:     `A completed review for "${s.assignment.title}" is waiting for approval.`,
        data:     { submissionId: s.id, assignmentId: s.assignmentId },
        link:     `/admin/submissions/${s.id}`,
      }, { email: false });
    });
  }

  @OnEvent(Events.ReviewRejected, ASYNC)
  @OnEvent(Events.ResultReopened, ASYNC)
  async onReviewSentBack(e: SubmissionEvent) {
    await this.safe('review sent back', async () => {
      const s = await this.submission(e.submissionId);
      const mentorId = s?.currentReview?.mentorId;
      if (!s || !mentorId) return;
      await this.notifications.notify([mentorId], {
        category: 'REVIEWS',
        type:     Events.ReviewRejected,
        title:    'Review returned to you',
        body:     `Your review for "${s.assignment.title}" needs another look. Reason: ${e.reason ?? '—'}`,
        data:     { submissionId: s.id },
        link:     `/mentor/reviews/${s.id}`,
      });
    });
  }

  @OnEvent(Events.ResubmissionRequested, ASYNC)
  async onResubmissionRequested(e: SubmissionEvent) {
    await this.safe('resubmission requested', async () => {
      const s = await this.prisma.submission.findUnique({
        where:  { id: e.submissionId },
        select: { id: true, studentId: true, assignmentId: true, resubmissionDueAt: true, assignment: { select: { title: true } } },
      });
      if (!s) return;
      const due = s.resubmissionDueAt ? ` by ${s.resubmissionDueAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
      await this.notifications.notify([s.studentId], {
        category: 'SUBMISSIONS',
        type:     Events.ResubmissionRequested,
        title:    'Please resubmit your work',
        body:     `Your mentor asked for a new attempt at "${s.assignment.title}"${due}. ${e.reason ?? ''}`.trim(),
        data:     { submissionId: s.id, assignmentId: s.assignmentId },
        link:     `/assignments/${s.assignmentId}`,
      });
    });
  }

  @OnEvent(Events.ResubmissionRequestWithdrawn, ASYNC)
  async onResubmissionRequestWithdrawn(e: SubmissionEvent) {
    await this.safe('resubmission request withdrawn', async () => {
      const s = await this.submission(e.submissionId);
      if (!s) return;
      await this.notifications.notify([s.studentId], {
        category: 'SUBMISSIONS',
        type:     Events.ResubmissionRequestWithdrawn,
        title:    'Resubmission no longer needed',
        body:     `Your work on "${s.assignment.title}" is being reviewed as submitted.`,
        data:     { submissionId: s.id, assignmentId: s.assignmentId },
        link:     `/assignments/${s.assignmentId}`,
      }, { email: false });
    });
  }

  @OnEvent(Events.ResultsPublished, ASYNC)
  async onResultsPublished(e: ResultsPublishedEvent) {
    await this.safe('results published', async () => {
      const subs = await this.prisma.submission.findMany({
        where:  { id: { in: e.submissionIds } },
        select: { id: true, studentId: true, assignmentId: true, assignment: { select: { title: true } } },
      });
      for (const s of subs) {
        await this.notifications.notify([s.studentId], {
          category: 'RESULTS',
          type:     Events.ResultsPublished,
          title:    'Your result is available',
          body:     `Your result and mentor feedback for "${s.assignment.title}" have been published.`,
          data:     { submissionId: s.id, assignmentId: s.assignmentId },
          link:     `/results/${s.id}`,
        });
      }
    });
  }

  // ─── Resources ────────────────────────────────────────────────────────────

  @OnEvent(Events.ResourcePublished, ASYNC)
  async onResourcePublished(e: ResourceEvent) {
    await this.safe('resource published', async () => {
      const r = await this.prisma.courseResource.findUnique({
        where:  { id: e.resourceId },
        select: { id: true, title: true, courseId: true, divisionId: true, course: { select: { title: true, status: true } } },
      });
      if (!r || r.course.status !== 'PUBLISHED') return;
      await this.notifications.notify(await this.notifications.studentIdsInDivision(r.divisionId), {
        category: 'RESOURCES',
        type:     Events.ResourcePublished,
        title:    `New ${r.course.title} material`,
        body:     `"${r.title}" was added to ${r.course.title}.`,
        data:     { resourceId: r.id, courseId: r.courseId },
        link:     `/courses/${r.courseId}/resources/${r.id}`,
      }, { email: false });
    });
  }

  // ─── Live sessions ────────────────────────────────────────────────────────

  @OnEvent(Events.LiveSessionScheduled, ASYNC)
  @OnEvent(Events.LiveSessionUpdated, ASYNC)
  @OnEvent(Events.LiveSessionCancelled, ASYNC)
  async onLiveSession(e: LiveSessionEvent & { kind?: string }) {
    await this.safe('live session', async () => {
      const s = await this.prisma.liveSession.findUnique({
        where:  { id: e.sessionId },
        select: { id: true, title: true, startsAt: true, status: true, divisionId: true, courseId: true, cancelReason: true, course: { select: { title: true, status: true } } },
      });
      if (!s || s.course.status !== 'PUBLISHED') return;

      const cancelled = s.status === 'CANCELLED';
      await this.notifications.notify(await this.notifications.studentIdsInDivision(s.divisionId), {
        category: 'LIVE_SESSIONS',
        type:     cancelled ? Events.LiveSessionCancelled : Events.LiveSessionScheduled,
        title:    cancelled ? `Cancelled: ${s.title}` : `Live session: ${s.title}`,
        body:     cancelled
          ? `The ${s.course.title} live session "${s.title}" was cancelled.${s.cancelReason ? ` Reason: ${s.cancelReason}` : ''}`
          : `${s.course.title} live session "${s.title}" starts ${s.startsAt.toUTCString()}.`,
        data:     { sessionId: s.id, courseId: s.courseId },
        link:     `/live-sessions/${s.id}`,
      });
    });
  }

  // ─── Discussions ──────────────────────────────────────────────────────────
  // In-app only: discussion activity is too frequent for e-mail. The exception
  // is moderation of a user's own content, which respects their DISCUSSIONS
  // e-mail preference.

  /** New thread → the mentors who teach that course to that division. */
  @OnEvent(Events.DiscussionThreadCreated, ASYNC)
  async onThreadCreated(e: DiscussionThreadEvent) {
    await this.safe('thread created', async () => {
      const t = await this.prisma.discussionThread.findUnique({
        where:  { id: e.threadId },
        select: {
          id: true, title: true, courseId: true, assignmentId: true, divisionId: true, createdById: true,
          course:     { select: { title: true } },
          assignment: { select: { title: true, courseId: true } },
        },
      });
      if (!t) return;
      const courseId = t.courseId ?? t.assignment!.courseId;
      const mentors = await this.prisma.mentorAssignment.findMany({
        where:  { courseId, divisionId: t.divisionId, isActive: true, mentor: { isActive: true } },
        select: { mentorId: true },
      });
      const where = t.assignment ? `the assignment "${t.assignment.title}"` : t.course!.title;
      await this.notifications.notify(mentors.map((m) => m.mentorId).filter((id) => id !== t.createdById), {
        category: 'DISCUSSIONS',
        type:     Events.DiscussionThreadCreated,
        title:    'New discussion',
        body:     `"${t.title}" was started in ${where}.`,
        data:     { threadId: t.id, ...(t.courseId && { courseId: t.courseId }), ...(t.assignmentId && { assignmentId: t.assignmentId }) },
        link:     `/discussions/${t.id}`,
      }, { email: false });
    });
  }

  /** New comment → the thread's author; a reply → also the comment's author. Never the poster. */
  @OnEvent(Events.DiscussionCommentPosted, ASYNC)
  async onCommentPosted(e: DiscussionCommentEvent) {
    await this.safe('comment posted', async () => {
      const c = await this.prisma.comment.findUnique({
        where:  { id: e.commentId },
        select: {
          id: true, threadId: true, authorId: true,
          author: { select: { firstName: true, lastName: true } },
          parent: { select: { authorId: true } },
          thread: { select: { title: true, createdById: true } },
        },
      });
      if (!c) return;
      const who = `${c.author.firstName ?? ''} ${c.author.lastName ?? ''}`.trim() || 'Someone';
      const notice = (title: string, body: string) => ({
        category: 'DISCUSSIONS' as const,
        type:     Events.DiscussionCommentPosted,
        title, body,
        data:     { threadId: c.threadId, commentId: c.id },
        link:     `/discussions/${c.threadId}`,
      });

      const parentAuthor = c.parent?.authorId;
      if (parentAuthor && parentAuthor !== c.authorId) {
        await this.notifications.notify([parentAuthor],
          notice('New reply to your comment', `${who} replied to your comment in "${c.thread.title}".`), { email: false });
      }
      const threadAuthor = c.thread.createdById;
      if (threadAuthor !== c.authorId && threadAuthor !== parentAuthor) {
        await this.notifications.notify([threadAuthor],
          notice('New activity in your discussion', `${who} posted in "${c.thread.title}".`), { email: false });
      }
    });
  }

  /** New report → administrators. */
  @OnEvent(Events.ContentReported, ASYNC)
  async onContentReported(e: ContentReportedEvent) {
    await this.safe('content reported', async () => {
      const r = await this.prisma.contentReport.findUnique({
        where:  { id: e.reportId },
        select: { id: true, reason: true, commentId: true },
      });
      if (!r) return;
      await this.notifications.notify(await this.notifications.adminIds(), {
        category: 'DISCUSSIONS',
        type:     Events.ContentReported,
        title:    'Content reported',
        body:     `A ${r.commentId ? 'comment' : 'discussion thread'} was reported (${r.reason.toLowerCase().replace(/_/g, ' ')}).`,
        data:     { reportId: r.id },
        link:     `/admin/moderation/reports/${r.id}`,
      }, { email: false });
    });
  }

  /** Content hidden, removed, restored or locked by an administrator → its author, with the reason. */
  @OnEvent(Events.ContentModerated, ASYNC)
  async onContentModerated(e: ContentModeratedEvent) {
    await this.safe('content moderated', async () => {
      const verbs: Partial<Record<ContentModeratedEvent['action'], string>> = {
        HIDE_COMMENT:    'hidden',   HIDE_THREAD:    'hidden',
        DELETE_COMMENT:  'removed',  DELETE_THREAD:  'removed',
        RESTORE_COMMENT: 'restored', RESTORE_THREAD: 'restored',
        LOCK_THREAD:     'locked',
      };
      const verb = verbs[e.action];
      if (!verb) return;

      let target: { authorId: string; kind: string; title: string } | null = null;
      if (e.commentId) {
        const c = await this.prisma.comment.findUnique({
          where: { id: e.commentId }, select: { authorId: true, thread: { select: { title: true } } },
        });
        if (c) target = { authorId: c.authorId, kind: 'comment', title: c.thread.title };
      } else if (e.threadId) {
        const t = await this.prisma.discussionThread.findUnique({
          where: { id: e.threadId }, select: { createdById: true, title: true },
        });
        if (t) target = { authorId: t.createdById, kind: 'discussion', title: t.title };
      }
      if (!target) return;

      await this.notifications.notify([target.authorId], {
        category: 'DISCUSSIONS',
        type:     Events.ContentModerated,
        title:    `Your ${target.kind} was ${verb}`,
        body:     `A moderator ${verb} your ${target.kind} in "${target.title}".${e.reason ? ` Reason: ${e.reason}` : ''}`,
        data:     { action: e.action, ...(e.threadId && { threadId: e.threadId }), ...(e.commentId && { commentId: e.commentId }) },
      });
    });
  }

  /** Report handled → each reporter learns the outcome (not the details). */
  @OnEvent(Events.ReportsResolved, ASYNC)
  async onReportsResolved(e: ReportsResolvedEvent) {
    await this.safe('reports resolved', async () => {
      if (e.reportIds.length === 0) return;
      const reports = await this.prisma.contentReport.findMany({
        where:  { id: { in: e.reportIds } },
        select: { reporterId: true },
      });
      await this.notifications.notify(reports.map((r) => r.reporterId), {
        category: 'DISCUSSIONS',
        type:     Events.ReportsResolved,
        title:    'Your report was reviewed',
        body:     e.actionTaken
          ? 'Thank you. A moderator reviewed the content you reported and took action.'
          : 'Thank you. A moderator reviewed the content you reported and found it within the guidelines.',
      }, { email: false });
    });
  }

  // ─── Accounts ─────────────────────────────────────────────────────────────

  @OnEvent(Events.MentorRequestDecided, ASYNC)
  async onMentorRequestDecided(e: MentorRequestDecidedEvent) {
    await this.safe('mentor request decided', async () => {
      await this.notifications.queueEmail(
        e.email,
        e.approved ? 'Your mentor application was approved' : 'Your mentor application',
        e.approved
          ? 'Your mentor application has been approved. You can now log in with the username and password you chose.'
          : 'Thank you for applying to mentor. Your application was not approved at this time.',
        { firstName: e.firstName, link: e.approved ? '/login' : undefined },
      );
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private assignment(id: string) {
    return this.prisma.assignment.findUnique({
      where:  { id },
      select: {
        id: true, title: true, deadline: true, courseId: true, divisionId: true, createdById: true,
        course:   { select: { title: true, status: true } },
        division: { select: { name: true } },
      },
    });
  }

  private submission(id: string) {
    return this.prisma.submission.findUnique({
      where:  { id },
      select: {
        id: true, studentId: true, assignmentId: true, isLate: true,
        assignment:    { select: { title: true } },
        currentReview: { select: { mentorId: true } },
      },
    });
  }

  private async safe(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Notification for "${label}" failed: ${(err as Error).message}`);
    }
  }
}
