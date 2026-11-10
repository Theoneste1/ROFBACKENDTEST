-- Rollback for M2 (20261121000100_programme_membership). Roll back M3 first.
-- Drops the membership table and its enum (all memberships are lost, including
-- MANUAL ones). Nothing else is touched. Run manually, with approval.
BEGIN;
DROP TABLE "ProgrammeMembership";
DROP TYPE "MembershipSource";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000100_programme_membership';
COMMIT;
