-- Administrator-managed divisions and Olympiad levels (owner 2026-11-21/22). Additive and value-preserving: no row is
-- deleted and no existing value changes meaning.
--
--  - Division.code becomes text (JUNIOR and SENIOR keep their rows and codes; Administrators add more, e.g. MIDDLE);
--    each division gets the grades it is suggested for (suggestedGrades) and a display order.
--  - A student's division IS their Olympiad level. It follows the grade (the active division whose suggestedGrades
--    hold it: trigger student_division_from_grade) unless a Coach or a User Manager set it by hand (divisionManual).
--    Every change is kept (DivisionChange).
--  - Test.division becomes text: a division code, or ALL. Each submission keeps the code of its student's division when
--    it was made (TestSubmission.level: the ranking group).
--  - The MIDDLE division is created, active, suggested for NO grade: nothing changes for any student until an
--    Administrator gives Middle some grades, or a Coach or User Manager moves a student there.
-- Rollback: docs/migrations/20261224000000_divisions_levels.rollback.sql

-- CreateEnum
CREATE TYPE "DivisionChangeSource" AS ENUM ('GRADE', 'MANUAL', 'AUTOMATIC', 'SYSTEM');

-- Division: code enum → text, in place (the unique index on it is kept); suggested grades; order.
ALTER TABLE "Division" ALTER COLUMN "code" TYPE TEXT USING "code"::text;
ALTER TABLE "Division" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
                       ADD COLUMN "suggestedGrades" "GradeLevel"[] DEFAULT ARRAY[]::"GradeLevel"[];
DROP TYPE "DivisionCode";
ALTER TABLE "Division" ADD CONSTRAINT "Division_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,29}$' AND "code" <> 'ALL');

