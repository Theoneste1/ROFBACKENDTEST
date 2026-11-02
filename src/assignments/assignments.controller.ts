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

import {
  AssignmentsService,
  assignmentStorage,
  ASSIGNMENT_FILE_FILTER,
  ASSIGNMENT_MAX_FILE_SIZE,
} from './assignments.service.js';
import { CreateAssignmentDto } from './dto/create-assignment.dto.js';
import { UpdateAssignmentDto } from './dto/update-assignment.dto.js';
import { RejectAssignmentDto } from './dto/reject-assignment.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { resolveUploadPath, contentDisposition } from '../common/file.utils.js';

const fileUploadOpts = {
  storage:    assignmentStorage,
  fileFilter: ASSIGNMENT_FILE_FILTER,
  limits:     { fileSize: ASSIGNMENT_MAX_FILE_SIZE },
};

@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignmentsService: AssignmentsService) {}

  // ─── MENTOR (+ADMIN): Create draft assignment ─────────────────────────────
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  @UseInterceptors(FileInterceptor('file', fileUploadOpts))
  create(
    @Body() body: CreateAssignmentDto,
    @Request() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.assignmentsService.create(body, { id: req.user.id, role: req.user.role }, file);
  }

  // ─── MENTOR (+ADMIN): View own assignments ────────────────────────────────
  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  findMine(@Request() req: any) {
    return this.assignmentsService.findMine(req.user.id);
  }

  // ─── ADMIN: Full list ─────────────────────────────────────────────────────
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  findAllAdmin() {
    return this.assignmentsService.findAllAdmin();
  }

  // ─── STUDENT (+ADMIN): Browse published assignments with display status ──────
  //
  // Returns every published assignment annotated with the student's personal
  // display status (New / Opened / Submitted / In Review / Marked / Redo).
  @Get('my-assignments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('STUDENT')
  getStudentAssignments(@Request() req: any) {
    return this.assignmentsService.getStudentAssignments(req.user.id);
  }

  // ─── ANY AUTHENTICATED: Published assignments ─────────────────────────────
  @Get()
  @UseGuards(JwtAuthGuard)
  findAll() {
    return this.assignmentsService.findAll();
  }

  // ─── ANY AUTHENTICATED: Single assignment ─────────────────────────────────
  // For students: also records the view event that drives New → Opened.
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @Request() req: any) {
    const assignment = await this.assignmentsService.findOne(id, { id: req.user.id, role: req.user.role });

    // Record view for students (fire-and-forget — don't block the response).
    if (req.user.role === 'STUDENT' && assignment.status === 'PUBLISHED') {
      void this.assignmentsService.recordView(id, req.user.id);
    }

    return assignment;
  }

  // ─── MENTOR (+ADMIN): Edit DRAFT/REJECTED assignment ─────────────────────
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  @UseInterceptors(FileInterceptor('file', fileUploadOpts))
  update(
    @Param('id') id: string,
    @Body() body: UpdateAssignmentDto,
    @Request() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.assignmentsService.update(id, body, { id: req.user.id, role: req.user.role }, file);
  }

  // ─── MENTOR (+ADMIN): Submit for admin review ────────────────────────────
  @Patch(':id/submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  submitForReview(@Param('id') id: string, @Request() req: any) {
    return this.assignmentsService.submitForReview(id, { id: req.user.id, role: req.user.role });
  }

  // ─── MENTOR (+ADMIN): Recall pending back to draft ───────────────────────
  @Patch(':id/recall')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('MENTOR')
  recall(@Param('id') id: string, @Request() req: any) {
    return this.assignmentsService.recall(id, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: Publish ───────────────────────────────────────────────────────
  @Patch(':id/publish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  publish(@Param('id') id: string, @Request() req: any) {
    return this.assignmentsService.publish(id, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: Reject ────────────────────────────────────────────────────────
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  rejectAssignment(
    @Param('id') id: string,
    @Body() body: RejectAssignmentDto,
    @Request() req: any,
  ) {
    return this.assignmentsService.rejectAssignment(id, body, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: Unpublish ─────────────────────────────────────────────────────
  @Patch(':id/unpublish')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  unpublish(@Param('id') id: string, @Request() req: any) {
    return this.assignmentsService.unpublish(id, { id: req.user.id, role: req.user.role });
  }

  // ─── ANY AUTHENTICATED: Download / view assignment attachment ───────────────
  //
  // Access rule (enforced in AssignmentsService.findOne):
  //   - ADMIN: always.
  //   - Creator: always (even while unpublished).
  //   - Everyone else: only when the assignment is PUBLISHED.
  //
  // Path traversal is prevented by resolveUploadPath().
  @Get(':id/download')
  @UseGuards(JwtAuthGuard)
  async download(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    const assignment = await this.assignmentsService.findOne(
      id,
      { id: req.user.id, role: req.user.role },
    );

    if (!assignment.fileUrl) {
      return res.status(404).json({ message: 'No file attached to this assignment.' });
    }

    const filePath = resolveUploadPath(assignment.fileUrl, 'assignments');
    const mime     = 'application/pdf'; // assignments are always PDFs per MIME filter
    const disp     = contentDisposition(mime, assignment.title + '.pdf');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', disp);
    createReadStream(filePath).pipe(res);
  }
}
