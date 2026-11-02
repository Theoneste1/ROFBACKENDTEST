import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import type { Response } from 'express';

import { SubmissionsService } from './submissions.service.js';
import {
  submissionStorage,
  submissionFileFilter,
  SUBMISSION_MAX_FILE_SIZE,
  feedbackStorage,
  feedbackFileFilter,
  FEEDBACK_MAX_FILE_SIZE,
} from './submissions.constants.js';
import { CreateSubmissionDto } from './dto/create-submission.dto.js';
import { AssignSubmissionDto } from './dto/assign-submission.dto.js';
import { MarkSubmissionDto } from './dto/mark-submission.dto.js';
import { ApproveResultDto, RejectResultDto } from './dto/review-result.dto.js';
import { CorrectResultDto } from './dto/correct-result.dto.js';
import { resolveUploadPath, contentDisposition } from '../common/file.utils.js';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

// ─── Multer option objects ────────────────────────────────────────────────────

const submissionUploadOpts = {
  storage:    submissionStorage,
  fileFilter: submissionFileFilter,
  limits:     { fileSize: SUBMISSION_MAX_FILE_SIZE },
};

const feedbackUploadOpts = {
  storage:    feedbackStorage,
  fileFilter: feedbackFileFilter,
  limits:     { fileSize: FEEDBACK_MAX_FILE_SIZE },
};

