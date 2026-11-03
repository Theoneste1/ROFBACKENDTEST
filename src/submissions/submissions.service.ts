import {
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Response } from 'express';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  Prisma,
  type ReviewEventType,
  type ReviewStatus,
  type SubmissionStatus,
  type FileObject,
} from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import { validateScore, computePercentage, computePointsAwarded } from './score.utils.js';
import { DistributionStrategy, OPEN_REVIEW_STATUSES, RESUBMITTABLE } from './submissions.constants.js';
import {
  adminView,
  mentorView,
  REVIEW_HISTORY_SELECT,
  studentView,
  SUBMISSION_INCLUDE,
  type SubmissionWithRelations,
} from './submission.views.js';

import { CreateSubmissionDto } from './dto/create-submission.dto.js';
import { AssignSubmissionDto, DistributeSubmissionsDto } from './dto/assign-submission.dto.js';
import { MarkSubmissionDto } from './dto/mark-submission.dto.js';
import { ApproveResultDto, RejectResultDto } from './dto/review-result.dto.js';
import { ReopenResultDto } from './dto/correct-result.dto.js';
import { ListSubmissionsDto } from './dto/list-submissions.dto.js';
import { RequestResubmissionDto } from './dto/request-resubmission.dto.js';
import { deriveStudentDisplayStatus } from './student-display-status.js';

/** @deprecated Import from common/auth-user instead. Kept for compatibility. */
export type { CallerCtx } from '../common/auth-user.js';

type Tx = Prisma.TransactionClient;

/** One submission attempt: stored file ids and/or a typed answer. */
type Attempt = { fileIds: string[]; note?: string; answerText?: string };

