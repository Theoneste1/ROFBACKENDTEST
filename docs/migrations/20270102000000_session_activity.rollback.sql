-- Rollback for 20270102000000_session_activity (session inactivity; owner 2026-11-28).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the column on every sign-in, refresh and activity report).
--
-- It drops RefreshToken."lastActivityAt". Nothing else is lost: sessions keep working with the previous release
-- (which has no inactivity limit). No data guard is needed — the column only holds the time of the last activity.
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'RefreshToken' AND column_name = 'lastActivityAt';   -- expect 0
--   2. Then, and only then, remove its history row (guarded: nothing is deleted while the column exists):
--        DELETE FROM "_prisma_migrations" WHERE migration_name = '20270102000000_session_activity'
--          AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'RefreshToken' AND column_name = 'lastActivityAt');
--      (`prisma migrate resolve --rolled-back` only applies to FAILED migrations: on this one it is refused with P3012,
--      and a history row left behind makes the next `migrate deploy` skip the migration. Rehearsed 2026-11-28.)
BEGIN;

ALTER TABLE "RefreshToken" DROP COLUMN "lastActivityAt";

COMMIT;
