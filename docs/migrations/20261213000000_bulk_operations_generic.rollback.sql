-- Rollback for 20261213000000_bulk_operations_generic (generic bulk engine, 2026-11-19).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes BulkOperation.entityType and BulkOperationItem.entityId).
--
-- It drops the trigger bulk_item_entity_from_user and its function, the single-use index on v2 confirmations
-- (BulkOperation_selectionToken_v2_key), the (operationId, entityId) unique index and the two columns, and makes
-- BulkOperationItem.userId NOT NULL again. Every USER operation and item is kept unchanged (userId always equals entityId for them).
--
-- It REFUSES, and changes nothing, while any operation of another record type exists (entityType <> 'USER'): the
-- previous release cannot read them, and their items have no userId. To discard them knowingly — the operations and
-- their per-record results; the changes they made to records stay — after a backup that contains them, run this file in
-- a session that first sets:
--     SET rof.bulk_operations_generic_rollback = 'discard-non-user-operations';
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE (table_name = 'BulkOperation' AND column_name = 'entityType')
--            OR (table_name = 'BulkOperationItem' AND column_name = 'entityId');                     -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261213000000_bulk_operations_generic';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "BulkOperation", "BulkOperationItem" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  other bigint;
  mismatched bigint;
BEGIN
  SELECT count(*) INTO other FROM "BulkOperation" WHERE "entityType" <> 'USER';
  IF other > 0
     AND current_setting('rof.bulk_operations_generic_rollback', true) IS DISTINCT FROM 'discard-non-user-operations' THEN
    RAISE EXCEPTION 'BULK_OPERATIONS_GENERIC_ROLLBACK_REFUSED: % bulk operation(s) of another record type than USER exist; nothing was changed. After a backup that contains them, SET rof.bulk_operations_generic_rollback = ''discard-non-user-operations'' and run again.', other;
  END IF;
  -- USER items must still say the same thing in both columns (the previous release reads userId only).
  SELECT count(*) INTO mismatched FROM "BulkOperationItem" i JOIN "BulkOperation" o ON o."id" = i."operationId"
   WHERE o."entityType" = 'USER' AND i."userId" IS DISTINCT FROM i."entityId";
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'BULK_OPERATIONS_GENERIC_ROLLBACK_REFUSED: % USER item(s) whose userId differs from entityId; nothing was changed. Investigate before rolling back.', mismatched;
  END IF;
END $$;

-- Acknowledged above (or none exist): operations of other record types and, by cascade, their items.
DELETE FROM "BulkOperation" WHERE "entityType" <> 'USER';

DROP TRIGGER IF EXISTS bulk_item_entity_from_user ON "BulkOperationItem";
DROP FUNCTION IF EXISTS bulk_item_entity_from_user();
DROP INDEX IF EXISTS "BulkOperation_selectionToken_v2_key";
DROP INDEX IF EXISTS "BulkOperationItem_operationId_entityId_key";
ALTER TABLE "BulkOperationItem" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "BulkOperationItem" DROP COLUMN IF EXISTS "entityId";
ALTER TABLE "BulkOperation" DROP COLUMN IF EXISTS "entityType";

COMMIT;
