-- Decision notifications (owner-approved, after teacher self-registration): the NotificationOutbox table
-- and the school verification of a missing-school Teacher application. Additive only: one enum, one table,
-- two nullable TeacherApplication columns; no existing row changes.
--
-- NotificationOutbox rows are written in the same transaction as the Administrator's action (approval,
-- school verification, permission grant); the e-mail is sent after commit and retried from this table.
--
-- Explicit transaction: everything is created together or not at all.
-- Rollback: docs/migrations/20261202000000_notification_outbox.rollback.sql

BEGIN;
-- CreateEnum
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "TeacherApplication" ADD COLUMN     "schoolVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "schoolVerifiedById" TEXT;

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "inAppNotificationId" TEXT,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_nextAttemptAt_idx" ON "NotificationOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "NotificationOutbox_recipientUserId_idx" ON "NotificationOutbox"("recipientUserId");

-- CreateIndex
CREATE INDEX "NotificationOutbox_type_createdAt_idx" ON "NotificationOutbox"("type", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationOutbox_createdAt_idx" ON "NotificationOutbox"("createdAt");

-- CreateIndex
CREATE INDEX "TeacherApplication_schoolVerifiedById_idx" ON "TeacherApplication"("schoolVerifiedById");

-- AddForeignKey
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_schoolVerifiedById_fkey" FOREIGN KEY ("schoolVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


COMMIT;
