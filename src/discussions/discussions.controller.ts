import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';

import { DiscussionsService } from './discussions.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

/**
 * Discussion endpoints.
 *
 * Course comments:      /courses/:courseId/comments
 * Assignment comments:  /assignments/:assignmentId/comments
 * Comment management:   /comments/:id
 * Reactions:            /comments/:id/reactions
 */
@Controller()
export class DiscussionsController {
  constructor(private readonly discussionsService: DiscussionsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Course discussions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ANY AUTHENTICATED: List top-level comments on a course.
   * Unauthorized users get 404 on unpublished courses.
   *
   * GET /courses/:courseId/comments
   */
  @Get('courses/:courseId/comments')
  @UseGuards(JwtAuthGuard)
  listCourseComments(
    @Param('courseId') courseId: string,
    @Query() query: ListCommentsDto,
    @Request() req: any,
  ) {
    return this.discussionsService.listCourseComments(
      courseId,
      { id: req.user.id, role: req.user.role },
      query,
    );
  }

  /**
   * ANY AUTHENTICATED: Post a comment on a course.
   *
   * POST /courses/:courseId/comments
   */
  @Post('courses/:courseId/comments')
  @UseGuards(JwtAuthGuard)
  createCourseComment(
    @Param('courseId') courseId: string,
    @Body() body: CreateCommentDto,
    @Request() req: any,
  ) {
    return this.discussionsService.createCourseComment(
      courseId,
      body,
      { id: req.user.id, role: req.user.role },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Assignment discussions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ANY AUTHENTICATED: List top-level comments on an assignment.
   * Unauthorized users get 404 on unpublished assignments.
   *
   * GET /assignments/:assignmentId/comments
   */
  @Get('assignments/:assignmentId/comments')
  @UseGuards(JwtAuthGuard)
  listAssignmentComments(
    @Param('assignmentId') assignmentId: string,
    @Query() query: ListCommentsDto,
    @Request() req: any,
  ) {
    return this.discussionsService.listAssignmentComments(
      assignmentId,
      { id: req.user.id, role: req.user.role },
      query,
    );
  }

  /**
   * ANY AUTHENTICATED: Post a comment on an assignment.
   *
   * POST /assignments/:assignmentId/comments
   */
  @Post('assignments/:assignmentId/comments')
  @UseGuards(JwtAuthGuard)
  createAssignmentComment(
    @Param('assignmentId') assignmentId: string,
    @Body() body: CreateCommentDto,
    @Request() req: any,
  ) {
    return this.discussionsService.createAssignmentComment(
      assignmentId,
      body,
      { id: req.user.id, role: req.user.role },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Replies
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ANY AUTHENTICATED: List replies to a comment.
   *
   * GET /comments/:id/replies
   */
  @Get('comments/:id/replies')
  @UseGuards(JwtAuthGuard)
  listReplies(
    @Param('id') id: string,
    @Query() query: ListCommentsDto,
    @Request() req: any,
  ) {
    return this.discussionsService.listReplies(
      id,
      { id: req.user.id, role: req.user.role },
      query,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Comment management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ANY AUTHENTICATED: Edit own comment. Admin can edit any comment.
   *
   * PATCH /comments/:id
   */
  @Patch('comments/:id')
  @UseGuards(JwtAuthGuard)
  updateComment(
    @Param('id') id: string,
    @Body() body: UpdateCommentDto,
    @Request() req: any,
  ) {
    return this.discussionsService.update(
      id,
      body,
      { id: req.user.id, role: req.user.role },
    );
  }

  /**
   * ANY AUTHENTICATED: Soft-delete own comment. Admin can delete any comment.
   * Deleted comments show as "[deleted]" to preserve thread structure.
   *
   * DELETE /comments/:id
   */
  @Delete('comments/:id')
  @UseGuards(JwtAuthGuard)
  removeComment(@Param('id') id: string, @Request() req: any) {
    return this.discussionsService.remove(
      id,
      { id: req.user.id, role: req.user.role },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Moderation (Admin only)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ADMIN: Hide a comment from public view.
   *
   * PATCH /comments/:id/hide
   */
  @Patch('comments/:id/hide')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  hideComment(@Param('id') id: string, @Request() req: any) {
    return this.discussionsService.hide(
      id,
      { id: req.user.id, role: req.user.role },
    );
  }

  /**
   * ADMIN: Restore a hidden comment.
   *
   * PATCH /comments/:id/restore
   */
  @Patch('comments/:id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  restoreComment(@Param('id') id: string, @Request() req: any) {
    return this.discussionsService.restore(
      id,
      { id: req.user.id, role: req.user.role },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reactions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ANY AUTHENTICATED: Add or remove a reaction on a comment (toggle).
   * The unique constraint prevents the same reaction from being added twice;
   * reacting with the same type again removes it.
   *
   * POST /comments/:id/reactions
   */
  @Post('comments/:id/reactions')
  @UseGuards(JwtAuthGuard)
  react(
    @Param('id') id: string,
    @Body() body: ReactCommentDto,
    @Request() req: any,
  ) {
    return this.discussionsService.react(
      id,
      body,
      { id: req.user.id, role: req.user.role },
    );
  }
}
