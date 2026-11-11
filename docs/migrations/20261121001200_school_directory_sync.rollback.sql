-- Rollback for M13 (20261121001200_school_directory_sync). Run manually, with approval, after a
-- backup, and after deploying the previous application release (the current code reads the sync
-- tables). Roll back M13 BEFORE M12 (docs/migrations/README.md).
--
-- It removes ONLY what M13 created: the three sync tables (runs, items, changes), their enums,
-- triggers and functions, and SchoolSourceRecord.syncRunId. It never deletes or changes a school,
-- contact, education level, programme, external id or source record, and it does not undo
-- anything a sync applied (applied data stays in the directory tables; every applied change is in
-- the audit log).
--
-- It REFUSES, and changes nothing, while any sync run exists: their summaries, decisions and
-- reviewers would be lost (and source records would lose their run link). To discard that sync
-- history knowingly, after a backup that contains it, run this file in a session that first sets:
--     SET rof.m13_rollback = 'discard-sync-history';
--
-- This file deliberately does NOT edit Prisma's migration history (same procedure as M9–M12):
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.tables
--         WHERE table_name IN ('SchoolSyncRun', 'SchoolSyncItem', 'SchoolSyncChange');           -- expect 0
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'SchoolSourceRecord' AND column_name = 'syncRunId';                  -- expect 0
--   2. Back up, then mark M13 as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121001200_school_directory_sync';
--   3. `npx prisma migrate status` must then list M13 as not yet applied.
-- Re-applying later is safe: M13 creates everything again (empty).
BEGIN;

DO $$
DECLARE
  runs bigint;
BEGIN
  SELECT count(*) INTO runs FROM "SchoolSyncRun";
  IF runs > 0 AND current_setting('rof.m13_rollback', true) IS DISTINCT FROM 'discard-sync-history' THEN
    RAISE EXCEPTION 'M13_ROLLBACK_REFUSED: % sync runs (with their items, changes and decisions) would be lost; nothing was changed. After a backup that contains them, SET rof.m13_rollback = ''discard-sync-history'' and run again. Schools, contacts and source records are never touched.', runs;
  END IF;
END $$;

DROP TRIGGER IF EXISTS school_sync_run_guard ON "SchoolSyncRun";
DROP TRIGGER IF EXISTS school_sync_item_keep ON "SchoolSyncItem";
DROP TRIGGER IF EXISTS school_sync_change_keep ON "SchoolSyncChange";
DROP FUNCTION IF EXISTS school_sync_run_guard();
DROP FUNCTION IF EXISTS school_sync_staging_keep();

ALTER TABLE "SchoolSourceRecord" DROP CONSTRAINT IF EXISTS "SchoolSourceRecord_syncRunId_fkey";
DROP INDEX IF EXISTS "SchoolSourceRecord_syncRunId_idx";
ALTER TABLE "SchoolSourceRecord" DROP COLUMN IF EXISTS "syncRunId";

DROP TABLE IF EXISTS "SchoolSyncChange";
DROP TABLE IF EXISTS "SchoolSyncItem";
DROP TABLE IF EXISTS "SchoolSyncRun";

DROP TYPE IF EXISTS "SchoolSyncRunStatus";
DROP TYPE IF EXISTS "SchoolSyncItemOutcome";
DROP TYPE IF EXISTS "SchoolSyncChangeKind";
DROP TYPE IF EXISTS "SchoolSyncDecision";
DROP TYPE IF EXISTS "SchoolSyncConflictState";

COMMIT;
