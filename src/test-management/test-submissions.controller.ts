import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import {
  CancelTestExtensionDto, CreateTestExtensionDto, ExtensionTargetsQueryDto, ListMyTestsQueryDto, ListTeacherTestStudentsQueryDto,
  ListTestExtensionsQueryDto, ListTestSubmissionsQueryDto, SubmitTestAnswerDto, UpdateTestExtensionDto,
} from './dto/submission.dto.js';
import { TestExtensionsService } from './test-extensions.service.js';
import { TestSubmissionsService } from './test-submissions.service.js';

/** One answer page per request (PDF or image incl. phone photos, at most 20 MB: FilePurpose TEST_ANSWER). */
const PAGE_UPLOAD = uploadOptions('TEST_ANSWER', 1);
const isDownload = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Test Management, Phase 2 — the student's own tests (capability testSubmissions; tests.submit: Students only).
 * Published tests of the student's division; the deadline shown includes any extension that applies to them.
 */
@ApiTags('Tests · Students')
@Controller('me/tests')
export class MyTestsController {
  constructor(private readonly submissions: TestSubmissionsService) {}

  /** My tests: ?window=UPCOMING|OPEN|CLOSED; each with my deadline, window, submission summary and canSubmit. Paginated. */
  @Get()
  @RequirePermission('tests.submit')
  list(@Query() q: ListMyTestsQueryDto, @CurrentUser() user: AuthUser) {
    return this.submissions.listMine(user, q);
  }

  /** The test (questions once open), my deadline, my submission with every version. 404 TEST_NOT_FOUND (draft, other division). */
  @Get(':id')
  @RequirePermission('tests.submit')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissions.getMine(user, id);
  }

  /** The test paper (neutral name), once the test opened. 409 TEST_NOT_OPEN; 404 TEST_FILE_NOT_FOUND. */
  @Get(':id/paper')
  @RequirePermission('tests.submit')
  async paper(@Param('id', ParseUUIDPipe) id: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.submissions.sendPaper(this.submissions.studentCaller(user), id, res, isDownload(download));
  }

  /** Pages uploaded under :uploadKey and not yet submitted. */
  @Get(':id/uploads/:uploadKey')
  @RequirePermission('tests.submit')
  pending(@Param('id', ParseUUIDPipe) id: string, @Param('uploadKey', ParseUUIDPipe) key: string, @CurrentUser() user: AuthUser) {
    return this.submissions.pendingPages(this.submissions.studentCaller(user), id, user.id, key);
  }

  /**
   * Upload ONE page (multipart field `file`; PDF or image, 20 MB) as page :page of the upload :uploadKey; the same page
   * again replaces it. 400 UPLOAD_NOT_ALLOWED (typed-only test), TOO_MANY_PAGES; 409 DEADLINE_PASSED, TEST_NOT_OPEN,
   * UPLOAD_ALREADY_SUBMITTED; 415 FILE_TYPE_NOT_ALLOWED.
   */
  @Post(':id/uploads/:uploadKey/pages/:page')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', PAGE_UPLOAD))
  @RequirePermission('tests.submit')
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadKey', ParseUUIDPipe) key: string,
    @Param('page', ParseIntPipe) page: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.uploadPage(this.submissions.studentCaller(user), id, user.id, key, page, file);
  }

  /** Remove a pending page. 404 PAGE_NOT_FOUND (also for a submitted page: those never change). */
  @Delete(':id/uploads/:uploadKey/pages/:page')
  @RequirePermission('tests.submit')
  removePage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadKey', ParseUUIDPipe) key: string,
    @Param('page', ParseIntPipe) page: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.removePendingPage(this.submissions.studentCaller(user), id, user.id, key, page);
  }

  /**
   * Submit (first time) or replace (a new version; every version is kept): { clientKey, typedAnswer?, pageCount? }.
   * The same clientKey again returns the same version (replayed: true). 400 TYPED_ANSWER_REQUIRED, PAGES_REQUIRED,
   * TYPED_ANSWER_NOT_ALLOWED, UPLOAD_NOT_ALLOWED, ANSWER_REQUIRED; 409 DEADLINE_PASSED, PAGES_INCOMPLETE, TEST_NOT_OPEN.
   */
  @Post(':id/submission')
  @RequirePermission('tests.submit')
  submit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitTestAnswerDto, @CurrentUser() user: AuthUser) {
    return this.submissions.submit(this.submissions.studentCaller(user), id, user.id, dto);
  }

  /** A page of one of my versions (page-3.jpg …). */
  @Get(':id/versions/:versionId/pages/:page')
  @RequirePermission('tests.submit')
  async page(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Param('page', ParseIntPipe) page: number,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissions.sendAnswererPage(this.submissions.studentCaller(user), id, user.id, versionId, page, res, isDownload(download));
  }
}

