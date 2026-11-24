-- Rollback for 20261231000000_email_free_plan (e-mail within the Resend Free plan; owner 2026-11-24).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes EmailDelivery.priority / kind / linkExpiresAt / linkTokenId, EmailSendingState and the DISCARDED status).
--
-- It removes what this migration created that PostgreSQL can remove: the EmailSendingState table, the four EmailDelivery
-- columns, the EmailPriority type and the four indexes. The EmailDeliveryStatus value DISCARDED is KEPT: PostgreSQL cannot
-- drop an enum value, and an unused value is harmless — but the previous release cannot READ a row with it (its Prisma
-- client does not know the value), so no row may keep it.
--
-- It REFUSES, and changes nothing, while any e-mail is DISCARDED (the record of which e-mails were deliberately not sent,
-- and why, would change) or while any e-mail still waiting carries a kind / priority / link expiry (the previous release
-- would send it in plain queue order, without the budget and without the dead-link check). To proceed knowingly, after a
-- backup that contains them, run this file in a session that first sets:
--     SET rof.email_free_plan_rollback = 'discard-email-budget-data';
-- With that setting every DISCARDED row becomes FAILED (its plain reason kept in errorMessage; its text was already
-- cleared, so an administrator's "retry" answers CONTENT_NOT_KEPT and it is never sent), and the budget columns are dropped.
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name = 'EmailSendingState';                    -- expect 0
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'EmailDelivery'
--           AND column_name IN ('priority', 'kind', 'linkExpiresAt', 'linkTokenId');                               -- expect 0
--        SELECT count(*) FROM "EmailDelivery" WHERE "status"::text = 'DISCARDED';                                  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261231000000_email_free_plan';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works: the migration uses `ADD VALUE IF NOT EXISTS 'DISCARDED'` (the value is kept by this file).
BEGIN;

LOCK TABLE "EmailDelivery" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  discarded bigint;
  waiting   bigint;
BEGIN
  SELECT count(*) INTO discarded FROM "EmailDelivery" WHERE "status"::text = 'DISCARDED';
  SELECT count(*) INTO waiting FROM "EmailDelivery"
   WHERE "status" = 'PENDING' AND ("priority" IS NOT NULL OR "kind" IS NOT NULL OR "linkExpiresAt" IS NOT NULL);
  IF (discarded > 0 OR waiting > 0)
     AND current_setting('rof.email_free_plan_rollback', true) IS DISTINCT FROM 'discard-email-budget-data' THEN
    RAISE EXCEPTION 'EMAIL_FREE_PLAN_ROLLBACK_REFUSED: % discarded e-mail(s) and % waiting e-mail(s) with budget data would change; nothing was changed. After a backup that contains them, SET rof.email_free_plan_rollback = ''discard-email-budget-data'' and run again.', discarded, waiting;
  END IF;
END $$;

UPDATE "EmailDelivery" SET "status" = 'FAILED' WHERE "status"::text = 'DISCARDED';

DROP TABLE IF EXISTS "EmailSendingState";
DROP INDEX IF EXISTS "EmailDelivery_status_attemptedAt_idx";
DROP INDEX IF EXISTS "EmailDelivery_status_priority_nextAttemptAt_idx";
DROP INDEX IF EXISTS "EmailDelivery_recipientId_status_idx";
DROP INDEX IF EXISTS "NotificationOutbox_status_sentAt_idx";
ALTER TABLE "EmailDelivery" DROP COLUMN IF EXISTS "priority";
ALTER TABLE "EmailDelivery" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "EmailDelivery" DROP COLUMN IF EXISTS "linkExpiresAt";
ALTER TABLE "EmailDelivery" DROP COLUMN IF EXISTS "linkTokenId";
DROP TYPE IF EXISTS "EmailPriority";

COMMIT;