const MAX_RESUBMISSION_WINDOW_MS = 60 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// ─── Workflow ─────────────────────────────────────────────────────────────────
//
// Submission.status (overall)  ↔  MentorReview.status (current review cycle)
//
//  SUBMITTED            (no active review)        student submitted / resubmitted
//  ASSIGNED             ASSIGNED                  admin assign / distribute
//  IN_REVIEW            IN_PROGRESS               mentor started
//  MARKED               MARKED                    mentor scored (draft)
//  SUBMITTED_TO_ADMIN   RETURNED                  mentor returned the review
//  APPROVED             APPROVED                  admin accepted
//  REJECTED             SENT_BACK                 admin sent it back / reopened
//  PUBLISHED            PUBLISHED                 admin released the result
//  RESUBMISSION_        RESUBMISSION_REQUESTED    mentor asked for a new attempt;
//    REQUESTED                                    the student's resubmission starts
//                                                 a new cycle with the same mentor
//
// Each (re)assignment and each reopen starts a new review CYCLE (new
// MentorReview row); earlier cycles become SUPERSEDED or CANCELLED and remain
// as history. Every step appends a ReviewEvent.
//
// Admins never write score or feedback; mentor routes refuse ADMIN callers.
// Every transition is a conditional UPDATE … WHERE status IN (…) so concurrent
// requests cannot both succeed.

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly access:    AccessService,
    private readonly storage:   StorageService,
    private readonly settings:  SettingsService,
    private readonly events:    EventEmitter2,
    private readonly activity:  ActivityService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3 — Student submits / resubmits work
  // ═══════════════════════════════════════════════════════════════════════════

  async submit(data: CreateSubmissionDto, user: AuthUser, files: Express.Multer.File[] = []) {
    if (files.length === 0 && !data.answerText) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'ANSWER_REQUIRED',
        'Type your answer ("answerText") or attach your work (field "files", or "file").',
      );
    }

    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: data.assignmentId },
      select: {
        id: true, title: true, status: true, deadline: true, courseId: true, divisionId: true,
        allowResubmission: true, maxResubmissions: true, allowLateSubmission: true,
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, assignment);

    const existing = await this.prisma.submission.findUnique({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: user.id } },
      select: {
        id: true, status: true, revisionCount: true, currentReviewId: true, resubmissionDueAt: true,
        currentReview: { select: { mentorId: true } },
      },
    });
    // A mentor's request opens its own window, even on a closed assignment.
    const requested = existing?.status === 'RESUBMISSION_REQUESTED';

    if (assignment.status === 'CLOSED' && !requested) {
      throw new AppError(HttpStatus.CONFLICT, 'ASSIGNMENT_CLOSED', 'This assignment is closed and no longer accepts submissions.');
    }
    if (!['PUBLISHED', 'CLOSED'].includes(assignment.status)) throw new NotFoundException('Assignment not found.');

    const isLate = new Date() > assignment.deadline;

    // ── Validate BEFORE storing any file ──────────────────────────────────
    if (existing && requested) {
      if (!existing.resubmissionDueAt || new Date() > existing.resubmissionDueAt) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'RESUBMISSION_WINDOW_CLOSED',
          'The time allowed for the requested resubmission has passed. Contact your mentor.',
        );
      }
      if (assignment.maxResubmissions > 0 && existing.revisionCount >= assignment.maxResubmissions) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'RESUBMISSION_LIMIT_REACHED',
          `You have reached the maximum number of resubmissions (${assignment.maxResubmissions}).`,
        );
      }
    } else if (existing) {
      if (isLate) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'DEADLINE_PASSED', 'The deadline has passed. Resubmission is not permitted.');
      }
      if (!assignment.allowResubmission) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'RESUBMISSION_NOT_ALLOWED', 'This assignment does not permit resubmissions.');
      }
      if (assignment.maxResubmissions > 0 && existing.revisionCount >= assignment.maxResubmissions) {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'RESUBMISSION_LIMIT_REACHED',
          `You have reached the maximum number of resubmissions (${assignment.maxResubmissions}).`,
        );
      }
      if (!RESUBMITTABLE.includes(existing.status)) {
        throw invalidState('Your work is already under review and can no longer be replaced.');
      }
    } else if (isLate && !assignment.allowLateSubmission) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DEADLINE_PASSED', 'The deadline for this assignment has passed.');
    }

    const stored: FileObject[] = [];
    for (const f of files) stored.push(await this.storage.store(f, 'SUBMISSION', user.id));
    const attempt: Attempt = { fileIds: stored.map((s) => s.id), note: data.note, answerText: data.answerText };

    // After a request, the new attempt goes straight back to the requesting
    // mentor — if they still teach this course × division.
    const returnTo = requested && existing?.currentReview && await this.isEligibleMentor(existing.currentReview.mentorId, assignment)
      ? existing.currentReview.mentorId
      : null;

    const submission = existing
      ? await this.resubmit(existing, attempt, user, returnTo)
      : await this.firstSubmit(assignment.id, attempt, isLate, user);

    if (returnTo) {
      this.events.emit(Events.SubmissionsAssigned, { assignmentId: assignment.id, byMentor: { [returnTo]: 1 } });
    }

    this.activity.record(user.id, existing ? 'SUBMISSION_RESUBMITTED' : 'SUBMISSION_CREATED', {
      courseId: assignment.courseId, entityType: 'Submission', entityId: submission.id,
    });
    this.events.emit(Events.SubmissionReceived, { submissionId: submission.id });
    return studentView(submission);
  }

  private async firstSubmit(assignmentId: string, attempt: Attempt, isLate: boolean, user: AuthUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const created = await tx.submission.create({
          data: {
            assignmentId,
            studentId:   user.id,
            status:      'SUBMITTED',
            isLate,
            submittedAt: now,
            revisions: {
              create: {
                revisionNumber: 1, note: attempt.note ?? null, answerText: attempt.answerText ?? null,
                isLate, submittedById: user.id, submittedAt: now,
                attachments: { create: attempt.fileIds.map((fileId, i) => ({ fileId, sortOrder: i })) },
              },
            },
          },
        });
        await this.audit.log({
          actorId: user.id, actorRole: user.role,
          action: 'SUBMIT_ASSIGNMENT', entity: 'Submission', entityId: created.id,
          metadata: { assignmentId, isLate, files: attempt.fileIds.length, typedAnswer: !!attempt.answerText },
        }, tx);
        return this.load(tx, created.id);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(HttpStatus.CONFLICT, 'ALREADY_SUBMITTED', 'You have already submitted this assignment.');
      }
      throw err;
    }
  }

  /**
   * Record a new attempt. Every attempt is kept as a SubmissionRevision.
   *
   * - Voluntary resubmission (SUBMITTED/ASSIGNED): a mentor assigned but not
   *   yet started is CANCELLED and the work returns to the distribution queue,
   *   so the review always covers the latest version.
   * - Requested resubmission (RESUBMISSION_REQUESTED): the request is cleared
   *   and a new review cycle starts with `returnTo` (the requesting mentor), or
   *   the work returns to the queue when that mentor is no longer eligible.
   */
  private async resubmit(
    existing: { id: string; status: SubmissionStatus; revisionCount: number; currentReviewId: string | null },
    attempt: Attempt,
    user: AuthUser,
    returnTo: string | null,
  ) {
    const requested = existing.status === 'RESUBMISSION_REQUESTED';
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.submission.updateMany({
        // Optimistic lock: same status group AND nobody resubmitted meanwhile.
        where: {
          id: existing.id, revisionCount: existing.revisionCount,
          status: { in: requested ? ['RESUBMISSION_REQUESTED'] : RESUBMITTABLE },
        },
        data:  {
          revisionCount: existing.revisionCount + 1, submittedAt: now, status: 'SUBMITTED',
          isLate: false, currentReviewId: null,
          resubmissionRequestedAt: null, resubmissionDueAt: null, resubmissionNote: null,
        },
      });
      if (count === 0) throw invalidState('Your submission changed while uploading. Refresh and try again.');

      if (existing.currentReviewId && !requested) {
        await this.moveReview(tx, existing.currentReviewId, ['ASSIGNED'], { status: 'CANCELLED' },
          'CANCELLED', user.id, 'Student replaced their work before review started.');
      }

      const revisionNumber = existing.revisionCount + 2;
      await tx.submissionRevision.create({
        data: {
          submissionId: existing.id, revisionNumber, note: attempt.note ?? null, answerText: attempt.answerText ?? null,
          submittedById: user.id, submittedAt: now,
          attachments: { create: attempt.fileIds.map((fileId, i) => ({ fileId, sortOrder: i })) },
        },
      });

      if (returnTo) {
        await this.moveSubmission(tx, existing.id, ['SUBMITTED'], 'ASSIGNED');
        await this.startCycle(tx, existing.id, returnTo, returnTo, 'ASSIGNED');
      }

      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'RESUBMIT_ASSIGNMENT', entity: 'Submission', entityId: existing.id,
        metadata: {
          revisionNumber, requested, returnedToMentorId: returnTo,
          ...(!requested && { cancelledReviewId: existing.currentReviewId }),
        },
      }, tx);

      return this.load(tx, existing.id);
    });
  }

  /** STUDENT: own submissions. Score and feedback appear only once published. */
  async getMySubmissions(user: AuthUser, q: ListSubmissionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SubmissionWhereInput = {
      studentId: user.id,
      ...(q.assignmentId && { assignmentId: q.assignmentId }),
      ...(q.status && { status: q.status }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.submission.findMany({ where, include: SUBMISSION_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.submission.count({ where }),
    ]);
    return paginated(rows.map((s) => studentView(s as unknown as SubmissionWithRelations)), total, page, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read (role-aware)
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: every submission, filterable. */
  async findAll(q: ListSubmissionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SubmissionWhereInput = {
      ...(q.assignmentId && { assignmentId: q.assignmentId }),
      ...(q.mentorId     && { currentReview: { mentorId: q.mentorId } }),
      ...(q.studentId    && { studentId: q.studentId }),
      ...(q.status       && { status: q.status }),
      ...((q.courseId || q.divisionId) && {
        assignment: {
          ...(q.courseId   && { courseId: q.courseId }),
          ...(q.divisionId && { divisionId: q.divisionId }),
        },
      }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.submission.findMany({ where, include: SUBMISSION_INCLUDE, orderBy: { submittedAt: 'asc' }, skip, take }),
      this.prisma.submission.count({ where }),
    ]);
    return paginated(rows.map((s) => adminView(s as unknown as SubmissionWithRelations)), total, page, limit);
  }

  /** Single submission, projected for the caller's role. Opening a published result is logged. */
  async findOne(submissionId: string, user: AuthUser) {
    const s = await this.loadForCaller(submissionId, user);
    if (user.role === 'STUDENT') {
      if (s.status === 'PUBLISHED') {
        this.activity.record(user.id, 'RESULT_VIEWED', { entityType: 'Submission', entityId: s.id });
      }
      return studentView(s);
    }
    if (user.role === 'MENTOR') return mentorView(s);
    return adminView(s);
  }

  /**
   * Review history: every cycle with its events and files.
   * Admins see all cycles; mentors see only the cycles they did themselves.
   */
  async reviewHistory(submissionId: string, user: AuthUser) {
    if (user.role === 'STUDENT') throw new NotFoundException('Submission not found.');
    const sub = await this.prisma.submission.findUnique({ where: { id: submissionId }, select: { id: true } });
    if (!sub) throw new NotFoundException('Submission not found.');

    const reviews = await this.prisma.mentorReview.findMany({
      where:   { submissionId, ...(user.role === 'MENTOR' && { mentorId: user.id }) },
      orderBy: { cycle: 'asc' },
      select:  REVIEW_HISTORY_SELECT,
    });
    if (user.role === 'MENTOR' && reviews.length === 0) throw new NotFoundException('Submission not found.');
    // Mentors never see the administrators' internal coordination note.
    return user.role === 'MENTOR' ? reviews.map(({ coordinationNote: _internal, ...r }) => r) : reviews;
  }

  /**
   * Submission history: every attempt (answer, files, timestamps, lateness)
   * and every resubmission request, oldest first. Same access as findOne:
   * the student who owns it, the mentor of the current review, admins.
   * Students never see who requested (mentors stay anonymous until results).
   */
  async attemptHistory(submissionId: string, user: AuthUser) {
    const s = await this.loadForCaller(submissionId, user);
    const events = await this.prisma.reviewEvent.findMany({
      where:   { review: { submissionId }, type: { in: ['RESUBMISSION_REQUESTED', 'RESUBMISSION_REQUEST_WITHDRAWN'] } },
      orderBy: { createdAt: 'asc' },
      select:  {
        type: true, note: true, createdAt: true,
        actor: { select: { id: true, username: true, firstName: true, lastName: true } },
      },
    });
    return {
      submissionId:  s.id,
      status:        s.status,
      displayStatus: deriveStudentDisplayStatus({ submissionStatus: s.status }),
      attempts:      s.revisions,
      resubmissionRequests: events.map((e) => ({
        type: e.type, note: e.note, at: e.createdAt,
        ...(user.role !== 'STUDENT' && { by: e.actor }),
      })),
      openRequest: s.status === 'RESUBMISSION_REQUESTED'
        ? { note: s.resubmissionNote, dueAt: s.resubmissionDueAt, requestedAt: s.resubmissionRequestedAt }
        : null,
    };
  }

  /** MENTOR: submissions whose current review is mine (including ones awaiting a requested resubmission). */
  async getReviewQueue(user: AuthUser, q: ListSubmissionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SubmissionWhereInput = {
      currentReview: { mentorId: user.id },
      ...(q.assignmentId && { assignmentId: q.assignmentId }),
      status: q.status ?? {
        in: ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED', 'SUBMITTED_TO_ADMIN', 'RESUBMISSION_REQUESTED'],
      },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.submission.findMany({ where, include: SUBMISSION_INCLUDE, orderBy: { submittedAt: 'asc' }, skip, take }),
      this.prisma.submission.count({ where }),
    ]);
    return paginated(rows.map((s) => mentorView(s as unknown as SubmissionWithRelations)), total, page, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4 — Admin distributes submissions to mentors
  // ═══════════════════════════════════════════════════════════════════════════

  async assign(submissionId: string, body: AssignSubmissionDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    await this.requireEligibleMentor(body.mentorId, sub.assignment);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveSubmission(tx, submissionId, ['SUBMITTED'], 'ASSIGNED');
      await this.startCycle(tx, submissionId, body.mentorId, user.id, 'ASSIGNED');
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'ASSIGN_SUBMISSION', entity: 'Submission', entityId: submissionId, metadata: { mentorId: body.mentorId },
      }, tx);
      return this.load(tx, submissionId);
    });

    this.events.emit(Events.SubmissionsAssigned, { assignmentId: sub.assignmentId, byMentor: { [body.mentorId]: 1 } });
    return adminView(updated);
  }

  /**
   * Move a review to a different mentor. The current cycle is SUPERSEDED (it
   * stays in the history with any draft score) and a new cycle starts.
   */
  async reassign(submissionId: string, body: AssignSubmissionDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    if (sub.currentReview?.mentorId === body.mentorId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SAME_MENTOR', 'The submission is already assigned to this mentor.');
    }
    await this.requireEligibleMentor(body.mentorId, sub.assignment);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveSubmission(tx, submissionId, ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED'], 'ASSIGNED');
      if (sub.currentReviewId) {
        await this.moveReview(tx, sub.currentReviewId, OPEN_REVIEW_STATUSES, { status: 'SUPERSEDED' },
          'REASSIGNED', user.id, `Reassigned to mentor ${body.mentorId}.`);
      }
      await this.startCycle(tx, submissionId, body.mentorId, user.id, 'ASSIGNED');
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'REASSIGN_SUBMISSION', entity: 'Submission', entityId: submissionId,
        metadata: { previousMentorId: sub.currentReview?.mentorId ?? null, newMentorId: body.mentorId },
      }, tx);
      return this.load(tx, submissionId);
    });

    this.events.emit(Events.SubmissionsAssigned, { assignmentId: sub.assignmentId, byMentor: { [body.mentorId]: 1 } });
    return adminView(updated);
  }

  /**
   * Distribute every unassigned (SUBMITTED) submission of an assignment across
   * the mentors assigned to its course × division. The run is recorded as a
   * DistributionBatch.
   */
  async distribute(assignmentId: string, body: DistributeSubmissionsDto, user: AuthUser) {
    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { id: true, courseId: true, divisionId: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');

    const strategy = body.strategy
      ?? ((await this.settings.get('submissions.defaultDistributionStrategy')) as DistributionStrategy);

    const eligible = await this.prisma.mentorAssignment.findMany({
      where: {
        courseId: assignment.courseId, divisionId: assignment.divisionId, isActive: true,
        mentor: { isActive: true, isApproved: true, role: 'MENTOR' },
        ...(body.mentorIds && { mentorId: { in: body.mentorIds } }),
      },
      select:  { mentorId: true },
      orderBy: { createdAt: 'asc' },
    });
    const mentorIds = eligible.map((e) => e.mentorId);

    if (body.mentorIds) {
      const notEligible = body.mentorIds.filter((id) => !mentorIds.includes(id));
      if (notEligible.length) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'MENTOR_NOT_ELIGIBLE',
          'Some mentors are not assigned to this course and division.', { mentorIds: notEligible });
      }
    }
    if (mentorIds.length === 0) {
      throw new AppError(HttpStatus.CONFLICT, 'NO_ELIGIBLE_MENTORS', 'No active mentor is assigned to this course and division.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.submission.findMany({
        where: { assignmentId, status: 'SUBMITTED' }, orderBy: { submittedAt: 'asc' }, select: { id: true },
      });

      // Current open workload per mentor (across all assignments).
      const loads = new Map<string, number>(mentorIds.map((id) => [id, 0]));
      const grouped = await tx.mentorReview.groupBy({
        by: ['mentorId'], where: { mentorId: { in: mentorIds }, status: { in: OPEN_REVIEW_STATUSES } },
        _count: { _all: true },
      });
      for (const g of grouped) loads.set(g.mentorId, g._count._all);

      const batch = await tx.distributionBatch.create({
        data: { assignmentId, strategy, createdById: user.id },
      });

      const byMentor: Record<string, number> = {};
      let turn = 0;
      for (const s of pending) {
        const mentorId = strategy === DistributionStrategy.ROUND_ROBIN
          ? mentorIds[turn++ % mentorIds.length]
          : [...loads.entries()].sort((a, b) => a[1] - b[1])[0][0];

        const { count } = await tx.submission.updateMany({
          where: { id: s.id, status: 'SUBMITTED' }, data: { status: 'ASSIGNED' },
        });
        if (count === 0) continue;
        await this.startCycle(tx, s.id, mentorId, user.id, 'ASSIGNED', batch.id);
        loads.set(mentorId, (loads.get(mentorId) ?? 0) + 1);
        byMentor[mentorId] = (byMentor[mentorId] ?? 0) + 1;
      }

      const distributed = Object.values(byMentor).reduce((a, b) => a + b, 0);
      await tx.distributionBatch.update({ where: { id: batch.id }, data: { assignedCount: distributed } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'DISTRIBUTE_SUBMISSIONS', entity: 'Assignment', entityId: assignmentId,
        metadata: { batchId: batch.id, strategy, distributed, byMentor },
      }, tx);

      return { batchId: batch.id, strategy, distributed, byMentor };
    }, { timeout: 60_000 });

    if (result.distributed > 0) {
      this.events.emit(Events.SubmissionsAssigned, { assignmentId, byMentor: result.byMentor });
    }
    return result;
  }

  async listDistributionBatches(assignmentId: string) {
    return this.prisma.distributionBatch.findMany({
      where:   { assignmentId },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { id: true, username: true } },
        reviews:   { select: { id: true, submissionId: true, status: true, mentor: { select: { id: true, username: true } } } },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5–6 — Mentor reviews, scores and returns the review
  // ═══════════════════════════════════════════════════════════════════════════

  async startReview(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireAssignedMentor(sub, user);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, ['ASSIGNED', 'SENT_BACK'], { status: 'IN_PROGRESS', startedAt: new Date() },
        'STARTED', user.id, null, { mentorId: user.id });
      await this.moveSubmission(tx, submissionId, ['ASSIGNED', 'REJECTED'], 'IN_REVIEW');
      return this.load(tx, submissionId);
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'START_REVIEW', entity: 'Submission', entityId: submissionId,
    });
    return mentorView(updated);
  }

  /** Save score and formal feedback (repeatable until the review is returned). */
  async mark(submissionId: string, data: MarkSubmissionDto, user: AuthUser, files: Express.Multer.File[] = []) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireAssignedMentor(sub, user);

    if (!['IN_PROGRESS', 'MARKED'].includes(sub.currentReview!.status)) {
      throw invalidState(`Start the review before marking. Current status: "${sub.status}".`);
    }
    validateScore(data.score, sub.assignment.maximumMarks);
    const percentage = computePercentage(data.score, sub.assignment.maximumMarks);

    const stored: FileObject[] = [];
    for (const f of files) stored.push(await this.storage.store(f, 'FEEDBACK', user.id));

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, ['IN_PROGRESS', 'MARKED'], {
        status: 'MARKED', score: data.score, percentage, feedback: data.mentorFeedback, markedAt: new Date(),
      }, 'MARKED', user.id, null, { mentorId: user.id }, data.score);

      if (stored.length) {
        const max = await tx.reviewAttachment.aggregate({ where: { reviewId }, _max: { sortOrder: true } });
        let order = (max._max.sortOrder ?? -1) + 1;
        for (const s of stored) await tx.reviewAttachment.create({ data: { reviewId, fileId: s.id, sortOrder: order++ } });
      }
      await this.moveSubmission(tx, submissionId, ['IN_REVIEW', 'MARKED'], 'MARKED');
      return this.load(tx, submissionId);
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'MARK_SUBMISSION', entity: 'Submission', entityId: submissionId,
      metadata: { reviewId, score: data.score, percentage, maximumMarks: sub.assignment.maximumMarks, files: stored.length },
    });
    return mentorView(updated);
  }

  /** Remove a feedback file from the current review (before it is returned). */
  async removeReviewAttachment(submissionId: string, attachmentId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireAssignedMentor(sub, user);
    if (!['IN_PROGRESS', 'MARKED'].includes(sub.currentReview!.status)) {
      throw invalidState('Feedback files can only be changed while the review is in progress.');
    }
    const { count } = await this.prisma.reviewAttachment.deleteMany({ where: { id: attachmentId, reviewId } });
    if (count === 0) throw new NotFoundException('Attachment not found.');
    return mentorView(await this.load(this.prisma, submissionId));
  }

  /** Return the completed review to the administrators. */
  async submitToAdmin(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireAssignedMentor(sub, user);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, ['MARKED'], { status: 'RETURNED', returnedAt: new Date() },
        'RETURNED', user.id, null, { mentorId: user.id });
      await this.moveSubmission(tx, submissionId, ['MARKED'], 'SUBMITTED_TO_ADMIN');
      return this.load(tx, submissionId);
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'RETURN_REVIEW_TO_ADMIN', entity: 'Submission', entityId: submissionId,
    });
    this.events.emit(Events.ReviewReturned, { submissionId });
    return mentorView(updated);
  }

  /**
   * Ask the student for a new attempt (assigned mentor, review not yet
   * returned). Only where the assignment allows resubmissions and the
   * student is under its limit. The current cycle ends as
   * RESUBMISSION_REQUESTED (any draft score stays in its history).
   */
  async requestResubmission(submissionId: string, body: RequestResubmissionDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireAssignedMentor(sub, user);
    const a = sub.assignment;

    if (!a.allowResubmission) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'RESUBMISSION_NOT_ALLOWED', 'This assignment does not permit resubmissions.');
    }
    if (a.maxResubmissions > 0 && sub.revisionCount >= a.maxResubmissions) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'RESUBMISSION_LIMIT_REACHED',
        `The student has already used all ${a.maxResubmissions} resubmission(s).`,
      );
    }
    if (!['PUBLISHED', 'CLOSED'].includes(a.status)) throw invalidState('This assignment is archived.');

    const now   = new Date();
    const dueAt = body.dueAt
      ? new Date(body.dueAt)
      // Default window: the administrator's setting, or until the deadline if later.
      : new Date(Math.max(a.deadline.getTime(), now.getTime() + (await this.settings.get('submissions.resubmissionRequestDays')) * DAY_MS));
    if (dueAt <= now) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DEADLINE_IN_PAST', 'The resubmission due date must be in the future.');
    }
    if (dueAt.getTime() - now.getTime() > MAX_RESUBMISSION_WINDOW_MS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DUE_DATE_TOO_FAR', 'The resubmission due date must be within 60 days.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, OPEN_REVIEW_STATUSES, { status: 'RESUBMISSION_REQUESTED' },
        'RESUBMISSION_REQUESTED', user.id, body.note, { mentorId: user.id });
      await this.moveSubmission(tx, submissionId, ['ASSIGNED', 'IN_REVIEW', 'MARKED', 'REJECTED'], 'RESUBMISSION_REQUESTED', {
        resubmissionRequestedAt: now, resubmissionDueAt: dueAt, resubmissionNote: body.note,
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'REQUEST_RESUBMISSION', entity: 'Submission', entityId: submissionId,
        metadata: { reviewId, dueAt: dueAt.toISOString(), note: body.note },
      }, tx);
      return this.load(tx, submissionId);
    });

    this.events.emit(Events.ResubmissionRequested, { submissionId, reason: body.note });
    return mentorView(updated);
  }

  /**
   * Withdraw an open request (e.g. the due date passed without a new attempt):
   * the review resumes on the work already submitted.
   */
  async withdrawResubmissionRequest(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireAssignedMentor(sub, user);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, ['RESUBMISSION_REQUESTED'], { status: 'IN_PROGRESS' },
        'RESUBMISSION_REQUEST_WITHDRAWN', user.id, null, { mentorId: user.id });
      await this.moveSubmission(tx, submissionId, ['RESUBMISSION_REQUESTED'], 'IN_REVIEW', {
        resubmissionRequestedAt: null, resubmissionDueAt: null, resubmissionNote: null,
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'WITHDRAW_RESUBMISSION_REQUEST', entity: 'Submission', entityId: submissionId, metadata: { reviewId },
      }, tx);
      return this.load(tx, submissionId);
    });

    this.events.emit(Events.ResubmissionRequestWithdrawn, { submissionId });
    return mentorView(updated);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 7 — Admin coordinates and publishes results
  // ═══════════════════════════════════════════════════════════════════════════

  async approve(submissionId: string, body: ApproveResultDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireCurrentReview(sub);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, ['RETURNED'], {
        status: 'APPROVED', decidedAt: new Date(), decidedById: user.id, coordinationNote: body.coordinationNote ?? null,
      }, 'APPROVED', user.id, null);
      await this.moveSubmission(tx, submissionId, ['SUBMITTED_TO_ADMIN'], 'APPROVED');
      return this.load(tx, submissionId);
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'APPROVE_RESULT', entity: 'Submission', entityId: submissionId,
    });
    return adminView(updated);
  }

  /** Send the review back to its mentor (score and feedback are kept for revision). */
  async reject(submissionId: string, body: RejectResultDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const reviewId = this.requireCurrentReview(sub);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.moveReview(tx, reviewId, ['RETURNED', 'APPROVED'], {
        status: 'SENT_BACK', decidedAt: new Date(), decidedById: user.id, decisionNote: body.rejectionReason,
      }, 'SENT_BACK', user.id, body.rejectionReason);
      await this.moveSubmission(tx, submissionId, ['SUBMITTED_TO_ADMIN', 'APPROVED'], 'REJECTED');
      return this.load(tx, submissionId);
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REJECT_RESULT', entity: 'Submission', entityId: submissionId, metadata: { rejectionReason: body.rejectionReason },
    });
    this.events.emit(Events.ReviewRejected, { submissionId, reason: body.rejectionReason });
    return adminView(updated);
  }

  /** Publish one APPROVED result (recorded as a one-result release). */
  async publish(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const { published } = await this.release(sub.assignmentId, [sub.id], user);
    if (published.length === 0) {
      throw invalidState(`Only APPROVED results can be published. Current: "${sub.status}".`);
    }
    return adminView(await this.load(this.prisma, submissionId));
  }

  /** Publish every APPROVED result of an assignment as one release. */
  async publishAssignmentResults(assignmentId: string, user: AuthUser, note?: string) {
    const assignment = await this.prisma.assignment.findUnique({ where: { id: assignmentId }, select: { id: true } });
    if (!assignment) throw new NotFoundException('Assignment not found.');

    const approved = await this.prisma.submission.findMany({
      where: { assignmentId, status: 'APPROVED' }, select: { id: true },
    });
    const { published, releaseId } = await this.release(assignmentId, approved.map((a) => a.id), user, note);

    const remaining = await this.prisma.submission.groupBy({
      by: ['status'], where: { assignmentId, status: { not: 'PUBLISHED' } }, _count: { _all: true },
    });

    return {
      releaseId,
      published: published.length,
      notYetPublished: Object.fromEntries(remaining.map((r) => [r.status, r._count._all])),
    };
  }

  async listResultReleases(assignmentId: string) {
    return this.prisma.resultRelease.findMany({
      where:   { assignmentId },
      orderBy: { publishedAt: 'desc' },
      include: {
        publishedBy: { select: { id: true, username: true } },
        submissions: { select: { id: true, studentId: true, status: true } },
      },
    });
  }

  /**
   * Correct a published result: withdraw it from the student, remove its
   * points and start a new review cycle for the same mentor (pre-filled with
   * the previous score and feedback). Admins never change scores themselves.
   */
  async reopen(submissionId: string, body: ReopenResultDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    if (sub.status !== 'PUBLISHED' || !sub.publishedReview) {
      throw invalidState(`Only PUBLISHED results can be reopened. Current: "${sub.status}".`);
    }
    const previous = sub.publishedReview;

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.submission.updateMany({
        where: { id: submissionId, status: 'PUBLISHED' },
        data:  { status: 'REJECTED', publishedReviewId: null, pointsAwarded: 0, publishedAt: null, resultReleaseId: null },
      });
      if (count === 0) throw invalidState('This result is no longer published.');

      await this.moveReview(tx, previous.id, ['PUBLISHED'], { status: 'SUPERSEDED' }, 'REOPENED', user.id, body.reopenNote);
      const next = await this.startCycle(tx, submissionId, previous.mentorId, user.id, 'SENT_BACK', null, {
        score: previous.score, percentage: previous.percentage, feedback: previous.feedback,
        decisionNote: body.reopenNote, decidedAt: new Date(), decidedById: user.id,
      });
      await this.addEvent(tx, next.id, 'SENT_BACK', user.id, body.reopenNote, previous.score);

      await this.recomputeStudentPoints(tx, sub.studentId);
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'REOPEN_RESULT', entity: 'Submission', entityId: submissionId,
        metadata: { previousReviewId: previous.id, previousScore: previous.score, pointsRemoved: sub.pointsAwarded, reopenNote: body.reopenNote },
      }, tx);
      return this.load(tx, submissionId);
    });

    this.events.emit(Events.ResultReopened, { submissionId, reason: body.reopenNote });
    return { ...adminView(updated), previousScore: previous.score };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Files
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A file of the student's work: a specific attachment, the first file of a
   * given revision, or (default) the first file of the latest revision.
   */
  async serveSubmissionFile(
    submissionId: string, user: AuthUser, res: Response,
    opts: { revisionNumber?: number; attachmentId?: string } = {},
  ) {
    const s = await this.loadForCaller(submissionId, user);
    const revision = opts.revisionNumber !== undefined
      ? s.revisions.find((r) => r.revisionNumber === opts.revisionNumber)
      : s.revisions[s.revisions.length - 1];

    const attachmentId = opts.attachmentId ?? revision?.attachments[0]?.id;
    const owned = s.revisions.some((r) => r.attachments.some((a) => a.id === attachmentId));
    if (!attachmentId || !owned) throw new NotFoundException('File not found.');

    const attachment = await this.prisma.submissionAttachment.findUniqueOrThrow({
      where: { id: attachmentId }, include: { file: true },
    });
    await this.storage.send(res, attachment.file, { download: true });
  }

  /**
   * A mentor feedback file. Students: only from the published review.
   * Mentors: their current review. Admins: published or current review.
   */
  async serveFeedbackFile(submissionId: string, user: AuthUser, res: Response, attachmentId?: string) {
    const s = await this.loadForCaller(submissionId, user);
    if (user.role === 'STUDENT' && s.status !== 'PUBLISHED') {
      throw new AppError(HttpStatus.FORBIDDEN, 'RESULT_NOT_PUBLISHED', 'Feedback is available once results are published.');
    }
    const review = user.role === 'STUDENT' ? s.publishedReview : (s.currentReview ?? s.publishedReview);
    const attachment = review?.attachments.find((a) => (attachmentId ? a.id === attachmentId : true));
    if (!attachment) throw new NotFoundException('No feedback file attached to this result.');

    const full = await this.prisma.reviewAttachment.findUniqueOrThrow({ where: { id: attachment.id }, include: { file: true } });
    await this.storage.send(res, full.file, { download: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Points
  // ═══════════════════════════════════════════════════════════════════════════

  /** Rebuild every student's cached points from published results (maintenance). */
  async recomputeAllPoints(user: AuthUser) {
    const students = await this.prisma.user.findMany({ where: { role: 'STUDENT' }, select: { id: true } });
    for (const s of students) {
      await this.prisma.$transaction((tx) => this.recomputeStudentPoints(tx, s.id));
    }
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'RECOMPUTE_POINTS', entity: 'User', metadata: { students: students.length },
    });
    return { recomputed: students.length };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /** Publish the given APPROVED submissions of one assignment as a ResultRelease. */
  private async release(assignmentId: string, ids: string[], user: AuthUser, note?: string) {
    if (ids.length === 0) return { published: [] as string[], releaseId: null };

    const out = await this.prisma.$transaction(async (tx) => {
      const subs = await tx.submission.findMany({
        where:  { id: { in: ids }, assignmentId, status: 'APPROVED' },
        select: {
          id: true, studentId: true, currentReviewId: true,
          currentReview: { select: { score: true } },
          assignment:    { select: { points: true, maximumMarks: true } },
        },
      });
      if (subs.length === 0) return { published: [] as string[], releaseId: null };

      const releaseRow = await tx.resultRelease.create({
        data: { assignmentId, publishedById: user.id, resultCount: 0, note: note ?? null },
      });

      const done: string[] = [];
      const now = new Date();
      for (const s of subs) {
        if (!s.currentReviewId) continue;
        const pointsAwarded = computePointsAwarded(s.currentReview?.score ?? 0, s.assignment.maximumMarks, s.assignment.points);
        const { count } = await tx.submission.updateMany({
          where: { id: s.id, status: 'APPROVED' },
          data:  {
            status: 'PUBLISHED', publishedAt: now, pointsAwarded,
            publishedReviewId: s.currentReviewId, resultReleaseId: releaseRow.id,
          },
        });
        if (count === 0) continue;
        await this.moveReview(tx, s.currentReviewId, ['APPROVED'], { status: 'PUBLISHED', publishedAt: now },
          'PUBLISHED', user.id, null);
        done.push(s.id);
      }

      await tx.resultRelease.update({ where: { id: releaseRow.id }, data: { resultCount: done.length } });

      const students = [...new Set(subs.filter((s) => done.includes(s.id)).map((s) => s.studentId))];
      for (const studentId of students) await this.recomputeStudentPoints(tx, studentId);

      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'PUBLISH_RESULTS', entity: 'ResultRelease', entityId: releaseRow.id,
        metadata: { assignmentId, submissionIds: done },
      }, tx);
      return { published: done, releaseId: releaseRow.id };
    }, { timeout: 60_000 });

    if (out.published.length) this.events.emit(Events.ResultsPublished, { submissionIds: out.published });
    return out;
  }

  /** User.points / problemsSolved are a cache of published results. */
  private async recomputeStudentPoints(tx: Tx, studentId: string) {
    const agg = await tx.submission.aggregate({
      where:  { studentId, status: 'PUBLISHED' },
      _sum:   { pointsAwarded: true },
      _count: { _all: true },
    });
    await tx.user.update({
      where: { id: studentId },
      data:  { points: agg._sum.pointsAwarded ?? 0, problemsSolved: agg._count._all },
    });
  }

  /** Create the next review cycle and make it the submission's current review. */
  private async startCycle(
    tx: Tx, submissionId: string, mentorId: string, actorId: string,
    status: ReviewStatus, distributionBatchId: string | null = null,
    extra: Partial<Prisma.MentorReviewUncheckedCreateInput> = {},
  ) {
    const last = await tx.mentorReview.aggregate({ where: { submissionId }, _max: { cycle: true } });
    const review = await tx.mentorReview.create({
      data: {
        submissionId, mentorId, status, assignedById: actorId, distributionBatchId,
        cycle: (last._max.cycle ?? 0) + 1,
        ...extra,
      },
    });
    await tx.submission.update({ where: { id: submissionId }, data: { currentReviewId: review.id } });
    if (status === 'ASSIGNED') await this.addEvent(tx, review.id, 'ASSIGNED', actorId, null);
    return review;
  }

  /** Conditional review transition + history event. */
  private async moveReview(
    tx: Tx, reviewId: string, from: ReviewStatus[], data: Prisma.MentorReviewUncheckedUpdateManyInput,
    event: ReviewEventType, actorId: string, note: string | null,
    extraWhere: Prisma.MentorReviewWhereInput = {}, score?: number,
  ) {
    const { count } = await tx.mentorReview.updateMany({
      where: { id: reviewId, status: { in: from }, ...extraWhere },
      data,
    });
    if (count === 0) {
      const current = await tx.mentorReview.findUnique({ where: { id: reviewId }, select: { status: true } });
      throw invalidState(
        `This action requires review status ${from.join(' or ')}; the review is "${current?.status}".`,
        { currentReviewStatus: current?.status, allowedFrom: from },
      );
    }
    await this.addEvent(tx, reviewId, event, actorId, note, score);
  }

  private addEvent(tx: Tx, reviewId: string, type: ReviewEventType, actorId: string, note: string | null, score?: number | null) {
    return tx.reviewEvent.create({ data: { reviewId, type, actorId, note, score: score ?? null } });
  }

  /** Conditional submission transition. */
  private async moveSubmission(
    tx: Tx, id: string, from: SubmissionStatus[], to: SubmissionStatus,
    extra: Prisma.SubmissionUncheckedUpdateManyInput = {},
  ) {
    const { count } = await tx.submission.updateMany({ where: { id, status: { in: from } }, data: { ...extra, status: to } });
    if (count === 0) {
      const current = await tx.submission.findUnique({ where: { id }, select: { status: true } });
      throw invalidState(
        `This action requires status ${from.join(' or ')}; the submission is "${current?.status}".`,
        { currentStatus: current?.status, allowedFrom: from },
      );
    }
  }

  private async load(tx: Tx | PrismaService, id: string): Promise<SubmissionWithRelations> {
    return (await tx.submission.findUniqueOrThrow({
      where: { id }, include: SUBMISSION_INCLUDE,
    })) as unknown as SubmissionWithRelations;
  }

  /** Load a submission and enforce who may see it. */
  private async loadForCaller(id: string, user: AuthUser): Promise<SubmissionWithRelations> {
    const s = (await this.prisma.submission.findUnique({ where: { id }, include: SUBMISSION_INCLUDE })) as unknown as SubmissionWithRelations | null;
    const allowed =
      s &&
      (user.role === 'ADMIN' ||
        (user.role === 'STUDENT' && s.studentId === user.id) ||
        (user.role === 'MENTOR' && s.currentReview?.mentor.id === user.id));
    if (!allowed) throw new NotFoundException('Submission not found.');
    return s;
  }

  private async requireSubmission(id: string) {
    const sub = await this.prisma.submission.findUnique({
      where:   { id },
      include: {
        assignment:      {
          select: {
            courseId: true, divisionId: true, maximumMarks: true, status: true, deadline: true,
            allowResubmission: true, maxResubmissions: true,
          },
        },
        currentReview:   { select: { id: true, mentorId: true, status: true } },
        publishedReview: { select: { id: true, mentorId: true, score: true, percentage: true, feedback: true } },
      },
    });
    if (!sub) throw new NotFoundException('Submission not found.');
    return sub;
  }

  private requireCurrentReview(sub: { currentReviewId: string | null }) {
    if (!sub.currentReviewId) throw invalidState('This submission has not been assigned to a mentor.');
    return sub.currentReviewId;
  }

  /** The caller must be the mentor of the current review cycle. Returns its id. */
  private requireAssignedMentor(sub: { currentReview: { id: string; mentorId: string } | null }, user: AuthUser) {
    if (user.role !== 'MENTOR' || sub.currentReview?.mentorId !== user.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ASSIGNED_MENTOR', 'This submission is not assigned to you.');
    }
    return sub.currentReview.id;
  }

  private async isEligibleMentor(mentorId: string, scope: { courseId: string; divisionId: string }) {
    try {
      await this.requireEligibleMentor(mentorId, scope);
      return true;
    } catch {
      return false;
    }
  }

  /** The mentor must be active and assigned to the assignment's course × division. */
  private async requireEligibleMentor(mentorId: string, scope: { courseId: string; divisionId: string }) {
    const user = await this.prisma.user.findUnique({
      where:  { id: mentorId },
      select: { role: true, isActive: true, isApproved: true },
    });
    if (!user) throw new NotFoundException('Mentor not found.');
    if (user.role !== 'MENTOR') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_MENTOR', 'Selected user is not a mentor.');
    }
    if (!user.isActive || !user.isApproved) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'ACCOUNT_SUSPENDED', 'This mentor account is not active.');
    }
    if (!(await this.access.isAssignedMentor(mentorId, scope))) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'MENTOR_NOT_ELIGIBLE',
        'This mentor is not assigned to the assignment\'s course and division.',
      );
    }
  }
}
