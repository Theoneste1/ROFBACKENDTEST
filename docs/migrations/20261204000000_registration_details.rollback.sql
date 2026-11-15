-- Rollback for 20261204000000_registration_details (student registration details and coach application
-- details; after 20261203000000_student_olympiad_interests).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads and writes these columns).
--
-- It removes ONLY what this migration created: User.dateOfBirth, guardianPhone, homeProvince,
-- homeDistrict, homeSector; MentorRequest.country, occupation, educationLevel, olympiadInterests; and the
-- CoachEducationLevel enum. User.phone / User.country and the OlympiadSubject enum belong to
-- 20261201000000_teacher_applications and are kept. Roll this migration back BEFORE that one.
--
-- It REFUSES, and changes nothing, while any row holds a value in these columns: that data would be lost.
-- To discard it knowingly, after a backup that contains it, run this file in a session that first sets:
--     SET rof.registration_details_rollback = 'discard-registration-details';
--
-- Like the earlier rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE (table_name = 'User' AND column_name IN ('dateOfBirth','guardianPhone','homeProvince','homeDistrict','homeSector'))
--            OR (table_name = 'MentorRequest' AND column_name IN ('country','occupation','educationLevel','olympiadInterests'));  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261204000000_registration_details';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later is safe: the migration adds the columns again (empty).
BEGIN;

DO $$
DECLARE
  users bigint;
  requests bigint;
BEGIN
  SELECT count(*) INTO users FROM "User"
   WHERE "dateOfBirth" IS NOT NULL OR "guardianPhone" IS NOT NULL
      OR "homeProvince" IS NOT NULL OR "homeDistrict" IS NOT NULL OR "homeSector" IS NOT NULL;
  SELECT count(*) INTO requests FROM "MentorRequest"
   WHERE "country" IS NOT NULL OR "occupation" IS NOT NULL OR "educationLevel" IS NOT NULL
      OR cardinality("olympiadInterests") > 0;
  IF (users > 0 OR requests > 0)
     AND current_setting('rof.registration_details_rollback', true) IS DISTINCT FROM 'discard-registration-details' THEN
    RAISE EXCEPTION 'REGISTRATION_DETAILS_ROLLBACK_REFUSED: % account(s) and % coach application(s) hold registration details that would be lost; nothing was changed. After a backup that contains them, SET rof.registration_details_rollback = ''discard-registration-details'' and run again.', users, requests;
  END IF;
END $$;

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "dateOfBirth",
  DROP COLUMN IF EXISTS "guardianPhone",
  DROP COLUMN IF EXISTS "homeProvince",
  DROP COLUMN IF EXISTS "homeDistrict",
  DROP COLUMN IF EXISTS "homeSector";

ALTER TABLE "MentorRequest"
  DROP COLUMN IF EXISTS "country",
  DROP COLUMN IF EXISTS "occupation",
  DROP COLUMN IF EXISTS "educationLevel",
  DROP COLUMN IF EXISTS "olympiadInterests";

DROP TYPE IF EXISTS "CoachEducationLevel";

COMMIT;
