import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Patch, PipeTransform, Post, Put, Query, Res,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import { FILE_RULES } from '../common/storage/file-rules.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import {
  CreateTestDto, GrantMarkerDto, ListMarkersQueryDto, ListTestsQueryDto, MarkerCandidatesQueryDto, ReorderTestQuestionsDto,
  RevokeMarkerDto, TEST_FILE_KINDS, TestQuestionInputDto, UpdateTestDto, UpdateTestQuestionDto, type TestFileKindParam,
} from './dto/test.dto.js';
import { TestMarkersService } from './test-markers.service.js';
import { TestsService } from './tests.service.js';

/** `paper` or `marking-guide` in the path; anything else is 404 TEST_FILE_NOT_FOUND. */
@Injectable()
export class TestFileKindPipe implements PipeTransform<string, TestFileKindParam> {
  transform(value: string): TestFileKindParam {
    if (!(TEST_FILE_KINDS as readonly string[]).includes(value)) {
      throw new AppError(HttpStatus.NOT_FOUND, 'TEST_FILE_NOT_FOUND', 'Unknown test file: use "paper" or "marking-guide".');
    }
    return value as TestFileKindParam;
  }
}

// The paper and the marking guide share one rule (PDF and images, 20 MB; file-rules.ts); StorageService.store applies the
// exact rule of each purpose, multer only caps the size.
const TEST_FILE_UPLOAD = uploadOptions(
  FILE_RULES.TEST_PAPER.maxBytes >= FILE_RULES.MARKING_GUIDE.maxBytes ? 'TEST_PAPER' : 'MARKING_GUIDE', 1);

/**
 * Test Management (WS3, Phase 1; capability `testManagement`). Administrators: every subject; Head Coaches: only the
 * subjects they head (403 SCOPE_FORBIDDEN otherwise). Coaches, Teachers and Students: 403 PERMISSION_REQUIRED. Every
 * change is audited (TESTS).
 */
