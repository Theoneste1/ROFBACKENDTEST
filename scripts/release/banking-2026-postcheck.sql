-- Banking-2026 release post-check (AFTER `prisma migrate deploy` of 20261231000000_user_bank_details; owner 2026-11-25):
-- READ ONLY. Compare section 3 with banking-2026-precheck.sql. Runbook: docs/releases/banking-2026.md.
--
--   node scripts/release/rehearsal.mjs postcheck --release banking-2026
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/banking-2026-postcheck.sql

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the banking migration applied; nothing after it; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name = '20261231000000_user_bank_details'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS banking_applied,
       count(*) FILTER (WHERE migration_name > '20261231000000_user_bank_details')             AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 0: the table exists and is empty (nobody has given bank details yet)'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('UserBankDetails')) AS banking_tables,
       (SELECT count(*) FROM "UserBankDetails")                                                                             AS bank_detail_rows;

\echo '== 3. compare: users by role, unchanged by the migration'
SELECT "role"::text AS role, count(*) AS users FROM "User" GROUP BY 1 ORDER BY 1;

ROLLBACK;
