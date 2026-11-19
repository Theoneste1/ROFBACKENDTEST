-- Rollback for 20261220000200_tests_submissions (Test Management Phase 2, migration M-c; owner-approved plan 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes these tables). Roll it back FIRST (newest), before 20261220000100_tests_core.
--
-- It drops TestExtension, TestSubmission, TestSubmissionVersion, TestAnswerPage and TestSubmissionStatusChange, their enums
-- (TestExtensionKind, TestSubmissionStatus, TestSubmitterRole), the three guard triggers and their functions. Every Test,
-- TestQuestion, TestFile and MarkerAuthorization row is kept, and so is every course-assignment row. The answer-page files
-- (FilePurpose TEST_ANSWER) lose their link and become orphans; the nightly cleanup removes them.
--
-- It REFUSES, and changes nothing, while any extension, submission, version or answer page exists (students' answers and
-- deadline decisions would be lost), unless explicitly acknowledged — after a backup that contains them, run this file
-- in a session that first sets:
--     SET rof.tests_submissions_rollback = 'discard-submissions';
-- (the audit log keeps TEST_EXTENSION_* / TEST_SUBMITTED / TEST_SUBMISSION_REPLACED / TEST_ANSWER_PAGE_* entries).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the tables are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
--           AND table_name IN ('TestExtension', 'TestSubmission', 'TestSubmissionVersion', 'TestAnswerPage', 'TestSubmissionStatusChange');  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220000200_tests_submissions';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works (the migration creates everything from scratch).
BEGIN;

LOCK TABLE "TestExtension", "TestSubmission", "TestSubmissionVersion", "TestAnswerPage", "TestSubmissionStatusChange" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  extensions bigint;
  submissions bigint;
  versions bigint;
  pages bigint;
BEGIN
  SELECT count(*) INTO extensions FROM "TestExtension";
  SELECT count(*) INTO submissions FROM "TestSubmission";
  SELECT count(*) INTO versions FROM "TestSubmissionVersion";
  SELECT count(*) INTO pages FROM "TestAnswerPage";
  IF (extensions > 0 OR submissions > 0 OR versions > 0 OR pages > 0)
     AND current_setting('rof.tests_submissions_rollback', true) IS DISTINCT FROM 'discard-submissions' THEN
    RAISE EXCEPTION 'TESTS_SUBMISSIONS_ROLLBACK_REFUSED: % extension(s), % submission(s), % version(s) and % answer page(s) would be lost; nothing was changed. After a backup that contains them, SET rof.tests_submissions_rollback = ''discard-submissions'' and run again.', extensions, submissions, versions, pages;
  END IF;
END $$;

-- The append-only guards first (a DROP TABLE is not a row operation, but nothing should fire on the way out).
DROP TRIGGER IF EXISTS test_submission_version_append_only ON "TestSubmissionVersion";
DROP TRIGGER IF EXISTS test_submission_status_append_only ON "TestSubmissionStatusChange";
DROP TRIGGER IF EXISTS test_answer_page_committed_guard ON "TestAnswerPage";
DROP FUNCTION IF EXISTS test_submission_version_append_only();
DROP FUNCTION IF EXISTS test_submission_status_append_only();
DROP FUNCTION IF EXISTS test_answer_page_committed_guard();

-- TestSubmission and TestSubmissionVersion reference each other (current version / versions): drop them together.
DROP TABLE IF EXISTS "TestSubmissionStatusChange";
DROP TABLE IF EXISTS "TestAnswerPage";
DROP TABLE IF EXISTS "TestSubmission", "TestSubmissionVersion";
DROP TABLE IF EXISTS "TestExtension";
DROP TYPE IF EXISTS "TestSubmitterRole";
DROP TYPE IF EXISTS "TestSubmissionStatus";
DROP TYPE IF EXISTS "TestExtensionKind";

COMMIT;
