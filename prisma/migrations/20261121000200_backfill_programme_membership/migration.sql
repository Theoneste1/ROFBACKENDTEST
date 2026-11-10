-- M3 (Phase 1, P1-07): backfill programme membership (plan §7.3; decisions K3, K4, K5).
--
-- Data only. The whole backfill is ONE PostgreSQL DO statement, which PostgreSQL
-- executes atomically: an error at any point (including the precondition below)
-- rolls back everything it wrote. It does not rely on Prisma adding a transaction.
--   * no STUDENT or MENTOR account          → nothing to do (K3: fresh databases, CI);
--   * otherwise exactly one discipline, code MATHEMATICS, is required — else the
--     migration aborts with an explicit error and writes nothing;
--   * every STUDENT (any status, K4)        → Mathematics;
--   * every MENTOR (any status, K4)         → the disciplines of their MentorAssignment
--     courses, active or ended (K5); a coach with no assignment → Mathematics;
--   * rows are source = 'BACKFILL', addedById = NULL, active;
--   * idempotent: existing (user, discipline) pairs are left untouched;
--   * one AuditLog summary row (counts and the discipline id only, no personal data),
--     written only when rows were added.
-- Membership grants no access (student access stays division-based, coach access
-- MentorAssignment-based). Existing ids and rows are not modified.
-- Rollback: docs/migrations/20261121000200_backfill_programme_membership.rollback.sql
DO $$
DECLARE
  candidates  int;
  disciplines int;
  maths       text;
  n           int;
  students    int := 0;
  coaches     int := 0;
BEGIN
  SELECT count(*) INTO candidates FROM "User" WHERE "role" IN ('STUDENT', 'MENTOR');
  IF candidates = 0 THEN
    RAISE NOTICE 'Programme membership backfill: no students or coaches, nothing to do.';
    RETURN;
  END IF;

  SELECT count(*) INTO disciplines FROM "Discipline";
  SELECT "id" INTO maths FROM "Discipline" WHERE "code" = 'MATHEMATICS';
  IF disciplines <> 1 OR maths IS NULL THEN
    RAISE EXCEPTION 'Programme membership backfill aborted: expected exactly one discipline (MATHEMATICS), found % discipline(s)%.',
      disciplines, CASE WHEN maths IS NULL THEN ' and no MATHEMATICS' ELSE '' END;
  END IF;

  -- Students → Mathematics.
  INSERT INTO "ProgrammeMembership" ("id", "userId", "disciplineId", "source", "isActive", "createdAt")
  SELECT gen_random_uuid()::text, u."id", maths, 'BACKFILL', true, CURRENT_TIMESTAMP
    FROM "User" u
   WHERE u."role" = 'STUDENT'
  ON CONFLICT ("userId", "disciplineId") DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; students := students + n;

  -- Coaches → the disciplines of their assigned courses (active or ended).
  INSERT INTO "ProgrammeMembership" ("id", "userId", "disciplineId", "source", "isActive", "createdAt")
  SELECT gen_random_uuid()::text, x."mentorId", x."disciplineId", 'BACKFILL', true, CURRENT_TIMESTAMP
    FROM (SELECT DISTINCT ma."mentorId", c."disciplineId"
            FROM "MentorAssignment" ma
            JOIN "Course" c ON c."id" = ma."courseId"
            JOIN "User"   u ON u."id" = ma."mentorId" AND u."role" = 'MENTOR') x
  ON CONFLICT ("userId", "disciplineId") DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; coaches := coaches + n;

  -- … or Mathematics when they have never been assigned.
  INSERT INTO "ProgrammeMembership" ("id", "userId", "disciplineId", "source", "isActive", "createdAt")
  SELECT gen_random_uuid()::text, u."id", maths, 'BACKFILL', true, CURRENT_TIMESTAMP
    FROM "User" u
   WHERE u."role" = 'MENTOR'
     AND NOT EXISTS (SELECT 1 FROM "MentorAssignment" ma WHERE ma."mentorId" = u."id")
  ON CONFLICT ("userId", "disciplineId") DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; coaches := coaches + n;

  IF students + coaches > 0 THEN
    INSERT INTO "AuditLog" ("id", "action", "entity", "metadata", "createdAt")
    VALUES (gen_random_uuid()::text, 'PROGRAMME_MEMBERSHIP_BACKFILL', 'ProgrammeMembership',
            jsonb_build_object('studentMemberships', students, 'coachMemberships', coaches, 'disciplineId', maths),
            CURRENT_TIMESTAMP);
  END IF;
END $$;