/**
 * Test Management, Phase 2 — a teacher submits for their students (G2: any teacher of the school, primary or secondary;
 * tests.submitForStudents, Teachers by default): only VERIFIED students of the teacher's own schools whose account is
 * active — another student: 403 STUDENT_NOT_IN_SCOPE. The deadline is the student's, or the teacher's own extension when
 * later. The course-assignment delegation submissions.submitOnBehalf is unchanged.
 */
@ApiTags('Tests · Teachers')
@Controller('teacher/tests')
export class TeacherTestsController {
  constructor(private readonly submissions: TestSubmissionsService) {}

  /** Published tests (?window), each with my general deadline, how many of my students may answer and have submitted. */
  @Get()
  @RequirePermission('tests.submitForStudents')
  list(@Query() q: ListMyTestsQueryDto, @CurrentUser() user: AuthUser) {
    return this.submissions.listForTeacher(user, q);
  }

  /** The test paper (neutral name), once the test opened. */
  @Get(':id/paper')
  @RequirePermission('tests.submitForStudents')
  async paper(@Param('id', ParseUUIDPipe) id: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.submissions.sendPaper(await this.submissions.teacherCaller(user), id, res, isDownload(download));
  }

  /** My students for this test (?status, ?schoolId, ?q): deadline, state, submission; with counts. Paginated. */
  @Get(':id/students')
  @RequirePermission('tests.submitForStudents')
  students(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListTeacherTestStudentsQueryDto, @CurrentUser() user: AuthUser) {
    return this.submissions.teacherTestStudents(user, id, q);
  }

  /** One of my students for this test: the test, the deadline when I submit, the submission's versions. */
  @Get(':id/students/:studentId')
  @RequirePermission('tests.submitForStudents')
  student(@Param('id', ParseUUIDPipe) id: string, @Param('studentId', ParseUUIDPipe) studentId: string, @CurrentUser() user: AuthUser) {
    return this.submissions.teacherTestStudent(user, id, studentId);
  }

  /** Pages I uploaded under :uploadKey for this student and not yet submitted. */
  @Get(':id/students/:studentId/uploads/:uploadKey')
  @RequirePermission('tests.submitForStudents')
  async pending(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('uploadKey', ParseUUIDPipe) key: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.pendingPages(await this.submissions.teacherCaller(user), id, studentId, key);
  }

  /** Upload ONE page for the student (same rules as the student's own upload). */
  @Post(':id/students/:studentId/uploads/:uploadKey/pages/:page')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', PAGE_UPLOAD))
  @RequirePermission('tests.submitForStudents')
  async upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('uploadKey', ParseUUIDPipe) key: string,
    @Param('page', ParseIntPipe) page: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.uploadPage(await this.submissions.teacherCaller(user), id, studentId, key, page, file);
  }

  /** Remove a pending page I uploaded. */
  @Delete(':id/students/:studentId/uploads/:uploadKey/pages/:page')
  @RequirePermission('tests.submitForStudents')
  async removePage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('uploadKey', ParseUUIDPipe) key: string,
    @Param('page', ParseIntPipe) page: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.removePendingPage(await this.submissions.teacherCaller(user), id, studentId, key, page);
  }

  /** Submit or replace for the student: { clientKey, typedAnswer?, pageCount? } (same rules and idempotency). */
  @Post(':id/students/:studentId/submission')
  @RequirePermission('tests.submitForStudents')
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Body() dto: SubmitTestAnswerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.submit(await this.submissions.teacherCaller(user), id, studentId, dto);
  }

  /** A page of one of the student's versions (page-3.jpg …). */
  @Get(':id/students/:studentId/versions/:versionId/pages/:page')
  @RequirePermission('tests.submitForStudents')
  async page(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Param('page', ParseIntPipe) page: number,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissions.sendAnswererPage(await this.submissions.teacherCaller(user), id, studentId, versionId, page, res, isDownload(download));
  }
}

