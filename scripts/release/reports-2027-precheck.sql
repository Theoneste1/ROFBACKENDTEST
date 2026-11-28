-- Reports-2027 release pre-check (BEFORE `prisma migrate deploy` of 20270103000000_submission_reports: submission
-- reports — corrections of a submission's test and/or level; report sharing with schools, expiry and revocation;
-- owner 2026-11-28): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release reports-2027   (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/reports-2027-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with reports-2027-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the session-2027 migration applied; nothing from 20270103000000 on; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name = '20270102000000_session_activity'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS session_applied,
       count(*) FILTER (WHERE migration_name >= '20270103000000')                              AS reports_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0: the table and the grant columns do not exist yet'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TestSubmissionCorrection') AS correction_table,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CustomReportGrant'
           AND column_name IN ('schoolId', 'expiresAt', 'revokedAt', 'revokedById'))                                   AS grant_columns;

\echo '== 3. compare: reports, grants and submitted answers, unchanged by the migration'
SELECT (SELECT count(*) FROM "CustomReport")                                    AS reports,
       (SELECT count(*) FROM "CustomReportGrant")                               AS grants,
       (SELECT count(*) FROM "TestSubmission" WHERE "versionCount" > 0)         AS submitted_answers;

ROLLBACK;
