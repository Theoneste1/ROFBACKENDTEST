-- Rollback of 20261228000000_form_email_verification. Removes only the per-form switch; nothing else.
-- After a rollback the previous backend reads registration.requireEmailVerification again (its stored value applies).
BEGIN;
ALTER TABLE "FormAvailability" DROP COLUMN IF EXISTS "requireEmailVerification";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261228000000_form_email_verification';
COMMIT;
