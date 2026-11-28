-- Session-2027 release post-check (AFTER `prisma migrate deploy` of 20270102000000_session_activity; owner 2026-11-28):
-- READ ONLY. Compare section 3 with session-2027-precheck.sql.
--
--   node scripts/release/rehearsal.mjs postcheck --release session-2027
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/session-2027-postcheck.sql

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the session migration applied; nothing after it; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name = '20270102000000_session_activity'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS session_applied,
       count(*) FILTER (WHERE migration_name > '20270102000000_session_activity')              AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1: the column exists (existing tokens hold NULL: their issue time counts as their last activity)'
SELECT count(*) AS session_columns FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'RefreshToken' AND column_name = 'lastActivityAt';

\echo '== 3. compare: sessions (refresh tokens) by state, unchanged by the migration'
SELECT count(*) AS tokens, count(*) FILTER (WHERE "revokedAt" IS NULL AND "rotatedAt" IS NULL AND "expiresAt" > now()) AS live
  FROM "RefreshToken";

ROLLBACK;
