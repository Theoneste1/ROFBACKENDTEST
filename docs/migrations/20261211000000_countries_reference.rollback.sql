-- Rollback for 20261211000000_countries_reference (countries; design area 1 as simplified by the owner, 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads "Country").
--
-- It drops the School.countryCode foreign key and the Country table. School.countryCode itself (and every other country
-- column) is kept unchanged, so no school, account or application loses its country.
--
-- It REFUSES, and changes nothing, while an Administrator has corrected any country's name or calling code (the row was
-- changed after the migration): those corrections exist only in this table (and in the audit log). To discard them
-- knowingly, after a backup that contains them, run this file in a session that first sets:
--     SET rof.countries_reference_rollback = 'discard-country-edits';
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT to_regclass('"Country"');                                                                 -- expect NULL
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261211000000_countries_reference';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "Country" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  edited bigint;
BEGIN
  SELECT count(*) INTO edited FROM "Country" WHERE "updatedAt" <> "createdAt";
  IF edited > 0
     AND current_setting('rof.countries_reference_rollback', true) IS DISTINCT FROM 'discard-country-edits' THEN
    RAISE EXCEPTION 'COUNTRIES_ROLLBACK_REFUSED: % country row(s) were corrected by an Administrator; nothing was changed. After a backup that contains them, SET rof.countries_reference_rollback = ''discard-country-edits'' and run again.', edited;
  END IF;
END $$;

ALTER TABLE "School" DROP CONSTRAINT IF EXISTS "School_countryCode_fkey";
DROP TABLE IF EXISTS "Country";

COMMIT;
