-- Rollback for M11 (20261121001000_school_administration). Run manually, with approval, after a
-- backup, and after deploying the previous application release (the current code reads these
-- columns). It removes ONLY what M11 created: the five School columns, their two indexes, the
-- foreign key and the SchoolSource enum. School ids, names, codes, students, claims, enrolments
-- and Teacher assignments are untouched. Lost with the columns: which schools were deactivated,
-- each school's source, country and creator (the audit log keeps every change).
-- Schools an Administrator created stay as ordinary schools (same id, name and code).
-- Roll back M11 BEFORE M10 (docs/migrations/README.md).
--
-- This file deliberately does NOT edit Prisma's migration history (same procedure as M9/M10):
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM information_schema.columns WHERE table_name = 'School'
--          AND column_name IN ('countryCode', 'isActive', 'source', 'createdById', 'updatedAt');   -- expect 0
--        SELECT count(*) FROM pg_type WHERE typname = 'SchoolSource';                              -- expect 0
--   2. Back up, then mark M11 as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121001000_school_administration';
--   3. `npx prisma migrate status` must then list M11 as not yet applied.
-- Re-applying later is safe: M11 adds the columns again (all schools active, Rwandan) and its
-- backfill is idempotent.
BEGIN;
ALTER TABLE "School" DROP CONSTRAINT IF EXISTS "School_createdById_fkey";
DROP INDEX IF EXISTS "School_createdById_idx";
DROP INDEX IF EXISTS "School_countryCode_isActive_idx";
ALTER TABLE "School"
  DROP COLUMN IF EXISTS "countryCode",
  DROP COLUMN IF EXISTS "createdById",
  DROP COLUMN IF EXISTS "isActive",
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "updatedAt";
DROP TYPE IF EXISTS "SchoolSource";
COMMIT;
