-- Registration details (capabilities studentRegistrationDetails and coachApplicationDetails).
-- Additive only: one enum and nullable columns (olympiadInterests of coach applications defaults to
-- an empty array). Existing accounts and applications get NULL / no values; nothing is backfilled.
-- User: a student's date of birth, close-family phone and official home place (Rwanda); User.phone
-- and User.country already exist (20261201000000_teacher_applications).
-- MentorRequest: a coach applicant's country, occupation, education level and Olympiad interests.
-- Uses the OlympiadSubject enum created by 20261201000000_teacher_applications.
-- Rollback: docs/migrations/20261204000000_registration_details.rollback.sql
-- CreateEnum
CREATE TYPE "CoachEducationLevel" AS ENUM ('SECONDARY', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE', 'OTHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dateOfBirth" DATE,
ADD COLUMN     "guardianPhone" TEXT,
ADD COLUMN     "homeDistrict" TEXT,
ADD COLUMN     "homeProvince" TEXT,
ADD COLUMN     "homeSector" TEXT;

-- AlterTable
ALTER TABLE "MentorRequest" ADD COLUMN     "country" TEXT,
ADD COLUMN     "educationLevel" "CoachEducationLevel",
ADD COLUMN     "occupation" TEXT,
ADD COLUMN     "olympiadInterests" "OlympiadSubject"[] DEFAULT ARRAY[]::"OlympiadSubject"[];