UPDATE "Division" SET "suggestedGrades" = ARRAY['S1', 'S2', 'S3']::"GradeLevel"[], "sortOrder" = 1 WHERE "code" = 'JUNIOR';
UPDATE "Division" SET "suggestedGrades" = ARRAY['S4', 'S5', 'S6']::"GradeLevel"[], "sortOrder" = 3 WHERE "code" = 'SENIOR';
INSERT INTO "Division" ("id", "code", "name", "description", "isActive", "suggestedGrades", "sortOrder", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'MIDDLE', 'Middle', 'Olympiad level between Junior and Senior.', true, ARRAY[]::"GradeLevel"[], 2,
        (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
ON CONFLICT ("code") DO NOTHING;

-- Test: division enum → text, in place (JUNIOR / SENIOR / ALL keep their values).
ALTER TABLE "Test" ALTER COLUMN "division" DROP DEFAULT;
ALTER TABLE "Test" ALTER COLUMN "division" TYPE TEXT USING "division"::text;
ALTER TABLE "Test" ALTER COLUMN "division" SET DEFAULT 'ALL';
DROP TYPE "TestDivision";

-- TestSubmission: the code of the student's division when the submission was made (existing ones: their division now).
ALTER TABLE "TestSubmission" ADD COLUMN "level" TEXT;
UPDATE "TestSubmission" s SET "level" = d."code"
  FROM "User" u JOIN "Division" d ON d."id" = u."divisionId"
 WHERE u."id" = s."studentId" AND s."level" IS NULL;

-- User: the division set by hand.
ALTER TABLE "User" ADD COLUMN "divisionManual" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DivisionChange" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fromDivisionId" TEXT,
    "toDivisionId" TEXT NOT NULL,
    "gradeLevel" "GradeLevel",
    "source" "DivisionChangeSource" NOT NULL,
    "reason" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DivisionChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DivisionChange_studentId_createdAt_idx" ON "DivisionChange"("studentId", "createdAt");
CREATE INDEX "DivisionChange_changedById_idx" ON "DivisionChange"("changedById");
CREATE INDEX "DivisionChange_fromDivisionId_idx" ON "DivisionChange"("fromDivisionId");
CREATE INDEX "DivisionChange_toDivisionId_idx" ON "DivisionChange"("toDivisionId");
ALTER TABLE "DivisionChange" ADD CONSTRAINT "DivisionChange_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DivisionChange" ADD CONSTRAINT "DivisionChange_fromDivisionId_fkey" FOREIGN KEY ("fromDivisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DivisionChange" ADD CONSTRAINT "DivisionChange_toDivisionId_fkey" FOREIGN KEY ("toDivisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DivisionChange" ADD CONSTRAINT "DivisionChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A reason, when there is one, is 3–500 characters; a MANUAL or AUTOMATIC change always has one.
ALTER TABLE "DivisionChange" ADD CONSTRAINT "DivisionChange_reason_length" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 3 AND 500);
ALTER TABLE "DivisionChange" ADD CONSTRAINT "DivisionChange_manual_reason" CHECK ("source" NOT IN ('MANUAL', 'AUTOMATIC') OR "reason" IS NOT NULL);

-- The division a grade suggests: the active division whose suggestedGrades hold it (the service keeps exactly one).
CREATE OR REPLACE FUNCTION division_for_grade(grade text) RETURNS text AS $$
  SELECT "id" FROM "Division" WHERE "isActive" AND grade::"GradeLevel" = ANY("suggestedGrades") ORDER BY "sortOrder", "code" LIMIT 1
$$ LANGUAGE sql STABLE;

-- Before a student is created, or their grade or role changes (every write path: sign-up, an Administrator, bulk, a new
-- academic year): the division the grade suggests — unless set by hand, which a grade change never moves (whatever
-- division the writer sent).
CREATE OR REPLACE FUNCTION student_division_from_grade() RETURNS trigger AS $$
DECLARE
  suggested text;
BEGIN
  IF NEW."role" <> 'STUDENT' THEN
    RETURN NEW;
  END IF;
  -- Set by hand: only the classification routes (their transaction marked 'recorded') change it.
  IF NEW."divisionManual" THEN
    IF TG_OP = 'UPDATE' AND coalesce(current_setting('rof.division_change', true), '') <> 'recorded' THEN
      NEW."divisionId" := OLD."divisionId";
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."gradeLevel" IS NOT DISTINCT FROM OLD."gradeLevel" AND NEW."role" = OLD."role" THEN
    RETURN NEW;
  END IF;
  IF NEW."gradeLevel" IS NOT NULL THEN
    suggested := division_for_grade(NEW."gradeLevel"::text);
    IF suggested IS NOT NULL THEN
      NEW."divisionId" := suggested;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_division_from_grade
  BEFORE INSERT OR UPDATE OF "gradeLevel", "role", "divisionId" ON "User"
  FOR EACH ROW EXECUTE FUNCTION student_division_from_grade();

-- After it: the history of a division that changed other than by the classification routes (which write MANUAL /
-- AUTOMATIC themselves and mark their transaction with rof.division_change = 'recorded').
CREATE OR REPLACE FUNCTION student_division_history() RETURNS trigger AS $$
BEGIN
  IF NEW."role" = 'STUDENT' AND NEW."divisionId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."divisionId" IS DISTINCT FROM OLD."divisionId")
     AND coalesce(current_setting('rof.division_change', true), '') <> 'recorded' THEN
    INSERT INTO "DivisionChange" ("id", "studentId", "fromDivisionId", "toDivisionId", "gradeLevel", "source", "createdAt")
    VALUES (gen_random_uuid()::text, NEW."id", CASE WHEN TG_OP = 'UPDATE' THEN OLD."divisionId" END, NEW."divisionId", NEW."gradeLevel",
            CASE WHEN TG_OP = 'INSERT' OR NEW."gradeLevel" IS DISTINCT FROM OLD."gradeLevel" THEN 'GRADE' ELSE 'SYSTEM' END::"DivisionChangeSource",
            (clock_timestamp() AT TIME ZONE 'UTC'));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_division_history
  AFTER INSERT OR UPDATE OF "gradeLevel", "role", "divisionId" ON "User"
  FOR EACH ROW EXECUTE FUNCTION student_division_history();

-- Which courses each division offers. Every existing course is offered in every division (MIDDLE included), so nothing
-- changes for anyone; Administrators then choose per division.
CREATE TABLE "CourseDivision" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseDivision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CourseDivision_divisionId_isActive_idx" ON "CourseDivision"("divisionId", "isActive");
CREATE UNIQUE INDEX "CourseDivision_courseId_divisionId_key" ON "CourseDivision"("courseId", "divisionId");
ALTER TABLE "CourseDivision" ADD CONSTRAINT "CourseDivision_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseDivision" ADD CONSTRAINT "CourseDivision_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "CourseDivision" ("id", "courseId", "divisionId", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", d."id", true, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC')
  FROM "Course" c CROSS JOIN "Division" d
ON CONFLICT ("courseId", "divisionId") DO NOTHING;

-- A new course is offered in every active division (whatever creates it: the API, the seed, a script); Administrators
-- then narrow it per division.
CREATE OR REPLACE FUNCTION course_offered_in_divisions() RETURNS trigger AS $$
BEGIN
  INSERT INTO "CourseDivision" ("id", "courseId", "divisionId", "isActive", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, NEW."id", d."id", true, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC')
    FROM "Division" d WHERE d."isActive"
  ON CONFLICT ("courseId", "divisionId") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER course_offered_in_divisions
  AFTER INSERT ON "Course"
  FOR EACH ROW EXECUTE FUNCTION course_offered_in_divisions();
