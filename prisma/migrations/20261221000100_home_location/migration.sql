-- Home location on every registration form (owner, 2026-11-20; capability homeLocationRules). Additive: the home
-- country is required on new applications and the home province, district and sector only for Rwanda, so
--   - TeacherApplication: a new nullable homeProvince; homeDistrict and homeSector become nullable (international
--     applicants give none). Existing applications keep their values;
--   - MentorRequest (coach applications): new nullable homeProvince, homeDistrict and homeSector.
-- No row is changed. Rollback: docs/migrations/20261221000100_home_location.rollback.sql.

-- AlterTable
ALTER TABLE "TeacherApplication" ADD COLUMN "homeProvince" TEXT,
ALTER COLUMN "homeDistrict" DROP NOT NULL,
ALTER COLUMN "homeSector" DROP NOT NULL;

-- AlterTable
ALTER TABLE "MentorRequest" ADD COLUMN "homeDistrict" TEXT,
ADD COLUMN "homeProvince" TEXT,
ADD COLUMN "homeSector" TEXT;
