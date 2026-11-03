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
 *   PUBLISHED ──(deadline passes¹, or admin closes)──► CLOSED ──(admin reopens)──► PUBLISHED
 *   ¹ unless late submissions are allowed; see AssignmentCloserService.
 *
 *   Any status ──(admin archives, or the academic year is closed)──► ARCHIVED
 *   (read-only; existing results stay visible to students).
 *
 * Mentors act only inside the course × division they are assigned to.
 * Admins never author or edit assignment content.
 *
 * Every transition is a conditional update made under a row lock, so two
 * concurrent requests cannot both succeed, and each one is written to the
 * assignment's history (AssignmentEvent) in the same transaction.
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
import { ATTACHMENT_SELECT, MAX_ATTACHMENTS } from '../common/storage/attachments.js';
import { AcademicYearsService } from '../academic-years/academic-years.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import type { AssignmentEventType, AssignmentStatus, FileObject, Prisma } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import { deriveStudentDisplayStatus } from '../submissions/student-display-status.js';
import { CreateAssignmentDto, ListAssignmentsDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { CloseAssignmentDto, RejectAssignmentDto, ReopenAssignmentDto } from './dto/reject-assignment.dto.js';

const EDITABLE_STATUSES: AssignmentStatus[] = ['DRAFT', 'REJECTED'];

/** Statuses a student can see (CLOSED: no new work, but their results remain). */
export const STUDENT_VISIBLE_STATUSES: AssignmentStatus[] = ['PUBLISHED', 'CLOSED'];

/** Content fields whose before/after values are kept in the history. */
const TRACKED_FIELDS = [
  'title', 'description', 'instructions', 'deadline', 'points', 'maximumMarks',
  'allowResubmission', 'maxResubmissions', 'allowLateSubmission',
] as const;

const EVENT_SELECT = {
  id: true, type: true, fromStatus: true, toStatus: true, note: true, changes: true, createdAt: true,
  actor: { select: { id: true, username: true, firstName: true, lastName: true, role: true } },
} as const;

type HistoryEntry = {
  type:     AssignmentEventType;
  actorId:  string | null;
  note?:    string | null;
  changes?: Prisma.InputJsonValue;
};

export const ASSIGNMENT_SUMMARY = {
  id:                  true,
  title:               true,
  description:         true,
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
  closedAt:            true,
  archivedAt:          true,
  createdAt:           true,
  courseId:            true,
  divisionId:          true,
  attachments:  { orderBy: { sortOrder: 'asc' as const }, select: ATTACHMENT_SELECT },
  academicYear: { select: { id: true, name: true } },
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
    private readonly academicYears: AcademicYearsService,
    private readonly activity: ActivityService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // MENTOR: prepare
  // ═══════════════════════════════════════════════════════════════════════════

  async create(data: CreateAssignmentDto, user: AuthUser, files: Express.Multer.File[] = []) {
    const course = await this.prisma.course.findUnique({ where: { id: data.courseId }, select: { id: true, title: true } });
    if (!course) throw new NotFoundException('Course not found.');
    await this.access.assertMentorOf(user, { courseId: data.courseId, divisionId: data.divisionId });
    this.assertResubmissionRules(data.allowResubmission ?? false, data.maxResubmissions ?? 0);

    const year = await this.academicYears.current();

    const stored: FileObject[] = [];
    for (const f of files) stored.push(await this.storage.store(f, 'ASSIGNMENT_BRIEF', user.id));

    const assignment = await this.prisma.assignment.create({
      data: {
        title:               data.title,
        courseId:            data.courseId,
        divisionId:          data.divisionId,
        description:         data.description ?? null,
        instructions:        data.instructions,
        deadline:            new Date(data.deadline),
        points:              data.points,
        maximumMarks:        data.maximumMarks,
        academicYearId:      year.id,
        attachments:         { create: stored.map((s, i) => ({ fileId: s.id, sortOrder: i })) },
        allowResubmission:   data.allowResubmission   ?? false,
        maxResubmissions:    data.maxResubmissions    ?? 0,
        allowLateSubmission: data.allowLateSubmission ?? false,
        status:              'DRAFT',
        createdById:         user.id,
        events: {
          create: {
            type: 'CREATED', toStatus: 'DRAFT', actorId: user.id,
            ...(stored.length > 0 && { changes: { files: stored.length } }),
          },
        },
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
  async update(assignmentId: string, data: UpdateAssignmentDto, user: AuthUser, files: Express.Multer.File[] = []) {
    const assignment = await this.findOrThrow(assignmentId);
    await this.access.assertMentorOf(user, assignment);

    if (!EDITABLE_STATUSES.includes(assignment.status)) {
      throw invalidState(
        `Cannot edit an assignment in "${assignment.status}" status. Only DRAFT or REJECTED assignments can be edited.`,
      );
    }
    if (Object.keys(data).length === 0 && files.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'No fields to update.');
    }
    this.assertResubmissionRules(
      data.allowResubmission ?? assignment.allowResubmission,
      data.maxResubmissions ?? assignment.maxResubmissions,
    );

    await this.addAttachmentsInternal(assignmentId, files, user);

    const next = {
      title:               data.title,
      description:         data.description,
      instructions:        data.instructions,
      deadline:            data.deadline ? new Date(data.deadline) : undefined,
      points:              data.points,
      maximumMarks:        data.maximumMarks,
      allowResubmission:   data.allowResubmission,
      maxResubmissions:    data.maxResubmissions,
      allowLateSubmission: data.allowLateSubmission,
    };
    const changes = diffFields(assignment, next);
    const updated = Object.keys(changes).length === 0
      ? await this.prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId }, select: STAFF_DETAIL })
      : await this.transition(assignmentId, EDITABLE_STATUSES, next, { type: 'UPDATED', actorId: user.id, changes });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UPDATE_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
      metadata: { fields: Object.keys(data), filesAdded: files.length },
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
    }, { type: 'SUBMITTED_FOR_REVIEW', actorId: user.id });

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

    const updated = await this.transition(
      assignmentId, ['PENDING_APPROVAL'], { status: 'DRAFT', submittedAt: null },
      { type: 'RECALLED', actorId: user.id },
    );

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
    }, { type: 'PUBLISHED', actorId: user.id });

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
    }, { type: 'REJECTED', actorId: user.id, note: body.rejectionNote });

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
    }, { type: 'UNPUBLISHED', actorId: user.id });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UNPUBLISH_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
    });
    return updated;
  }

  /**
   * Stop accepting submissions now (e.g. before the deadline, or when late
   * submissions were allowed). Reviews and results carry on as normal.
   */
  async close(assignmentId: string, body: CloseAssignmentDto, user: AuthUser) {
    await this.findOrThrow(assignmentId);
    const updated = await this.transition(
      assignmentId, ['PUBLISHED'], { status: 'CLOSED', closedAt: new Date() },
      { type: 'CLOSED', actorId: user.id, note: body.note ?? null },
    );
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'CLOSE_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
      ...(body.note && { metadata: { note: body.note } }),
    });
    return updated;
  }

  /**
   * Accept submissions again. If the deadline has passed (and late work is not
   * accepted) a new future deadline is required, otherwise it would close again.
   */
  async reopen(assignmentId: string, body: ReopenAssignmentDto, user: AuthUser) {
    const assignment = await this.findOrThrow(assignmentId);
    const deadline = body.deadline ? new Date(body.deadline) : assignment.deadline;
    if (body.deadline && deadline <= new Date()) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DEADLINE_IN_PAST', 'The new deadline must be in the future.');
    }
    if (deadline <= new Date() && !assignment.allowLateSubmission) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'DEADLINE_REQUIRED',
        'The deadline has passed. Provide a new deadline to reopen this assignment.',
      );
    }

    const changes = diffFields(assignment, { deadline: body.deadline ? deadline : undefined });
    const updated = await this.transition(
      assignmentId, ['CLOSED'], { status: 'PUBLISHED', closedAt: null, deadline },
      {
        type: 'REOPENED', actorId: user.id, note: body.note ?? null,
        ...(Object.keys(changes).length > 0 && { changes }),
      },
    );
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REOPEN_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
      metadata: { deadline: deadline.toISOString(), ...(body.note && { note: body.note }) },
    });
    return updated;
  }

  /**
   * Archive an assignment (any status). It becomes read-only: no new
   * submissions; reviews in progress can still be finished; published results
   * stay visible to students. Closing an academic year archives all of its
   * assignments automatically.
   */
  async archive(assignmentId: string, user: AuthUser) {
    await this.findOrThrow(assignmentId);
    const updated = await this.transition(
      assignmentId,
      ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'CLOSED', 'REJECTED'],
      { status: 'ARCHIVED', archivedAt: new Date() },
      { type: 'ARCHIVED', actorId: user.id },
    );
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'ARCHIVE_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
    });
    return updated;
  }

  // ─── MENTOR: brief attachments (editable statuses only) ───────────────────

  async addAttachments(assignmentId: string, user: AuthUser, files: Express.Multer.File[]) {
    if (files.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Attach at least one file (field "files").');
    }
    const assignment = await this.findOrThrow(assignmentId);
    await this.access.assertMentorOf(user, assignment);
    if (!EDITABLE_STATUSES.includes(assignment.status)) {
      throw invalidState('Files can only be changed while the assignment is DRAFT or REJECTED.');
    }
    await this.addAttachmentsInternal(assignmentId, files, user);
    return this.prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId }, select: STAFF_DETAIL });
  }

  async removeAttachment(assignmentId: string, attachmentId: string, user: AuthUser) {
    const assignment = await this.findOrThrow(assignmentId);
    await this.access.assertMentorOf(user, assignment);
    if (!EDITABLE_STATUSES.includes(assignment.status)) {
      throw invalidState('Files can only be changed while the assignment is DRAFT or REJECTED.');
    }
    const count = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.assignmentAttachment.deleteMany({ where: { id: attachmentId, assignmentId } });
      if (removed.count > 0) {
        await tx.assignmentEvent.create({
          data: {
            assignmentId, type: 'ATTACHMENT_REMOVED', actorId: user.id,
            fromStatus: assignment.status, toStatus: assignment.status, changes: { attachmentIds: [attachmentId] },
          },
        });
      }
      return removed.count;
    });
    if (count === 0) throw new NotFoundException('Attachment not found.');
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REMOVE_ASSIGNMENT_FILE', entity: 'Assignment', entityId: assignmentId, metadata: { attachmentId },
    });
    return this.prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId }, select: STAFF_DETAIL });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Paginated list.
   *   STUDENT: published or closed assignments of their division (published courses only).
   *   MENTOR:  every status, within their scopes.
   *   ADMIN:   everything.
   */
  async findAll(user: AuthUser, q: ListAssignmentsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const scope = await this.access.scopeFilter(user);
    const isStudent = user.role === 'STUDENT';

    const where: Prisma.AssignmentWhereInput = {
      AND: [
        scope ?? {},
        isStudent ? this.studentStatusFilter(q) : q.status ? { status: q.status } : {},
        q.divisionId && !isStudent ? { divisionId: q.divisionId } : {},
        q.createdById && !isStudent ? { createdById: q.createdById } : {},
        this.commonFilters(q),
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

    if (!STUDENT_VISIBLE_STATUSES.includes(assignment.status)) throw new NotFoundException('Assignment not found.');

    await this.recordView(assignmentId, user.id);
    this.activity.record(user.id, 'ASSIGNMENT_VIEWED', {
      courseId: assignment.courseId, entityType: 'Assignment', entityId: assignmentId,
    });

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

  /** STUDENT: published and closed assignments of their division, each with a display status. */
  async getStudentAssignments(user: AuthUser, q: ListAssignmentsDto) {
    const divisionId = this.access.studentDivision(user);
    const { page, limit, skip, take } = pageArgs(q);

    const where: Prisma.AssignmentWhereInput = {
      AND: [
        { divisionId, course: { status: 'PUBLISHED' } },
        this.studentStatusFilter(q),
        this.commonFilters(q),
      ],
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

  /**
   * Download a brief attachment (the first one when attachmentId is omitted).
   * Same visibility rules as findOne; students may still open the brief of an
   * archived assignment they can see results for.
   */
  async serveFile(assignmentId: string, user: AuthUser, res: Response, forceDownload = false, attachmentId?: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { courseId: true, divisionId: true, status: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, assignment);
    if (user.role === 'STUDENT' && ![...STUDENT_VISIBLE_STATUSES, 'ARCHIVED'].includes(assignment.status)) {
      throw new NotFoundException('Assignment not found.');
    }
    const attachment = await this.prisma.assignmentAttachment.findFirst({
      where:   { assignmentId, ...(attachmentId && { id: attachmentId }) },
      orderBy: { sortOrder: 'asc' },
      include: { file: true },
    });
    if (!attachment) throw new NotFoundException('No such file on this assignment.');

    await this.storage.send(res, attachment.file, { download: forceDownload });
  }

  /** Full history, oldest first. Mentors of the scope and admins. */
  async history(assignmentId: string, user: AuthUser) {
    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { courseId: true, divisionId: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, assignment);

    return this.prisma.assignmentEvent.findMany({
      where:   { assignmentId },
      orderBy: { createdAt: 'asc' },
      select:  EVENT_SELECT,
    });
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
   * Apply `data` only if the assignment is currently in one of `from`, and
   * record `entry` in its history — both in one transaction, under a row lock.
   * Returns the updated assignment or throws INVALID_STATE_TRANSITION.
   */
  private async transition(
    id: string,
    from: AssignmentStatus[],
    data: Prisma.AssignmentUncheckedUpdateManyInput,
    entry: HistoryEntry,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<{ status: AssignmentStatus }[]>`
        SELECT "status" FROM "Assignment" WHERE "id" = ${id} FOR UPDATE`;
      if (!current || !from.includes(current.status)) {
        throw invalidState(
          `This action requires status ${from.join(' or ')}; the assignment is "${current?.status}".`,
          { currentStatus: current?.status, allowedFrom: from },
        );
      }
      await tx.assignment.update({ where: { id }, data });
      await tx.assignmentEvent.create({
        data: {
          assignmentId: id,
          type:         entry.type,
          fromStatus:   current.status,
          toStatus:     (data.status as AssignmentStatus | undefined) ?? current.status,
          actorId:      entry.actorId,
          note:         entry.note ?? null,
          ...(entry.changes !== undefined && { changes: entry.changes }),
        },
      });
    });
    return this.prisma.assignment.findUniqueOrThrow({ where: { id }, select: STAFF_DETAIL });
  }

  private async addAttachmentsInternal(assignmentId: string, files: Express.Multer.File[], user: AuthUser) {
    if (files.length === 0) return;
    const existing = await this.prisma.assignmentAttachment.aggregate({
      where: { assignmentId }, _count: { _all: true }, _max: { sortOrder: true },
    });
    if (existing._count._all + files.length > MAX_ATTACHMENTS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_FILES', `An assignment can have at most ${MAX_ATTACHMENTS} files.`);
    }
    let order = (existing._max.sortOrder ?? -1) + 1;
    const added: string[] = [];
    for (const f of files) {
      const stored = await this.storage.store(f, 'ASSIGNMENT_BRIEF', user.id);
      const a = await this.prisma.assignmentAttachment.create({ data: { assignmentId, fileId: stored.id, sortOrder: order++ } });
      added.push(a.id);
    }
    await this.prisma.assignmentEvent.create({
      data: { assignmentId, type: 'ATTACHMENT_ADDED', actorId: user.id, changes: { attachmentIds: added } },
    });
  }

  /** Students see PUBLISHED and CLOSED; `status` may narrow to one of them. */
  private studentStatusFilter(q: ListAssignmentsDto): Prisma.AssignmentWhereInput {
    return {
      status: { in: q.status ? STUDENT_VISIBLE_STATUSES.filter((s) => s === q.status) : STUDENT_VISIBLE_STATUSES },
    };
  }

  /** Filters every role may use: course, year, text search, deadline window. */
  private commonFilters(q: ListAssignmentsDto): Prisma.AssignmentWhereInput {
    return {
      ...(q.courseId       && { courseId: q.courseId }),
      ...(q.academicYearId && { academicYearId: q.academicYearId }),
      ...((q.deadlineFrom || q.deadlineTo) && {
        deadline: {
          ...(q.deadlineFrom && { gte: new Date(q.deadlineFrom) }),
          ...(q.deadlineTo   && { lte: new Date(q.deadlineTo) }),
        },
      }),
      ...(q.q && {
        OR: (['title', 'description', 'instructions'] as const).map((field) => ({
          [field]: { contains: q.q, mode: 'insensitive' as const },
        })),
      }),
    };
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
    a: { status: AssignmentStatus; deadline: Date; allowResubmission: boolean; maxResubmissions: number; allowLateSubmission: boolean },
    submission: { status: string; revisionCount: number } | null,
  ): boolean {
    if (a.status !== 'PUBLISHED') return false;
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

/**
 * Before/after values of the tracked fields that `next` actually changes
 * (undefined = not provided). Dates are compared and stored as ISO strings.
 */
function diffFields(
  current: Record<string, unknown>,
  next: Partial<Record<(typeof TRACKED_FIELDS)[number], unknown>>,
): Record<string, { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }> {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null)) as Prisma.InputJsonValue | null;
  const changes: Record<string, { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }> = {};
  for (const field of TRACKED_FIELDS) {
    if (next[field] === undefined) continue;
    const from = norm(current[field]);
    const to   = norm(next[field]);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}
