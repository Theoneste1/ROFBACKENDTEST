-- Rollback for M7 (20261121000600_school_codes). Run manually, with approval, AFTER the
-- M8 rollback. Drops the six official-list columns and their indexes; schools and
-- students are kept (they lose only code, province, district, sector, ownership, nameKey).
BEGIN;
DROP INDEX "School_province_district_sector_idx";
DROP INDEX "School_nameKey_idx";
DROP INDEX "School_code_key";
ALTER TABLE "School" DROP COLUMN "code", DROP COLUMN "province", DROP COLUMN "district", DROP COLUMN "sector",
  DROP COLUMN "ownership", DROP COLUMN "nameKey";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000600_school_codes';
COMMIT;
