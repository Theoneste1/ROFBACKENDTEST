-- ADDITIVE (approved 2026-11-06): messages from the public contact form.
-- Creates one enum and one table; no existing table or row is changed.

-- CreateEnum
CREATE TYPE "ContactMessageStatus" AS ENUM ('NEW', 'HANDLED');

-- CreateTable
CREATE TABLE "ContactMessage" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ContactMessageStatus" NOT NULL DEFAULT 'NEW',
    "notification" TEXT NOT NULL,
    "ipHash" TEXT,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactMessage_status_createdAt_idx" ON "ContactMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContactMessage_email_createdAt_idx" ON "ContactMessage"("email", "createdAt");

-- CreateIndex
CREATE INDEX "ContactMessage_ipHash_createdAt_idx" ON "ContactMessage"("ipHash", "createdAt");
