-- Rollback for 20261221000000_registration_gender (gender at sign-up; owner, 2026-11-20).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the gender columns).
--
-- It drops the three gender columns and the Gender enum: every gender given since the release would be LOST. It REFUSES,
-- and changes nothing, while any account or application has a gender. To discard them knowingly, after a backup that
-- contains them, run this file in a session that first sets:
--     SET rof.registration_gender_rollback = 'discard-genders';
-- Nothing else changes.
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns WHERE column_name = 'gender'
--           AND table_name IN ('User', 'MentorRequest', 'TeacherApplication');                      -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261221000000_registration_gender';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "User", "MentorRequest", "TeacherApplication" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  given bigint;
BEGIN
  SELECT (SELECT count(*) FROM "User" WHERE "gender" IS NOT NULL)
       + (SELECT count(*) FROM "MentorRequest" WHERE "gender" IS NOT NULL)
       + (SELECT count(*) FROM "TeacherApplication" WHERE "gender" IS NOT NULL) INTO given;
  IF given > 0
     AND current_setting('rof.registration_gender_rollback', true) IS DISTINCT FROM 'discard-genders' THEN
    RAISE EXCEPTION 'REGISTRATION_GENDER_ROLLBACK_REFUSED: % account(s) or application(s) have a gender; nothing was changed. After a backup that contains them, SET rof.registration_gender_rollback = ''discard-genders'' and run again.', given;
  END IF;
END $$;

ALTER TABLE "TeacherApplication" DROP COLUMN IF EXISTS "gender";
ALTER TABLE "MentorRequest" DROP COLUMN IF EXISTS "gender";
ALTER TABLE "User" DROP COLUMN IF EXISTS "gender";
DROP TYPE IF EXISTS "Gender";
COMMIT;
