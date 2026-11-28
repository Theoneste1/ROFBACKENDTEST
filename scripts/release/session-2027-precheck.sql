-- Session-2027 release pre-check (BEFORE `prisma migrate deploy` of 20270102000000_session_activity: sessions end after
-- 60 minutes without user activity; owner 2026-11-28): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release session-2027   (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/session-2027-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with session-2027-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 2, 0, 0: the two question-marking-2027 migrations applied; nothing from 20270102000000 on; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name IN ('20270101000000_question_marking_kind', '20270101000100_question_marking')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS question_marking_applied,
       count(*) FILTER (WHERE migration_name >= '20270102000000')                              AS session_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0: the column does not exist yet'
SELECT count(*) AS session_columns FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'RefreshToken' AND column_name = 'lastActivityAt';

\echo '== 3. compare: sessions (refresh tokens) by state, unchanged by the migration'
SELECT count(*) AS tokens, count(*) FILTER (WHERE "revokedAt" IS NULL AND "rotatedAt" IS NULL AND "expiresAt" > now()) AS live
  FROM "RefreshToken";

ROLLBACK;
