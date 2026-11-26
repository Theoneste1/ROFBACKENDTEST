-- Question-level marking (design Rev 5.2), migration 1 of 2: the COMPOSED marking kind, alone.
-- PostgreSQL refuses to use an enum value in the transaction that adds it (tested 2026-11-26 on PostgreSQL 18:
-- "unsafe use of new value"), so the value is committed here and first used by 20270101000100_question_marking.
-- Inert: nothing uses it until a QUESTION-mode paper is fully approved. IF NOT EXISTS: PostgreSQL cannot drop an enum
-- value, so a rollback keeps it and a re-deploy must not fail on it. No rollback file (as 20261220000000_test_file_purposes).

ALTER TYPE "TestMarkingKind" ADD VALUE IF NOT EXISTS 'COMPOSED';
