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
 * - Authors edit and delete their own content. A thread can be deleted by its
 *   author only while nobody else has posted in it. Administrators may hide,
 *   restore or remove anything; deleted content is masked for everyone but
 *   kept for the moderation record (except an author's own comment deletion).
 * - When an admin turns a course's discussions off, its course and assignment
 *   threads stay readable but nobody can start a thread or post.
 * - Every moderation decision is recorded in ModerationAction. Acting directly
 *   on reported content also closes its open reports.
 * - Activity, reports and moderation decisions emit events that
 *   NotificationListener turns into notifications.
 *
 * There is no private or direct messaging: every message lives in a course or
 * assignment thread.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { studentCanOpenAssignment } from '../assignments/assignments.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { Events, type ContentModeratedEvent } from '../notifications/events.js';
import { Prisma, type ModerationActionType, type ThreadStatus } from '../generated/prisma/client.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import {
  CreateThreadDto,
  ListModerationActionsDto,
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
  divisionId: true, lastActivityAt: true, archivedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
  createdBy: { select: AUTHOR_SELECT },
  _count:    { select: { comments: { where: { status: 'ACTIVE' as const } } } },
} as const;

const COMMENT_SELECT = {
  id: true, threadId: true, content: true, status: true, parentId: true,
  editedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
  author:    { select: AUTHOR_SELECT },
  reactions: { select: { type: true, userId: true } },
  _count:    { select: { replies: { where: { status: 'ACTIVE' as const } } } },
} as const;

const REPORT_THREAD_SELECT = {
  id: true, title: true, status: true, courseId: true, assignmentId: true, divisionId: true, deletedAt: true,
  createdBy: { select: AUTHOR_SELECT },
} as const;

const REPORT_INCLUDE = {
  reporter:   { select: AUTHOR_SELECT },
  resolvedBy: { select: AUTHOR_SELECT },
  thread:     { select: REPORT_THREAD_SELECT },
  comment:    {
    select: {
      id: true, content: true, status: true, editedAt: true, deletedAt: true,
      author: { select: AUTHOR_SELECT },
      thread: { select: REPORT_THREAD_SELECT },
    },
  },
} as const;

type Thread = {
  id: string; title: string; courseId: string | null; assignmentId: string | null; divisionId: string;
  status: ThreadStatus; createdById: string;
};

/** Thread statuses listed by default (DELETED only on request, admins only). */
const LISTED_STATUSES: Record<'ADMIN' | 'OTHER', ThreadStatus[]> = {
  ADMIN: ['OPEN', 'LOCKED', 'HIDDEN'],
  OTHER: ['OPEN', 'LOCKED'],
};

