-- Rollback for 20261220000000_test_file_purposes (Test Management Phase 1, migration M-a; owner-approved plan 2026-11-19).
-- Run manually, with approval, after a backup, after deploying the previous application release, and AFTER
-- 20261220000100_tests_core.rollback.sql (newest first).
--
-- PostgreSQL cannot drop an enum value: the FilePurpose values TEST_PAPER, TEST_ANSWER and MARKING_GUIDE are KEPT (an
-- unused value is harmless; the previous release never writes them). This file only checks that nothing still needs them.
--
-- It REFUSES, and changes nothing:
--   * while the Test Management tables still exist (roll back 20261220000100_tests_core first);
--   * while files with those purposes exist, unless explicitly acknowledged: the previous release cannot serve them (its
--     nightly cleanup removes them once nothing links to them). After a backup that contains them, run this file in a
--     session that first sets:
--         SET rof.test_file_purposes_rollback = 'discard-test-files';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220000000_test_file_purposes';
--   2. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works: the migration uses ADD VALUE IF NOT EXISTS (the values are kept by this file).
BEGIN;

DO $$
DECLARE
  tables bigint;
  files bigint;
BEGIN
  SELECT count(*) INTO tables FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('Test', 'TestQuestion', 'TestFile', 'MarkerAuthorization');
  IF tables > 0 THEN
    RAISE EXCEPTION 'TEST_FILE_PURPOSES_ROLLBACK_REFUSED: the Test Management tables still exist (%); nothing was changed. Run 20261220000100_tests_core.rollback.sql first.', tables;
  END IF;
  SELECT count(*) INTO files FROM "FileObject" WHERE "purpose"::text IN ('TEST_PAPER', 'TEST_ANSWER', 'MARKING_GUIDE');
  IF files > 0
     AND current_setting('rof.test_file_purposes_rollback', true) IS DISTINCT FROM 'discard-test-files' THEN
    RAISE EXCEPTION 'TEST_FILE_PURPOSES_ROLLBACK_REFUSED: % test file(s) exist that the previous release cannot serve; nothing was changed. After a backup that contains them, SET rof.test_file_purposes_rollback = ''discard-test-files'' and run again.', files;
  END IF;
END $$;

COMMIT;
