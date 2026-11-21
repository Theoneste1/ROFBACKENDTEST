-- Rollback for 20261223000100_test_resubmission_lock (locked test submissions; owner, 2026-11-21).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the table).
--
-- It drops TestResubmissionAuthorization: the record of every unlock (who authorized it, why, when, which replacement
-- used it) would be LOST — the versions themselves stay. It REFUSES, and changes nothing, while any authorization exists.
-- To discard them knowingly, after a backup that contains them, run this file in a session that first sets:
--     SET rof.test_resubmission_lock_rollback = 'discard-authorizations';
-- Rolled back, submitted answers are no longer locked by the database's history (the previous code allows replacing).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'TestResubmissionAuthorization';   -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261223000100_test_resubmission_lock';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "TestSubmission" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  rows bigint;
BEGIN
  SELECT count(*) INTO rows FROM "TestResubmissionAuthorization";
  IF rows > 0 AND coalesce(current_setting('rof.test_resubmission_lock_rollback', true), '') <> 'discard-authorizations' THEN
    RAISE EXCEPTION 'TEST_RESUBMISSION_LOCK_ROLLBACK_REFUSED: % resubmission authorization(s) exist; their history would be lost. Back up, then SET rof.test_resubmission_lock_rollback = ''discard-authorizations'' to proceed.', rows;
  END IF;
END $$;

DROP TABLE "TestResubmissionAuthorization";

COMMIT;
