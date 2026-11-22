-- Levels-2026 release post-check (AFTER `prisma migrate deploy` of administrator-managed divisions and Olympiad levels,
-- owner 2026-11-21/22): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release levels-2026  (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/levels-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with levels-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the divisions migration applied; nothing failed or rolled back; nothing after 20261224000000'
SELECT count(*) FILTER (WHERE migration_name = '20261224000000_divisions_levels'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS divisions_applied,
       count(*) FILTER (WHERE migration_name > '20261224000000_divisions_levels')               AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be: JUNIOR S1,S2,S3 order 1; MIDDLE (no grade) order 2; SENIOR S4,S5,S6 order 3 — all active; the student counts equal pre-check section 3, MIDDLE 0'
SELECT d."code", array_to_string(d."suggestedGrades", ',') AS grades, d."sortOrder", d."isActive", count(u."id") AS students
  FROM "Division" d LEFT JOIN "User" u ON u."divisionId" = d."id" AND u."role" = 'STUDENT'
 GROUP BY d."id" ORDER BY d."sortOrder";

\echo '== 3. MUST be 5, 1, 0, 4, 3, 2: DivisionChange, CourseDivision, TableLayout, CustomReport, CustomReportGrant; DivisionChangeSource; DivisionCode and TestDivision gone; 4 functions; 3 triggers; 2 CHECKs'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
           AND table_name IN ('DivisionChange', 'CourseDivision', 'TableLayout', 'CustomReport', 'CustomReportGrant'))      AS new_tables,
       (SELECT count(*) FROM pg_type WHERE typname = 'DivisionChangeSource')                                                    AS source_enums,
       (SELECT count(*) FROM pg_type WHERE typname IN ('DivisionCode', 'TestDivision'))                                       AS old_enums,
       (SELECT count(*) FROM pg_proc WHERE proname IN ('division_for_grade', 'student_division_from_grade', 'student_division_history', 'course_offered_in_divisions')) AS functions,
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
           AND tgname IN ('student_division_from_grade', 'student_division_history', 'course_offered_in_divisions'))           AS triggers,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname IN ('DivisionChange_reason_length', 'DivisionChange_manual_reason')) AS checks;

\echo '== 4. compare: tests by level (MUST equal pre-check section 4), and submissions'
SELECT "division" AS division, count(*) AS tests FROM "Test" GROUP BY 1 ORDER BY 1;
SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "TestSubmission") AS submissions;

\echo '== 5. MUST be 0, 0, 0: no submission without its level; nobody set by hand yet; no history yet'
SELECT (SELECT count(*) FROM "TestSubmission" WHERE "level" IS NULL)   AS submissions_without_level,
       (SELECT count(*) FROM "User" WHERE "divisionManual")            AS set_by_hand,
       (SELECT count(*) FROM "DivisionChange")                         AS changes;

\echo '== 6. MUST be 0: every course is offered in every division (CourseDivision), none missing'
SELECT (SELECT count(*) FROM "Course") * (SELECT count(*) FROM "Division") - (SELECT count(*) FROM "CourseDivision" WHERE "isActive") AS offerings_missing;

\echo '== 7. MUST be 0, 0: no saved report or table layout yet'
SELECT (SELECT count(*) FROM "CustomReport") AS reports, (SELECT count(*) FROM "TableLayout") AS layouts;

-- Named for the kit's tests: 'DivisionChange' 'CourseDivision' 'TableLayout' 'CustomReport' 'CustomReportGrant' 'DivisionChangeSource' 'sortOrder' 'suggestedGrades' 'level' 'divisionManual'
-- 'student_division_from_grade' 'student_division_history' 'division_for_grade' 'course_offered_in_divisions'

ROLLBACK;
