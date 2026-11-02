import {
  Body,
  Controller,
  Get,
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

import { AssignmentsService } from './assignments.service.js';
import { CreateAssignmentDto, ListAssignmentsDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { RejectAssignmentDto } from './dto/reject-assignment.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Assignments')
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  // ─── MENTOR: prepare ──────────────────────────────────────────────────────

  /** Create a draft (multipart/form-data; optional brief in field `file`). */
  @Post()
  @Roles('MENTOR')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('ASSIGNMENT_BRIEF')))
  create(
    @Body() body: CreateAssignmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.create(body, user, file);
  }

  /** Edit a DRAFT or REJECTED assignment. */
  @Patch(':id')
  @Roles('MENTOR')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('ASSIGNMENT_BRIEF')))
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAssignmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.update(id, body, user, file);
  }

  /** Send to the administrators for official publication. */
  @Patch(':id/submit')
  @Roles('MENTOR')
  submitForReview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.submitForReview(id, user);
  }

  /** Withdraw from review back to draft. */
  @Patch(':id/recall')
  @Roles('MENTOR')
  recall(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.recall(id, user);
  }

  // ─── ADMIN: official publication ──────────────────────────────────────────

  @Patch(':id/publish')
  @Roles('ADMIN')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.publish(id, user);
  }

  @Patch(':id/reject')
  @Roles('ADMIN')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignmentsService.reject(id, body, user);
  }

  /** Only possible while the assignment has no submissions. */
  @Patch(':id/unpublish')
  @Roles('ADMIN')
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.unpublish(id, user);
  }

  // ─── Read (scoped by role) ────────────────────────────────────────────────

  /**
   * Students: published assignments of their division.
   * Mentors: all statuses within their courses × divisions. Admins: everything.
   */
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListAssignmentsDto) {
    return this.assignmentsService.findAll(user, query);
  }

  /** Detail. For students this records the view and includes their submission state. */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.assignmentsService.findOne(id, user);
  }

  /** Download the assignment brief. */
  @Get(':id/file')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.assignmentsService.serveFile(id, user, res, download === 'true' || download === '1');
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
