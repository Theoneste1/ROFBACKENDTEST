-- Rollback for 20261228000000_form_email_verification (activation per sign-up form; owner, 2026-11-23).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the column).
--
-- It drops FormAvailability.requireEmailVerification. The previous release reads the single setting
-- registration.requireEmailVerification again (its stored row was kept, unchanged), so a form on which an Administrator
-- turned activation ON since the release would silently stop asking for it. It REFUSES, and changes nothing, while any
-- form has activation turned on. To discard those switches knowingly (note which forms they were first), run this file
-- in a session that first sets:
--     SET rof.form_email_verification_rollback = 'discard-verification-switches';
-- No account, form setting or other row is changed by this rollback.
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'FormAvailability' AND column_name = 'requireEmailVerification';  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261228000000_form_email_verification';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "FormAvailability" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  switched bigint;
BEGIN
  SELECT count(*) INTO switched FROM "FormAvailability" WHERE "requireEmailVerification";
  IF switched > 0 AND coalesce(current_setting('rof.form_email_verification_rollback', true), '') <> 'discard-verification-switches' THEN
    RAISE EXCEPTION 'FORM_EMAIL_VERIFICATION_ROLLBACK_REFUSED: % form(s) have activation turned on; the previous release would not ask for it there. Nothing was changed. Note them, then set rof.form_email_verification_rollback = ''discard-verification-switches'' to proceed.', switched;
  END IF;
END $$;

ALTER TABLE "FormAvailability" DROP COLUMN "requireEmailVerification";

COMMIT;
