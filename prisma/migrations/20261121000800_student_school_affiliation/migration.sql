-- M9 (Phase 1, school administration PR A): student–school affiliation (owner-approved 2026-11-10).
-- Additive only: two enums and one table (StudentSchoolAffiliation); no existing table, column,
-- constraint or row is changed. Explicit transaction: everything is created together or not at all.
--
-- Backfill (the BACKFILL block below; idempotent, nobody becomes VERIFIED):
--   * every STUDENT with a school            → one PENDING claim for that school, source MIGRATION;
--   * every STUDENT without a school whose latest REGISTER audit entry recorded an entered school
--     name (international or unmatched, since P1-11) → one PENDING claim without a school,
--     holding that name and the country;
--   * one count-only AuditLog summary row, written only when rows were added.
-- Existing ids, users, schools, enrolments and submissions are not modified.
-- Rollback: docs/migrations/20261121000800_student_school_affiliation.rollback.sql

BEGIN;

-- CreateEnum
CREATE TYPE "SchoolAffiliationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SchoolAffiliationSource" AS ENUM ('REGISTRATION', 'ADMIN', 'MIGRATION', 'STUDENT_REQUEST');

-- CreateTable
CREATE TABLE "StudentSchoolAffiliation" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "schoolId" TEXT,
    "claimedName" TEXT,
    "claimedCountry" TEXT,
    "claimedProvince" TEXT,
    "claimedDistrict" TEXT,
    "claimedSector" TEXT,
    "status" "SchoolAffiliationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "SchoolAffiliationSource" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersedeReason" TEXT,

    CONSTRAINT "StudentSchoolAffiliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_studentId_supersededAt_idx" ON "StudentSchoolAffiliation"("studentId", "supersededAt");

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_schoolId_status_idx" ON "StudentSchoolAffiliation"("schoolId", "status");

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_status_idx" ON "StudentSchoolAffiliation"("status");

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_createdById_idx" ON "StudentSchoolAffiliation"("createdById");

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_decidedById_idx" ON "StudentSchoolAffiliation"("decidedById");

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_revokedById_idx" ON "StudentSchoolAffiliation"("revokedById");

-- CreateIndex
CREATE INDEX "StudentSchoolAffiliation_supersededById_idx" ON "StudentSchoolAffiliation"("supersededById");

-- AddForeignKey
ALTER TABLE "StudentSchoolAffiliation" ADD CONSTRAINT "StudentSchoolAffiliation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSchoolAffiliation" ADD CONSTRAINT "StudentSchoolAffiliation_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSchoolAffiliation" ADD CONSTRAINT "StudentSchoolAffiliation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSchoolAffiliation" ADD CONSTRAINT "StudentSchoolAffiliation_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSchoolAffiliation" ADD CONSTRAINT "StudentSchoolAffiliation_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSchoolAffiliation" ADD CONSTRAINT "StudentSchoolAffiliation_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- BACKFILL BEGIN
DO $$
DECLARE
  with_school int := 0;
  name_only   int := 0;
BEGIN
  INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "status", "source", "createdAt")
  SELECT gen_random_uuid()::text, u."id", u."schoolId", 'PENDING', 'MIGRATION', CURRENT_TIMESTAMP
    FROM "User" u
   WHERE u."role" = 'STUDENT' AND u."schoolId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "StudentSchoolAffiliation" a WHERE a."studentId" = u."id" AND a."supersededAt" IS NULL);
  GET DIAGNOSTICS with_school = ROW_COUNT;

  INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "claimedName", "claimedCountry", "status", "source", "createdAt")
  SELECT gen_random_uuid()::text, u."id", NULL, r.metadata->>'schoolNameEntered', COALESCE(r.metadata->>'country', 'RW'),
         'PENDING', 'MIGRATION', CURRENT_TIMESTAMP
    FROM "User" u
    JOIN LATERAL (
      SELECT l."metadata" FROM "AuditLog" l
       WHERE l."action" = 'REGISTER' AND l."entityId" = u."id"
       ORDER BY l."createdAt" DESC LIMIT 1
    ) r ON true
   WHERE u."role" = 'STUDENT' AND u."schoolId" IS NULL
     AND COALESCE(trim(r.metadata->>'schoolNameEntered'), '') <> ''
     AND NOT EXISTS (SELECT 1 FROM "StudentSchoolAffiliation" a WHERE a."studentId" = u."id" AND a."supersededAt" IS NULL);
  GET DIAGNOSTICS name_only = ROW_COUNT;

  IF with_school > 0 OR name_only > 0 THEN
    INSERT INTO "AuditLog" ("id", "action", "entity", "metadata", "createdAt")
    VALUES (gen_random_uuid()::text, 'SCHOOL_AFFILIATION_BACKFILL', 'StudentSchoolAffiliation',
            jsonb_build_object('withSchool', with_school, 'nameOnly', name_only), CURRENT_TIMESTAMP);
  END IF;
  RAISE NOTICE 'Affiliation backfill: % with a school, % name-only, all PENDING.', with_school, name_only;
END $$;
-- BACKFILL END

COMMIT;
