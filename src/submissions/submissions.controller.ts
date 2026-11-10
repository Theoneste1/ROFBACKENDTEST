import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { IsOptional, IsString, Length } from 'class-validator';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { SubmissionsService } from './submissions.service.js';
import { CreateSubmissionDto } from './dto/create-submission.dto.js';
import { RequestResubmissionDto } from './dto/request-resubmission.dto.js';
import { AssignSubmissionDto, DistributeSubmissionsDto } from './dto/assign-submission.dto.js';
import { MarkSubmissionDto } from './dto/mark-submission.dto.js';
import { ApproveResultDto, RejectResultDto } from './dto/review-result.dto.js';
import { ReopenResultDto } from './dto/correct-result.dto.js';
import { ListSubmissionsDto } from './dto/list-submissions.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { uploadOptions } from '../common/storage/upload-options.js';
import {
  ATTACHMENT_FIELDS,
  filesFrom,
  MAX_ATTACHMENTS,
  type UploadedAttachmentFiles,
} from '../common/storage/attachments.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

/** Mentor feedback upload fields: "feedbackFile" (single, legacy) and "feedbackFiles". */
const FEEDBACK_FIELDS = [
  { name: 'feedbackFile',  maxCount: 1 },
  { name: 'feedbackFiles', maxCount: MAX_ATTACHMENTS },
];
type FeedbackUpload = { feedbackFile?: Express.Multer.File[]; feedbackFiles?: Express.Multer.File[] };
const feedbackFiles = (u?: FeedbackUpload) => filesFrom({ file: u?.feedbackFile, files: u?.feedbackFiles });

class PublishResultsDto {
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  note?: string;
}
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
   * Submit or resubmit (multipart/form-data: "assignmentId", a typed answer in
   * "answerText" and/or work in "files" — up to 10, e.g. photographed pages —
   * or "file"; optional "note"). Deadline and resubmission rules apply; after
   * a mentor's request the student may resubmit until the request's due date.
   */
  @Post()
  @RequirePermission('submissions.submit')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(ATTACHMENT_FIELDS, uploadOptions('SUBMISSION')))
  submit(
    @Body() body: CreateSubmissionDto,
    @UploadedFiles() upload: UploadedAttachmentFiles | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.submit(body, user, filesFrom(upload));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — list
  // ═══════════════════════════════════════════════════════════════════════════

  @Get()
  @RequirePermission('submissions.distribute')
  findAll(@Query() query: ListSubmissionsDto) {
    return this.submissionsService.findAll(query);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Any role — single submission (projected for the caller)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Students: own only. Mentors: assigned to them. Admins: any. */
  @Get(':id')
  @Authenticated()
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.findOne(id, user);
  }

  /**
   * Attempt history: every attempt (answer, files, timestamps) and every
   * resubmission request. Students: own only. Mentors: assigned to them. Admins: any.
   */
  @Get(':id/history')
  @Authenticated()
  history(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.attemptHistory(id, user);
  }

  /** Review history (all cycles with events). Admins: all; mentors: their own cycles. */
  @Get(':id/reviews')
  @Roles('ADMIN', 'MENTOR', 'SUPER_ADMIN')
  reviews(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reviewHistory(id, user);
  }

  /** First file of the latest submitted version. */
  @Get(':id/file')
  @Authenticated()
  async file(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.submissionsService.serveSubmissionFile(id, user, res);
  }

  /** A specific submitted file (any revision). */
  @Get(':id/attachments/:attachmentId/file')
  @Authenticated()
  async attachmentFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissionsService.serveSubmissionFile(id, user, res, { attachmentId });
  }

  /** First file of a specific revision (1 = first submission). */
  @Get(':id/revisions/:revisionNumber/file')
  @Authenticated()
  async revisionFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNumber', ParseIntPipe) revisionNumber: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissionsService.serveSubmissionFile(id, user, res, { revisionNumber });
  }

  /** First mentor feedback file (students: only after publication). */
  @Get(':id/feedback-file')
  @Authenticated()
  async feedbackFile(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.submissionsService.serveFeedbackFile(id, user, res);
  }

  /** A specific mentor feedback file. */
  @Get(':id/feedback-files/:attachmentId')
  @Authenticated()
  async feedbackAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    await this.submissionsService.serveFeedbackFile(id, user, res, attachmentId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4 — Admin distributes
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch(':id/assign')
  @RequirePermission('submissions.distribute')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.assign(id, body, user);
  }

  @Patch(':id/reassign')
  @RequirePermission('submissions.distribute')
  reassign(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignSubmissionDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reassign(id, body, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5 — Mentor reviews (MENTOR only: administrators do not grade)
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch(':id/start-review')
  @RequirePermission('reviews.grade')
  startReview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.startReview(id, user);
  }

  /** Score + formal feedback; files in "feedbackFiles" (up to 10) or "feedbackFile". */
  @Patch(':id/mark')
  @RequirePermission('reviews.grade')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileFieldsInterceptor(FEEDBACK_FIELDS, uploadOptions('FEEDBACK')))
  mark(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkSubmissionDto,
    @UploadedFiles() upload: FeedbackUpload | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.mark(id, body, user, feedbackFiles(upload));
  }

  /** Remove a feedback file from your current review (before returning it). */
  @Delete(':id/review/attachments/:attachmentId')
  @RequirePermission('reviews.grade')
  removeFeedbackFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.removeReviewAttachment(id, attachmentId, user);
  }

  /**
   * Ask the student for a new attempt, with a note and an optional due date
   * (default: the assignment deadline or 7 days from now, whichever is later).
   * Only where the assignment permits resubmissions.
   */
  @Patch(':id/request-resubmission')
  @RequirePermission('reviews.grade')
  requestResubmission(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RequestResubmissionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.requestResubmission(id, body, user);
  }

  /** Withdraw an open request; the review resumes on the current work. */
  @Patch(':id/withdraw-resubmission-request')
  @RequirePermission('reviews.grade')
  withdrawResubmissionRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.withdrawResubmissionRequest(id, user);
  }

  /** Return the completed review to the administrators. */
  @Patch(':id/submit-to-admin')
  @RequirePermission('reviews.grade')
  submitToAdmin(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.submitToAdmin(id, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6–7 — Admin coordinates results
  // ═══════════════════════════════════════════════════════════════════════════

  @Patch(':id/approve')
  @RequirePermission('results.approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveResultDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.approve(id, body, user);
  }

  /** Send the review back to the mentor with a reason. */
  @Patch(':id/reject')
  @RequirePermission('results.approve')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectResultDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reject(id, body, user);
  }

  /** Publish one approved result to the student. */
  @Patch(':id/publish')
  @RequirePermission('results.publish')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.submissionsService.publish(id, user);
  }

  /** Correct a published result by returning it to the mentor (replaces the old score-correction endpoint). */
  @Patch(':id/reopen')
  @RequirePermission('results.approve')
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReopenResultDto, @CurrentUser() user: AuthUser) {
    return this.submissionsService.reopen(id, body, user);
  }
}

