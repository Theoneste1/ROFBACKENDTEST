-- Rollback for 20261206000000_account_states (account states and their history; after
-- 20261205000000_avatar_file_purpose).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads and writes User.accountStatus and UserStatusChange).
--
-- It removes what this migration created: the sync trigger and its function, the UserStatusChange table, the
-- User.accountStatus column with its indexes, and the AccountStatus enum. isActive is kept: every blocked
-- account (DEACTIVATED, SUSPENDED or ARCHIVED) already has isActive = false, which the previous release treats
-- as suspended — nobody regains access by the rollback.
--
-- It REFUSES, and changes nothing, while the history or a state the previous release cannot express would be
-- lost: any UserStatusChange row, or any DEACTIVATED or ARCHIVED account. To discard them knowingly, after a
-- backup that contains them, run this file in a session that first sets:
--     SET rof.account_states_rollback = 'discard-account-states';
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'User' AND column_name = 'accountStatus';                                 -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261206000000_account_states';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;

DO $$
DECLARE
  history bigint;
  states  bigint;
BEGIN
  SELECT count(*) INTO history FROM "UserStatusChange";
  SELECT count(*) INTO states FROM "User" WHERE "accountStatus" IN ('DEACTIVATED', 'ARCHIVED');
  IF (history > 0 OR states > 0)
     AND current_setting('rof.account_states_rollback', true) IS DISTINCT FROM 'discard-account-states' THEN
    RAISE EXCEPTION 'ACCOUNT_STATES_ROLLBACK_REFUSED: % status change(s) and % deactivated or archived account(s) would lose their history or state; nothing was changed. After a backup that contains them, SET rof.account_states_rollback = ''discard-account-states'' and run again.', history, states;
  END IF;
END $$;

DROP TRIGGER IF EXISTS user_account_status_sync ON "User";
DROP FUNCTION IF EXISTS user_account_status_sync();
DROP TABLE IF EXISTS "UserStatusChange";
DROP INDEX IF EXISTS "User_role_accountStatus_idx";
DROP INDEX IF EXISTS "User_accountStatus_idx";
ALTER TABLE "User" DROP COLUMN IF EXISTS "accountStatus";
DROP TYPE IF EXISTS "AccountStatus";

COMMIT;
