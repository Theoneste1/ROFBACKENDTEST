import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import {
  ApproveMarkingDto, AssignMarkingDto, ChooseMarkDto, DistributeMarkingDto, ListMarkingSubmissionsQueryDto, MarkingHistoryQueryDto,
  MarkingQueueQueryDto, ReassignMarkingDto, RequestSecondMarkingDto, ReturnMarkingDto, SaveMarkingDto, SubmitMarkingDto, UnlockMarkingDto,
} from './dto/marking.dto.js';
import { TestMarkerService } from './test-marker.service.js';
import { TestMarkingService } from './test-marking.service.js';

const isDownload = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Test Management, Phase 3 — distribution and review (capability testMarking). Administrators: every subject; Head
 * Coaches: the subjects they head (403 SCOPE_FORBIDDEN otherwise). Distribution: tests.distribute; review: tests.review;
 * choosing the first / second / adjusted mark: tests.adjustMarks — the subject's Head Coach only (G4: Administrators
 * never edit or adjust marks; the permission guard refuses them). Every decision is audited (TESTS).
 */
@ApiTags('Admin · Test marking')
@Controller('admin/tests/:id/marking')
export class AdminTestMarkingController {
  constructor(private readonly marking: TestMarkingService) {}

  /** Submissions by status, how many may be distributed now / wait for their deadline (G5), each coach's progress. */
  @Get()
  @RequirePermission('tests.distribute')
  overview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.marking.overview(id, user);
  }

  /**
   * Share every unassigned, markable submission evenly between these authorised coaches: { coachIds, clientKey? }.
   * 400 COACH_NOT_AUTHORIZED (with each coach's problem). Submissions still within a deadline wait (waitingForDeadline).
   */
  @Post('distribute')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.distribute')
  distribute(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DistributeMarkingDto, @CurrentUser() user: AuthUser) {
    return this.marking.distribute(id, dto, user);
  }

  /**
   * Give named submissions to one authorised coach: { submissionIds, coachId, reason? }. Already theirs: no change.
   * 400 COACH_NOT_AUTHORIZED; 404 SUBMISSION_NOT_FOUND; 409 ALREADY_ASSIGNED, NOT_YET_MARKABLE (G5), INVALID_STATUS_TRANSITION.
   */
  @Post('assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.distribute')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignMarkingDto, @CurrentUser() user: AuthUser) {
    return this.marking.assign(id, dto, user);
  }

  /** Submissions with identity, status, markers and marks. Filters: status, coachId, q (name, username, code). Paginated. */
  @Get('submissions')
  @RequirePermission('tests.review')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListMarkingSubmissionsQueryDto, @CurrentUser() user: AuthUser) {
    return this.marking.list(id, q, user);
  }

  /** One submission: identity, answer, every marking side by side, assignments, reviews, status history, mark changes. */
  @Get('submissions/:submissionId')
  @RequirePermission('tests.review')
  get(@Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string, @CurrentUser() user: AuthUser) {
    return this.marking.detail(id, submissionId, user);
  }

  /**
   * Another authorised coach takes over a FIRST (default) or SECOND marking not yet submitted: { coachId, reason, kind? }.
   * 409 NOT_ASSIGNED, MARKING_ALREADY_SUBMITTED, SAME_COACH, SAME_MARKER, INVALID_STATUS_TRANSITION; 400 COACH_NOT_AUTHORIZED.
   */
  @Post('submissions/:submissionId/reassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.distribute')
  reassign(
    @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: ReassignMarkingDto, @CurrentUser() user: AuthUser,
  ) {
    return this.marking.reassign(id, submissionId, dto, user);
  }

  /** Approve (locks the result). 409 INVALID_STATUS_TRANSITION (not MARKED — e.g. already approved by someone else), MARK_CHOICE_REQUIRED, SUBMISSION_CHANGED. */
  @Post('submissions/:submissionId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  approve(
    @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: ApproveMarkingDto, @CurrentUser() user: AuthUser,
  ) {
    return this.marking.approve(id, submissionId, dto, user);
  }

  /** Return a marking for correction: { comment (mandatory), kind? }. 400 KIND_REQUIRED; 409 INVALID_STATUS_TRANSITION, NOTHING_TO_RETURN. */
  @Post('submissions/:submissionId/return')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  returnForCorrection(
    @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: ReturnMarkingDto, @CurrentUser() user: AuthUser,
  ) {
    return this.marking.returnForCorrection(id, submissionId, dto, user);
  }

  /** Request an independent, blind second marking: { coachId, reason? }. 409 SECOND_MARKING_EXISTS, SAME_MARKER; 400 COACH_NOT_AUTHORIZED. */
  @Post('submissions/:submissionId/second-marking')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  secondMarking(
    @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: RequestSecondMarkingDto, @CurrentUser() user: AuthUser,
  ) {
    return this.marking.requestSecondMarking(id, submissionId, dto, user);
  }

  /**
   * The subject's Head Coach chooses the mark that counts: { source: FIRST | SECOND | ADJUSTMENT, reason, marks? }
   * (ADJUSTMENT: the complete adjusted marks). Administrators: 403 (G4). 409 MARKING_NOT_AVAILABLE; 400 MARKS_*.
   */
  @Post('submissions/:submissionId/choose')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.adjustMarks')
  choose(
    @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: ChooseMarkDto, @CurrentUser() user: AuthUser,
  ) {
    return this.marking.choose(id, submissionId, dto, user);
  }

  /** Unlock an approved result: { reason (mandatory) }. 409 INVALID_STATUS_TRANSITION. */
  @Post('submissions/:submissionId/unlock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.review')
  unlock(
    @Param('id', ParseUUIDPipe) id: string, @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() dto: UnlockMarkingDto, @CurrentUser() user: AuthUser,
  ) {
    return this.marking.unlock(id, submissionId, dto, user);
  }

  /** The test's marking history: ?type=status (default) | marks (the mark-change log) | reviews; ?submissionId. Paginated, newest first. */
  @Get('history')
  @RequirePermission('tests.review')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() q: MarkingHistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.marking.history(id, q, user);
  }
}

