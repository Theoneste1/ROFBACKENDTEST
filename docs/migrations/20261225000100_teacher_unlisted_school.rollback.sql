-- Rollback for 20261225000100_teacher_unlisted_school (teacher registration: an unlisted school's details; owner, 2026-11-22).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the columns).
--
-- It drops the five proposedSchool* detail columns from TeacherApplication: the official code, cell, village, ownership
-- and day/boarding given by applicants since the release would be LOST (their school name and place stay). It REFUSES,
-- and changes nothing, while a PENDING application still has a proposed code. To discard them knowingly, after a backup
-- that contains them, run this file in a session that first sets:
--     SET rof.teacher_unlisted_school_rollback = 'discard-details';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'TeacherApplication' AND column_name LIKE 'proposedSchool%';  -- expect 1 (the name)
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261225000100_teacher_unlisted_school';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "TeacherApplication" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  pending bigint;
BEGIN
  SELECT count(*) INTO pending FROM "TeacherApplication" WHERE "status" = 'PENDING' AND "proposedSchoolCode" IS NOT NULL;
  IF pending > 0 AND coalesce(current_setting('rof.teacher_unlisted_school_rollback', true), '') <> 'discard-details' THEN
    RAISE EXCEPTION 'Refusing: % pending application(s) propose a school code. Set rof.teacher_unlisted_school_rollback = ''discard-details'' to proceed.', pending;
  END IF;
END $$;

ALTER TABLE "TeacherApplication"
  DROP COLUMN "proposedSchoolCode",
  DROP COLUMN "proposedSchoolCell",
  DROP COLUMN "proposedSchoolVillage",
  DROP COLUMN "proposedSchoolOwnership",
  DROP COLUMN "proposedSchoolAccommodation";

COMMIT;
