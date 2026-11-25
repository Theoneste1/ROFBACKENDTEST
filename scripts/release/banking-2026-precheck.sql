-- Banking-2026 release pre-check (BEFORE `prisma migrate deploy` of 20261231000000_user_bank_details: the personal and
-- school bank details of Teachers, Coaches and Head Coaches; owner 2026-11-25): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release banking-2026   (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/banking-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with banking-2026-postcheck.sql right after the migration. Runbook: docs/releases/banking-2026.md.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 7, 0, 0: the seven launch-2026 migrations applied; nothing from 20261231000000 on; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name IN ('20261225000000_school_sync_mode', '20261225000100_teacher_unlisted_school',
                          '20261226000000_registration_data', '20261227000000_coach_programme_access',
                          '20261228000000_form_email_verification', '20261229000000_subscribers', '20261230000000_view_as')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS launch_applied,
       count(*) FILTER (WHERE migration_name >= '20261231000000')                              AS banking_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0: the table does not exist yet'
SELECT count(*) AS banking_tables FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('UserBankDetails');

\echo '== 3. compare: the people who will be asked for their bank details at their next sign-in (Teachers, Coaches, Head Coaches), and every role'
SELECT "role"::text AS role, count(*) AS users FROM "User" GROUP BY 1 ORDER BY 1;

ROLLBACK;
