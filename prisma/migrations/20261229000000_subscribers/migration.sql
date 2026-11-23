-- News subscribers and mailings (owner 2026-11-23): Subscriber (one row per e-mail; ACTIVE / UNSUBSCRIBED), Mailing
-- (an update to the active subscribers of an audience, delivered through the e-mail outbox) and
-- EmailDelivery.subscriberId (the worker adds that subscriber's unsubscribe link at send time). Additive only:
-- new types, new tables, one nullable column. Rollback: docs/migrations/20261229000000_subscribers.rollback.sql.

-- CreateEnum
CREATE TYPE "SubscriberKind" AS ENUM ('PARENT', 'STUDENT', 'TEACHER', 'SCHOOL', 'OTHER');

-- CreateEnum
CREATE TYPE "SubscriberSource" AS ENUM ('WEBSITE', 'ADMIN', 'IMPORT');

-- CreateEnum
CREATE TYPE "SubscriberStatus" AS ENUM ('ACTIVE', 'UNSUBSCRIBED');

-- CreateEnum
CREATE TYPE "MailingStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "EmailDelivery" ADD COLUMN     "subscriberId" TEXT;

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "kind" "SubscriberKind",
    "interests" "OlympiadSubject"[] DEFAULT ARRAY[]::"OlympiadSubject"[],
    "country" TEXT,
    "source" "SubscriberSource" NOT NULL,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'ACTIVE',
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),
    "unsubscribeReason" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailing" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "status" "MailingStatus" NOT NULL DEFAULT 'QUEUED',
    "recipientCount" INTEGER NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledCount" INTEGER NOT NULL DEFAULT 0,
    "emailJobId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,

    CONSTRAINT "Mailing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_email_key" ON "Subscriber"("email");

-- CreateIndex
CREATE INDEX "Subscriber_status_createdAt_idx" ON "Subscriber"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Subscriber_userId_idx" ON "Subscriber"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Mailing_idempotencyKey_key" ON "Mailing"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Mailing_emailJobId_key" ON "Mailing"("emailJobId");

-- CreateIndex
CREATE INDEX "Mailing_createdAt_idx" ON "Mailing"("createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_subscriberId_idx" ON "EmailDelivery"("subscriberId");

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailing" ADD CONSTRAINT "Mailing_emailJobId_fkey" FOREIGN KEY ("emailJobId") REFERENCES "EmailJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailing" ADD CONSTRAINT "Mailing_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

