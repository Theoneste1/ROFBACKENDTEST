import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateCommentDto } from './dto/create-comment.dto.js';
import { UpdateCommentDto } from './dto/update-comment.dto.js';
import { ReactCommentDto } from './dto/react-comment.dto.js';
import { ListCommentsDto } from './dto/list-comments.dto.js';
import type { CallerCtx } from '../submissions/submissions.service.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

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

// ─── Comment shape returned to callers ───────────────────────────────────────

const COMMENT_SELECT = {
  id:         true,
  content:    true,
  status:     true,
  parentId:   true,
  createdAt:  true,
  updatedAt:  true,
  author:     { select: AUTHOR_SELECT },
  reactions: {
    select: {
      id:   true,
      type: true,
      user: { select: { id: true, username: true } },
    },
  },
  _count: { select: { replies: true } },
} as const;

@Injectable()
export class DiscussionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // List top-level comments (threaded, paginated)
  // ═══════════════════════════════════════════════════════════════════════════

  /** List top-level comments on a course. */
  async listCourseComments(courseId: string, caller: CallerCtx, query: ListCommentsDto) {
    await this.assertCourseAccess(courseId, caller);
    return this.listTopLevel({ courseId }, caller, query);
  }

  /** List top-level comments on an assignment. */
  async listAssignmentComments(assignmentId: string, caller: CallerCtx, query: ListCommentsDto) {
    await this.assertAssignmentAccess(assignmentId, caller);
    return this.listTopLevel({ assignmentId }, caller, query);
  }

  /** List replies to a specific comment. */
  async listReplies(commentId: string, caller: CallerCtx, query: ListCommentsDto) {
    const parent = await this.requireComment(commentId);
    // Check access to the parent comment's target.
    if (parent.courseId)     await this.assertCourseAccess(parent.courseId, caller);
    if (parent.assignmentId) await this.assertAssignmentAccess(parent.assignmentId, caller);

    const page  = query.page  ?? 1;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const skip  = (page - 1) * limit;

    // Replies to replies are not supported (one level of nesting).
    // Only show replies that belong directly to this parent.
    const [replies, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where:   { parentId: commentId, ...this.visibleFilter(caller) },
        orderBy: { createdAt: 'asc' },
        skip,
        take:    limit,
        select:  COMMENT_SELECT,
      }),
      this.prisma.comment.count({
        where: { parentId: commentId, ...this.visibleFilter(caller) },
      }),
    ]);

    return {
      data: replies.map((r) => this.sanitizeComment(r, caller)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Create
  // ═══════════════════════════════════════════════════════════════════════════

  /** Post a comment on a course. */
  async createCourseComment(courseId: string, dto: CreateCommentDto, caller: CallerCtx) {
    await this.assertCourseAccess(courseId, caller);
    return this.createComment({ courseId }, dto, caller);
  }

  /** Post a comment on an assignment. */
  async createAssignmentComment(assignmentId: string, dto: CreateCommentDto, caller: CallerCtx) {
    await this.assertAssignmentAccess(assignmentId, caller);
    return this.createComment({ assignmentId }, dto, caller);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Edit
  // ═══════════════════════════════════════════════════════════════════════════

  /** Edit own comment content. Admin may edit any comment. */
  async update(commentId: string, dto: UpdateCommentDto, caller: CallerCtx) {
    const comment = await this.requireComment(commentId);
    this.assertCommentEditAccess(comment, caller);

    if (comment.status !== 'ACTIVE') {
      throw new BadRequestException('Only ACTIVE comments can be edited.');
    }

    const updated = await this.prisma.comment.update({
      where:  { id: commentId },
      data:   { content: dto.content },
      select: COMMENT_SELECT,
    });

    return this.sanitizeComment(updated, caller);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete (soft — preserves thread structure)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Soft-delete own comment (sets status to DELETED). */
  async remove(commentId: string, caller: CallerCtx) {
    const comment = await this.requireComment(commentId);
    this.assertCommentEditAccess(comment, caller);

    if (comment.status === 'DELETED') {
      throw new BadRequestException('Comment is already deleted.');
    }

    await this.prisma.comment.update({
      where: { id: commentId },
      data:  { status: 'DELETED', content: '[deleted]' },
    });

    return { message: 'Comment deleted.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Moderation (Admin only)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Admin: hide a comment from public view. */
  async hide(commentId: string, caller: CallerCtx) {
    const comment = await this.requireComment(commentId);

    if (comment.status === 'HIDDEN') {
      throw new BadRequestException('Comment is already hidden.');
    }
    if (comment.status === 'DELETED') {
      throw new BadRequestException('Cannot hide a deleted comment.');
    }

    const updated = await this.prisma.comment.update({
      where:  { id: commentId },
      data:   { status: 'HIDDEN', moderatedAt: new Date(), moderatedById: caller.id },
      select: COMMENT_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'HIDE_COMMENT',
      entity:    'Comment',
      entityId:  commentId,
    });

    return this.sanitizeComment(updated, caller);
  }

  /** Admin: restore a hidden comment. */
  async restore(commentId: string, caller: CallerCtx) {
    const comment = await this.requireComment(commentId);

    if (comment.status !== 'HIDDEN') {
      throw new BadRequestException('Only HIDDEN comments can be restored.');
    }

    const updated = await this.prisma.comment.update({
      where:  { id: commentId },
      data:   { status: 'ACTIVE', moderatedAt: null, moderatedById: null },
      select: COMMENT_SELECT,
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'RESTORE_COMMENT',
      entity:    'Comment',
      entityId:  commentId,
    });

    return this.sanitizeComment(updated, caller);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reactions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a reaction to a comment. Idempotent — reacting with the same type
   * a second time removes the reaction (toggle behaviour).
   */
  async react(commentId: string, dto: ReactCommentDto, caller: CallerCtx) {
    const comment = await this.requireComment(commentId);

    if (comment.status !== 'ACTIVE') {
      throw new BadRequestException('Cannot react to a hidden or deleted comment.');
    }

    // Check access to the comment's parent content.
    if (comment.courseId)     await this.assertCourseAccess(comment.courseId, caller);
    if (comment.assignmentId) await this.assertAssignmentAccess(comment.assignmentId, caller);

    const existing = await this.prisma.commentReaction.findUnique({
      where: {
        commentId_userId_type: { commentId, userId: caller.id, type: dto.type },
      },
    });

    if (existing) {
      // Toggle off — remove the reaction.
      await this.prisma.commentReaction.delete({ where: { id: existing.id } });
      return { reacted: false, type: dto.type };
    }

    await this.prisma.commentReaction.create({
      data: {
        id:        randomUUID(),
        commentId,
        userId:    caller.id,
        type:      dto.type,
      },
    });

    return { reacted: true, type: dto.type };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async listTopLevel(
    target:  { courseId?: string; assignmentId?: string },
    caller:  CallerCtx,
    query:   ListCommentsDto,
  ) {
    const page  = query.page  ?? 1;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const skip  = (page - 1) * limit;

    const where = {
      ...target,
      parentId: null,
      ...this.visibleFilter(caller),
    };

    const [comments, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take:    limit,
        select:  COMMENT_SELECT,
      }),
      this.prisma.comment.count({ where }),
    ]);

    return {
      data: comments.map((c) => this.sanitizeComment(c, caller)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private async createComment(
    target:  { courseId?: string; assignmentId?: string },
    dto:     CreateCommentDto,
    caller:  CallerCtx,
  ) {
    let parentId: string | null = null;

    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: dto.parentId },
      });
      if (!parent) {
        throw new NotFoundException('Parent comment not found.');
      }
      // Verify parent belongs to the same target.
      const targetKey = 'courseId' in target ? 'courseId' : 'assignmentId';
      if ((parent as any)[targetKey] !== (target as any)[targetKey]) {
        throw new BadRequestException('Parent comment belongs to a different target.');
      }
      // Replies to replies not supported.
      if (parent.parentId !== null) {
        throw new BadRequestException('Replies to replies are not supported.');
      }
      if (parent.status !== 'ACTIVE') {
        throw new BadRequestException('Cannot reply to a hidden or deleted comment.');
      }
      parentId = dto.parentId;
    }

    const comment = await this.prisma.comment.create({
      data: {
        id:       randomUUID(),
        content:  dto.content,
        status:   'ACTIVE',
        ...target,
        parentId,
        authorId: caller.id,
      },
      select: COMMENT_SELECT,
    });

    return this.sanitizeComment(comment, caller);
  }

  /**
   * Status filter for comments:
   * - ADMIN sees ACTIVE + HIDDEN (not DELETED).
   * - Everyone else sees ACTIVE only.
   */
  private visibleFilter(caller: CallerCtx): Record<string, unknown> {
    return caller.role === 'ADMIN'
      ? { status: { in: ['ACTIVE', 'HIDDEN'] } }
      : { status: 'ACTIVE' };
  }

  /**
   * For DELETED comments: replace content with placeholder.
   * Admin sees the moderation fields; others do not.
   */
  private sanitizeComment(comment: any, caller: CallerCtx) {
    const base = {
      id:        comment.id,
      content:   comment.status === 'DELETED' ? '[deleted]' : comment.content,
      status:    comment.status,
      parentId:  comment.parentId,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author:    comment.status === 'DELETED' ? null : comment.author,
      reactions: comment.reactions ?? [],
      replyCount: comment._count?.replies ?? 0,
    };

    if (caller.role === 'ADMIN' && comment.status === 'HIDDEN') {
      return { ...base, moderatedAt: comment.moderatedAt };
    }

    return base;
  }

  private async requireComment(id: string) {
    const c = await this.prisma.comment.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Comment not found.');
    return c;
  }

  private assertCommentEditAccess(
    comment: { authorId: string; status: string },
    caller: CallerCtx,
  ) {
    if (caller.role === 'ADMIN') return;
    if (comment.authorId !== caller.id) {
      throw new ForbiddenException('You can only edit your own comments.');
    }
  }

  /**
   * Check that the caller may access the course discussion.
   * - ADMIN: always.
   * - Course creator: always (even unpublished).
   * - Others: only on PUBLISHED courses.
   */
  private async assertCourseAccess(courseId: string, caller: CallerCtx) {
    if (caller.role === 'ADMIN') return;

    const course = await this.prisma.course.findUnique({
      where:  { id: courseId },
      select: { status: true, createdById: true },
    });
    if (!course) throw new NotFoundException('Course not found.');

    if (course.createdById === caller.id) return;

    if (course.status !== 'PUBLISHED') {
      throw new NotFoundException('Course not found.');
    }
  }

  /**
   * Check that the caller may access the assignment discussion.
   * - ADMIN: always.
   * - Assignment creator: always (even unpublished).
   * - Others: only on PUBLISHED assignments.
   */
  private async assertAssignmentAccess(assignmentId: string, caller: CallerCtx) {
    if (caller.role === 'ADMIN') return;

    const assignment = await this.prisma.assignment.findUnique({
      where:  { id: assignmentId },
      select: { status: true, createdById: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found.');

    if (assignment.createdById === caller.id) return;

    if (assignment.status !== 'PUBLISHED') {
      throw new NotFoundException('Assignment not found.');
    }
  }
}
