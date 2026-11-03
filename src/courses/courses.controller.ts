import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CoursesService } from './courses.service.js';
import { CourseResourcesService } from './course-resources.service.js';
import { UpdateCourseDto } from './dto/update-course.dto.js';
import { CreateResourceDto, ListResourcesDto } from './dto/create-resource.dto.js';
import { UpdateResourceDto } from './dto/update-resource.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import { ATTACHMENT_FIELDS, filesFrom, type UploadedAttachmentFiles } from '../common/storage/attachments.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Courses')
@Controller('courses')
export class CoursesController {
  constructor(
    private readonly coursesService:         CoursesService,
    private readonly courseResourcesService: CourseResourcesService,
  ) {}

  /** Courses visible to the caller (students: published, with progress; mentors: taught). */
  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.coursesService.findAll(user);
  }

  /** Course detail. Opening a course as a student moves it from Unrolled to Rolled. */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.coursesService.findOne(id, user);
  }

  /** Student ticks the completion box. Idempotent. */
  @Post(':id/complete')
  @Roles('STUDENT')
  @HttpCode(200)
  completeCourse(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.coursesService.completeCourse(id, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Course resources — /courses/:courseId/resources
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a learning resource (multipart/form-data). Files go in "files"
   * (up to 10) or "file". Mentors: only for a division they teach.
   */
  @Post(':courseId/resources')
  @Roles('MENTOR', 'ADMIN')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('RESOURCE')))
  createResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() body: CreateResourceDto,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.create(courseId, body, user, filesFrom(upload));
  }

  /** Students: published resources of their division. Mentors/admins: all, filterable. */
  @Get(':courseId/resources')
  listResources(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Query() query: ListResourcesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.findAll(courseId, user, query);
  }

  @Get(':courseId/resources/:resourceId')
  getResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.findOne(courseId, resourceId, user);
  }

  /** The first file of the resource. ?download=true forces download. */
  @Get(':courseId/resources/:resourceId/file')
  async serveResourceFile(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.courseResourcesService.serveFile(courseId, resourceId, user, res, download === 'true' || download === '1');
  }

  /** A specific attachment of the resource. */
  @Get(':courseId/resources/:resourceId/attachments/:attachmentId/file')
  async serveAttachment(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.courseResourcesService.serveFile(
      courseId, resourceId, user, res, download === 'true' || download === '1', attachmentId,
    );
  }

  /** Update metadata; uploaded files are added as attachments. */
  @Patch(':courseId/resources/:resourceId')
  @Roles('MENTOR', 'ADMIN')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('RESOURCE')))
  updateResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body() body: UpdateResourceDto,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.update(courseId, resourceId, body, user, filesFrom(upload));
  }

  /** Add files to a resource. */
  @Post(':courseId/resources/:resourceId/attachments')
  @Roles('MENTOR', 'ADMIN')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('RESOURCE')))
  addResourceFiles(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.addAttachments(courseId, resourceId, user, filesFrom(upload));
  }

  @Delete(':courseId/resources/:resourceId/attachments/:attachmentId')
  @Roles('MENTOR', 'ADMIN')
  removeResourceFile(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.removeAttachment(courseId, resourceId, attachmentId, user);
  }

  @Patch(':courseId/resources/:resourceId/publish')
  @Roles('MENTOR', 'ADMIN')
  publishResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.setPublished(courseId, resourceId, true, user);
  }

  @Patch(':courseId/resources/:resourceId/unpublish')
  @Roles('MENTOR', 'ADMIN')
  unpublishResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.setPublished(courseId, resourceId, false, user);
  }

  /** Hide from students but keep (reversible with /restore). */
  @Patch(':courseId/resources/:resourceId/archive')
  @Roles('MENTOR', 'ADMIN')
  archiveResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.setArchived(courseId, resourceId, true, user);
  }

  @Patch(':courseId/resources/:resourceId/restore')
  @Roles('MENTOR', 'ADMIN')
  restoreResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.setArchived(courseId, resourceId, false, user);
  }

  @Delete(':courseId/resources/:resourceId')
  @Roles('MENTOR', 'ADMIN')
  removeResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.remove(courseId, resourceId, user);
  }
}

@ApiTags('Admin · Courses')
@Controller('admin/courses')
@Roles('ADMIN')
export class AdminCoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  /** Edit title, description or display order. The four courses cannot be created or deleted. */
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCourseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.coursesService.update(id, body, user);
  }

  @Patch(':id/publish')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.coursesService.setPublished(id, true, user);
  }

  /** Hides the course and all of its content from students. */
  @Patch(':id/unpublish')
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.coursesService.setPublished(id, false, user);
  }

  /** Retire a course: read-only, hidden from students, kept for history. */
  @Patch(':id/archive')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.coursesService.archive(id, user);
  }
}

@ApiTags('Courses')
@Controller('disciplines')
export class DisciplinesController {
  constructor(private readonly coursesService: CoursesService) {}

  /** Subject areas (Mathematics at launch). */
  @Get()
  list() {
    return this.coursesService.listDisciplines();
  }
}

@ApiTags('Me')
@Controller('me/courses')
@Roles('STUDENT')
export class MyCoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  /** Progress (Unrolled / Rolled / Completed) for every published course. */
  @Get()
  findMine(@CurrentUser() user: AuthUser) {
    return this.coursesService.getMyEnrollments(user.id);
  }
}
