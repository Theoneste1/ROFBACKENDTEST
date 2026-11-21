-- Rollback for 20261223000000_olympiad_interest_other ("Other" Olympiad interest; owner, 2026-11-21).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the column).
--
-- It drops olympiadInterestOther from User, MentorRequest and TeacherApplication: every "other" interest given since the
-- release would be LOST. It REFUSES, and changes nothing, while any account or application has one. To discard them
-- knowingly, after a backup that contains them, run this file in a session that first sets:
--     SET rof.olympiad_interest_other_rollback = 'discard-answers';
-- Nothing else changes (the three subjects are untouched).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns WHERE column_name = 'olympiadInterestOther'
--           AND table_name IN ('User', 'MentorRequest', 'TeacherApplication');                      -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261223000000_olympiad_interest_other';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "User", "MentorRequest", "TeacherApplication" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  answers bigint;
BEGIN
  SELECT (SELECT count(*) FROM "User" WHERE "olympiadInterestOther" IS NOT NULL)
       + (SELECT count(*) FROM "MentorRequest" WHERE "olympiadInterestOther" IS NOT NULL)
       + (SELECT count(*) FROM "TeacherApplication" WHERE "olympiadInterestOther" IS NOT NULL)
    INTO answers;
  IF answers > 0 AND coalesce(current_setting('rof.olympiad_interest_other_rollback', true), '') <> 'discard-answers' THEN
    RAISE EXCEPTION 'OLYMPIAD_INTEREST_OTHER_ROLLBACK_REFUSED: % account(s) or application(s) name another Olympiad; they would be lost. Back up, then SET rof.olympiad_interest_other_rollback = ''discard-answers'' to proceed.', answers;
  END IF;
END $$;

ALTER TABLE "TeacherApplication" DROP CONSTRAINT IF EXISTS "TeacherApplication_olympiadInterestOther_length";
ALTER TABLE "MentorRequest"      DROP CONSTRAINT IF EXISTS "MentorRequest_olympiadInterestOther_length";
ALTER TABLE "User"               DROP CONSTRAINT IF EXISTS "User_olympiadInterestOther_length";
ALTER TABLE "TeacherApplication" DROP COLUMN "olympiadInterestOther";
ALTER TABLE "MentorRequest"      DROP COLUMN "olympiadInterestOther";
ALTER TABLE "User"               DROP COLUMN "olympiadInterestOther";

COMMIT;
