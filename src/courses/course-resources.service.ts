/**
 * CourseResourcesService
 *
 * Manages learning materials (books, notes, past papers, attachments)
 * that belong to a Course.
 *
 * File handling:
 *   - Files are stored in uploads/resources/<uuid><ext>.
 *   - MIME type and original filename are persisted on the resource row.
 *   - The serve() method sets Content-Disposition based on MIME type:
 *       inline  → PDF, images, plain text (browsers can display these).
 *       attachment → everything else (Word, ZIP, etc.) — forces download.
 *
 * Access rules:
 *   - ADMIN: full CRUD on resources in any course.
 *   - MENTOR (creator): full CRUD on resources in their own courses.
 *   - MENTOR (non-creator): read + download on PUBLISHED resources in PUBLISHED courses.
 *   - STUDENT: read + download on PUBLISHED resources in PUBLISHED courses.
 */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { diskStorage } from 'multer';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateResourceDto } from './dto/create-resource.dto.js';
import { UpdateResourceDto } from './dto/update-resource.dto.js';
import { resolveUploadPath, contentDisposition } from '../common/file.utils.js';
import type { CallerCtx } from '../submissions/submissions.service.js';

// ─── Multer storage config (exported for controller use) ──────────────────────

/** Allowed resource MIME types. */
export const RESOURCE_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'application/epub+zip',
]);

/** Max file size for resources: 50 MB. */
export const RESOURCE_MAX_FILE_SIZE = 50 * 1024 * 1024;

export const resourceStorage = diskStorage({
  destination: join(process.cwd(), 'uploads', 'resources'),
  filename: (_req, file, cb) =>
    cb(null, `${randomUUID()}${extname(file.originalname)}`),
});

export const resourceFileFilter = (
  _req: any,
  file: Express.Multer.File,
  cb: (err: Error | null, accept: boolean) => void,
) => {
  if (RESOURCE_ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new BadRequestException(
        `File type "${file.mimetype}" is not permitted for course resources.`,
      ),
      false,
    );
  }
};

// ─── Resource summary select ──────────────────────────────────────────────────

const RESOURCE_SELECT = {
  id:               true,
  type:             true,
  title:            true,
  description:      true,
  originalFilename: true,
  mimeType:         true,
  fileSize:         true,
  sortOrder:        true,
  isPublished:      true,
  publishedAt:      true,
  createdAt:        true,
  updatedAt:        true,
  uploadedBy: {
    select: { id: true, username: true, firstName: true, lastName: true },
  },
} as const;

