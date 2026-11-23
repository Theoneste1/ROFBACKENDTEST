-- Rollback for 20261229000000_subscribers (news subscribers and mailings; owner, 2026-11-23).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the new tables and EmailDelivery.subscriberId).
--
-- It drops Subscriber, Mailing, EmailDelivery.subscriberId and the four new types. The mailing list (names, e-mail
-- addresses, interests, who unsubscribed and when) and the mailing history would be LOST; the e-mails themselves stay
-- in EmailJob / EmailDelivery (without the link to the subscriber). It REFUSES, and changes nothing, while any
-- subscriber or mailing exists. To discard them knowingly, after a backup that contains them (export the list first:
-- GET /api/v1/admin/subscribers/export), run this file in a session that first sets:
--     SET rof.subscribers_rollback = 'discard-subscribers';
-- It also refuses while a mailing delivery is still PENDING (wait for the outbox, or cancel the mailing).
--
-- Like the other recent rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name IN ('Subscriber', 'Mailing');           -- expect 0
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'EmailDelivery' AND column_name = 'subscriberId';  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261229000000_subscribers';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

LOCK TABLE "Subscriber", "Mailing", "EmailDelivery" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  subscribers bigint;
  mailings    bigint;
  pending     bigint;
BEGIN
  SELECT count(*) INTO pending FROM "EmailDelivery" WHERE "subscriberId" IS NOT NULL AND "status" = 'PENDING';
  IF pending > 0 THEN
    RAISE EXCEPTION 'Refusing: % subscriber e-mail(s) are still waiting to be sent. Let the outbox finish or cancel the mailing first.', pending;
  END IF;
  SELECT count(*) INTO subscribers FROM "Subscriber";
  SELECT count(*) INTO mailings FROM "Mailing";
  IF (subscribers > 0 OR mailings > 0) AND coalesce(current_setting('rof.subscribers_rollback', true), '') <> 'discard-subscribers' THEN
    RAISE EXCEPTION 'Refusing: % subscriber(s) and % mailing(s) exist. Back them up, then set rof.subscribers_rollback = ''discard-subscribers'' to proceed.', subscribers, mailings;
  END IF;
END $$;

ALTER TABLE "EmailDelivery" DROP CONSTRAINT "EmailDelivery_subscriberId_fkey";
DROP INDEX "EmailDelivery_subscriberId_idx";
ALTER TABLE "EmailDelivery" DROP COLUMN "subscriberId";

DROP TABLE "Mailing";
DROP TABLE "Subscriber";

DROP TYPE "MailingStatus";
DROP TYPE "SubscriberStatus";
DROP TYPE "SubscriberSource";
DROP TYPE "SubscriberKind";

COMMIT;