@ApiTags('Submissions')
@Controller('assignments/:assignmentId')
export class AssignmentResultsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Spread all unassigned submissions across the mentors of this course × division. */
  @Post('distribute')
  @HttpCode(200)
  @RequirePermission('submissions.distribute')
  distribute(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: DistributeSubmissionsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.distribute(assignmentId, body, user);
  }

  /** Distribution runs for this assignment (who got what, when). */
  @Get('distribution-batches')
  @RequirePermission('submissions.distribute')
  batches(@Param('assignmentId', ParseUUIDPipe) assignmentId: string) {
    return this.submissionsService.listDistributionBatches(assignmentId);
  }

  /** Publish every approved result of the assignment as one release. */
  @Post('results/publish')
  @HttpCode(200)
  @RequirePermission('results.publish')
  publishResults(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: PublishResultsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissionsService.publishAssignmentResults(assignmentId, user, body.note);
  }

  /** Result releases for this assignment. */
  @Get('result-releases')
  @RequirePermission('results.publish')
  releases(@Param('assignmentId', ParseUUIDPipe) assignmentId: string) {
    return this.submissionsService.listResultReleases(assignmentId);
  }
}

@ApiTags('Me')
@Controller('me/submissions')
export class MySubmissionsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Own submissions; scores and feedback appear once results are published. */
  @Get()
  @RequirePermission('submissions.viewOwn')
  findMine(@CurrentUser() user: AuthUser, @Query() query: ListSubmissionsDto) {
    return this.submissionsService.getMySubmissions(user, query);
  }
}

@ApiTags('Mentor')
@Controller('mentor/reviews')
export class MentorReviewsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Submissions assigned to me (open reviews by default; filter with ?status=). */
  @Get()
  @RequirePermission('reviews.grade')
  queue(@CurrentUser() user: AuthUser, @Query() query: ListSubmissionsDto) {
    return this.submissionsService.getReviewQueue(user, query);
  }
}

@ApiTags('Admin · Leaderboard')
@Controller('admin/leaderboard')
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminPointsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  /** Rebuild every student's points from published results (maintenance). */
  @Post('recompute')
  @HttpCode(200)
  recompute(@CurrentUser() user: AuthUser) {
    return this.submissionsService.recomputeAllPoints(user);
  }
}
