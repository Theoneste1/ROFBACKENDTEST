-- Rollback for 20261221000100_home_location (home location on every registration form; owner, 2026-11-20).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes these columns).
--
-- It drops the new home place columns (the home province of teacher applications; province, district and sector of coach
-- applications) and makes the teacher application's home district and sector required again. It REFUSES, and changes
-- nothing, while a teacher application has no home district or sector (an international applicant): the previous
-- release cannot store it. Decide those applications first. It also refuses while an application holds a home place that
-- would be lost (a teacher's province, a coach's place) unless, after a backup, the session first sets:
--     SET rof.home_location_rollback = 'discard-home-places';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE (table_name = 'TeacherApplication' AND column_name = 'homeProvince')
--            OR (table_name = 'MentorRequest' AND column_name IN ('homeProvince', 'homeDistrict', 'homeSector')); -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261221000100_home_location';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "TeacherApplication", "MentorRequest" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  abroad bigint;
  places bigint;
BEGIN
  -- Teacher applications without a home district or sector (international applicants): the previous release cannot store them.
  SELECT count(*) INTO abroad FROM "TeacherApplication" WHERE "homeDistrict" IS NULL OR "homeSector" IS NULL;
  IF abroad > 0 THEN
    RAISE EXCEPTION 'HOME_LOCATION_ROLLBACK_REFUSED: % teacher application(s) have no home district or sector (international applicants); nothing was changed. Decide them first.', abroad;
  END IF;
  -- Home places that would be lost: teacher applications' provinces, coach applications' places.
  SELECT (SELECT count(*) FROM "TeacherApplication" WHERE "homeProvince" IS NOT NULL)
       + (SELECT count(*) FROM "MentorRequest" WHERE "homeDistrict" IS NOT NULL) INTO places;
  IF places > 0
     AND current_setting('rof.home_location_rollback', true) IS DISTINCT FROM 'discard-home-places' THEN
    RAISE EXCEPTION 'HOME_LOCATION_ROLLBACK_REFUSED: % application(s) hold a home place that would be lost; nothing was changed. After a backup that contains them, SET rof.home_location_rollback = ''discard-home-places'' and run again.', places;
  END IF;
END $$;
ALTER TABLE "MentorRequest" DROP COLUMN IF EXISTS "homeSector", DROP COLUMN IF EXISTS "homeDistrict", DROP COLUMN IF EXISTS "homeProvince";
ALTER TABLE "TeacherApplication" ALTER COLUMN "homeSector" SET NOT NULL, ALTER COLUMN "homeDistrict" SET NOT NULL,
  DROP COLUMN IF EXISTS "homeProvince";
COMMIT;
