-- Olympiad levels (owner 2026-11-21): a student's Olympiad level — JUNIOR, MIDDLE or SENIOR — separate from the school
-- grade; tests may be for MIDDLE students; every change is kept (OlympiadLevelChange). Additive: nothing is dropped,
-- no existing value changes meaning.
--
-- Backfill: every existing student keeps exactly the test level they have today (S1–S3 → JUNIOR, S4–S6 → SENIOR, their
-- former test division), recorded as a BACKFILL change — so no open test changes who may answer it. From now on the
-- grade SUGGESTS the level (S1–S2 Junior, S3–S4 Middle, S5–S6 Senior: trigger olympiad_level_from_grade) when a student
-- is created or their grade changes, unless a Coach or a User Manager set the level by hand. Existing submissions get
-- the level their student has now (TestSubmission.level: the ranking group, frozen from then on).

-- CreateEnum
CREATE TYPE "OlympiadLevel" AS ENUM ('JUNIOR', 'MIDDLE', 'SENIOR');

-- CreateEnum
CREATE TYPE "OlympiadLevelChangeSource" AS ENUM ('GRADE', 'MANUAL', 'AUTOMATIC', 'BACKFILL');

-- AlterEnum
ALTER TYPE "TestDivision" ADD VALUE IF NOT EXISTS 'MIDDLE';

-- AlterTable
ALTER TABLE "TestSubmission" ADD COLUMN     "level" "OlympiadLevel";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "olympiadLevel" "OlympiadLevel",
ADD COLUMN     "olympiadLevelManual" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OlympiadLevelChange" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fromLevel" "OlympiadLevel",
    "toLevel" "OlympiadLevel",
    "gradeLevel" "GradeLevel",
    "source" "OlympiadLevelChangeSource" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OlympiadLevelChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OlympiadLevelChange_studentId_createdAt_idx" ON "OlympiadLevelChange"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "OlympiadLevelChange_changedById_idx" ON "OlympiadLevelChange"("changedById");

-- AddForeignKey
ALTER TABLE "OlympiadLevelChange" ADD CONSTRAINT "OlympiadLevelChange_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OlympiadLevelChange" ADD CONSTRAINT "OlympiadLevelChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A reason, when there is one, is 3–500 characters; a MANUAL or AUTOMATIC change always has one, and its author.
ALTER TABLE "OlympiadLevelChange" ADD CONSTRAINT "OlympiadLevelChange_reason_length"
  CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 3 AND 500);
ALTER TABLE "OlympiadLevelChange" ADD CONSTRAINT "OlympiadLevelChange_manual_reason"
  CHECK ("source" NOT IN ('MANUAL', 'AUTOMATIC') OR "reason" IS NOT NULL);

-- Backfill: today's test level of every student with a grade.
UPDATE "User"
   SET "olympiadLevel" = CASE WHEN "gradeLevel" IN ('S1', 'S2', 'S3') THEN 'JUNIOR'::"OlympiadLevel"
                              WHEN "gradeLevel" IN ('S4', 'S5', 'S6') THEN 'SENIOR'::"OlympiadLevel" END
 WHERE "role" = 'STUDENT' AND "gradeLevel" IS NOT NULL;

INSERT INTO "OlympiadLevelChange" ("id", "studentId", "fromLevel", "toLevel", "gradeLevel", "source", "createdAt")
SELECT gen_random_uuid()::text, u."id", NULL, u."olympiadLevel", u."gradeLevel", 'BACKFILL', (clock_timestamp() AT TIME ZONE 'UTC')
  FROM "User" u
 WHERE u."role" = 'STUDENT' AND u."olympiadLevel" IS NOT NULL;

-- Existing submissions: the ranking group is the student's level now (their former division).
UPDATE "TestSubmission" s
   SET "level" = u."olympiadLevel"
  FROM "User" u
 WHERE u."id" = s."studentId" AND s."level" IS NULL;

-- The level a grade suggests (one place, used by the trigger and the application's tests).
CREATE OR REPLACE FUNCTION olympiad_level_of_grade(grade text) RETURNS "OlympiadLevel" AS $$
  SELECT CASE WHEN grade IN ('S1', 'S2') THEN 'JUNIOR'::"OlympiadLevel"
              WHEN grade IN ('S3', 'S4') THEN 'MIDDLE'::"OlympiadLevel"
              WHEN grade IN ('S5', 'S6') THEN 'SENIOR'::"OlympiadLevel" END
$$ LANGUAGE sql IMMUTABLE;

-- Before a student is created, or their grade or role changes: the suggested level, unless set by hand. A grade
-- removed keeps the level it had. Every write path (sign-up, an Administrator, bulk, a new academic year) is covered.
CREATE OR REPLACE FUNCTION olympiad_level_from_grade() RETURNS trigger AS $$
DECLARE
  suggested "OlympiadLevel";
BEGIN
  IF NEW."role" <> 'STUDENT' OR NEW."olympiadLevelManual" THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."gradeLevel" IS NOT DISTINCT FROM OLD."gradeLevel" AND NEW."role" = OLD."role" THEN
    RETURN NEW;
  END IF;
  suggested := olympiad_level_of_grade(NEW."gradeLevel"::text);
  IF suggested IS NOT NULL THEN
    NEW."olympiadLevel" := suggested;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER olympiad_level_from_grade
  BEFORE INSERT OR UPDATE OF "gradeLevel", "role" ON "User"
  FOR EACH ROW EXECUTE FUNCTION olympiad_level_from_grade();

-- After it: the history row of a level that followed the grade (the application writes MANUAL / AUTOMATIC itself).
CREATE OR REPLACE FUNCTION olympiad_level_history() RETURNS trigger AS $$
BEGIN
  IF NEW."role" = 'STUDENT' AND NEW."olympiadLevel" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."olympiadLevel" IS DISTINCT FROM OLD."olympiadLevel") THEN
    INSERT INTO "OlympiadLevelChange" ("id", "studentId", "fromLevel", "toLevel", "gradeLevel", "source", "createdAt")
    VALUES (gen_random_uuid()::text, NEW."id", CASE WHEN TG_OP = 'UPDATE' THEN OLD."olympiadLevel" END, NEW."olympiadLevel",
            NEW."gradeLevel", 'GRADE', (clock_timestamp() AT TIME ZONE 'UTC'));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER olympiad_level_history
  AFTER INSERT OR UPDATE OF "gradeLevel", "role" ON "User"
  FOR EACH ROW EXECUTE FUNCTION olympiad_level_history();

-- Tests' student lists filter on the level.
CREATE INDEX "User_role_olympiadLevel_idx" ON "User"("role", "olympiadLevel");

-- The Users list (and so a bulk selection) filters on the level: the bulk membership guard covers it too — the same
-- function, the trigger re-created with "olympiadLevel" added to its UPDATE OF list (src/users/bulk/bulk-rules.ts
-- MEMBERSHIP_COLUMNS).
DROP TRIGGER user_bulk_membership_guard ON "User";
CREATE TRIGGER user_bulk_membership_guard
  BEFORE INSERT OR DELETE
      OR UPDATE OF "role", "divisionId", "gradeLevel", "schoolId", "isApproved", "isActive", "accountStatus",
                   "activatedAt", "firstName", "lastName", "username", "email", "olympiadLevel"
  ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_bulk_membership_guard();
