import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiExtension, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ATTACHMENT_FIELDS, filesFrom, type UploadedAttachmentFiles } from '../common/storage/attachments.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import { PermissionOverridesService } from '../permission-overrides/permission-overrides.service.js';
import { CreateSubmissionDto } from '../submissions/dto/create-submission.dto.js';
import { CreateDelegationDto, CreateTeacherSchoolDto, ListTeacherSchoolsDto, ListTeacherStudentsDto } from './dto/teacher.dto.js';
import { TeacherSchoolsService } from './teacher-schools.service.js';
import { TeacherStudentsService } from './teacher-students.service.js';

/** Teacher school assignments (Administrators: users.manageTeachers). */
@ApiTags('Admin · Teachers')
@ApiBearerAuth()
@Controller('admin/teacher-assignments')
export class TeacherSchoolsController {
  constructor(private readonly service: TeacherSchoolsService) {}

  @Get()
  @RequirePermission('users.manageTeachers')
  list(@Query() q: ListTeacherSchoolsDto) {
    return this.service.list(q);
  }

  /** Give a Teacher a school (re-activates an ended assignment). */
  @Post()
  @RequirePermission('users.manageTeachers')
  assign(@Body() body: CreateTeacherSchoolDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(body, user);
  }

  /** End the assignment; applies on the teacher's next request. */
  @Delete(':id')
  @RequirePermission('users.manageTeachers')
  end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.end(id, user);
  }
}

/**
 * Teacher delegations (users.manageTeachers): Administrators (and Super Admins)
 * grant or revoke students.viewProfile, students.viewProgress and
 * submissions.submitOnBehalf for an individual Teacher — never anything else,
 * never on their own account. Revocation applies on the teacher's next request.
 */
@ApiTags('Admin · Teachers')
@ApiBearerAuth()
@Controller('admin/teachers')
export class TeacherDelegationsController {
  constructor(private readonly overrides: PermissionOverridesService) {}

  @Get(':id/delegations')
  @RequirePermission('users.manageTeachers')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.overrides.list(id, { delegation: true });
  }

  @Post(':id/delegations')
  @RequirePermission('users.manageTeachers')
  grant(@Param('id', ParseUUIDPipe) id: string, @Body() body: CreateDelegationDto, @CurrentUser() user: AuthUser) {
    return this.overrides.create(id, { permission: body.permission, effect: 'GRANT', reason: body.reason, expiresAt: body.expiresAt }, user, { delegation: true });
  }

  @Delete(':id/delegations/:overrideId')
  @RequirePermission('users.manageTeachers')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.overrides.revoke(id, overrideId, user, { delegation: true });
  }
}

/** The Teacher's own views: students of their schools only (P1-11). */
@ApiTags('Teacher')
@ApiBearerAuth()
@Controller('teacher/students')
export class TeacherStudentsController {
  constructor(private readonly service: TeacherStudentsService) {}

  /**
   * Teachers only: every registered student of the schools an Administrator has assigned to you
   * (active school assignments) — name, username, grade, division, school. Other roles: 403.
   */
  @Get()
  @RequirePermission('students.viewScoped')
  @ApiExtension('x-served-roles', ['TEACHER'])
  list(@Query() q: ListTeacherStudentsDto, @CurrentUser() user: AuthUser) {
    return this.service.list(user, q);
  }

  /** A student of your assigned schools: profile and account status, no contact details. Needs the students.viewProfile delegation. */
  @Get(':id')
  @RequirePermission('students.viewProfile')
  profile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.profile(user, id);
  }

  /** A student of your assigned schools: assignment availability and submission history, no scores or feedback. Needs the students.viewProgress delegation. */
  @Get(':id/progress')
  @RequirePermission('students.viewProgress')
  progress(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.progress(user, id);
  }

  /**
   * Submit for a student of your assigned schools (multipart, as POST /submissions). Needs the
   * submissions.submitOnBehalf delegation. The student stays the owner; you are recorded as the submitter.
   */
  @Post(':id/submissions')
  @RequirePermission('submissions.submitOnBehalf')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('SUBMISSION')))
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateSubmissionDto,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.submit(user, id, body, filesFrom(upload));
  }
}
