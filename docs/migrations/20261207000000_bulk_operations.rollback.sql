-- Rollback for 20261207000000_bulk_operations (bulk user operations; after 20261206000000_account_states).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads and writes BulkOperation and BulkOperationItem).
--
-- It removes what this migration created: the two tables, their enums and the two User indexes. Account changes
-- made by bulk operations are NOT undone (they are ordinary changes, each with its own audit and status-history row).
--
-- It REFUSES, and changes nothing, while any bulk operation is recorded (its per-user results would be lost). To
-- discard them knowingly, after a backup that contains them, run this file in a session that first sets:
--     SET rof.bulk_operations_rollback = 'discard-bulk-operations';
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'BulkOperation';             -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261207000000_bulk_operations';
BEGIN;

DO $$
DECLARE
  operations bigint;
BEGIN
  SELECT count(*) INTO operations FROM "BulkOperation";
  IF operations > 0
     AND current_setting('rof.bulk_operations_rollback', true) IS DISTINCT FROM 'discard-bulk-operations' THEN
    RAISE EXCEPTION 'BULK_OPERATIONS_ROLLBACK_REFUSED: % bulk operation(s) and their per-user results would be lost; nothing was changed. After a backup that contains them, SET rof.bulk_operations_rollback = ''discard-bulk-operations'' and run again.', operations;
  END IF;
END $$;

DROP TABLE IF EXISTS "BulkOperationItem";
DROP TABLE IF EXISTS "BulkOperation";
DROP TYPE IF EXISTS "BulkItemOutcome";
DROP TYPE IF EXISTS "BulkOperationStatus";
DROP INDEX IF EXISTS "User_createdAt_idx";
DROP INDEX IF EXISTS "User_gradeLevel_idx";

COMMIT;
