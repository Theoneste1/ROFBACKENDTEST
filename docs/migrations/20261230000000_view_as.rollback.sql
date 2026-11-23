-- Rollback for 20261230000000_view_as ("view as", read only; owner 2026-11-23).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the table on every viewing request).
--
-- It drops the ViewAsSession table: the record of who viewed the platform as whom (and why) would be LOST — the audit
-- log keeps VIEW_AS_STARTED / VIEW_AS_ENDED either way. It REFUSES, and changes nothing, while any row exists. To
-- discard them knowingly, after a backup that contains them, run this file in a session that first sets:
--     SET rof.view_as_rollback = 'discard-sessions';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'ViewAsSession';   -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261230000000_view_as';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "ViewAsSession" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  sessions bigint;
BEGIN
  SELECT count(*) INTO sessions FROM "ViewAsSession";
  IF sessions > 0 AND coalesce(current_setting('rof.view_as_rollback', true), '') <> 'discard-sessions' THEN
    RAISE EXCEPTION 'VIEW_AS_ROLLBACK_REFUSED: % viewing session record(s) would be lost; nothing was changed. Back up, then SET rof.view_as_rollback = ''discard-sessions'' to proceed.', sessions;
  END IF;
END $$;

DROP TABLE "ViewAsSession";

COMMIT;
