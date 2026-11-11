-- M13 (school directory S2a; owner-approved 2026-11-11): staging for the repeatable directory sync.
--
-- Additive only: five enums, three tables and one nullable column. No existing row, id or
-- relationship changes; nothing is written to the directory tables.
--
--   SchoolSyncRun      one upload of a source export compared with the directory (a dry run);
--                      datasetKey / normaliserVersion come from the server's dataset configuration
--   SchoolSyncItem     one source row (or a directory school missing from the source); raw and
--                      normalized are staged copies, purged 7 days after the run ended
--   SchoolSyncChange   one proposed field change, addition, new place or new school; its values
--                      are staged copies, purged with the run's staging data
--   SchoolSourceRecord.syncRunId   the run that recorded a permanent source row (S2b's apply)
--
-- Triggers:
--   school_sync_run_guard     run status moves only PREVIEW → APPLIED / EXPIRED / SUPERSEDED and
--                             EXPIRED → SUPERSEDED; APPLIED and SUPERSEDED are final (only
--                             stagedPurgedAt may still be set); runs are never deleted
--   school_sync_staging_keep  sync items and changes are never deleted (decisions, outcomes and
--                             links are permanent; only staged values are purged)
-- Every new reference is ON DELETE RESTRICT (users: SET NULL).
-- Explicit transaction: everything is applied together or not at all.
-- Rollback: docs/migrations/20261121001200_school_directory_sync.rollback.sql (before M12's).

BEGIN;

-- CreateEnum
CREATE TYPE "SchoolSyncRunStatus" AS ENUM ('PREVIEW', 'APPLIED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SchoolSyncItemOutcome" AS ENUM ('MATCHED', 'NEW', 'DUPLICATE_ROW', 'CONFLICT', 'POSSIBLE_DUPLICATE', 'INVALID', 'MISSING_FROM_SOURCE');

-- CreateEnum
CREATE TYPE "SchoolSyncChangeKind" AS ENUM ('CREATE_SCHOOL', 'FILL_EMPTY', 'CHANGE', 'NAME_RESTORE', 'NEW_PLACE', 'ADD_CONTACT', 'ADD_LEVEL', 'ADD_PROGRAMME', 'RESOLVE_CONFLICT');

-- CreateEnum
CREATE TYPE "SchoolSyncDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SchoolSyncConflictState" AS ENUM ('OPEN', 'PROPOSED', 'RESOLVED');

-- AlterTable
ALTER TABLE "SchoolSourceRecord" ADD COLUMN     "syncRunId" TEXT;

-- CreateTable
CREATE TABLE "SchoolSyncRun" (
    "id" TEXT NOT NULL,
    "datasetKey" TEXT NOT NULL,
    "normaliserVersion" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "datasetLabel" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "sourceSummary" JSONB,
    "reconciliation" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "reportDigest" TEXT NOT NULL,
    "decisionsDigest" TEXT NOT NULL,
    "reviewGeneration" INTEGER NOT NULL DEFAULT 0,
    "status" "SchoolSyncRunStatus" NOT NULL DEFAULT 'PREVIEW',
    "comparedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "supersededByRunId" TEXT,
    "stagedPurgedAt" TIMESTAMP(3),
    "metrics" JSONB,

    CONSTRAINT "SchoolSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolSyncItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rowNumber" INTEGER,
    "sourceRef" TEXT,
    "raw" JSONB,
    "normalized" JSONB,
    "outcome" "SchoolSyncItemOutcome" NOT NULL,
    "schoolId" TEXT,
    "matchedBy" TEXT,
    "conflictGroup" TEXT,
    "details" JSONB,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "conflictState" "SchoolSyncConflictState",
    "proposal" JSONB,
    "proposedById" TEXT,
    "proposedAt" TIMESTAMP(3),
    "resolution" JSONB,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "sourceRecordId" TEXT,
    "auditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolSyncItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolSyncChange" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT,
    "schoolId" TEXT,
    "kind" "SchoolSyncChangeKind" NOT NULL,
    "field" TEXT,
    "currentValue" JSONB,
    "publishedValue" JSONB,
    "decision" "SchoolSyncDecision" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "categoryApprovalDigest" TEXT,
    "appliedAt" TIMESTAMP(3),
    "auditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolSyncChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchoolSyncRun_datasetKey_status_idx" ON "SchoolSyncRun"("datasetKey", "status");

-- CreateIndex
CREATE INDEX "SchoolSyncRun_status_expiresAt_idx" ON "SchoolSyncRun"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "SchoolSyncRun_dataSourceId_idx" ON "SchoolSyncRun"("dataSourceId");

-- CreateIndex
CREATE INDEX "SchoolSyncRun_createdById_idx" ON "SchoolSyncRun"("createdById");

-- CreateIndex
CREATE INDEX "SchoolSyncRun_appliedById_idx" ON "SchoolSyncRun"("appliedById");

-- CreateIndex
CREATE INDEX "SchoolSyncRun_supersededByRunId_idx" ON "SchoolSyncRun"("supersededByRunId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSyncItem_sourceRecordId_key" ON "SchoolSyncItem"("sourceRecordId");

-- CreateIndex
CREATE INDEX "SchoolSyncItem_runId_outcome_idx" ON "SchoolSyncItem"("runId", "outcome");

-- CreateIndex
CREATE INDEX "SchoolSyncItem_runId_rowNumber_idx" ON "SchoolSyncItem"("runId", "rowNumber");

-- CreateIndex
CREATE INDEX "SchoolSyncItem_conflictState_idx" ON "SchoolSyncItem"("conflictState");

-- CreateIndex
CREATE INDEX "SchoolSyncItem_schoolId_idx" ON "SchoolSyncItem"("schoolId");

-- CreateIndex
CREATE INDEX "SchoolSyncItem_proposedById_idx" ON "SchoolSyncItem"("proposedById");

-- CreateIndex
CREATE INDEX "SchoolSyncItem_resolvedById_idx" ON "SchoolSyncItem"("resolvedById");

-- CreateIndex
CREATE INDEX "SchoolSyncChange_runId_kind_decision_idx" ON "SchoolSyncChange"("runId", "kind", "decision");

-- CreateIndex
CREATE INDEX "SchoolSyncChange_itemId_idx" ON "SchoolSyncChange"("itemId");

-- CreateIndex
CREATE INDEX "SchoolSyncChange_schoolId_idx" ON "SchoolSyncChange"("schoolId");

-- CreateIndex
CREATE INDEX "SchoolSyncChange_decidedById_idx" ON "SchoolSyncChange"("decidedById");

-- CreateIndex
CREATE INDEX "SchoolSourceRecord_syncRunId_idx" ON "SchoolSourceRecord"("syncRunId");

-- AddForeignKey
ALTER TABLE "SchoolSourceRecord" ADD CONSTRAINT "SchoolSourceRecord_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SchoolSyncRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncRun" ADD CONSTRAINT "SchoolSyncRun_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "SchoolDataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncRun" ADD CONSTRAINT "SchoolSyncRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncRun" ADD CONSTRAINT "SchoolSyncRun_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncRun" ADD CONSTRAINT "SchoolSyncRun_supersededByRunId_fkey" FOREIGN KEY ("supersededByRunId") REFERENCES "SchoolSyncRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncItem" ADD CONSTRAINT "SchoolSyncItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SchoolSyncRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncItem" ADD CONSTRAINT "SchoolSyncItem_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncItem" ADD CONSTRAINT "SchoolSyncItem_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncItem" ADD CONSTRAINT "SchoolSyncItem_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncItem" ADD CONSTRAINT "SchoolSyncItem_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SchoolSourceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncChange" ADD CONSTRAINT "SchoolSyncChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SchoolSyncRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncChange" ADD CONSTRAINT "SchoolSyncChange_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "SchoolSyncItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncChange" ADD CONSTRAINT "SchoolSyncChange_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSyncChange" ADD CONSTRAINT "SchoolSyncChange_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Run lifecycle. Allowed status changes: PREVIEW → APPLIED / EXPIRED / SUPERSEDED, EXPIRED →
-- SUPERSEDED. A run that is APPLIED or SUPERSEDED is final: only stagedPurgedAt may still be set.
-- An EXPIRED run may only become SUPERSEDED (with its supersession fields) or be purged.
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

CREATE TRIGGER school_sync_run_guard
  BEFORE UPDATE OR DELETE ON "SchoolSyncRun"
  FOR EACH ROW EXECUTE FUNCTION school_sync_run_guard();

-- Items and changes are permanent (decisions, outcomes, reviewers, links); only their staged
-- values are purged.
CREATE OR REPLACE FUNCTION school_sync_staging_keep() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SCHOOL_SYNC_HISTORY_PERMANENT: % rows are never deleted', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER school_sync_item_keep
  BEFORE DELETE ON "SchoolSyncItem"
  FOR EACH ROW EXECUTE FUNCTION school_sync_staging_keep();

CREATE TRIGGER school_sync_change_keep
  BEFORE DELETE ON "SchoolSyncChange"
  FOR EACH ROW EXECUTE FUNCTION school_sync_staging_keep();

COMMIT;
