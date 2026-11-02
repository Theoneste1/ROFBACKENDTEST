import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { deriveStudentDisplayStatus } from './student-display-status.js';
import { validateScore, computePercentage } from './score.utils.js';

import { CreateSubmissionDto } from './dto/create-submission.dto.js';
import { AssignSubmissionDto } from './dto/assign-submission.dto.js';
import { MarkSubmissionDto } from './dto/mark-submission.dto.js';
import { ApproveResultDto, RejectResultDto } from './dto/review-result.dto.js';
import { CorrectResultDto } from './dto/correct-result.dto.js';

/** Caller context threaded from every controller handler into every service method. */
export interface CallerCtx {
  id:   string;
  role: string;
}

// ─── Valid status-transition table ────────────────────────────────────────────
//
// [current status]  →  allowed transitions and the minimum role required
//
//  SUBMITTED         →  ASSIGNED            (ADMIN)
//  ASSIGNED          →  IN_REVIEW           (MENTOR assigned, or ADMIN)
//                   →  ASSIGNED (reassign)  (ADMIN)
//  IN_REVIEW         →  MARKED              (MENTOR assigned, or ADMIN)
//  MARKED            →  SUBMITTED_TO_ADMIN  (MENTOR assigned, or ADMIN)
//                   →  ASSIGNED (reassign)  (ADMIN)
//  SUBMITTED_TO_ADMIN → APPROVED            (ADMIN)
//                     → REJECTED            (ADMIN)
//  APPROVED          →  PUBLISHED           (ADMIN)
//  PUBLISHED         →  [score correction]  (ADMIN — not a status change)
//  REJECTED          →  ASSIGNED (reassign) (ADMIN)
//                   →  IN_REVIEW            (MENTOR assigned, or ADMIN)
//
// Enforced in each service method; a caller that fails the role check gets 403.

