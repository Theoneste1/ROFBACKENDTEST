-- Additive only: no existing data is changed or removed.
--   SubmissionStatus / ReviewStatus / ReviewEventType gain the resubmission-request values.
--   Submission.resubmissionRequestedAt/DueAt/Note hold the open request.
--   SubmissionRevision.answerText holds a typed answer for each attempt.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewEventType" ADD VALUE 'RESUBMISSION_REQUESTED';
ALTER TYPE "ReviewEventType" ADD VALUE 'RESUBMISSION_REQUEST_WITHDRAWN';

-- AlterEnum
ALTER TYPE "ReviewStatus" ADD VALUE 'RESUBMISSION_REQUESTED';

-- AlterEnum
ALTER TYPE "SubmissionStatus" ADD VALUE 'RESUBMISSION_REQUESTED';

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "resubmissionDueAt" TIMESTAMP(3),
ADD COLUMN     "resubmissionNote" TEXT,
ADD COLUMN     "resubmissionRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubmissionRevision" ADD COLUMN     "answerText" TEXT;


-- An open request always has a due date and a note.
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_resubmission_request_check"
  CHECK (("resubmissionRequestedAt" IS NULL) = ("resubmissionDueAt" IS NULL)
     AND ("resubmissionRequestedAt" IS NULL) = ("resubmissionNote" IS NULL));
