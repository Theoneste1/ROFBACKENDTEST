/*
  Migration: add_separate_roles_audit_token_blacklist_max_marks
  
  Changes:
  - Expand SubmissionStatus enum (TODO→SUBMITTED, REDO→IN_REVIEW, PASSED→APPROVED)
  - Migrate feedback column → mentorFeedback
  - Add maximumMarks, fileUrl, isPublished, publishedAt to Assignment
  - Add adminFeedback, rejectionReason, reviewStartedAt, submittedToAdminAt, approvedAt to Submission
  - Create TokenBlacklist table
  - Create AuditLog table
  - Add new indexes
*/

-- ─── 1. Rename assignedsubmissions relation column name (no-op, schema only) ─

-- ─── 2. Pre-add mentorFeedback before we touch the enum/feedback ─────────────
ALTER TABLE "Submission" ADD COLUMN IF NOT EXISTS "mentorFeedback" TEXT;
UPDATE "Submission" SET "mentorFeedback" = "feedback" WHERE "feedback" IS NOT NULL;

-- ─── 3. Expand the SubmissionStatus enum to include ALL values (old + new) ───
--    We add the new values first so existing rows can be safely updated.
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'IN_REVIEW';
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'MARKED';
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED_TO_ADMIN';
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'PUBLISHED';
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- ─── 4. Migrate existing rows to the new equivalent values ───────────────────
--    (Safe now because all new values exist in the enum)
UPDATE "Submission" SET "status" = 'SUBMITTED' WHERE "status" = 'TODO';
UPDATE "Submission" SET "status" = 'IN_REVIEW'  WHERE "status" = 'REDO';
UPDATE "Submission" SET "status" = 'APPROVED'   WHERE "status" = 'PASSED';

-- ─── 5. Remove old enum values via the rename dance ─────────────────────────
BEGIN;
CREATE TYPE "SubmissionStatus_new" AS ENUM (
  'SUBMITTED',
  'ASSIGNED',
  'IN_REVIEW',
  'MARKED',
  'SUBMITTED_TO_ADMIN',
  'APPROVED',
  'PUBLISHED',
  'REJECTED'
);
ALTER TABLE "Submission" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Submission"
  ALTER COLUMN "status" TYPE "SubmissionStatus_new"
  USING ("status"::text::"SubmissionStatus_new");
ALTER TYPE "SubmissionStatus" RENAME TO "SubmissionStatus_old";
ALTER TYPE "SubmissionStatus_new" RENAME TO "SubmissionStatus";
DROP TYPE "SubmissionStatus_old";
ALTER TABLE "Submission" ALTER COLUMN "status" SET DEFAULT 'SUBMITTED';
COMMIT;

-- ─── 6. Drop old feedback column (data already migrated to mentorFeedback) ───
ALTER TABLE "Submission" DROP COLUMN IF EXISTS "feedback";

-- ─── 7. Add remaining new Submission columns ─────────────────────────────────
ALTER TABLE "Submission"
  ADD COLUMN IF NOT EXISTS "adminFeedback"       TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectionReason"     TEXT,
  ADD COLUMN IF NOT EXISTS "reviewStartedAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "submittedToAdminAt"  TIMESTAMP(3);

-- ─── 8. Add new Assignment columns ───────────────────────────────────────────
ALTER TABLE "Assignment"
  ADD COLUMN IF NOT EXISTS "fileUrl"      TEXT,
  ADD COLUMN IF NOT EXISTS "isPublished"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "maximumMarks" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "publishedAt"  TIMESTAMP(3);

-- Remove the temporary default so future inserts must be explicit
ALTER TABLE "Assignment" ALTER COLUMN "maximumMarks" DROP DEFAULT;

-- ─── 9. Create TokenBlacklist table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TokenBlacklist" (
    "id"        TEXT NOT NULL,
    "jti"       TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TokenBlacklist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TokenBlacklist_jti_key"       ON "TokenBlacklist"("jti");
CREATE INDEX        IF NOT EXISTS "TokenBlacklist_jti_idx"       ON "TokenBlacklist"("jti");
CREATE INDEX        IF NOT EXISTS "TokenBlacklist_expiresAt_idx" ON "TokenBlacklist"("expiresAt");

-- ─── 10. Create AuditLog table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id"        TEXT NOT NULL,
    "actorId"   TEXT,
    "actorRole" TEXT,
    "action"    TEXT NOT NULL,
    "entity"    TEXT NOT NULL,
    "entityId"  TEXT,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLog_actorId_idx"   ON "AuditLog"("actorId");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx"    ON "AuditLog"("action");
CREATE INDEX IF NOT EXISTS "AuditLog_entity_idx"    ON "AuditLog"("entity");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- ─── 11. New indexes on existing tables ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Assignment_isPublished_idx" ON "Assignment"("isPublished");
CREATE INDEX IF NOT EXISTS "User_role_idx"              ON "User"("role");

-- ─── 12. Foreign key for AuditLog -> User ─────────────────────────────────────
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
