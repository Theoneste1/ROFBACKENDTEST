-- Rollback for 20261220000100_tests_core (Test Management Phase 1, migration M-b; owner-approved plan 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the Test* tables and MarkerAuthorization). Roll it back after 20261220000200_tests_submissions (Phase 2, whose tables reference
-- these: while they exist the DROP below fails and nothing changes), before
-- 20261220000000_test_file_purposes.
--
-- It drops Test, TestQuestion, TestFile and MarkerAuthorization with their enums, and removes the PHYSICS and COMPUTING
-- subjects (Discipline rows). Removing them restores the previous release's default programme membership: that release
-- gives new students and coaches the Mathematics membership only while Mathematics is the ONLY subject (G3 was fixed in
-- this release). Every other row is kept: Mathematics, courses, assignments, submissions, results and files.
--
-- It REFUSES, and changes nothing:
--   * always, while a course belongs to PHYSICS or COMPUTING (course content is never discarded by a rollback);
--   * while any test, marker authorisation or Physics / Computing programme membership exists (they would be lost),
--     unless explicitly acknowledged — after a backup that contains them, run this file in a session that first sets:
--         SET rof.tests_core_rollback = 'discard-tests';
--     (the memberships are heads and members an Administrator added; the audit log keeps PROGRAMME_HEADS_SET /
--     PROGRAMME_MEMBER_ADD).
-- The test files (FilePurpose TEST_PAPER / MARKING_GUIDE) lose their link and become orphans; the previous release's
-- nightly cleanup removes them.
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the tables are gone:
--        SELECT count(*) FROM information_schema.tables
--         WHERE table_schema = 'public' AND table_name IN ('Test', 'TestQuestion', 'TestFile', 'MarkerAuthorization');  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220000100_tests_core';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works: the subjects are inserted again ON CONFLICT ("code") DO NOTHING.
BEGIN;

LOCK TABLE "Test", "TestQuestion", "TestFile", "MarkerAuthorization", "ProgrammeMembership", "Course" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  tests bigint;
  markers bigint;
  members bigint;
  courses bigint;
BEGIN
  SELECT count(*) INTO tests FROM "Test";
  SELECT count(*) INTO markers FROM "MarkerAuthorization";
  SELECT count(*) INTO members FROM "ProgrammeMembership" m JOIN "Discipline" d ON d."id" = m."disciplineId"
   WHERE d."code" IN ('PHYSICS', 'COMPUTING');
  SELECT count(*) INTO courses FROM "Course" c JOIN "Discipline" d ON d."id" = c."disciplineId"
   WHERE d."code" IN ('PHYSICS', 'COMPUTING');
  IF courses > 0 THEN
    RAISE EXCEPTION 'TESTS_CORE_ROLLBACK_REFUSED: % course(s) belong to Physics or Computing; nothing was changed. Course content is never discarded by a rollback.', courses;
  END IF;
  IF (tests > 0 OR markers > 0 OR members > 0)
     AND current_setting('rof.tests_core_rollback', true) IS DISTINCT FROM 'discard-tests' THEN
    RAISE EXCEPTION 'TESTS_CORE_ROLLBACK_REFUSED: % test(s), % marker authorisation(s) and % Physics/Computing programme membership(s) would be lost; nothing was changed. After a backup that contains them, SET rof.tests_core_rollback = ''discard-tests'' and run again.', tests, markers, members;
  END IF;
END $$;

DROP TABLE IF EXISTS "TestFile";
DROP TABLE IF EXISTS "TestQuestion";
DROP TABLE IF EXISTS "Test";
DROP TABLE IF EXISTS "MarkerAuthorization";
DROP TYPE IF EXISTS "TestFileKind";
DROP TYPE IF EXISTS "TestStatus";
DROP TYPE IF EXISTS "TestAnswerFormat";
DROP TYPE IF EXISTS "TestDivision";

DELETE FROM "ProgrammeMembership" WHERE "disciplineId" IN (SELECT "id" FROM "Discipline" WHERE "code" IN ('PHYSICS', 'COMPUTING'));
DELETE FROM "Discipline" WHERE "code" IN ('PHYSICS', 'COMPUTING');

COMMIT;
