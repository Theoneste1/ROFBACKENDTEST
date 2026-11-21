-- Rollback for 20261224000000_divisions_levels (administrator-managed divisions and Olympiad levels; owner 2026-11-21/22).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes divisions as data).
--
-- It returns the database to two fixed divisions: Division.code and Test.division become the former enums again
-- (DivisionCode JUNIOR / SENIOR; TestDivision JUNIOR / SENIOR / ALL); the suggested grades, the display order, the
-- MIDDLE division (and any other an Administrator created), the hand-set flag, the submissions' level and the
-- DivisionChange history are removed, with the grade triggers and their functions.
--
-- It REFUSES, and changes nothing:
--   - while any test is for a division other than JUNIOR, SENIOR or ALL, or any student, enrolment, coach assignment,
--     course resource, assignment, discussion or permission override points at a division other than JUNIOR or SENIOR
--     (the previous code cannot represent it): move them first;
--   - while any division was set by hand, or any MANUAL / AUTOMATIC change is recorded (that work and its history would
--     be LOST), unless acknowledged after a backup that contains it, in a session that first sets:
--         SET rof.divisions_levels_rollback = 'discard-classifications';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'DivisionChange';   -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261224000000_divisions_levels';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "Division", "User", "Test", "TestSubmission" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  other_tests bigint;
  other_refs bigint;
  classified bigint;
BEGIN
  SELECT count(*) INTO other_tests FROM "Test" WHERE "division" NOT IN ('JUNIOR', 'SENIOR', 'ALL');
  SELECT (SELECT count(*) FROM "User" u JOIN "Division" d ON d."id" = u."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
       + (SELECT count(*) FROM "StudentEnrollment" e JOIN "Division" d ON d."id" = e."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
       + (SELECT count(*) FROM "MentorAssignment" m JOIN "Division" d ON d."id" = m."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
       + (SELECT count(*) FROM "CourseResource" r JOIN "Division" d ON d."id" = r."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
       + (SELECT count(*) FROM "Assignment" a JOIN "Division" d ON d."id" = a."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
       + (SELECT count(*) FROM "DiscussionThread" t JOIN "Division" d ON d."id" = t."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
       + (SELECT count(*) FROM "UserPermissionOverride" o JOIN "Division" d ON d."id" = o."divisionId" WHERE d."code" NOT IN ('JUNIOR', 'SENIOR'))
    INTO other_refs;
  IF other_tests > 0 OR other_refs > 0 THEN
    RAISE EXCEPTION 'DIVISIONS_LEVELS_ROLLBACK_REFUSED: % test(s) and % record(s) use a division other than JUNIOR or SENIOR; the previous code cannot represent them. Move them first.', other_tests, other_refs;
  END IF;
  SELECT (SELECT count(*) FROM "User" WHERE "divisionManual")
       + (SELECT count(*) FROM "DivisionChange" WHERE "source" IN ('MANUAL', 'AUTOMATIC')) INTO classified;
  IF classified > 0 AND coalesce(current_setting('rof.divisions_levels_rollback', true), '') <> 'discard-classifications' THEN
    RAISE EXCEPTION 'DIVISIONS_LEVELS_ROLLBACK_REFUSED: % division(s) set by hand or recorded changes would be lost. Back up, then SET rof.divisions_levels_rollback = ''discard-classifications'' to proceed.', classified;
  END IF;
END $$;

DROP TRIGGER student_division_history ON "User";
DROP TRIGGER student_division_from_grade ON "User";
DROP FUNCTION student_division_history();
DROP FUNCTION student_division_from_grade();
DROP FUNCTION division_for_grade(text);

DROP TABLE "DivisionChange";
DROP TYPE "DivisionChangeSource";
ALTER TABLE "TestSubmission" DROP COLUMN "level";
ALTER TABLE "User" DROP COLUMN "divisionManual";

CREATE TYPE "TestDivision" AS ENUM ('JUNIOR', 'SENIOR', 'ALL');
ALTER TABLE "Test" ALTER COLUMN "division" DROP DEFAULT;
ALTER TABLE "Test" ALTER COLUMN "division" TYPE "TestDivision" USING "division"::"TestDivision";
ALTER TABLE "Test" ALTER COLUMN "division" SET DEFAULT 'ALL';

-- Divisions other than JUNIOR and SENIOR are unreferenced (checked above): removed.
DELETE FROM "Division" WHERE "code" NOT IN ('JUNIOR', 'SENIOR');
ALTER TABLE "Division" DROP CONSTRAINT "Division_code_format";
CREATE TYPE "DivisionCode" AS ENUM ('JUNIOR', 'SENIOR');
ALTER TABLE "Division" ALTER COLUMN "code" TYPE "DivisionCode" USING "code"::"DivisionCode";
ALTER TABLE "Division" DROP COLUMN "sortOrder", DROP COLUMN "suggestedGrades";

COMMIT;
