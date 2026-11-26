-- Rollback for 20270101000000_question_marking_kind (question-level marking, design Rev 5.2): CHECK ONLY.
-- Run with approval, AFTER 20270101000100_question_marking.rollback.sql (newest first), through the release kit:
--     node scripts/release/rehearsal.mjs rollback --release question-marking-2027 --evidence <manifest.json> --confirm <ep-id>
--
-- PostgreSQL cannot drop an enum value: the TestMarkingKind value COMPOSED is KEPT (an unused value is harmless; the
-- previous release never writes it, and the restored CHECK "TestMarking_assignment_matches_kind" no longer accepts a
-- COMPOSED row without an assignment). This file changes nothing; it only checks that nothing still needs the value.
--
-- It REFUSES, and changes nothing:
--   * while the question-marking tables still exist (roll back 20270101000100_question_marking first);
--   * while any COMPOSED marking exists (a question-marked paper's final result: never discarded by a rollback).
--
-- Like the other rollbacks, it does NOT edit Prisma's migration history: `rollback-history --release question-marking-2027`
-- deletes both rows once 20270101000100's objects are gone. Re-applying later works: ADD VALUE IF NOT EXISTS.
BEGIN;

DO $$
DECLARE
  tables bigint;
  composed bigint;
BEGIN
  SELECT count(*) INTO tables FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('TestQuestionTask', 'TestTaskClaim', 'TestQuestionAssessment', 'TestQuestionMarker');
  IF tables > 0 THEN
    RAISE EXCEPTION 'QUESTION_MARKING_KIND_ROLLBACK_REFUSED: the question-marking tables still exist (%); nothing was changed. Run 20270101000100_question_marking.rollback.sql first.', tables;
  END IF;
  SELECT count(*) INTO composed FROM "TestMarking" WHERE "kind" = 'COMPOSED';
  IF composed > 0 THEN
    RAISE EXCEPTION 'QUESTION_MARKING_KIND_ROLLBACK_REFUSED: % COMPOSED marking(s) exist (final results of question-marked papers); nothing was changed. Roll forward instead.', composed;
  END IF;
  RAISE NOTICE 'question-marking kind rollback: COMPOSED is kept (PostgreSQL cannot drop an enum value) and unused';
END $$;

COMMIT;
