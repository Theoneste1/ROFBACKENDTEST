-- Rollback for 20270101000100_question_marking (question-level marking, design Rev 5.2; addendum 5.1 point 6).
-- Run only with approval, AFTER deploying the previous application release, and only through the release kit:
--     node scripts/release/rehearsal.mjs rollback --release question-marking-2027 --evidence <manifest.json> --confirm <ep-id>
--
-- EVIDENCE, NOT ACKNOWLEDGEMENT. When any question-marking data exists, this file refuses unless the session carries a
-- VERIFIED backup manifest (rof.question_marking_manifest, set by the kit from `verify-backup`): a dump restored into a
-- separate scratch database whose per-table row counts and checksums equal the live ones. The check below recomputes the
-- live counts and checksums INSIDE this transaction and refuses on any difference (data written after the backup).
-- It ALWAYS refuses while a COMPOSED final marking exists: such a paper's result lives in the shared results tables
-- (TestMarking, never deleted), so after real approvals the safe path is to roll forward, not back.
--
-- 20270101000000_question_marking_kind's rollback (run after this one) is check-only: PostgreSQL cannot drop an enum
-- value; the unused COMPOSED is harmless (as the file purposes of 20261220000000). Like the other rollbacks, this file
-- does NOT edit Prisma's migration history: `rollback-history --release question-marking-2027` is its own approved step.
BEGIN;

DO $$
DECLARE
  tbl text;
  manifest jsonb;
  live_count bigint;
  live_md5 text;
  total bigint := 0;
  composed bigint;
  question_tests bigint;
  corrected bigint;
