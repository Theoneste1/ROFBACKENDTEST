import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../../common/auth-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import {
  AssignQuestionTaskDto, DecideQuestionDto, MarkingModeDto, QuestionHistoryQueryDto, QuestionMarkersDto, QuestionMarksDto,
  QuestionQueueQueryDto, QuestionReviewDto, QuestionTasksQueryDto, ReasonDto, ReopenQuestionDto, ReturnQuestionDto,
  SecondAssessmentDto, StructureCorrectionDto, WordingCorrectionDto,
} from './question-marking.dto.js';
import { QuestionMarkerService } from './question-marker.service.js';
import { QuestionMarkingService } from './question-marking.service.js';

const isDownload = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Question-level marking — COACHES (tests.mark), design Rev 5.2 (capability questionMarking; QUESTION_MARKING_ENABLED).
 * A shared pool per question: a coach authorised for a question claims one student's answer to it (blind: paper code +
 * question number, `q2`; a second assessment `q2-s1`). One holder per task; different questions of the same paper can
 * be held by different coaches at once. Every write is checked against the caller's CURRENT claim (409 CLAIM_LOST with
 * its reason) and authorisation.
 */
@ApiTags('Tests · Question marking')
@Controller('marking/tasks')
export class QuestionMarkingController {
  constructor(private readonly marker: QuestionMarkerService) {}

  /** My queue: ?view=TO_MARK|MINE|RETURNED|SUBMITTED|ALL, ?testId, ?question; counts per view; others' as "TAKEN". */
  @Get()
  @RequirePermission('tests.mark')
  queue(@Query() q: QuestionQueueQueryDto, @CurrentUser() user: AuthUser) {
    return this.marker.queue(user, q);
  }

  /** Claim (atomic): 409 TASK_TAKEN, CLAIM_LIMIT, TASK_NOT_AVAILABLE, RESUBMISSION_PENDING; 403 QUESTION_NOT_ASSIGNED, MARKER_NOT_AUTHORIZED, FIRST_MARKER_EXCLUDED. */
  @Post(':code/:ref/claim')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.mark')
  claim(@Param('code') code: string, @Param('ref') ref: string, @CurrentUser() user: AuthUser) {
    return this.marker.claim(user, code, ref);
  }

  /** The task: question, maximum, MY assessment, return reason, the answer's pages (neutral names). */
  @Get(':code/:ref')
  @RequirePermission('tests.mark')
  detail(@Param('code') code: string, @Param('ref') ref: string, @CurrentUser() user: AuthUser) {
    return this.marker.detail(user, code, ref);
  }

  /** One answer page (page-N.ext; identifying metadata removed). Logged once per claim and page. */
  @Get(':code/:ref/pages/:page')
  @RequirePermission('tests.mark')
  async page(@Param('code') code: string, @Param('ref') ref: string, @Param('page', ParseIntPipe) page: number, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.marker.sendPage(user, code, ref, page, res, isDownload(download));
  }

  /** The test's question paper. */
  @Get(':code/:ref/paper')
  @RequirePermission('tests.mark')
  async paper(@Param('code') code: string, @Param('ref') ref: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.marker.sendTestFile(user, code, ref, 'PAPER', res, isDownload(download));
  }

  /** The marking guide this assessment is made against (logged once per claim). */
  @Get(':code/:ref/marking-guide')
  @RequirePermission('tests.mark')
  async guide(@Param('code') code: string, @Param('ref') ref: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.marker.sendTestFile(user, code, ref, 'MARKING_GUIDE', res, isDownload(download));
  }

  /** Keep my claim alive (every 2 minutes while the workspace is visible). 409 CLAIM_LOST. */
  @Post(':code/:ref/heartbeat')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.mark')
  heartbeat(@Param('code') code: string, @Param('ref') ref: string, @CurrentUser() user: AuthUser) {
    return this.marker.heartbeat(user, code, ref);
  }

  /** Save my draft for this question: { marks, comment, expectedRevision }. 400 MARKS_INVALID; 409 MARKING_CHANGED, CLAIM_LOST. */
  @Put(':code/:ref/marks')
  @RequirePermission('tests.mark')
  marks(@Param('code') code: string, @Param('ref') ref: string, @Body() dto: QuestionMarksDto, @CurrentUser() user: AuthUser) {
    return this.marker.saveMarks(user, code, ref, dto);
  }

  /** Submit this question only (the given marks saved first). 400 MARKS_INCOMPLETE; 409 CLAIM_LOST. */
  @Post(':code/:ref/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.mark')
  submit(@Param('code') code: string, @Param('ref') ref: string, @Body() dto: QuestionMarksDto, @CurrentUser() user: AuthUser) {
    return this.marker.submit(user, code, ref, dto);
  }

  /** Give the task back (the draft is kept in the history for staff; the next claim starts empty). */
  @Post(':code/:ref/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.mark')
  release(@Param('code') code: string, @Param('ref') ref: string, @CurrentUser() user: AuthUser) {
    return this.marker.release(user, code, ref);
  }
}

/**
 * Question-level marking — STAFF: the subject's Head Coach, Administrators and Super Administrators (scope as for the
 * test). Reviews lock the paper (FOR UPDATE) and change a task only by a conditional transition (409 TASK_CHANGED to the
 * one who lost). Deciding after a second assessment: tests.adjustMarks — the subject's Head Coach only (G4).
 */
