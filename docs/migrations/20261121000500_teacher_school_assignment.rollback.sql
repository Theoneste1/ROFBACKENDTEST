-- Rollback for M6 (20261121000500_teacher_school_assignment). Run manually, with approval.
-- Drops the teacher school assignments: teachers lose their school scope (the audit log keeps
-- the history). Nothing else is touched.
BEGIN;
DROP TABLE "TeacherSchoolAssignment";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121000500_teacher_school_assignment';
COMMIT;
