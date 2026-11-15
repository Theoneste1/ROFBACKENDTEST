-- M10 (Phase 1, school administration PR A.1): database enforcement of the affiliation
-- invariants (PR #25 review, owner-approved 2026-11-10), independently of the application,
-- so direct SQL is refused too:
--
--   AFFILIATION_ONE_CURRENT      a student has at most ONE current claim (supersededAt NULL);
--   AFFILIATION_SCHOOL_MISMATCH  the current claim's school IS the student's User.schoolId
--                                (both NULL for a claim whose school is not yet resolved).
--
-- Two AFTER ... FOR EACH ROW triggers run one function at the end of every statement that
-- makes a claim current or changes a student's school, so EVERY statement must leave the
-- student consistent. To move a student to another school: end the current claim, change
-- User.schoolId, then create the new claim (SchoolAffiliationService and UsersService do this).
-- The function first locks the student's "User" row (FOR UPDATE, held until the transaction
-- ends), which serialises concurrent transactions for the same student; under READ COMMITTED
-- (the application's isolation level) the checks that follow see every transaction committed
-- before it.
--
-- Checked per statement, not deferred to COMMIT: an error raised at COMMIT terminates the
-- local `prisma dev` (PGlite) server; a statement error is reported like any other.
--
-- Functions and triggers only, like M4: no table, column, index, constraint or row changes,
-- so schema.prisma is unchanged and `prisma migrate diff` (which does not compare functions
-- or triggers) reports no drift.
--
-- Pre-check: refuses to apply (nothing is created) when existing data already violates an
-- invariant, and reports — without failing — students whose current-year enrolment school
-- differs from User.schoolId (an academic-year rollover would copy that school; see
-- docs/migrations/README.md).
-- Explicit transaction: all or nothing.
-- Rollback: docs/migrations/20261121000900_school_affiliation_integrity.rollback.sql

BEGIN;

DO $$
DECLARE
  several  int;
  mismatch int;
  diverged int;
BEGIN
  SELECT count(*) INTO several FROM (
    SELECT "studentId" FROM "StudentSchoolAffiliation" WHERE "supersededAt" IS NULL GROUP BY "studentId" HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO mismatch
    FROM "StudentSchoolAffiliation" a JOIN "User" u ON u."id" = a."studentId"
   WHERE a."supersededAt" IS NULL AND a."schoolId" IS DISTINCT FROM u."schoolId";
  IF several > 0 OR mismatch > 0 THEN
    RAISE EXCEPTION 'AFFILIATION_INTEGRITY: % student(s) with several current claims and % current claim(s) whose school differs from User.schoolId; resolve them before applying M10', several, mismatch
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO diverged
    FROM "StudentEnrollment" e
    JOIN "AcademicYear" y ON y."id" = e."academicYearId" AND y."isCurrent"
    JOIN "User" u ON u."id" = e."studentId"
   WHERE e."status" = 'ACTIVE' AND e."schoolId" IS DISTINCT FROM u."schoolId";
  RAISE NOTICE 'M10 pre-check: 0 violations; % current-year enrolment(s) whose school differs from User.schoolId.', diverged;
END $$;

CREATE OR REPLACE FUNCTION school_affiliation_integrity() RETURNS trigger AS $$
DECLARE
  sid      text;
  claims   int;
  mismatch boolean;
BEGIN
  IF TG_TABLE_NAME = 'User' THEN
    sid := NEW."id";
  ELSE
    sid := NEW."studentId";
  END IF;

  -- Serialise against concurrent transactions for the same student.
  PERFORM 1 FROM "User" WHERE "id" = sid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;   -- the student was deleted in this transaction (their claims cascade)
  END IF;

  SELECT count(*) INTO claims
    FROM "StudentSchoolAffiliation" WHERE "studentId" = sid AND "supersededAt" IS NULL;
  IF claims > 1 THEN
    RAISE EXCEPTION 'AFFILIATION_ONE_CURRENT: student % has % current school claims; at most one is allowed', sid, claims
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "StudentSchoolAffiliation" a JOIN "User" u ON u."id" = a."studentId"
     WHERE a."studentId" = sid AND a."supersededAt" IS NULL AND a."schoolId" IS DISTINCT FROM u."schoolId"
  ) INTO mismatch;
  IF mismatch THEN
    RAISE EXCEPTION 'AFFILIATION_SCHOOL_MISMATCH: the current school claim of student % is not for the student''s school', sid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A claim becomes (or is created as) current, or a current claim's student or school changes.
CREATE TRIGGER school_affiliation_integrity
  AFTER INSERT OR UPDATE OF "studentId", "schoolId", "supersededAt" ON "StudentSchoolAffiliation"
  FOR EACH ROW
  WHEN (NEW."supersededAt" IS NULL)
  EXECUTE FUNCTION school_affiliation_integrity();

-- The student's school changes.
CREATE TRIGGER user_school_affiliation_integrity
  AFTER UPDATE OF "schoolId" ON "User"
  FOR EACH ROW
  WHEN (OLD."schoolId" IS DISTINCT FROM NEW."schoolId")
  EXECUTE FUNCTION school_affiliation_integrity();

COMMIT;
