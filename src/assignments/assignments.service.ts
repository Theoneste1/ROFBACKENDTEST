import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateAssignmentDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { RejectAssignmentDto } from './dto/reject-assignment.dto.js';
import { deriveStudentDisplayStatus } from '../submissions/student-display-status.js';
import type { CallerCtx } from '../submissions/submissions.service.js';
/** Allowed attachment MIME types and max size (10 MB). */
export const ASSIGNMENT_FILE_FILTER = (
  _req: any,
  file: Express.Multer.File,
  cb: (error: Error | null, accept: boolean) => void,
) => {
  const allowed = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/zip',
    'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new BadRequestException(`File type "${file.mimetype}" is not allowed.`), false);
  }
};

export const ASSIGNMENT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const assignmentStorage = diskStorage({
  destination: join(process.cwd(), 'uploads', 'assignments'),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
});

const EDITABLE_STATUSES = ['DRAFT', 'REJECTED'] as const;

const ASSIGNMENT_SUMMARY = {
  id:               true,
  title:            true,
  instructions:     true,
  deadline:         true,
  points:           true,
  maximumMarks:     true,
  fileUrl:          true,
  allowResubmission: true,
  maxResubmissions: true,
  status:           true,
  publishedAt:      true,
  createdAt:        true,
  course:     { select: { id: true, title: true, subject: true } },
  createdBy:  { select: { id: true, username: true, firstName: true, lastName: true } },
  approvedBy: { select: { id: true, username: true } },
} as const;

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── MENTOR (+ADMIN): Create a draft assignment ───────────────────────────
  async create(
    data: CreateAssignmentDto,
    caller: CallerCtx,
    file?: Express.Multer.File,
  ) {
    const course = await this.prisma.course.findUnique({ where: { id: data.courseId } });
    if (!course) throw new NotFoundException('Course not found.');
    if (course.status !== 'PUBLISHED') {
      throw new BadRequestException('Assignments can only be created under a PUBLISHED course.');
    }

    const fileUrl = file ? `/uploads/assignments/${file.filename}` : null;

    const assignment = await this.prisma.assignment.create({
      data: {
        title:             data.title,
        courseId:          data.courseId,
        instructions:      data.instructions,
        deadline:          new Date(data.deadline),
        points:            data.points,
        maximumMarks:      data.maximumMarks,
        fileUrl,
        allowResubmission: data.allowResubmission ?? false,
        maxResubmissions:  data.maxResubmissions  ?? 0,
        status:            'DRAFT',
        createdById:       caller.id,
      },
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'CREATE_ASSIGNMENT',
      entity:    'Assignment',
      entityId:  assignment.id,
      metadata:  { title: assignment.title, courseId: data.courseId, courseTitle: course.title },
    });

    return assignment;
  }

  // ─── MENTOR (+ADMIN): Edit a DRAFT or REJECTED assignment ─────────────────
  async update(
    assignmentId: string,
    data: UpdateAssignmentDto,
    caller: CallerCtx,
    file?: Express.Multer.File,
  ) {
    const assignment = await this.findOrThrow(assignmentId);

    if (caller.role !== 'ADMIN' && assignment.createdById !== caller.id) {
      throw new ForbiddenException('You can only edit your own assignments.');
    }
    if (!EDITABLE_STATUSES.includes(assignment.status as any)) {
      throw new BadRequestException(
        `Cannot edit an assignment in "${assignment.status}" status. ` +
        `Only DRAFT or REJECTED assignments can be edited.`,
      );
    }

    // ── maximumMarks change guard ────────────────────────────────────────────
    // If the caller wants to reduce maximumMarks, check whether any submitted
    // score would become invalid. We check ALL submissions (not just published)
    // because the assignment might be re-published later.
    if (data.maximumMarks !== undefined && data.maximumMarks !== assignment.maximumMarks) {
      const highestScore = await this.prisma.submission.aggregate({
        where:  { assignmentId, score: { not: null } },
        _max:   { score: true },
      });

      const maxExistingScore = highestScore._max.score ?? 0;

      if (maxExistingScore > data.maximumMarks) {
        throw new BadRequestException(
          `Cannot reduce maximumMarks to ${data.maximumMarks}: ` +
          `an existing submission has a score of ${maxExistingScore}, ` +
          `which would exceed the new maximum. ` +
          `Correct or remove that score first.`,
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (data.title             !== undefined) updateData['title']             = data.title;
    if (data.instructions      !== undefined) updateData['instructions']      = data.instructions;
    if (data.deadline          !== undefined) updateData['deadline']           = new Date(data.deadline);
    if (data.points            !== undefined) updateData['points']             = data.points;
    if (data.maximumMarks      !== undefined) updateData['maximumMarks']       = data.maximumMarks;
    if (data.allowResubmission !== undefined) updateData['allowResubmission'] = data.allowResubmission;
    if (data.maxResubmissions  !== undefined) updateData['maxResubmissions']  = data.maxResubmissions;
    if (file) updateData['fileUrl'] = `/uploads/assignments/${file.filename}`;

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No fields to update.');
    }

    const updated = await this.prisma.assignment.update({
      where:  { id: assignmentId },
      data:   updateData,
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UPDATE_ASSIGNMENT',
      entity:    'Assignment',
      entityId:  assignmentId,
      metadata:  { fields: Object.keys(updateData) },
    });

    return updated;
  }

  // ─── MENTOR (+ADMIN): Submit draft for admin review ───────────────────────
  async submitForReview(assignmentId: string, caller: CallerCtx) {
    const assignment = await this.findOrThrow(assignmentId);

    if (caller.role !== 'ADMIN' && assignment.createdById !== caller.id) {
      throw new ForbiddenException('You can only submit your own assignments.');
    }
    if (!EDITABLE_STATUSES.includes(assignment.status as any)) {
      throw new BadRequestException(
        `Only DRAFT or REJECTED assignments can be submitted for review. Current: "${assignment.status}".`,
      );
    }

    const updated = await this.prisma.assignment.update({
      where:  { id: assignmentId },
      data:   { status: 'PENDING_APPROVAL', submittedAt: new Date(), rejectedAt: null, rejectionNote: null },
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'SUBMIT_ASSIGNMENT_FOR_REVIEW',
      entity:    'Assignment',
      entityId:  assignmentId,
      metadata:  { title: assignment.title },
    });

    return updated;
  }

  // ─── MENTOR (+ADMIN): Recall a pending assignment back to draft ───────────
  async recall(assignmentId: string, caller: CallerCtx) {
    const assignment = await this.findOrThrow(assignmentId);

    if (caller.role !== 'ADMIN' && assignment.createdById !== caller.id) {
      throw new ForbiddenException('You can only recall your own assignments.');
    }
    if (assignment.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Only PENDING_APPROVAL assignments can be recalled. Current: "${assignment.status}".`,
      );
    }

    const updated = await this.prisma.assignment.update({
      where:  { id: assignmentId },
      data:   { status: 'DRAFT', submittedAt: null },
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'RECALL_ASSIGNMENT', entity: 'Assignment', entityId: assignmentId,
    });

    return updated;
  }

  // ─── ADMIN: Publish a pending assignment ──────────────────────────────────
  async publish(assignmentId: string, caller: CallerCtx) {
    const assignment = await this.findOrThrow(assignmentId);

    if (assignment.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Only PENDING_APPROVAL assignments can be published. Current: "${assignment.status}".`,
      );
    }

    const updated = await this.prisma.assignment.update({
      where:  { id: assignmentId },
      data:   {
        status:       'PUBLISHED',
        publishedAt:  new Date(),
        approvedById: caller.id,
        rejectedAt:   null,
        rejectionNote: null,
      },
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'PUBLISH_ASSIGNMENT',
      entity:    'Assignment',
      entityId:  assignmentId,
      metadata:  { title: assignment.title },
    });

    return updated;
  }

  // ─── ADMIN: Reject a pending assignment ───────────────────────────────────
  async rejectAssignment(assignmentId: string, body: RejectAssignmentDto, caller: CallerCtx) {
    const assignment = await this.findOrThrow(assignmentId);

    if (assignment.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Only PENDING_APPROVAL assignments can be rejected. Current: "${assignment.status}".`,
      );
    }

    const updated = await this.prisma.assignment.update({
      where:  { id: assignmentId },
      data:   {
        status:        'REJECTED',
        rejectedAt:    new Date(),
        rejectionNote: body.rejectionNote,
        submittedAt:   null,
      },
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'REJECT_ASSIGNMENT',
      entity:    'Assignment',
      entityId:  assignmentId,
      metadata:  { rejectionNote: body.rejectionNote },
    });

    return updated;
  }

  // ─── ADMIN: Unpublish a published assignment ───────────────────────────────
  async unpublish(assignmentId: string, caller: CallerCtx) {
    const assignment = await this.findOrThrow(assignmentId);

    if (assignment.status !== 'PUBLISHED') {
      throw new BadRequestException('Only PUBLISHED assignments can be unpublished.');
    }

    const updated = await this.prisma.assignment.update({
      where:  { id: assignmentId },
      data:   { status: 'DRAFT', publishedAt: null, approvedById: null },
      select: ASSIGNMENT_SUMMARY,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UNPUBLISH_ASSIGNMENT',
      entity:    'Assignment',
      entityId:  assignmentId,
    });

    return updated;
  }

  // ─── ADMIN: Full list (all statuses) ──────────────────────────────────────
  async findAllAdmin() {
    return this.prisma.assignment.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        ...ASSIGNMENT_SUMMARY,
        submittedAt:   true,
        rejectedAt:    true,
        rejectionNote: true,
        updatedAt:     true,
        _count: { select: { submissions: true } },
      },
    });
  }

  // ─── MENTOR (+ADMIN): Own assignments (all statuses) ──────────────────────
  async findMine(creatorId: string) {
    return this.prisma.assignment.findMany({
      where:   { createdById: creatorId },
      orderBy: { updatedAt: 'desc' },
      select: {
        ...ASSIGNMENT_SUMMARY,
        submittedAt:   true,
        rejectedAt:    true,
        rejectionNote: true,
        updatedAt:     true,
      },
    });
  }

  // ─── ANY AUTHENTICATED: Published assignments ──────────────────────────────
  async findAll() {
    return this.prisma.assignment.findMany({
      where:   { status: 'PUBLISHED' },
      orderBy: { deadline: 'asc' },
      select:  ASSIGNMENT_SUMMARY,
    });
  }

  // ─── Get single assignment ─────────────────────────────────────────────────
  async findOne(assignmentId: string, caller: CallerCtx) {
    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: {
        ...ASSIGNMENT_SUMMARY,
        submittedAt:   true,
        rejectedAt:    true,
        rejectionNote: true,
        updatedAt:     true,
      },
    });

    if (!assignment) throw new NotFoundException('Assignment not found.');

    // Non-admin: can only see published, or their own unpublished
    if (
      caller.role !== 'ADMIN' &&
      assignment.status !== 'PUBLISHED' &&
      assignment.createdBy.id !== caller.id
    ) {
      throw new NotFoundException('Assignment not found.');
    }

    return assignment;
  }

  // ─── Private ───────────────────────────────────────────────────────────────
  private async findOrThrow(id: string) {
    const a = await this.prisma.assignment.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Assignment not found.');
    return a;
  }

  // ─── STUDENT: Record that a student opened this assignment ────────────────
  //
  // Called when a student GETs a single assignment.  Uses upsert so the first
  // call creates the view record and subsequent calls increment the counter.
  async recordView(assignmentId: string, studentId: string): Promise<void> {
    await this.prisma.assignmentView.upsert({
      where: {
        assignmentId_studentId: { assignmentId, studentId },
      },
      create: {
        id:            randomUUID(),
        assignmentId,
        studentId,
        firstViewedAt: new Date(),
        lastViewedAt:  new Date(),
        viewCount:     1,
      },
      update: {
        lastViewedAt: new Date(),
        viewCount:    { increment: 1 },
      },
    });
  }

  // ─── STUDENT: Get published assignments enriched with display status ───────
  //
  // Returns every published assignment a student can see, each annotated with:
  //   - displayStatus  (New / Opened / Submitted / In Review / Marked / Redo)
  //   - submissionId   (if the student has an active submission)
  async getStudentAssignments(studentId: string) {
    // Load all published assignments with the student's view and submission state.
    const assignments = await this.prisma.assignment.findMany({
      where:   { status: 'PUBLISHED' },
      orderBy: { deadline: 'asc' },
      select: {
        id:                true,
        title:             true,
        instructions:      true,
        deadline:          true,
        points:            true,
        maximumMarks:      true,
        fileUrl:           true,
        allowResubmission: true,
        maxResubmissions:  true,
        publishedAt:       true,
        course: { select: { id: true, title: true, subject: true } },
        // This student's view record (null if never viewed).
        views: {
          where:  { studentId },
          select: { firstViewedAt: true, lastViewedAt: true, viewCount: true },
          take:   1,
        },
        // This student's active submission (null if never submitted).
        submissions: {
          where:  { studentId },
          select: {
            id:            true,
            status:        true,
            revisionCount: true,
            submittedAt:   true,
          },
          orderBy: { createdAt: 'desc' },
          take:    1,
        },
      },
    });

    const { deriveStudentDisplayStatus: derive } = { deriveStudentDisplayStatus };

    return assignments.map((a) => {
      const view       = a.views[0]       ?? null;
      const submission = a.submissions[0] ?? null;

      const displayStatus = derive({
        hasViewed:         view !== null,
        submissionStatus:  submission?.status ?? null,
        deadline:          a.deadline,
        allowResubmission: a.allowResubmission,
      });

      return {
        id:                a.id,
        title:             a.title,
        instructions:      a.instructions,
        deadline:          a.deadline,
        points:            a.points,
        maximumMarks:      a.maximumMarks,
        fileUrl:           a.fileUrl,
        allowResubmission: a.allowResubmission,
        maxResubmissions:  a.maxResubmissions,
        publishedAt:       a.publishedAt,
        course:            a.course,
        displayStatus,
        submission: submission
          ? { id: submission.id, revisionCount: submission.revisionCount, submittedAt: submission.submittedAt }
          : null,
        viewedAt: view?.firstViewedAt ?? null,
      };
    });
  }
}
