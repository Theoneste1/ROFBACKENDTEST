-- Primary teacher of a school (owner decision 2026-11-19). Additive: the TeacherSchoolRole enum, one column on
-- TeacherSchoolAssignment (role, default SECONDARY) and a partial unique index — at most ONE active PRIMARY link per
-- school, enforced by the database. The primary teacher is the school's designated main contact only: no permission,
-- no account state and no access changes with it.
--
-- Existing links: per school, the EARLIEST active link (createdAt, then id) whose teacher account is ACTIVE becomes
-- PRIMARY; every other link stays SECONDARY. No link is created, ended or removed, and nothing else changes. A school
-- whose active links all belong to accounts that are not ACTIVE (deactivated, suspended, archived) gets no primary —
-- the same rule the application applies when an account leaves ACTIVE (never a primary on an inactive account).
-- Rollback: docs/migrations/20261212000000_teacher_school_primary.rollback.sql.

-- CreateEnum
CREATE TYPE "TeacherSchoolRole" AS ENUM ('PRIMARY', 'SECONDARY');

-- AlterTable
ALTER TABLE "TeacherSchoolAssignment" ADD COLUMN     "role" "TeacherSchoolRole" NOT NULL DEFAULT 'SECONDARY';

-- Backfill: the earliest active link of an ACTIVE account per school (deterministic: createdAt, then id).
UPDATE "TeacherSchoolAssignment" a
   SET "role" = 'PRIMARY'
  FROM (
    SELECT DISTINCT ON (t."schoolId") t."id"
      FROM "TeacherSchoolAssignment" t
      JOIN "User" u ON u."id" = t."teacherId"
     WHERE t."isActive" AND u."accountStatus" = 'ACTIVE'
     ORDER BY t."schoolId", t."createdAt", t."id"
  ) f
 WHERE a."id" = f."id";

-- At most one ACTIVE PRIMARY per school (concurrent approvals or reassignments can never create two).
CREATE UNIQUE INDEX "TeacherSchoolAssignment_one_primary_per_school" ON "TeacherSchoolAssignment"("schoolId") WHERE "isActive" AND "role" = 'PRIMARY';
