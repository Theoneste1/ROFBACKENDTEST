-- Rollback for 20261224000000_olympiad_levels (Olympiad levels; owner, 2026-11-21).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the level).
--
-- It drops the level triggers and functions, the OlympiadLevelChange history, the User olympiadLevel /
-- olympiadLevelManual and TestSubmission level columns and both enums, and re-creates the bulk membership guard trigger
-- without "olympiadLevel" (as 20261207000100 created it). Test eligibility goes back to the grade (S1–S3 Junior, S4–S6
-- Senior). The value MIDDLE stays in the TestDivision enum (PostgreSQL cannot drop an enum value; the previous code never
-- writes it).
--
-- It REFUSES, and changes nothing:
--   - while any test is for MIDDLE students (the previous code could not read it): move those tests to another level
--     or delete them first;
--   - while any level was set by hand, or any MANUAL / AUTOMATIC change is recorded (that work and its history would be
--     LOST), unless acknowledged after a backup that contains it, in a session that first sets:
--         SET rof.olympiad_levels_rollback = 'discard-classifications';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'OlympiadLevelChange';   -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261224000000_olympiad_levels';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "User", "Test", "TestSubmission" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  middle_tests bigint;
  classified bigint;
BEGIN
  SELECT count(*) INTO middle_tests FROM "Test" WHERE "division"::text = 'MIDDLE';
  IF middle_tests > 0 THEN
    RAISE EXCEPTION 'OLYMPIAD_LEVELS_ROLLBACK_REFUSED: % test(s) are for MIDDLE students; the previous code cannot read them. Move them to another level or delete them first.', middle_tests;
  END IF;
  SELECT (SELECT count(*) FROM "User" WHERE "olympiadLevelManual")
       + (SELECT count(*) FROM "OlympiadLevelChange" WHERE "source" IN ('MANUAL', 'AUTOMATIC')) INTO classified;
  IF classified > 0 AND coalesce(current_setting('rof.olympiad_levels_rollback', true), '') <> 'discard-classifications' THEN
    RAISE EXCEPTION 'OLYMPIAD_LEVELS_ROLLBACK_REFUSED: % level(s) set by hand or recorded changes would be lost. Back up, then SET rof.olympiad_levels_rollback = ''discard-classifications'' to proceed.', classified;
  END IF;
END $$;

DROP TRIGGER olympiad_level_history ON "User";
DROP TRIGGER olympiad_level_from_grade ON "User";
DROP FUNCTION olympiad_level_history();
DROP FUNCTION olympiad_level_from_grade();
DROP FUNCTION olympiad_level_of_grade(text);

DROP TRIGGER user_bulk_membership_guard ON "User";
CREATE TRIGGER user_bulk_membership_guard
  BEFORE INSERT OR DELETE
      OR UPDATE OF "role", "divisionId", "gradeLevel", "schoolId", "isApproved", "isActive", "accountStatus",
                   "activatedAt", "firstName", "lastName", "username", "email"
  ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_bulk_membership_guard();

DROP INDEX "User_role_olympiadLevel_idx";
DROP TABLE "OlympiadLevelChange";
ALTER TABLE "TestSubmission" DROP COLUMN "level";
ALTER TABLE "User" DROP COLUMN "olympiadLevel", DROP COLUMN "olympiadLevelManual";
DROP TYPE "OlympiadLevelChangeSource";
DROP TYPE "OlympiadLevel";

COMMIT;
