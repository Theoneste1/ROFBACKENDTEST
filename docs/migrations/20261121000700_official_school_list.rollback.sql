-- Rollback for M8 (20261121000700_official_school_list). Run manually, with approval,
-- BEFORE the M7 rollback.
--   1. Deletes the official schools M8 INSERTED that nothing references yet (no student,
--      enrolment or teacher assignment). Official schools already in use are kept.
--   2. Schools that existed before M8 and ADOPTED a code keep their row, name and
--      students; only their official-list fields are cleared.
-- "Before M8" = created earlier than M8's OFFICIAL_SCHOOL_LIST_LOADED audit entry.
BEGIN;
DELETE FROM "School" s
 WHERE s."code" IS NOT NULL
   AND s."createdAt" >= (SELECT min("createdAt") FROM "AuditLog" WHERE "action" = 'OFFICIAL_SCHOOL_LIST_LOADED')
   AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."schoolId" = s."id")
   AND NOT EXISTS (SELECT 1 FROM "StudentEnrollment" e WHERE e."schoolId" = s."id")
   AND NOT EXISTS (SELECT 1 FROM "TeacherSchoolAssignment" t WHERE t."schoolId" = s."id");
UPDATE "School" SET "code" = NULL, "province" = NULL, "district" = NULL, "sector" = NULL, "ownership" = NULL, "nameKey" = NULL
 WHERE "code" IS NOT NULL
   AND "createdAt" < (SELECT min("createdAt") FROM "AuditLog" WHERE "action" = 'OFFICIAL_SCHOOL_LIST_LOADED');
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000700_official_school_list';
COMMIT;
