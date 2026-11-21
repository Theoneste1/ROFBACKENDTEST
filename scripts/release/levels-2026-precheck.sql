-- Levels-2026 release pre-check (BEFORE `prisma migrate deploy` of the Olympiad levels, owner 2026-11-21): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release levels-2026   (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/levels-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with levels-2026-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 14, 11, 7, 3, 2, 0, 0: Phase 1, post-Phase-1, the design areas, late-2026 and dec-2026 applied; not the levels one; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)  AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000' AND migration_name < '20261211000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261211000000' AND migration_name < '20261221000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS areas_applied,
       count(*) FILTER (WHERE migration_name >= '20261221000000' AND migration_name < '20261223000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS late_applied,
       count(*) FILTER (WHERE migration_name >= '20261223000000' AND migration_name < '20261224000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS dec_applied,
       count(*) FILTER (WHERE migration_name >= '20261224000000')                                                       AS levels_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                        AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0, 0, 0: nothing made by the levels migration exists yet (OlympiadLevelChange, OlympiadLevel, olympiadLevel, olympiad_level_from_grade)'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'OlympiadLevelChange') AS level_tables,
       (SELECT count(*) FROM pg_type WHERE typname = 'OlympiadLevel')                                                          AS level_enums,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User'
           AND column_name = 'olympiadLevel')                                                                                    AS level_columns,
       (SELECT count(*) FROM pg_proc WHERE proname = 'olympiad_level_from_grade')                                              AS level_functions;

\echo '== 3. compare: students by course division (S1-S3, S4-S6, no grade); the backfill gives them JUNIOR, SENIOR, none'
SELECT count(*) FILTER (WHERE "gradeLevel" IN ('S1', 'S2', 'S3')) AS junior_grades,
       count(*) FILTER (WHERE "gradeLevel" IN ('S4', 'S5', 'S6')) AS senior_grades,
       count(*) FILTER (WHERE "gradeLevel" IS NULL)               AS no_grade
  FROM "User" WHERE "role" = 'STUDENT';

\echo '== 4. compare: accounts, tests and test submissions (MUST be unchanged after the migration: additive only)'
SELECT (SELECT count(*) FROM "User")           AS users,
       (SELECT count(*) FROM "Test")           AS tests,
       (SELECT count(*) FROM "TestSubmission") AS submissions;

-- Named for the kit's tests: 'OlympiadLevelChange' 'OlympiadLevel' 'OlympiadLevelChangeSource' 'olympiadLevel'
-- 'olympiadLevelManual' 'level' 'olympiad_level_of_grade' 'olympiad_level_from_grade' 'olympiad_level_history'

ROLLBACK;
