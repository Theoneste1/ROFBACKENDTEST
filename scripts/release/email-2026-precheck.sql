-- Email-2026 release pre-check (BEFORE `prisma migrate deploy` of 20261231000000_email_free_plan: e-mail within the Resend
-- Free plan; owner decision 2026-11-24): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release email-2026   (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/email-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with email-2026-postcheck.sql right after the migration. Runbook: docs/releases/email-2026.md.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 7, 0, 0: the seven launch-2026 migrations applied; nothing from 20261231000000 on; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name >= '20261225000000' AND migration_name < '20261231000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)              AS launch_applied,
       count(*) FILTER (WHERE migration_name >= '20261231000000')                              AS email_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)               AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0, 0, 0: nothing made by the migration exists yet (table, type, columns, status value)'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('EmailSendingState'))      AS email_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname IN ('EmailPriority'))                 AS email_types,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'EmailDelivery'
           AND column_name IN ('priority', 'kind', 'linkExpiresAt', 'linkTokenId'))                                                AS email_columns,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'EmailDeliveryStatus' AND e.enumlabel = 'DISCARDED')                                                    AS discarded_value;

\echo '== 3. compare: e-mail rows by status (the migration changes none; the worker classifies and cleans the queue after the deploy)'
SELECT "status"::text AS status, count(*) AS deliveries FROM "EmailDelivery" GROUP BY 1 ORDER BY 1;
SELECT "status"::text AS status, count(*) AS decision_notices FROM "NotificationOutbox" GROUP BY 1 ORDER BY 1;

\echo '== 4. NOTE: the waiting e-mails by subject (platform prefix removed; no addresses shown)'
SELECT regexp_replace(coalesce("subject", '(bulk job)'), '^\[[^]]*\] *', '') AS subject, ("jobId" IS NOT NULL) AS bulk,
       count(*) AS waiting, min("createdAt") AS oldest
  FROM "EmailDelivery" WHERE "status" = 'PENDING' GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '== 5. NOTE: e-mails sent today (UTC day) and in the last 31 days (the budget counts these: 95 / 2,900 by default)'
SELECT (SELECT count(*) FROM "EmailDelivery" WHERE "status" = 'SENT' AND "attemptedAt" >= date_trunc('day', NOW() AT TIME ZONE 'UTC'))
     + (SELECT count(*) FROM "NotificationOutbox" WHERE "status" = 'SENT' AND "sentAt" >= date_trunc('day', NOW() AT TIME ZONE 'UTC'))      AS sent_today_utc,
       (SELECT count(*) FROM "EmailDelivery" WHERE "status" = 'SENT' AND "attemptedAt" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '31 days')
     + (SELECT count(*) FROM "NotificationOutbox" WHERE "status" = 'SENT' AND "sentAt" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '31 days')  AS sent_31d;

\echo '== 6. NOTE: rows that FAILED only because of the provider limit (recoverable from the admin E-mail page after the release, with approval)'
SELECT (SELECT count(*) FROM "EmailDelivery" WHERE "status" = 'FAILED' AND "errorMessage" LIKE 'Resend 429 %')   AS quota_failed_emails,
       (SELECT count(*) FROM "NotificationOutbox" WHERE "status" = 'FAILED' AND "lastError" LIKE 'Resend 429 %')  AS quota_failed_notices;

ROLLBACK;
