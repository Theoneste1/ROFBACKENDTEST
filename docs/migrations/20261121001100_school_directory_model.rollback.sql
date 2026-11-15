-- Rollback for M12 (20261121001100_school_directory_model). Run manually, with approval, after a
-- backup, and after deploying the previous application release (the current code reads the new
-- tables and allows repeated names). Roll back M12 BEFORE M11 (docs/migrations/README.md).
--
-- It removes ONLY what M12 created — the directory tables, the six School columns, the enums,
-- triggers and functions — and restores the unique index on School.name. School ids, names,
-- codes, students, claims, enrolments and Teacher assignments are untouched.
--
-- It REFUSES, and changes nothing, in two cases. It never deletes, renames or merges a school to
-- make itself succeed:
--
--   1. Two or more schools share a name (allowed since M12). The unique index cannot be restored
--      while they exist. There is no override: either keep M12 (fix forward), or first resolve the
--      repeated names as a separate, reviewed, approved and audited change to the school records
--      (through the application) — never by deleting schools or relationships.
--        SELECT "name", count(*) FROM "School" GROUP BY "name" HAVING count(*) > 1;
--
--   2. Directory data exists (contacts — removed ones included —, offerings, external ids, source
--      records, programmes, or a value in a new School column) — it would be lost with the tables.
--      To discard it knowingly,
--      after a backup that contains it, run this file in a session that first sets:
--        SET rof.m12_rollback = 'discard-directory-data';
--      (EducationLevel and SchoolDataSource hold only the seeded reference rows and do not count.)
--
-- This file deliberately does NOT edit Prisma's migration history (same procedure as M9–M11):
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.tables WHERE table_name IN ('SchoolContact',
--          'SchoolEducationLevel', 'SchoolProgramme', 'Programme', 'EducationLevel',
--          'SchoolExternalId', 'SchoolSourceRecord', 'SchoolDataSource');               -- expect 0
--        SELECT count(*) FROM pg_indexes WHERE indexname = 'School_name_key';           -- expect 1
--   2. Back up, then mark M12 as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121001100_school_directory_model';
--   3. `npx prisma migrate status` must then list M12 as not yet applied.
-- Re-applying later is safe: M12 creates everything again and re-seeds the reference rows.
BEGIN;

DO $$
DECLARE
  repeated  int;
  example   text;
  directory bigint;
BEGIN
  SELECT count(*), min("name") INTO repeated, example
    FROM (SELECT "name" FROM "School" GROUP BY "name" HAVING count(*) > 1) r;
  IF repeated > 0 THEN
    RAISE EXCEPTION 'M12_ROLLBACK_REFUSED: % school names are shared by more than one school (e.g. "%"). The unique index cannot be restored; nothing was changed. Keep M12, or resolve the names first through a reviewed, audited change — never by deleting schools.', repeated, example;
  END IF;

  SELECT (SELECT count(*) FROM "SchoolContact")
       + (SELECT count(*) FROM "SchoolEducationLevel")
       + (SELECT count(*) FROM "SchoolProgramme")
       + (SELECT count(*) FROM "Programme")
       + (SELECT count(*) FROM "SchoolExternalId")
       + (SELECT count(*) FROM "SchoolSourceRecord")
       + (SELECT count(*) FROM "School"
           WHERE "cell" IS NOT NULL OR "village" IS NOT NULL OR "accommodation" IS NOT NULL
              OR "lastSourceSyncAt" IS NOT NULL OR "lastVerifiedAt" IS NOT NULL OR "lastVerifiedById" IS NOT NULL)
    INTO directory;
  IF directory > 0 AND current_setting('rof.m12_rollback', true) IS DISTINCT FROM 'discard-directory-data' THEN
    RAISE EXCEPTION 'M12_ROLLBACK_REFUSED: % directory rows / values would be lost; nothing was changed. After a backup that contains them, SET rof.m12_rollback = ''discard-directory-data'' and run again.', directory;
  END IF;
END $$;

DROP TRIGGER IF EXISTS school_contact_keep ON "SchoolContact";
DROP TRIGGER IF EXISTS school_source_record_immutable ON "SchoolSourceRecord";
DROP TRIGGER IF EXISTS school_external_id_keep ON "SchoolExternalId";
DROP FUNCTION IF EXISTS school_contact_keep();
DROP FUNCTION IF EXISTS school_source_record_immutable();
DROP FUNCTION IF EXISTS school_external_id_keep();

DROP TABLE IF EXISTS "SchoolProgramme";
DROP TABLE IF EXISTS "SchoolEducationLevel";
DROP TABLE IF EXISTS "SchoolContact";
DROP TABLE IF EXISTS "SchoolExternalId";
DROP TABLE IF EXISTS "SchoolSourceRecord";
DROP TABLE IF EXISTS "Programme";
DROP TABLE IF EXISTS "EducationLevel";
DROP TABLE IF EXISTS "SchoolDataSource";

ALTER TABLE "School" DROP CONSTRAINT IF EXISTS "School_lastVerifiedById_fkey";
DROP INDEX IF EXISTS "School_lastVerifiedById_idx";
ALTER TABLE "School"
  DROP COLUMN IF EXISTS "accommodation",
  DROP COLUMN IF EXISTS "cell",
  DROP COLUMN IF EXISTS "lastSourceSyncAt",
  DROP COLUMN IF EXISTS "lastVerifiedAt",
  DROP COLUMN IF EXISTS "lastVerifiedById",
  DROP COLUMN IF EXISTS "village";

DROP TYPE IF EXISTS "SchoolAccommodation";
DROP TYPE IF EXISTS "SchoolContactType";
DROP TYPE IF EXISTS "SchoolContactVisibility";
DROP TYPE IF EXISTS "ProgrammeCategory";
DROP TYPE IF EXISTS "SchoolExternalIdKind";

DROP INDEX IF EXISTS "School_name_idx";
CREATE UNIQUE INDEX "School_name_key" ON "School"("name");

COMMIT;
