-- Additive only: no existing data is changed or removed.
--   Assignment.deadlineRemindedFor: the deadline a "due soon" reminder was sent for.
--   Notification.link: the frontend path a notification opens.
--   Notification (userId, createdAt) index: the inbox query, newest first.

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "deadlineRemindedFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "link" TEXT;

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
