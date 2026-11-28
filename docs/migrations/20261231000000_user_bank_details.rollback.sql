-- Rollback for 20261231000000_user_bank_details (banking information; owner 2026-11-25).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads the table on every request of a Teacher, Coach or Head Coach).
--
-- It drops the UserBankDetails table: every bank detail given by Teachers, Coaches and Head Coaches would be LOST. It
-- REFUSES, and changes nothing, while any row exists. To discard them knowingly, after a backup that contains them,
-- run this file in a session that first sets:
--     SET rof.bank_details_rollback = 'discard-bank-details';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'UserBankDetails';   -- expect 0
--   2. Then, and only then, remove its history row (guarded: nothing is deleted while the table exists):
--        DELETE FROM "_prisma_migrations" WHERE migration_name = '20261231000000_user_bank_details'
--          AND to_regclass('public."UserBankDetails"') IS NULL;
--      (`prisma migrate resolve --rolled-back` only applies to FAILED migrations; this one applied successfully.)
BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "UserBankDetails";
  IF n > 0 AND coalesce(current_setting('rof.bank_details_rollback', true), '') <> 'discard-bank-details' THEN
    RAISE EXCEPTION 'BANK_DETAILS_ROLLBACK_REFUSED: % person(s)'' bank details would be lost; nothing was changed. Back up, then SET rof.bank_details_rollback = ''discard-bank-details'' to proceed.', n;
  END IF;
END $$;

DROP TABLE "UserBankDetails";

COMMIT;
