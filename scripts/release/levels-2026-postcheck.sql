-- Levels-2026 release post-check (AFTER `prisma migrate deploy` of the Olympiad levels, owner 2026-11-21): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release levels-2026  (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/levels-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with levels-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the levels migration applied; nothing failed or rolled back; nothing after 20261224000000'
SELECT count(*) FILTER (WHERE migration_name = '20261224000000_olympiad_levels'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS levels_applied,
       count(*) FILTER (WHERE migration_name > '20261224000000_olympiad_levels')                AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 2, 3, 1: the OlympiadLevelChange table; 2 enums; the 3 level columns; MIDDLE in TestDivision'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'OlympiadLevelChange')   AS level_tables,
       (SELECT count(*) FROM pg_type WHERE typname IN ('OlympiadLevel', 'OlympiadLevelChangeSource'))                           AS level_enums,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
           AND ((table_name = 'User' AND column_name IN ('olympiadLevel', 'olympiadLevelManual'))
             OR (table_name = 'TestSubmission' AND column_name = 'level')))                                                     AS level_columns,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'TestDivision' AND e.enumlabel = 'MIDDLE')                                                          AS middle_tests;

\echo '== 3. MUST be 3, 2, 2: functions olympiad_level_of_grade, olympiad_level_from_grade, olympiad_level_history; their 2 triggers; 2 CHECKs'
SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('olympiad_level_of_grade', 'olympiad_level_from_grade', 'olympiad_level_history')) AS level_functions,
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('olympiad_level_from_grade', 'olympiad_level_history'))       AS level_triggers,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'c'
           AND conname IN ('OlympiadLevelChange_reason_length', 'OlympiadLevelChange_manual_reason'))                                       AS level_checks;

\echo '== 4. junior and senior MUST equal pre-check section 3 (junior_grades, senior_grades); middle and set_by_hand MUST be 0'
SELECT count(*) FILTER (WHERE "olympiadLevel" = 'JUNIOR') AS junior,
       count(*) FILTER (WHERE "olympiadLevel" = 'SENIOR') AS senior,
       count(*) FILTER (WHERE "olympiadLevel" = 'MIDDLE') AS middle,
       count(*) FILTER (WHERE "olympiadLevelManual")      AS set_by_hand
  FROM "User" WHERE "role" = 'STUDENT';

\echo '== 5. MUST be 0, 0: no student with a grade lacks a level; no submission lacks one whose student has a level'
SELECT (SELECT count(*) FROM "User" WHERE "role" = 'STUDENT' AND "gradeLevel" IS NOT NULL AND "olympiadLevel" IS NULL)   AS students_without_level,
       (SELECT count(*) FROM "TestSubmission" s JOIN "User" u ON u."id" = s."studentId"
          WHERE s."level" IS NULL AND u."olympiadLevel" IS NOT NULL)                                                      AS submissions_without_level;

\echo '== 6. compare: BACKFILL history rows (MUST equal junior + senior of section 4)'
SELECT count(*) AS backfill_rows FROM "OlympiadLevelChange" WHERE "source" = 'BACKFILL';

\echo '== 7. compare: accounts, tests and test submissions (MUST equal pre-check section 4)'
SELECT (SELECT count(*) FROM "User")           AS users,
       (SELECT count(*) FROM "Test")           AS tests,
       (SELECT count(*) FROM "TestSubmission") AS submissions;

-- Named for the kit's tests: 'OlympiadLevelChange' 'OlympiadLevel' 'OlympiadLevelChangeSource' 'olympiadLevel'
-- 'olympiadLevelManual' 'level' 'olympiad_level_of_grade' 'olympiad_level_from_grade' 'olympiad_level_history'

ROLLBACK;
