import {
  Body,
  Controller,
  Delete,
  Get,
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

import { AssignmentsService } from './assignments.service.js';
import { CreateAssignmentDto, ListAssignmentsDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { CloseAssignmentDto, RejectAssignmentDto, ReopenAssignmentDto } from './dto/reject-assignment.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import { ATTACHMENT_FIELDS, filesFrom, type UploadedAttachmentFiles } from '../common/storage/attachments.js';
import type { AuthUser } from '../common/auth-user.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

@ApiTags('Assignments')
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  // ─── MENTOR: prepare ──────────────────────────────────────────────────────

  /**
   * Create a draft in the current academic year (multipart/form-data; brief
   * files in "files" — up to 10 — or "file").
   */
  @Post()
  @RequirePermission('assignments.prepare')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('ASSIGNMENT_BRIEF')))
  create(
    @Body() body: CreateAssignmentDto,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.create(body, user, filesFrom(upload));
  }

  /** Edit a DRAFT or REJECTED assignment; uploaded files are added to the brief. */
  @Patch(':id')
  @RequirePermission('assignments.prepare')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('ASSIGNMENT_BRIEF')))
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAssignmentDto,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.update(id, body, user, filesFrom(upload));
  }

  /** Add brief files (DRAFT/REJECTED only). */
  @Post(':id/attachments')
  @RequirePermission('assignments.prepare')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('ASSIGNMENT_BRIEF')))
  addAttachments(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.addAttachments(id, user, filesFrom(upload));
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermission('assignments.prepare')
  removeAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.removeAttachment(id, attachmentId, user);
  }

  /** Send to the administrators for official publication. */
  @Patch(':id/submit')
  @RequirePermission('assignments.prepare')
  submitForReview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.submitForReview(id, user);
  }

  /** Withdraw from review back to draft. */
  @Patch(':id/recall')
  @RequirePermission('assignments.prepare')
  recall(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.recall(id, user);
  }

  // ─── ADMIN: official publication ──────────────────────────────────────────

  @Patch(':id/publish')
  @RequirePermission('assignments.publish')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.publish(id, user);
  }

  @Patch(':id/reject')
  @RequirePermission('assignments.publish')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.reject(id, body, user);
  }

  /** Only possible while the assignment has no submissions. */
  @Patch(':id/unpublish')
  @RequirePermission('assignments.publish')
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.unpublish(id, user);
  }

  /** Stop accepting submissions now. Reviews and results carry on. */
  @Patch(':id/close')
  @RequirePermission('assignments.publish')
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CloseAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.close(id, body, user);
  }

  /** Accept submissions again; a new deadline is required if the old one has passed. */
  @Patch(':id/reopen')
  @RequirePermission('assignments.publish')
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReopenAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.reopen(id, body, user);
  }

  /** Read-only from now on; results stay visible. */
  @Patch(':id/archive')
  @RequirePermission('assignments.publish')
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.archive(id, user);
  }

  // ─── Read (scoped by role) ────────────────────────────────────────────────

  /**
   * Students: published and closed assignments of their division.
   * Mentors: all statuses within their courses × divisions. Admins: everything.
   * Filters: courseId, divisionId, status, academicYearId, createdById, q (text),
   * deadlineFrom / deadlineTo.
   */
  @Get()
  @Authenticated()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListAssignmentsDto) {
    return this.assignmentsService.findAll(user, query);
  }

  /** Detail. For students this records the view and includes their submission state. */
  @Get(':id')
  @Authenticated()
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.findOne(id, user);
  }

  /** Everything that happened to the assignment, oldest first (mentors of the scope, admins). */
  @Get(':id/history')
  @Roles('MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN')
  history(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.history(id, user);
  }

  /** Download the (first) brief file. */
  @Get(':id/file')
  @Authenticated()
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.assignmentsService.serveFile(id, user, res, download === 'true' || download === '1');
  }

  /** Download a specific brief file. */
  @Get(':id/attachments/:attachmentId/file')
  @Authenticated()
  async downloadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.assignmentsService.serveFile(id, user, res, download === 'true' || download === '1', attachmentId);
  }
}

@ApiTags('Me')
@Controller('me/assignments')
@Roles('STUDENT')
export class MyAssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  /** Every assignment for the student's division with New / Opened / Submitted / In Review / Marked. */
  @Get()
  findMine(@CurrentUser() user: AuthUser, @Query() query: ListAssignmentsDto) {
    return this.assignmentsService.getStudentAssignments(user, query);
  }
}