@Controller('submissions')
export class SubmissionsController {
  constructor(private readonly submissionsService: SubmissionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3 — Student submits / resubmits
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * STUDENT (+ADMIN): Submit or resubmit an assignment.
   * Handles first submission and revisions in one endpoint.
   * Deadline + resubmission rules enforced in the service.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT')
  @UseInterceptors(FileInterceptor('file', submissionUploadOpts))
  submit(
    @Body() body: CreateSubmissionDto,
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    return this.submissionsService.submit(body, { id: req.user.id, role: req.user.role }, file);
  }

  /**
   * STUDENT (+ADMIN): View own submissions.
   * Published results include score, percentage, mentor name, feedback.
   * Pre-publish submissions show status only — no score/feedback leak.
   */
  @Get('my-submissions')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT')
  getMySubmissions(@Request() req: any) {
    return this.submissionsService.getMySubmissions(req.user.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4 — Admin views and assigns
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: Full list of all submissions with current status. */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  findAll() {
    return this.submissionsService.findAll();
  }

  /** ADMIN: Single submission with full revision history. */
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  findOne(@Param('id') id: string) {
    return this.submissionsService.findOne(id);
  }

  /** ADMIN: Assign a mentor to a SUBMITTED submission. */
  @Patch(':id/assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  assign(
    @Param('id') id: string,
    @Body() body: AssignSubmissionDto,
    @Request() req: any,
  ) {
    return this.submissionsService.assign(id, body, { id: req.user.id, role: req.user.role });
  }

  /** ADMIN: Reassign a different mentor to an already-assigned submission. */
  @Patch(':id/reassign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  reassign(
    @Param('id') id: string,
    @Body() body: AssignSubmissionDto,
    @Request() req: any,
  ) {
    return this.submissionsService.reassign(id, body, { id: req.user.id, role: req.user.role });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5 — Mentor reviews, marks, and sends to admin
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * MENTOR (+ADMIN): Get submissions assigned to this mentor.
   * Admin calling this sees their own mentor queue (empty unless directly assigned).
   * Use GET /submissions for the admin's full list.
   */
  @Get('my-assignments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  getByMentor(@Request() req: any) {
    return this.submissionsService.getByMentor(req.user.id);
  }

  /** MENTOR (+ADMIN): Start reviewing an ASSIGNED submission. */
  @Patch(':id/start-review')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  startReview(@Param('id') id: string, @Request() req: any) {
    return this.submissionsService.startReview(id, { id: req.user.id, role: req.user.role });
  }

  /**
   * MENTOR (+ADMIN): Submit score + feedback.
   * Accepts an optional `feedbackFile` field for an attachment.
   */
  @Patch(':id/mark')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  @UseInterceptors(FileInterceptor('feedbackFile', feedbackUploadOpts))
  mark(
    @Param('id') id: string,
    @Body() body: MarkSubmissionDto,
    @UploadedFile() feedbackFile: Express.Multer.File,
    @Request() req: any,
  ) {
    return this.submissionsService.mark(
      id,
      body,
      { id: req.user.id, role: req.user.role },
      feedbackFile,
    );
  }

  /** MENTOR (+ADMIN): Send MARKED submission to admin for approval. */
  @Patch(':id/submit-to-admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  submitToAdmin(@Param('id') id: string, @Request() req: any) {
    return this.submissionsService.submitToAdmin(id, { id: req.user.id, role: req.user.role });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6 — Admin approves, rejects, publishes, and corrects
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: Approve a SUBMITTED_TO_ADMIN result. */
  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  approve(
    @Param('id') id: string,
    @Body() body: ApproveResultDto,
    @Request() req: any,
  ) {
    return this.submissionsService.approve(id, body, { id: req.user.id, role: req.user.role });
  }

  /** ADMIN: Reject a SUBMITTED_TO_ADMIN result — returns it to the mentor. */
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  reject(
    @Param('id') id: string,
    @Body() body: RejectResultDto,
    @Request() req: any,
  ) {
    return this.submissionsService.reject(id, body, { id: req.user.id, role: req.user.role });
  }

  /** ADMIN: Publish an APPROVED result to the student. Awards leaderboard points. */
  @Patch(':id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  publish(@Param('id') id: string, @Request() req: any) {
    return this.submissionsService.publish(id, { id: req.user.id, role: req.user.role });
  }

  /**
   * ADMIN: Correct a PUBLISHED result.
   * Snapshots the previous score, requires a mandatory correction note,
   * adjusts leaderboard points by the delta, and writes a full audit entry.
   */
  @Patch(':id/correct')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  correctResult(
    @Param('id') id: string,
    @Body() body: CorrectResultDto,
    @Request() req: any,
  ) {
    return this.submissionsService.correctResult(id, body, { id: req.user.id, role: req.user.role });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // File downloads
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ADMIN (+MENTOR): Download a student submission file.
   *
   * Access rule:
   *   - ADMIN: any submission.
   *   - MENTOR: only submissions assigned to them.
   *   - STUDENT: cannot reach this endpoint (blocked by @Roles('MENTOR')).
   *              Students download their own submissions via my-submissions response.
   */
  @Get(':id/download-submission')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  async downloadSubmission(
    @Param('id') id: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const sub    = await this.submissionsService.findOne(id);
    const caller = { id: req.user.id, role: req.user.role };

    if (caller.role !== 'ADMIN' && sub.mentor?.id !== caller.id) {
      return res.status(403).json({ message: 'You are not assigned to this submission.' });
    }

    if (!sub.fileUrl) {
      return res.status(404).json({ message: 'No file attached to this submission.' });
    }

    const filePath = resolveUploadPath(sub.fileUrl, 'submissions');
    const disp     = contentDisposition(null, `submission-${id}`);
    res.setHeader('Content-Disposition', disp);
    createReadStream(filePath).pipe(res);
  }

  /**
   * STUDENT (+ADMIN): Download the mentor feedback file for a published result.
   *
   * Access rule: Student may only download feedback for their own submission
   * once the result is PUBLISHED.
   */
  @Get(':id/download-feedback')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT')
  async downloadFeedback(
    @Param('id') id: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const mySubmissions = await this.submissionsService.getMySubmissions(req.user.id);
    const sub           = mySubmissions.find((s) => s.id === id);

    if (!sub) {
      return res.status(404).json({ message: 'Submission not found.' });
    }
    if (sub.status !== 'PUBLISHED') {
      return res.status(403).json({ message: 'Feedback is not available until results are published.' });
    }

    const feedbackUrl = (sub as any).mentorFeedbackFileUrl as string | undefined;
    if (!feedbackUrl) {
      return res.status(404).json({ message: 'No feedback file attached to this result.' });
    }

    const filePath = resolveUploadPath(feedbackUrl, 'feedback');
    const disp     = contentDisposition(null, `feedback-${id}`);
    res.setHeader('Content-Disposition', disp);
    createReadStream(filePath).pipe(res);
  }
}
