-- Rollback for 20261209000000_application_details. Run manually, with approval, after a backup, and after deploying
-- the previous application release (which neither reads nor writes these columns or the table).
--
-- It REFUSES, and changes nothing, while data would be lost: any information request, any application holding a
-- position, years of experience, phone, affiliation, expertise or relevant experience, or several coach application
-- attempts sharing a username or e-mail (the previous release needs both unique across all rows). In discard mode the
-- OLDER REJECTED attempts sharing a username or e-mail are deleted (the newest attempt of each identity is kept). To discard them knowingly,
-- after a backup that contains them, run this file in a session that first sets:
--     SET rof.application_details_rollback = 'discard-application-details';
--
-- Like the other post-Phase-1 rollbacks, it does NOT edit Prisma's migration history:
--   1. Confirm the table is gone:  SELECT to_regclass('"ApplicationInfoRequest"');   -- expect NULL
--   2. Back up, then, as its own reviewed and approved step:
--        DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261209000000_application_details';
--   3. `npx prisma migrate status` must then list it as not yet applied.
BEGIN;
DO $$
DECLARE
  requests bigint;
  details  bigint;
  attempts bigint;
BEGIN
  SELECT count(*) INTO requests FROM "ApplicationInfoRequest";
  SELECT (SELECT count(*) FROM "TeacherApplication" WHERE "position" IS NOT NULL OR "yearsOfExperience" IS NOT NULL OR "avatarFileId" IS NOT NULL)
       + (SELECT count(*) FROM "MentorRequest" WHERE "phone" IS NOT NULL OR "affiliation" IS NOT NULL OR "expertise" IS NOT NULL
                                                  OR "relevantExperience" IS NOT NULL OR "yearsOfExperience" IS NOT NULL OR "rejectionReason" IS NOT NULL
                                                  OR "avatarFileId" IS NOT NULL)
    INTO details;
  SELECT count(*) INTO attempts FROM "MentorRequest" a
   WHERE EXISTS (SELECT 1 FROM "MentorRequest" b WHERE b."id" <> a."id" AND (b."username" = a."username" OR b."email" = a."email"));
  IF (requests > 0 OR details > 0 OR attempts > 0)
     AND current_setting('rof.application_details_rollback', true) IS DISTINCT FROM 'discard-application-details' THEN
    RAISE EXCEPTION 'APPLICATION_DETAILS_ROLLBACK_REFUSED: % information request(s), % application(s) with details and % coach application attempt(s) sharing a username or e-mail would be lost; nothing was changed. After a backup that contains them, SET rof.application_details_rollback = ''discard-application-details'' and run again.', requests, details;
  END IF;
END $$;
DROP TABLE IF EXISTS "ApplicationInfoRequest";
-- Older REJECTED attempts sharing a username or e-mail with a newer attempt (discard mode only; refused above otherwise).
DELETE FROM "MentorRequest" a
 WHERE a."status" = 'REJECTED'
   AND EXISTS (SELECT 1 FROM "MentorRequest" b WHERE b."id" <> a."id" AND (b."username" = a."username" OR b."email" = a."email")
                AND (b."status" <> 'REJECTED' OR b."createdAt" > a."createdAt" OR (b."createdAt" = a."createdAt" AND b."id" > a."id")));
DROP INDEX IF EXISTS "MentorRequest_active_username_key";
DROP INDEX IF EXISTS "MentorRequest_active_email_key";
DROP INDEX IF EXISTS "MentorRequest_username_idx";
DROP INDEX IF EXISTS "MentorRequest_email_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "MentorRequest_username_key" ON "MentorRequest"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "MentorRequest_email_key" ON "MentorRequest"("email");
ALTER TABLE "MentorRequest" DROP CONSTRAINT IF EXISTS "MentorRequest_yearsOfExperience_check";
ALTER TABLE "MentorRequest" DROP CONSTRAINT IF EXISTS "MentorRequest_avatarFileId_fkey";
ALTER TABLE "TeacherApplication" DROP CONSTRAINT IF EXISTS "TeacherApplication_avatarFileId_fkey";
ALTER TABLE "MentorRequest" DROP COLUMN IF EXISTS "avatarFileId";
ALTER TABLE "TeacherApplication" DROP COLUMN IF EXISTS "avatarFileId";
ALTER TABLE "MentorRequest" DROP COLUMN IF EXISTS "phone", DROP COLUMN IF EXISTS "affiliation", DROP COLUMN IF EXISTS "expertise",
  DROP COLUMN IF EXISTS "relevantExperience", DROP COLUMN IF EXISTS "yearsOfExperience", DROP COLUMN IF EXISTS "rejectionReason";
ALTER TABLE "TeacherApplication" DROP CONSTRAINT IF EXISTS "TeacherApplication_yearsOfExperience_check";
ALTER TABLE "TeacherApplication" DROP COLUMN IF EXISTS "position", DROP COLUMN IF EXISTS "yearsOfExperience";
COMMIT;