/** Fields always included in submission responses. */
const SUBMISSION_INCLUDE = {
  assignment: {
    select: {
      id:           true,
      title:        true,
      maximumMarks: true,
      deadline:     true,
      allowResubmission: true,
      maxResubmissions:  true,
      course: { select: { id: true, title: true } },
    },
  },
  student: { select: { id: true, username: true, firstName: true, lastName: true } },
  mentor:  { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3 — Student submits / resubmits work
  // ═══════════════════════════════════════════════════════════════════════════

  async submit(
    data: CreateSubmissionDto,
    caller: CallerCtx,
    file?: Express.Multer.File,
  ) {
    // ── Fetch assignment with deadline and resubmission rules ──────────────
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: data.assignmentId },
    });

    if (!assignment) throw new NotFoundException('Assignment not found.');
    if (assignment.status !== 'PUBLISHED') {
      throw new BadRequestException('This assignment is not published yet.');
    }

    const now = new Date();

    // ── Check for an existing submission from this student ─────────────────
    const existing = await this.prisma.submission.findFirst({
      where: { assignmentId: data.assignmentId, studentId: caller.id },
    });

    if (existing) {
      // ── Resubmission path ──────────────────────────────────────────────
      // Backend deadline enforcement — cannot rely on the frontend.
      if (now > assignment.deadline) {
        throw new BadRequestException(
          'The deadline for this assignment has passed. Resubmission is not permitted.',
        );
      }

      // Resubmission must be explicitly allowed.
      if (!assignment.allowResubmission) {
        throw new BadRequestException(
          'This assignment does not permit resubmissions.',
        );
      }

      // Count-based limit (0 = unlimited).
      if (
        assignment.maxResubmissions > 0 &&
        existing.revisionCount >= assignment.maxResubmissions
      ) {
        throw new BadRequestException(
          `You have reached the maximum number of resubmissions (${assignment.maxResubmissions}) for this assignment.`,
        );
      }

      // Only allow resubmission while still in a submittable state.
      const resubmittableStatuses = ['SUBMITTED', 'ASSIGNED'];
      if (!resubmittableStatuses.includes(existing.status)) {
        throw new BadRequestException(
          `You cannot resubmit once your submission is in "${existing.status}" status.`,
        );
      }

      const fileUrl = file ? `/uploads/submissions/${file.filename}` : existing.fileUrl;

      // ── Persist the revision record ─────────────────────────────────────
      const newRevisionNumber = existing.revisionCount + 1;

      const [, updated] = await this.prisma.$transaction([
        this.prisma.submissionRevision.create({
          data: {
            submissionId:   existing.id,
            revisionNumber: newRevisionNumber,
            fileUrl,
            note:           data.note ?? null,
            submittedById:  caller.id,
          },
        }),
        this.prisma.submission.update({
          where: { id: existing.id },
          data:  {
            fileUrl,
            revisionCount: newRevisionNumber,
            submittedAt:   now,
            // Reset review state if mentor hasn't started yet.
            status:        existing.status === 'ASSIGNED' ? 'SUBMITTED' : existing.status,
          },
          include: SUBMISSION_INCLUDE,
        }),
      ]);

      await this.audit.log({
        actorId:   caller.id,
        actorRole: caller.role,
        action:    'RESUBMIT_ASSIGNMENT',
        entity:    'Submission',
        entityId:  existing.id,
        metadata:  {
          revisionNumber: newRevisionNumber,
          assignmentId:   data.assignmentId,
        },
      });

      return updated;
    }

    // ── First submission ───────────────────────────────────────────────────
    // Block first submission after deadline too.
    if (now > assignment.deadline) {
      throw new BadRequestException(
        'The deadline for this assignment has passed.',
      );
    }

    const fileUrl = file ? `/uploads/submissions/${file.filename}` : null;

    const submission = await this.prisma.submission.create({
      data: {
        assignmentId: data.assignmentId,
        studentId:    caller.id,
        status:       'SUBMITTED',
        fileUrl,
        revisionCount: 0,
        submittedAt:  now,
      },
      include: SUBMISSION_INCLUDE,
    });

    // Record revision 1 (initial submission).
    await this.prisma.submissionRevision.create({
      data: {
        submissionId:   submission.id,
        revisionNumber: 1,
        fileUrl,
        note:           data.note ?? null,
        submittedById:  caller.id,
      },
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'SUBMIT_ASSIGNMENT',
      entity:    'Submission',
      entityId:  submission.id,
      metadata:  { assignmentId: data.assignmentId, assignmentTitle: assignment.title },
    });

    return submission;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4 — Admin views, assigns and reassigns
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: All submissions with current status. */
  async findAll() {
    return this.prisma.submission.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        ...SUBMISSION_INCLUDE,
        revisions: { orderBy: { revisionNumber: 'asc' } },
      },
    });
  }

  /** ADMIN: Get single submission with full history. */
  async findOne(submissionId: string) {
    const sub = await this.prisma.submission.findUnique({
      where:   { id: submissionId },
      include: {
        ...SUBMISSION_INCLUDE,
        revisions:  { orderBy: { revisionNumber: 'asc' } },
        correctedBy: { select: { id: true, username: true } },
      },
    });
    if (!sub) throw new NotFoundException('Submission not found.');
    return sub;
  }

  /** ADMIN: Assign mentor to a SUBMITTED submission. */
  async assign(submissionId: string, body: AssignSubmissionDto, caller: CallerCtx) {
    const sub = await this.requireSubmission(submissionId);

    if (sub.status !== 'SUBMITTED') {
      throw new BadRequestException(
        `Only SUBMITTED submissions can be assigned. Current: "${sub.status}".`,
      );
    }

    const mentor = await this.requireMentor(body.mentorId);

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    { mentorId: body.mentorId, status: 'ASSIGNED' },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'ASSIGN_SUBMISSION',
      entity:    'Submission',
      entityId:  submissionId,
      metadata:  { mentorId: body.mentorId, mentorUsername: mentor.username },
    });

    return updated;
  }

  /** ADMIN: Reassign mentor on ASSIGNED / IN_REVIEW / REJECTED submissions. */
  async reassign(submissionId: string, body: AssignSubmissionDto, caller: CallerCtx) {
    const sub = await this.requireSubmission(submissionId);

    const reassignableStatuses = ['ASSIGNED', 'IN_REVIEW', 'REJECTED', 'MARKED'];
    if (!reassignableStatuses.includes(sub.status)) {
      throw new BadRequestException(
        `Cannot reassign a submission in "${sub.status}" status.`,
      );
    }

    const mentor = await this.requireMentor(body.mentorId);

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    { mentorId: body.mentorId, status: 'ASSIGNED', rejectionReason: null },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'REASSIGN_SUBMISSION',
      entity:    'Submission',
      entityId:  submissionId,
      metadata:  {
        previousMentorId: sub.mentorId,
        newMentorId:      body.mentorId,
        newMentorUsername: mentor.username,
      },
    });

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5 — Mentor reviews and marks
  // ═══════════════════════════════════════════════════════════════════════════

  /** MENTOR (+ADMIN): List submissions assigned to this mentor. */
  async getByMentor(mentorId: string) {
    return this.prisma.submission.findMany({
      where:   { mentorId },
      orderBy: { createdAt: 'desc' },
      include: {
        ...SUBMISSION_INCLUDE,
        revisions: { orderBy: { revisionNumber: 'asc' } },
      },
    });
  }

  /** MENTOR (+ADMIN): Transition ASSIGNED → IN_REVIEW. */
  async startReview(submissionId: string, caller: CallerCtx) {
    const sub = await this.requireSubmission(submissionId);
    this.requireOwnerOrAdmin(sub.mentorId, caller);

    if (!['ASSIGNED', 'REJECTED'].includes(sub.status)) {
      throw new BadRequestException(
        `Cannot start review on a submission in "${sub.status}" status.`,
      );
    }

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    { status: 'IN_REVIEW', reviewStartedAt: new Date() },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'START_REVIEW', entity: 'Submission', entityId: submissionId,
    });

    return updated;
  }

  /** MENTOR (+ADMIN): Submit score + feedback. Optionally attach a feedback file. */
  async mark(
    submissionId: string,
    data: MarkSubmissionDto,
    caller: CallerCtx,
    feedbackFile?: Express.Multer.File,
  ) {
    const sub = await this.prisma.submission.findUnique({
      where:   { id: submissionId },
      include: { assignment: { select: { maximumMarks: true } } },
    });
    if (!sub) throw new NotFoundException('Submission not found.');
    this.requireOwnerOrAdmin(sub.mentorId, caller);

    if (sub.status !== 'IN_REVIEW') {
      throw new BadRequestException(
        `Submission must be IN_REVIEW to mark. Current: "${sub.status}".`,
      );
    }

    // Validate score server-side — never trust the DTO alone.
    validateScore(data.score, sub.assignment.maximumMarks);

    const percentage = computePercentage(data.score, sub.assignment.maximumMarks);
    const feedbackFileUrl = feedbackFile
      ? `/uploads/feedback/${feedbackFile.filename}`
      : undefined;

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    {
        score:                data.score,
        percentage,
        mentorFeedback:       data.mentorFeedback,
        ...(feedbackFileUrl && { mentorFeedbackFileUrl: feedbackFileUrl }),
        status:               'MARKED',
        markedAt:             new Date(),
      },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'MARK_SUBMISSION',
      entity:    'Submission',
      entityId:  submissionId,
      metadata:  { score: data.score, percentage, maximumMarks: sub.assignment.maximumMarks },
    });

    return updated;
  }

  /** MENTOR (+ADMIN): Transition MARKED → SUBMITTED_TO_ADMIN. */
  async submitToAdmin(submissionId: string, caller: CallerCtx) {
    const sub = await this.requireSubmission(submissionId);
    this.requireOwnerOrAdmin(sub.mentorId, caller);

    if (sub.status !== 'MARKED') {
      throw new BadRequestException(
        `Submission must be MARKED before sending to admin. Current: "${sub.status}".`,
      );
    }

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    { status: 'SUBMITTED_TO_ADMIN', submittedToAdminAt: new Date() },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'SUBMIT_RESULT_TO_ADMIN', entity: 'Submission', entityId: submissionId,
    });

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6 — Admin approves, rejects, publishes and corrects
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: Approve a SUBMITTED_TO_ADMIN submission. */
  async approve(submissionId: string, body: ApproveResultDto, caller: CallerCtx) {
    const sub = await this.requireSubmission(submissionId);

    if (sub.status !== 'SUBMITTED_TO_ADMIN') {
      throw new BadRequestException(
        `Only SUBMITTED_TO_ADMIN submissions can be approved. Current: "${sub.status}".`,
      );
    }

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    {
        status:        'APPROVED',
        adminFeedback: body.adminFeedback ?? null,
        approvedAt:    new Date(),
      },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'APPROVE_RESULT', entity: 'Submission', entityId: submissionId,
    });

    return updated;
  }

  /**
   * ADMIN: Reject a SUBMITTED_TO_ADMIN submission — returns it to the mentor.
   * Score and feedback are preserved (not wiped) so the audit trail is intact.
   * The mentor must update and resubmit.
   */
  async reject(submissionId: string, body: RejectResultDto, caller: CallerCtx) {
    const sub = await this.requireSubmission(submissionId);

    if (sub.status !== 'SUBMITTED_TO_ADMIN') {
      throw new BadRequestException(
        `Only SUBMITTED_TO_ADMIN submissions can be rejected. Current: "${sub.status}".`,
      );
    }

    const updated = await this.prisma.submission.update({
      where:   { id: submissionId },
      data:    {
        status:          'REJECTED',
        rejectionReason: body.rejectionReason,
        // Do NOT clear score/feedback — preserve history for audit.
      },
      include: SUBMISSION_INCLUDE,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'REJECT_RESULT',
      entity:    'Submission',
      entityId:  submissionId,
      metadata:  { rejectionReason: body.rejectionReason },
    });

    return updated;
  }

  /** ADMIN: Publish APPROVED result to the student and award leaderboard points. */
  async publish(submissionId: string, caller: CallerCtx) {
    const sub = await this.prisma.submission.findUnique({
      where:   { id: submissionId },
      include: { assignment: { select: { points: true, maximumMarks: true } } },
    });
    if (!sub) throw new NotFoundException('Submission not found.');

    if (sub.status !== 'APPROVED') {
      throw new BadRequestException(
        `Only APPROVED results can be published. Current: "${sub.status}".`,
      );
    }
    if (sub.publishedAt) {
      throw new BadRequestException('This result has already been published.');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.submission.update({
        where:   { id: submissionId },
        data:    { status: 'PUBLISHED', publishedAt: new Date() },
        include: SUBMISSION_INCLUDE,
      }),
      this.prisma.user.update({
        where: { id: sub.studentId },
        data:  {
          points:         { increment: sub.assignment.points },
          problemsSolved: { increment: 1 },
        },
      }),
    ]);

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'PUBLISH_RESULT',
      entity:    'Submission',
      entityId:  submissionId,
      metadata:  {
        studentId:     sub.studentId,
        score:         sub.score,
        percentage:    sub.percentage,
        pointsAwarded: sub.assignment.points,
      },
    });

    return updated;
  }

  /**
   * ADMIN: Correct a PUBLISHED result.
   * The previous score is snapshotted into `previousScore` before overwrite.
   * A mandatory `correctionNote` is required.
   * An audit record captures previous value, new value, reason, actor, and time.
   */
  async correctResult(submissionId: string, body: CorrectResultDto, caller: CallerCtx) {
    const sub = await this.prisma.submission.findUnique({
      where:   { id: submissionId },
      include: { assignment: { select: { maximumMarks: true, points: true } } },
    });
    if (!sub) throw new NotFoundException('Submission not found.');

    if (sub.status !== 'PUBLISHED') {
      throw new BadRequestException('Only PUBLISHED results can be corrected.');
    }

    // Validate corrected score server-side.
    validateScore(body.score, sub.assignment.maximumMarks, 'Corrected score');

    const previousScore  = sub.score;
    const newPercentage  = computePercentage(body.score, sub.assignment.maximumMarks);

    // Adjust the student's leaderboard points by the delta.
    // This keeps points accurate without wiping the entire history.
    const pointDelta = body.score - (previousScore ?? 0);

    const [updated] = await this.prisma.$transaction([
      this.prisma.submission.update({
        where:   { id: submissionId },
        data:    {
          previousScore:  previousScore,
          score:          body.score,
          percentage:     newPercentage,
          correctionNote: body.correctionNote,
          correctedAt:    new Date(),
          correctedById:  caller.id,
        },
        include: SUBMISSION_INCLUDE,
      }),
      this.prisma.user.update({
        where: { id: sub.studentId },
        data:  { points: { increment: pointDelta } },
      }),
    ]);

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'CORRECT_PUBLISHED_RESULT',
      entity:    'Submission',
      entityId:  submissionId,
      metadata:  {
        previousScore,
        newScore:      body.score,
        newPercentage,
        correctionNote: body.correctionNote,
        pointDelta,
      },
    });

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Student-facing views
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * STUDENT (+ADMIN): Get a student's own submissions.
   * Published results show score, percentage, mentor name, feedback.
   * Unpublished submissions show status only (no score/feedback leak).
   * Every row includes a `displayStatus` field using the student-facing labels.
   */
  async getMySubmissions(studentId: string) {
    const submissions = await this.prisma.submission.findMany({
      where:   { studentId },
      orderBy: { createdAt: 'desc' },
      include: {
        assignment: {
          select: {
            id: true, title: true, maximumMarks: true, deadline: true,
            allowResubmission: true,
            course: { select: { id: true, title: true } },
            // Include the student's view record so we can compute New vs Opened
            // for submissions that somehow exist without a view (e.g. admin-created).
            views: {
              where:  { studentId },
              select: { firstViewedAt: true },
              take:   1,
            },
          },
        },
        mentor: { select: { id: true, username: true, firstName: true, lastName: true } },
        revisions: { orderBy: { revisionNumber: 'asc' } },
      },
    });

    const { deriveStudentDisplayStatus: derive } = { deriveStudentDisplayStatus };

    return submissions.map((sub) => {
      const displayStatus = derive({
        hasViewed:         (sub.assignment.views?.length ?? 0) > 0,
        submissionStatus:  sub.status,
        deadline:          sub.assignment.deadline,
        allowResubmission: sub.assignment.allowResubmission,
      });

      const base = {
        id:            sub.id,
        status:        sub.status,
        displayStatus,
        assignment:    { ...sub.assignment, views: undefined },
        fileUrl:       sub.fileUrl,
        revisionCount: sub.revisionCount,
        submittedAt:   sub.submittedAt,
        revisions:     sub.revisions,
        createdAt:     sub.createdAt,
      };

      if (sub.status === 'PUBLISHED') {
        return {
          ...base,
          score:                 sub.score,
          percentage:            sub.percentage,
          mentor:                sub.mentor,
          markedAt:              sub.markedAt,
          mentorFeedback:        sub.mentorFeedback,
          mentorFeedbackFileUrl: sub.mentorFeedbackFileUrl,
          adminFeedback:         sub.adminFeedback,
          publishedAt:           sub.publishedAt,
          ...(sub.correctedAt && {
            correctionNote: sub.correctionNote,
            correctedAt:    sub.correctedAt,
          }),
        };
      }

      return base;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async requireSubmission(id: string) {
    const sub = await this.prisma.submission.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException('Submission not found.');
    return sub;
  }

  private async requireMentor(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Mentor not found.');
    if (user.role !== 'MENTOR') throw new BadRequestException('Selected user is not a mentor.');
    return user;
  }

  /**
   * Verifies that the caller owns this submission (is the assigned mentor)
   * OR is an Admin. Throws 403 otherwise.
   */
  private requireOwnerOrAdmin(assignedMentorId: string | null, caller: CallerCtx) {
    if (caller.role !== 'ADMIN' && assignedMentorId !== caller.id) {
      throw new ForbiddenException('This submission is not assigned to you.');
    }
  }
}