BEGIN
  SELECT count(*) INTO composed FROM "TestMarking" WHERE "kind" = 'COMPOSED';
  IF composed > 0 THEN
    RAISE EXCEPTION 'QUESTION_MARKING_ROLLBACK_REFUSED: % COMPOSED final marking(s) exist (question-marked papers were approved); results would be orphaned. Roll forward instead. Nothing was changed.', composed;
  END IF;
  FOREACH tbl IN ARRAY ARRAY['TestQuestionMarker', 'TestQuestionTask', 'TestTaskClaim', 'TestQuestionAssessment', 'TestAssessmentVersion',
                             'TestMarkDraftChange', 'TestQuestionDecision', 'TestTaskEvent', 'TestPaperAccess', 'TestStaffPaperAccess',
                             'TestQuestionPromptHistory'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', tbl) INTO live_count;
    total := total + live_count;
  END LOOP;
  SELECT count(*) INTO question_tests FROM "Test" WHERE "markingMode" = 'QUESTION';
  SELECT count(*) INTO corrected FROM "TestQuestion" WHERE "promptVersion" > 1;
  IF total = 0 AND question_tests = 0 AND corrected = 0 THEN
    RAISE NOTICE 'question-marking rollback: no question-marking data; nothing to verify';
    RETURN;
  END IF;
  manifest := NULLIF(current_setting('rof.question_marking_manifest', true), '')::jsonb;
  IF manifest IS NULL OR (manifest ->> 'verified') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'QUESTION_MARKING_ROLLBACK_REFUSED: % question-marking row(s) and % QUESTION-mode test(s) exist and no verified backup manifest was given (acknowledgement alone is never enough). Run verify-backup, then rollback --evidence <manifest>. Nothing was changed.', total, question_tests;
  END IF;
  FOREACH tbl IN ARRAY ARRAY['TestQuestionMarker', 'TestQuestionTask', 'TestTaskClaim', 'TestQuestionAssessment', 'TestAssessmentVersion',
                             'TestMarkDraftChange', 'TestQuestionDecision', 'TestTaskEvent', 'TestPaperAccess', 'TestStaffPaperAccess',
                             'TestQuestionPromptHistory'] LOOP
    -- The same checksum as the kit's verify-backup: md5 of every row as text, in id order.
    EXECUTE format('SELECT count(*), md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x."id"), '''')) FROM %I x', tbl) INTO live_count, live_md5;
    IF (manifest -> 'tables' -> tbl ->> 'count') IS DISTINCT FROM live_count::text OR (manifest -> 'tables' -> tbl ->> 'md5') IS DISTINCT FROM live_md5 THEN
      RAISE EXCEPTION 'QUESTION_MARKING_ROLLBACK_REFUSED: % differs from the verified backup (live % row(s); manifest % row(s)): data changed after the backup. Take and verify a new backup. Nothing was changed.',
        tbl, live_count, coalesce(manifest -> 'tables' -> tbl ->> 'count', 'none');
    END IF;
  END LOOP;
  SELECT count(*), md5(coalesce(string_agg("id" || ':' || "markingMode"::text, E'\n' ORDER BY "id"), '')) INTO live_count, live_md5 FROM "Test" WHERE "markingMode" = 'QUESTION';
  IF (manifest -> 'tables' -> 'Test.markingMode' ->> 'md5') IS DISTINCT FROM live_md5 THEN
    RAISE EXCEPTION 'QUESTION_MARKING_ROLLBACK_REFUSED: the QUESTION-mode tests differ from the verified backup. Nothing was changed.';
  END IF;
  SELECT count(*), md5(coalesce(string_agg("id" || ':' || "promptVersion"::text, E'\n' ORDER BY "id"), '')) INTO live_count, live_md5 FROM "TestQuestion" WHERE "promptVersion" > 1;
  IF (manifest -> 'tables' -> 'TestQuestion.promptVersion' ->> 'md5') IS DISTINCT FROM live_md5 THEN
    RAISE EXCEPTION 'QUESTION_MARKING_ROLLBACK_REFUSED: the corrected question wordings differ from the verified backup. Nothing was changed.';
  END IF;
  RAISE NOTICE 'question-marking rollback: % row(s) match the verified backup %; discarding them', total, manifest ->> 'dumpSha256';
END $$;

-- The original CHECK (only ADJUSTMENT has no assignment); safe: no COMPOSED row exists (refused above otherwise).
ALTER TABLE "TestMarking" DROP CONSTRAINT "TestMarking_assignment_matches_kind";
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_assignment_matches_kind" CHECK (("kind" = 'ADJUSTMENT') = ("assignmentId" IS NULL));

-- Triggers on existing tables, then the commit-time invariants.
DROP TRIGGER test_marking_mode_guard ON "Test";
DROP TRIGGER test_max_marks_guard ON "Test";
DROP TRIGGER test_question_structure_guard ON "TestQuestion";
DROP TRIGGER test_guide_guard ON "TestFile";
DROP TRIGGER question_paper_invariant_submission ON "TestSubmission";

-- The new tables (their own triggers go with them). Claim ↔ task reference each other: the claim foreign key first.
ALTER TABLE "TestQuestionTask" DROP CONSTRAINT "TestQuestionTask_claimId_fkey";
DROP TABLE "TestPaperAccess";
DROP TABLE "TestStaffPaperAccess";
DROP TABLE "TestMarkDraftChange";
DROP TABLE "TestQuestionDecision";
DROP TABLE "TestAssessmentVersion";
DROP TABLE "TestQuestionAssessment";
DROP TABLE "TestTaskEvent";
DROP TABLE "TestTaskClaim";
DROP TABLE "TestQuestionTask";
DROP TABLE "TestQuestionMarker";
DROP TABLE "TestQuestionPromptHistory";

ALTER TABLE "TestQuestion" DROP CONSTRAINT "TestQuestion_prompt_version";
ALTER TABLE "TestQuestion" DROP COLUMN "promptVersion";
ALTER TABLE "Test" DROP COLUMN "markingMode";

DROP FUNCTION check_question_paper_invariant();
DROP FUNCTION check_question_decision_invariant();
DROP FUNCTION test_question_decision_guard();
DROP FUNCTION test_paper_access_guard();
DROP FUNCTION question_marking_append_only();
DROP FUNCTION test_question_assessment_guard();
DROP FUNCTION test_task_claim_guard();
DROP FUNCTION test_question_task_guard();
DROP FUNCTION test_question_marker_guard();
DROP FUNCTION test_guide_guard();
DROP FUNCTION test_max_marks_guard();
DROP FUNCTION test_question_structure_guard();
DROP FUNCTION question_marking_started(text);
DROP FUNCTION test_marking_mode_guard();
DROP FUNCTION question_paper_status(text);
DROP FUNCTION question_paper_status_of(text[]);
DROP FUNCTION can_mark_subject(text, text);

DROP TYPE "PaperAccessKind";
DROP TYPE "QuestionDecisionSource";
DROP TYPE "TaskClaimEndReason";
DROP TYPE "TaskClaimMethod";
DROP TYPE "QuestionAssessmentStatus";
DROP TYPE "QuestionTaskStatus";
DROP TYPE "QuestionTaskRound";
DROP TYPE "TestMarkingMode";

COMMIT;