@ApiTags('Admin · Tests')
@Controller('admin/tests')
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  /** The subjects the caller manages tests in: { id, code, name }[] (Administrators: every active subject). */
  @Get('subjects')
  @RequirePermission('tests.view')
  subjects(@CurrentUser() user: AuthUser) {
    return this.tests.subjects(user);
  }

  /** Tests, newest window first. Filters: subjectId, division, status, q (title). Paginated. */
  @Get()
  @RequirePermission('tests.view')
  list(@Query() q: ListTestsQueryDto, @CurrentUser() user: AuthUser) {
    return this.tests.list(q, user);
  }

  /**
   * Create a DRAFT test: { title, subjectId, division, answerFormat, opensAt, closesAt, maxMarks, questions? }.
   * 400 INVALID_TEST_WINDOW, QUESTION_MARKS_EXCEED_TOTAL, SUBJECT_NOT_FOUND; 403 SCOPE_FORBIDDEN.
   */
  @Post()
  @RequirePermission('tests.manage')
  create(@Body() dto: CreateTestDto, @CurrentUser() user: AuthUser) {
    return this.tests.create(dto, user);
  }

  /** A test with its questions (in order), totals and files (neutral names; the marking guide only to who may read it). */
  @Get(':id')
  @RequirePermission('tests.view')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.tests.get(id, user);
  }

  /** Change any detail. 400 NO_CHANGES, INVALID_TEST_WINDOW, TEST_MAX_MARKS_BELOW_QUESTIONS; 409 QUESTION_MARKS_MISMATCH, TEST_PUBLISHED. */
  @Patch(':id')
  @RequirePermission('tests.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTestDto, @CurrentUser() user: AuthUser) {
    return this.tests.update(id, dto, user);
  }

  /** Delete a DRAFT test (409 TEST_PUBLISHED otherwise). 204. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('tests.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.tests.remove(id, user);
  }

  /** DRAFT → PUBLISHED. 409 TEST_NOT_READY { problems: NO_PAPER_OR_QUESTIONS | QUESTION_MARKS_MISMATCH | ALREADY_CLOSED }. */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.manage')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.tests.publish(id, user);
  }

  /** PUBLISHED → DRAFT. 409 TEST_NOT_PUBLISHED. */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.manage')
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.tests.unpublish(id, user);
  }

  /** Append a question { prompt, maxMarks }. 400 QUESTION_MARKS_EXCEED_TOTAL; 409 QUESTION_MARKS_MISMATCH (published). */
  @Post(':id/questions')
  @RequirePermission('tests.manage')
  addQuestion(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TestQuestionInputDto, @CurrentUser() user: AuthUser) {
    return this.tests.addQuestion(id, dto, user);
  }

  /** Every question id once, in the new order. 400 QUESTION_ORDER_MISMATCH. */
  @Put(':id/questions/order')
  @RequirePermission('tests.manage')
  reorderQuestions(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderTestQuestionsDto, @CurrentUser() user: AuthUser) {
    return this.tests.reorderQuestions(id, dto, user);
  }

  /** Change a question's prompt or marks (same sum rule). 404 QUESTION_NOT_FOUND. */
  @Patch(':id/questions/:questionId')
  @RequirePermission('tests.manage')
  updateQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() dto: UpdateTestQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tests.updateQuestion(id, questionId, dto, user);
  }

  /** Remove a question; the others are renumbered. */
  @Delete(':id/questions/:questionId')
  @RequirePermission('tests.manage')
  removeQuestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tests.removeQuestion(id, questionId, user);
  }

  /**
   * Upload or replace the paper or the marking guide (multipart field `file`: PDF or image incl. phone photos, at most
   * 20 MB). 400 FILE_REQUIRED / EMPTY_FILE, 413, 415 FILE_TYPE_NOT_ALLOWED. Private storage.
   */
  @Put(':id/files/:kind')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', TEST_FILE_UPLOAD))
  @RequirePermission('tests.manage')
  putFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', TestFileKindPipe) kind: TestFileKindParam,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
    @Query('correctionReason') correctionReason?: string,
  ) {
    return this.tests.putFile(id, kind, file, user, correctionReason);
  }

  /** Remove the paper or the marking guide. 404 TEST_FILE_NOT_FOUND. */
  @Delete(':id/files/:kind')
  @RequirePermission('tests.manage')
  removeFile(@Param('id', ParseUUIDPipe) id: string, @Param('kind', TestFileKindPipe) kind: TestFileKindParam, @CurrentUser() user: AuthUser) {
    return this.tests.removeFile(id, kind, user);
  }

  /** The file's bytes under a neutral name (test-paper.pdf, marking-guide.pdf …); ?download=1 forces a download. */
  @Get(':id/files/:kind')
  @RequirePermission('tests.view')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', TestFileKindPipe) kind: TestFileKindParam,
    @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.tests.sendFile(id, kind, user, res, download === '1' || download === 'true');
  }
}

/**
 * Coaches authorised to mark a subject's tests (Phase 3 uses them). Administrators: every subject; Head Coaches: the
 * subjects they head, and only coaches who are members of that subject. An interest never grants marking.
 */
@ApiTags('Admin · Tests')
@Controller('admin/test-markers')
export class TestMarkersController {
  constructor(private readonly markers: TestMarkersService) {}

  /** Authorisations: ?subjectId, ?state=active (default) | revoked | all. Paginated. */
  @Get()
  @RequirePermission('tests.manageMarkers')
  list(@Query() q: ListMarkersQueryDto, @CurrentUser() user: AuthUser) {
    return this.markers.list(q, user);
  }

  /** Coaches who can be authorised for ?subjectId (search ?q), with authorizationId when already authorised. */
  @Get('candidates')
  @RequirePermission('tests.manageMarkers')
  candidates(@Query() q: MarkerCandidatesQueryDto, @CurrentUser() user: AuthUser) {
    return this.markers.candidates(q, user);
  }

  /** Authorise { coachId, subjectId, reason? }. 400 NOT_A_COACH; 409 MARKER_ALREADY_AUTHORIZED, ACCOUNT_NOT_ACTIVE. */
  @Post()
  @RequirePermission('tests.manageMarkers')
  grant(@Body() dto: GrantMarkerDto, @CurrentUser() user: AuthUser) {
    return this.markers.grant(dto, user);
  }

  /** Revoke { reason } (mandatory). 409 MARKER_AUTHORIZATION_REVOKED. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.manageMarkers')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevokeMarkerDto, @CurrentUser() user: AuthUser) {
    return this.markers.revoke(id, dto, user);
  }
}
