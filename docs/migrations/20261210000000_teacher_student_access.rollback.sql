-- Rollback for 20261210000000_teacher_student_access (teacher–student assignments, delegation student scope).
-- Run manually, with approval, after a backup. ORDER (unlike the other rollbacks):
--   1. With the NEW release still serving: 20261210000000_teacher_student_access.pre-switch.sql (revokes every active
--      ASSIGNED / SELECTED delegation, audited).
--   2. Deploy the previous application release.
--   3. This file.
--
-- SECURITY: the previous release has no student scope — every teacher delegation it reads applies to EVERY student
-- the teacher sees through their schools. A delegation narrowed to ASSIGNED or SELECTED students would therefore
-- WIDEN as soon as the previous release is live — hence step 1 before the code switch. This file then guarantees it
-- again under a table lock (a narrowed delegation written concurrently is revoked, never kept unscoped).
--
-- It REFUSES, and changes nothing, while anything exists that the previous release cannot keep: a teacher–student
-- assignment, a selected-student row, or a delegation whose scope is not SCHOOL. To discard them knowingly, after a
-- backup that contains them, run this file in a session that first sets:
--     SET rof.teacher_student_rollback = 'discard-teacher-student-access';
-- Then every delegation whose scope is ASSIGNED or SELECTED is REVOKED first (revokeReason ROLLBACK, so it can never
-- apply school-wide), and the tables and columns are dropped. SCHOOL-scope delegations keep working unchanged.
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the tables are gone:
--        SELECT to_regclass('"TeacherStudentAssignment"'), to_regclass('"UserPermissionOverrideStudent"');  -- expect NULL, NULL
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261210000000_teacher_student_access';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

-- Before the check: a row written concurrently is either committed and counted, or waits and then sees the tables gone.
LOCK TABLE "UserPermissionOverride", "UserPermissionOverrideStudent", "TeacherStudentAssignment" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  assignments bigint;
  selections  bigint;
  narrowed    bigint;
BEGIN
  SELECT count(*) INTO assignments FROM "TeacherStudentAssignment";
  SELECT count(*) INTO selections  FROM "UserPermissionOverrideStudent";
  SELECT count(*) INTO narrowed    FROM "UserPermissionOverride" WHERE "studentScope" IN ('ASSIGNED', 'SELECTED');
  IF (assignments + selections + narrowed) > 0
     AND current_setting('rof.teacher_student_rollback', true) IS DISTINCT FROM 'discard-teacher-student-access' THEN
    RAISE EXCEPTION 'TEACHER_STUDENT_ROLLBACK_REFUSED: % assignment(s), % selected-student row(s), % narrowed delegation(s) exist; nothing was changed. After a backup that contains them, SET rof.teacher_student_rollback = ''discard-teacher-student-access'' and run again.', assignments, selections, narrowed;
  END IF;
END $$;

-- Narrowed delegations stop for good (never widened to the whole school by the previous release); audited.
WITH revoked AS (
  UPDATE "UserPermissionOverride"
     SET "revokedAt" = now(), "revokeReason" = 'ROLLBACK'
   WHERE "studentScope" IN ('ASSIGNED', 'SELECTED') AND "revokedAt" IS NULL
  RETURNING "id", "userId", "permission", "studentScope"
)
INSERT INTO "AuditLog" ("id", "action", "entity", "entityId", "metadata", "createdAt")
SELECT gen_random_uuid()::text, 'PERMISSION_OVERRIDE_REVOKE', 'UserPermissionOverride', "id",
       jsonb_build_object('targetUserId', "userId", 'permission', "permission", 'studentScope', "studentScope"::text,
                          'reason', 'ROLLBACK', 'previous', jsonb_build_object('active', true),
                          'next', jsonb_build_object('active', false), 'via', 'RELEASE_ROLLBACK'),
       CURRENT_TIMESTAMP
  FROM revoked;

ALTER TABLE "UserPermissionOverride" DROP CONSTRAINT IF EXISTS "UserPermissionOverride_student_scope";
DROP TABLE IF EXISTS "UserPermissionOverrideStudent";
DROP TABLE IF EXISTS "TeacherStudentAssignment";
ALTER TABLE "UserPermissionOverride"
  DROP COLUMN IF EXISTS "studentScope",
  DROP COLUMN IF EXISTS "reviewNeededAt",
  DROP COLUMN IF EXISTS "reviewReason";
DROP TYPE IF EXISTS "DelegationStudentScope";
DROP TYPE IF EXISTS "TeacherStudentSource";

COMMIT;