@ApiTags('Admin · Question marking')
@Controller('admin/tests/:id/question-marking')
export class AdminQuestionMarkingController {
  constructor(private readonly marking: QuestionMarkingService) {}

  /** The test's marking mode and whether it can still change. */
  @Get()
  @RequirePermission('tests.view')
  overview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.marking.overview(id, user);
  }

  /** PAPER ↔ QUESTION, only before any marking exists. 409 MARKING_STARTED, NO_QUESTIONS. */
  @Patch('mode')
  @RequirePermission('tests.manage')
  mode(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkingModeDto, @CurrentUser() user: AuthUser) {
    return this.marking.setMode(id, dto.mode, user);
  }

  /** Coaches per question, and the coaches who may mark the subject. */
  @Get('markers')
  @RequirePermission('tests.distribute')
  markers(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.marking.markers(id, user);
  }

  /** Authorise or remove coaches for one question (removal: reason; their open claims end, reserved returns need reassignment). */
  @Put('questions/:questionId/markers')
  @RequirePermission('tests.distribute')
  setMarkers(@Param('id', ParseUUIDPipe) id: string, @Param('questionId', ParseUUIDPipe) questionId: string, @Body() dto: QuestionMarkersDto, @CurrentUser() user: AuthUser) {
    return this.marking.setMarkers(id, questionId, dto, user);
  }

  /** Create the missing tasks of eligible papers (idempotent); reports skipped papers and why. */
  @Post('tasks/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.distribute')
  generate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.marking.generate(id, user);
  }

  @Get('tasks')
  @RequirePermission('tests.review')
  tasks(@Param('id', ParseUUIDPipe) id: string, @Query() q: QuestionTasksQueryDto, @CurrentUser() user: AuthUser) {
    return this.marking.listTasks(id, q, user);
  }

  /** One question of one paper: every round and cycle, assessments, versions, decisions, claims, events. */
  @Get('tasks/:taskId')
  @RequirePermission('tests.review')
  task(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @CurrentUser() user: AuthUser) {
    return this.marking.taskDetail(id, taskId, user);
  }

  /** Exceptional direct assignment (reason): the claim's checks and the same limit (409 CLAIM_LIMIT, no override). */
  @Post('tasks/:taskId/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.distribute')
  assign(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: AssignQuestionTaskDto, @CurrentUser() user: AuthUser) {
    return this.marking.assign(id, taskId, dto, user);
  }

  @Post('tasks/:taskId/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.distribute')
  release(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser) {
    return this.marking.release(id, taskId, dto, user);
  }

  @Post('tasks/:taskId/review-hold')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  hold(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @CurrentUser() user: AuthUser) {
    return this.marking.reviewHold(id, taskId, user);
  }

  @Post('tasks/:taskId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  approve(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: QuestionReviewDto, @CurrentUser() user: AuthUser) {
    return this.marking.approve(id, taskId, dto, user);
  }

  @Post('tasks/:taskId/return')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  returnTask(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReturnQuestionDto, @CurrentUser() user: AuthUser) {
    return this.marking.returnTask(id, taskId, dto, user);
  }

  @Post('tasks/:taskId/second-assessment')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  second(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: SecondAssessmentDto, @CurrentUser() user: AuthUser) {
    return this.marking.requestSecond(id, taskId, dto, user);
  }

  @Post('tasks/:taskId/cancel-second')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  cancelSecond(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReasonDto, @CurrentUser() user: AuthUser) {
    return this.marking.cancelSecond(id, taskId, dto, user);
  }

  /** FIRST, SECOND or ADJUSTED after a second assessment (reason): the subject's Head Coach only (G4). */
  @Post('tasks/:taskId/decide')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.adjustMarks')
  decide(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: DecideQuestionDto, @CurrentUser() user: AuthUser) {
    return this.marking.decide(id, taskId, dto, user);
  }

  /** An approved question back to RETURNED (to its marker) or SUBMITTED (re-review); withdraws a published result first. */
  @Post('tasks/:taskId/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  reopen(@Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReopenQuestionDto, @CurrentUser() user: AuthUser) {
    return this.marking.reopen(id, taskId, dto, user);
  }

  @Get('progress')
  @RequirePermission('tests.view')
  progress(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.marking.progress(id, user);
  }

  @Get('history')
  @RequirePermission('tests.review')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() q: QuestionHistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.marking.history(id, q, user);
  }

  /** An answer page with identity (staff); logged once per person, paper, page and Kigali day. */
  @Get('papers/:submissionId/pages/:page')
  @RequirePermission('tests.review')
  async page(@Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string, @Param('page', ParseIntPipe) page: number, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.marking.sendPage(id, submissionId, page, user, res, isDownload(download));
  }

  /** Super Admin: correct a question's wording after submissions (reason; the old wording is kept as history). */
  @Post('questions/:questionId/wording-correction')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.manage')
  wording(@Param('id', ParseUUIDPipe) id: string, @Param('questionId', ParseUUIDPipe) questionId: string, @Body() dto: WordingCorrectionDto, @CurrentUser() user: AuthUser) {
    return this.marking.correctWording(id, questionId, dto, user);
  }

  /** Super Admin: correct the question structure after submissions but before any marking (reason). */
  @Post('structure-correction')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.manage')
  structure(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StructureCorrectionDto, @CurrentUser() user: AuthUser) {
    return this.marking.correctStructure(id, dto, user);
  }
}
