-- Test Management (WS3, owner spec and plan approved 2026-11-19), migration M-a: three new PRIVATE file purposes.
-- Additive: enum values only. TEST_PAPER (a test's question paper), TEST_ANSWER (a student's answer pages, used from
-- Phase 2) and MARKING_GUIDE (a test's marking guide / answer key). Their content types and size limits live in the
-- application (src/common/storage/file-rules.ts: PDF and images incl. phone photos, 20 MB); files are stored and served
-- like every other private file (authorised download only). No existing row changes.
-- IF NOT EXISTS: PostgreSQL cannot drop an enum value, so the rollback keeps them and a re-deploy must not add them again.
-- Rollback: docs/migrations/20261220000000_test_file_purposes.rollback.sql (after the tests_core rollback).

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'TEST_PAPER';
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'TEST_ANSWER';
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'MARKING_GUIDE';
