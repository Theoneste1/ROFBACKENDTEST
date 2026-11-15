-- M6 (Phase 1, P1-11): teacher school assignments (owner decision 2026-11-10: school-based teacher scope).
-- Additive only: one table; no existing table, column or row changes.
-- Explicit transaction: everything is created together or not at all.
-- Rollback: docs/migrations/20261121000500_teacher_school_assignment.rollback.sql

BEGIN;

-- CreateTable
CREATE TABLE "TeacherSchoolAssignment" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,

    CONSTRAINT "TeacherSchoolAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherSchoolAssignment_schoolId_isActive_idx" ON "TeacherSchoolAssignment"("schoolId", "isActive");

-- CreateIndex
CREATE INDEX "TeacherSchoolAssignment_assignedById_idx" ON "TeacherSchoolAssignment"("assignedById");

-- CreateIndex
CREATE INDEX "TeacherSchoolAssignment_endedById_idx" ON "TeacherSchoolAssignment"("endedById");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherSchoolAssignment_teacherId_schoolId_key" ON "TeacherSchoolAssignment"("teacherId", "schoolId");

-- AddForeignKey
ALTER TABLE "TeacherSchoolAssignment" ADD CONSTRAINT "TeacherSchoolAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSchoolAssignment" ADD CONSTRAINT "TeacherSchoolAssignment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSchoolAssignment" ADD CONSTRAINT "TeacherSchoolAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherSchoolAssignment" ADD CONSTRAINT "TeacherSchoolAssignment_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


COMMIT;
