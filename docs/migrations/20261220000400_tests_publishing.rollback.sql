-- Rollback for 20261220000400_tests_publishing (Test Management Phase 4, migration M-d part 2; owner-approved plan 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes these tables). Roll it back FIRST (newest), before 20261220000300_tests_marking.
--
-- It drops TestPublication and TestResultWithdrawal, the columns TestSubmission.publicationId / publishedAt and
-- Test.studentRankingsVisible, their CHECKs, the two guard triggers and their functions. Every Test, submission, version,
-- page, marking, mark, mark change, review and status-history row is kept, and so is every course-assignment row.
-- The previous release knows no publication: a PUBLISHED result goes back to APPROVED (hidden again, still locked and
-- unlockable there), with one status-history row each (actorRole SYSTEM, the reason names this rollback).
--
-- It REFUSES, and changes nothing, while any publication or withdrawal exists or any result is PUBLISHED (students and
-- teachers would lose results they can see; the publication history would be lost), unless explicitly acknowledged —
-- after a backup that contains them, run this file in a session that first sets:
--     SET rof.tests_publishing_rollback = 'discard-publications';
-- (the audit log keeps TEST_RESULTS_PUBLISHED / TEST_PUBLICATION_OVERRIDDEN / TEST_RESULT_WITHDRAWN entries).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the tables are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
--           AND table_name IN ('TestPublication', 'TestResultWithdrawal');  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220000400_tests_publishing';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works (the migration creates everything from scratch; no result is PUBLISHED after this rollback).
BEGIN;

LOCK TABLE "Test", "TestSubmission", "TestPublication", "TestResultWithdrawal" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  publications bigint;
  withdrawals bigint;
  published bigint;
BEGIN
  SELECT count(*) INTO publications FROM "TestPublication";
  SELECT count(*) INTO withdrawals FROM "TestResultWithdrawal";
  SELECT count(*) INTO published FROM "TestSubmission" WHERE "status" = 'PUBLISHED';
  IF (publications > 0 OR withdrawals > 0 OR published > 0)
     AND current_setting('rof.tests_publishing_rollback', true) IS DISTINCT FROM 'discard-publications' THEN
    RAISE EXCEPTION 'TESTS_PUBLISHING_ROLLBACK_REFUSED: % publication(s), % withdrawal(s) and % published result(s) would be lost; nothing was changed. After a backup that contains them, SET rof.tests_publishing_rollback = ''discard-publications'' and run again.', publications, withdrawals, published;
  END IF;
END $$;

-- The guards first (a DROP TABLE is not a row operation, but nothing should fire on the way out).
DROP TRIGGER IF EXISTS test_publication_append_only ON "TestPublication";
DROP TRIGGER IF EXISTS test_result_withdrawal_append_only ON "TestResultWithdrawal";
DROP FUNCTION IF EXISTS test_publication_append_only();
DROP FUNCTION IF EXISTS test_result_withdrawal_append_only();

-- The columns that reference the publications go first (with their CHECK, index and foreign key).
ALTER TABLE "TestSubmission" DROP CONSTRAINT IF EXISTS "TestSubmission_published_state";
ALTER TABLE "TestSubmission" DROP CONSTRAINT IF EXISTS "TestSubmission_publicationId_fkey";
DROP INDEX IF EXISTS "TestSubmission_publicationId_idx";
ALTER TABLE "TestSubmission" DROP COLUMN IF EXISTS "publicationId";
ALTER TABLE "TestSubmission" DROP COLUMN IF EXISTS "publishedAt";
ALTER TABLE "Test" DROP CONSTRAINT IF EXISTS "Test_student_rankings_design_only";
ALTER TABLE "Test" DROP COLUMN IF EXISTS "studentRankingsVisible";
DROP TABLE IF EXISTS "TestResultWithdrawal";
DROP TABLE IF EXISTS "TestPublication";

-- (Acknowledged only) published results go back to APPROVED for the previous release, with their status history.
INSERT INTO "TestSubmissionStatusChange" ("id", "submissionId", "fromStatus", "toStatus", "actorId", "actorRole", "reason", "createdAt")
SELECT gen_random_uuid()::text, s."id", 'PUBLISHED', 'APPROVED', NULL, 'SYSTEM',
       'Rollback of 20261220000400_tests_publishing: publication removed', clock_timestamp() AT TIME ZONE 'UTC'
  FROM "TestSubmission" s WHERE s."status" = 'PUBLISHED';
UPDATE "TestSubmission" SET "status" = 'APPROVED', "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE "status" = 'PUBLISHED';

COMMIT;
