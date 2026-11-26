-- Question-marking-2027 release pre-check (BEFORE `prisma migrate deploy` of 20270101000000_question_marking_kind and
-- 20270101000100_question_marking; design Rev 5.2, approved 2026-11-26): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release question-marking-2027   (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/question-marking-2027-precheck.sql   (production, in the window)
--
-- Nothing is written. Lines marked "MUST" have to hold; "compare" lines are compared with the post-check right after.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the banking migration applied; nothing from 20270101000000 on; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name = '20261231000000_user_bank_details' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS banking_applied,
       count(*) FILTER (WHERE migration_name >= '20270101000000')                                AS question_marking_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                  AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0: none of the question-marking tables exists yet; COMPOSED is not a marking kind yet'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (
          'TestQuestionMarker', 'TestQuestionTask', 'TestTaskClaim', 'TestQuestionAssessment', 'TestAssessmentVersion',
          'TestMarkDraftChange', 'TestQuestionDecision', 'TestTaskEvent', 'TestPaperAccess', 'TestStaffPaperAccess',
          'TestQuestionPromptHistory'))                                                            AS question_marking_tables,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'TestMarkingKind' AND e.enumlabel = 'COMPOSED') AS composed_kind;

\echo '== 3. compare: markings by kind and status (paper-level marking must be unchanged by the release)'
SELECT "kind"::text AS kind, "status"::text AS status, count(*) AS markings FROM "TestMarking" GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== 4. compare: papers by status, publications, tests, questions'
SELECT "status"::text AS status, count(*) AS papers FROM "TestSubmission" GROUP BY 1 ORDER BY 1;
SELECT (SELECT count(*) FROM "TestPublication") AS publications, (SELECT count(*) FROM "Test") AS tests, (SELECT count(*) FROM "TestQuestion") AS questions;

\echo '== 5. compare: the TestMarking kind CHECK as it stands'
SELECT pg_get_constraintdef(oid) AS assignment_matches_kind FROM pg_constraint WHERE conname = 'TestMarking_assignment_matches_kind';

ROLLBACK;
