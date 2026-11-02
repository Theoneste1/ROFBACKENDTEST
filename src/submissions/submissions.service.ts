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
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { Prisma, type SubmissionStatus } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import { validateScore, computePercentage, computePointsAwarded } from './score.utils.js';
import {
  DistributionStrategy,
  MARKABLE,
  OPEN_REVIEW,
  REASSIGNABLE,
  RESUBMITTABLE,
  REVIEW_STARTABLE,
} from './submissions.constants.js';
import {
  adminView,
  mentorView,
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

/** @deprecated Import from common/auth-user instead. Kept for compatibility. */
export type { CallerCtx } from '../common/auth-user.js';

// ─── Status-transition table ──────────────────────────────────────────────────
//
//  [current status]      → next status          who
//  ───────────────────────────────────────────────────────────────────────────
//  (none)                → SUBMITTED            STUDENT (first submission)
//  SUBMITTED / ASSIGNED  → SUBMITTED            STUDENT (resubmission; unassigns mentor)
//  SUBMITTED             → ASSIGNED             ADMIN   (assign / distribute)
//  ASSIGNED…REJECTED     → ASSIGNED             ADMIN   (reassign to another mentor)
//  ASSIGNED / REJECTED   → IN_REVIEW            MENTOR  (assigned mentor only)
//  IN_REVIEW / MARKED    → MARKED               MENTOR  (score + formal feedback)
//  MARKED                → SUBMITTED_TO_ADMIN   MENTOR  (return completed review)
//  SUBMITTED_TO_ADMIN    → APPROVED             ADMIN
//  SUBMITTED_TO_ADMIN    → REJECTED             ADMIN   (back to the mentor)
//  APPROVED              → PUBLISHED            ADMIN   (awards points)
//  PUBLISHED             → REJECTED             ADMIN   (reopen; removes points)
//
// ADMINs never write score or feedback. MENTOR routes reject ADMIN callers.
// Every transition is a conditional UPDATE … WHERE status IN (…), so
// concurrent requests cannot both succeed.

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly access:    AccessService,
    private readonly storage:   StorageService,
    private readonly settings:  SettingsService,
    private readonly events:    EventEmitter2,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3 — Student submits / resubmits work
  // ═══════════════════════════════════════════════════════════════════════════

  async submit(data: CreateSubmissionDto, user: AuthUser, file?: Express.Multer.File) {
    if (!file) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Attach your work as a file (field "file").');
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
    if (assignment.status !== 'PUBLISHED') throw new NotFoundException('Assignment not found.');

    const now    = new Date();
    const isLate = now > assignment.deadline;

    const existing = await this.prisma.submission.findUnique({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: user.id } },
    });

    // ── Validate BEFORE storing the file ───────────────────────────────────
    if (existing) {
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

    const stored = await this.storage.store(file, 'SUBMISSION', user.id);

    const submission = existing
      ? await this.resubmit(existing, stored.id, data.note, user)
      : await this.firstSubmit(assignment.id, stored.id, data.note, isLate, user);

    this.events.emit(Events.SubmissionReceived, { submissionId: submission.id });
    return studentView(submission);
  }

  private async firstSubmit(assignmentId: string, fileId: string, note: string | undefined, isLate: boolean, user: AuthUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const created = await tx.submission.create({
          data: {
            assignmentId,
            studentId:     user.id,
            status:        'SUBMITTED',
            fileId,
            revisionCount: 0,
            isLate,
            submittedAt:   now,
            revisions: {
              create: { revisionNumber: 1, fileId, note: note ?? null, isLate, submittedById: user.id, submittedAt: now },
            },
          },
          include: SUBMISSION_INCLUDE,
        });
        await this.audit.log({
          actorId: user.id, actorRole: user.role,
          action: 'SUBMIT_ASSIGNMENT', entity: 'Submission', entityId: created.id,
          metadata: { assignmentId, isLate },
        }, tx);
        return created as unknown as SubmissionWithRelations;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(HttpStatus.CONFLICT, 'ALREADY_SUBMITTED', 'You have already submitted this assignment.');
      }
      throw err;
    }
  }

  /**
   * Replace the student's work. The submission returns to the distribution
   * queue (mentor unassigned) so the review always covers the latest version.
   * Revision numbers: first submission = 1, each resubmission = previous + 1.
   */
  private async resubmit(
    existing: { id: string; revisionCount: number; mentorId: string | null; assignmentId: string },
    fileId: string,
    note: string | undefined,
    user: AuthUser,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.submission.updateMany({
        // Optimistic lock: status still resubmittable AND nobody resubmitted meanwhile.
        where: { id: existing.id, status: { in: RESUBMITTABLE }, revisionCount: existing.revisionCount },
        data: {
          fileId,
          revisionCount: existing.revisionCount + 1,
          submittedAt:   now,
          status:        'SUBMITTED',
          mentorId:      null,
          assignedAt:    null,
          isLate:        false,
        },
      });
      if (count === 0) {
        throw invalidState('Your submission changed while uploading. Refresh and try again.');
      }

      const revisionNumber = existing.revisionCount + 2;
      await tx.submissionRevision.create({
        data: { submissionId: existing.id, revisionNumber, fileId, note: note ?? null, submittedById: user.id, submittedAt: now },
      });

      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'RESUBMIT_ASSIGNMENT', entity: 'Submission', entityId: existing.id,
        metadata: { revisionNumber, assignmentId: existing.assignmentId, previousMentorId: existing.mentorId },
      }, tx);

      return (await tx.submission.findUniqueOrThrow({
        where: { id: existing.id }, include: SUBMISSION_INCLUDE,
      })) as unknown as SubmissionWithRelations;
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
      ...(q.mentorId     && { mentorId: q.mentorId }),
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

  /** Single submission, projected for the caller's role. */
  async findOne(submissionId: string, user: AuthUser) {
    const s = await this.loadForCaller(submissionId, user);
    if (user.role === 'STUDENT') return studentView(s);
    if (user.role === 'MENTOR')  return mentorView(s);
    return adminView(s);
  }

  /** MENTOR: submissions assigned to me. */
  async getReviewQueue(user: AuthUser, q: ListSubmissionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SubmissionWhereInput = {
      mentorId: user.id,
      ...(q.assignmentId && { assignmentId: q.assignmentId }),
      status: q.status ?? { in: [...OPEN_REVIEW, 'SUBMITTED_TO_ADMIN'] },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.submission.findMany({ where, include: SUBMISSION_INCLUDE, orderBy: { assignedAt: 'asc' }, skip, take }),
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

    const updated = await this.transition(submissionId, ['SUBMITTED'], {
      mentorId: body.mentorId, status: 'ASSIGNED', assignedAt: new Date(),
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'ASSIGN_SUBMISSION', entity: 'Submission', entityId: submissionId,
      metadata: { mentorId: body.mentorId },
    });
    this.events.emit(Events.SubmissionsAssigned, { assignmentId: sub.assignmentId, byMentor: { [body.mentorId]: 1 } });
    return adminView(updated);
  }

  /**
   * Move a review to a different mentor. Any draft score/feedback from the
   * previous mentor is cleared (it remains in the audit log) so the new mentor
   * starts fresh.
   */
  async reassign(submissionId: string, body: AssignSubmissionDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    if (sub.mentorId === body.mentorId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SAME_MENTOR', 'The submission is already assigned to this mentor.');
    }
    await this.requireEligibleMentor(body.mentorId, sub.assignment);

    const updated = await this.transition(submissionId, REASSIGNABLE, {
      mentorId: body.mentorId, status: 'ASSIGNED', assignedAt: new Date(),
      score: null, percentage: null, mentorFeedback: null, feedbackFileId: null,
      reviewStartedAt: null, markedAt: null,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REASSIGN_SUBMISSION', entity: 'Submission', entityId: submissionId,
      metadata: {
        previousMentorId: sub.mentorId, newMentorId: body.mentorId,
        previousStatus: sub.status, discardedDraftScore: sub.score,
      },
    });
    this.events.emit(Events.SubmissionsAssigned, { assignmentId: sub.assignmentId, byMentor: { [body.mentorId]: 1 } });
    return adminView(updated);
  }

  /**
   * Distribute every unassigned (SUBMITTED) submission of an assignment across
   * the mentors assigned to its course × division.
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
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'MENTOR_NOT_ELIGIBLE',
          'Some mentors are not assigned to this course and division.',
          { mentorIds: notEligible },
        );
      }
    }
    if (mentorIds.length === 0) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'NO_ELIGIBLE_MENTORS',
        'No active mentor is assigned to this course and division.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.submission.findMany({
        where:   { assignmentId, status: 'SUBMITTED' },
        orderBy: { submittedAt: 'asc' },
        select:  { id: true },
      });

      // Current open workload per mentor (across all assignments).
      const loads = new Map<string, number>(mentorIds.map((id) => [id, 0]));
      const grouped = await tx.submission.groupBy({
        by:    ['mentorId'],
        where: { mentorId: { in: mentorIds }, status: { in: OPEN_REVIEW } },
        _count: { _all: true },
      });
      for (const g of grouped) if (g.mentorId) loads.set(g.mentorId, g._count._all);

      const byMentor: Record<string, number> = {};
      const now = new Date();
      let turn = 0;

      for (const s of pending) {
        const mentorId = strategy === DistributionStrategy.ROUND_ROBIN
          ? mentorIds[turn++ % mentorIds.length]
          : [...loads.entries()].sort((a, b) => a[1] - b[1])[0][0];

        const { count } = await tx.submission.updateMany({
          where: { id: s.id, status: 'SUBMITTED' },
          data:  { mentorId, status: 'ASSIGNED', assignedAt: now },
        });
        if (count === 1) {
          loads.set(mentorId, (loads.get(mentorId) ?? 0) + 1);
          byMentor[mentorId] = (byMentor[mentorId] ?? 0) + 1;
        }
      }

      const distributed = Object.values(byMentor).reduce((a, b) => a + b, 0);
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'DISTRIBUTE_SUBMISSIONS', entity: 'Assignment', entityId: assignmentId,
        metadata: { strategy, distributed, byMentor },
      }, tx);

      return { strategy, distributed, byMentor };
    }, { timeout: 60_000 });

    if (result.distributed > 0) {
      this.events.emit(Events.SubmissionsAssigned, { assignmentId, byMentor: result.byMentor });
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5 — Mentor reviews, scores and returns the review
  // ═══════════════════════════════════════════════════════════════════════════

  async startReview(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    this.requireAssignedMentor(sub.mentorId, user);

    const updated = await this.transition(submissionId, REVIEW_STARTABLE, {
      status: 'IN_REVIEW', reviewStartedAt: new Date(),
    }, { mentorId: user.id });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'START_REVIEW', entity: 'Submission', entityId: submissionId,
    });
    return mentorView(updated);
  }

  /** Save the score and formal feedback (can be repeated until the review is returned). */
  async mark(submissionId: string, data: MarkSubmissionDto, user: AuthUser, feedbackFile?: Express.Multer.File) {
    const sub = await this.requireSubmission(submissionId);
    this.requireAssignedMentor(sub.mentorId, user);

    if (!MARKABLE.includes(sub.status)) {
      throw invalidState(`Start the review before marking. Current status: "${sub.status}".`);
    }
    validateScore(data.score, sub.assignment.maximumMarks);
    const percentage = computePercentage(data.score, sub.assignment.maximumMarks);

    const stored = feedbackFile ? await this.storage.store(feedbackFile, 'FEEDBACK', user.id) : null;

    const updated = await this.transition(submissionId, MARKABLE, {
      score:          data.score,
      percentage,
      mentorFeedback: data.mentorFeedback,
      ...(stored && { feedbackFileId: stored.id }),
      status:         'MARKED',
      markedAt:       new Date(),
    }, { mentorId: user.id });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'MARK_SUBMISSION', entity: 'Submission', entityId: submissionId,
      metadata: { score: data.score, percentage, maximumMarks: sub.assignment.maximumMarks },
    });
    return mentorView(updated);
  }

  /** Return the completed review to the administrators. */
  async submitToAdmin(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    this.requireAssignedMentor(sub.mentorId, user);

    const updated = await this.transition(submissionId, ['MARKED'], {
      status: 'SUBMITTED_TO_ADMIN', submittedToAdminAt: new Date(), rejectionReason: null,
    }, { mentorId: user.id });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'RETURN_REVIEW_TO_ADMIN', entity: 'Submission', entityId: submissionId,
    });
    this.events.emit(Events.ReviewReturned, { submissionId });
    return mentorView(updated);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6–7 — Admin coordinates and publishes results
  // ═══════════════════════════════════════════════════════════════════════════

  async approve(submissionId: string, body: ApproveResultDto, user: AuthUser) {
    await this.requireSubmission(submissionId);

    const updated = await this.transition(submissionId, ['SUBMITTED_TO_ADMIN'], {
      status: 'APPROVED', coordinationNote: body.coordinationNote ?? null, approvedAt: new Date(),
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'APPROVE_RESULT', entity: 'Submission', entityId: submissionId,
    });
    return adminView(updated);
  }

  /** Send the review back to the mentor. Score and feedback are kept for the mentor to revise. */
  async reject(submissionId: string, body: RejectResultDto, user: AuthUser) {
    await this.requireSubmission(submissionId);

    const updated = await this.transition(submissionId, ['SUBMITTED_TO_ADMIN', 'APPROVED'], {
      status: 'REJECTED', rejectionReason: body.rejectionReason, approvedAt: null,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REJECT_RESULT', entity: 'Submission', entityId: submissionId,
      metadata: { rejectionReason: body.rejectionReason },
    });
    this.events.emit(Events.ReviewRejected, { submissionId, reason: body.rejectionReason });
    return adminView(updated);
  }

  /** Publish one APPROVED result and award leaderboard points. */
  async publish(submissionId: string, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);
    const published = await this.publishMany([sub.id], user);
    if (published.length === 0) {
      throw invalidState(`Only APPROVED results can be published. Current: "${sub.status}".`);
    }
    return adminView(await this.loadAny(submissionId));
  }

  /**
   * Publish every APPROVED result of an assignment at once (the usual way
   * results are released). Reports how many are still in the pipeline.
   */
  async publishAssignmentResults(assignmentId: string, user: AuthUser) {
    const assignment = await this.prisma.assignment.findUnique({ where: { id: assignmentId }, select: { id: true } });
    if (!assignment) throw new NotFoundException('Assignment not found.');

    const approved = await this.prisma.submission.findMany({
      where:  { assignmentId, status: 'APPROVED' },
      select: { id: true },
    });
    const published = await this.publishMany(approved.map((a) => a.id), user);

    if (published.length > 0) {
      await this.prisma.assignment.update({ where: { id: assignmentId }, data: { resultsPublishedAt: new Date() } });
    }

    const remaining = await this.prisma.submission.groupBy({
      by:     ['status'],
      where:  { assignmentId, status: { not: 'PUBLISHED' } },
      _count: { _all: true },
    });

    return {
      published: published.length,
      notYetPublished: Object.fromEntries(remaining.map((r) => [r.status, r._count._all])),
    };
  }

  /**
   * Correct a published result: withdraw it from the student, remove its points
   * and return it to the mentor for re-review. Admins never change scores.
   */
  async reopen(submissionId: string, body: ReopenResultDto, user: AuthUser) {
    const sub = await this.requireSubmission(submissionId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.submission.updateMany({
        where: { id: submissionId, status: 'PUBLISHED' },
        data: {
          status:          'REJECTED',
          rejectionReason: body.reopenNote,
          reopenNote:      body.reopenNote,
          reopenedAt:      new Date(),
          reopenedById:    user.id,
          previousScore:   sub.score,
          pointsAwarded:   0,
          publishedAt:     null,
          approvedAt:      null,
        },
      });
      if (count === 0) throw invalidState(`Only PUBLISHED results can be reopened. Current: "${sub.status}".`);

      await this.recomputeStudentPoints(tx, sub.studentId);
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'REOPEN_RESULT', entity: 'Submission', entityId: submissionId,
        metadata: { previousScore: sub.score, pointsRemoved: sub.pointsAwarded, reopenNote: body.reopenNote },
      }, tx);

      return tx.submission.findUniqueOrThrow({ where: { id: submissionId }, include: SUBMISSION_INCLUDE });
    });

    this.events.emit(Events.ResultReopened, { submissionId, reason: body.reopenNote });
    return adminView(updated as unknown as SubmissionWithRelations);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Files
  // ═══════════════════════════════════════════════════════════════════════════

  /** The student's work: the student, the assigned mentor, or an admin. */
  async serveSubmissionFile(submissionId: string, user: AuthUser, res: Response, revisionNumber?: number) {
    await this.loadForCaller(submissionId, user);

    const file = revisionNumber !== undefined
      ? (await this.prisma.submissionRevision.findUnique({
          where:  { submissionId_revisionNumber: { submissionId, revisionNumber } },
          select: { file: true },
        }))?.file
      : (await this.prisma.submission.findUnique({ where: { id: submissionId }, select: { file: true } }))?.file;

    if (!file) throw new NotFoundException('No file attached.');
    await this.storage.send(res, file, { download: true });
  }

  /** Mentor feedback file: students only once published. */
  async serveFeedbackFile(submissionId: string, user: AuthUser, res: Response) {
    const s = await this.loadForCaller(submissionId, user);
    if (user.role === 'STUDENT' && s.status !== 'PUBLISHED') {
      throw new AppError(HttpStatus.FORBIDDEN, 'RESULT_NOT_PUBLISHED', 'Feedback is available once results are published.');
    }
    const file = (await this.prisma.submission.findUnique({
      where: { id: submissionId }, select: { feedbackFile: true },
    }))?.feedbackFile;
    if (!file) throw new NotFoundException('No feedback file attached to this result.');
    await this.storage.send(res, file, { download: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Points
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recompute every student's cached points from published results.
   * Use after data fixes; normal publishing keeps the cache current.
   */
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

  /** Publish the given ids that are APPROVED; returns the ids actually published. */
  private async publishMany(ids: string[], user: AuthUser): Promise<string[]> {
    if (ids.length === 0) return [];

    const published = await this.prisma.$transaction(async (tx) => {
      const subs = await tx.submission.findMany({
        where:  { id: { in: ids }, status: 'APPROVED' },
        select: { id: true, studentId: true, score: true, assignment: { select: { points: true, maximumMarks: true } } },
      });

      const done: string[] = [];
      const now = new Date();
      for (const s of subs) {
        const pointsAwarded = computePointsAwarded(s.score ?? 0, s.assignment.maximumMarks, s.assignment.points);
        const { count } = await tx.submission.updateMany({
          where: { id: s.id, status: 'APPROVED' },
          data:  { status: 'PUBLISHED', publishedAt: now, pointsAwarded },
        });
        if (count === 1) done.push(s.id);
      }

      const students = [...new Set(subs.filter((s) => done.includes(s.id)).map((s) => s.studentId))];
      for (const studentId of students) await this.recomputeStudentPoints(tx, studentId);

      if (done.length) {
        await this.audit.log({
          actorId: user.id, actorRole: user.role,
          action: 'PUBLISH_RESULTS', entity: 'Submission', metadata: { submissionIds: done },
        }, tx);
      }
      return done;
    }, { timeout: 60_000 });

    if (published.length) this.events.emit(Events.ResultsPublished, { submissionIds: published });
    return published;
  }

  /** User.points / problemsSolved are a cache of published results. */
  private async recomputeStudentPoints(tx: Prisma.TransactionClient, studentId: string) {
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

  /**
   * Conditional state transition. `extraWhere` lets mentor actions also require
   * that the submission is still assigned to them at write time.
   */
  private async transition(
    id: string,
    from: SubmissionStatus[],
    data: Prisma.SubmissionUncheckedUpdateManyInput,
    extraWhere: Prisma.SubmissionWhereInput = {},
  ): Promise<SubmissionWithRelations> {
    const { count } = await this.prisma.submission.updateMany({
      where: { id, status: { in: from }, ...extraWhere },
      data,
    });
    if (count === 0) {
      const current = await this.prisma.submission.findUnique({ where: { id }, select: { status: true } });
      throw invalidState(
        `This action requires status ${from.join(' or ')}; the submission is "${current?.status}".`,
        { currentStatus: current?.status, allowedFrom: from },
      );
    }
    return this.loadAny(id);
  }

  private async loadAny(id: string): Promise<SubmissionWithRelations> {
    return (await this.prisma.submission.findUniqueOrThrow({
      where: { id }, include: SUBMISSION_INCLUDE,
    })) as unknown as SubmissionWithRelations;
  }

  /** Load a submission and enforce who may see it. */
  private async loadForCaller(id: string, user: AuthUser): Promise<SubmissionWithRelations> {
    const s = await this.prisma.submission.findUnique({ where: { id }, include: SUBMISSION_INCLUDE });
    const allowed =
      s &&
      (user.role === 'ADMIN' ||
        (user.role === 'STUDENT' && s.studentId === user.id) ||
        (user.role === 'MENTOR' && s.mentorId === user.id));
    if (!allowed) throw new NotFoundException('Submission not found.');
    return s as unknown as SubmissionWithRelations;
  }

  private async requireSubmission(id: string) {
    const sub = await this.prisma.submission.findUnique({
      where:   { id },
      include: { assignment: { select: { courseId: true, divisionId: true, maximumMarks: true } } },
    });
    if (!sub) throw new NotFoundException('Submission not found.');
    return sub;
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

  private requireAssignedMentor(assignedMentorId: string | null, user: AuthUser) {
    if (user.role !== 'MENTOR' || assignedMentorId !== user.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ASSIGNED_MENTOR', 'This submission is not assigned to you.');
    }
  }
}
