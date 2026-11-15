-- Bulk user operations (2026-11-17): an operation and one item per selected account. Additive only: two enums,
-- two tables, indexes (incl. User.createdAt and User.gradeLevel for the list filters). No existing row changes.
-- (operationId, userId) is unique, so an account is processed, and notified, at most once per operation.
-- Rollback: docs/migrations/20261207000000_bulk_operations.rollback.sql

-- CreateEnum
CREATE TYPE "BulkOperationStatus" AS ENUM ('PENDING', 'RUNNING', 'CANCELLING', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BulkItemOutcome" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "BulkOperation" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "selection" JSONB NOT NULL,
    "selectionToken" TEXT NOT NULL,
    "reason" TEXT,
    "status" "BulkOperationStatus" NOT NULL DEFAULT 'PENDING',
    "total" INTEGER NOT NULL,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "emailJobId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkOperationItem" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outcome" "BulkItemOutcome" NOT NULL DEFAULT 'PENDING',
    "code" TEXT,
    "message" TEXT,
    "stillBlockedBy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "claimToken" TEXT,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BulkOperationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BulkOperation_emailJobId_key" ON "BulkOperation"("emailJobId");

-- CreateIndex
CREATE INDEX "BulkOperation_status_createdAt_idx" ON "BulkOperation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BulkOperation_actorId_createdAt_idx" ON "BulkOperation"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkOperation_actorId_idempotencyKey_key" ON "BulkOperation"("actorId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BulkOperationItem_operationId_outcome_idx" ON "BulkOperationItem"("operationId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "BulkOperationItem_operationId_userId_key" ON "BulkOperationItem"("operationId", "userId");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "User_gradeLevel_idx" ON "User"("gradeLevel");

-- AddForeignKey
ALTER TABLE "BulkOperation" ADD CONSTRAINT "BulkOperation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkOperationItem" ADD CONSTRAINT "BulkOperationItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "BulkOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

