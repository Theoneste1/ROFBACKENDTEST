import {
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import type { CourseEnrollmentStatus } from '../generated/prisma/client.js';
import { UpdateCourseDto } from './dto/update-course.dto.js';

// ─── Student-facing display labels ───────────────────────────────────────────
//
// Internal enum values are UNROLLED / ROLLED / COMPLETED.

const DISPLAY_LABELS: Record<CourseEnrollmentStatus, string> = {
  UNROLLED:  'Unrolled',
  ROLLED:    'Rolled',
  COMPLETED: 'Completed',
};

const COURSE_SELECT = {
  id:          true,
  code:        true,
  title:       true,
  description: true,
  status:      true,
  sortOrder:   true,
  discussionsEnabled: true,
  publishedAt: true,
  archivedAt:  true,
  discipline:  { select: { id: true, code: true, name: true } },
} as const;

/**
 * Courses belong to a discipline (launch: the four Mathematics courses —
 * Algebra, Geometry, Number Theory, Combinatorics). Courses are created by
 * the seed; admins may edit their text and visibility, and archive them, but
 * never delete them.
 */
@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly audit:   AuditService,
    private readonly access:  AccessService,
    private readonly activity: ActivityService,
  ) {}

  // ─── List courses visible to the caller ────────────────────────────────────
  //
  // STUDENT: published courses, with their enrollment status and the number of
  //          published resources/assignments in THEIR division.
  // MENTOR:  courses they teach, with the divisions they are assigned to.
  // ADMIN:   every course with totals.
  async findAll(user: AuthUser) {
    if (user.role === 'STUDENT') {
      const divisionId = this.access.studentDivision(user);
      const courses = await this.prisma.course.findMany({
        where:   { status: 'PUBLISHED' },
        orderBy: { sortOrder: 'asc' },
        select: {
          ...COURSE_SELECT,
          enrollments: { where: { studentId: user.id }, select: { status: true }, take: 1 },
          _count: {
            select: {
              resources:   { where: { divisionId, isPublished: true } },
              assignments: { where: { divisionId, status: { in: ['PUBLISHED', 'CLOSED'] } } },
            },
          },
        },
      });
      return courses.map(({ enrollments, _count, ...c }) => {
        const status = enrollments[0]?.status ?? 'UNROLLED';
        return {
          ...c,
          enrollmentStatus: status,
          displayStatus:    DISPLAY_LABELS[status],
          counts:           _count,
        };
      });
    }

    if (user.role === 'MENTOR') {
      const scopes = await this.prisma.mentorAssignment.findMany({
        where:  { mentorId: user.id, isActive: true },
        select: { courseId: true, division: { select: { id: true, code: true, name: true } } },
      });
      const courseIds = [...new Set(scopes.map((s) => s.courseId))];
      const courses = await this.prisma.course.findMany({
        where:   { id: { in: courseIds } },
        orderBy: { sortOrder: 'asc' },
        select:  COURSE_SELECT,
      });
      return courses.map((c) => ({
        ...c,
        divisions: scopes.filter((s) => s.courseId === c.id).map((s) => s.division),
      }));
    }

    return this.prisma.course.findMany({
      orderBy: { sortOrder: 'asc' },
      select: {
        ...COURSE_SELECT,
        createdAt: true,
        updatedAt: true,
        _count: { select: { assignments: true, resources: true, mentorAssignments: { where: { isActive: true } } } },
      },
    });
  }

  // ─── Single course ─────────────────────────────────────────────────────────
  //
  // For STUDENT callers this records the view (UNROLLED → ROLLED on first open);
  // re-opening a COMPLETED course never regresses it.
  async findOne(courseId: string, user: AuthUser) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: COURSE_SELECT });
    if (!course) throw new NotFoundException('Course not found.');

    if (user.role === 'STUDENT') {
      if (course.status !== 'PUBLISHED') throw new NotFoundException('Course not found.');
      const divisionId = this.access.studentDivision(user);
      const enrollment = await this.recordCourseView(courseId, user.id);
      this.activity.record(user.id, 'COURSE_OPENED', { courseId, entityType: 'Course', entityId: courseId });
      const counts = await this.prisma.course.findUnique({
        where:  { id: courseId },
        select: {
          _count: {
            select: {
              resources:   { where: { divisionId, isPublished: true } },
              assignments: { where: { divisionId, status: { in: ['PUBLISHED', 'CLOSED'] } } },
            },
          },
        },
      });
      return {
        ...course,
        enrollmentStatus: enrollment.status,
        displayStatus:    DISPLAY_LABELS[enrollment.status],
        completedAt:      enrollment.completedAt,
        counts:           counts!._count,
      };
    }

    if (user.role === 'MENTOR') {
      const divisions = await this.prisma.mentorAssignment.findMany({
        where:  { mentorId: user.id, courseId, isActive: true },
        select: { division: { select: { id: true, code: true, name: true } } },
      });
      if (divisions.length === 0) {
        throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ASSIGNED_TO_SCOPE', 'You are not assigned to this course.');
      }
      return { ...course, divisions: divisions.map((d) => d.division) };
    }

    const mentors = await this.prisma.mentorAssignment.findMany({
      where:  { courseId, isActive: true },
      select: {
        id:       true,
        division: { select: { id: true, code: true, name: true } },
        mentor:   { select: { id: true, firstName: true, lastName: true, username: true } },
      },
    });
    return { ...course, mentorAssignments: mentors };
  }

  // ─── ADMIN: Edit course text / order ───────────────────────────────────────
  async update(courseId: string, data: UpdateCourseDto, caller: CallerCtx) {
    await this.findOrThrow(courseId);

    if (Object.keys(data).length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }

    const updated = await this.prisma.course.update({
      where:  { id: courseId },
      data:   {
        title: data.title, description: data.description, sortOrder: data.sortOrder,
        discussionsEnabled: data.discussionsEnabled,
      },
      select: COURSE_SELECT,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UPDATE_COURSE', entity: 'Course', entityId: courseId, metadata: {
        fields: Object.keys(data),
        ...(data.discussionsEnabled !== undefined && { discussionsEnabled: data.discussionsEnabled }),
      },
    });
    return updated;
  }

  // ─── ADMIN: Archive ────────────────────────────────────────────────────────
  //
  // Archiving keeps everything (content, results, history) but hides the course
  // from students and stops new work. It can be re-published later.
  async archive(courseId: string, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);
    if (course.status === 'ARCHIVED') throw invalidState('Course is already archived.');

    const updated = await this.prisma.course.update({
      where:  { id: courseId },
      data:   { status: 'ARCHIVED', archivedAt: new Date() },
      select: COURSE_SELECT,
    });
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'ARCHIVE_COURSE', entity: 'Course', entityId: courseId,
    });
    return updated;
  }

  /** Disciplines (subject areas). Mathematics only at launch. */
  async listDisciplines() {
    return this.prisma.discipline.findMany({
      where:   { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select:  { id: true, code: true, name: true, description: true, _count: { select: { courses: true } } },
    });
  }

  // ─── ADMIN: Publish / unpublish ────────────────────────────────────────────
  //
  // An unpublished course hides ALL of its content from students (resources,
  // assignments, sessions, discussions) and blocks new submissions.
  async setPublished(courseId: string, publish: boolean, caller: CallerCtx) {
    const course = await this.findOrThrow(courseId);
    const target = publish ? 'PUBLISHED' : 'DRAFT';
    if (course.status === target) {
      throw invalidState(`Course is already ${publish ? 'published' : 'unpublished'}.`);
    }

    const updated = await this.prisma.course.update({
      where:  { id: courseId },
      data:   { status: target, publishedAt: publish ? new Date() : null, archivedAt: null },
      select: COURSE_SELECT,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: publish ? 'PUBLISH_COURSE' : 'UNPUBLISH_COURSE', entity: 'Course', entityId: courseId,
    });
    return updated;
  }

  // ─── STUDENT: Mark course as COMPLETED ─────────────────────────────────────
  //
  // Rules:
  //   - Course must be PUBLISHED and already opened (ROLLED).
  //   - Re-checking a COMPLETED course is idempotent.
  async completeCourse(courseId: string, user: AuthUser) {
    const course = await this.findOrThrow(courseId);
    if (course.status !== 'PUBLISHED') throw new NotFoundException('Course not found.');

    const enrollment = await this.prisma.courseEnrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId: user.id } },
    });

    if (!enrollment || enrollment.status === 'UNROLLED') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'COURSE_NOT_OPENED', 'You must open the course before marking it as completed.');
    }

    if (enrollment.status === 'COMPLETED') {
      return {
        courseId,
        enrollmentStatus: 'COMPLETED',
        displayStatus:    DISPLAY_LABELS.COMPLETED,
        completedAt:      enrollment.completedAt,
        alreadyCompleted: true,
      };
    }

    const now = new Date();
    const updated = await this.prisma.courseEnrollment.update({
      where: { courseId_studentId: { courseId, studentId: user.id } },
      data:  { status: 'COMPLETED', completedAt: now },
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'COMPLETE_COURSE', entity: 'CourseEnrollment', entityId: updated.id, metadata: { courseId },
    });
    this.activity.record(user.id, 'COURSE_COMPLETED', { courseId, entityType: 'Course', entityId: courseId });

    return {
      courseId,
      enrollmentStatus: 'COMPLETED',
      displayStatus:    DISPLAY_LABELS.COMPLETED,
      completedAt:      now,
      alreadyCompleted: false,
    };
  }

  // ─── STUDENT: Status across all published courses ──────────────────────────
  async getMyEnrollments(studentId: string) {
    const courses = await this.prisma.course.findMany({
      where:   { status: 'PUBLISHED' },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, code: true, title: true,
        enrollments: {
          where:  { studentId },
          select: { status: true, firstOpenedAt: true, lastOpenedAt: true, completedAt: true },
          take:   1,
        },
      },
    });

    return courses.map(({ enrollments, ...course }) => {
      const e = enrollments[0];
      const status = e?.status ?? 'UNROLLED';
      return {
        course,
        status,
        displayStatus: DISPLAY_LABELS[status],
        firstOpenedAt: e?.firstOpenedAt ?? null,
        lastOpenedAt:  e?.lastOpenedAt  ?? null,
        completedAt:   e?.completedAt   ?? null,
      };
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────
  private async findOrThrow(id: string) {
    const course = await this.prisma.course.findUnique({ where: { id } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  /**
   * Records a student view and advances UNROLLED → ROLLED on first open.
   * Uses upsert so concurrent first opens cannot collide.
   */
  private async recordCourseView(courseId: string, studentId: string) {
    const now = new Date();
    const enrollment = await this.prisma.courseEnrollment.upsert({
      where:  { courseId_studentId: { courseId, studentId } },
      create: { courseId, studentId, status: 'ROLLED', firstOpenedAt: now, lastOpenedAt: now },
      update: { lastOpenedAt: now },
    });

    if (enrollment.status === 'UNROLLED') {
      return this.prisma.courseEnrollment.update({
        where: { id: enrollment.id },
        data:  { status: 'ROLLED' },
      });
    }
    return enrollment;
  }
}
