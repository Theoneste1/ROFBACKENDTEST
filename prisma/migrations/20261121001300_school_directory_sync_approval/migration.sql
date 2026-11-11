-- M14 (school directory S2b; owner-approved 2026-11-11): approval, review generations and
-- recompare for the directory sync.
--
-- Named after M13 on purpose: migrations apply in name order, and M14 builds on M13's tables.
--
-- Additive only: five nullable columns and two indexes. No existing row, id or relationship
-- changes; nothing is written to the directory tables.
--
--   SchoolSyncRun.approvedAt / approvedById   the Super Admin who approved the run for apply
--   SchoolSyncRun.approvedGeneration          the review generation that was approved
--   SchoolSyncRun.approvalTokenId             identifies the one valid apply token — never the
--                                             token itself (a random id; tokens are signed and
--                                             their hashes appear only in the audit log)
--   SchoolSyncChange.retiredAt                a recompare found the change no longer part of
--                                             the comparison; kept with its decision as history
--                                             (changes are never deleted — M13's trigger)
--
-- school_sync_run_guard (M13) is replaced by a version that also lets a user reference
-- (createdById, appliedById, approvedById) become NULL when that user is deleted (ON DELETE SET
-- NULL) — nothing else may change on an APPLIED or SUPERSEDED run, as before. Without this, a
-- user who created, approved or applied a final run could not be deleted (the same exception
-- the audit log's append-only trigger makes for actorId).
-- Explicit transaction: everything is applied together or not at all.
-- Rollback: docs/migrations/20261121001300_school_directory_sync_approval.rollback.sql (before M13's).

BEGIN;

-- AlterTable
ALTER TABLE "SchoolSyncChange" ADD COLUMN     "retiredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SchoolSyncRun" ADD COLUMN     "approvalTokenId" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedGeneration" INTEGER;

-- CreateIndex
CREATE INDEX "SchoolSyncChange_runId_retiredAt_idx" ON "SchoolSyncChange"("runId", "retiredAt");

-- CreateIndex
CREATE INDEX "SchoolSyncRun_approvedById_idx" ON "SchoolSyncRun"("approvedById");

-- AddForeignKey
ALTER TABLE "SchoolSyncRun" ADD CONSTRAINT "SchoolSyncRun_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Run lifecycle (M13's rules, unchanged) + a deleted user's reference may become NULL.
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
  -- A deleted user's reference becoming NULL (ON DELETE SET NULL) is not a change of the run.
  changed := changed - ARRAY(SELECT k FROM unnest(ARRAY['createdById', 'appliedById', 'approvedById']) AS k
                              WHERE changed -> k = 'null'::jsonb);
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

COMMIT;