@Injectable()
export class DiscussionsService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly access:    AccessService,
    private readonly activity:  ActivityService,
    private readonly events:    EventEmitter2,
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
    if (thread.createdById !== user.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'Only the author can edit this thread.');
    }
    if (thread.status !== 'OPEN') throw invalidState('Only open threads can be edited.');
    return this.prisma.discussionThread.update({ where: { id: threadId }, data: { title: dto.title }, select: THREAD_SELECT });
  }

  /**
   * Delete a thread.
   *   Author: only while nobody else has posted in it (other people's messages
   *           are not theirs to remove), and not once it is archived.
   *   Admin:  any thread; recorded as a moderation action and closes its open reports.
   * The thread disappears for everyone but administrators.
   */
  async deleteThread(threadId: string, user: AuthUser, reason?: string) {
    const thread = await this.requireVisibleThread(threadId, user);
    if (thread.status === 'DELETED') throw invalidState('Thread is already deleted.');
    const isAuthor = thread.createdById === user.id;
    const asModerator = user.role === 'ADMIN' && !isAuthor;

    if (!asModerator) {
      if (!isAuthor) throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'Only the author can delete this thread.');
      if (thread.status === 'ARCHIVED') throw invalidState('Archived threads cannot be deleted.');
      const others = await this.prisma.comment.count({
        where: { threadId, authorId: { not: user.id }, status: { not: 'DELETED' } },
      });
      if (others > 0) {
        throw new AppError(HttpStatus.CONFLICT, 'THREAD_HAS_REPLIES',
          'Others have posted in this thread; ask an administrator to remove it.');
      }
    }

    const closed = await this.prisma.$transaction(async (tx) => {
      await tx.discussionThread.update({ where: { id: threadId }, data: { status: 'DELETED', deletedAt: new Date() } });
      if (!asModerator) return [];
      await this.recordAction(tx, user, 'DELETE_THREAD', { threadId, reason });
      return this.closeOpenReports(tx, { threadId }, user, reason);
    });
    if (asModerator) this.emitModerated({ action: 'DELETE_THREAD', threadId, reason }, closed);
    return { message: 'Thread deleted.' };
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
    this.events.emit(Events.DiscussionCommentPosted, { commentId: comment.id });
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

  /**
   * Soft delete: the comment stays in place (replies keep their parent) but is
   * shown as "[deleted]". An author's own deletion erases the text; an
   * administrator's removal keeps it for the moderation record.
   */
  async removeComment(commentId: string, user: AuthUser, reason?: string) {
    const comment = await this.requireVisibleComment(commentId, user);
    const isAuthor = comment.authorId === user.id;
    if (!isAuthor && user.role !== 'ADMIN') {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'You can only delete your own comments.');
    }
    if (comment.status === 'DELETED') throw invalidState('Comment is already deleted.');

    const closed = await this.prisma.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: commentId },
        data:  { status: 'DELETED', deletedAt: new Date(), ...(isAuthor && { content: '[deleted]' }) },
      });
      if (isAuthor) return [];
      await this.recordAction(tx, user, 'DELETE_COMMENT', { commentId, threadId: comment.threadId, reason });
      return this.closeOpenReports(tx, { commentId }, user, reason);
    });
    if (!isAuthor) this.emitModerated({ action: 'DELETE_COMMENT', commentId, threadId: comment.threadId, reason }, closed);
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
    const thread = await this.requireVisibleThread(threadId, user);
    if (thread.createdById === user.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_REPORT_OWN', 'You cannot report your own thread.');
    }
    if (thread.status === 'DELETED') throw invalidState('This thread has been deleted.');
    return this.createReport({ threadId }, thread.title, dto, user);
  }

  async reportComment(commentId: string, dto: ReportContentDto, user: AuthUser) {
    const comment = await this.requireVisibleComment(commentId, user);
    if (comment.authorId === user.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_REPORT_OWN', 'You cannot report your own comment.');
    }
    if (comment.status === 'DELETED') throw invalidState('This comment has been deleted.');
    return this.createReport({ commentId }, comment.content, dto, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Moderation (ADMIN)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Report queue: open reports by default, oldest first. */
  async listReports(q: ListReportsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.ContentReportWhereInput = {
      status: q.status ?? 'OPEN',
      ...(q.reason && { reason: q.reason }),
      ...(q.targetType === 'THREAD'  && { threadId:  { not: null } }),
      ...(q.targetType === 'COMMENT' && { commentId: { not: null } }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contentReport.findMany({ where, skip, take, orderBy: { createdAt: 'asc' }, include: REPORT_INCLUDE }),
      this.prisma.contentReport.count({ where }),
    ]);
    return paginated(rows.map((r) => this.reportView(r)), total, page, limit);
  }

  /**
   * One report with everything needed to decide: the reported item as it is
   * now and as it was reported, where it was posted, every other report about
   * it, and the moderation already taken on it.
   */
  async getReport(reportId: string) {
    const report = await this.prisma.contentReport.findUnique({ where: { id: reportId }, include: REPORT_INCLUDE });
    if (!report) throw new NotFoundException('Report not found.');
    const target = report.commentId ? { commentId: report.commentId } : { threadId: report.threadId! };

    const [otherReports, actions] = await this.prisma.$transaction([
      this.prisma.contentReport.findMany({
        where:   { ...target, id: { not: report.id } },
        orderBy: { createdAt: 'asc' },
        select:  { id: true, reason: true, details: true, status: true, createdAt: true, reporter: { select: AUTHOR_SELECT } },
      }),
      this.prisma.moderationAction.findMany({
        where:   target,
        orderBy: { createdAt: 'asc' },
        select:  { id: true, action: true, reason: true, reportId: true, createdAt: true, moderator: { select: AUTHOR_SELECT } },
      }),
    ]);
    return { ...this.reportView(report), otherReports, moderationHistory: actions };
  }

  /**
   * Resolve a report by acting on the reported item (HIDE, DELETE, LOCK) or by
   * dismissing it (NONE). Other open reports about the same item are closed
   * with the same outcome.
   */
  async resolveReport(reportId: string, dto: ResolveReportDto, user: AuthUser) {
    const report = await this.prisma.contentReport.findUnique({
      where:   { id: reportId },
      include: { thread: { select: { status: true } }, comment: { select: { status: true, threadId: true } } },
    });
    if (!report) throw new NotFoundException('Report not found.');
    if (report.status !== 'OPEN') throw invalidState('This report has already been handled.');
    if (dto.action === 'LOCK' && !report.threadId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_ACTION', 'Only threads can be locked.');
    }
    const current = report.comment?.status ?? report.thread?.status;
    if (dto.action !== 'NONE' && current === 'DELETED') {
      throw invalidState('The reported content has already been removed; dismiss the report instead.');
    }

    const target = report.commentId
      ? { commentId: report.commentId, threadId: report.comment!.threadId }
      : { threadId: report.threadId! };
    let action: ModerationActionType = 'DISMISS_REPORT';
    const closed = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (dto.action === 'HIDE') {
        action = report.commentId ? 'HIDE_COMMENT' : 'HIDE_THREAD';
        if (report.commentId) await tx.comment.update({ where: { id: report.commentId }, data: { status: 'HIDDEN' } });
        else await tx.discussionThread.update({ where: { id: report.threadId! }, data: { status: 'HIDDEN' } });
      } else if (dto.action === 'DELETE') {
        // The text is kept (masked for everyone) so the decision can be audited.
        action = report.commentId ? 'DELETE_COMMENT' : 'DELETE_THREAD';
        if (report.commentId) await tx.comment.update({ where: { id: report.commentId }, data: { status: 'DELETED', deletedAt: now } });
        else await tx.discussionThread.update({ where: { id: report.threadId! }, data: { status: 'DELETED', deletedAt: now } });
      } else if (dto.action === 'LOCK') {
        action = 'LOCK_THREAD';
        await tx.discussionThread.update({ where: { id: report.threadId! }, data: { status: 'LOCKED' } });
      }

      await this.recordAction(tx, user, action, { ...target, reportId, reason: dto.note });
      return this.closeOpenReports(tx, report.commentId ? { commentId: report.commentId } : { threadId: report.threadId! },
        user, dto.note, dto.action === 'NONE' ? 'DISMISSED' : 'RESOLVED');
    });

    if (dto.action !== 'NONE') this.emitModerated({ action, ...target, reason: dto.note }, closed);
    else this.events.emit(Events.ReportsResolved, { reportIds: closed, actionTaken: false });
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

    const live: ThreadStatus[] = ['OPEN', 'LOCKED', 'HIDDEN', 'ARCHIVED'];
    const plan: Record<ThreadModerationOp, { from: ThreadStatus[]; data: Prisma.DiscussionThreadUpdateInput; action: ModerationActionType }> = {
      lock:    { from: ['OPEN'],             data: { status: 'LOCKED' },                       action: 'LOCK_THREAD' },
      unlock:  { from: ['LOCKED'],           data: { status: 'OPEN' },                         action: 'UNLOCK_THREAD' },
      hide:    { from: ['OPEN', 'LOCKED'],   data: { status: 'HIDDEN' },                       action: 'HIDE_THREAD' },
      restore: { from: ['HIDDEN'],           data: { status: 'OPEN' },                         action: 'RESTORE_THREAD' },
      archive: { from: ['OPEN', 'LOCKED'],   data: { status: 'ARCHIVED', archivedAt: new Date() }, action: 'ARCHIVE_THREAD' },
      pin:     { from: live,                 data: { isPinned: true },                         action: 'PIN_THREAD' },
      unpin:   { from: live,                 data: { isPinned: false },                        action: 'UNPIN_THREAD' },
    };
    const step = plan[op];
    if (!step.from.includes(thread.status)) {
      throw invalidState(`Cannot ${op} a thread that is ${thread.status}.`);
    }

    const { row, closed } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.discussionThread.update({ where: { id: threadId }, data: step.data, select: THREAD_SELECT });
      await this.recordAction(tx, user, step.action, { threadId, reason });
      return { row, closed: op === 'hide' ? await this.closeOpenReports(tx, { threadId }, user, reason) : [] };
    });
    if (op === 'hide' || op === 'restore') this.emitModerated({ action: step.action, threadId, reason }, closed);
    return row;
  }

  /** Every moderation decision, newest first; filter by action, moderator, thread or comment. */
  async listModerationActions(q: ListModerationActionsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.ModerationActionWhereInput = {
      ...(q.action      && { action: q.action }),
      ...(q.moderatorId && { moderatorId: q.moderatorId }),
      ...(q.threadId    && { threadId: q.threadId }),
      ...(q.commentId   && { commentId: q.commentId }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.moderationAction.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: {
          moderator: { select: AUTHOR_SELECT },
          thread:    { select: { id: true, title: true, status: true } },
          comment:   { select: { id: true, content: true, status: true, author: { select: AUTHOR_SELECT } } },
          report:    { select: { id: true, reason: true, contentSnapshot: true } },
        },
      }),
      this.prisma.moderationAction.count({ where }),
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
      select: { id: true, courseId: true, divisionId: true, status: true, publishedAt: true },
    });
    if (!a) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, a);
    if (user.role === 'STUDENT' && !studentCanOpenAssignment(a)) {
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
        : { status: { in: LISTED_STATUSES[user.role === 'ADMIN' ? 'ADMIN' : 'OTHER'] } }),
    };
    if (user.role !== 'ADMIN' && (q.status === 'HIDDEN' || q.status === 'DELETED')) throw new NotFoundException('Not found.');

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
    this.events.emit(Events.DiscussionThreadCreated, { threadId: thread.id });
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
      select: { id: true, title: true, courseId: true, assignmentId: true, divisionId: true, status: true, createdById: true },
    });
    if (!thread) throw new NotFoundException('Thread not found.');

    if (thread.courseId) {
      await this.access.assertCanView(user, { courseId: thread.courseId, divisionId: thread.divisionId });
    } else if (thread.assignmentId) {
      await this.assignmentTarget(thread.assignmentId, user);
    }
    if (user.role !== 'ADMIN' && (thread.status === 'HIDDEN' || thread.status === 'DELETED')) {
      throw new NotFoundException('Thread not found.');
    }
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

  private async createReport(
    target: { threadId: string } | { commentId: string }, snapshot: string, dto: ReportContentDto, user: AuthUser,
  ) {
    try {
      const report = await this.prisma.contentReport.create({
        data:   { ...target, reporterId: user.id, reason: dto.reason, details: dto.details ?? null, contentSnapshot: snapshot },
        select: { id: true, reason: true, status: true, createdAt: true },
      });
      this.events.emit(Events.ContentReported, { reportId: report.id });
      return report;
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
    const { row, closed } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.comment.update({ where: { id: commentId }, data: { status: to }, select: COMMENT_SELECT });
      await this.recordAction(tx, user, action, { commentId, threadId: comment.threadId, reason });
      return { row, closed: to === 'HIDDEN' ? await this.closeOpenReports(tx, { commentId }, user, reason) : [] };
    });
    this.emitModerated({ action, commentId, threadId: comment.threadId, reason }, closed);
    return this.sanitizeComment(row, user);
  }

  /**
   * Close the open reports about an item once a moderator has acted on it.
   * Returns the ids of the reports closed (their reporters are told).
   */
  private async closeOpenReports(
    tx: Prisma.TransactionClient, target: { threadId: string } | { commentId: string }, user: AuthUser,
    note?: string, status: 'RESOLVED' | 'DISMISSED' = 'RESOLVED',
  ) {
    const open = await tx.contentReport.findMany({ where: { ...target, status: 'OPEN' }, select: { id: true } });
    if (open.length === 0) return [];
    const ids = open.map((r) => r.id);
    await tx.contentReport.updateMany({
      where: { id: { in: ids }, status: 'OPEN' },
      data:  { status, resolvedAt: new Date(), resolvedById: user.id, resolutionNote: note ?? null },
    });
    return ids;
  }

  /** Tell the author what was done to their content, and the reporters that action was taken. */
  private emitModerated(e: ContentModeratedEvent, closedReports: string[]) {
    this.events.emit(Events.ContentModerated, e);
    if (closedReports.length > 0) this.events.emit(Events.ReportsResolved, { reportIds: closedReports, actionTaken: true });
  }

  /** Reports as administrators review them: who, why, what was reported and where. */
  private reportView(r: Prisma.ContentReportGetPayload<{ include: typeof REPORT_INCLUDE }>) {
    const thread = r.thread ?? r.comment?.thread ?? null;
    return {
      id: r.id, reason: r.reason, details: r.details, status: r.status, createdAt: r.createdAt,
      targetType:      r.commentId ? 'COMMENT' as const : 'THREAD' as const,
      contentSnapshot: r.contentSnapshot,
      reporter:        r.reporter,
      resolvedAt:      r.resolvedAt, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote,
      thread,
      comment: r.comment && {
        id: r.comment.id, content: r.comment.content, status: r.comment.status,
        editedAt: r.comment.editedAt, deletedAt: r.comment.deletedAt, author: r.comment.author,
      },
    };
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
