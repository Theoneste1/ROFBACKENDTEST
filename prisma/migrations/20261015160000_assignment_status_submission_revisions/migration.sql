-- Migration: assignment_status_submission_revisions
--
-- 1. Add AssignmentStatus enum; migrate existing isPublished bool → status.
-- 2. Add new Assignment columns (title/instructions replacing name/requirements,
--    allowResubmission, maxResubmissions, approval tracking, rejection tracking).
-- 3. Add new Submission columns (revisionCount, percentage, feedbackFileUrl,
--    result-correction fields).
-- 4. Create SubmissionRevision table.

-- ─── 1. AssignmentStatus enum ────────────────────────────────────────────────
CREATE TYPE "AssignmentStatus" AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'PUBLISHED',
  'REJECTED'
);

-- ─── 2a. Add status column (nullable first, populate, then NOT NULL) ──────────
ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "status" "AssignmentStatus";

UPDATE "Assignment" SET "status" = 'PUBLISHED' WHERE "isPublished" = true;
UPDATE "Assignment" SET "status" = 'DRAFT'     WHERE "isPublished" = false;

ALTER TABLE "Assignment" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "Assignment" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- ─── 2b. Rename name → title, requirements → instructions (safe: same type) ──
ALTER TABLE "Assignment" RENAME COLUMN "name" TO "title";
ALTER TABLE "Assignment" RENAME COLUMN "requirements" TO "instructions";

-- ─── 2c. Add remaining new Assignment columns ─────────────────────────────────
ALTER TABLE "Assignment"
    ADD COLUMN IF NOT EXISTS "allowResubmission" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "maxResubmissions"  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "submittedAt"        TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "rejectedAt"         TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "rejectionNote"      TEXT,
    ADD COLUMN IF NOT EXISTS "approvedById"       TEXT;

-- ─── 2d. Drop the old boolean column (data migrated to status) ───────────────
ALTER TABLE "Assignment" DROP COLUMN IF EXISTS "isPublished";

-- ─── 2e. Rebuild index on status (old isPublished index dropped with column) ──
DROP INDEX IF EXISTS "Assignment_isPublished_idx";
CREATE INDEX IF NOT EXISTS "Assignment_status_idx" ON "Assignment"("status");

-- ─── 2f. FK: approvedById → User ─────────────────────────────────────────────
ALTER TABLE "Assignment"
    ADD CONSTRAINT "Assignment_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. New Submission columns ────────────────────────────────────────────────
ALTER TABLE "Submission"
    ADD COLUMN IF NOT EXISTS "revisionCount"        INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "percentage"           DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS "mentorFeedbackFileUrl" TEXT,
    ADD COLUMN IF NOT EXISTS "previousScore"        INTEGER,
    ADD COLUMN IF NOT EXISTS "correctionNote"       TEXT,
    ADD COLUMN IF NOT EXISTS "correctedAt"          TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "correctedById"        TEXT;

-- ─── 3b. FK: correctedById → User ────────────────────────────────────────────
ALTER TABLE "Submission"
    ADD CONSTRAINT "Submission_correctedById_fkey"
    FOREIGN KEY ("correctedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 4. SubmissionRevision table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SubmissionRevision" (
    "id"             TEXT NOT NULL,
    "submissionId"   TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "fileUrl"        TEXT,
    "note"           TEXT,
    "submittedById"  TEXT NOT NULL,
    "submittedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SubmissionRevision_submissionId_idx"
    ON "SubmissionRevision"("submissionId");

ALTER TABLE "SubmissionRevision"
    ADD CONSTRAINT "SubmissionRevision_submissionId_fkey"
    FOREIGN KEY ("submissionId") REFERENCES "Submission"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
