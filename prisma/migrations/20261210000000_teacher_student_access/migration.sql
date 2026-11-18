-- Teacher–student access (2026-11-18; owner approvals TS-1…TS-6; docs/TEACHER-STUDENT-ACCESS-PLAN.md).
-- Additive: the TeacherStudentAssignment and UserPermissionOverrideStudent tables, and three nullable columns on
-- UserPermissionOverride (studentScope, reviewNeededAt, reviewReason).
-- Data: every existing teacher delegation GRANT (students.viewProfile, students.viewProgress,
-- submissions.submitOnBehalf) gets studentScope = 'SCHOOL' — exactly today's behaviour (every student the teacher sees
-- through their schools). No other row changes.
-- Database rules the Prisma schema cannot express (documented on the models):
--   * a teacher is never assigned to themselves;
--   * a cross-school assignment carries a reason (TS-3);
--   * an ended assignment has endedAt, an active one has none;
--   * studentScope is set only on teacher delegation GRANTs (NULL there means SCHOOL — a row written by a release
--     without scopes, e.g. during the deploy, keeps today's meaning; existing rows are set to SCHOOL below).
-- Explicit transaction: everything is created together or not at all.
-- Rollback: docs/migrations/20261210000000_teacher_student_access.rollback.sql
BEGIN;
-- CreateEnum
CREATE TYPE "TeacherStudentSource" AS ENUM ('ADMIN', 'BULK');

-- CreateEnum
CREATE TYPE "DelegationStudentScope" AS ENUM ('SCHOOL', 'ASSIGNED', 'SELECTED');

-- AlterTable
ALTER TABLE "UserPermissionOverride" ADD COLUMN     "reviewNeededAt" TIMESTAMP(3),
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "studentScope" "DelegationStudentScope";

-- CreateTable
CREATE TABLE "TeacherStudentAssignment" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "source" "TeacherStudentSource" NOT NULL DEFAULT 'ADMIN',
    "crossSchool" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" TEXT,

    CONSTRAINT "TeacherStudentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPermissionOverrideStudent" (
    "id" TEXT NOT NULL,
    "overrideId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "removeReason" TEXT,

    CONSTRAINT "UserPermissionOverrideStudent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherStudentAssignment_studentId_isActive_idx" ON "TeacherStudentAssignment"("studentId", "isActive");

-- CreateIndex
CREATE INDEX "TeacherStudentAssignment_teacherId_isActive_idx" ON "TeacherStudentAssignment"("teacherId", "isActive");

-- CreateIndex
CREATE INDEX "TeacherStudentAssignment_assignedById_idx" ON "TeacherStudentAssignment"("assignedById");

-- CreateIndex
CREATE INDEX "TeacherStudentAssignment_endedById_idx" ON "TeacherStudentAssignment"("endedById");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherStudentAssignment_teacherId_studentId_key" ON "TeacherStudentAssignment"("teacherId", "studentId");

-- CreateIndex
CREATE INDEX "UserPermissionOverrideStudent_studentId_idx" ON "UserPermissionOverrideStudent"("studentId");

-- CreateIndex
CREATE INDEX "UserPermissionOverrideStudent_addedById_idx" ON "UserPermissionOverrideStudent"("addedById");

-- CreateIndex
CREATE INDEX "UserPermissionOverrideStudent_removedById_idx" ON "UserPermissionOverrideStudent"("removedById");

-- CreateIndex
CREATE UNIQUE INDEX "UserPermissionOverrideStudent_overrideId_studentId_key" ON "UserPermissionOverrideStudent"("overrideId", "studentId");

-- AddForeignKey
ALTER TABLE "TeacherStudentAssignment" ADD CONSTRAINT "TeacherStudentAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherStudentAssignment" ADD CONSTRAINT "TeacherStudentAssignment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherStudentAssignment" ADD CONSTRAINT "TeacherStudentAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherStudentAssignment" ADD CONSTRAINT "TeacherStudentAssignment_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverrideStudent" ADD CONSTRAINT "UserPermissionOverrideStudent_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "UserPermissionOverride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverrideStudent" ADD CONSTRAINT "UserPermissionOverrideStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverrideStudent" ADD CONSTRAINT "UserPermissionOverrideStudent_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverrideStudent" ADD CONSTRAINT "UserPermissionOverrideStudent_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing teacher delegations keep their behaviour.
UPDATE "UserPermissionOverride" SET "studentScope" = 'SCHOOL'
WHERE "effect" = 'GRANT' AND "permission" IN ('students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf');

ALTER TABLE "TeacherStudentAssignment"
  ADD CONSTRAINT "TeacherStudentAssignment_not_self" CHECK ("teacherId" <> "studentId"),
  ADD CONSTRAINT "TeacherStudentAssignment_cross_school_reason" CHECK (NOT "crossSchool" OR length(btrim(coalesce("reason", ''))) >= 5),
  ADD CONSTRAINT "TeacherStudentAssignment_ended" CHECK ("isActive" = ("endedAt" IS NULL));

ALTER TABLE "UserPermissionOverride"
  ADD CONSTRAINT "UserPermissionOverride_student_scope" CHECK (
    "studentScope" IS NULL OR ("effect" = 'GRANT' AND "permission" IN ('students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf'))
  );

COMMIT;
