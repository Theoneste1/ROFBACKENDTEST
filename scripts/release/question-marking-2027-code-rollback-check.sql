-- Question-marking-2027, rollback LEVEL 2 guard (design Rev 5.2 §10): may the PREVIOUS application release be deployed
-- while the question-marking schema stays? READ ONLY.
--
--   node scripts/release/rehearsal.mjs code-rollback-check --release question-marking-2027
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/question-marking-2027-code-rollback-check.sql
--
-- The previous release knows nothing of QUESTION mode: it would show such a test's papers as paper-level work. So level 2 is
-- safe only while no QUESTION-mode test has tasks, and no paper carries a COMPOSED final marking. Otherwise use level 1
-- (QUESTION_MARKING_ENABLED=false keeps the new code and hides the routes and screens) — or roll forward.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 0, 0: no QUESTION-mode test has tasks; no COMPOSED final marking exists'
SELECT (SELECT count(DISTINCT t."id") FROM "Test" t JOIN "TestSubmission" s ON s."testId" = t."id" JOIN "TestQuestionTask" k ON k."submissionId" = s."id"
         WHERE t."markingMode" = 'QUESTION')                                                    AS question_tests_with_tasks,
       (SELECT count(*) FROM "TestMarking" WHERE "kind" = 'COMPOSED')                             AS composed_markings;

\echo '== 2. information: QUESTION-mode tests (without tasks, the previous release treats them as ordinary PAPER tests)'
SELECT count(*) AS question_mode_tests FROM "Test" WHERE "markingMode" = 'QUESTION';

ROLLBACK;
