-- Rollback for 20261227000000_coach_programme_access (coaches across their programmes; owner, 2026-11-23).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads the table: without it every coach would lose programme-wide access at once — that is the previous behaviour).
--
-- It drops the CoachProgrammeRestriction table and the CoachCapability type: the record of which coaches had a part of
-- their programme access taken away (and the history) would be LOST. It REFUSES, and changes nothing, while any row
-- exists that is not a carried-over marking revocation. To discard them knowingly, after a backup that contains them,
-- run this file in a session that first sets:
--     SET rof.coach_programme_access_rollback = 'discard-restrictions';
-- Marker authorisations are untouched (the carried-over revocations are still recorded on them).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm: SELECT to_regclass('"CoachProgrammeRestriction"');  -- expect NULL
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261227000000_coach_programme_access';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "CoachProgrammeRestriction" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  made bigint;
BEGIN
  SELECT count(*) INTO made FROM "CoachProgrammeRestriction" WHERE "reason" NOT LIKE 'Carried over from the revoked marking authorisation:%';
  IF made > 0 AND coalesce(current_setting('rof.coach_programme_access_rollback', true), '') <> 'discard-restrictions' THEN
    RAISE EXCEPTION 'Refusing: % coach access restriction(s) were recorded since the release. Set rof.coach_programme_access_rollback = ''discard-restrictions'' to proceed.', made;
  END IF;
END $$;

DROP TABLE "CoachProgrammeRestriction";
DROP TYPE "CoachCapability";

COMMIT;
