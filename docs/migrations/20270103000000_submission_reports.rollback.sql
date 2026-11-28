-- Rollback for 20270103000000_submission_reports (submission reports; owner 2026-11-28).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- writes a correction on every reassignment and reads the grant columns on every report).
--
-- It drops the TestSubmissionCorrection table (and its trigger function) and the four CustomReportGrant columns (school,
-- expiry, revocation), and restores the one-grantee CHECK (a user or a role). Lost: the correction history (the submissions themselves keep their corrected test and level; the
-- audit log keeps TEST_SUBMISSION_REASSIGNED), school grants (deleted: a grant without a user or role means nothing to
-- the previous release), time-limited and revoked grants (DELETED: the previous release knows no expiry or revocation,
-- so they would otherwise come back to life, without limit).
-- Refused while corrections or school grants exist, unless acknowledged:
--   SET rof.submission_reports_rollback = 'discard-submission-corrections';   (kit: --acknowledge submission-corrections)
--
-- Like the other rollbacks, this file does NOT edit Prisma's migration history. Afterwards, once the objects are gone:
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20270103000000_submission_reports'
--     AND to_regclass('public."TestSubmissionCorrection"') IS NULL;
-- (not `prisma migrate resolve --rolled-back`, which only applies to FAILED migrations; kit: rollback-history).
BEGIN;

DO $$
DECLARE
  corrections bigint;
  schools bigint;
BEGIN
  SELECT count(*) INTO corrections FROM "TestSubmissionCorrection";
  SELECT count(*) INTO schools FROM "CustomReportGrant" WHERE "schoolId" IS NOT NULL;
  IF (corrections > 0 OR schools > 0) AND coalesce(current_setting('rof.submission_reports_rollback', true), '') <> 'discard-submission-corrections' THEN
    RAISE EXCEPTION 'SUBMISSION_REPORTS_ROLLBACK_REFUSED: % correction(s) and % school grant(s) would be lost; nothing was changed. Back up, then SET rof.submission_reports_rollback = ''discard-submission-corrections'' to proceed.', corrections, schools;
  END IF;
END $$;

-- Grants the previous release cannot honour: a school grant (no user, no role), and a revoked or time-limited one (it
-- would come back, or never end).
DELETE FROM "CustomReportGrant" WHERE "schoolId" IS NOT NULL OR "revokedAt" IS NOT NULL OR "expiresAt" IS NOT NULL;

-- The one-grantee CHECK as the previous release defined it (a user or a role).
ALTER TABLE "CustomReportGrant" DROP CONSTRAINT "CustomReportGrant_one_grantee";
ALTER TABLE "CustomReportGrant" ADD CONSTRAINT "CustomReportGrant_one_grantee"
  CHECK (("userId" IS NOT NULL AND "role" IS NULL AND "grantee" = 'user:' || "userId")
      OR ("userId" IS NULL AND "role" IS NOT NULL AND "grantee" = 'role:' || "role"::text));

ALTER TABLE "CustomReportGrant" DROP CONSTRAINT "CustomReportGrant_schoolId_fkey";
DROP INDEX "CustomReportGrant_schoolId_idx";
ALTER TABLE "CustomReportGrant" DROP COLUMN "schoolId", DROP COLUMN "expiresAt", DROP COLUMN "revokedAt", DROP COLUMN "revokedById";

DROP TABLE "TestSubmissionCorrection";
DROP FUNCTION test_submission_correction_append_only();

COMMIT;
