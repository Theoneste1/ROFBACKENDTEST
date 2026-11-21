-- Rollback for 20261208000000_form_availability (form availability). Run manually, with approval, after a backup,
-- and after deploying the previous application release (the current code reads and writes "FormAvailability";
-- the previous release reads registration.studentSelfSignup / registration.teacherSelfSignup from "SystemSetting").
--
-- It first WRITES BACK the two old switches from the forms' current state, so the previous release keeps the
-- registration open or closed exactly as it is now:
--   registration.studentSelfSignup = STUDENT_REGISTRATION is open right now (by its mode and dates)
--   registration.teacherSelfSignup = TEACHER_REGISTRATION is open right now (the previous release still requires
--                                    TEACHERS_ENABLED as well)
-- then drops the table and its two enums.
--
-- It REFUSES, and changes nothing, while any form holds something the previous release cannot keep: a schedule
-- (mode SCHEDULED, or an opening / closing date), a custom closed message, instructions, a contact e-mail or a
-- support link, or the coach application / contact form being closed (the previous release has no switch for
-- them: they would reopen). To discard them knowingly, after a backup that contains them, run this file in a
-- session that first sets:
--     SET rof.form_availability_rollback = 'discard-form-settings';
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT to_regclass('"FormAvailability"');                                                   -- expect NULL
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261208000000_form_availability';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

DO $$
DECLARE
  kept bigint;
BEGIN
  SELECT count(*) INTO kept FROM "FormAvailability"
   WHERE "mode" = 'SCHEDULED' OR "opensAt" IS NOT NULL OR "closesAt" IS NOT NULL
      OR "closedMessage" IS NOT NULL OR "instructions" IS NOT NULL OR "contactEmail" IS NOT NULL OR "supportUrl" IS NOT NULL
      OR ("key" IN ('COACH_APPLICATION', 'CONTACT') AND "mode" <> 'OPEN');
  IF kept > 0
     AND current_setting('rof.form_availability_rollback', true) IS DISTINCT FROM 'discard-form-settings' THEN
    RAISE EXCEPTION 'FORM_AVAILABILITY_ROLLBACK_REFUSED: % form(s) have a schedule, custom texts or a closed state the previous release cannot keep; nothing was changed. After a backup that contains them, SET rof.form_availability_rollback = ''discard-form-settings'' and run again.', kept;
  END IF;
END $$;

-- Write the two old switches back from the forms' state right now (same rules as the application).
INSERT INTO "SystemSetting" ("key", "value", "updatedById", "updatedAt")
SELECT CASE f."key" WHEN 'STUDENT_REGISTRATION' THEN 'registration.studentSelfSignup' ELSE 'registration.teacherSelfSignup' END,
       to_jsonb(
         f."mode" <> 'CLOSED'
         AND (f."closesAt" IS NULL OR now() < f."closesAt")
         AND (f."mode" <> 'SCHEDULED' OR (f."opensAt" IS NOT NULL AND now() >= f."opensAt"))
       ),
       f."updatedById", now()
  FROM "FormAvailability" f
 WHERE f."key" IN ('STUDENT_REGISTRATION', 'TEACHER_REGISTRATION')
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedById" = EXCLUDED."updatedById", "updatedAt" = EXCLUDED."updatedAt";

DROP TABLE IF EXISTS "FormAvailability";
DROP TYPE IF EXISTS "FormMode";
DROP TYPE IF EXISTS "FormKey";

COMMIT;
