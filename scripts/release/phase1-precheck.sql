-- Phase 1 release pre-flight (M1–M14): READ ONLY. Safe to run against production.
--
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/phase1-precheck.sql
--
-- Use the DIRECT (non-pooled) Neon connection string. Nothing is written: the whole script runs
-- in a READ ONLY transaction (any write would fail). Run it:
--   1. on the Neon rehearsal branch before rehearsing (expected values below), and
--   2. on production at the start of the release window, AFTER the freeze, right before
--      `prisma migrate deploy` (docs/operations/RELEASE-PHASE1-RUNBOOK.md).
-- Every line marked "MUST" has to hold; otherwise stop — a migration would abort or the release
-- would change data the owner has not reviewed.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. Migration history (MUST: no failed or rolled-back row; latest is the main baseline, none of 2026112100* applied)'
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
  FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;
SELECT count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed_or_running,
       count(*) FILTER (WHERE migration_name LIKE '2026112100%')             AS phase1_already_applied
  FROM "_prisma_migrations";

\echo '== 2. M3 (programme membership backfill) — MUST: exactly 1 discipline, code MATHEMATICS (when any student or coach exists)'
SELECT count(*) AS disciplines,
       count(*) FILTER (WHERE "code" = 'MATHEMATICS') AS mathematics,
       (SELECT count(*) FROM "User" WHERE "role" IN ('STUDENT', 'MENTOR')) AS students_and_coaches
  FROM "Discipline";

\echo '== 3. M7/M8 (school codes, official list) — information: what M8 will adopt or insert into'
SELECT count(*) AS schools,
       count(*) FILTER (WHERE "name" <> btrim(regexp_replace("name", '\s+', ' ', 'g'))) AS names_with_extra_spaces
  FROM "School";

\echo '== 4. M9 (claims backfill) — information: PENDING claims M9 will create'
SELECT count(*) FILTER (WHERE "schoolId" IS NOT NULL) AS students_with_school,
       count(*) FILTER (WHERE "schoolId" IS NULL)     AS students_without_school,
       count(*)                                       AS students
  FROM "User" WHERE "role" = 'STUDENT';
SELECT count(DISTINCT u."id") AS name_only_claims_from_register_audit
  FROM "User" u JOIN "AuditLog" l ON l."entityId" = u."id" AND l."action" = 'REGISTER'
 WHERE u."role" = 'STUDENT' AND u."schoolId" IS NULL
   AND coalesce(btrim(l."metadata"->>'schoolNameEntered'), '') <> '';

\echo '== 5. M10 (claim integrity) — MUST be 0: current-year ACTIVE enrolments whose school differs from User.schoolId'
\echo '   (a later academic-year rollover would be refused for these students — docs/migrations/README.md)'
SELECT count(*) AS diverged
  FROM "StudentEnrollment" e
  JOIN "AcademicYear" y ON y."id" = e."academicYearId" AND y."isCurrent"
  JOIN "User" u ON u."id" = e."studentId"
 WHERE e."status" = 'ACTIVE' AND e."schoolId" IS DISTINCT FROM u."schoolId";

\echo '== 6. Roles (MUST: only STUDENT, MENTOR, ADMIN before Phase 1)'
SELECT "role", count(*) FROM "User" GROUP BY "role" ORDER BY "role";

\echo '== 7. Academic years — information: exactly one current year; PLANNED years (a start is not offered until the safe backend is live)'
SELECT "name", "status", "isCurrent" FROM "AcademicYear" ORDER BY "startsOn";

\echo '== 8. Size — information (locks taken by M7/M11/M12 on School and by M4/M10 triggers on User are brief at this size)'
SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables
 WHERE relname IN ('User', 'School', 'StudentEnrollment', 'AuditLog', 'Submission', 'Assignment') ORDER BY relname;

ROLLBACK;
