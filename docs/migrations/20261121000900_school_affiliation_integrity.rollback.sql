-- Rollback for M10 (20261121000900_school_affiliation_integrity). Run manually, with approval,
-- after a backup. It removes ONLY what M10 created: two triggers and their function. No table,
-- column or row is touched; the application keeps maintaining the invariants itself.
-- Roll back M10 BEFORE M9 (docs/migrations/README.md).
--
-- This file deliberately does NOT edit Prisma's migration history (same procedure as M9):
--   1. Confirm the objects are gone:
--        SELECT count(*) FROM pg_trigger WHERE tgname IN ('school_affiliation_integrity', 'user_school_affiliation_integrity');  -- expect 0
--        SELECT to_regproc('school_affiliation_integrity');                                                                       -- expect NULL
--   2. Back up, then mark M10 as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000900_school_affiliation_integrity';
--   3. `npx prisma migrate status` must then list M10 as not yet applied.
-- Re-applying later is safe: M10's pre-check runs again first.
BEGIN;
DROP TRIGGER IF EXISTS user_school_affiliation_integrity ON "User";
DROP TRIGGER IF EXISTS school_affiliation_integrity ON "StudentSchoolAffiliation";
DROP FUNCTION IF EXISTS school_affiliation_integrity();
COMMIT;
