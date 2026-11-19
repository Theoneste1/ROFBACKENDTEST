-- Bulk operations become generic (2026-11-19; docs/operations/bulk-operations.md). Additive for existing data: every
-- existing operation is a USER operation and keeps every row and column.
--
--   BulkOperation.entityType      the record type; existing rows (and the column default) are 'USER'.
--   BulkOperationItem.entityId    the record; backfilled from userId for every existing item (all are USER items),
--                                 then NOT NULL; unique per (operationId, entityId).
--   BulkOperationItem.userId      kept, still set for USER items; nullable for other record types. Its unique index
--                                 (operationId, userId) is kept (NULLs never collide).
-- No row is created, removed or otherwise changed. Rollback: docs/migrations/20261213000000_bulk_operations_generic.rollback.sql

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