/**
 * Test Management, Phase 2 — submission tracking and every version (tests.viewSubmissions): Administrators in every
 * subject, Head Coaches in the subjects they head (403 SCOPE_FORBIDDEN otherwise). Identity, submitter, teacher and
 * extension status are shown here (never to markers).
 */
@ApiTags('Admin · Tests')
@Controller('admin/tests/:id/submissions')
export class AdminTestSubmissionsController {
  constructor(private readonly submissions: TestSubmissionsService) {}

  /** Tracking: ?status=SUBMITTED|NOT_SUBMITTED|LATE_BLOCKED|UNDER_EXTENSION, ?schoolId, ?division, ?q; counts. Paginated. */
  @Get()
  @RequirePermission('tests.viewSubmissions')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListTestSubmissionsQueryDto, @CurrentUser() user: AuthUser) {
    return this.submissions.track(id, q, user);
  }

  /** One submission: every version (submitter, teacher, time, applicable deadline, under extension, pages), status history. */
  @Get(':submissionId')
  @RequirePermission('tests.viewSubmissions')
  get(@Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string, @CurrentUser() user: AuthUser) {
    return this.submissions.staffDetail(id, submissionId, user);
  }

  /** A page of a version (page-3.jpg …). */
  @Get(':submissionId/versions/:versionId/pages/:page')
  @RequirePermission('tests.viewSubmissions')
  async page(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Param('page', ParseIntPipe) page: number,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissions.sendStaffPage(id, submissionId, versionId, page, user, res, isDownload(download));
  }
}

/**
 * Test Management, Phase 2 — deadline extensions (tests.extensions): Administrators in every subject, Head Coaches in the
 * subjects they head. Whole test, one student, or one teacher; mandatory reasons; edit / cancel before expiry; audited.
 */
@ApiTags('Admin · Tests')
@Controller('admin/tests/:id')
export class AdminTestExtensionsController {
  constructor(private readonly extensions: TestExtensionsService) {}

  /** The test's extensions: ?state=active (default) | cancelled | all, ?kind. Paginated. */
  @Get('extensions')
  @RequirePermission('tests.extensions')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListTestExtensionsQueryDto, @CurrentUser() user: AuthUser) {
    return this.extensions.list(id, q, user);
  }

  /** Students (of the test's division) or teachers an individual extension can name: ?kind=STUDENT|TEACHER, ?q. */
  @Get('extension-targets')
  @RequirePermission('tests.extensions')
  targets(@Param('id', ParseUUIDPipe) id: string, @Query() q: ExtensionTargetsQueryDto, @CurrentUser() user: AuthUser) {
    return this.extensions.targets(id, q, user);
  }

  /**
   * Grant { kind, studentId? | teacherId?, newDeadline, reason }. 400 EXTENSION_NOT_LATER, EXTENSION_IN_PAST,
   * EXTENSION_TARGET_REQUIRED, STUDENT_NOT_IN_DIVISION; 404 STUDENT_NOT_FOUND, TEACHER_NOT_FOUND; 409 EXTENSION_ALREADY_ACTIVE.
   */
  @Post('extensions')
  @RequirePermission('tests.extensions')
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTestExtensionDto, @CurrentUser() user: AuthUser) {
    return this.extensions.create(id, dto, user);
  }

  /** Change { newDeadline?, reason } before it expires. 409 EXTENSION_CANCELLED, EXTENSION_EXPIRED. */
  @Patch('extensions/:extensionId')
  @RequirePermission('tests.extensions')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('extensionId', ParseUUIDPipe) extensionId: string,
    @Body() dto: UpdateTestExtensionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.extensions.update(id, extensionId, dto, user);
  }

  /** Cancel { reason } before it expires. 409 EXTENSION_CANCELLED, EXTENSION_EXPIRED. */
  @Post('extensions/:extensionId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.extensions')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('extensionId', ParseUUIDPipe) extensionId: string,
    @Body() dto: CancelTestExtensionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.extensions.cancel(id, extensionId, dto, user);
  }
}
