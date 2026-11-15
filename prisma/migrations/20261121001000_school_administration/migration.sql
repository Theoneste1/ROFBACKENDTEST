-- M11 (Phase 1, school administration PR B; owner-approved 2026-11-11): school records that
-- Administrators can create, edit, deactivate and reactivate.
--
-- Additive only: one enum (SchoolSource) and five School columns, two indexes and one foreign
-- key. No existing id, name, code, row or relationship changes — students, claims, enrolments,
-- submissions and Teacher assignments keep pointing at the same schools.
--
--   countryCode  ISO 3166-1 alpha-2, default 'RW' (every existing school is Rwandan)
--   isActive     default true (every existing school stays active)
--   source       OFFICIAL_LIST (from the M8 directory: has a code) / ADMIN / LEGACY (no code)
--   createdById  the Administrator who created it (NULL for existing schools)
--   updatedAt    default now
--
-- Backfill (the BACKFILL block; idempotent): every school with a code → OFFICIAL_LIST; the others
-- stay LEGACY. One count-only AuditLog summary row, written only when rows changed.
-- Explicit transaction: everything is applied together or not at all.
-- Rollback: docs/migrations/20261121001000_school_administration.rollback.sql (before M10's).

BEGIN;

-- CreateEnum
CREATE TYPE "SchoolSource" AS ENUM ('OFFICIAL_LIST', 'ADMIN', 'LEGACY');

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "countryCode" TEXT NOT NULL DEFAULT 'RW',
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source" "SchoolSource" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "School_countryCode_isActive_idx" ON "School"("countryCode", "isActive");

-- CreateIndex
CREATE INDEX "School_createdById_idx" ON "School"("createdById");

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BACKFILL BEGIN
DO $$
DECLARE
  official int := 0;
  legacy   int := 0;
BEGIN
  UPDATE "School" SET "source" = 'OFFICIAL_LIST'
   WHERE "code" IS NOT NULL AND "source" = 'LEGACY' AND "createdById" IS NULL;
  GET DIAGNOSTICS official = ROW_COUNT;
  SELECT count(*) INTO legacy FROM "School" WHERE "source" = 'LEGACY';

  IF official > 0 THEN
    INSERT INTO "AuditLog" ("id", "action", "entity", "metadata", "createdAt")
    VALUES (gen_random_uuid()::text, 'SCHOOL_SOURCE_BACKFILL', 'School',
            jsonb_build_object('officialList', official, 'legacy', legacy), CURRENT_TIMESTAMP);
  END IF;
  RAISE NOTICE 'School source backfill: % OFFICIAL_LIST, % LEGACY (uncoded).', official, legacy;
END $$;
-- BACKFILL END

COMMIT;
