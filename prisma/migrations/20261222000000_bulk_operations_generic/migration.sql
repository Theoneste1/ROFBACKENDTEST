-- Bulk operations become generic (2026-11-19; docs/operations/bulk-operations.md). Additive for existing data: every
-- existing operation is a USER operation and keeps every row and column.
--
--   BulkOperation.entityType      the record type; existing rows (and the column default) are 'USER'.
--   BulkOperationItem.entityId    the record; backfilled from userId for every existing item (all are USER items),
--                                 then NOT NULL; unique per (operationId, entityId).
--   BulkOperationItem.userId      kept, still set for USER items; nullable for other record types. Its unique index
--                                 (operationId, userId) is kept (NULLs never collide).
--   BulkOperation_selectionToken_v2_key  a v2 confirmation (signed, since 2026-11-19) creates at most ONE operation:
--                                 partial unique index on selectionToken for v2 tokens only (v1 digests may repeat).
--   bulk_item_entity_from_user    rolling-deploy safety: an INSERT without entityId (the previous release's code)
--                                 gets entityId = userId (BEFORE INSERT trigger), so the column stays NOT NULL.
-- No row is created, removed or otherwise changed. Rollback: docs/migrations/20261222000000_bulk_operations_generic.rollback.sql

-- AlterTable
ALTER TABLE "BulkOperation" ADD COLUMN     "entityType" TEXT NOT NULL DEFAULT 'USER';

-- AlterTable
ALTER TABLE "BulkOperationItem" ADD COLUMN     "entityId" TEXT;

-- Backfill: every existing item is a USER item.
UPDATE "BulkOperationItem" SET "entityId" = "userId";

ALTER TABLE "BulkOperationItem" ALTER COLUMN "entityId" SET NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BulkOperationItem_operationId_entityId_key" ON "BulkOperationItem"("operationId", "entityId");

-- A v2 confirmation is single-use (existing v1 digests are not affected).
CREATE UNIQUE INDEX "BulkOperation_selectionToken_v2_key" ON "BulkOperation"("selectionToken") WHERE "selectionToken" LIKE 'v2.%';

-- Rolling deploy: the previous release inserts items with userId only.
CREATE OR REPLACE FUNCTION bulk_item_entity_from_user() RETURNS trigger AS $$
BEGIN
  IF NEW."entityId" IS NULL THEN
    NEW."entityId" := NEW."userId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bulk_item_entity_from_user
  BEFORE INSERT ON "BulkOperationItem"
  FOR EACH ROW EXECUTE FUNCTION bulk_item_entity_from_user();
