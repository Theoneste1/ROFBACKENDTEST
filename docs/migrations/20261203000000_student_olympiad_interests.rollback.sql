-- Rollback for 20261203000000_student_olympiad_interests (Olympiad interests of students; after Phase 1
-- M1–M14 and after 20261201000000_teacher_applications / 20261202000000_notification_outbox).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads and writes User.olympiadInterests).
--
-- It removes ONLY what this migration created: the User.olympiadInterests column. The OlympiadSubject
-- enum belongs to 20261201000000_teacher_applications and is kept. Roll this migration back BEFORE that
-- one (its rollback drops the enum, which this column uses).
--
-- It REFUSES, and changes nothing, while any account has an Olympiad interest: that data would be lost.
-- To discard it knowingly, after a backup that contains it, run this file in a session that first sets:
--     SET rof.student_olympiad_interests_rollback = 'discard-student-olympiad-interests';
--
-- Like M9–M14, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'User' AND column_name = 'olympiadInterests';                              -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261203000000_student_olympiad_interests';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later is safe: the migration adds the column again (empty).
BEGIN;

DO $$
DECLARE
  interested bigint;
BEGIN
  SELECT count(*) INTO interested FROM "User" WHERE cardinality("olympiadInterests") > 0;
  IF interested > 0
     AND current_setting('rof.student_olympiad_interests_rollback', true) IS DISTINCT FROM 'discard-student-olympiad-interests' THEN
    RAISE EXCEPTION 'STUDENT_OLYMPIAD_INTERESTS_ROLLBACK_REFUSED: % account(s) with Olympiad interests would lose them; nothing was changed. After a backup that contains them, SET rof.student_olympiad_interests_rollback = ''discard-student-olympiad-interests'' and run again.', interested;
  END IF;
END $$;

ALTER TABLE "User" DROP COLUMN IF EXISTS "olympiadInterests";

COMMIT;
