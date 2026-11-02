
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { CoursesService } from './courses.service.js';
import { CourseResourcesService, resourceStorage, resourceFileFilter, RESOURCE_MAX_FILE_SIZE } from './course-resources.service.js';
import { CreateCourseDto } from './dto/create-course.dto.js';
import { UpdateCourseDto } from './dto/update-course.dto.js';
import { RejectCourseDto } from './dto/reject-course.dto.js';
import { CreateResourceDto } from './dto/create-resource.dto.js';
import { UpdateResourceDto } from './dto/update-resource.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

const resourceUploadOpts = {
  storage:    resourceStorage,
  fileFilter: resourceFileFilter,
  limits:     { fileSize: RESOURCE_MAX_FILE_SIZE },
};

@Controller('courses')
export class CoursesController {
  constructor(
    private readonly coursesService:          CoursesService,
    private readonly courseResourcesService:  CourseResourcesService,
  ) {}

  // ─── MENTOR (+ADMIN): Create a draft course ───────────────────────────────
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  create(@Body() body: CreateCourseDto, @Request() req: any) {
    return this.coursesService.create(body, { id: req.user.id, role: req.user.role });
  }

  // ─── MENTOR (+ADMIN): View own courses ────────────────────────────────────
  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  findMine(@Request() req: any) {
    return this.coursesService.findMine(req.user.id);
  }

  // ─── ADMIN: View ALL courses (all statuses) ────────────────────────────────
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  findAllAdmin() {
    return this.coursesService.findAllAdmin();
  }

  // ─── ANY AUTHENTICATED: Browse published courses with enrollment status ─────
  @Get()
  @UseGuards(JwtAuthGuard)
  findAllPublished(@Request() req: any) {
    return this.coursesService.findAllPublished({ id: req.user.id, role: req.user.role });
  }

