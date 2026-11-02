import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
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

import { SubmissionsService } from './submissions.service.js';
import { CreateSubmissionDto } from './dto/create-submission.dto.js';
import { AssignSubmissionDto, DistributeSubmissionsDto } from './dto/assign-submission.dto.js';
import { MarkSubmissionDto } from './dto/mark-submission.dto.js';
import { ApproveResultDto, RejectResultDto } from './dto/review-result.dto.js';
import { ReopenResultDto } from './dto/correct-result.dto.js';
import { ListSubmissionsDto } from './dto/list-submissions.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import type { AuthUser } from '../common/auth-user.js';

/**
 * Submission and review workflow.
 *
 * Static routes are declared before `:id` routes so that paths such as
 * `/submissions/my` are never captured as an id.
 */
@ApiTags('Submissions')
@Controller('submissions')
export class SubmissionsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3 — Student submits / resubmits
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Submit or resubmit (multipart/form-data: `assignmentId`, optional `note`,
   * file in field `file`). Deadline and resubmission rules apply.
   */
  @Post()
  @Roles('STUDENT')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions('SUBMISSION')))
  submit(
    @Body() body: CreateSubmissionDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.submit(body, user, file);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — list
  // ═══════════════════════════════════════════════════════════════════════════

  @Get()
  @Roles('ADMIN')
  findAll(@Query() query: ListSubmissionsDto) {
    return this.submissionsService.findAll(query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Any role — single submission (projected for the caller)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Students: own only. Mentors: assigned to them. Admins: any. */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.findOne(id, user);
  }

  /** Latest submitted file. */
  @Get(':id/file')
  async file(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.submissionsService.serveSubmissionFile(id, user, res);
  }

  /** File of a specific revision (1 = first submission). */
  @Get(':id/revisions/:revisionNumber/file')
  async revisionFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNumber', ParseIntPipe) revisionNumber: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissionsService.serveSubmissionFile(id, user, res, revisionNumber);
  }

  /** Mentor feedback attachment (students: only after publication). */
  @Get(':id/feedback-file')
  async feedbackFile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.submissionsService.serveFeedbackFile(id, user, res);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4 — Admin distributes
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch(':id/assign')
  @Roles('ADMIN')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.assign(id, body, user);
  }

  @Patch(':id/reassign')
  @Roles('ADMIN')
  reassign(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reassign(id, body, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5 — Mentor reviews (MENTOR only: administrators do not grade)
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch(':id/start-review')
  @Roles('MENTOR')
  startReview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.startReview(id, user);
  }

  /** Score + formal feedback; optional attachment in field `feedbackFile`. */
  @Patch(':id/mark')
  @Roles('MENTOR')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('feedbackFile', uploadOptions('FEEDBACK')))
  mark(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkSubmissionDto,
    @UploadedFile() feedbackFile: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.mark(id, body, user, feedbackFile);
  }

  /** Return the completed review to the administrators. */
  @Patch(':id/submit-to-admin')
  @Roles('MENTOR')
  submitToAdmin(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.submitToAdmin(id, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6–7 — Admin coordinates results
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch(':id/approve')
  @Roles('ADMIN')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveResultDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.approve(id, body, user);
  }

  /** Send the review back to the mentor with a reason. */
  @Patch(':id/reject')
  @Roles('ADMIN')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectResultDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reject(id, body, user);
  }

  /** Publish one approved result to the student. */
  @Patch(':id/publish')
  @Roles('ADMIN')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.publish(id, user);
  }

  /** Correct a published result by returning it to the mentor (replaces the old score-correction endpoint). */
  @Patch(':id/reopen')
  @Roles('ADMIN')
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReopenResultDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reopen(id, body, user);
  }
}

@ApiTags('Submissions')
@Controller('assignments/:assignmentId')
@Roles('ADMIN')
export class AssignmentResultsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Spread all unassigned submissions across the mentors of this course × division. */
  @Post('distribute')
  @HttpCode(200)
  distribute(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: DistributeSubmissionsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.distribute(assignmentId, body, user);
  }

  /** Publish every approved result of the assignment. */
  @Post('results/publish')
  @HttpCode(200)
  publishResults(@Param('assignmentId', ParseUUIDPipe) assignmentId: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.publishAssignmentResults(assignmentId, user);
  }
}

@ApiTags('Me')
@Controller('me/submissions')
@Roles('STUDENT')
export class MySubmissionsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Own submissions; scores and feedback appear once results are published. */
  @Get()
  findMine(@CurrentUser() user: AuthUser, @Query() query: ListSubmissionsDto) {
    return this.submissionsService.getMySubmissions(user, query);
  }
}

@ApiTags('Mentor')
@Controller('mentor/reviews')
@Roles('MENTOR')
export class MentorReviewsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Submissions assigned to me (open reviews by default; filter with ?status=). */
  @Get()
  queue(@CurrentUser() user: AuthUser, @Query() query: ListSubmissionsDto) {
    return this.submissionsService.getReviewQueue(user, query);
  }
}

@ApiTags('Admin · Leaderboard')
@Controller('admin/leaderboard')
@Roles('ADMIN')
export class AdminPointsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Rebuild every student's points from published results (maintenance). */
  @Post('recompute')
  @HttpCode(200)
  recompute(@CurrentUser() user: AuthUser) {
    return this.submissionsService.recomputeAllPoints(user);
  }
}
