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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
   * Upload a learning resource (multipart/form-data, file field `file`).
   * Mentors: only for a division they teach in this course.
   */
  @Post(':courseId/resources')
  @Roles('MENTOR', 'ADMIN')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('RESOURCE')))
  createResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() body: CreateResourceDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.create(courseId, body, user, file);
  }

  /** Students: published resources of their division. Mentors/admins: all, filterable by division. */
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

  /** View (PDF/images inline) or download the file. `?download=true` forces download. */
  @Get(':courseId/resources/:resourceId/file')
  async serveResourceFile(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.courseResourcesService.serveFile(
      courseId, resourceId, user, res, download === 'true' || download === '1',
    );
  }

  /** Update metadata and/or replace the file. */
  @Patch(':courseId/resources/:resourceId')
  @Roles('MENTOR', 'ADMIN')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('RESOURCE')))
  updateResource(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body() body: UpdateResourceDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.courseResourcesService.update(courseId, resourceId, body, user, file);
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
