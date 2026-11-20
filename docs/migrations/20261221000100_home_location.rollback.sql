-- Rollback for 20261221000100_home_location (home location on every registration form; owner, 2026-11-20).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes these columns).
--
-- It drops the new home place columns (the home province of teacher applications; province, district and sector of coach
-- applications) and makes the teacher application's home district and sector required again. It REFUSES, and changes
-- nothing, while a teacher application has no home district or sector (an international applicant): the previous
-- release cannot store it. Decide those applications first (or, after a backup, set a value knowingly).
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
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "TeacherApplication" WHERE "homeDistrict" IS NULL OR "homeSector" IS NULL) THEN
    RAISE EXCEPTION 'Rollback refused: teacher applications without a home district or sector exist (international applicants).';
  END IF;
END $$;
ALTER TABLE "MentorRequest" DROP COLUMN IF EXISTS "homeSector", DROP COLUMN IF EXISTS "homeDistrict", DROP COLUMN IF EXISTS "homeProvince";
ALTER TABLE "TeacherApplication" ALTER COLUMN "homeSector" SET NOT NULL, ALTER COLUMN "homeDistrict" SET NOT NULL,
  DROP COLUMN IF EXISTS "homeProvince";
COMMIT;
