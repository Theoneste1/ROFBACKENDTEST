-- Rollback for 20261226000000_registration_data (registration data for Super Administrators; owner, 2026-11-23).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the column and the table).
--
-- It drops MentorRequest.userId (the link from a coach application to its account; rebuilt by re-running the migration)
-- and the RegistrationSavedFilter table: Super Administrators' SAVED FILTERS would be LOST. It REFUSES, and changes
-- nothing, while any saved filter exists. To discard them knowingly, after a backup that contains them, run this file in
-- a session that first sets:
--     SET rof.registration_data_rollback = 'discard-saved-filters';
-- No account, application or registration value is changed by this rollback (column layouts live in TableLayout, rows
-- with table 'registration.<CATEGORY>'; they are left in place and ignored by the previous release).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm both are gone:
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'MentorRequest' AND column_name = 'userId';    -- expect 0
--        SELECT to_regclass('"RegistrationSavedFilter"');                                                                 -- expect NULL
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261226000000_registration_data';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "RegistrationSavedFilter" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  saved bigint;
BEGIN
  SELECT count(*) INTO saved FROM "RegistrationSavedFilter";
  IF saved > 0 AND coalesce(current_setting('rof.registration_data_rollback', true), '') <> 'discard-saved-filters' THEN
    RAISE EXCEPTION 'Refusing: % saved filter(s) exist. Set rof.registration_data_rollback = ''discard-saved-filters'' to proceed.', saved;
  END IF;
END $$;

DROP TABLE "RegistrationSavedFilter";

ALTER TABLE "MentorRequest" DROP CONSTRAINT "MentorRequest_userId_fkey";
DROP INDEX "MentorRequest_userId_key";
ALTER TABLE "MentorRequest" DROP COLUMN "userId";

COMMIT;
