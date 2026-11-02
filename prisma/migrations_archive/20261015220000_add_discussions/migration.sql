-- Migration: add_discussions
--
-- Adds CommentStatus enum, ReactionType enum, Comment table, and
-- CommentReaction table for course and assignment discussions.
--
-- Design: a single Comment table targets either a Course or an Assignment
-- via two nullable FKs (exactly one non-null, enforced in the service layer).
-- Self-referential parentId supports one level of threaded replies.

-- ─── 1. Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE "CommentStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'DELETED');
CREATE TYPE "ReactionType"  AS ENUM ('LIKE', 'HELPFUL', 'CONFUSED');

-- ─── 2. Comment table ─────────────────────────────────────────────────────────
CREATE TABLE "Comment" (
    "id"            TEXT            NOT NULL,
    "content"       TEXT            NOT NULL,
    "status"        "CommentStatus" NOT NULL DEFAULT 'ACTIVE',
    "courseId"      TEXT,
    "assignmentId"  TEXT,
    "parentId"      TEXT,
    "authorId"      TEXT            NOT NULL,
    "moderatedAt"   TIMESTAMP(3),
    "moderatedById" TEXT,
    "createdAt"     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Comment_courseId_idx"     ON "Comment"("courseId");
CREATE INDEX "Comment_assignmentId_idx" ON "Comment"("assignmentId");
CREATE INDEX "Comment_authorId_idx"     ON "Comment"("authorId");
CREATE INDEX "Comment_parentId_idx"     ON "Comment"("parentId");
CREATE INDEX "Comment_status_idx"       ON "Comment"("status");

-- Self-referential FK for replies
ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "Comment"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_moderatedById_fkey"
    FOREIGN KEY ("moderatedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. CommentReaction table ─────────────────────────────────────────────────
CREATE TABLE "CommentReaction" (
    "id"        TEXT           NOT NULL,
    "commentId" TEXT           NOT NULL,
    "userId"    TEXT           NOT NULL,
    "type"      "ReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentReaction_pkey" PRIMARY KEY ("id")
);

-- Prevent the same user from adding the same reaction type twice
CREATE UNIQUE INDEX "CommentReaction_commentId_userId_type_key"
    ON "CommentReaction"("commentId", "userId", "type");

CREATE INDEX "CommentReaction_commentId_idx" ON "CommentReaction"("commentId");
CREATE INDEX "CommentReaction_userId_idx"    ON "CommentReaction"("userId");

ALTER TABLE "CommentReaction"
    ADD CONSTRAINT "CommentReaction_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "Comment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommentReaction"
    ADD CONSTRAINT "CommentReaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
