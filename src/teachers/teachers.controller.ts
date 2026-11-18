import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiExtension, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ATTACHMENT_FIELDS, filesFrom, type UploadedAttachmentFiles } from '../common/storage/attachments.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import { PermissionOverridesService } from '../permission-overrides/permission-overrides.service.js';
import { CreateSubmissionDto } from '../submissions/dto/create-submission.dto.js';
import {
  AssignTeacherStudentsDto, CreateDelegationDto, CreateTeacherSchoolDto, DelegationStudentsDto, ListTeacherSchoolsDto,
  ListTeacherStudentAssignmentsDto, ListTeacherStudentsDto, ReassignTeacherStudentsDto, SchoolAccessStudentsDto,
} from './dto/teacher.dto.js';
import { TeacherStudentAssignmentsService } from './teacher-student-assignments.service.js';
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
  constructor(
    private readonly overrides: PermissionOverridesService,
    private readonly assignments: TeacherStudentAssignmentsService,
  ) {}

  @Get(':id/delegations')
  @RequirePermission('users.manageTeachers')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.overrides.list(id, { delegation: true });
  }

  @Post(':id/delegations')
  @RequirePermission('users.manageTeachers')
  grant(@Param('id', ParseUUIDPipe) id: string, @Body() body: CreateDelegationDto, @CurrentUser() user: AuthUser) {
    return this.overrides.create(id, {
      permission: body.permission, effect: 'GRANT', reason: body.reason, expiresAt: body.expiresAt,
      studentScope: body.studentScope, studentIds: body.studentIds,
    }, user, { delegation: true });
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

  /**
   * Add students to a delegation for SELECTED students (each must be seen by the teacher). Per student: ADDED,
   * SKIPPED (ALREADY_SET) or FAILED (STUDENT_NOT_IN_TEACHER_SCOPE). 409 NOT_SELECTED_SCOPE / OVERRIDE_INACTIVE.
   */
  @Post(':id/delegations/:overrideId/students')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  addStudents(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
    @Body() body: DelegationStudentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.addDelegationStudents(id, overrideId, body, user);
  }

  /** Take a student off a delegation for selected students (kept as history). */
  @Delete(':id/delegations/:overrideId/students/:studentId')
  @RequirePermission('users.manageTeachers')
  removeStudent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.removeDelegationStudent(id, overrideId, studentId, user);
  }

  /** Clear the "needs review" flag set when a listed student left the teacher's scope (409 NO_REVIEW_NEEDED). */
  @Post(':id/delegations/:overrideId/reviewed')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  reviewed(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.markReviewed(id, overrideId, user);
  }
}

/** Explicit teacher–student assignments (Administrators: users.manageTeachers; TS-2, TS-3). */
@ApiTags('Admin · Teachers')
@ApiBearerAuth()
@Controller('admin/teacher-students')
export class TeacherStudentAssignmentsController {
  constructor(private readonly service: TeacherStudentAssignmentsService) {}

  @Get()
  @RequirePermission('users.manageTeachers')
  list(@Query() q: ListTeacherStudentAssignmentsDto) {
    return this.service.list(q);
  }

  /**
   * Assign up to 200 students to one Teacher, in one transaction. Per student: ASSIGNED, REACTIVATED, SKIPPED
   * (ALREADY_ASSIGNED) or FAILED (NOT_A_STUDENT, NOT_FOUND, REASON_REQUIRED — a student outside the teacher's
   * verified schools needs a reason). The teacher gets one notice; students are never notified.
   */
  @Post()
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  assign(@Body() body: AssignTeacherStudentsDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(body, user);
  }

  /** Move students from one Teacher to another (each student: old ends and new starts together, or nothing changes). */
  @Post('reassign')
  @HttpCode(200)
  @RequirePermission('users.manageTeachers')
  reassign(@Body() body: ReassignTeacherStudentsDto, @CurrentUser() user: AuthUser) {
    return this.service.reassign(body, user);
  }

  /** End an assignment (kept as history; 409 ASSIGNMENT_ENDED). Selected-student delegations that depended on it are flagged. */
  @Delete(':id')
  @RequirePermission('users.manageTeachers')
  end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.end(id, user);
  }
}

/** School Access: a school's teachers, students and access in one place (Administrators: users.manageTeachers). */
@ApiTags('Admin · Teachers')
@ApiBearerAuth()
@Controller('admin/schools')
export class SchoolAccessController {
  constructor(private readonly service: TeacherStudentAssignmentsService) {}

  /** The school's teachers with their delegations and assigned-student counts; student counts; what needs attention. */
  @Get(':id/access')
  @RequirePermission('users.manageTeachers')
  access(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.schoolAccess(id);
  }

  /** The school's students (verified or pending claim) with their assigned teachers. No contact details. */
  @Get(':id/access/students')
  @RequirePermission('users.manageTeachers')
  students(@Param('id', ParseUUIDPipe) id: string, @Query() q: SchoolAccessStudentsDto) {
    return this.service.schoolStudents(id, q);
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

  /** Teachers only: how many students you see (through your schools, through assignments) and how many of your schools' students are waiting for verification (a number only). */
  @Get('summary')
  @RequirePermission('students.viewScoped')
  @ApiExtension('x-served-roles', ['TEACHER'])
  summary(@CurrentUser() user: AuthUser) {
    return this.service.summary(user);
  }

  /** A student of your assigned schools, or assigned to you: profile and account status, no contact details. Needs the students.viewProfile delegation covering this student. */
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
