-- E-mail within the Resend Free plan (owner decision 2026-11-24: 100 e-mails a day, 3,000 a month, never upgrade).
-- Additive only: one enum value (EmailDeliveryStatus DISCARDED), one new enum (EmailPriority), four nullable columns on
-- EmailDelivery (priority, kind, linkExpiresAt, linkTokenId), one small table (EmailSendingState: the shared provider
-- pause) and four indexes for the budget counts and the priority claim. No existing row is changed: rows queued
-- before this migration keep NULL priority/kind and the worker classifies them (src/email/email-kinds.ts).
-- Rollback: docs/migrations/20261231000000_email_free_plan.rollback.sql
-- IF NOT EXISTS: the rollback cannot drop an enum value (PostgreSQL), so a re-deploy after a rollback must not add
-- DISCARDED again.

-- AlterEnum
ALTER TYPE "EmailDeliveryStatus" ADD VALUE IF NOT EXISTS 'DISCARDED';

-- CreateEnum
CREATE TYPE "EmailPriority" AS ENUM ('CRITICAL', 'NORMAL', 'BULK');

-- AlterTable
ALTER TABLE "EmailDelivery" ADD COLUMN     "kind" TEXT,
ADD COLUMN     "linkExpiresAt" TIMESTAMP(3),
ADD COLUMN     "linkTokenId" TEXT,
ADD COLUMN     "priority" "EmailPriority";

-- CreateTable
CREATE TABLE "EmailSendingState" (
    "key" TEXT NOT NULL,
    "pausedUntil" TIMESTAMP(3),
    "pauseReason" TEXT,
    "lastProviderError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSendingState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "NotificationOutbox_status_sentAt_idx" ON "NotificationOutbox"("status", "sentAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_attemptedAt_idx" ON "EmailDelivery"("status", "attemptedAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_priority_nextAttemptAt_idx" ON "EmailDelivery"("status", "priority", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_recipientId_status_idx" ON "EmailDelivery"("recipientId", "status");
