-- Rollback for 20261220000300_tests_marking (Test Management Phase 3, migration M-d part 1; owner-approved plan 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes these tables). Roll it back FIRST (newest), before 20261220000200_tests_submissions.
--
-- It drops TestMarkerAssignment, TestMarking, TestMarkingScore, TestMarkChange and TestReview, the column
-- TestSubmission.finalMarkingId, their enums (TestMarkingKind, TestMarkingStatus, TestReviewAction), the five guard
-- triggers and their functions. Every Test, TestSubmission, TestSubmissionVersion, TestAnswerPage and
-- TestSubmissionStatusChange row is kept, and so is every course-assignment row. Submissions keep their status and
-- status history: the previous release treats any status other than SUBMITTED as "being marked" (no replacement), which
-- stays true — their deadlines had passed before marking could begin (G5).
--
-- It REFUSES, and changes nothing, while any assignment, marking, mark, mark change or review exists (markers' work and
-- reviewers' decisions would be lost), unless explicitly acknowledged — after a backup that contains them, run this file
-- in a session that first sets:
--     SET rof.tests_marking_rollback = 'discard-marking';
-- (the audit log keeps TEST_MARKING_* / TEST_MARKER_* / TEST_SECOND_MARKING_REQUESTED / TEST_MARK_CHOSEN entries).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the tables are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
--           AND table_name IN ('TestMarkerAssignment', 'TestMarking', 'TestMarkingScore', 'TestMarkChange', 'TestReview');  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220000300_tests_marking';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works (the migration creates everything from scratch).
BEGIN;

LOCK TABLE "TestSubmission", "TestMarkerAssignment", "TestMarking", "TestMarkingScore", "TestMarkChange", "TestReview" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  assignments bigint;
  markings bigint;
  scores bigint;
  changes bigint;
  reviews bigint;
BEGIN
  SELECT count(*) INTO assignments FROM "TestMarkerAssignment";
  SELECT count(*) INTO markings FROM "TestMarking";
  SELECT count(*) INTO scores FROM "TestMarkingScore";
  SELECT count(*) INTO changes FROM "TestMarkChange";
  SELECT count(*) INTO reviews FROM "TestReview";
  IF (assignments > 0 OR markings > 0 OR scores > 0 OR changes > 0 OR reviews > 0)
     AND current_setting('rof.tests_marking_rollback', true) IS DISTINCT FROM 'discard-marking' THEN
    RAISE EXCEPTION 'TESTS_MARKING_ROLLBACK_REFUSED: % assignment(s), % marking(s), % mark(s), % mark change(s) and % review(s) would be lost; nothing was changed. After a backup that contains them, SET rof.tests_marking_rollback = ''discard-marking'' and run again.', assignments, markings, scores, changes, reviews;
  END IF;
END $$;

-- The guards first (a DROP TABLE is not a row operation, but nothing should fire on the way out).
DROP TRIGGER IF EXISTS test_marker_assignment_guard ON "TestMarkerAssignment";
DROP TRIGGER IF EXISTS test_marking_guard ON "TestMarking";
DROP TRIGGER IF EXISTS test_marking_score_guard ON "TestMarkingScore";
DROP TRIGGER IF EXISTS test_mark_change_append_only ON "TestMarkChange";
DROP TRIGGER IF EXISTS test_review_append_only ON "TestReview";
DROP FUNCTION IF EXISTS test_marker_assignment_guard();
DROP FUNCTION IF EXISTS test_marking_guard();
DROP FUNCTION IF EXISTS test_marking_score_guard();
DROP FUNCTION IF EXISTS test_mark_change_append_only();
DROP FUNCTION IF EXISTS test_review_append_only();

-- TestSubmission.finalMarkingId references TestMarking: the column goes first (with its index and foreign key).
ALTER TABLE "TestSubmission" DROP CONSTRAINT IF EXISTS "TestSubmission_finalMarkingId_fkey";
DROP INDEX IF EXISTS "TestSubmission_finalMarkingId_key";
ALTER TABLE "TestSubmission" DROP COLUMN IF EXISTS "finalMarkingId";
DROP TABLE IF EXISTS "TestReview";
DROP TABLE IF EXISTS "TestMarkChange";
DROP TABLE IF EXISTS "TestMarkingScore";
DROP TABLE IF EXISTS "TestMarking";
DROP TABLE IF EXISTS "TestMarkerAssignment";
DROP TYPE IF EXISTS "TestReviewAction";
DROP TYPE IF EXISTS "TestMarkingStatus";
DROP TYPE IF EXISTS "TestMarkingKind";

COMMIT;
