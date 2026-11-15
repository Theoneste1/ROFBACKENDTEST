import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DiscussionsService, ThreadModerationOp } from './discussions.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import {
  CreateThreadDto,
  ListModerationActionsDto,
  ListReportsDto,
  ListThreadsDto,
  ModerationReasonDto,
  ReportContentDto,
  ResolveReportDto,
  UpdateThreadDto,
} from './dto/thread.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

/**
 * Discussion endpoints.
 *
 *   Course threads:      /courses/:courseId/threads        (per division)
 *   Assignment threads:  /assignments/:assignmentId/threads
 *   Threads:             /threads/:id, /threads/:id/comments
 *   Comments:            /comments/:id, /comments/:id/replies, /comments/:id/reactions
 *   Reports:             /threads/:id/report, /comments/:id/report
 *   Moderation (admin):  /admin/moderation/…, /threads/:id/{lock,…}, /comments/:id/{hide,restore}
 *
 * There are no private or direct messages: all discussion happens in course
 * and assignment threads.
 */
@ApiTags('Discussions')
@Controller()
export class DiscussionsController {
  constructor(private readonly discussions: DiscussionsService) {}

  // ─── Threads ──────────────────────────────────────────────────────────────

  @Get('courses/:courseId/threads')
  @Authenticated()
  listCourseThreads(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Query() query: ListThreadsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussions.listCourseThreads(courseId, user, query);
  }

  /** Start a course discussion (title + opening message). */
  @Post('courses/:courseId/threads')
  @Authenticated()
  createCourseThread(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() body: CreateThreadDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussions.createCourseThread(courseId, body, user);
  }

  @Get('assignments/:assignmentId/threads')
  @Authenticated()
  listAssignmentThreads(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Query() query: ListThreadsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussions.listAssignmentThreads(assignmentId, user, query);
  }

  @Post('assignments/:assignmentId/threads')
  @Authenticated()
  createAssignmentThread(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() body: CreateThreadDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussions.createAssignmentThread(assignmentId, body, user);
  }

  @Get('threads/:id')
  @Authenticated()
  getThread(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.discussions.getThread(id, user);
  }

  /** The author renames their open thread. */
  @Patch('threads/:id')
  @Authenticated()
  updateThread(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateThreadDto, @CurrentUser() user: AuthUser) {
    return this.discussions.updateThread(id, body, user);
  }

  /**
   * Authors delete their own thread while nobody else has posted in it; admins
   * may remove any thread (recorded as moderation, optional reason).
   */
  @Delete('threads/:id')
  @Authenticated()
  deleteThread(@Param('id', ParseUUIDPipe) id: string, @Body() body: ModerationReasonDto, @CurrentUser() user: AuthUser) {
    return this.discussions.deleteThread(id, user, body?.reason);
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  @Get('threads/:id/comments')
  @Authenticated()
  listComments(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListCommentsDto, @CurrentUser() user: AuthUser) {
    return this.discussions.listComments(id, user, query);
  }

  /** Post in a thread (set parentId to reply to a comment). */
  @Post('threads/:id/comments')
  @Authenticated()
  createComment(@Param('id', ParseUUIDPipe) id: string, @Body() body: CreateCommentDto, @CurrentUser() user: AuthUser) {
    return this.discussions.createComment(id, body, user);
  }

  @Get('comments/:id/replies')
  @Authenticated()
  listReplies(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListCommentsDto, @CurrentUser() user: AuthUser) {
    return this.discussions.listReplies(id, user, query);
  }

  @Patch('comments/:id')
  @Authenticated()
  updateComment(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCommentDto, @CurrentUser() user: AuthUser) {
    return this.discussions.updateComment(id, body, user);
  }

  /** Authors delete their own comments; admins may delete any (recorded as moderation, optional reason). */
  @Delete('comments/:id')
  @Authenticated()
  removeComment(@Param('id', ParseUUIDPipe) id: string, @Body() body: ModerationReasonDto, @CurrentUser() user: AuthUser) {
    return this.discussions.removeComment(id, user, body?.reason);
  }

  /** Toggle a reaction (LIKE, HELPFUL, CONFUSED). */
  @Post('comments/:id/reactions')
  @Authenticated()
  react(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReactCommentDto, @CurrentUser() user: AuthUser) {
    return this.discussions.react(id, body, user);
  }

  // ─── Reports ──────────────────────────────────────────────────────────────

  @Post('threads/:id/report')
  @Authenticated()
  reportThread(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReportContentDto, @CurrentUser() user: AuthUser) {
    return this.discussions.reportThread(id, body, user);
  }

  @Post('comments/:id/report')
  @Authenticated()
  reportComment(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReportContentDto, @CurrentUser() user: AuthUser) {
    return this.discussions.reportComment(id, body, user);
  }

  // ─── Moderation (ADMIN) ───────────────────────────────────────────────────

  @Get('admin/moderation/reports')
  @RequirePermission('discussions.moderate')
  listReports(@Query() query: ListReportsDto) {
    return this.discussions.listReports(query);
  }

  /** The reported item, its other reports and the moderation already taken. */
  @Get('admin/moderation/reports/:id')
  @RequirePermission('discussions.moderate')
  getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.discussions.getReport(id);
  }

  /** Act on a report: HIDE, DELETE, LOCK (thread) or NONE (dismiss). */
  @Post('admin/moderation/reports/:id/resolve')
  @RequirePermission('discussions.moderate')
  @HttpCode(200)
  resolveReport(@Param('id', ParseUUIDPipe) id: string, @Body() body: ResolveReportDto, @CurrentUser() user: AuthUser) {
    return this.discussions.resolveReport(id, body, user);
  }

  /** Every moderation decision, newest first. */
  @Get('admin/moderation/actions')
  @RequirePermission('discussions.moderate')
  listActions(@Query() query: ListModerationActionsDto) {
    return this.discussions.listModerationActions(query);
  }

  @Get('admin/comments/hidden')
  @RequirePermission('discussions.moderate')
  listHidden(@Query() query: ListCommentsDto) {
    return this.discussions.listHidden(query);
  }

  @Patch('comments/:id/hide')
  @RequirePermission('discussions.moderate')
  hide(@Param('id', ParseUUIDPipe) id: string, @Body() body: ModerationReasonDto, @CurrentUser() user: AuthUser) {
    return this.discussions.hideComment(id, user, body.reason);
  }

  @Patch('comments/:id/restore')
  @RequirePermission('discussions.moderate')
  restore(@Param('id', ParseUUIDPipe) id: string, @Body() body: ModerationReasonDto, @CurrentUser() user: AuthUser) {
    return this.discussions.restoreComment(id, user, body.reason);
  }

  /** lock | unlock | hide | restore | archive | pin | unpin */
  @Patch('threads/:id/:op')
  @RequirePermission('discussions.moderate')
  moderateThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('op', new ParseEnumPipe(ThreadModerationOp)) op: ThreadModerationOp,
    @Body() body: ModerationReasonDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.discussions.moderateThread(id, op, user, body.reason);
  }
}
