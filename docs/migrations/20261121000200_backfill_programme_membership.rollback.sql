-- Rollback for M3 (20261121000200_backfill_programme_membership).
-- Removes only the rows the backfill created; MANUAL memberships (added since by
-- account creation or administrators) are kept. Run manually, with approval.
-- The backfill's AuditLog summary row stays (the audit log is append-only).
BEGIN;
DELETE FROM "ProgrammeMembership" WHERE "source" = 'BACKFILL';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000200_backfill_programme_membership';
COMMIT;
