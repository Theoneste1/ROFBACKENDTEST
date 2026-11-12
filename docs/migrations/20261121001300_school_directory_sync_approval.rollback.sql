-- Rollback for M14 (20261121001300_school_directory_sync_approval). Run manually, with approval,
-- after a backup, and after deploying the previous application release (the current code reads
-- these columns). Roll back M14 BEFORE M13 (docs/migrations/README.md).
--
-- It removes ONLY what M14 created — the approval columns of SchoolSyncRun, SchoolSyncChange.
-- retiredAt and their indexes — and restores M13's run guard. It never touches a school, contact,
-- source record, external id or sync run row, and does not undo anything a sync applied.
--
-- It REFUSES, and changes nothing, while approval or recompare history exists (a run was approved,
-- or a change was retired by a recompare): who approved which run, and which changes a recompare
-- replaced, would be lost. To discard that history knowingly, after a backup that contains it,
-- run this file in a session that first sets:
--     SET rof.m14_rollback = 'discard-approval-history';
--
-- This file deliberately does NOT edit Prisma's migration history (same procedure as M9–M13):
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE (table_name = 'SchoolSyncRun' AND column_name IN ('approvedAt', 'approvedById', 'approvedGeneration', 'approvalTokenId'))
--            OR (table_name = 'SchoolSyncChange' AND column_name = 'retiredAt');                   -- expect 0
--   2. Back up, then mark M14 as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121001300_school_directory_sync_approval';
--   3. `npx prisma migrate status` must then list M14 as not yet applied.
BEGIN;

DO $$
DECLARE
  approvals bigint;
  retired   bigint;
BEGIN
  SELECT count(*) INTO approvals FROM "SchoolSyncRun" WHERE "approvedAt" IS NOT NULL OR "approvalTokenId" IS NOT NULL;
  SELECT count(*) INTO retired FROM "SchoolSyncChange" WHERE "retiredAt" IS NOT NULL;
  IF approvals + retired > 0 AND current_setting('rof.m14_rollback', true) IS DISTINCT FROM 'discard-approval-history' THEN
    RAISE EXCEPTION 'M14_ROLLBACK_REFUSED: % approved runs and % retired changes would lose their history; nothing was changed. After a backup that contains them, SET rof.m14_rollback = ''discard-approval-history'' and run again.', approvals, retired;
  END IF;
END $$;

-- M13's run guard, exactly.
CREATE OR REPLACE FUNCTION school_sync_run_guard() RETURNS trigger AS $$
DECLARE
  changed jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SCHOOL_SYNC_HISTORY_PERMANENT: sync runs are never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PREVIEW' AND NEW."status" IN ('APPLIED', 'EXPIRED', 'SUPERSEDED'))
    OR (OLD."status" = 'EXPIRED' AND NEW."status" = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'SCHOOL_SYNC_RUN_STATUS: % → % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  changed := (SELECT coalesce(jsonb_object_agg(n.key, n.value), '{}'::jsonb)
                FROM jsonb_each(to_jsonb(NEW)) n
               WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key);
  IF OLD."status" IN ('APPLIED', 'SUPERSEDED') AND (changed - 'stagedPurgedAt') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'SCHOOL_SYNC_RUN_FINAL: an % run cannot change', OLD."status"
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'EXPIRED'
     AND (changed - 'status' - 'supersededAt' - 'supersededByRunId' - 'stagedPurgedAt') <> '{}'::jsonb THEN
    RAISE EXCEPTION 'SCHOOL_SYNC_RUN_FINAL: an EXPIRED run can only be superseded or purged'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

ALTER TABLE "SchoolSyncRun" DROP CONSTRAINT IF EXISTS "SchoolSyncRun_approvedById_fkey";
DROP INDEX IF EXISTS "SchoolSyncRun_approvedById_idx";
DROP INDEX IF EXISTS "SchoolSyncChange_runId_retiredAt_idx";
ALTER TABLE "SchoolSyncRun"
  DROP COLUMN IF EXISTS "approvalTokenId",
  DROP COLUMN IF EXISTS "approvedAt",
  DROP COLUMN IF EXISTS "approvedById",
  DROP COLUMN IF EXISTS "approvedGeneration";
ALTER TABLE "SchoolSyncChange" DROP COLUMN IF EXISTS "retiredAt";

COMMIT;
