-- Phase 1 release post-check (after `prisma migrate deploy` of M1–M14): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck        (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/phase1-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to
-- hold; "compare" lines are compared with phase1-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST: 14 Phase 1 migrations applied, none failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS phase1_applied,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                    AS failed_or_rolled_back,
       count(*)                                                                                                     AS total_rows
  FROM "_prisma_migrations";

\echo '== 2. The counts each backfill recorded (system audit rows, no actor) — compare with the pre-check'
SELECT "action", "metadata"::text FROM "AuditLog"
 WHERE "actorId" IS NULL
   AND "action" IN ('PROGRAMME_MEMBERSHIP_BACKFILL', 'OFFICIAL_SCHOOL_LIST_LOADED', 'SCHOOL_AFFILIATION_BACKFILL', 'SCHOOL_SOURCE_BACKFILL')
 ORDER BY "createdAt";

\echo '== 3. Users — MUST equal the pre-check (same roles, same counts; nobody gains a Phase 1 role)'
SELECT "role", count(*) FROM "User" GROUP BY "role" ORDER BY "role";

\echo '== 4. M3 — MUST: one active BACKFILL membership per student and coach (count = students_and_coaches of the pre-check)'
SELECT "source", "isActive", count(*) FROM "ProgrammeMembership" GROUP BY "source", "isActive" ORDER BY 1, 2;

\echo '== 5. M8/M11 — MUST: 1974 coded OFFICIAL_LIST schools; LEGACY = uncoded schools left from before'
SELECT "source", count(*) AS schools, count(*) FILTER (WHERE "code" IS NOT NULL) AS coded FROM "School" GROUP BY "source" ORDER BY "source";

\echo '== 6. M7/M12 — MUST: School_code_key present, School_name_key absent'
SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'School' AND indexname IN ('School_name_key', 'School_code_key') ORDER BY indexname;

\echo '== 7. M9 — MUST: every claim PENDING and from MIGRATION; no VERIFIED claim; students_with_school_but_no_claim = 0'
SELECT "status", "source", count(*) AS claims, count(*) FILTER (WHERE "schoolId" IS NULL) AS name_only
  FROM "StudentSchoolAffiliation" GROUP BY "status", "source" ORDER BY 1, 2;
SELECT count(*) AS students_with_school_but_no_claim
  FROM "User" u
 WHERE u."role" = 'STUDENT' AND u."schoolId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "StudentSchoolAffiliation" a WHERE a."studentId" = u."id" AND a."supersededAt" IS NULL AND a."schoolId" = u."schoolId");

\echo '== 8. M10 invariants — MUST both be 0'
SELECT (SELECT count(*) FROM (SELECT "studentId" FROM "StudentSchoolAffiliation" WHERE "supersededAt" IS NULL
                               GROUP BY "studentId" HAVING count(*) > 1) s)                                   AS several_current_claims,
       (SELECT count(*) FROM "StudentSchoolAffiliation" a JOIN "User" u ON u."id" = a."studentId"
         WHERE a."supersededAt" IS NULL AND a."schoolId" IS NOT NULL AND a."schoolId" IS DISTINCT FROM u."schoolId") AS claim_school_mismatch;

\echo '== 9. MUST: triggers present and enabled (O = enabled)'
SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled AS enabled
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
 ORDER BY 1, 2;

\echo '== 10. Directory and sync tables — MUST be empty right after the migration (nothing was created yet)'
SELECT (SELECT count(*) FROM "SchoolSyncRun") AS sync_runs,
       (SELECT count(*) FROM "TeacherSchoolAssignment") AS teacher_assignments,
       (SELECT count(*) FROM "UserPermissionOverride") AS permission_overrides;

ROLLBACK;
