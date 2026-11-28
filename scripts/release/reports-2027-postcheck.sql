-- Reports-2027 release post-check (AFTER `prisma migrate deploy` of 20270103000000_submission_reports; owner 2026-11-28):
-- READ ONLY. Compare section 3 with reports-2027-precheck.sql.
--
--   node scripts/release/rehearsal.mjs postcheck --release reports-2027
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/reports-2027-postcheck.sql

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the reports migration applied; nothing after it; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name = '20270103000000_submission_reports'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS reports_applied,
       count(*) FILTER (WHERE migration_name > '20270103000000_submission_reports')            AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 4, 1, 0: the table, the four grant columns, its append-only trigger; no correction yet'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TestSubmissionCorrection') AS correction_table,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CustomReportGrant'
           AND column_name IN ('schoolId', 'expiresAt', 'revokedAt', 'revokedById'))                                   AS grant_columns,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'test_submission_correction_append_only' AND NOT tgisinternal)    AS append_only_trigger,
       (SELECT count(*) FROM "TestSubmissionCorrection")                                                              AS corrections;

\echo '== 3. compare: reports, grants and submitted answers, unchanged by the migration'
SELECT (SELECT count(*) FROM "CustomReport")                                    AS reports,
       (SELECT count(*) FROM "CustomReportGrant")                               AS grants,
       (SELECT count(*) FROM "TestSubmission" WHERE "versionCount" > 0)         AS submitted_answers;

ROLLBACK;
