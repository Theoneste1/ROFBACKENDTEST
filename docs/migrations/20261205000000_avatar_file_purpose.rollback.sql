-- Rollback for 20261205000000_avatar_file_purpose (profile pictures; after 20261204000000_registration_details
-- when that is applied, otherwise after 20261203000000_student_olympiad_interests).
-- Run manually, with approval, after a backup, and after deploying the previous application release
-- (the current code reads and writes User.avatarFileId and serves /api/v1/users/{id}/avatar).
--
-- It removes what this migration created that PostgreSQL can remove: the User.avatarFileId reference
-- (column, unique index, foreign key). The FilePurpose value AVATAR is KEPT: PostgreSQL cannot drop an
-- enum value, and an unused value is harmless (the previous release never writes it).
--
-- It REFUSES, and changes nothing, while any account has a profile picture: the reference would be lost,
-- the pictures' files would become orphans (deleted by the nightly cleanup) and their avatarUrl links would
-- stop working. To discard them knowingly, after a backup that contains them, run this file in a session
-- that first sets:
--     SET rof.avatar_file_purpose_rollback = 'discard-profile-pictures';
-- With that setting the profile-picture links (avatarUrl values pointing to /api/v1/users/.../avatar) are
-- cleared too, so no account keeps a link the previous release cannot serve.
--
-- Like the other post-Phase-1 rollbacks, this file deliberately does NOT edit Prisma's migration history:
--   1. Confirm the column is gone:
--        SELECT count(*) FROM information_schema.columns
--         WHERE table_name = 'User' AND column_name = 'avatarFileId';                                  -- expect 0
--   2. Back up, then mark the migration as not applied — as its own reviewed, approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261205000000_avatar_file_purpose';
--   3. `npx prisma migrate status` must then list it as not yet applied.
-- Re-applying later works: the migration uses `ADD VALUE IF NOT EXISTS 'AVATAR'` (the value is kept by this file).
BEGIN;

DO $$
DECLARE
  pictures bigint;
BEGIN
  SELECT count(*) INTO pictures FROM "User" WHERE "avatarFileId" IS NOT NULL;
  IF pictures > 0
     AND current_setting('rof.avatar_file_purpose_rollback', true) IS DISTINCT FROM 'discard-profile-pictures' THEN
    RAISE EXCEPTION 'AVATAR_FILE_PURPOSE_ROLLBACK_REFUSED: % account(s) have a profile picture that would be lost; nothing was changed. After a backup that contains them, SET rof.avatar_file_purpose_rollback = ''discard-profile-pictures'' and run again.', pictures;
  END IF;
END $$;

UPDATE "User" SET "avatarUrl" = NULL
 WHERE "avatarUrl" LIKE '/api/v1/users/%/avatar%'
   AND current_setting('rof.avatar_file_purpose_rollback', true) = 'discard-profile-pictures';

ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_avatarFileId_fkey";
DROP INDEX IF EXISTS "User_avatarFileId_key";
ALTER TABLE "User" DROP COLUMN IF EXISTS "avatarFileId";

COMMIT;
