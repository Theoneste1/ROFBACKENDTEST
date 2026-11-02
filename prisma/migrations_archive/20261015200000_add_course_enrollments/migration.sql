-- Migration: add_course_enrollments
--
-- Adds CourseEnrollmentStatus enum and CourseEnrollment table.
-- One row per (student × course) pair tracks the student-facing status:
--   UNROLLED → ROLLED → COMPLETED  (one-directional; never regresses).

-- ─── 1. Enum ──────────────────────────────────────────────────────────────────
CREATE TYPE "CourseEnrollmentStatus" AS ENUM (
  'UNROLLED',
  'ROLLED',
  'COMPLETED'
);

-- ─── 2. CourseEnrollment table ────────────────────────────────────────────────
CREATE TABLE "CourseEnrollment" (
    "id"            TEXT                     NOT NULL,
    "courseId"      TEXT                     NOT NULL,
    "studentId"     TEXT                     NOT NULL,
    "status"        "CourseEnrollmentStatus" NOT NULL DEFAULT 'UNROLLED',
    "firstOpenedAt" TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt"  TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"   TIMESTAMP(3),

    CONSTRAINT "CourseEnrollment_pkey" PRIMARY KEY ("id")
);

-- One enrollment record per student per course.
CREATE UNIQUE INDEX "CourseEnrollment_courseId_studentId_key"
    ON "CourseEnrollment"("courseId", "studentId");

CREATE INDEX "CourseEnrollment_studentId_idx" ON "CourseEnrollment"("studentId");
CREATE INDEX "CourseEnrollment_courseId_idx"  ON "CourseEnrollment"("courseId");
CREATE INDEX "CourseEnrollment_status_idx"    ON "CourseEnrollment"("status");

-- ─── 3. Foreign keys ──────────────────────────────────────────────────────────
ALTER TABLE "CourseEnrollment"
    ADD CONSTRAINT "CourseEnrollment_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseEnrollment"
    ADD CONSTRAINT "CourseEnrollment_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
