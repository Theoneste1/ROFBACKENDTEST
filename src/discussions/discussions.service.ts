import {
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { Prisma } from '../generated/prisma/client.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';

// ─── Safe author select ───────────────────────────────────────────────────────
// Return only public profile fields — never email, passwordHash, etc.

const AUTHOR_SELECT = {
  id:        true,
  username:  true,
  firstName: true,
  lastName:  true,
  avatarUrl: true,
  role:      true,
} as const;

const COMMENT_SELECT = {
  id:          true,
  content:     true,
  status:      true,
  parentId:    true,
  divisionId:  true,
  createdAt:   true,
  updatedAt:   true,
  moderatedAt: true,
  author:      { select: AUTHOR_SELECT },
  reactions:   { select: { type: true, userId: true } },
  _count:      { select: { replies: { where: { status: 'ACTIVE' as const } } } },
} as const;

type Target = { courseId: string; divisionId: string } | { assignmentId: string; divisionId: string };

/**
 * Course and assignment discussions.
 *
 * Course threads are separate per division (Junior and Senior never see each
 * other's course discussion). Assignment threads inherit the assignment's
 * division. Visibility follows AccessService: students in their division on
 * published content, mentors in their assigned scopes, admins everywhere.
 */
@Injectable()
export class DiscussionsService {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly audit:   AuditService,
    private readonly access:  AccessService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // List
  // ═══════════════════════════════════════════════════════════════════════════

  async listCourseComments(courseId: string, user: AuthUser, query: ListCommentsDto) {
    const target = await this.courseTarget(courseId, user, query.divisionId);
    return this.listTopLevel(target, user, query);
  }

  async listAssignmentComments(assignmentId: string, user: AuthUser, query: ListCommentsDto) {
    const target = await this.assignmentTarget(assignmentId, user);
    return this.listTopLevel(target, user, query);
  }

  /** Replies to a comment (one level of nesting). */
  async listReplies(commentId: string, user: AuthUser, query: ListCommentsDto) {
    const parent = await this.requireComment(commentId);
    await this.assertCanSeeComment(parent, user);

    const { page, limit, skip, take } = pageArgs(query);
    const where = { parentId: commentId, ...this.visibleFilter(user) };
    const [replies, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take, select: COMMENT_SELECT }),
      this.prisma.comment.count({ where }),
    ]);
    return paginated(replies.map((r) => this.sanitizeComment(r, user)), total, page, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Create
  // ═══════════════════════════════════════════════════════════════════════════

  async createCourseComment(courseId: string, dto: CreateCommentDto, user: AuthUser) {
    const target = await this.courseTarget(courseId, user, dto.divisionId, true);
    return this.createComment(target, dto, user);
  }

  async createAssignmentComment(assignmentId: string, dto: CreateCommentDto, user: AuthUser) {
    const target = await this.assignmentTarget(assignmentId, user);
    return this.createComment(target, dto, user);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Edit / delete (authors only; admins moderate with hide/restore/delete)
  // ═══════════════════════════════════════════════════════════════════════════

  async update(commentId: string, dto: UpdateCommentDto, user: AuthUser) {
    const comment = await this.requireComment(commentId);
    if (comment.authorId !== user.id) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'You can only edit your own comments.');
    }
    await this.assertCanSeeComment(comment, user);
    if (comment.status !== 'ACTIVE') throw invalidState('Only active comments can be edited.');

    const updated = await this.prisma.comment.update({
      where:  { id: commentId },
      data:   { content: dto.content },
      select: COMMENT_SELECT,
    });
    return this.sanitizeComment(updated, user);
  }

  /** Soft delete: content is replaced so the thread structure is preserved. */
  async remove(commentId: string, user: AuthUser) {
    const comment = await this.requireComment(commentId);
    const isAuthor = comment.authorId === user.id;
    if (!isAuthor && user.role !== 'ADMIN') {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_AUTHOR', 'You can only delete your own comments.');
    }
    if (isAuthor) await this.assertCanSeeComment(comment, user);
    if (comment.status === 'DELETED') throw invalidState('Comment is already deleted.');

    await this.prisma.comment.update({
      where: { id: commentId },
      data:  { status: 'DELETED', content: '[deleted]' },
    });

    if (!isAuthor) {
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'DELETE_COMMENT', entity: 'Comment', entityId: commentId,
        metadata: { authorId: comment.authorId },
      });
    }
    return { message: 'Comment deleted.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Moderation (Admin only)
  // ═══════════════════════════════════════════════════════════════════════════

  async hide(commentId: string, user: AuthUser) {
    const comment = await this.requireComment(commentId);
    if (comment.status === 'HIDDEN')  throw invalidState('Comment is already hidden.');
    if (comment.status === 'DELETED') throw invalidState('Cannot hide a deleted comment.');

    const updated = await this.prisma.comment.update({
      where:  { id: commentId },
      data:   { status: 'HIDDEN', moderatedAt: new Date(), moderatedById: user.id },
      select: COMMENT_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'HIDE_COMMENT', entity: 'Comment', entityId: commentId,
    });
    return this.sanitizeComment(updated, user);
  }

  async restore(commentId: string, user: AuthUser) {
    const comment = await this.requireComment(commentId);
    if (comment.status !== 'HIDDEN') throw invalidState('Only hidden comments can be restored.');

    const updated = await this.prisma.comment.update({
      where:  { id: commentId },
      data:   { status: 'ACTIVE', moderatedAt: null, moderatedById: null },
      select: COMMENT_SELECT,
    });

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'RESTORE_COMMENT', entity: 'Comment', entityId: commentId,
    });
    return this.sanitizeComment(updated, user);
  }

  /** Admin moderation queue: hidden comments across all discussions. */
  async listHidden(query: ListCommentsDto) {
    const { page, limit, skip, take } = pageArgs(query);
    const where = { status: 'HIDDEN' as const };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where, skip, take, orderBy: { moderatedAt: 'desc' },
        select: { ...COMMENT_SELECT, courseId: true, assignmentId: true, moderatedBy: { select: { id: true, username: true } } },
      }),
      this.prisma.comment.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reactions — toggle
  // ═══════════════════════════════════════════════════════════════════════════

  async react(commentId: string, dto: ReactCommentDto, user: AuthUser) {
    const comment = await this.requireComment(commentId);
    if (comment.status !== 'ACTIVE') throw invalidState('Cannot react to a hidden or deleted comment.');
    await this.assertCanSeeComment(comment, user);

    const key = { commentId_userId_type: { commentId, userId: user.id, type: dto.type } };
    const { count } = await this.prisma.commentReaction.deleteMany({ where: key.commentId_userId_type });
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
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve the division of a course thread.
   *   Students: always their own division.
   *   Mentors/admins: `divisionId` required when posting; when listing, admins
   *   may omit it to see every division's thread.
   */
  private async courseTarget(courseId: string, user: AuthUser, divisionId: string | undefined, forWrite = false) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { id: true } });
    if (!course) throw new NotFoundException('Course not found.');

    const division = user.role === 'STUDENT' ? this.access.studentDivision(user) : divisionId;
    if (!division) {
      if (user.role === 'ADMIN' && !forWrite) return { courseId } as unknown as Target;
      throw new AppError(HttpStatus.BAD_REQUEST, 'DIVISION_REQUIRED', 'Specify divisionId for course discussions.');
    }
    await this.access.assertCanView(user, { courseId, divisionId: division });
    return { courseId, divisionId: division };
  }

  private async assignmentTarget(assignmentId: string, user: AuthUser): Promise<Target> {
    const a = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { id: true, courseId: true, divisionId: true, status: true },
    });
    if (!a) throw new NotFoundException('Assignment not found.');
    await this.access.assertCanView(user, a);
    if (user.role === 'STUDENT' && a.status !== 'PUBLISHED') throw new NotFoundException('Assignment not found.');
    return { assignmentId, divisionId: a.divisionId };
  }

  /** Re-check access to the thread a comment belongs to; hidden/deleted parents block non-admins. */
  private async assertCanSeeComment(
    comment: { courseId: string | null; assignmentId: string | null; divisionId: string; status: string },
    user: AuthUser,
  ) {
    if (comment.courseId) {
      await this.access.assertCanView(user, { courseId: comment.courseId, divisionId: comment.divisionId });
    } else if (comment.assignmentId) {
      await this.assignmentTarget(comment.assignmentId, user);
    }
    if (user.role !== 'ADMIN' && comment.status === 'HIDDEN') {
      throw new NotFoundException('Comment not found.');
    }
  }

  private async listTopLevel(target: Target, user: AuthUser, query: ListCommentsDto) {
    const { page, limit, skip, take } = pageArgs(query);
    const where = { ...target, parentId: null, ...this.visibleFilter(user) };

    const [comments, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take, select: COMMENT_SELECT }),
      this.prisma.comment.count({ where }),
    ]);

    return paginated(comments.map((c) => this.sanitizeComment(c, user)), total, page, limit);
  }

  private async createComment(target: Target, dto: CreateCommentDto, user: AuthUser) {
    let parentId: string | null = null;

    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Parent comment not found.');

      const sameThread =
        parent.divisionId === target.divisionId &&
        ('courseId' in target ? parent.courseId === target.courseId : parent.assignmentId === target.assignmentId);
      if (!sameThread) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'WRONG_THREAD', 'Parent comment belongs to a different discussion.');
      }
      if (parent.parentId !== null) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NESTING_LIMIT', 'Replies to replies are not supported.');
      }
      if (parent.status !== 'ACTIVE') throw invalidState('Cannot reply to a hidden or deleted comment.');
      parentId = dto.parentId;
    }

    const comment = await this.prisma.comment.create({
      data:   { content: dto.content, status: 'ACTIVE', ...target, parentId, authorId: user.id },
      select: COMMENT_SELECT,
    });

    return this.sanitizeComment(comment, user);
  }

  /** Admins see ACTIVE + HIDDEN (not DELETED); everyone else ACTIVE only. */
  private visibleFilter(user: AuthUser): Prisma.CommentWhereInput {
    return user.role === 'ADMIN'
      ? { status: { in: ['ACTIVE', 'HIDDEN'] } }
      : { status: 'ACTIVE' };
  }

  private sanitizeComment(comment: Prisma.CommentGetPayload<{ select: typeof COMMENT_SELECT }>, user: AuthUser) {
    const counts: Record<string, number> = {};
    for (const r of comment.reactions) counts[r.type] = (counts[r.type] ?? 0) + 1;

    return {
      id:         comment.id,
      content:    comment.status === 'DELETED' ? '[deleted]' : comment.content,
      status:     comment.status,
      parentId:   comment.parentId,
      divisionId: comment.divisionId,
      createdAt:  comment.createdAt,
      updatedAt:  comment.updatedAt,
      author:     comment.status === 'DELETED' ? null : comment.author,
      reactions:  counts,
      myReactions: comment.reactions.filter((r) => r.userId === user.id).map((r) => r.type),
      replyCount: comment._count.replies,
      ...(user.role === 'ADMIN' && comment.status === 'HIDDEN' && { moderatedAt: comment.moderatedAt }),
    };
  }

  private async requireComment(id: string) {
    const c = await this.prisma.comment.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Comment not found.');
    return c;
  }
}
