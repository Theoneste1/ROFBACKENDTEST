-- Rollback for 20261212000000_teacher_school_primary (primary teacher of a school; owner decision 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes TeacherSchoolAssignment.role).
--
-- It drops the partial unique index, the role column and the TeacherSchoolRole enum. Every teacher–school link is kept
-- unchanged (teacher, school, active or ended, who assigned and ended it); only the PRIMARY / SECONDARY marking is lost.
--
-- It REFUSES, and changes nothing, while an Administrator has chosen a primary teacher (a TEACHER_PRIMARY_ASSIGNED
-- audit row exists): that choice exists only in this column (and in the audit log). To discard it knowingly, after a
-- backup that contains it, run this file in a session that first sets:
--     SET rof.teacher_school_primary_rollback = 'discard-primary-teachers';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'TeacherSchoolAssignment' AND column_name = 'role';                       -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261212000000_teacher_school_primary';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "TeacherSchoolAssignment" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  chosen bigint;
BEGIN
  SELECT count(*) INTO chosen FROM "AuditLog" WHERE "action" = 'TEACHER_PRIMARY_ASSIGNED';
  IF chosen > 0
     AND current_setting('rof.teacher_school_primary_rollback', true) IS DISTINCT FROM 'discard-primary-teachers' THEN
    RAISE EXCEPTION 'TEACHER_PRIMARY_ROLLBACK_REFUSED: an Administrator chose a primary teacher % time(s); nothing was changed. After a backup that contains them, SET rof.teacher_school_primary_rollback = ''discard-primary-teachers'' and run again.', chosen;
  END IF;
END $$;

DROP INDEX IF EXISTS "TeacherSchoolAssignment_one_primary_per_school";
ALTER TABLE "TeacherSchoolAssignment" DROP COLUMN IF EXISTS "role";
DROP TYPE IF EXISTS "TeacherSchoolRole";

COMMIT;