/**
 * Test Management, Phase 3 — BLIND marking (tests.mark: Coaches). Only submissions currently assigned to the coach, in
 * subjects the coach is still authorised for — both checked on every request (403 MARKING_NOT_ASSIGNED,
 * MARKER_NOT_AUTHORIZED). Responses carry the opaque submission code, never the student's identity; files have neutral
 * names (page-1.jpg, test-paper.pdf, marking-guide.pdf).
 */
@ApiTags('Tests · Marking')
@Controller('marking')
export class MarkingController {
  constructor(private readonly marker: TestMarkerService) {}

  /** My marking queue: ?state=NOT_STARTED|IN_PROGRESS|MARKED, ?testId; counts and progress per test. Paginated. */
  @Get('queue')
  @RequirePermission('tests.mark')
  queue(@Query() q: MarkingQueueQueryDto, @CurrentUser() user: AuthUser) {
    return this.marker.queue(user, q);
  }

  /** One assigned submission by its code: the test, questions, the answer (pages under neutral names) and my marking. */
  @Get('submissions/:code')
  @RequirePermission('tests.mark')
  get(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    return this.marker.get(user, code);
  }

  /** A page of the answer (page-N.ext; ?download=1 to save it). */
  @Get('submissions/:code/pages/:page')
  @RequirePermission('tests.mark')
  async page(
    @Param('code') code: string, @Param('page', ParseIntPipe) page: number, @Query('download') download: string | undefined,
    @CurrentUser() user: AuthUser, @Res() res: Response,
  ) {
    await this.marker.sendPage(user, code, page, res, isDownload(download));
  }

  /** The test paper (test-paper.ext). */
  @Get('submissions/:code/paper')
  @RequirePermission('tests.mark')
  async paper(@Param('code') code: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.marker.sendTestFile(user, code, 'PAPER', res, isDownload(download));
  }

  /** The marking guide (marking-guide.ext): the assigned marker may read it. */
  @Get('submissions/:code/marking-guide')
  @RequirePermission('tests.mark')
  async guide(@Param('code') code: string, @Query('download') download: string | undefined, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.marker.sendTestFile(user, code, 'MARKING_GUIDE', res, isDownload(download));
  }

  /**
   * Save my draft: { scores?: [{ questionId, marks?, comment? }], totalMarks?, comment?, expectedRevision? } — whole marks,
   * never above the maxima. 400 MARKS_*, QUESTION_NOT_IN_TEST, TOTAL_NOT_ALLOWED, SCORES_NOT_ALLOWED; 409 MARKING_SUBMITTED,
   * MARKING_CHANGED, INVALID_STATUS_TRANSITION.
   */
  @Put('submissions/:code/marking')
  @RequirePermission('tests.mark')
  save(@Param('code') code: string, @Body() dto: SaveMarkingDto, @CurrentUser() user: AuthUser) {
    return this.marker.save(user, code, dto);
  }

  /** Submit my marking for approval (every question marked, or the total). 400 MARKS_INCOMPLETE; 409 MARKING_SUBMITTED. */
  @Post('submissions/:code/marking/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.mark')
  submit(@Param('code') code: string, @Body() dto: SubmitMarkingDto, @CurrentUser() user: AuthUser) {
    return this.marker.submit(user, code, dto);
  }
}
