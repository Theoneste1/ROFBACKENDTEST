-- Levels-2026 release pre-check (BEFORE `prisma migrate deploy` of administrator-managed divisions and Olympiad levels,
-- owner 2026-11-21/22): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release levels-2026   (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/levels-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with levels-2026-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 14, 11, 7, 3, 2, 0, 0: Phase 1, post-Phase-1, the design areas, late-2026 and dec-2026 applied; not the divisions one; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)  AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000' AND migration_name < '20261211000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261211000000' AND migration_name < '20261221000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS areas_applied,
       count(*) FILTER (WHERE migration_name >= '20261221000000' AND migration_name < '20261223000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS late_applied,
       count(*) FILTER (WHERE migration_name >= '20261223000000' AND migration_name < '20261224000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS dec_applied,
       count(*) FILTER (WHERE migration_name >= '20261224000000')                                                       AS divisions_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                        AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0, 0: nothing made by the divisions migration exists yet (DivisionChange, suggestedGrades, division_for_grade)'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'DivisionChange')    AS change_tables,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Division'
           AND column_name = 'suggestedGrades')                                                                             AS suggested_columns,
       (SELECT count(*) FROM pg_proc WHERE proname = 'division_for_grade')                                                AS functions;

\echo '== 3. compare: the divisions (MUST be JUNIOR and SENIOR) and the students in each'
SELECT d."code"::text AS code, count(u."id") AS students
  FROM "Division" d LEFT JOIN "User" u ON u."divisionId" = d."id" AND u."role" = 'STUDENT'
 GROUP BY d."code" ORDER BY 1;

\echo '== 4. compare: tests by level, and test submissions (MUST be unchanged after the migration)'
SELECT "division"::text AS division, count(*) AS tests FROM "Test" GROUP BY 1 ORDER BY 1;
SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "TestSubmission") AS submissions;

-- Named for the kit's tests: 'DivisionChange' 'DivisionChangeSource' 'sortOrder' 'suggestedGrades' 'level' 'divisionManual'
-- 'student_division_from_grade' 'student_division_history' 'division_for_grade'

ROLLBACK;
