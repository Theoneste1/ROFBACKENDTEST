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
--   2. Then, and only then, mark the migration rolled back:
--        npx prisma migrate resolve --rolled-back 20270102000000_session_activity
BEGIN;

ALTER TABLE "RefreshToken" DROP COLUMN "lastActivityAt";

COMMIT;
