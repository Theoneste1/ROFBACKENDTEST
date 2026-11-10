-- M7 (Phase 1, P1-11): official school codes (owner decision 2026-11-10).
-- Additive only: six nullable School columns, a unique index on code and two lookup
-- indexes. No existing column, constraint or row changes (School.name stays unique).
-- The official list itself is loaded by M8. Explicit transaction.
-- Rollback: docs/migrations/20261121000600_school_codes.rollback.sql

BEGIN;

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "code" TEXT,
ADD COLUMN     "district" TEXT,
ADD COLUMN     "nameKey" TEXT,
ADD COLUMN     "ownership" TEXT,
ADD COLUMN     "province" TEXT,
ADD COLUMN     "sector" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "School_code_key" ON "School"("code");

-- CreateIndex
CREATE INDEX "School_nameKey_idx" ON "School"("nameKey");

-- CreateIndex
CREATE INDEX "School_province_district_sector_idx" ON "School"("province", "district", "sector");


COMMIT;
