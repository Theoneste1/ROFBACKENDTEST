-- Rollback for 20261202000000_notification_outbox (decision notifications; after teacher self-registration).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads NotificationOutbox and TeacherApplication.schoolVerifiedAt / schoolVerifiedById).
-- Roll it back BEFORE 20261201000000_teacher_applications (it adds columns to that table).
--
-- It removes ONLY what this migration created: the NotificationOutbox table, the NotificationOutboxStatus
-- enum and the TeacherApplication.schoolVerifiedAt / schoolVerifiedById columns. The in-app Notification
-- rows written with outbox rows are ordinary notifications and are kept; the audit log keeps every action.
--
-- It REFUSES, and changes nothing, while any outbox row exists or any Teacher application has a verified
-- school: the delivery history and the verification record would be lost (a verified missing-school
-- application would then need verifying again before approval under this release, and could not be
-- approved at all under the previous one without choosing the school again). To discard them knowingly,
-- after a backup that contains them, run this file in a session that first sets:
--     SET rof.notification_outbox_rollback = 'discard-notification-outbox';
--
-- Like M9–M14, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'NotificationOutbox';      -- expect 0
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'TeacherApplication' AND column_name IN ('schoolVerifiedAt', 'schoolVerifiedById'); -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261202000000_notification_outbox';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later is safe: the migration creates everything again (empty).
BEGIN;

DO $$
DECLARE
  outbox   bigint;
  verified bigint;
BEGIN
  SELECT count(*) INTO outbox FROM "NotificationOutbox";
  SELECT count(*) INTO verified FROM "TeacherApplication" WHERE "schoolVerifiedAt" IS NOT NULL OR "schoolVerifiedById" IS NOT NULL;
  IF (outbox > 0 OR verified > 0)
     AND current_setting('rof.notification_outbox_rollback', true) IS DISTINCT FROM 'discard-notification-outbox' THEN
    RAISE EXCEPTION 'NOTIFICATION_OUTBOX_ROLLBACK_REFUSED: % notification outbox row(s) and % verified teacher-application school(s) would be lost; nothing was changed. After a backup that contains them, SET rof.notification_outbox_rollback = ''discard-notification-outbox'' and run again.', outbox, verified;
  END IF;
END $$;

DROP TABLE IF EXISTS "NotificationOutbox";
DROP TYPE IF EXISTS "NotificationOutboxStatus";
ALTER TABLE "TeacherApplication" DROP CONSTRAINT IF EXISTS "TeacherApplication_schoolVerifiedById_fkey";
DROP INDEX IF EXISTS "TeacherApplication_schoolVerifiedById_idx";
ALTER TABLE "TeacherApplication" DROP COLUMN IF EXISTS "schoolVerifiedAt", DROP COLUMN IF EXISTS "schoolVerifiedById";

COMMIT;
