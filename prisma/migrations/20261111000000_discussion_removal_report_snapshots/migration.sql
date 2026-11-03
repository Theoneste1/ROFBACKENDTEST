-- Additive only: no existing data is changed or removed.
--   ThreadStatus.DELETED + DiscussionThread.deletedAt: threads can be removed
--   (by their author or an administrator) and stay on record for moderation.
--   Comment.deletedAt records when a comment was removed.
--   ModerationActionType.DELETE_THREAD records an administrator's removal.
--   ContentReport.contentSnapshot keeps the reported text as it was.
--   NotificationCategory.DISCUSSIONS lets users manage discussion e-mails.

-- AlterEnum
ALTER TYPE "ModerationActionType" ADD VALUE 'DELETE_THREAD';

-- AlterEnum
ALTER TYPE "NotificationCategory" ADD VALUE 'DISCUSSIONS';

-- AlterEnum
ALTER TYPE "ThreadStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ContentReport" ADD COLUMN     "contentSnapshot" TEXT;

-- AlterTable
ALTER TABLE "DiscussionThread" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- Backfill: comments already deleted get their last update as the removal time.
UPDATE "Comment" SET "deletedAt" = "updatedAt" WHERE "status" = 'DELETED' AND "deletedAt" IS NULL;
