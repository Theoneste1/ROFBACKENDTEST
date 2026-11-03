/**
 * CourseResourcesService
 *
 * Learning materials (books, notes, past papers, attachments) for a
 * (course × division). Junior and Senior students see different materials.
 * A resource can carry several files (ResourceAttachment).
 *
 * Access rules (via AccessService):
 *   - ADMIN:   manage everything.
 *   - MENTOR:  manage resources in the course × divisions they are assigned to.
 *   - STUDENT: read published, non-archived resources of their own division on
 *              published courses.
 *
 * Deletion policy: resources may be deleted (attachments cascade; orphaned
 * files are removed by the nightly storage cleanup) or archived (kept, hidden
 * from students).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Response } from 'express';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { ATTACHMENT_SELECT, MAX_ATTACHMENTS } from '../common/storage/attachments.js';
import type { AuthUser } from '../common/auth-user.js';
import type { FileObject, Prisma } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import { CreateResourceDto, ListResourcesDto } from './dto/create-resource.dto.js';
import { UpdateResourceDto } from './dto/update-resource.dto.js';

const RESOURCE_SELECT = {
  id:          true,
  courseId:    true,
  divisionId:  true,
  type:        true,
  title:       true,
  description: true,
  author:      true,
  source:      true,
  year:        true,
  tags:        true,
  sortOrder:   true,
  isPublished: true,
  publishedAt: true,
  archivedAt:  true,
  createdAt:   true,
  updatedAt:   true,
  attachments: { orderBy: { sortOrder: 'asc' as const }, select: ATTACHMENT_SELECT },
  division:    { select: { id: true, code: true, name: true } },
  uploadedBy:  { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class CourseResourcesService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly access:    AccessService,
    private readonly storage:   StorageService,
    private readonly events:    EventEmitter2,
    private readonly activity:  ActivityService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Create
  // ═══════════════════════════════════════════════════════════════════════════

  async create(courseId: string, data: CreateResourceDto, user: AuthUser, files: Express.Multer.File[] = []) {
    await this.requireCourse(courseId);
    await this.access.assertCanManage(user, { courseId, divisionId: data.divisionId });

    const stored: FileObject[] = [];
    for (const f of files) stored.push(await this.storage.store(f, 'RESOURCE', user.id));

    const resource = await this.prisma.courseResource.create({
      data: {
        courseId,
        divisionId:   data.divisionId,
        type:         data.type,
        title:        data.title,
        description:  data.description ?? null,
        author:       data.author ?? null,
        source:       data.source ?? null,
        year:         data.year ?? null,
        tags:         data.tags ?? [],
        sortOrder:    data.sortOrder ?? 0,
        uploadedById: user.id,
        attachments:  { create: stored.map((s, i) => ({ fileId: s.id, sortOrder: i })) },
      },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'CREATE_COURSE_RESOURCE', entity: 'CourseResource', entityId: resource.id,
      metadata: { courseId, divisionId: data.divisionId, title: resource.title, files: stored.length },
    });

    return resource;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read
  // ═══════════════════════════════════════════════════════════════════════════

  async findAll(courseId: string, user: AuthUser, q: ListResourcesDto) {
    await this.requireCourse(courseId);

    const where: Prisma.CourseResourceWhereInput = {
      courseId,
      ...(q.type && { type: q.type }),
      ...(q.tag && { tags: { has: q.tag } }),
      ...(q.year && { year: q.year }),
      ...(q.q && {
        OR: (['title', 'description', 'author', 'source'] as const).map((field) => ({
          [field]: { contains: q.q, mode: 'insensitive' as const },
        })),
      }),
    };

    if (user.role === 'STUDENT') {
      const divisionId = this.access.studentDivision(user);
      await this.access.assertCanView(user, { courseId, divisionId });
      Object.assign(where, { divisionId, isPublished: true, archivedAt: null });
    } else {
      if (user.role === 'MENTOR') {
        const divisions = (await this.access.mentorScopes(user.id))
          .filter((s) => s.courseId === courseId)
          .map((s) => s.divisionId);
        if (divisions.length === 0 || (q.divisionId && !divisions.includes(q.divisionId))) {
          throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ASSIGNED_TO_SCOPE', 'You are not assigned to this course and division.');
        }
        where.divisionId = q.divisionId ?? { in: divisions };
      } else if (q.divisionId) {
        where.divisionId = q.divisionId;
      }
      if (!q.includeArchived) where.archivedAt = null;
    }

    return this.prisma.courseResource.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select:  RESOURCE_SELECT,
    });
  }

  async findOne(courseId: string, resourceId: string, user: AuthUser) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.assertCanRead(resource, user);
    return resource;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serve files
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Stream one attachment (the first one when `attachmentId` is omitted).
   * PDFs and images open inline unless ?download=true. Student views are
   * recorded for course analytics.
   */
  async serveFile(
    courseId: string, resourceId: string, user: AuthUser, res: Response,
    forceDownload = false, attachmentId?: string,
  ) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.assertCanRead(resource, user);

    const attachment = await this.prisma.resourceAttachment.findFirst({
      where:   { resourceId, ...(attachmentId && { id: attachmentId }) },
      orderBy: { sortOrder: 'asc' },
      include: { file: true },
    });
    if (!attachment) throw new NotFoundException('This resource has no such file.');

    if (user.role === 'STUDENT') {
      const now = new Date();
      await this.prisma.resourceView.upsert({
        where:  { resourceId_studentId: { resourceId, studentId: user.id } },
        create: { resourceId, studentId: user.id, firstViewedAt: now, lastViewedAt: now },
        update: { lastViewedAt: now, viewCount: { increment: 1 } },
      });
      this.activity.record(user.id, 'RESOURCE_VIEWED', { courseId, entityType: 'CourseResource', entityId: resourceId });
    }

    await this.storage.send(res, attachment.file, { download: forceDownload });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Update / attachments / publish / archive
  // ═══════════════════════════════════════════════════════════════════════════

  /** Update metadata; any uploaded files are added as attachments. */
  async update(courseId: string, resourceId: string, data: UpdateResourceDto, user: AuthUser, files: Express.Multer.File[] = []) {
    const resource = await this.requireManageable(courseId, resourceId, user);

    if (Object.keys(data).length === 0 && files.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'No fields to update.');
    }

    await this.addAttachmentsInternal(resource.id, files, user);
    const updated = await this.prisma.courseResource.update({
      where:  { id: resourceId },
      data:   {
        type: data.type, title: data.title, description: data.description, sortOrder: data.sortOrder,
        author: data.author, source: data.source, year: data.year, tags: data.tags,
      },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UPDATE_COURSE_RESOURCE', entity: 'CourseResource', entityId: resourceId,
      metadata: { courseId, fields: Object.keys(data), filesAdded: files.length },
    });
    return updated;
  }

  async addAttachments(courseId: string, resourceId: string, user: AuthUser, files: Express.Multer.File[]) {
    if (files.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Attach at least one file (field "files").');
    }
    await this.requireManageable(courseId, resourceId, user);
    await this.addAttachmentsInternal(resourceId, files, user);
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'ADD_RESOURCE_FILES', entity: 'CourseResource', entityId: resourceId, metadata: { files: files.length },
    });
    return this.prisma.courseResource.findUniqueOrThrow({ where: { id: resourceId }, select: RESOURCE_SELECT });
  }

  /** Detach a file. The stored file is removed by the nightly orphan cleanup. */
  async removeAttachment(courseId: string, resourceId: string, attachmentId: string, user: AuthUser) {
    await this.requireManageable(courseId, resourceId, user);
    const { count } = await this.prisma.resourceAttachment.deleteMany({ where: { id: attachmentId, resourceId } });
    if (count === 0) throw new NotFoundException('Attachment not found.');
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'REMOVE_RESOURCE_FILE', entity: 'CourseResource', entityId: resourceId, metadata: { attachmentId },
    });
    return this.prisma.courseResource.findUniqueOrThrow({ where: { id: resourceId }, select: RESOURCE_SELECT });
  }

  async setPublished(courseId: string, resourceId: string, publish: boolean, user: AuthUser) {
    const resource = await this.requireManageable(courseId, resourceId, user);
    if (resource.archivedAt && publish) throw invalidState('Restore the resource before publishing it.');
    if (resource.isPublished === publish) {
      throw invalidState(publish ? 'Resource is already published.' : 'Resource is not published.');
    }

    const updated = await this.prisma.courseResource.update({
      where:  { id: resourceId },
      data:   { isPublished: publish, publishedAt: publish ? new Date() : null },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: publish ? 'PUBLISH_COURSE_RESOURCE' : 'UNPUBLISH_COURSE_RESOURCE',
      entity: 'CourseResource', entityId: resourceId, metadata: { courseId },
    });

    if (publish) this.events.emit(Events.ResourcePublished, { resourceId });
    return updated;
  }

  /** Archive (hide from students, keep) or restore a resource. */
  async setArchived(courseId: string, resourceId: string, archive: boolean, user: AuthUser) {
    const resource = await this.requireManageable(courseId, resourceId, user);
    if (!!resource.archivedAt === archive) {
      throw invalidState(archive ? 'Resource is already archived.' : 'Resource is not archived.');
    }
    const updated = await this.prisma.courseResource.update({
      where: { id: resourceId },
      data:  archive
        ? { archivedAt: new Date(), isPublished: false, publishedAt: null }
        : { archivedAt: null },
      select: RESOURCE_SELECT,
    });
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: archive ? 'ARCHIVE_COURSE_RESOURCE' : 'RESTORE_COURSE_RESOURCE',
      entity: 'CourseResource', entityId: resourceId,
    });
    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete
  // ═══════════════════════════════════════════════════════════════════════════

  async remove(courseId: string, resourceId: string, user: AuthUser) {
    const resource = await this.requireManageable(courseId, resourceId, user);

    await this.prisma.courseResource.delete({ where: { id: resourceId } });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'DELETE_COURSE_RESOURCE', entity: 'CourseResource', entityId: resourceId,
      metadata: { courseId, title: resource.title },
    });

    return { message: 'Resource deleted.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async addAttachmentsInternal(resourceId: string, files: Express.Multer.File[], user: AuthUser) {
    if (files.length === 0) return;
    const existing = await this.prisma.resourceAttachment.aggregate({
      where: { resourceId }, _count: { _all: true }, _max: { sortOrder: true },
    });
    if (existing._count._all + files.length > MAX_ATTACHMENTS) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_FILES', `A resource can have at most ${MAX_ATTACHMENTS} files.`);
    }
    let order = (existing._max.sortOrder ?? -1) + 1;
    for (const f of files) {
      const stored = await this.storage.store(f, 'RESOURCE', user.id);
      await this.prisma.resourceAttachment.create({ data: { resourceId, fileId: stored.id, sortOrder: order++ } });
    }
  }

  private async requireCourse(courseId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  private async requireResource(courseId: string, resourceId: string) {
    const resource = await this.prisma.courseResource.findFirst({
      where:  { id: resourceId, courseId },
      select: RESOURCE_SELECT,
    });
    if (!resource) throw new NotFoundException('Resource not found.');
    return resource;
  }

  private async requireManageable(courseId: string, resourceId: string, user: AuthUser) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.access.assertCanManage(user, { courseId, divisionId: resource.divisionId });
    return resource;
  }

  /** Students additionally need the resource to be published and not archived. */
  private async assertCanRead(
    resource: { courseId: string; divisionId: string; isPublished: boolean; archivedAt: Date | null },
    user: AuthUser,
  ) {
    await this.access.assertCanView(user, { courseId: resource.courseId, divisionId: resource.divisionId });
    if (user.role === 'STUDENT' && (!resource.isPublished || resource.archivedAt)) {
      throw new NotFoundException('Resource not found.');
    }
  }
}
