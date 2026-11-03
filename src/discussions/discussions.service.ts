/**
 * Discussions: threads (topics) containing comments, plus content reports and
 * moderation.
 *
 * - Course threads belong to a (course × division): Junior and Senior never see
 *   each other's course discussions. Assignment threads inherit the
 *   assignment's division.
 * - Visibility follows AccessService: students in their division on published
 *   content, mentors in their assigned scopes, admins everywhere.
 * - Hidden threads/comments are visible to admins only. Locked threads can be
 *   read but not replied to. Archived threads are read-only history.
 * - When an admin turns a course's discussions off, its course and assignment
 *   threads stay readable but nobody can start a thread or post.
 * - Every moderation decision is recorded in ModerationAction.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { Prisma, type ModerationActionType, type ThreadStatus } from '../generated/prisma/client.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import {
  CreateThreadDto,
  ListReportsDto,
  ListThreadsDto,
  ReportContentDto,
  ResolveReportDto,
  UpdateThreadDto,
} from './dto/thread.dto.js';

// Only public profile fields — never email, passwordHash, etc.
const AUTHOR_SELECT = {
  id: true, username: true, firstName: true, lastName: true, avatarUrl: true, role: true,
} as const;

const THREAD_SELECT = {
  id: true, title: true, status: true, isPinned: true, courseId: true, assignmentId: true,
  divisionId: true, lastActivityAt: true, archivedAt: true, createdAt: true, updatedAt: true,
  createdBy: { select: AUTHOR_SELECT },
  _count:    { select: { comments: { where: { status: 'ACTIVE' as const } } } },
} as const;

const COMMENT_SELECT = {
  id: true, threadId: true, content: true, status: true, parentId: true,
  editedAt: true, createdAt: true, updatedAt: true,
  author:    { select: AUTHOR_SELECT },
  reactions: { select: { type: true, userId: true } },
  _count:    { select: { replies: { where: { status: 'ACTIVE' as const } } } },
} as const;

type Thread = { id: string; courseId: string | null; assignmentId: string | null; divisionId: string; status: ThreadStatus };

@Injectable()
export class DiscussionsService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly access:    AccessService,
    private readonly activity:  ActivityService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Threads
  // ═══════════════════════════════════════════════════════════════════════════

  async listCourseThreads(courseId: string, user: AuthUser, q: ListThreadsDto) {
    const target = await this.courseTarget(courseId, user, q.divisionId, false);
    return this.listThreads(target, user, q);
  }

  async listAssignmentThreads(assignmentId: string, user: AuthUser, q: ListThreadsDto) {
    const target = await this.assignmentTarget(assignmentId, user);
    return this.listThreads(target, user, q);
  }

  async createCourseThread(courseId: string, dto: CreateThreadDto, user: AuthUser) {
    const target = await this.courseTarget(courseId, user, dto.divisionId, true);
    await this.assertDiscussionsEnabled({ courseId, assignmentId: null });
    return this.createThread(target as { courseId: string; divisionId: string }, dto, user);
  }

  async createAssignmentThread(assignmentId: string, dto: CreateThreadDto, user: AuthUser) {
    const target = await this.assignmentTarget(assignmentId, user);
    await this.assertDiscussionsEnabled({ courseId: null, assignmentId });
    return this.createThread(target, dto, user);
  }

  async getThread(threadId: string, user: AuthUser) {
    const thread = await this.requireVisibleThread(threadId, user);
    return this.prisma.discussionThread.findUniqueOrThrow({ where: { id: thread.id }, select: THREAD_SELECT });
  }

  /** The author may rename their thread while it is open. */
  async updateThread(threadId: string, dto: UpdateThreadDto, user: AuthUser) {
    const thread = await this.requireVisibleThread(threadId, user);
    const full = await this.prisma.discussionThread.findUniqueOrThrow({ where: { id: threadId } });
    if (full.createdById !== user.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'Only the author can edit this thread.');
    }
    if (thread.status !== 'OPEN') throw invalidState('Only open threads can be edited.');
    return this.prisma.discussionThread.update({ where: { id: threadId }, data: { title: dto.title }, select: THREAD_SELECT });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Comments
  // ═══════════════════════════════════════════════════════════════════════════

  /** Top-level comments of a thread (oldest first) with reply counts. */
  async listComments(threadId: string, user: AuthUser, q: ListCommentsDto) {
    await this.requireVisibleThread(threadId, user);
    const { page, limit, skip, take } = pageArgs(q);
    const where = { threadId, parentId: null, ...this.visibleFilter(user) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take, select: COMMENT_SELECT }),
      this.prisma.comment.count({ where }),
    ]);
    return paginated(rows.map((c) => this.sanitizeComment(c, user)), total, page, limit);
  }

  async listReplies(commentId: string, user: AuthUser, q: ListCommentsDto) {
    const parent = await this.requireVisibleComment(commentId, user);
    const { page, limit, skip, take } = pageArgs(q);
    const where = { parentId: parent.id, ...this.visibleFilter(user) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take, select: COMMENT_SELECT }),
      this.prisma.comment.count({ where }),
    ]);
    return paginated(rows.map((c) => this.sanitizeComment(c, user)), total, page, limit);
  }

  async createComment(threadId: string, dto: CreateCommentDto, user: AuthUser) {
    const thread = await this.requireVisibleThread(threadId, user);
    if (thread.status !== 'OPEN') {
      throw invalidState(thread.status === 'LOCKED' ? 'This thread is locked.' : 'This thread is closed.');
    }
    await this.assertDiscussionsEnabled(thread);

    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.threadId !== threadId) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'WRONG_THREAD', 'Parent comment belongs to a different thread.');
      }
      if (parent.parentId !== null) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NESTING_LIMIT', 'Replies to replies are not supported.');
      }
      if (parent.status !== 'ACTIVE') throw invalidState('Cannot reply to a hidden or deleted comment.');
    }

    const [comment] = await this.prisma.$transaction([
      this.prisma.comment.create({
        data:   { threadId, content: dto.content, parentId: dto.parentId ?? null, authorId: user.id },
        select: COMMENT_SELECT,
      }),
      this.prisma.discussionThread.update({ where: { id: threadId }, data: { lastActivityAt: new Date() } }),
    ]);

    this.activity.record(user.id, 'COMMENT_POSTED', {
      courseId: thread.courseId ?? undefined, entityType: 'Comment', entityId: comment.id,
    });
    return this.sanitizeComment(comment, user);
  }

  async updateComment(commentId: string, dto: UpdateCommentDto, user: AuthUser) {
    const comment = await this.requireVisibleComment(commentId, user);
    if (comment.authorId !== user.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'You can only edit your own comments.');
    }
    if (comment.status !== 'ACTIVE') throw invalidState('Only active comments can be edited.');
    if (comment.thread.status !== 'OPEN') throw invalidState('This thread is no longer open.');

    const updated = await this.prisma.comment.update({
      where: { id: commentId }, data: { content: dto.content, editedAt: new Date() }, select: COMMENT_SELECT,
    });
    return this.sanitizeComment(updated, user);
  }

  /** Soft delete: content is replaced so the thread structure is preserved. */
  async removeComment(commentId: string, user: AuthUser, reason?: string) {
    const comment = await this.requireVisibleComment(commentId, user);
    const isAuthor = comment.authorId === user.id;
    if (!isAuthor && user.role !== 'ADMIN') {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'You can only delete your own comments.');
    }
    if (comment.status === 'DELETED') throw invalidState('Comment is already deleted.');

    await this.prisma.$transaction(async (tx) => {
      await tx.comment.update({ where: { id: commentId }, data: { status: 'DELETED', content: '[deleted]' } });
      if (!isAuthor) {
        await this.recordAction(tx, user, 'DELETE_COMMENT', { commentId, threadId: comment.threadId, reason });
      }
    });
    return { message: 'Comment deleted.' };
  }

  /** Toggle a reaction. */
  async react(commentId: string, dto: ReactCommentDto, user: AuthUser) {
    const comment = await this.requireVisibleComment(commentId, user);
    if (comment.status !== 'ACTIVE') throw invalidState('Cannot react to a hidden or deleted comment.');

    const { count } = await this.prisma.commentReaction.deleteMany({
      where: { commentId, userId: user.id, type: dto.type },
    });
    if (count > 0) return { reacted: false, type: dto.type };

    try {
      await this.prisma.commentReaction.create({ data: { commentId, userId: user.id, type: dto.type } });
    } catch (err) {
      // A concurrent identical request already added it — the end state is the same.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
    return { reacted: true, type: dto.type };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Content reports (any user who can see the content)
  // ═══════════════════════════════════════════════════════════════════════════

  async reportThread(threadId: string, dto: ReportContentDto, user: AuthUser) {
    await this.requireVisibleThread(threadId, user);
    return this.createReport({ threadId }, dto, user);
  }

  async reportComment(commentId: string, dto: ReportContentDto, user: AuthUser) {
    const comment = await this.requireVisibleComment(commentId, user);
    if (comment.authorId === user.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_REPORT_OWN', 'You cannot report your own comment.');
    }
    return this.createReport({ commentId }, dto, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Moderation (ADMIN)
  // ═══════════════════════════════════════════════════════════════════════════

  async listReports(q: ListReportsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = { status: q.status ?? 'OPEN' as const };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contentReport.findMany({
        where, skip, take, orderBy: { createdAt: 'asc' },
        include: {
          reporter:   { select: AUTHOR_SELECT },
          resolvedBy: { select: AUTHOR_SELECT },
          thread:     { select: { id: true, title: true, status: true } },
          comment:    { select: { id: true, content: true, status: true, threadId: true, author: { select: AUTHOR_SELECT } } },
        },
      }),
      this.prisma.contentReport.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * Resolve a report by acting on the reported item (HIDE, DELETE, LOCK) or by
   * dismissing it (NONE). Other open reports about the same item are closed
   * with the same outcome.
   */
  async resolveReport(reportId: string, dto: ResolveReportDto, user: AuthUser) {
    const report = await this.prisma.contentReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found.');
    if (report.status !== 'OPEN') throw invalidState('This report has already been handled.');
    if (dto.action === 'LOCK' && !report.threadId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ACTION', 'Only threads can be locked.');
    }

    await this.prisma.$transaction(async (tx) => {
      const target = report.commentId ? { commentId: report.commentId } : { threadId: report.threadId! };
      let action: ModerationActionType = 'DISMISS_REPORT';

      if (dto.action === 'HIDE') {
        action = report.commentId ? 'HIDE_COMMENT' : 'HIDE_THREAD';
        if (report.commentId) await tx.comment.update({ where: { id: report.commentId }, data: { status: 'HIDDEN' } });
        else await tx.discussionThread.update({ where: { id: report.threadId! }, data: { status: 'HIDDEN' } });
      } else if (dto.action === 'DELETE') {
        if (!report.commentId) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ACTION', 'Only comments can be deleted.');
        action = 'DELETE_COMMENT';
        await tx.comment.update({ where: { id: report.commentId }, data: { status: 'DELETED', content: '[deleted]' } });
      } else if (dto.action === 'LOCK') {
        action = 'LOCK_THREAD';
        await tx.discussionThread.update({ where: { id: report.threadId! }, data: { status: 'LOCKED' } });
      }

      await this.recordAction(tx, user, action, { ...target, reportId, reason: dto.note });
      await tx.contentReport.updateMany({
        where: { ...target, status: 'OPEN' },
        data:  {
          status: dto.action === 'NONE' ? 'DISMISSED' : 'RESOLVED',
          resolvedAt: new Date(), resolvedById: user.id, resolutionNote: dto.note ?? null,
        },
      });
    });

    return this.prisma.contentReport.findUniqueOrThrow({ where: { id: reportId } });
  }

  async hideComment(commentId: string, user: AuthUser, reason?: string) {
    return this.setCommentModeration(commentId, user, 'HIDDEN', 'HIDE_COMMENT', ['ACTIVE'], reason);
  }

  async restoreComment(commentId: string, user: AuthUser, reason?: string) {
    return this.setCommentModeration(commentId, user, 'ACTIVE', 'RESTORE_COMMENT', ['HIDDEN'], reason);
  }

  /** Lock / unlock / pin / unpin / hide / restore / archive a thread. */
  async moderateThread(threadId: string, op: ThreadModerationOp, user: AuthUser, reason?: string) {
    const thread = await this.prisma.discussionThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Thread not found.');

    const plan: Record<ThreadModerationOp, { from?: ThreadStatus[]; data: Prisma.DiscussionThreadUpdateInput; action: ModerationActionType }> = {
      lock:    { from: ['OPEN'],             data: { status: 'LOCKED' },                       action: 'LOCK_THREAD' },
      unlock:  { from: ['LOCKED'],           data: { status: 'OPEN' },                         action: 'UNLOCK_THREAD' },
      hide:    { from: ['OPEN', 'LOCKED'],   data: { status: 'HIDDEN' },                       action: 'HIDE_THREAD' },
      restore: { from: ['HIDDEN'],           data: { status: 'OPEN' },                         action: 'RESTORE_THREAD' },
      archive: { from: ['OPEN', 'LOCKED'],   data: { status: 'ARCHIVED', archivedAt: new Date() }, action: 'ARCHIVE_THREAD' },
      pin:     {                             data: { isPinned: true },                         action: 'PIN_THREAD' },
      unpin:   {                             data: { isPinned: false },                        action: 'UNPIN_THREAD' },
    };
    const step = plan[op];
    if (step.from && !step.from.includes(thread.status)) {
      throw invalidState(`Cannot ${op} a thread that is ${thread.status}.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.discussionThread.update({ where: { id: threadId }, data: step.data, select: THREAD_SELECT });
      await this.recordAction(tx, user, step.action, { threadId, reason });
      return updated;
    });
  }

  async listModerationActions(q: ListCommentsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.moderationAction.findMany({
        skip, take, orderBy: { createdAt: 'desc' },
        include: {
          moderator: { select: AUTHOR_SELECT },
          thread:    { select: { id: true, title: true } },
          comment:   { select: { id: true, content: true } },
        },
      }),
      this.prisma.moderationAction.count(),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Hidden comments across all discussions (moderation overview). */
  async listHidden(q: ListCommentsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = { status: 'HIDDEN' as const };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where, skip, take, orderBy: { updatedAt: 'desc' },
        select: { ...COMMENT_SELECT, thread: { select: { id: true, title: true } } },
      }),
      this.prisma.comment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve the division of a course discussion.
   *   Students: always their own division.
   *   Mentors/admins: divisionId required to post; admins may omit it to list
   *   every division's threads.
   */
  private async courseTarget(courseId: string, user: AuthUser, divisionId: string | undefined, forWrite: boolean) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found.');

    const division = user.role === 'STUDENT' ? this.access.studentDivision(user) : divisionId;
    if (!division) {
      if (user.role === 'ADMIN' && !forWrite) return { courseId };
      throw new AppError(HttpStatus.BAD_REQUEST, 'DIVISION_REQUIRED', 'Specify divisionId for course discussions.');
    }
    await this.access.assertCanView(user, { courseId, divisionId: division });
    return { courseId, divisionId: division };
  }

  private async assignmentTarget(assignmentId: string, user: AuthUser) {
    const a = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { id: true, courseId: true, divisionId: true, status: true },
    });
    if (!a) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, a);
    if (user.role === 'STUDENT' && !['PUBLISHED', 'CLOSED', 'ARCHIVED'].includes(a.status)) {
      throw new NotFoundException('Assignment not found.');
    }
    return { assignmentId, divisionId: a.divisionId };
  }

  private async listThreads(target: Prisma.DiscussionThreadWhereInput, user: AuthUser, q: ListThreadsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.DiscussionThreadWhereInput = {
      ...target,
      ...(q.status
        ? { status: q.status }
        : { status: { in: user.role === 'ADMIN' ? ['OPEN', 'LOCKED', 'HIDDEN'] : ['OPEN', 'LOCKED'] } }),
    };
    if (user.role !== 'ADMIN' && q.status === 'HIDDEN') throw new NotFoundException('Not found.');

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.discussionThread.findMany({
        where, skip, take, select: THREAD_SELECT,
        orderBy: [{ isPinned: 'desc' }, { lastActivityAt: 'desc' }],
      }),
      this.prisma.discussionThread.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  private async createThread(target: { courseId: string; divisionId: string } | { assignmentId: string; divisionId: string }, dto: CreateThreadDto, user: AuthUser) {
    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.discussionThread.create({
        data: { ...target, title: dto.title, createdById: user.id },
      });
      await tx.comment.create({ data: { threadId: created.id, content: dto.content, authorId: user.id } });
      return tx.discussionThread.findUniqueOrThrow({ where: { id: created.id }, select: THREAD_SELECT });
    });
    this.activity.record(user.id, 'THREAD_CREATED', {
      courseId: 'courseId' in target ? target.courseId : undefined, entityType: 'DiscussionThread', entityId: thread.id,
    });
    return thread;
  }

  /** Refuse new threads/comments when the thread's course has discussions turned off. */
  private async assertDiscussionsEnabled(target: { courseId: string | null; assignmentId: string | null }) {
    const course = await this.prisma.course.findFirst({
      where: target.courseId
        ? { id: target.courseId }
        : { assignments: { some: { id: target.assignmentId ?? undefined } } },
      select: { discussionsEnabled: true },
    });
    if (course && !course.discussionsEnabled) {
      throw new AppError(HttpStatus.CONFLICT, 'DISCUSSIONS_DISABLED', 'Discussions are turned off for this course.');
    }
  }

  /** Load a thread and check the caller may see it. */
  private async requireVisibleThread(threadId: string, user: AuthUser): Promise<Thread> {
    const thread = await this.prisma.discussionThread.findUnique({
      where:  { id: threadId },
      select: { id: true, courseId: true, assignmentId: true, divisionId: true, status: true },
    });
    if (!thread) throw new NotFoundException('Thread not found.');

    if (thread.courseId) {
      await this.access.assertCanView(user, { courseId: thread.courseId, divisionId: thread.divisionId });
    } else if (thread.assignmentId) {
      await this.assignmentTarget(thread.assignmentId, user);
    }
    if (user.role !== 'ADMIN' && thread.status === 'HIDDEN') throw new NotFoundException('Thread not found.');
    return thread;
  }

  private async requireVisibleComment(commentId: string, user: AuthUser) {
    const comment = await this.prisma.comment.findUnique({
      where:   { id: commentId },
      include: { thread: { select: { status: true } } },
    });
    if (!comment) throw new NotFoundException('Comment not found.');
    await this.requireVisibleThread(comment.threadId, user);
    if (user.role !== 'ADMIN' && comment.status === 'HIDDEN') throw new NotFoundException('Comment not found.');
    return comment;
  }

  private async createReport(target: { threadId: string } | { commentId: string }, dto: ReportContentDto, user: AuthUser) {
    try {
      return await this.prisma.contentReport.create({
        data:   { ...target, reporterId: user.id, reason: dto.reason, details: dto.details ?? null },
        select: { id: true, reason: true, status: true, createdAt: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(HttpStatus.CONFLICT, 'ALREADY_REPORTED', 'You have already reported this.');
      }
      throw err;
    }
  }

  private async setCommentModeration(
    commentId: string, user: AuthUser, to: 'HIDDEN' | 'ACTIVE', action: ModerationActionType,
    from: Array<'ACTIVE' | 'HIDDEN'>, reason?: string,
  ) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found.');
    if (!from.includes(comment.status as 'ACTIVE' | 'HIDDEN')) {
      throw invalidState(to === 'HIDDEN' ? 'Only active comments can be hidden.' : 'Only hidden comments can be restored.');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.comment.update({ where: { id: commentId }, data: { status: to }, select: COMMENT_SELECT });
      await this.recordAction(tx, user, action, { commentId, threadId: comment.threadId, reason });
      return this.sanitizeComment(updated, user);
    });
  }

  private async recordAction(
    tx: Prisma.TransactionClient, user: AuthUser, action: ModerationActionType,
    target: { threadId?: string; commentId?: string; reportId?: string; reason?: string },
  ) {
    await tx.moderationAction.create({
      data: {
        moderatorId: user.id, action,
        threadId: target.threadId ?? null, commentId: target.commentId ?? null,
        reportId: target.reportId ?? null, reason: target.reason ?? null,
      },
    });
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action, entity: target.commentId ? 'Comment' : 'DiscussionThread',
      entityId: target.commentId ?? target.threadId ?? null, metadata: { reportId: target.reportId, reason: target.reason },
    }, tx);
  }

  /** Admins see ACTIVE + HIDDEN (not DELETED placeholders' content); everyone else ACTIVE. */
  private visibleFilter(user: AuthUser): Prisma.CommentWhereInput {
    return user.role === 'ADMIN' ? { status: { in: ['ACTIVE', 'HIDDEN'] } } : { status: 'ACTIVE' };
  }

  private sanitizeComment(comment: Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>, user: AuthUser) {
    const counts: Record<string, number> = {};
    for (const r of comment.reactions) counts[r.type] = (counts[r.type] ?? 0) + 1;
    return {
      id:          comment.id,
      threadId:    comment.threadId,
      content:     comment.status === 'DELETED' ? '[deleted]' : comment.content,
      status:      comment.status,
      parentId:    comment.parentId,
      editedAt:    comment.editedAt,
      createdAt:   comment.createdAt,
      updatedAt:   comment.updatedAt,
      author:      comment.status === 'DELETED' ? null : comment.author,
      reactions:   counts,
      myReactions: comment.reactions.filter((r) => r.userId === user.id).map((r) => r.type),
      replyCount:  comment._count.replies,
    };
  }
}

/** Admin thread operations: PATCH /threads/:id/:op */
export enum ThreadModerationOp {
  lock    = 'lock',
  unlock  = 'unlock',
  hide    = 'hide',
  restore = 'restore',
  archive = 'archive',
  pin     = 'pin',
  unpin   = 'unpin',
}
