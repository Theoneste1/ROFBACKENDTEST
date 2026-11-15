-- Rollback for M9 (20261121000800_student_school_affiliation). Run manually, with approval,
-- after a backup. It removes ONLY what M9 created: the affiliation table (every claim and
-- decision in it is lost; the audit log keeps their history) and its two enums. No user,
-- school, enrolment or submission row is touched. Teacher views then show no student until
-- the code that requires a verified affiliation is also rolled back (deploy the previous
-- release first, then run this file).
--
-- This file deliberately does NOT edit Prisma's migration history. Reconcile it separately,
-- only after this rollback has committed and been verified:
--   1. Confirm the objects are gone:
--        SELECT to_regclass('"StudentSchoolAffiliation"');                       -- expect NULL
--        SELECT count(*) FROM pg_type WHERE typname IN ('SchoolAffiliationStatus', 'SchoolAffiliationSource');  -- expect 0
--   2. Back up, then mark M9 as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000800_student_school_affiliation';
--      (`prisma migrate resolve --rolled-back` only applies to FAILED migrations; M9 applied
--      successfully, so its history row is removed explicitly.)
--   3. `npx prisma migrate status` must then list M9 as not yet applied, and
--      `npx prisma migrate diff --from-config-datasource --to-schema <previous schema> --exit-code`
--      must report no difference against the previous release's schema.
-- Re-applying later is safe: M9 creates the objects again and its backfill is idempotent.
BEGIN;
DROP TABLE "StudentSchoolAffiliation";
DROP TYPE "SchoolAffiliationSource";
DROP TYPE "SchoolAffiliationStatus";
COMMIT;
