
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateCourseDto } from './dto/create-course.dto.js';
import { UpdateCourseDto } from './dto/update-course.dto.js';
import { RejectCourseDto } from './dto/reject-course.dto.js';
import type { CallerCtx } from '../submissions/submissions.service.js';

// ─── Student-facing display labels ───────────────────────────────────────────
//
// The requirement mandates these exact strings in API responses.
// Internal enum values are UNROLLED / ROLLED / COMPLETED.

const DISPLAY_LABELS: Record<string, string> = {
  UNROLLED:  'Unrolled',
  ROLLED:    'Rolled',
  COMPLETED: 'Completed',
};

/** Statuses that are safe to edit (draft or sent back after rejection). */
const EDITABLE_STATUSES = ['DRAFT', 'REJECTED'] as const;

const COURSE_SUMMARY_SELECT = {
  id:          true,
  title:       true,
  description: true,
  subject:     true,
  status:      true,
  publishedAt: true,
  createdAt:   true,
  createdById: true,
  createdBy: {
    select: { id: true, firstName: true, lastName: true, username: true },
  },
} as const;

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── MENTOR (+ADMIN): Create a course draft ───────────────────────────────
  async create(data: CreateCourseDto, caller: CallerCtx) {
    const course = await this.prisma.course.create({
      data: {
        title:       data.title,
        description: data.description,
        subject:     data.subject,
        status:      'DRAFT',
        createdById: caller.id,
      },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'CREATE_COURSE',
      entity:    'Course',
      entityId:  course.id,
      metadata:  { title: course.title, subject: course.subject },
    });

    return course;
  }

  // ─── MENTOR (+ADMIN): Update own draft / rejected course ─────────────────
  async update(courseId: string, data: UpdateCourseDto, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    // Only creator or admin may edit.
    if (caller.role !== 'ADMIN' && course.createdById !== caller.id) {
      throw new ForbiddenException('You can only edit your own courses.');
    }

    // Can only edit while in DRAFT or REJECTED state.
    if (!EDITABLE_STATUSES.includes(course.status as any)) {
      throw new BadRequestException(
        `A course in "${course.status}" status cannot be edited. Recall it first.`,
      );
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one field must be provided.');
    }

    const updated = await this.prisma.course.update({
      where:  { id: courseId },
      data:   {
        title:       data.title,
        description: data.description,
        subject:     data.subject,
      },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UPDATE_COURSE',
      entity:    'Course',
      entityId:  courseId,
    });

    return updated;
  }

  // ─── MENTOR (+ADMIN): Submit a draft for admin review ─────────────────────
  async submitForReview(courseId: string, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    if (caller.role !== 'ADMIN' && course.createdById !== caller.id) {
      throw new ForbiddenException('You can only submit your own courses.');
    }

    if (!EDITABLE_STATUSES.includes(course.status as any)) {
      throw new BadRequestException(
        `Only DRAFT or REJECTED courses can be submitted for review. Current status: "${course.status}".`,
      );
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data:  {
        status:       'PENDING_APPROVAL',
        submittedAt:  new Date(),
        rejectedAt:   null,
        rejectionNote: null,
      },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'SUBMIT_COURSE_FOR_REVIEW',
      entity:    'Course',
      entityId:  courseId,
      metadata:  { title: course.title },
    });

    return updated;
  }

  // ─── MENTOR (+ADMIN): Recall a pending-approval course back to draft ──────
  async recall(courseId: string, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    if (caller.role !== 'ADMIN' && course.createdById !== caller.id) {
      throw new ForbiddenException('You can only recall your own courses.');
    }

    if (course.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Only PENDING_APPROVAL courses can be recalled. Current status: "${course.status}".`,
      );
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data:  { status: 'DRAFT', submittedAt: null },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'RECALL_COURSE',
      entity:    'Course',
      entityId:  courseId,
    });

    return updated;
  }

  // ─── ADMIN: Approve and publish a course ──────────────────────────────────
  async publish(courseId: string, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    if (course.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Only PENDING_APPROVAL courses can be published. Current status: "${course.status}".`,
      );
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data:  {
        status:      'PUBLISHED',
        publishedAt: new Date(),
        rejectedAt:  null,
        rejectionNote: null,
      },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'PUBLISH_COURSE',
      entity:    'Course',
      entityId:  courseId,
      metadata:  { title: course.title },
    });

    return updated;
  }

  // ─── ADMIN: Reject a pending course ───────────────────────────────────────
  async reject(courseId: string, body: RejectCourseDto, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    if (course.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Only PENDING_APPROVAL courses can be rejected. Current status: "${course.status}".`,
      );
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data:  {
        status:       'REJECTED',
        rejectedAt:   new Date(),
        rejectionNote: body.rejectionNote,
        submittedAt:  null,
      },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'REJECT_COURSE',
      entity:    'Course',
      entityId:  courseId,
      metadata:  { rejectionNote: body.rejectionNote },
    });

    return updated;
  }

  // ─── ADMIN: Unpublish a published course ──────────────────────────────────
  async unpublish(courseId: string, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    if (course.status !== 'PUBLISHED') {
      throw new BadRequestException(
        `Only PUBLISHED courses can be unpublished. Current status: "${course.status}".`,
      );
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data:  { status: 'DRAFT', publishedAt: null },
      select: COURSE_SUMMARY_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UNPUBLISH_COURSE',
      entity:    'Course',
      entityId:  courseId,
    });

    return updated;
  }

  // ─── ADMIN: Full list (all statuses) ──────────────────────────────────────
  async findAllAdmin() {
    return this.prisma.course.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        ...COURSE_SUMMARY_SELECT,
        submittedAt:   true,
        rejectedAt:    true,
        rejectionNote: true,
        updatedAt:     true,
        _count: { select: { assignments: true } },
      },
    });
  }

  // ─── MENTOR: Own courses (all statuses) ───────────────────────────────────
  async findMine(creatorId: string) {
    return this.prisma.course.findMany({
      where:   { createdById: creatorId },
      orderBy: { updatedAt: 'desc' },
      select: {
        ...COURSE_SUMMARY_SELECT,
        submittedAt:   true,
        rejectedAt:    true,
        rejectionNote: true,
        updatedAt:     true,
        _count: { select: { assignments: true } },
      },
    });
  }

  // ─── ANY AUTHENTICATED USER: Published courses ────────────────────────────
  //
  // When the caller is a STUDENT, each course is annotated with their
  // personal enrollment status (displayStatus) and the internal enum value.
  async findAllPublished(caller: CallerCtx) {
    const courses = await this.prisma.course.findMany({
      where:   { status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      select: {
        ...COURSE_SUMMARY_SELECT,
        _count: { select: { assignments: true } },
        ...(caller.role === 'STUDENT' || caller.role === 'ADMIN'
          ? {
              enrollments: {
                where:  { studentId: caller.id },
                select: { status: true },
                take:   1,
              },
            }
          : {}),
      },
    });

    return courses.map((c) => {
      const raw = (c as any).enrollments?.[0]?.status ?? 'UNROLLED';
      return {
        ...c,
        enrollments:   undefined,
        enrollmentStatus: raw,
        displayStatus:    DISPLAY_LABELS[raw] ?? raw,
      };
    });
  }

  // ─── ANY AUTHENTICATED USER: Single published course ──────────────────────
  //
  // For STUDENT callers:
  //   1. Records the view (UNROLLED → ROLLED if first open).
  //   2. Returns the current enrollment status.
  //   3. Re-opening a COMPLETED course does NOT reset the status.
  async findOne(courseId: string, caller: CallerCtx) {
    const course = await this.prisma.course.findUnique({
      where:  { id: courseId },
      select: {
        ...COURSE_SUMMARY_SELECT,
        submittedAt:   true,
        rejectedAt:    true,
        rejectionNote: true,
        updatedAt:     true,
        assignments: {
          where:   caller.role === 'ADMIN' ? {} : { status: 'PUBLISHED' as const },
          orderBy: { deadline: 'asc' },
          select: {
            id:           true,
            title:        true,
            instructions: true,
            deadline:     true,
            points:       true,
            maximumMarks: true,
            fileUrl:      true,
            status:       true,
            publishedAt:  true,
          },
        },
      },
    });

    if (!course) throw new NotFoundException('Course not found.');

    // Non-admin cannot see the course unless it is published or they created it.
    if (
      caller.role !== 'ADMIN' &&
      course.status !== 'PUBLISHED' &&
      course.createdById !== caller.id
    ) {
      throw new NotFoundException('Course not found.');
    }

    // ── Record view for students ─────────────────────────────────────────────
    let enrollmentStatus = 'UNROLLED';

    if (caller.role === 'STUDENT' && course.status === 'PUBLISHED') {
      enrollmentStatus = await this.recordCourseView(courseId, caller.id);
    } else if (caller.role === 'ADMIN') {
      // Admins get the raw enrollment status if it exists (no view recording).
      const existing = await this.prisma.courseEnrollment.findUnique({
        where:  { courseId_studentId: { courseId, studentId: caller.id } },
        select: { status: true },
      });
      enrollmentStatus = existing?.status ?? 'UNROLLED';
    }

    return {
      ...course,
      enrollmentStatus,
      displayStatus: DISPLAY_LABELS[enrollmentStatus] ?? enrollmentStatus,
    };
  }

  // ─── STUDENT (+ADMIN): Mark course as COMPLETED ──────────────────────────
  //
  // Called when the student checks the completion checkbox at the end
  // of the course. The checkbox is a frontend element; this endpoint
  // persists the completion.
  //
  // Rules:
  //   - Course must be PUBLISHED.
  //   - Student must have opened the course (status must be ROLLED).
  //   - Re-checking the box on a COMPLETED course is idempotent (200, no change).
  //   - Completion is NEVER derived from books/notes/resources opened.
  async completeCourse(courseId: string, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);

    if (course.status !== 'PUBLISHED') {
      throw new NotFoundException('Course not found.');
    }

    const enrollment = await this.prisma.courseEnrollment.findUnique({
      where:  { courseId_studentId: { courseId, studentId: caller.id } },
    });

    // Must have opened the course before completing it.
    if (!enrollment || enrollment.status === 'UNROLLED') {
      throw new BadRequestException(
        'You must open the course before marking it as completed.',
      );
    }

    // Idempotent — if already COMPLETED, return the current state without change.
    if (enrollment.status === 'COMPLETED') {
      return {
        courseId,
        enrollmentStatus: 'COMPLETED',
        displayStatus:    DISPLAY_LABELS['COMPLETED'],
        completedAt:      enrollment.completedAt,
        alreadyCompleted: true,
      };
    }

    const now = new Date();
    const updated = await this.prisma.courseEnrollment.update({
      where: { courseId_studentId: { courseId, studentId: caller.id } },
      data:  { status: 'COMPLETED', completedAt: now },
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'COMPLETE_COURSE',
      entity:    'CourseEnrollment',
      entityId:  updated.id,
      metadata:  { courseId, completedAt: now },
    });

    return {
      courseId,
      enrollmentStatus: 'COMPLETED',
      displayStatus:    DISPLAY_LABELS['COMPLETED'],
      completedAt:      now,
      alreadyCompleted: false,
    };
  }

  // ─── STUDENT: Get own enrollment status across all enrolled courses ───────
  async getMyEnrollments(studentId: string) {
    const enrollments = await this.prisma.courseEnrollment.findMany({
      where:   { studentId },
      orderBy: { lastOpenedAt: 'desc' },
      select: {
        id:           true,
        status:       true,
        firstOpenedAt: true,
        lastOpenedAt:  true,
        completedAt:   true,
        course: {
          select: {
            id:          true,
            title:       true,
            description: true,
            subject:     true,
            publishedAt: true,
          },
        },
      },
    });

    return enrollments.map((e) => ({
      ...e,
      displayStatus: DISPLAY_LABELS[e.status] ?? e.status,
    }));
  }

  // ─── Private helpers ──────────────────────────────────────────────────────
  private async findOrThrow(id: string) {
    const course = await this.prisma.course.findUnique({ where: { id } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  /**
   * Records a student view of a course and advances the enrollment status
   * from UNROLLED → ROLLED on the first open.
   *
   * Idempotent:
   *   - UNROLLED  → advances to ROLLED
   *   - ROLLED    → updates lastOpenedAt only (no status change)
   *   - COMPLETED → updates lastOpenedAt only (does NOT regress to ROLLED)
   *
   * Returns the current status after the operation.
   */
  private async recordCourseView(courseId: string, studentId: string): Promise<string> {
    const existing = await this.prisma.courseEnrollment.findUnique({
      where:  { courseId_studentId: { courseId, studentId } },
    });

    if (!existing) {
      // First open — create enrollment as ROLLED.
      const created = await this.prisma.courseEnrollment.create({
        data: {
          id:            randomUUID(),
          courseId,
          studentId,
          status:        'ROLLED',
          firstOpenedAt: new Date(),
          lastOpenedAt:  new Date(),
        },
      });
      return created.status;
    }

    // Already has a record — advance only if UNROLLED; never regress from COMPLETED.
    const newStatus = existing.status === 'UNROLLED' ? 'ROLLED' : existing.status;

    await this.prisma.courseEnrollment.update({
      where: { courseId_studentId: { courseId, studentId } },
      data:  { status: newStatus, lastOpenedAt: new Date() },
    });

    return newStatus;
  }
}