  // ─── ANY AUTHENTICATED: Get single course ─────────────────────────────────
  // For STUDENT callers: records the view (UNROLLED → ROLLED on first open).
  // Re-opening a COMPLETED course does NOT reset the status.
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.findOne(id, { id: req.user.id, role: req.user.role });
  }

  // ─── STUDENT (+ADMIN): Mark course as COMPLETED ───────────────────────────
  // Called when the student checks the completion checkbox at the end of the
  // course. Idempotent — checking the box again on a completed course is fine.
  @Post(':id/complete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT')
  completeCourse(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.completeCourse(id, { id: req.user.id, role: req.user.role });
  }

  // ─── STUDENT (+ADMIN): View own course enrollments ────────────────────────
  @Get('my/enrollments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT')
  getMyEnrollments(@Request() req: any) {
    return this.coursesService.getMyEnrollments(req.user.id);
  }

  // ─── MENTOR (+ADMIN): Edit a DRAFT or REJECTED course ────────────────────
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  update(
    @Param('id') id: string,
    @Body() body: UpdateCourseDto,
    @Request() req: any,
  ) {
    return this.coursesService.update(id, body, { id: req.user.id, role: req.user.role });
  }

  // ─── MENTOR (+ADMIN): Submit a draft for admin review ────────────────────
  @Patch(':id/submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  submitForReview(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.submitForReview(id, { id: req.user.id, role: req.user.role });
  }

  // ─── MENTOR (+ADMIN): Recall a pending course back to draft ──────────────
  @Patch(':id/recall')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  recall(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.recall(id, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: Publish a pending course ──────────────────────────────────────
  @Patch(':id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  publish(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.publish(id, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: Reject a pending course ───────────────────────────────────────
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  reject(
    @Param('id') id: string,
    @Body() body: RejectCourseDto,
    @Request() req: any,
  ) {
    return this.coursesService.reject(id, body, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: Unpublish a live course ───────────────────────────────────────
  @Patch(':id/unpublish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  unpublish(@Param('id') id: string, @Request() req: any) {
    return this.coursesService.unpublish(id, { id: req.user.id, role: req.user.role });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Course Resources — nested under /courses/:courseId/resources
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * MENTOR (+ADMIN): Upload a new learning resource to a course.
   * File field name: `file` (multipart/form-data).
   * Allowed types: PDF, images, Word, PowerPoint, ZIP, ePub, plain text.
   * Max size: 50 MB.
   *
   * POST /courses/:courseId/resources
   */
  @Post(':courseId/resources')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  @UseInterceptors(FileInterceptor('file', resourceUploadOpts))
  createResource(
    @Param('courseId') courseId: string,
    @Body() body: CreateResourceDto,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    return this.courseResourcesService.create(
      courseId,
      body,
      { id: req.user.id, role: req.user.role },
      file,
    );
  }

  /**
   * ANY AUTHENTICATED: List resources for a course.
   * ADMIN / creator → all resources (published + draft).
   * Everyone else   → published resources on published courses only.
   *
   * GET /courses/:courseId/resources
   */
  @Get(':courseId/resources')
  @UseGuards(JwtAuthGuard)
  listResources(@Param('courseId') courseId: string, @Request() req: any) {
    return this.courseResourcesService.findAll(
      courseId,
      { id: req.user.id, role: req.user.role },
    );
  }

  /**
   * ANY AUTHENTICATED: Get a single resource's metadata.
   *
   * GET /courses/:courseId/resources/:resourceId
   */
  @Get(':courseId/resources/:resourceId')
  @UseGuards(JwtAuthGuard)
  getResource(
    @Param('courseId')   courseId:   string,
    @Param('resourceId') resourceId: string,
    @Request() req: any,
  ) {
    return this.courseResourcesService.findOne(
      courseId,
      resourceId,
      { id: req.user.id, role: req.user.role },
    );
  }

  /**
   * ANY AUTHENTICATED: View or download the resource file.
   *
   * Content-Disposition behaviour:
   *   PDF, images, plain text → inline  (browser can display)
   *   Word, ZIP, ePub, etc.   → attachment (browser downloads)
   *
   * Add ?download=true to force attachment disposition for any type.
   *
   * GET /courses/:courseId/resources/:resourceId/file
   * GET /courses/:courseId/resources/:resourceId/file?download=true
   */
  @Get(':courseId/resources/:resourceId/file')
  @UseGuards(JwtAuthGuard)
  async serveResourceFile(
    @Param('courseId')   courseId:   string,
    @Param('resourceId') resourceId: string,
    @Query('download')   download:   string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const forceDownload = download === 'true' || download === '1';
    await this.courseResourcesService.serveFile(
      courseId,
      resourceId,
      { id: req.user.id, role: req.user.role },
      res,
      forceDownload,
    );
  }

  /**
   * MENTOR (+ADMIN): Update resource metadata or replace the file.
   *
   * PATCH /courses/:courseId/resources/:resourceId
   */
  @Patch(':courseId/resources/:resourceId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  @UseInterceptors(FileInterceptor('file', resourceUploadOpts))
  updateResource(
    @Param('courseId')   courseId:   string,
    @Param('resourceId') resourceId: string,
    @Body() body: UpdateResourceDto,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    return this.courseResourcesService.update(
      courseId,
      resourceId,
      body,
      { id: req.user.id, role: req.user.role },
      file,
    );
  }

  /**
   * MENTOR (+ADMIN): Publish a resource (make it visible to students).
   *
   * PATCH /courses/:courseId/resources/:resourceId/publish
   */
  @Patch(':courseId/resources/:resourceId/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  publishResource(
    @Param('courseId')   courseId:   string,
    @Param('resourceId') resourceId: string,
    @Request() req: any,
  ) {
    return this.courseResourcesService.publish(
      courseId,
      resourceId,
      { id: req.user.id, role: req.user.role },
    );
  }

  /**
   * MENTOR (+ADMIN): Unpublish a resource.
   *
   * PATCH /courses/:courseId/resources/:resourceId/unpublish
   */
  @Patch(':courseId/resources/:resourceId/unpublish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  unpublishResource(
    @Param('courseId')   courseId:   string,
    @Param('resourceId') resourceId: string,
    @Request() req: any,
  ) {
    return this.courseResourcesService.unpublish(
      courseId,
      resourceId,
      { id: req.user.id, role: req.user.role },
    );
  }

  /**
   * ADMIN (+course creator): Delete a resource.
   *
   * DELETE /courses/:courseId/resources/:resourceId
   */
  @Delete(':courseId/resources/:resourceId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  removeResource(
    @Param('courseId')   courseId:   string,
    @Param('resourceId') resourceId: string,
    @Request() req: any,
  ) {
    return this.courseResourcesService.remove(
      courseId,
      resourceId,
      { id: req.user.id, role: req.user.role },
    );
  }
}
