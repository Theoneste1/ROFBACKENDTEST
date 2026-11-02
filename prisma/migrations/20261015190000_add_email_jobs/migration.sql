-- Migration: add_email_jobs
--
-- Adds EmailJob and EmailDelivery tables for bulk email tracking.
-- Bodies are stored in the DB (for retry support) but are never written to
-- audit logs.

-- ─── 1. Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE "EmailJobStatus" AS ENUM (
  'PENDING', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL_FAILURE', 'FAILED'
);

CREATE TYPE "EmailDeliveryStatus" AS ENUM (
  'PENDING', 'SENT', 'FAILED'
);

-- ─── 2. EmailJob ──────────────────────────────────────────────────────────────
CREATE TABLE "EmailJob" (
    "id"               TEXT            NOT NULL,
    "idempotencyKey"   TEXT            NOT NULL,
    "subject"          TEXT            NOT NULL,
    "body"             TEXT            NOT NULL,
    "status"           "EmailJobStatus" NOT NULL DEFAULT 'PENDING',
    "totalRecipients"  INTEGER         NOT NULL,
    "sentCount"        INTEGER         NOT NULL DEFAULT 0,
    "failedCount"      INTEGER         NOT NULL DEFAULT 0,
    "createdById"      TEXT            NOT NULL,
    "completedAt"      TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailJob_idempotencyKey_key" ON "EmailJob"("idempotencyKey");
CREATE INDEX "EmailJob_createdById_idx"        ON "EmailJob"("createdById");
CREATE INDEX "EmailJob_status_idx"             ON "EmailJob"("status");

ALTER TABLE "EmailJob"
    ADD CONSTRAINT "EmailJob_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. EmailDelivery ─────────────────────────────────────────────────────────
CREATE TABLE "EmailDelivery" (
    "id"             TEXT                  NOT NULL,
    "jobId"          TEXT                  NOT NULL,
    "recipientEmail" TEXT                  NOT NULL,
    "recipientId"    TEXT,
    "status"         "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "messageId"      TEXT,
    "errorMessage"   TEXT,
    "attemptedAt"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailDelivery_jobId_idx"          ON "EmailDelivery"("jobId");
CREATE INDEX "EmailDelivery_status_idx"         ON "EmailDelivery"("status");
CREATE INDEX "EmailDelivery_recipientEmail_idx" ON "EmailDelivery"("recipientEmail");

ALTER TABLE "EmailDelivery"
    ADD CONSTRAINT "EmailDelivery_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "EmailJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
