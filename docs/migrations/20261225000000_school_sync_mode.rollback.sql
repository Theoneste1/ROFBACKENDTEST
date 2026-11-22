-- Rollback for 20261225000000_school_sync_mode (directory sync "new schools only" mode; owner, 2026-11-22).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the column).
--
-- It drops SchoolSyncRun.mode and the SchoolSyncMode type. A NEW_ONLY run would then read as FULL: its staged
-- comparison would no longer match a recompare. It REFUSES, and changes nothing, while any NEW_ONLY run exists. To
-- accept that knowingly, run this file in a session that first sets:
--     SET rof.school_sync_mode_rollback = 'forget-modes';
-- Nothing else changes (schools, runs, items, changes and source records are untouched).
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'SchoolSyncRun' AND column_name = 'mode';  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261225000000_school_sync_mode';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "SchoolSyncRun" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  runs bigint;
BEGIN
  SELECT count(*) INTO runs FROM "SchoolSyncRun" WHERE "mode" = 'NEW_ONLY';
  IF runs > 0 AND coalesce(current_setting('rof.school_sync_mode_rollback', true), '') <> 'forget-modes' THEN
    RAISE EXCEPTION 'Refusing: % NEW_ONLY sync run(s) exist. Set rof.school_sync_mode_rollback = ''forget-modes'' to proceed.', runs;
  END IF;
END $$;

ALTER TABLE "SchoolSyncRun" DROP COLUMN "mode";
DROP TYPE "SchoolSyncMode";

COMMIT;
