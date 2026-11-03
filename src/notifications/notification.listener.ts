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
  type LiveSessionEvent,
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
