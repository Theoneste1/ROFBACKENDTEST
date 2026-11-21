-- Olympiad interests of students (owner decision 8): any of MATHEMATICS, COMPUTING, PHYSICS, chosen at
-- registration and editable on the profile. Additive: one column with an empty default; existing accounts
-- get no interests. Information only (no programme membership, no permissions).
-- Uses the OlympiadSubject enum created by 20261201000000_teacher_applications.
-- Rollback: docs/migrations/20261203000000_student_olympiad_interests.rollback.sql

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "olympiadInterests" "OlympiadSubject"[] DEFAULT ARRAY[]::"OlympiadSubject"[];
