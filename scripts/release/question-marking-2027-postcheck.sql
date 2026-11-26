-- Question-marking-2027 release post-check (AFTER `prisma migrate deploy` of its two migrations; design Rev 5.2):
-- READ ONLY. Compare section 3 with question-marking-2027-precheck.sql.
--
--   node scripts/release/rehearsal.mjs postcheck --release question-marking-2027
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/question-marking-2027-postcheck.sql

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 2, 0, 0: both migrations applied; nothing after them; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name IN ('20270101000000_question_marking_kind', '20270101000100_question_marking')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS question_marking_applied,
       count(*) FILTER (WHERE migration_name > '20270101000100_question_marking')               AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 11, 0, 1, 0, 0: the eleven tables exist and are empty; COMPOSED exists and is unused; every test is PAPER'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (
          'TestQuestionMarker', 'TestQuestionTask', 'TestTaskClaim', 'TestQuestionAssessment', 'TestAssessmentVersion',
          'TestMarkDraftChange', 'TestQuestionDecision', 'TestTaskEvent', 'TestPaperAccess', 'TestStaffPaperAccess',
          'TestQuestionPromptHistory'))                                                            AS question_marking_tables,
       (SELECT count(*) FROM "TestQuestionTask") + (SELECT count(*) FROM "TestQuestionMarker") + (SELECT count(*) FROM "TestTaskClaim")
         + (SELECT count(*) FROM "TestQuestionAssessment") + (SELECT count(*) FROM "TestQuestionDecision") + (SELECT count(*) FROM "TestTaskEvent") AS question_marking_rows,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'TestMarkingKind' AND e.enumlabel = 'COMPOSED') AS composed_kind,
       (SELECT count(*) FROM "TestMarking" WHERE "kind" = 'COMPOSED')                              AS composed_markings,
       (SELECT count(*) FROM "Test" WHERE "markingMode" <> 'PAPER')                                AS question_mode_tests;

\echo '== 3. compare: markings by kind and status; papers by status; publications, tests, questions (equal to the pre-check)'
SELECT "kind"::text AS kind, "status"::text AS status, count(*) AS markings FROM "TestMarking" GROUP BY 1, 2 ORDER BY 1, 2;
SELECT "status"::text AS status, count(*) AS papers FROM "TestSubmission" GROUP BY 1 ORDER BY 1;
SELECT (SELECT count(*) FROM "TestPublication") AS publications, (SELECT count(*) FROM "Test") AS tests, (SELECT count(*) FROM "TestQuestion") AS questions;

\echo '== 4. MUST be 19 and 4: the guards, the commit-time invariants and the functions are present; the CHECK accepts COMPOSED'
SELECT count(*) AS question_marking_triggers FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
  'test_marking_mode_guard', 'test_question_structure_guard', 'test_max_marks_guard', 'test_guide_guard', 'test_question_marker_guard',
  'test_question_task_guard', 'test_task_claim_guard', 'test_question_assessment_guard', 'test_assessment_version_append_only',
  'test_mark_draft_change_append_only', 'test_task_event_append_only', 'test_question_prompt_history_append_only', 'test_paper_access_guard',
  'test_staff_paper_access_guard', 'test_question_decision_guard', 'question_decision_invariant_task', 'question_decision_invariant_decision',
  'question_paper_invariant_submission', 'question_paper_invariant_task');
SELECT count(*) AS question_marking_functions FROM pg_proc WHERE proname IN ('can_mark_subject', 'question_paper_status_of', 'question_paper_status', 'question_marking_started');
SELECT pg_get_constraintdef(oid) AS assignment_matches_kind FROM pg_constraint WHERE conname = 'TestMarking_assignment_matches_kind';

\echo '== 5. MUST be 0: no QUESTION-mode paper differs from its projection (reconciliation)'
SELECT count(*) AS projection_mismatches FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId"
 WHERE t."markingMode" = 'QUESTION' AND s."status"::text <> question_paper_status(s."id")
   AND NOT (s."status" = 'PUBLISHED' AND question_paper_status(s."id") = 'APPROVED');

ROLLBACK;
