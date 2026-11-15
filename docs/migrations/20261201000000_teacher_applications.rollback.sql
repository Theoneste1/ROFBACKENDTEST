-- Rollback for 20261201000000_teacher_applications (Teacher self-registration; after Phase 1 M1–M14).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads TeacherApplication and User.phone / User.country).
--
-- It removes ONLY what this migration created: the TeacherApplication table (with its partial unique
-- indexes), the TeacherApplicationStatus and OlympiadSubject enums, and the User.phone / User.country
-- columns. TEACHER accounts created by approvals and their TeacherSchoolAssignment rows are kept (they
-- are ordinary Teacher accounts; the audit log keeps every decision).
--
-- It REFUSES, and changes nothing, while any application exists or any account has a phone or country:
-- that data would be lost. To discard it knowingly, after a backup that contains it, run this file in a
-- session that first sets:
--     SET rof.teacher_applications_rollback = 'discard-teacher-applications';
--
-- Like M9–M14, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'TeacherApplication';      -- expect 0
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'User' AND column_name IN ('phone', 'country');                          -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261201000000_teacher_applications';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later is safe: the migration creates everything again (empty).
BEGIN;

DO $$
DECLARE
  applications bigint;
  contacts     bigint;
BEGIN
  SELECT count(*) INTO applications FROM "TeacherApplication";
  SELECT count(*) INTO contacts FROM "User" WHERE "phone" IS NOT NULL OR "country" IS NOT NULL;
  IF (applications > 0 OR contacts > 0)
     AND current_setting('rof.teacher_applications_rollback', true) IS DISTINCT FROM 'discard-teacher-applications' THEN
    RAISE EXCEPTION 'TEACHER_APPLICATIONS_ROLLBACK_REFUSED: % teacher application(s) and % account phone/country value(s) would be lost; nothing was changed. After a backup that contains them, SET rof.teacher_applications_rollback = ''discard-teacher-applications'' and run again.', applications, contacts;
  END IF;
END $$;

DROP TABLE IF EXISTS "TeacherApplication";
DROP TYPE IF EXISTS "TeacherApplicationStatus";
DROP TYPE IF EXISTS "OlympiadSubject";
ALTER TABLE "User" DROP COLUMN IF EXISTS "phone", DROP COLUMN IF EXISTS "country";

COMMIT;
