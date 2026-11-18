import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RegistrationAvatarService } from '../users/registration-avatar.service.js';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { TeacherApplicationsService } from './teacher-applications.service.js';
import {
  ApproveTeacherApplicationDto, ListTeacherApplicationsDto, RegisterTeacherDto, RejectTeacherApplicationDto,
  VerifyTeacherApplicationSchoolDto,
} from './dto/teacher-application.dto.js';
import { RequestApplicationInfoDto } from '../application-info-requests/application-info-requests.dto.js';

/** Teacher self-registration (public): availability and the application itself. */
@ApiTags('Auth')
@Controller('auth/register/teacher')
export class TeacherRegistrationController {
  constructor(private readonly service: TeacherApplicationsService) {}

  /** `{ open }`: true only while TEACHERS_ENABLED and registration.teacherSelfSignup are both on. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('availability')
  availability() {
    return this.service.availability();
  }

  /** Submit a Teacher application (no account until an Administrator approves it). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  register(@Body() body: RegisterTeacherDto) {
    return this.service.register(body);
  }
}

/** Administrators review Teacher applications (users.manageTeachers; the TEACHER role must be enabled). */
@ApiTags('Teacher applications')
@ApiBearerAuth()
@Controller('admin/teacher-applications')
export class AdminTeacherApplicationsController {
  constructor(
    private readonly service: TeacherApplicationsService,
    private readonly registrationAvatar: RegistrationAvatarService,
  ) {}

  @Get()
  @RequirePermission('users.manageTeachers')
  list(@Query() query: ListTeacherApplicationsDto, @CurrentUser() user: AuthUser) {
    return this.service.list(query, user);
  }

  /** The picture sent with the application, for review before approval (private, not cached). 404 when none. */
  @Get(':id/avatar')
  @RequirePermission('users.manageTeachers')
  async avatar(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.service.get(id, user);   // the same access rule as opening the application
    await this.registrationAvatar.sendApplicationAvatar('TEACHER', id, res);
  }

  @Get(':id')
  @RequirePermission('users.manageTeachers')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.get(id, user);
  }

  /**
   * Missing-school application: link it to an existing official school (records the verification and
   * e-mails the applicant that the school was verified). The application stays PENDING.
   */
  @Post(':id/school')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  verifySchool(@Param('id', ParseUUIDPipe) id: string, @Body() body: VerifyTeacherApplicationSchoolDto, @CurrentUser() user: AuthUser) {
    return this.service.verifySchool(id, body, user);
  }

  /** Creates the TEACHER account and its school assignment (a missing-school application: after its school is verified). */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveTeacherApplicationDto, @CurrentUser() user: AuthUser) {
    return this.service.approve(id, body, user);
  }

  /** Ask the applicant for more information (ADR-009); the application stays PENDING. 409 when already decided. */
  @Post(':id/request-info')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  requestInfo(@Param('id', ParseUUIDPipe) id: string, @Body() body: RequestApplicationInfoDto, @CurrentUser() user: AuthUser) {
    return this.service.requestInfo(id, body.question, user);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectTeacherApplicationDto, @CurrentUser() user: AuthUser) {
    return this.service.reject(id, body, user);
  }
}
