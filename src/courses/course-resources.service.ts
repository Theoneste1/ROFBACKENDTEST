/**
 * CourseResourcesService
 *
 * Learning materials (books, notes, past papers, attachments) for a
 * (course × division). Junior and Senior students see different materials.
 *
 * Access rules (via AccessService):
 *   - ADMIN:   manage everything.
 *   - MENTOR:  manage resources in the course × divisions they are assigned to.
 *   - STUDENT: read published resources of their own division on published courses.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Response } from 'express';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { StorageService } from '../common/storage/storage.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import type { AuthUser } from '../common/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { Events } from '../notifications/events.js';
import { CreateResourceDto, ListResourcesDto } from './dto/create-resource.dto.js';
import { UpdateResourceDto } from './dto/update-resource.dto.js';

const FILE_SELECT = { select: { id: true, originalName: true, mimeType: true, size: true } } as const;

const RESOURCE_SELECT = {
  id:          true,
  courseId:    true,
  divisionId:  true,
  type:        true,
  title:       true,
  description: true,
  sortOrder:   true,
  isPublished: true,
  publishedAt: true,
  createdAt:   true,
  updatedAt:   true,
  file:        FILE_SELECT,
  division:    { select: { id: true, code: true, name: true } },
  uploadedBy:  { select: { id: true, username: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class CourseResourcesService {
  constructor(
    private readonly prisma:   PrismaService,
    private readonly audit:    AuditService,
    private readonly access:   AccessService,
    private readonly storage:  StorageService,
    private readonly events:   EventEmitter2,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Create
  // ═══════════════════════════════════════════════════════════════════════════

  async create(courseId: string, data: CreateResourceDto, user: AuthUser, file?: Express.Multer.File) {
    await this.requireCourse(courseId);
    await this.access.assertCanManage(user, { courseId, divisionId: data.divisionId });

    const stored = file ? await this.storage.store(file, 'RESOURCE', user.id) : null;

    const resource = await this.prisma.courseResource.create({
      data: {
        courseId,
        divisionId:   data.divisionId,
        type:         data.type,
        title:        data.title,
        description:  data.description ?? null,
        fileId:       stored?.id ?? null,
        sortOrder:    data.sortOrder ?? 0,
        uploadedById: user.id,
      },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'CREATE_COURSE_RESOURCE', entity: 'CourseResource', entityId: resource.id,
      metadata: { courseId, divisionId: data.divisionId, title: resource.title, type: resource.type },
    });

    return resource;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read
  // ═══════════════════════════════════════════════════════════════════════════

  async findAll(courseId: string, user: AuthUser, q: ListResourcesDto) {
    await this.requireCourse(courseId);

    const where: Prisma.CourseResourceWhereInput = { courseId, ...(q.type && { type: q.type }) };

    if (user.role === 'STUDENT') {
      const divisionId = this.access.studentDivision(user);
      await this.access.assertCanView(user, { courseId, divisionId });
      Object.assign(where, { divisionId, isPublished: true });
    } else if (user.role === 'MENTOR') {
      const divisions = (await this.access.mentorScopes(user.id))
        .filter((s) => s.courseId === courseId)
        .map((s) => s.divisionId);
      if (q.divisionId && !divisions.includes(q.divisionId)) {
        await this.access.assertCanView(user, { courseId, divisionId: q.divisionId }); // throws
      }
      if (divisions.length === 0) {
        throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ASSIGNED_TO_SCOPE', 'You are not assigned to this course.');
      }
      where.divisionId = q.divisionId ?? { in: divisions };
    } else if (q.divisionId) {
      where.divisionId = q.divisionId;
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
  // Serve file
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Stream the resource file. PDFs and images open inline; other types (and
   * any type with ?download=true) download as attachments.
   * Student downloads are recorded for course analytics.
   */
  async serveFile(courseId: string, resourceId: string, user: AuthUser, res: Response, forceDownload = false) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.assertCanRead(resource, user);

    const file = resource.fileId
      ? await this.prisma.fileObject.findUnique({ where: { id: resource.fileId } })
      : null;
    if (!file) throw new NotFoundException('This resource does not have a file attached.');

    if (user.role === 'STUDENT') {
      const now = new Date();
      await this.prisma.resourceView.upsert({
        where:  { resourceId_studentId: { resourceId, studentId: user.id } },
        create: { resourceId, studentId: user.id, firstViewedAt: now, lastViewedAt: now },
        update: { lastViewedAt: now, viewCount: { increment: 1 } },
      });
    }

    await this.storage.send(res, file, { download: forceDownload });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Update / publish
  // ═══════════════════════════════════════════════════════════════════════════

  async update(courseId: string, resourceId: string, data: UpdateResourceDto, user: AuthUser, file?: Express.Multer.File) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.access.assertCanManage(user, { courseId, divisionId: resource.divisionId });

    if (Object.keys(data).length === 0 && !file) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'No fields to update.');
    }

    // The previous file becomes an orphan and is removed by the nightly cleanup.
    const stored = file ? await this.storage.store(file, 'RESOURCE', user.id) : null;

    const updated = await this.prisma.courseResource.update({
      where: { id: resourceId },
      data: {
        type:        data.type,
        title:       data.title,
        description: data.description,
        sortOrder:   data.sortOrder,
        ...(stored && { fileId: stored.id }),
      },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'UPDATE_COURSE_RESOURCE', entity: 'CourseResource', entityId: resourceId,
      metadata: { courseId, fields: Object.keys(data), fileReplaced: !!stored },
    });

    return updated;
  }

  async setPublished(courseId: string, resourceId: string, publish: boolean, user: AuthUser) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.access.assertCanManage(user, { courseId, divisionId: resource.divisionId });

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

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete
  // ═══════════════════════════════════════════════════════════════════════════

  async remove(courseId: string, resourceId: string, user: AuthUser) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.access.assertCanManage(user, { courseId, divisionId: resource.divisionId });

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

  private async requireCourse(courseId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  private async requireResource(courseId: string, resourceId: string) {
    const resource = await this.prisma.courseResource.findFirst({
      where:  { id: resourceId, courseId },
      select: { ...RESOURCE_SELECT, fileId: true },
    });
    if (!resource) throw new NotFoundException('Resource not found.');
    return resource;
  }

  /** Students additionally need the resource itself to be published. */
  private async assertCanRead(resource: { courseId: string; divisionId: string; isPublished: boolean }, user: AuthUser) {
    await this.access.assertCanView(user, { courseId: resource.courseId, divisionId: resource.divisionId });
    if (user.role === 'STUDENT' && !resource.isPublished) {
      throw new NotFoundException('Resource not found.');
    }
  }
}