@Injectable()
export class CourseResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Create
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * MENTOR (+ADMIN): Upload and register a new resource on a course.
   * File is optional — a resource record can exist without a file (e.g. a
   * metadata-only entry that will have a file added later).
   */
  async create(
    courseId: string,
    data: CreateResourceDto,
    caller: CallerCtx,
    file?: Express.Multer.File,
  ) {
    const course = await this.requireCourse(courseId);
    this.assertCanManage(course, caller);

    const fileUrl          = file ? `/uploads/resources/${file.filename}` : null;
    const originalFilename = file ? file.originalname : null;
    const mimeType         = file ? file.mimetype     : null;
    const fileSize         = file ? file.size         : null;

    const resource = await this.prisma.courseResource.create({
      data: {
        id:               randomUUID(),
        courseId,
        type:             data.type,
        title:            data.title,
        description:      data.description ?? null,
        fileUrl,
        originalFilename,
        mimeType,
        fileSize,
        sortOrder:        data.sortOrder ?? 0,
        isPublished:      false,
        uploadedById:     caller.id,
      },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'CREATE_COURSE_RESOURCE',
      entity:    'CourseResource',
      entityId:  resource.id,
      metadata:  { courseId, title: resource.title, type: resource.type },
    });

    return resource;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Read
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * List resources for a course.
   *
   * - ADMIN / course creator: all resources (published + unpublished).
   * - Everyone else: published resources only on a PUBLISHED course.
   */
  async findAll(courseId: string, caller: CallerCtx) {
    const course = await this.requireCourse(courseId);

    const isPrivileged =
      caller.role === 'ADMIN' || course.createdById === caller.id;

    // Non-privileged users may only see resources on published courses.
    if (!isPrivileged && course.status !== 'PUBLISHED') {
      throw new NotFoundException('Course not found.');
    }

    const where = isPrivileged
      ? { courseId }
      : { courseId, isPublished: true };

    return this.prisma.courseResource.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select:  RESOURCE_SELECT,
    });
  }

  /** Get a single resource record (metadata only — no file content). */
  async findOne(courseId: string, resourceId: string, caller: CallerCtx) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.assertCanRead(resource, courseId, caller);
    return resource;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serve file (view inline or force download)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Stream the resource file to the caller with correct headers.
   *
   * Content-Disposition:
   *   inline     → PDF, images, plain text — browser may render these.
   *   attachment → Word, ZIP, ePub, etc.   — browser will download.
   *
   * ?download=true forces attachment disposition regardless of MIME type
   * (useful when the user explicitly wants to save the file).
   */
  async serveFile(
    courseId:    string,
    resourceId:  string,
    caller:      CallerCtx,
    res:         Response,
    forceDownload = false,
  ) {
    const resource = await this.requireResource(courseId, resourceId);
    await this.assertCanRead(resource, courseId, caller);

    if (!resource.fileUrl) {
      throw new NotFoundException('This resource does not have a file attached.');
    }

    // resolveUploadPath validates the path and confirms the file exists.
    const filePath = resolveUploadPath(resource.fileUrl, 'resources');
    const disp     = contentDisposition(resource.mimeType, resource.originalFilename, forceDownload);

    if (resource.mimeType) {
      res.setHeader('Content-Type', resource.mimeType);
    }
    res.setHeader('Content-Disposition', disp);
    if (resource.fileSize) {
      res.setHeader('Content-Length', String(resource.fileSize));
    }

    createReadStream(filePath).pipe(res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Update
  // ═══════════════════════════════════════════════════════════════════════════

  /** MENTOR (+ADMIN): Update metadata fields. */
  async update(
    courseId:   string,
    resourceId: string,
    data:       UpdateResourceDto,
    caller:     CallerCtx,
    file?:      Express.Multer.File,
  ) {
    const course   = await this.requireCourse(courseId);
    const resource = await this.requireResource(courseId, resourceId);
    this.assertCanManage(course, caller);

    if (Object.keys(data).length === 0 && !file) {
      throw new BadRequestException('No fields to update.');
    }

    const updateData: Record<string, unknown> = {};
    if (data.type      !== undefined) updateData['type']      = data.type;
    if (data.title     !== undefined) updateData['title']     = data.title;
    if (data.description !== undefined) updateData['description'] = data.description;
    if (data.sortOrder !== undefined) updateData['sortOrder'] = data.sortOrder;

    if (file) {
      updateData['fileUrl']          = `/uploads/resources/${file.filename}`;
      updateData['originalFilename'] = file.originalname;
      updateData['mimeType']         = file.mimetype;
      updateData['fileSize']         = file.size;
    }

    const updated = await this.prisma.courseResource.update({
      where:  { id: resourceId },
      data:   updateData,
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UPDATE_COURSE_RESOURCE',
      entity:    'CourseResource',
      entityId:  resourceId,
      metadata:  { courseId, fields: Object.keys(updateData) },
    });

    return updated;
  }

  /** ADMIN (+course creator): Publish a resource so students can see it. */
  async publish(courseId: string, resourceId: string, caller: CallerCtx) {
    const course   = await this.requireCourse(courseId);
    const resource = await this.requireResource(courseId, resourceId);
    this.assertCanManage(course, caller);

    if (resource.isPublished) {
      throw new BadRequestException('Resource is already published.');
    }

    const updated = await this.prisma.courseResource.update({
      where:  { id: resourceId },
      data:   { isPublished: true, publishedAt: new Date() },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'PUBLISH_COURSE_RESOURCE',
      entity:    'CourseResource',
      entityId:  resourceId,
      metadata:  { courseId, title: resource.title },
    });

    return updated;
  }

  /** ADMIN (+course creator): Unpublish a resource. */
  async unpublish(courseId: string, resourceId: string, caller: CallerCtx) {
    const course   = await this.requireCourse(courseId);
    const resource = await this.requireResource(courseId, resourceId);
    this.assertCanManage(course, caller);

    if (!resource.isPublished) {
      throw new BadRequestException('Resource is not published.');
    }

    const updated = await this.prisma.courseResource.update({
      where:  { id: resourceId },
      data:   { isPublished: false, publishedAt: null },
      select: RESOURCE_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'UNPUBLISH_COURSE_RESOURCE',
      entity:    'CourseResource',
      entityId:  resourceId,
    });

    return updated;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN (+course creator): Delete a resource and its DB record. */
  async remove(courseId: string, resourceId: string, caller: CallerCtx) {
    const course = await this.requireCourse(courseId);
    await this.requireResource(courseId, resourceId);
    this.assertCanManage(course, caller);

    await this.prisma.courseResource.delete({ where: { id: resourceId } });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'DELETE_COURSE_RESOURCE',
      entity:    'CourseResource',
      entityId:  resourceId,
      metadata:  { courseId },
    });

    return { message: 'Resource deleted.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async requireCourse(courseId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  private async requireResource(courseId: string, resourceId: string) {
    const resource = await this.prisma.courseResource.findFirst({
      where:  { id: resourceId, courseId },
      select: { ...RESOURCE_SELECT, fileUrl: true, courseId: true },
    });
    if (!resource) throw new NotFoundException('Resource not found.');
    return resource;
  }

  /**
   * Can the caller manage (create/edit/delete) resources on this course?
   * ADMIN: always.
   * MENTOR: only if they created the course.
   */
  private assertCanManage(
    course: { createdById: string; status: string },
    caller: CallerCtx,
  ) {
    if (caller.role === 'ADMIN') return;
    if (caller.role === 'MENTOR' && course.createdById === caller.id) return;
    throw new ForbiddenException(
      'You do not have permission to manage resources on this course.',
    );
  }

  /**
   * Can the caller read (view metadata / download) this resource?
   * - Admin and course creator: always.
   * - Everyone else: only if the resource is published AND the course is published.
   */
  private async assertCanRead(
    resource: { isPublished: boolean; courseId: string },
    courseId: string,
    caller: CallerCtx,
  ) {
    if (caller.role === 'ADMIN') return;

    // Fetch course for creator + status check.
    const course = await this.prisma.course.findUnique({
      where:  { id: courseId },
      select: { createdById: true, status: true },
    });

    if (!course) throw new NotFoundException('Course not found.');

    // Course creator sees all resources regardless of publish state.
    if (course.createdById === caller.id) return;

    if (course.status !== 'PUBLISHED') {
      throw new NotFoundException('Course not found.');
    }

    if (!resource.isPublished) {
      throw new NotFoundException('Resource not found.');
    }
  }
}
