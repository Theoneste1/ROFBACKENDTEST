import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { ResultsService } from './results.service.js';
import { SubmissionsService } from './submissions.service.js';
import { ListResultsDto } from './dto/list-results.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

/**
 * Students' published results and formal feedback. Read-only: results have no
 * comments or replies — questions go to the assignment's discussion threads.
 */
@ApiTags('Me')
@Controller('me/results')
export class MyResultsController {
  constructor(
    private readonly results:     ResultsService,
    private readonly submissions: SubmissionsService,
  ) {}

  /** Previously reviewed assignments (published results only), newest first. */
  @Get()
  @RequirePermission('submissions.viewOwn')
  list(@CurrentUser() user: AuthUser, @Query() query: ListResultsDto) {
    return this.results.listMine(user, query);
  }

  /** Assignment, submission, score, mentor feedback, feedback files, review and publication dates. */
  @Get(':submissionId')
  @RequirePermission('submissions.viewOwn')
  get(@Param('submissionId', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.results.getMine(id, user);
  }

  /** Download a feedback attachment of a published result. */
  @Get(':submissionId/feedback-files/:attachmentId')
  @RequirePermission('submissions.viewOwn')
  async feedbackFile(
    @Param('submissionId', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissions.serveFeedbackFile(id, user, res, attachmentId);
  }
}

@ApiTags('Submissions')
@Controller('submissions')
export class ResultHistoryController {
  constructor(private readonly results: ResultsService) {}

  /** Every publication of this result: score, reviewer, who published it and when, withdrawals. */
  @Get(':id/result-history')
  @RequirePermission('results.approve')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.results.publicationHistory(id);
  }
}
