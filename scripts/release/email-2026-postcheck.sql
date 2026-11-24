-- Email-2026 release post-check (AFTER `prisma migrate deploy` of 20261231000000_email_free_plan; owner 2026-11-24):
-- READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release email-2026  (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/email-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with email-2026-precheck.sql taken just before the migration. Runbook: docs/releases/email-2026.md.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 1, 0, 0: the migration applied; nothing after 20261231000000_email_free_plan; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name = '20261231000000_email_free_plan' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS email_applied,
       count(*) FILTER (WHERE migration_name > '20261231000000_email_free_plan')                 AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                  AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 1, 4, 1: the table, the type, the four columns, the status value'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('EmailSendingState'))      AS email_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname IN ('EmailPriority'))                 AS email_types,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'EmailDelivery'
           AND column_name IN ('priority', 'kind', 'linkExpiresAt', 'linkTokenId'))                                                AS email_columns,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'EmailDeliveryStatus' AND e.enumlabel = 'DISCARDED')                                                    AS discarded_value;

\echo '== 3. MUST be: EmailDeliveryStatus PENDING,SENT,FAILED,DISCARDED; EmailPriority CRITICAL,NORMAL,BULK'
SELECT t.typname AS type, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS "values"
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
 WHERE t.typnamespace = 'public'::regnamespace AND t.typname IN ('EmailPriority', 'EmailDeliveryStatus')
 GROUP BY t.typname ORDER BY t.typname;

\echo '== 4. MUST be: the four columns nullable, no default (priority "EmailPriority", linkExpiresAt timestamp, kind and linkTokenId text)'
SELECT c.column_name AS "column", CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS type,
       c.is_nullable AS nullable, coalesce(c.column_default, '') AS "default"
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND c.table_name = 'EmailDelivery' AND c.column_name IN ('priority', 'kind', 'linkExpiresAt', 'linkTokenId')
 ORDER BY 1;

\echo '== 5. MUST be 4: the indexes for the budget counts, the priority claim and the superseded links'
SELECT count(*) AS indexes FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
         'EmailDelivery_status_attemptedAt_idx', 'EmailDelivery_status_priority_nextAttemptAt_idx',
         'EmailDelivery_recipientId_status_idx', 'NotificationOutbox_status_sentAt_idx');

\echo '== 6. compare: e-mail rows by status, right after the migration equal to the pre-check (only the running worker discards, later)'
SELECT "status"::text AS status, count(*) AS deliveries FROM "EmailDelivery" GROUP BY 1 ORDER BY 1;
SELECT "status"::text AS status, count(*) AS decision_notices FROM "NotificationOutbox" GROUP BY 1 ORDER BY 1;

\echo '== 7. NOTE (0 right after the migration, before the new application starts): rows the worker has classified; provider pause rows'
SELECT (SELECT count(*) FROM "EmailDelivery" WHERE "priority" IS NOT NULL OR "kind" IS NOT NULL OR "linkExpiresAt" IS NOT NULL) AS classified,
       (SELECT count(*) FROM "EmailSendingState")                                                                                AS pause_rows;

ROLLBACK;
