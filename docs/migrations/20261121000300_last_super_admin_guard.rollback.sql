-- Rollback for M4 (20261121000300_last_super_admin_guard). Run manually, with approval.
-- Removes the database-level protection only; the application rule (409
-- LAST_SUPER_ADMIN) stays. No data changes.
BEGIN;
DROP TRIGGER IF EXISTS user_last_super_admin_guard ON "User";
DROP FUNCTION IF EXISTS user_last_super_admin_guard();
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000300_last_super_admin_guard';
COMMIT;
