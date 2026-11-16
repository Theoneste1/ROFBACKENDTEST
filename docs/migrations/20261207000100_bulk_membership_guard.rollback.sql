-- Rollback for 20261207000100_bulk_membership_guard (the bulk-operation membership guard; after
-- 20261207000000_bulk_operations). Run manually, with approval, after deploying the previous application release.
--
-- It removes the trigger and its function. No data changes. Without the guard, creating a bulk operation can no
-- longer exclude membership changes that commit while it is being created — so roll this back only together with
-- (or after) the release that creates bulk operations.
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the trigger is gone:
--        SELECT count(*) FROM pg_trigger WHERE tgname = 'user_bulk_membership_guard';                       -- expect 0
--   2. Mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261207000100_bulk_membership_guard';
BEGIN;

DROP TRIGGER IF EXISTS user_bulk_membership_guard ON "User";
DROP FUNCTION IF EXISTS user_bulk_membership_guard();

COMMIT;
