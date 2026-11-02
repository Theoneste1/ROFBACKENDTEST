import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DiscussionsService } from './discussions.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

/**
 * Discussion endpoints.
 *
 * Course comments:      /courses/:courseId/comments      (per division)
 * Assignment comments:  /assignments/:assignmentId/comments
 * Comment management:   /comments/:id
 * Reactions:            /comments/:id/reactions
 * Moderation:           /admin/comments/hidden, /comments/:id/hide|restore
 */
@ApiTags('Discussions')
@Controller()
export class DiscussionsController {
  constructor(private readonly discussionsService: DiscussionsService) {}

  // ─── Course discussions ───────────────────────────────────────────────────

  @Get('courses/:courseId/comments')
  listCourseComments(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Query() query: ListCommentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.listCourseComments(courseId, user, query);
  }

  @Post('courses/:courseId/comments')
  createCourseComment(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() body: CreateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.createCourseComment(courseId, body, user);
  }

  // ─── Assignment discussions ───────────────────────────────────────────────

  @Get('assignments/:assignmentId/comments')
  listAssignmentComments(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query() query: ListCommentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.listAssignmentComments(assignmentId, user, query);
  }

  @Post('assignments/:assignmentId/comments')
  createAssignmentComment(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: CreateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.createAssignmentComment(assignmentId, body, user);
  }

  // ─── Threads ──────────────────────────────────────────────────────────────

  @Get('comments/:id/replies')
  listReplies(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListCommentsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.listReplies(id, user, query);
  }

  /** Authors edit their own comments. */
  @Patch('comments/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.update(id, body, user);
  }

  /** Authors delete their own comments; admins may delete any (audited). */
  @Delete('comments/:id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.discussionsService.remove(id, user);
  }

  /** Toggle a reaction (LIKE, HELPFUL, CONFUSED). */
  @Post('comments/:id/reactions')
  react(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReactCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussionsService.react(id, body, user);
  }

  // ─── Moderation (ADMIN) ───────────────────────────────────────────────────

  @Patch('comments/:id/hide')
  @Roles('ADMIN')
  hide(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.discussionsService.hide(id, user);
  }

  @Patch('comments/:id/restore')
  @Roles('ADMIN')
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.discussionsService.restore(id, user);
  }

  @Get('admin/comments/hidden')
  @Roles('ADMIN')
  listHidden(@Query() query: ListCommentsDto) {
    return this.discussionsService.listHidden(query);
  }
}
