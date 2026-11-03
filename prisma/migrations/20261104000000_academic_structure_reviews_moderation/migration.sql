-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: academic_structure_reviews_moderation          (EXPAND phase)
--
-- Purely additive and data-preserving. Nothing is dropped except:
--   • the unique index on Course.code (replaced by a unique (disciplineId, code))
--   • the CourseCode enum TYPE, after Course.code is converted to TEXT in place
--     (ALTER … USING code::text — every value is kept)
--   • the old Comment CHECK constraint (comments now belong to a thread)
--
-- New: Discipline, AcademicYear, StudentEnrollment, attachment tables,
-- MentorReview (+ events, attachments), DistributionBatch, ResultRelease,
-- DiscussionThread, ContentReport, ModerationAction, ActivityLog.
--
-- Existing data is backfilled into the new tables (see BACKFILL below).
-- The superseded columns are left in place and unused; dropping them is a
-- separate CONTRACT migration in prisma/pending-migrations/ that must be
-- approved before it is applied.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "AcademicYearStatus" AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "StudentEnrollmentStatus" AS ENUM ('ACTIVE', 'PROMOTED', 'GRADUATED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DistributionStrategy" AS ENUM ('BALANCED', 'ROUND_ROBIN', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'MARKED', 'RETURNED', 'APPROVED', 'SENT_BACK', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewEventType" AS ENUM ('ASSIGNED', 'STARTED', 'MARKED', 'RETURNED', 'APPROVED', 'SENT_BACK', 'PUBLISHED', 'REOPENED', 'REASSIGNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('OPEN', 'LOCKED', 'HIDDEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'ABUSE', 'INAPPROPRIATE', 'OFF_TOPIC', 'ACADEMIC_DISHONESTY', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ModerationActionType" AS ENUM ('HIDE_COMMENT', 'RESTORE_COMMENT', 'DELETE_COMMENT', 'HIDE_THREAD', 'RESTORE_THREAD', 'LOCK_THREAD', 'UNLOCK_THREAD', 'PIN_THREAD', 'UNPIN_THREAD', 'ARCHIVE_THREAD', 'DISMISS_REPORT');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('LOGIN', 'COURSE_OPENED', 'COURSE_COMPLETED', 'RESOURCE_VIEWED', 'ASSIGNMENT_VIEWED', 'SUBMISSION_CREATED', 'SUBMISSION_RESUBMITTED', 'RESULT_VIEWED', 'THREAD_CREATED', 'COMMENT_POSTED', 'LIVE_SESSION_OPENED');

-- AlterEnum
ALTER TYPE "AssignmentStatus" ADD VALUE 'ARCHIVED';

-- AlterEnum
ALTER TYPE "CourseStatus" ADD VALUE 'ARCHIVED';

-- DropForeignKey (re-created below with ON DELETE SET NULL; column becomes optional)
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_divisionId_fkey";

-- Comments now belong to a thread; the old single-target CHECK no longer applies.
ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "Comment_single_target_check";

-- Course: enum code → text, IN PLACE (no data loss); discipline added nullable then backfilled.
DROP INDEX "Course_code_key";
ALTER TABLE "Course" ALTER COLUMN "code" TYPE TEXT USING "code"::text;
ALTER TABLE "Course" ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "disciplineId" TEXT;
DROP TYPE "CourseCode";

-- New columns on populated tables are added NULLABLE, backfilled, then enforced.
ALTER TABLE "Assignment" ADD COLUMN "academicYearId" TEXT,
ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "Comment" ADD COLUMN "editedAt" TIMESTAMP(3),
ADD COLUMN "threadId" TEXT,
ALTER COLUMN "divisionId" DROP NOT NULL;

ALTER TABLE "CourseResource" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "LiveSession" ADD COLUMN "academicYearId" TEXT;

ALTER TABLE "Submission" ADD COLUMN "currentReviewId" TEXT,
ADD COLUMN "publishedReviewId" TEXT,
ADD COLUMN "resultReleaseId" TEXT;

-- CreateTable
CREATE TABLE "Discipline" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discipline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicYear" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" "AcademicYearStatus" NOT NULL DEFAULT 'PLANNED',
    "isCurrent" BOOLEAN,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "gradeLevel" "GradeLevel" NOT NULL,
    "schoolId" TEXT,
    "status" "StudentEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "StudentEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceAttachment" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentAttachment" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAttachment" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionBatch" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "strategy" "DistributionStrategy" NOT NULL,
    "assignedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorReview" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "mentorId" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'ASSIGNED',
    "score" INTEGER,
    "percentage" DOUBLE PRECISION,
    "feedback" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "distributionBatchId" TEXT,
    "startedAt" TIMESTAMP(3),
    "markedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "coordinationNote" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewAttachment" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewEvent" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "type" "ReviewEventType" NOT NULL,
    "actorId" TEXT,
    "score" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResultRelease" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "publishedById" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "note" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscussionThread" (
    "id" TEXT NOT NULL,
    "courseId" TEXT,
    "assignmentId" TEXT,
    "divisionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ThreadStatus" NOT NULL DEFAULT 'OPEN',
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscussionThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "threadId" TEXT,
    "commentId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "action" "ModerationActionType" NOT NULL,
    "threadId" TEXT,
    "commentId" TEXT,
    "reportId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "courseId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Discipline_code_key" ON "Discipline"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicYear_name_key" ON "AcademicYear"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicYear_isCurrent_key" ON "AcademicYear"("isCurrent");

-- CreateIndex
CREATE INDEX "AcademicYear_status_idx" ON "AcademicYear"("status");

-- CreateIndex
CREATE INDEX "StudentEnrollment_academicYearId_divisionId_status_idx" ON "StudentEnrollment"("academicYearId", "divisionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StudentEnrollment_studentId_academicYearId_key" ON "StudentEnrollment"("studentId", "academicYearId");

-- CreateIndex
CREATE INDEX "ResourceAttachment_fileId_idx" ON "ResourceAttachment"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceAttachment_resourceId_fileId_key" ON "ResourceAttachment"("resourceId", "fileId");

-- CreateIndex
CREATE INDEX "AssignmentAttachment_fileId_idx" ON "AssignmentAttachment"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentAttachment_assignmentId_fileId_key" ON "AssignmentAttachment"("assignmentId", "fileId");

-- CreateIndex
CREATE INDEX "SubmissionAttachment_fileId_idx" ON "SubmissionAttachment"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttachment_revisionId_fileId_key" ON "SubmissionAttachment"("revisionId", "fileId");

-- CreateIndex
CREATE INDEX "DistributionBatch_assignmentId_idx" ON "DistributionBatch"("assignmentId");

-- CreateIndex
CREATE INDEX "MentorReview_mentorId_status_idx" ON "MentorReview"("mentorId", "status");

-- CreateIndex
CREATE INDEX "MentorReview_distributionBatchId_idx" ON "MentorReview"("distributionBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "MentorReview_submissionId_cycle_key" ON "MentorReview"("submissionId", "cycle");

-- CreateIndex
CREATE INDEX "ReviewAttachment_fileId_idx" ON "ReviewAttachment"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewAttachment_reviewId_fileId_key" ON "ReviewAttachment"("reviewId", "fileId");

-- CreateIndex
CREATE INDEX "ReviewEvent_reviewId_createdAt_idx" ON "ReviewEvent"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "ResultRelease_assignmentId_idx" ON "ResultRelease"("assignmentId");

-- CreateIndex
CREATE INDEX "DiscussionThread_courseId_divisionId_status_lastActivityAt_idx" ON "DiscussionThread"("courseId", "divisionId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "DiscussionThread_assignmentId_status_idx" ON "DiscussionThread"("assignmentId", "status");

-- CreateIndex
CREATE INDEX "DiscussionThread_createdById_idx" ON "DiscussionThread"("createdById");

-- CreateIndex
CREATE INDEX "ContentReport_status_createdAt_idx" ON "ContentReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_commentId_idx" ON "ContentReport"("commentId");

-- CreateIndex
CREATE INDEX "ContentReport_threadId_idx" ON "ContentReport"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentReport_reporterId_threadId_key" ON "ContentReport"("reporterId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentReport_reporterId_commentId_key" ON "ContentReport"("reporterId", "commentId");

-- CreateIndex
CREATE INDEX "ModerationAction_commentId_idx" ON "ModerationAction"("commentId");

-- CreateIndex
CREATE INDEX "ModerationAction_threadId_idx" ON "ModerationAction"("threadId");

-- CreateIndex
CREATE INDEX "ModerationAction_moderatorId_createdAt_idx" ON "ModerationAction"("moderatorId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_courseId_type_createdAt_idx" ON "ActivityLog"("courseId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_type_createdAt_idx" ON "ActivityLog"("type", "createdAt");

-- CreateIndex
CREATE INDEX "Assignment_academicYearId_status_idx" ON "Assignment"("academicYearId", "status");

-- CreateIndex
CREATE INDEX "Comment_threadId_parentId_createdAt_idx" ON "Comment"("threadId", "parentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Course_disciplineId_code_key" ON "Course"("disciplineId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_currentReviewId_key" ON "Submission"("currentReviewId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_publishedReviewId_key" ON "Submission"("publishedReviewId");

-- CreateIndex
CREATE INDEX "Submission_resultReleaseId_idx" ON "Submission"("resultReleaseId");

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceAttachment" ADD CONSTRAINT "ResourceAttachment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "CourseResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceAttachment" ADD CONSTRAINT "ResourceAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentAttachment" ADD CONSTRAINT "AssignmentAttachment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentAttachment" ADD CONSTRAINT "AssignmentAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_currentReviewId_fkey" FOREIGN KEY ("currentReviewId") REFERENCES "MentorReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_publishedReviewId_fkey" FOREIGN KEY ("publishedReviewId") REFERENCES "MentorReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_resultReleaseId_fkey" FOREIGN KEY ("resultReleaseId") REFERENCES "ResultRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttachment" ADD CONSTRAINT "SubmissionAttachment_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "SubmissionRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttachment" ADD CONSTRAINT "SubmissionAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionBatch" ADD CONSTRAINT "DistributionBatch_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionBatch" ADD CONSTRAINT "DistributionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorReview" ADD CONSTRAINT "MentorReview_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorReview" ADD CONSTRAINT "MentorReview_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorReview" ADD CONSTRAINT "MentorReview_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorReview" ADD CONSTRAINT "MentorReview_distributionBatchId_fkey" FOREIGN KEY ("distributionBatchId") REFERENCES "DistributionBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorReview" ADD CONSTRAINT "MentorReview_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAttachment" ADD CONSTRAINT "ReviewAttachment_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "MentorReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewAttachment" ADD CONSTRAINT "ReviewAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewEvent" ADD CONSTRAINT "ReviewEvent_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "MentorReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewEvent" ADD CONSTRAINT "ReviewEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultRelease" ADD CONSTRAINT "ResultRelease_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResultRelease" ADD CONSTRAINT "ResultRelease_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DiscussionThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DiscussionThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ContentReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL — copy existing data into the new structures.
-- Every statement is idempotent with respect to an empty database.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Discipline: everything existing is Mathematics.
INSERT INTO "Discipline" ("id", "code", "name", "description", "sortOrder", "updatedAt")
VALUES (gen_random_uuid()::text, 'MATHEMATICS', 'Mathematics', 'Olympiad mathematics.', 0, CURRENT_TIMESTAMP);

UPDATE "Course" SET "disciplineId" = (SELECT "id" FROM "Discipline" WHERE "code" = 'MATHEMATICS')
WHERE "disciplineId" IS NULL;

-- 2. Academic year: create the current one (September–July) if data needs it.
INSERT INTO "AcademicYear" ("id", "name", "startsOn", "endsOn", "status", "isCurrent", "updatedAt")
SELECT gen_random_uuid()::text, y || '-' || (y + 1), make_date(y, 9, 1), make_date(y + 1, 7, 31),
       'ACTIVE', true, CURRENT_TIMESTAMP
FROM (SELECT CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 9
                  THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                  ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END AS y) t
WHERE EXISTS (SELECT 1 FROM "Assignment")
   OR EXISTS (SELECT 1 FROM "LiveSession")
   OR EXISTS (SELECT 1 FROM "User" WHERE "role" = 'STUDENT');

UPDATE "Assignment"  SET "academicYearId" = (SELECT "id" FROM "AcademicYear" WHERE "isCurrent") WHERE "academicYearId" IS NULL;
UPDATE "LiveSession" SET "academicYearId" = (SELECT "id" FROM "AcademicYear" WHERE "isCurrent") WHERE "academicYearId" IS NULL;

-- Each student's current placement becomes their enrolment for the current year.
INSERT INTO "StudentEnrollment" ("id", "studentId", "academicYearId", "divisionId", "gradeLevel", "schoolId", "status")
SELECT gen_random_uuid()::text, u."id", ay."id", u."divisionId", u."gradeLevel", u."schoolId", 'ACTIVE'
FROM "User" u CROSS JOIN "AcademicYear" ay
WHERE ay."isCurrent" AND u."role" = 'STUDENT' AND u."gradeLevel" IS NOT NULL AND u."divisionId" IS NOT NULL;

-- 3. Attachments from the single-file columns.
INSERT INTO "ResourceAttachment" ("id", "resourceId", "fileId")
SELECT gen_random_uuid()::text, "id", "fileId" FROM "CourseResource" WHERE "fileId" IS NOT NULL;

INSERT INTO "AssignmentAttachment" ("id", "assignmentId", "fileId")
SELECT gen_random_uuid()::text, "id", "fileId" FROM "Assignment" WHERE "fileId" IS NOT NULL;

INSERT INTO "SubmissionAttachment" ("id", "revisionId", "fileId")
SELECT gen_random_uuid()::text, "id", "fileId" FROM "SubmissionRevision" WHERE "fileId" IS NOT NULL;

-- A submission's current file that is not on any revision goes on its latest revision.
INSERT INTO "SubmissionAttachment" ("id", "revisionId", "fileId")
SELECT gen_random_uuid()::text, r."id", s."fileId"
FROM "Submission" s
JOIN LATERAL (SELECT "id" FROM "SubmissionRevision" WHERE "submissionId" = s."id"
              ORDER BY "revisionNumber" DESC LIMIT 1) r ON true
WHERE s."fileId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SubmissionAttachment" a
                  JOIN "SubmissionRevision" rv ON rv."id" = a."revisionId"
                  WHERE rv."submissionId" = s."id" AND a."fileId" = s."fileId");

-- 4. Mentor reviews: the review stored on each assigned submission becomes cycle 1.
INSERT INTO "MentorReview" ("id", "submissionId", "cycle", "mentorId", "status", "score", "percentage", "feedback",
                            "assignedAt", "startedAt", "markedAt", "returnedAt", "decidedAt", "decisionNote",
                            "coordinationNote", "publishedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, s."id", 1, s."mentorId",
       (CASE s."status"
          WHEN 'IN_REVIEW'          THEN 'IN_PROGRESS'
          WHEN 'MARKED'             THEN 'MARKED'
          WHEN 'SUBMITTED_TO_ADMIN' THEN 'RETURNED'
          WHEN 'APPROVED'           THEN 'APPROVED'
          WHEN 'PUBLISHED'          THEN 'PUBLISHED'
          WHEN 'REJECTED'           THEN 'SENT_BACK'
          ELSE 'ASSIGNED' END)::"ReviewStatus",
       s."score", s."percentage", s."mentorFeedback",
       COALESCE(s."assignedAt", s."createdAt"), s."reviewStartedAt", s."markedAt", s."submittedToAdminAt",
       CASE WHEN s."status" IN ('APPROVED', 'PUBLISHED', 'REJECTED') THEN COALESCE(s."approvedAt", s."updatedAt") END,
       s."rejectionReason", s."coordinationNote", s."publishedAt",
       COALESCE(s."assignedAt", s."createdAt"), CURRENT_TIMESTAMP
FROM "Submission" s
WHERE s."mentorId" IS NOT NULL;

UPDATE "Submission" s SET "currentReviewId" = r."id"
FROM "MentorReview" r WHERE r."submissionId" = s."id" AND r."cycle" = 1;

UPDATE "Submission" s SET "publishedReviewId" = r."id"
FROM "MentorReview" r WHERE r."submissionId" = s."id" AND r."cycle" = 1 AND s."status" = 'PUBLISHED';

INSERT INTO "ReviewAttachment" ("id", "reviewId", "fileId")
SELECT gen_random_uuid()::text, r."id", s."feedbackFileId"
FROM "Submission" s JOIN "MentorReview" r ON r."submissionId" = s."id" AND r."cycle" = 1
WHERE s."feedbackFileId" IS NOT NULL;

INSERT INTO "ReviewEvent" ("id", "reviewId", "type", "note", "createdAt")
SELECT gen_random_uuid()::text, r."id", 'ASSIGNED', 'Migrated from the previous review model', r."assignedAt"
FROM "MentorReview" r;

-- 5. Discussion threads: one per (course × division) and one per assignment with comments.
INSERT INTO "DiscussionThread" ("id", "courseId", "divisionId", "title", "createdById", "lastActivityAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, g."courseId", g."divisionId", 'General discussion',
       (SELECT c2."authorId" FROM "Comment" c2
        WHERE c2."courseId" = g."courseId" AND c2."divisionId" = g."divisionId"
        ORDER BY c2."createdAt" LIMIT 1),
       g."last", g."first", CURRENT_TIMESTAMP
FROM (SELECT "courseId", "divisionId", MIN("createdAt") AS "first", MAX("createdAt") AS "last"
      FROM "Comment" WHERE "courseId" IS NOT NULL GROUP BY "courseId", "divisionId") g;

UPDATE "Comment" c SET "threadId" = t."id"
FROM "DiscussionThread" t
WHERE c."courseId" IS NOT NULL AND t."courseId" = c."courseId" AND t."divisionId" = c."divisionId";

INSERT INTO "DiscussionThread" ("id", "assignmentId", "divisionId", "title", "createdById", "lastActivityAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, g."assignmentId", a."divisionId", 'Questions about this assignment',
       (SELECT c2."authorId" FROM "Comment" c2 WHERE c2."assignmentId" = g."assignmentId" ORDER BY c2."createdAt" LIMIT 1),
       g."last", g."first", CURRENT_TIMESTAMP
FROM (SELECT "assignmentId", MIN("createdAt") AS "first", MAX("createdAt") AS "last"
      FROM "Comment" WHERE "assignmentId" IS NOT NULL GROUP BY "assignmentId") g
JOIN "Assignment" a ON a."id" = g."assignmentId";

UPDATE "Comment" c SET "threadId" = t."id"
FROM "DiscussionThread" t
WHERE c."assignmentId" IS NOT NULL AND t."assignmentId" = c."assignmentId";

-- Existing hidden comments become moderation history.
INSERT INTO "ModerationAction" ("id", "moderatorId", "action", "threadId", "commentId", "reason", "createdAt")
SELECT gen_random_uuid()::text, c."moderatedById", 'HIDE_COMMENT', c."threadId", c."id",
       'Migrated from the previous moderation fields', COALESCE(c."moderatedAt", c."updatedAt")
FROM "Comment" c
WHERE c."status" = 'HIDDEN' AND c."moderatedById" IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- ENFORCE — now that every row has a value.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "Course"      ALTER COLUMN "disciplineId"   SET NOT NULL;
ALTER TABLE "Assignment"  ALTER COLUMN "academicYearId" SET NOT NULL;
ALTER TABLE "LiveSession" ALTER COLUMN "academicYearId" SET NOT NULL;
ALTER TABLE "Comment"     ALTER COLUMN "threadId"       SET NOT NULL;

-- Integrity rules Prisma cannot express (Prisma ignores CHECK constraints when diffing).
ALTER TABLE "DiscussionThread" ADD CONSTRAINT "DiscussionThread_single_target_check"
  CHECK ((("courseId" IS NOT NULL)::int + ("assignmentId" IS NOT NULL)::int) = 1);

ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_single_target_check"
  CHECK ((("threadId" IS NOT NULL)::int + ("commentId" IS NOT NULL)::int) = 1);

ALTER TABLE "MentorReview" ADD CONSTRAINT "MentorReview_score_check"
  CHECK ("score" IS NULL OR "score" >= 0);

ALTER TABLE "AcademicYear" ADD CONSTRAINT "AcademicYear_dates_check"
  CHECK ("endsOn" > "startsOn");

-- isCurrent is TRUE or NULL (never FALSE) so the unique index allows one current year.
ALTER TABLE "AcademicYear" ADD CONSTRAINT "AcademicYear_isCurrent_check"
  CHECK ("isCurrent" IS NULL OR "isCurrent" = true);
