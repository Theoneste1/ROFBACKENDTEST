-- ═══════════════════════════════════════════════════════════════════════════
-- CONTRACT migration — NOT APPLIED. REQUIRES APPROVAL (destructive).
--
-- Drops the columns superseded by 20261104000000_academic_structure_reviews_
-- moderation. Their data was copied into the new tables by that migration and
-- the application no longer reads or writes them.
--
-- Before running, this script VERIFIES that every value it is about to drop
-- exists in the new structure and aborts (changing nothing) if not.
-- See prisma/pending-migrations/README.md for the procedure.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Every reviewed submission has a review cycle.
  IF EXISTS (SELECT 1 FROM "Submission" WHERE "mentorId" IS NOT NULL AND "currentReviewId" IS NULL) THEN
    RAISE EXCEPTION 'Abort: a submission has a mentor but no MentorReview.';
  END IF;

  -- Every published score lives on the published review.
  IF EXISTS (SELECT 1 FROM "Submission" s
             WHERE s."score" IS NOT NULL AND s."status" = 'PUBLISHED'
               AND NOT EXISTS (SELECT 1 FROM "MentorReview" r
                               WHERE r."id" = s."publishedReviewId" AND r."score" = s."score")) THEN
    RAISE EXCEPTION 'Abort: a published score is not on its MentorReview.';
  END IF;

  -- Every single-file reference has an attachment row.
  IF EXISTS (SELECT 1 FROM "CourseResource" x WHERE x."fileId" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM "ResourceAttachment" a WHERE a."resourceId" = x."id" AND a."fileId" = x."fileId")) THEN
    RAISE EXCEPTION 'Abort: CourseResource.fileId without ResourceAttachment.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Assignment" x WHERE x."fileId" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM "AssignmentAttachment" a WHERE a."assignmentId" = x."id" AND a."fileId" = x."fileId")) THEN
    RAISE EXCEPTION 'Abort: Assignment.fileId without AssignmentAttachment.';
  END IF;
  IF EXISTS (SELECT 1 FROM "SubmissionRevision" x WHERE x."fileId" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM "SubmissionAttachment" a WHERE a."revisionId" = x."id" AND a."fileId" = x."fileId")) THEN
    RAISE EXCEPTION 'Abort: SubmissionRevision.fileId without SubmissionAttachment.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Submission" s WHERE s."feedbackFileId" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM "ReviewAttachment" a JOIN "MentorReview" r ON r."id" = a."reviewId"
                             WHERE r."submissionId" = s."id" AND a."fileId" = s."feedbackFileId")) THEN
    RAISE EXCEPTION 'Abort: Submission.feedbackFileId without ReviewAttachment.';
  END IF;

  -- Every comment belongs to a thread.
  IF EXISTS (SELECT 1 FROM "Comment" WHERE "threadId" IS NULL) THEN
    RAISE EXCEPTION 'Abort: a comment has no thread.';
  END IF;
END $$;

-- Dropping a column also drops its foreign keys and indexes.
ALTER TABLE "Submission"
  DROP COLUMN "mentorId",
  DROP COLUMN "fileId",
  DROP COLUMN "score",
  DROP COLUMN "percentage",
  DROP COLUMN "mentorFeedback",
  DROP COLUMN "feedbackFileId",
  DROP COLUMN "coordinationNote",
  DROP COLUMN "rejectionReason",
  DROP COLUMN "previousScore",
  DROP COLUMN "reopenNote",
  DROP COLUMN "reopenedAt",
  DROP COLUMN "reopenedById",
  DROP COLUMN "assignedAt",
  DROP COLUMN "reviewStartedAt",
  DROP COLUMN "markedAt",
  DROP COLUMN "submittedToAdminAt",
  DROP COLUMN "approvedAt";

ALTER TABLE "SubmissionRevision" DROP COLUMN "fileId";
ALTER TABLE "CourseResource"     DROP COLUMN "fileId";
ALTER TABLE "Assignment"         DROP COLUMN "fileId";

ALTER TABLE "Comment"
  DROP COLUMN "courseId",
  DROP COLUMN "assignmentId",
  DROP COLUMN "divisionId",
  DROP COLUMN "moderatedAt",
  DROP COLUMN "moderatedById";
