-- Rollback for M5 (20261121000400_permission_overrides). Run manually, with approval.
-- Drops the overrides table and its enum: all overrides are lost (the audit log keeps
-- their history). Nothing else is touched.
BEGIN;
DROP TABLE "UserPermissionOverride";
DROP TYPE "OverrideEffect";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000400_permission_overrides';
COMMIT;
