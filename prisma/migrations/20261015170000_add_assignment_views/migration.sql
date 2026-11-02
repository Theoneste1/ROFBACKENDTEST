-- Migration: add_assignment_views
--
-- Creates the AssignmentView table: one row per (student × assignment).
-- Used to derive the student-facing "New" and "Opened" display statuses.
-- firstViewedAt is recorded when the student opens the assignment for the first time.

CREATE TABLE IF NOT EXISTS "AssignmentView" (
    "id"           TEXT         NOT NULL,
    "assignmentId" TEXT         NOT NULL,
    "studentId"    TEXT         NOT NULL,
    "firstViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewCount"    INTEGER      NOT NULL DEFAULT 1,

    CONSTRAINT "AssignmentView_pkey" PRIMARY KEY ("id")
);

-- Each student can have at most one view record per assignment.
CREATE UNIQUE INDEX IF NOT EXISTS "AssignmentView_assignmentId_studentId_key"
    ON "AssignmentView"("assignmentId", "studentId");

CREATE INDEX IF NOT EXISTS "AssignmentView_studentId_idx"    ON "AssignmentView"("studentId");
CREATE INDEX IF NOT EXISTS "AssignmentView_assignmentId_idx" ON "AssignmentView"("assignmentId");

ALTER TABLE "AssignmentView"
    ADD CONSTRAINT "AssignmentView_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssignmentView"
    ADD CONSTRAINT "AssignmentView_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
