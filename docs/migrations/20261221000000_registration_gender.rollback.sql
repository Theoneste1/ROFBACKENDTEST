-- Rollback for 20261221000000_registration_gender (gender at sign-up; owner, 2026-11-20).
-- Run manually, with approval, after a backup, and after deploying the previous application release (the current code
-- reads and writes the gender columns).
--
-- It drops the three gender columns and the Gender enum: every gender given since the release is LOST (keep the backup).
-- Nothing else changes.
--
-- Like the other rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the columns are gone:
--        SELECT count(*) FROM information_schema.columns WHERE column_name = 'gender'
--           AND table_name IN ('User', 'MentorRequest', 'TeacherApplication');                      -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261221000000_registration_gender';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;
ALTER TABLE "TeacherApplication" DROP COLUMN IF EXISTS "gender";
ALTER TABLE "MentorRequest" DROP COLUMN IF EXISTS "gender";
ALTER TABLE "User" DROP COLUMN IF EXISTS "gender";
DROP TYPE IF EXISTS "Gender";
COMMIT;
