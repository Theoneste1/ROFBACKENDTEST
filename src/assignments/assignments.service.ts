/**
 * AssignmentsService
 *
 * Workflow — mentors prepare, administrators officially publish:
 *
 *   DRAFT ──(mentor submits)──► PENDING_APPROVAL ──(admin publishes)──► PUBLISHED
 *     ▲            (mentor recalls) │                 │ (admin unpublishes, only
 *     └─────────────────────────────┘                 │  while no submissions exist)
 *     ▲                             │ (admin rejects with note)
 *     └──── REJECTED (mentor edits) ◄┘
 *
 * Mentors act only inside the course × division they are assigned to.
 * Admins never author or edit assignment content.
 *
 * Every transition is a conditional update (`WHERE status IN (...)`), so two
 * concurrent requests cannot both succeed.
 */
import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Response } from 'express';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import type { AssignmentStatus, Prisma } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import { deriveStudentDisplayStatus } from '../submissions/student-display-status.js';
import { CreateAssignmentDto, ListAssignmentsDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { RejectAssignmentDto } from './dto/reject-assignment.dto.js';

const EDITABLE_STATUSES: AssignmentStatus[] = ['DRAFT', 'REJECTED'];

export const ASSIGNMENT_SUMMARY = {
  id:                  true,
  title:               true,
  instructions:        true,
  deadline:            true,
  points:              true,
  maximumMarks:        true,
  allowResubmission:   true,
  maxResubmissions:    true,
  allowLateSubmission: true,
  status:              true,
  publishedAt:         true,
  resultsPublishedAt:  true,
  createdAt:           true,
  courseId:            true,
  divisionId:          true,
  file:       { select: { id: true, originalName: true, mimeType: true, size: true } },
  course:     { select: { id: true, code: true, title: true } },
  division:   { select: { id: true, code: true, name: true } },
  createdBy:  { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;

/** Extra fields for mentors and admins. */
const STAFF_DETAIL = {
  ...ASSIGNMENT_SUMMARY,
  submittedAt:   true,
  rejectedAt:    true,
  rejectionNote: true,
  updatedAt:     true,
  approvedBy:    { select: { id: true, username: true } },
  _count:        { select: { submissions: true } },
} as const;

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly audit:    AuditService,
    private readonly access:   AccessService,
    private readonly storage:  StorageService,
    private readonly events:   EventEmitter2,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // MENTOR: prepare
  // ═══════════════════════════════════════════════════════════════════════════

  async create(data: CreateAssignmentDto, user: AuthUser, file?: Express.Multer.File) {
    const course = await this.prisma.course.findUnique({ where: { id: data.courseId }, select: { id: true, title: true } });
    if (!course) throw new NotFoundException('Course not found.');
    await this.access.assertMentorOf(user, { courseId: data.courseId, divisionId: data.divisionId });
    this.assertResubmissionRules(data.allowResubmission ?? false, data.maxResubmissions ?? 0);

    const stored = file ? await this.storage.store(file, 'ASSIGNMENT_BRIEF', user.id) : null;

    const assignment = await this.prisma.assignment.create({
      data: {
        title:               data.title,
        courseId:            data.courseId,
        divisionId:          data.divisionId,
        instructions:        data.instructions,
        deadline:            new Date(data.deadline),
        points:              data.points,
        maximumMarks:        data.maximumMarks,
        fileId:              stored?.id ?? null,
        allowResubmission:   data.allowResubmission   ?? false,
        maxResubmissions:    data.maxResubmissions    ?? 0,
        allowLateSubmission: data.allowLateSubmission ?? false,
        status:              'DRAFT',
        createdById:         user.id,
      },
      select: STAFF_DETAIL,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'CREATE_ASSIGNMENT', entity: 'Assignment', entityId: assignment.id,
      metadata: { title: assignment.title, courseId: data.courseId, divisionId: data.divisionId },
    });

    return assignment;
  }

  /** Edit a DRAFT or REJECTED assignment (any mentor assigned to its scope). */
  async update(assignmentId: string, data: UpdateAssignmentDto, user: AuthUser, file?: Express.Multer.File) {
    const assignment = await this.findOrThrow(assignmentId);
    await this.access.assertMentorOf(user, assignment);

    if (!EDITABLE_STATUSES.includes(assignment.status)) {
      throw invalidState(
        `Cannot edit an assignment in "${assignment.status}" status. Only DRAFT or REJECTED assignments can be edited.`,
      );
    }
    if (Object.keys(data).length === 0 && !file) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'No fields to update.');
    }
    this.assertResubmissionRules(
      data.allowResubmission ?? assignment.allowResubmission,
      data.maxResubmissions ?? assignment.maxResubmissions,
    );

    const stored = file ? await this.storage.store(file, 'ASSIGNMENT_BRIEF', user.id) : null;

    const updated = await this.transition(assignmentId, EDITABLE_STATUSES, {
      title:               data.title,
      instructions:        data.instructions,
      deadline:            data.deadline ? new Date(data.deadline) : undefined,
      points:              data.points,
      maximumMarks:        data.maximumMarks,
      allowResubmission:   data.allowResubmission,
      maxResubmissions:    data.maxResubmissions,
      allowLateSubmission: data.allowLateSubmission,
      ...(stored && { fileId: stored.id }),
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UPDATE_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
      metadata: { fields: Object.keys(data), fileReplaced: !!stored },
    });
    return updated;
  }

  async submitForReview(assignmentId: string, user: AuthUser) {
    const assignment = await this.findOrThrow(assignmentId);
    await this.access.assertMentorOf(user, assignment);

    if (assignment.deadline <= new Date()) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DEADLINE_IN_PAST', 'Set a future deadline before submitting for review.');
    }

    const updated = await this.transition(assignmentId, EDITABLE_STATUSES, {
      status: 'PENDING_APPROVAL', submittedAt: new Date(), rejectedAt: null, rejectionNote: null,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'SUBMIT_ASSIGNMENT_FOR_REVIEW', entity: 'Assignment', entityId: assignmentId,
    });
    this.events.emit(Events.AssignmentSubmittedForReview, { assignmentId });
    return updated;
  }

  async recall(assignmentId: string, user: AuthUser) {
    const assignment = await this.findOrThrow(assignmentId);
    await this.access.assertMentorOf(user, assignment);

    const updated = await this.transition(assignmentId, ['PENDING_APPROVAL'], { status: 'DRAFT', submittedAt: null });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'RECALL_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
    });
    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN: official publication
  // ═══════════════════════════════════════════════════════════════════════════

  async publish(assignmentId: string, user: AuthUser) {
    const assignment = await this.findOrThrow(assignmentId);
    if (assignment.deadline <= new Date()) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'DEADLINE_IN_PAST',
        'The deadline has already passed. Reject the assignment so the mentor can set a new deadline.',
      );
    }

    const updated = await this.transition(assignmentId, ['PENDING_APPROVAL'], {
      status: 'PUBLISHED', publishedAt: new Date(), approvedById: user.id, rejectedAt: null, rejectionNote: null,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'PUBLISH_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
      metadata: { title: assignment.title },
    });
    this.events.emit(Events.AssignmentPublished, { assignmentId });
    return updated;
  }

  async reject(assignmentId: string, body: RejectAssignmentDto, user: AuthUser) {
    await this.findOrThrow(assignmentId);

    const updated = await this.transition(assignmentId, ['PENDING_APPROVAL'], {
      status: 'REJECTED', rejectedAt: new Date(), rejectionNote: body.rejectionNote, submittedAt: null,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REJECT_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
      metadata: { rejectionNote: body.rejectionNote },
    });
    this.events.emit(Events.AssignmentRejected, { assignmentId, note: body.rejectionNote });
    return updated;
  }

  /** Withdraw a published assignment. Not allowed once students have submitted. */
  async unpublish(assignmentId: string, user: AuthUser) {
    await this.findOrThrow(assignmentId);
    const submissions = await this.prisma.submission.count({ where: { assignmentId } });
    if (submissions > 0) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'ASSIGNMENT_HAS_SUBMISSIONS',
        `This assignment already has ${submissions} submission(s) and cannot be unpublished.`,
      );
    }

    const updated = await this.transition(assignmentId, ['PUBLISHED'], {
      status: 'DRAFT', publishedAt: null, approvedById: null,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UNPUBLISH_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
    });
    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Paginated list.
   *   STUDENT: published assignments of their division (published courses only).
   *   MENTOR:  every status, within their scopes.
   *   ADMIN:   everything.
   */
  async findAll(user: AuthUser, q: ListAssignmentsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const scope = await this.access.scopeFilter(user);

    const where: Prisma.AssignmentWhereInput = {
      AND: [
        scope ?? {},
        user.role === 'STUDENT' ? { status: 'PUBLISHED' } : q.status ? { status: q.status } : {},
        q.courseId   ? { courseId: q.courseId } : {},
        q.divisionId && user.role !== 'STUDENT' ? { divisionId: q.divisionId } : {},
      ],
    };

    const select = user.role === 'STUDENT' ? ASSIGNMENT_SUMMARY : STAFF_DETAIL;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.assignment.findMany({
        where, select, skip, take,
        orderBy: user.role === 'STUDENT' ? { deadline: 'asc' } : { updatedAt: 'desc' },
      }),
      this.prisma.assignment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Single assignment. Opening it as a student records the view (New → Opened). */
  async findOne(assignmentId: string, user: AuthUser) {
    const isStudent  = user.role === 'STUDENT';
    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: isStudent ? ASSIGNMENT_SUMMARY : STAFF_DETAIL,
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');

    await this.access.assertCanView(user, assignment);

    if (!isStudent) return assignment;

    if (assignment.status !== 'PUBLISHED') throw new NotFoundException('Assignment not found.');

    await this.recordView(assignmentId, user.id);

    const submission = await this.prisma.submission.findUnique({
      where:  { assignmentId_studentId: { assignmentId, studentId: user.id } },
      select: { id: true, status: true, revisionCount: true, submittedAt: true, isLate: true },
    });

    return {
      ...assignment,
      displayStatus: deriveStudentDisplayStatus({
        hasViewed:        true,
        submissionStatus: submission?.status ?? null,
      }),
      submission: submission
        ? { id: submission.id, revisionCount: submission.revisionCount, submittedAt: submission.submittedAt, isLate: submission.isLate }
        : null,
      canSubmit: this.canStudentSubmit(assignment, submission),
    };
  }

  /** STUDENT: published assignments of their division, each with a display status. */
  async getStudentAssignments(user: AuthUser, q: ListAssignmentsDto) {
    const divisionId = this.access.studentDivision(user);
    const { page, limit, skip, take } = pageArgs(q);

    const where: Prisma.AssignmentWhereInput = {
      divisionId,
      status: 'PUBLISHED',
      course: { status: 'PUBLISHED' },
      ...(q.courseId && { courseId: q.courseId }),
    };

    const [assignments, total] = await this.prisma.$transaction([
      this.prisma.assignment.findMany({
        where, skip, take,
        orderBy: { deadline: 'asc' },
        select: {
          ...ASSIGNMENT_SUMMARY,
          views:       { where: { studentId: user.id }, select: { firstViewedAt: true }, take: 1 },
          submissions: {
            where:  { studentId: user.id },
            select: { id: true, status: true, revisionCount: true, submittedAt: true, isLate: true },
            take:   1,
          },
        },
      }),
      this.prisma.assignment.count({ where }),
    ]);

    const data = assignments.map(({ views, submissions, ...a }) => {
      const submission = submissions[0] ?? null;
      return {
        ...a,
        displayStatus: deriveStudentDisplayStatus({
          hasViewed:        views.length > 0,
          submissionStatus: submission?.status ?? null,
        }),
        submission: submission
          ? { id: submission.id, revisionCount: submission.revisionCount, submittedAt: submission.submittedAt, isLate: submission.isLate }
          : null,
        viewedAt:  views[0]?.firstViewedAt ?? null,
        canSubmit: this.canStudentSubmit(a, submission),
      };
    });

    return paginated(data, total, page, limit);
  }

  /** Download the assignment brief. Same visibility rules as findOne. */
  async serveFile(assignmentId: string, user: AuthUser, res: Response, forceDownload = false) {
    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { courseId: true, divisionId: true, status: true, file: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, assignment);
    if (user.role === 'STUDENT' && assignment.status !== 'PUBLISHED') {
      throw new NotFoundException('Assignment not found.');
    }
    if (!assignment.file) throw new NotFoundException('No file attached to this assignment.');

    await this.storage.send(res, assignment.file, { download: forceDownload });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async findOrThrow(id: string) {
    const a = await this.prisma.assignment.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Assignment not found.');
    return a;
  }

  /**
   * Apply `data` only if the assignment is currently in one of `from`.
   * Returns the updated assignment or throws INVALID_STATE_TRANSITION.
   */
  private async transition(id: string, from: AssignmentStatus[], data: Prisma.AssignmentUncheckedUpdateManyInput) {
    const { count } = await this.prisma.assignment.updateMany({
      where: { id, status: { in: from } },
      data,
    });
    if (count === 0) {
      const current = await this.prisma.assignment.findUnique({ where: { id }, select: { status: true } });
      throw invalidState(
        `This action requires status ${from.join(' or ')}; the assignment is "${current?.status}".`,
        { currentStatus: current?.status, allowedFrom: from },
      );
    }
    return this.prisma.assignment.findUniqueOrThrow({ where: { id }, select: STAFF_DETAIL });
  }

  private assertResubmissionRules(allow: boolean, max: number) {
    if (!allow && max > 0) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'INVALID_RESUBMISSION_RULES',
        'maxResubmissions only applies when allowResubmission is true.',
      );
    }
  }

  private canStudentSubmit(
    a: { deadline: Date; allowResubmission: boolean; maxResubmissions: number; allowLateSubmission: boolean },
    submission: { status: string; revisionCount: number } | null,
  ): boolean {
    const beforeDeadline = new Date() <= a.deadline;
    if (!submission) return beforeDeadline || a.allowLateSubmission;
    return (
      beforeDeadline &&
      a.allowResubmission &&
      ['SUBMITTED', 'ASSIGNED'].includes(submission.status) &&
      (a.maxResubmissions === 0 || submission.revisionCount < a.maxResubmissions)
    );
  }

  /** Records that a student opened the assignment (drives "New" vs "Opened"). */
  private async recordView(assignmentId: string, studentId: string): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.assignmentView.upsert({
        where:  { assignmentId_studentId: { assignmentId, studentId } },
        create: { assignmentId, studentId, firstViewedAt: now, lastViewedAt: now, viewCount: 1 },
        update: { lastViewedAt: now, viewCount: { increment: 1 } },
      });
    } catch (err) {
      // View tracking must never break reading the assignment.
      this.logger.warn(`Could not record assignment view: ${(err as Error).message}`);
    }
  }
}
