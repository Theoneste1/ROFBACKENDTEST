-- Gender at every sign-up (owner, 2026-11-20). Additive only: the Gender enum and one nullable column on User,
-- MentorRequest (coach applications) and TeacherApplication. Existing rows keep NULL; nothing else changes.
-- Rollback: docs/migrations/20261221000000_registration_gender.rollback.sql.

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "gender" "Gender";

-- AlterTable
ALTER TABLE "MentorRequest" ADD COLUMN "gender" "Gender";

-- AlterTable
ALTER TABLE "TeacherApplication" ADD COLUMN "gender" "Gender";
