-- M12 (school directory S1; owner-approved 2026-11-11): the comprehensive school directory's data
-- model, and school names that are no longer unique.
--
-- Names: official names are kept exactly as published, and several schools share a name
-- (EP KARAMA ×7). The unique index "School_name_key" is replaced by an ordinary index (name
-- search stays fast). Schools are identified by code (still unique), by their ids in a data
-- source (SchoolExternalId) and by place — never by name. A same-name school in the same district
-- remains a POSSIBLE_DUPLICATE that needs an explicit, audited confirmation.
--
-- Additive otherwise: no existing row, id or relationship changes — students, claims, enrolments,
-- submissions and Teacher assignments keep pointing at the same schools.
--
--   School               cell, village, accommodation, lastSourceSyncAt, lastVerifiedAt / By
--   SchoolDataSource     where directory data comes from (seeded: NESA); new sources are rows
--   SchoolExternalId     a school's code or fingerprint in a source; a school keeps every key it
--                        was matched by; never deleted (trigger)
--   SchoolSourceRecord   each source row verbatim (every column); never deleted, and its source
--                        data never edited (trigger) — only its link to a school may change
--   SchoolContact        e-mail / phone; ADMIN_ONLY by default; REPRESENTATIVES only when
--                        verified (CHECK constraint); never deleted — removal sets removedAt
--                        (trigger school_contact_keep)
--   EducationLevel       reference data (seeded: PPR, PR, OL, AL, PE)
--   SchoolEducationLevel, Programme, SchoolProgramme   what each school offers
--
-- Every new reference to a school is ON DELETE RESTRICT: deleting a school never silently removes
-- its directory data.
-- Explicit transaction: everything is applied together or not at all.
-- Rollback: docs/migrations/20261121001100_school_directory_model.rollback.sql (before M11's).

BEGIN;
-- CreateEnum
CREATE TYPE "SchoolAccommodation" AS ENUM ('DAY', 'BOARDING', 'MIXED');

-- CreateEnum
CREATE TYPE "SchoolContactType" AS ENUM ('EMAIL', 'PHONE', 'OTHER');

-- CreateEnum
CREATE TYPE "SchoolContactVisibility" AS ENUM ('ADMIN_ONLY', 'REPRESENTATIVES');

-- CreateEnum
CREATE TYPE "ProgrammeCategory" AS ENUM ('A_LEVEL_COMBINATION', 'TVET_TRADE', 'OTHER');

-- CreateEnum
CREATE TYPE "SchoolExternalIdKind" AS ENUM ('CODE', 'FINGERPRINT', 'OTHER');

-- DropIndex
DROP INDEX "School_name_key";

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "accommodation" "SchoolAccommodation",
ADD COLUMN     "cell" TEXT,
ADD COLUMN     "lastSourceSyncAt" TIMESTAMP(3),
ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastVerifiedById" TEXT,
ADD COLUMN     "village" TEXT;

-- CreateTable
CREATE TABLE "SchoolDataSource" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolDataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolExternalId" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "kind" "SchoolExternalIdKind" NOT NULL,
    "schoolId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "SchoolExternalId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolSourceRecord" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "datasetLabel" TEXT NOT NULL,
    "datasetSha256" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "rowHash" TEXT NOT NULL,
    "schoolId" TEXT,
    "matchedBy" TEXT,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolContact" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "type" "SchoolContactType" NOT NULL,
    "value" TEXT NOT NULL,
    "rawValue" TEXT,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "SchoolContactVisibility" NOT NULL DEFAULT 'ADMIN_ONLY',
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "dataSourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "SchoolContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EducationLevel" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "EducationLevel_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "SchoolEducationLevel" (
    "schoolId" TEXT NOT NULL,
    "levelCode" TEXT NOT NULL,
    "qualifier" TEXT,
    "sourceToken" TEXT,
    "dataSourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolEducationLevel_pkey" PRIMARY KEY ("schoolId","levelCode")
);

-- CreateTable
CREATE TABLE "Programme" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "category" "ProgrammeCategory" NOT NULL,
    "tvetLevel" INTEGER,
    "needsReview" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Programme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolProgramme" (
    "schoolId" TEXT NOT NULL,
    "programmeId" TEXT NOT NULL,
    "sourceToken" TEXT,
    "dataSourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolProgramme_pkey" PRIMARY KEY ("schoolId","programmeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolDataSource_key_key" ON "SchoolDataSource"("key");

-- CreateIndex
CREATE INDEX "SchoolExternalId_schoolId_idx" ON "SchoolExternalId"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolExternalId_dataSourceId_externalKey_key" ON "SchoolExternalId"("dataSourceId", "externalKey");

-- CreateIndex
CREATE INDEX "SchoolSourceRecord_schoolId_idx" ON "SchoolSourceRecord"("schoolId");

-- CreateIndex
CREATE INDEX "SchoolSourceRecord_dataSourceId_rowHash_idx" ON "SchoolSourceRecord"("dataSourceId", "rowHash");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSourceRecord_dataSourceId_datasetSha256_sourceRef_key" ON "SchoolSourceRecord"("dataSourceId", "datasetSha256", "sourceRef");

-- CreateIndex
CREATE INDEX "SchoolContact_verifiedById_idx" ON "SchoolContact"("verifiedById");

-- CreateIndex
CREATE INDEX "SchoolContact_dataSourceId_idx" ON "SchoolContact"("dataSourceId");

-- CreateIndex
CREATE INDEX "SchoolContact_schoolId_type_value_idx" ON "SchoolContact"("schoolId", "type", "value");

-- CreateIndex
CREATE INDEX "SchoolContact_removedById_idx" ON "SchoolContact"("removedById");

-- CreateIndex
CREATE INDEX "SchoolEducationLevel_levelCode_idx" ON "SchoolEducationLevel"("levelCode");

-- CreateIndex
CREATE INDEX "SchoolEducationLevel_dataSourceId_idx" ON "SchoolEducationLevel"("dataSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Programme_code_key" ON "Programme"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Programme_category_name_key" ON "Programme"("category", "name");

-- CreateIndex
CREATE INDEX "SchoolProgramme_programmeId_idx" ON "SchoolProgramme"("programmeId");

-- CreateIndex
CREATE INDEX "SchoolProgramme_dataSourceId_idx" ON "SchoolProgramme"("dataSourceId");

-- CreateIndex
CREATE INDEX "School_name_idx" ON "School"("name");

-- CreateIndex
CREATE INDEX "School_lastVerifiedById_idx" ON "School"("lastVerifiedById");

-- AddForeignKey
ALTER TABLE "SchoolExternalId" ADD CONSTRAINT "SchoolExternalId_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "SchoolDataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolExternalId" ADD CONSTRAINT "SchoolExternalId_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSourceRecord" ADD CONSTRAINT "SchoolSourceRecord_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "SchoolDataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSourceRecord" ADD CONSTRAINT "SchoolSourceRecord_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolContact" ADD CONSTRAINT "SchoolContact_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolContact" ADD CONSTRAINT "SchoolContact_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolContact" ADD CONSTRAINT "SchoolContact_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolContact" ADD CONSTRAINT "SchoolContact_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "SchoolDataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolEducationLevel" ADD CONSTRAINT "SchoolEducationLevel_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolEducationLevel" ADD CONSTRAINT "SchoolEducationLevel_levelCode_fkey" FOREIGN KEY ("levelCode") REFERENCES "EducationLevel"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolEducationLevel" ADD CONSTRAINT "SchoolEducationLevel_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "SchoolDataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolProgramme" ADD CONSTRAINT "SchoolProgramme_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolProgramme" ADD CONSTRAINT "SchoolProgramme_programmeId_fkey" FOREIGN KEY ("programmeId") REFERENCES "Programme"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolProgramme" ADD CONSTRAINT "SchoolProgramme_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "SchoolDataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_lastVerifiedById_fkey" FOREIGN KEY ("lastVerifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Contacts: visible to school representatives only once an Administrator has verified them.
ALTER TABLE "SchoolContact" ADD CONSTRAINT "SchoolContact_visibility_verified_check"
  CHECK ("visibility" = 'ADMIN_ONLY' OR "verifiedAt" IS NOT NULL);

-- Contacts are never deleted: removing or replacing one sets removedAt, so every value a school
-- had stays readable by Administrators (and only by them).
CREATE OR REPLACE FUNCTION school_contact_keep() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SCHOOL_CONTACT_PERMANENT: contacts are removed by setting removedAt, never deleted'
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER school_contact_keep
  BEFORE DELETE ON "SchoolContact"
  FOR EACH ROW EXECUTE FUNCTION school_contact_keep();

-- Source records: the published data is permanent. Only the link to a school (schoolId,
-- matchedBy) and the recorded issues may change; the row is never deleted.
CREATE OR REPLACE FUNCTION school_source_record_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."id", NEW."dataSourceId", NEW."datasetLabel", NEW."datasetSha256", NEW."sourceRef", NEW."raw"::text, NEW."rowHash", NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."dataSourceId", OLD."datasetLabel", OLD."datasetSha256", OLD."sourceRef", OLD."raw"::text, OLD."rowHash", OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SCHOOL_SOURCE_RECORD_IMMUTABLE: % of published source data is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER school_source_record_immutable
  BEFORE UPDATE OR DELETE ON "SchoolSourceRecord"
  FOR EACH ROW EXECUTE FUNCTION school_source_record_immutable();

-- External ids: a school keeps every key it was ever matched by (a superseded fingerprint still
-- identifies it), so they are never deleted.
CREATE OR REPLACE FUNCTION school_external_id_keep() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SCHOOL_EXTERNAL_ID_PERMANENT: a school''s source identity is never deleted'
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER school_external_id_keep
  BEFORE DELETE ON "SchoolExternalId"
  FOR EACH ROW EXECUTE FUNCTION school_external_id_keep();

-- Reference data (idempotent).
INSERT INTO "EducationLevel" ("code", "name", "sortOrder") VALUES
  ('PPR', 'Pre-primary', 1),
  ('PR',  'Primary', 2),
  ('OL',  'Ordinary Level', 3),
  ('AL',  'Advanced Level', 4),
  ('PE',  'Professional Education', 5)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "SchoolDataSource" ("id", "key", "name", "url", "description", "createdAt") VALUES
  (gen_random_uuid()::text, 'NESA', 'National Examination and School Inspection Authority (NESA)',
   'https://ireme.nesa.gov.rw', 'Accredited-schools exports of the Rwanda school directory.', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

COMMIT;
