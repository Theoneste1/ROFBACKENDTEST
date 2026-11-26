-- Question-level marking (design Rev 5.2, approved 2026-11-26), migration 2 of 2. Additive: one column on Test (markingMode,
-- default PAPER for every existing test), one on TestQuestion (promptVersion, default 1), ten tables for question tasks, claims,
-- assessments, versions, draft changes, decisions, events and access logs, a prompt history table, and the rules: partial
-- unique indexes, CHECKs, guard triggers, two commit-time (DEFERRABLE) invariants, can_mark_subject and the paper projection.
-- The only change to an existing object: TestMarking_assignment_matches_kind also accepts COMPOSED (from migration
-- 20270101000000). PAPER-mode tests, rows and behaviour are unchanged; the new triggers on TestQuestion, Test and TestFile
-- refuse only what the service already refuses (structure after submissions), plus QUESTION-mode wording/guide freezes.
-- Rollback: docs/migrations/20270101000100_question_marking.rollback.sql (refuses without a verified backup manifest).

-- CreateEnum
CREATE TYPE "TestMarkingMode" AS ENUM ('PAPER', 'QUESTION');

-- CreateEnum
CREATE TYPE "QuestionTaskRound" AS ENUM ('FIRST', 'SECOND');

-- CreateEnum
CREATE TYPE "QuestionTaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED', 'AWAITING_SECOND', 'APPROVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuestionAssessmentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'ABANDONED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TaskClaimMethod" AS ENUM ('CLAIM', 'RESUME', 'ASSIGN');

-- CreateEnum
CREATE TYPE "TaskClaimEndReason" AS ENUM ('SUBMITTED', 'RELEASED', 'RELEASED_BY_STAFF', 'EXPIRED', 'REASSIGNED', 'AUTHORISATION_LOST', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuestionDecisionSource" AS ENUM ('APPROVED_AS_MARKED', 'FIRST', 'SECOND', 'ADJUSTED');

-- CreateEnum
CREATE TYPE "PaperAccessKind" AS ENUM ('PAPER_OPENED', 'PAGE_VIEWED', 'GUIDE_VIEWED');

-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "markingMode" "TestMarkingMode" NOT NULL DEFAULT 'PAPER';

-- AlterTable
ALTER TABLE "TestQuestion" ADD COLUMN     "promptVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "TestQuestionMarker" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" TEXT,

    CONSTRAINT "TestQuestionMarker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuestionTask" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "round" "QuestionTaskRound" NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 0,
    "currentCycle" INTEGER NOT NULL DEFAULT 0,
    "firstTaskId" TEXT,
    "versionId" TEXT NOT NULL,
    "status" "QuestionTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "holderId" TEXT,
    "claimId" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "reservedForId" TEXT,
    "needsReassignment" BOOLEAN NOT NULL DEFAULT false,
    "reviewHoldById" TEXT,
    "reviewHoldUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestQuestionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestTaskClaim" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "method" "TaskClaimMethod" NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" "TaskClaimEndReason",
    "endedById" TEXT,

    CONSTRAINT "TestTaskClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuestionAssessment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "markerId" TEXT NOT NULL,
    "openedByClaimId" TEXT NOT NULL,
    "marks" INTEGER,
    "comment" TEXT,
    "status" "QuestionAssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastVersion" INTEGER NOT NULL DEFAULT 0,
    "guideFileId" TEXT,
    "promptVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestQuestionAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestAssessmentVersion" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "marks" INTEGER NOT NULL,
    "comment" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestAssessmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestMarkDraftChange" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "oldMarks" INTEGER,
    "newMarks" INTEGER,
    "commentChanged" BOOLEAN NOT NULL DEFAULT false,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestMarkDraftChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuestionDecision" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "cycle" INTEGER,
    "source" "QuestionDecisionSource" NOT NULL,
    "marks" INTEGER NOT NULL,
    "sourceVersionId" TEXT,
    "reason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersedeReason" TEXT,

    CONSTRAINT "TestQuestionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestTaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "cycle" INTEGER,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestTaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestPaperAccess" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "kind" "PaperAccessKind" NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TestPaperAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestStaffPaperAccess" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" "PaperAccessKind" NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "day" DATE NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TestStaffPaperAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuestionPromptHistory" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3) NOT NULL,
    "changedById" TEXT,
    "reason" TEXT NOT NULL,

    CONSTRAINT "TestQuestionPromptHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestQuestionMarker_coachId_endedAt_idx" ON "TestQuestionMarker"("coachId", "endedAt");

-- CreateIndex
CREATE INDEX "TestQuestionMarker_questionId_endedAt_idx" ON "TestQuestionMarker"("questionId", "endedAt");

-- CreateIndex
CREATE INDEX "TestQuestionMarker_grantedById_idx" ON "TestQuestionMarker"("grantedById");

-- CreateIndex
CREATE INDEX "TestQuestionMarker_endedById_idx" ON "TestQuestionMarker"("endedById");

-- CreateIndex
CREATE INDEX "TestQuestionTask_questionId_status_idx" ON "TestQuestionTask"("questionId", "status");

-- CreateIndex
CREATE INDEX "TestQuestionTask_holderId_idx" ON "TestQuestionTask"("holderId");

-- CreateIndex
CREATE INDEX "TestQuestionTask_reservedForId_idx" ON "TestQuestionTask"("reservedForId");

-- CreateIndex
CREATE INDEX "TestQuestionTask_claimId_idx" ON "TestQuestionTask"("claimId");

-- CreateIndex
CREATE INDEX "TestQuestionTask_versionId_idx" ON "TestQuestionTask"("versionId");

-- CreateIndex
CREATE INDEX "TestQuestionTask_reviewHoldById_idx" ON "TestQuestionTask"("reviewHoldById");

-- CreateIndex
CREATE UNIQUE INDEX "TestQuestionTask_submissionId_questionId_round_cycle_key" ON "TestQuestionTask"("submissionId", "questionId", "round", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "TestQuestionTask_firstTaskId_cycle_key" ON "TestQuestionTask"("firstTaskId", "cycle");

-- CreateIndex
CREATE INDEX "TestTaskClaim_taskId_endedAt_idx" ON "TestTaskClaim"("taskId", "endedAt");

-- CreateIndex
CREATE INDEX "TestTaskClaim_coachId_endedAt_idx" ON "TestTaskClaim"("coachId", "endedAt");

-- CreateIndex
CREATE INDEX "TestTaskClaim_endedById_idx" ON "TestTaskClaim"("endedById");

-- CreateIndex
CREATE INDEX "TestQuestionAssessment_taskId_status_idx" ON "TestQuestionAssessment"("taskId", "status");

-- CreateIndex
CREATE INDEX "TestQuestionAssessment_markerId_idx" ON "TestQuestionAssessment"("markerId");

-- CreateIndex
CREATE INDEX "TestQuestionAssessment_openedByClaimId_idx" ON "TestQuestionAssessment"("openedByClaimId");

-- CreateIndex
CREATE INDEX "TestQuestionAssessment_guideFileId_idx" ON "TestQuestionAssessment"("guideFileId");

-- CreateIndex
CREATE UNIQUE INDEX "TestAssessmentVersion_assessmentId_version_key" ON "TestAssessmentVersion"("assessmentId", "version");

-- CreateIndex
CREATE INDEX "TestMarkDraftChange_assessmentId_createdAt_idx" ON "TestMarkDraftChange"("assessmentId", "createdAt");

-- CreateIndex
CREATE INDEX "TestMarkDraftChange_actorId_idx" ON "TestMarkDraftChange"("actorId");

-- CreateIndex
CREATE INDEX "TestQuestionDecision_taskId_decidedAt_idx" ON "TestQuestionDecision"("taskId", "decidedAt");

-- CreateIndex
CREATE INDEX "TestQuestionDecision_sourceVersionId_idx" ON "TestQuestionDecision"("sourceVersionId");

-- CreateIndex
CREATE INDEX "TestQuestionDecision_decidedById_idx" ON "TestQuestionDecision"("decidedById");

-- CreateIndex
CREATE INDEX "TestQuestionDecision_supersededById_idx" ON "TestQuestionDecision"("supersededById");

-- CreateIndex
CREATE INDEX "TestTaskEvent_taskId_createdAt_idx" ON "TestTaskEvent"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TestTaskEvent_actorId_createdAt_idx" ON "TestTaskEvent"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TestPaperAccess_claimId_kind_page_key" ON "TestPaperAccess"("claimId", "kind", "page");

-- CreateIndex
CREATE INDEX "TestStaffPaperAccess_submissionId_idx" ON "TestStaffPaperAccess"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "TestStaffPaperAccess_actorId_submissionId_kind_page_day_key" ON "TestStaffPaperAccess"("actorId", "submissionId", "kind", "page", "day");

-- CreateIndex
CREATE INDEX "TestQuestionPromptHistory_changedById_idx" ON "TestQuestionPromptHistory"("changedById");

-- CreateIndex
CREATE UNIQUE INDEX "TestQuestionPromptHistory_questionId_version_key" ON "TestQuestionPromptHistory"("questionId", "version");

-- AddForeignKey
ALTER TABLE "TestQuestionMarker" ADD CONSTRAINT "TestQuestionMarker_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TestQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionMarker" ADD CONSTRAINT "TestQuestionMarker_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionMarker" ADD CONSTRAINT "TestQuestionMarker_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionMarker" ADD CONSTRAINT "TestQuestionMarker_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TestQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_firstTaskId_fkey" FOREIGN KEY ("firstTaskId") REFERENCES "TestQuestionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TestSubmissionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "TestTaskClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_reservedForId_fkey" FOREIGN KEY ("reservedForId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_reviewHoldById_fkey" FOREIGN KEY ("reviewHoldById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestTaskClaim" ADD CONSTRAINT "TestTaskClaim_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TestQuestionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestTaskClaim" ADD CONSTRAINT "TestTaskClaim_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestTaskClaim" ADD CONSTRAINT "TestTaskClaim_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionAssessment" ADD CONSTRAINT "TestQuestionAssessment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TestQuestionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionAssessment" ADD CONSTRAINT "TestQuestionAssessment_markerId_fkey" FOREIGN KEY ("markerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionAssessment" ADD CONSTRAINT "TestQuestionAssessment_openedByClaimId_fkey" FOREIGN KEY ("openedByClaimId") REFERENCES "TestTaskClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionAssessment" ADD CONSTRAINT "TestQuestionAssessment_guideFileId_fkey" FOREIGN KEY ("guideFileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAssessmentVersion" ADD CONSTRAINT "TestAssessmentVersion_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "TestQuestionAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkDraftChange" ADD CONSTRAINT "TestMarkDraftChange_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "TestQuestionAssessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkDraftChange" ADD CONSTRAINT "TestMarkDraftChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TestQuestionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "TestAssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestTaskEvent" ADD CONSTRAINT "TestTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "TestQuestionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestTaskEvent" ADD CONSTRAINT "TestTaskEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPaperAccess" ADD CONSTRAINT "TestPaperAccess_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "TestTaskClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestStaffPaperAccess" ADD CONSTRAINT "TestStaffPaperAccess_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestStaffPaperAccess" ADD CONSTRAINT "TestStaffPaperAccess_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionPromptHistory" ADD CONSTRAINT "TestQuestionPromptHistory_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TestQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestionPromptHistory" ADD CONSTRAINT "TestQuestionPromptHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Question-level marking: the rules (design Rev 5.2). Everything below is enforced by the database whatever the code.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── Partial unique indexes (not expressible in the Prisma schema; same pattern as TestMarkerAssignment_one_current) ──
CREATE UNIQUE INDEX "TestQuestionMarker_one_active" ON "TestQuestionMarker"("questionId", "coachId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "TestTaskClaim_one_open" ON "TestTaskClaim"("taskId") WHERE "endedAt" IS NULL;
CREATE INDEX "TestTaskClaim_open_by_coach" ON "TestTaskClaim"("coachId") WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "TestQuestionAssessment_one_open" ON "TestQuestionAssessment"("taskId") WHERE "status" IN ('DRAFT', 'RETURNED');
CREATE UNIQUE INDEX "TestQuestionDecision_one_current" ON "TestQuestionDecision"("taskId") WHERE "supersededAt" IS NULL;

-- ── CHECK constraints ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "TestMarking" DROP CONSTRAINT "TestMarking_assignment_matches_kind";
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_assignment_matches_kind" CHECK (("kind" IN ('ADJUSTMENT', 'COMPOSED')) = ("assignmentId" IS NULL));

ALTER TABLE "TestQuestionMarker" ADD CONSTRAINT "TestQuestionMarker_ending_complete" CHECK (("endedAt" IS NULL) = ("endReason" IS NULL));
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_round_cycle" CHECK (
  ("round" = 'FIRST' AND "cycle" = 0 AND "firstTaskId" IS NULL AND "currentCycle" >= 0)
  OR ("round" = 'SECOND' AND "cycle" >= 1 AND "firstTaskId" IS NOT NULL AND "currentCycle" = 0));
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_round_status" CHECK (
  ("round" = 'FIRST' AND "status" NOT IN ('CLOSED', 'CANCELLED'))
  OR ("round" = 'SECOND' AND "status" NOT IN ('UNDER_REVIEW', 'AWAITING_SECOND', 'APPROVED')));
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_holder_iff_in_progress" CHECK (
  ("status" = 'IN_PROGRESS') = ("holderId" IS NOT NULL)
  AND ("status" = 'IN_PROGRESS') = ("claimId" IS NOT NULL)
  AND ("status" = 'IN_PROGRESS') = ("lockExpiresAt" IS NOT NULL));
ALTER TABLE "TestQuestionTask" ADD CONSTRAINT "TestQuestionTask_review_hold_complete" CHECK (("reviewHoldUntil" IS NULL) OR ("status" = 'UNDER_REVIEW'));
ALTER TABLE "TestTaskClaim" ADD CONSTRAINT "TestTaskClaim_ending_complete" CHECK (("endedAt" IS NULL) = ("endReason" IS NULL));
ALTER TABLE "TestQuestionAssessment" ADD CONSTRAINT "TestQuestionAssessment_numbers" CHECK (("marks" IS NULL OR "marks" >= 0) AND "revision" >= 1 AND "lastVersion" >= 0 AND "promptVersion" >= 1);
ALTER TABLE "TestAssessmentVersion" ADD CONSTRAINT "TestAssessmentVersion_numbers" CHECK ("marks" >= 0 AND "version" >= 1);
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_source_version" CHECK (("source" = 'ADJUSTED') = ("sourceVersionId" IS NULL));
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_reason" CHECK ("source" = 'APPROVED_AS_MARKED' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0));
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_cycle" CHECK (("source" = 'APPROVED_AS_MARKED') = ("cycle" IS NULL) AND ("cycle" IS NULL OR "cycle" >= 1));
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_marks" CHECK ("marks" >= 0);
ALTER TABLE "TestQuestionDecision" ADD CONSTRAINT "TestQuestionDecision_superseded_complete" CHECK (("supersededAt" IS NULL) = ("supersedeReason" IS NULL));
ALTER TABLE "TestPaperAccess" ADD CONSTRAINT "TestPaperAccess_page" CHECK (("kind" = 'PAGE_VIEWED') = ("page" > 0) AND "page" >= 0 AND "count" >= 1);
ALTER TABLE "TestStaffPaperAccess" ADD CONSTRAINT "TestStaffPaperAccess_page" CHECK (("kind" = 'PAGE_VIEWED') = ("page" > 0) AND "page" >= 0 AND "count" >= 1);
ALTER TABLE "TestQuestionPromptHistory" ADD CONSTRAINT "TestQuestionPromptHistory_version" CHECK ("version" >= 1 AND length(btrim("reason")) > 0);
ALTER TABLE "TestQuestion" ADD CONSTRAINT "TestQuestion_prompt_version" CHECK ("promptVersion" >= 1);

-- ── Functions ─────────────────────────────────────────────────────────────────────────────────────────────────────

-- Who may mark a subject now (mirrors src/test-management/marker-reach.ts): an ACTIVE Coach with an active marker
-- authorisation or an active programme membership for the subject, and no active MARKING restriction.
CREATE OR REPLACE FUNCTION can_mark_subject(coach_id text, discipline_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User" u
     WHERE u."id" = coach_id AND u."role" = 'MENTOR' AND u."accountStatus" = 'ACTIVE'
       AND (EXISTS (SELECT 1 FROM "MarkerAuthorization" a WHERE a."coachId" = u."id" AND a."disciplineId" = discipline_id AND a."revokedAt" IS NULL)
         OR EXISTS (SELECT 1 FROM "ProgrammeMembership" m WHERE m."userId" = u."id" AND m."disciplineId" = discipline_id AND m."isActive"))
       AND NOT EXISTS (SELECT 1 FROM "CoachProgrammeRestriction" r
                        WHERE r."coachId" = u."id" AND r."disciplineId" = discipline_id AND r."capability" = 'MARKING' AND r."liftedAt" IS NULL))
$$;

-- The paper status projected from its FIRST-round task statuses (design §4; mirrored by projectPaper in TypeScript).
CREATE OR REPLACE FUNCTION question_paper_status_of(statuses text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN coalesce(array_length(statuses, 1), 0) = 0 THEN 'SUBMITTED'
    WHEN 'RETURNED' = ANY(statuses) THEN 'RETURNED'
    WHEN statuses <@ ARRAY['APPROVED']::text[] THEN 'APPROVED'
    WHEN statuses <@ ARRAY['SUBMITTED', 'UNDER_REVIEW', 'AWAITING_SECOND', 'APPROVED']::text[] THEN 'MARKED'
    WHEN NOT (statuses <@ ARRAY['NOT_STARTED']::text[]) THEN 'MARKING_IN_PROGRESS'
    ELSE 'SUBMITTED'
  END
$$;

CREATE OR REPLACE FUNCTION question_paper_status(submission_id text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT question_paper_status_of(coalesce(array_agg(t."status"::text ORDER BY t."questionId"), ARRAY[]::text[]))
    FROM "TestQuestionTask" t WHERE t."submissionId" = submission_id AND t."round" = 'FIRST'
$$;

-- ── Test.markingMode: frozen once any marking record exists (addendum 5.1, point 5) ──────────────────────────────────
CREATE OR REPLACE FUNCTION test_marking_mode_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."markingMode" IS DISTINCT FROM OLD."markingMode" THEN
    IF EXISTS (SELECT 1 FROM "TestMarkerAssignment" a JOIN "TestSubmission" s ON s."id" = a."submissionId" WHERE s."testId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "TestMarking" m JOIN "TestSubmission" s ON s."id" = m."submissionId" WHERE s."testId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "TestReview" r JOIN "TestSubmission" s ON s."id" = r."submissionId" WHERE s."testId" = NEW."id")
       OR EXISTS (SELECT 1 FROM "TestSubmission" s WHERE s."testId" = NEW."id" AND s."status" <> 'SUBMITTED')
       OR EXISTS (SELECT 1 FROM "TestQuestionTask" t JOIN "TestSubmission" s ON s."id" = t."submissionId" WHERE s."testId" = NEW."id") THEN
      RAISE EXCEPTION 'Test %: the marking mode cannot change once marking has begun', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."markingMode" = 'QUESTION' AND NOT EXISTS (SELECT 1 FROM "TestQuestion" q WHERE q."testId" = NEW."id") THEN
      RAISE EXCEPTION 'Test %: question marking needs at least one question', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_marking_mode_guard BEFORE UPDATE OF "markingMode" ON "Test" FOR EACH ROW EXECUTE FUNCTION test_marking_mode_guard();

-- ── Question structure, wording and guide (addendum 5.1 point 4, 5.2 point 4) ────────────────────────────────────────
-- Number, order and maxima of questions, and the test maximum: frozen once the test has any submission, task, marker
-- assignment or marking (backstop of the service rule TEST_LOCKED_BY_SUBMISSIONS; it never refuses what the service
-- allows). The one exception: a Super Admin structure correction (transaction-local rof.question_structure_correction =
-- 'on'), possible only while there is no task, assignment or marking. QUESTION mode only: the wording is frozen once any
-- submission exists, except a Super Admin correction (rof.question_wording_correction = 'on').
CREATE OR REPLACE FUNCTION question_marking_started(test_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "TestQuestionTask" t JOIN "TestSubmission" s ON s."id" = t."submissionId" WHERE s."testId" = test_id)
      OR EXISTS (SELECT 1 FROM "TestMarkerAssignment" a JOIN "TestSubmission" s ON s."id" = a."submissionId" WHERE s."testId" = test_id)
      OR EXISTS (SELECT 1 FROM "TestMarking" m JOIN "TestSubmission" s ON s."id" = m."submissionId" WHERE s."testId" = test_id)
$$;

CREATE OR REPLACE FUNCTION test_question_structure_guard() RETURNS trigger AS $$
DECLARE
  tid text := CASE WHEN TG_OP = 'DELETE' THEN OLD."testId" ELSE NEW."testId" END;
  has_submissions boolean;
  correction boolean := coalesce(current_setting('rof.question_structure_correction', true), '') = 'on';
  mode text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."testId" IS DISTINCT FROM OLD."testId" THEN
    RAISE EXCEPTION 'TestQuestion %: a question never moves to another test', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (SELECT 1 FROM "TestSubmission" s WHERE s."testId" = tid) INTO has_submissions;
  IF TG_OP <> 'UPDATE' OR (NEW."order", NEW."maxMarks") IS DISTINCT FROM (OLD."order", OLD."maxMarks") THEN
    IF has_submissions AND (NOT correction OR question_marking_started(tid)) THEN
      RAISE EXCEPTION 'Test %: its questions (number, order, marks) are frozen once students have submitted', tid USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."prompt" IS DISTINCT FROM OLD."prompt" THEN
    SELECT t."markingMode"::text INTO mode FROM "Test" t WHERE t."id" = tid;
    IF mode = 'QUESTION' AND has_submissions AND coalesce(current_setting('rof.question_wording_correction', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Test %: in question marking a question''s wording is frozen once students have submitted', tid USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_question_structure_guard BEFORE INSERT OR UPDATE OR DELETE ON "TestQuestion" FOR EACH ROW EXECUTE FUNCTION test_question_structure_guard();

CREATE OR REPLACE FUNCTION test_max_marks_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."maxMarks" IS DISTINCT FROM OLD."maxMarks"
     AND EXISTS (SELECT 1 FROM "TestSubmission" s WHERE s."testId" = NEW."id")
     AND (coalesce(current_setting('rof.question_structure_correction', true), '') <> 'on' OR question_marking_started(NEW."id")) THEN
    RAISE EXCEPTION 'Test %: its maximum is frozen once students have submitted', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_max_marks_guard BEFORE UPDATE OF "maxMarks" ON "Test" FOR EACH ROW EXECUTE FUNCTION test_max_marks_guard();

CREATE OR REPLACE FUNCTION test_guide_guard() RETURNS trigger AS $$
DECLARE
  tid text := CASE WHEN TG_OP = 'DELETE' THEN OLD."testId" ELSE NEW."testId" END;
  k text := CASE WHEN TG_OP = 'DELETE' THEN OLD."kind"::text ELSE NEW."kind"::text END;
BEGIN
  IF k = 'MARKING_GUIDE'
     AND EXISTS (SELECT 1 FROM "Test" t WHERE t."id" = tid AND t."markingMode" = 'QUESTION')
     AND EXISTS (SELECT 1 FROM "TestQuestionTask" q JOIN "TestSubmission" s ON s."id" = q."submissionId" WHERE s."testId" = tid)
     AND coalesce(current_setting('rof.question_guide_correction', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Test %: in question marking the marking guide is frozen once marking tasks exist', tid USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_guide_guard BEFORE INSERT OR UPDATE OR DELETE ON "TestFile" FOR EACH ROW EXECUTE FUNCTION test_guide_guard();

-- ── Question markers: the coach may mark the subject; only ending; never deleted ─────────────────────────────────────
CREATE OR REPLACE FUNCTION test_question_marker_guard() RETURNS trigger AS $$
DECLARE
  subject text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestQuestionMarker is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT t."disciplineId" INTO subject FROM "TestQuestion" q JOIN "Test" t ON t."id" = q."testId" WHERE q."id" = NEW."questionId";
    IF NOT can_mark_subject(NEW."coachId", subject) THEN
      RAISE EXCEPTION 'TestQuestionMarker: coach % may not mark this subject', NEW."coachId" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."endedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'TestQuestionMarker: created active only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."questionId", NEW."coachId", NEW."grantedAt", NEW."reason") IS DISTINCT FROM (OLD."id", OLD."questionId", OLD."coachId", OLD."grantedAt", OLD."reason")
     OR (NEW."grantedById" IS DISTINCT FROM OLD."grantedById" AND NEW."grantedById" IS NOT NULL)
     OR (OLD."endedAt" IS NOT NULL AND ((NEW."endedAt", NEW."endReason") IS DISTINCT FROM (OLD."endedAt", OLD."endReason")
         OR (NEW."endedById" IS DISTINCT FROM OLD."endedById" AND NEW."endedById" IS NOT NULL))) THEN
    RAISE EXCEPTION 'TestQuestionMarker %: only ending is allowed', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_question_marker_guard BEFORE INSERT OR UPDATE OR DELETE ON "TestQuestionMarker" FOR EACH ROW EXECUTE FUNCTION test_question_marker_guard();

-- ── Tasks: identity never changes; the question belongs to the paper's test (QUESTION mode); only the transitions of
--    design §4; a SECOND task is never held by anyone with an assessment on its FIRST task; never deleted ──────────────
CREATE OR REPLACE FUNCTION test_question_task_guard() RETURNS trigger AS $$
DECLARE
  ok boolean;
  pair text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestQuestionTask is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId" JOIN "TestQuestion" q ON q."testId" = t."id"
                    WHERE s."id" = NEW."submissionId" AND q."id" = NEW."questionId" AND t."markingMode" = 'QUESTION') INTO ok;
    IF NOT ok THEN
      RAISE EXCEPTION 'TestQuestionTask: the question must belong to the paper''s test, in question marking' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."round" = 'SECOND' AND NOT EXISTS (
         SELECT 1 FROM "TestQuestionTask" f WHERE f."id" = NEW."firstTaskId" AND f."round" = 'FIRST'
            AND f."submissionId" = NEW."submissionId" AND f."questionId" = NEW."questionId") THEN
      RAISE EXCEPTION 'TestQuestionTask: a SECOND task belongs to the FIRST task of the same answer' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" NOT IN ('NOT_STARTED', 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'TestQuestionTask: created NOT_STARTED (or IN_PROGRESS by an assignment)' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW."id", NEW."submissionId", NEW."questionId", NEW."round", NEW."cycle", NEW."firstTaskId", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."submissionId", OLD."questionId", OLD."round", OLD."cycle", OLD."firstTaskId", OLD."createdAt") THEN
      RAISE EXCEPTION 'TestQuestionTask %: its identity never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."currentCycle" < OLD."currentCycle" OR NEW."currentCycle" > OLD."currentCycle" + 1 THEN
      RAISE EXCEPTION 'TestQuestionTask %: the cycle only goes up by one', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      pair := NEW."round"::text || ':' || OLD."status"::text || '>' || NEW."status"::text;
      IF pair NOT IN (
        'FIRST:NOT_STARTED>IN_PROGRESS', 'FIRST:IN_PROGRESS>NOT_STARTED', 'FIRST:IN_PROGRESS>SUBMITTED', 'FIRST:IN_PROGRESS>RETURNED',
        'FIRST:RETURNED>IN_PROGRESS', 'FIRST:SUBMITTED>UNDER_REVIEW', 'FIRST:UNDER_REVIEW>SUBMITTED',
        'FIRST:SUBMITTED>APPROVED', 'FIRST:UNDER_REVIEW>APPROVED', 'FIRST:SUBMITTED>RETURNED', 'FIRST:UNDER_REVIEW>RETURNED',
        'FIRST:SUBMITTED>AWAITING_SECOND', 'FIRST:UNDER_REVIEW>AWAITING_SECOND', 'FIRST:AWAITING_SECOND>APPROVED',
        'FIRST:AWAITING_SECOND>SUBMITTED', 'FIRST:APPROVED>RETURNED', 'FIRST:APPROVED>SUBMITTED',
        'SECOND:NOT_STARTED>IN_PROGRESS', 'SECOND:IN_PROGRESS>NOT_STARTED', 'SECOND:IN_PROGRESS>SUBMITTED', 'SECOND:IN_PROGRESS>RETURNED',
        'SECOND:RETURNED>IN_PROGRESS', 'SECOND:SUBMITTED>RETURNED', 'SECOND:SUBMITTED>CLOSED',
        'SECOND:NOT_STARTED>CANCELLED', 'SECOND:IN_PROGRESS>CANCELLED', 'SECOND:RETURNED>CANCELLED') THEN
        RAISE EXCEPTION 'TestQuestionTask %: % is not an allowed transition', OLD."id", pair USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW."round" = 'SECOND' AND NEW."holderId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."holderId" IS DISTINCT FROM OLD."holderId")
     AND EXISTS (SELECT 1 FROM "TestQuestionAssessment" a WHERE a."taskId" = NEW."firstTaskId" AND a."markerId" = NEW."holderId") THEN
    RAISE EXCEPTION 'TestQuestionTask %: a first marker may not take the second assessment', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_question_task_guard BEFORE INSERT OR UPDATE OR DELETE ON "TestQuestionTask" FOR EACH ROW EXECUTE FUNCTION test_question_task_guard();

-- ── Claims: only ending (once) and lastActiveAt; never deleted ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION test_task_claim_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestTaskClaim is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."taskId", NEW."coachId", NEW."method", NEW."claimedAt") IS DISTINCT FROM (OLD."id", OLD."taskId", OLD."coachId", OLD."method", OLD."claimedAt")
     OR (OLD."endedAt" IS NOT NULL AND ((NEW."endedAt", NEW."endReason", NEW."lastActiveAt") IS DISTINCT FROM (OLD."endedAt", OLD."endReason", OLD."lastActiveAt")
         OR (NEW."endedById" IS DISTINCT FROM OLD."endedById" AND NEW."endedById" IS NOT NULL))) THEN
    RAISE EXCEPTION 'TestTaskClaim %: only ending and activity are recorded', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_task_claim_guard BEFORE UPDATE OR DELETE ON "TestTaskClaim" FOR EACH ROW EXECUTE FUNCTION test_task_claim_guard();

-- ── Assessments (addendum 5.1 point 3): a new one belongs to the task's current claim and holder; marks and comment
--    change only while DRAFT or RETURNED and only by the current holder; never above the question's maximum ───────────
CREATE OR REPLACE FUNCTION test_question_assessment_guard() RETURNS trigger AS $$
DECLARE
  tk record;
  max_marks integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestQuestionAssessment is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT t."status"::text AS status, t."claimId", t."holderId", q."maxMarks" INTO tk
    FROM "TestQuestionTask" t JOIN "TestQuestion" q ON q."id" = t."questionId" WHERE t."id" = NEW."taskId";
  IF TG_OP = 'INSERT' THEN
    IF tk.status <> 'IN_PROGRESS' OR tk."claimId" IS DISTINCT FROM NEW."openedByClaimId" OR tk."holderId" IS DISTINCT FROM NEW."markerId"
       OR NEW."status" <> 'DRAFT' OR NEW."marks" IS NOT NULL THEN
      RAISE EXCEPTION 'TestQuestionAssessment: a new assessment is empty and belongs to the task''s current claim and holder' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."taskId", NEW."markerId", NEW."openedByClaimId", NEW."createdAt", NEW."guideFileId", NEW."promptVersion")
     IS DISTINCT FROM (OLD."id", OLD."taskId", OLD."markerId", OLD."openedByClaimId", OLD."createdAt", OLD."guideFileId", OLD."promptVersion") THEN
    RAISE EXCEPTION 'TestQuestionAssessment %: its identity never changes', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."marks", NEW."comment") IS DISTINCT FROM (OLD."marks", OLD."comment") THEN
    IF OLD."status" NOT IN ('DRAFT', 'RETURNED') OR NEW."status" NOT IN ('DRAFT', 'RETURNED', 'SUBMITTED')
       OR tk.status <> 'IN_PROGRESS' OR tk."holderId" IS DISTINCT FROM OLD."markerId" THEN
      RAISE EXCEPTION 'TestQuestionAssessment %: only its marker, holding the task, may change its marks', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD."status" IN ('ABANDONED', 'SUPERSEDED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'TestQuestionAssessment %: an abandoned or superseded assessment never reopens', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."marks" IS NOT NULL AND NEW."marks" > tk."maxMarks" THEN
    RAISE EXCEPTION 'TestQuestionAssessment: % marks exceed the question''s maximum of %', NEW."marks", tk."maxMarks" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_question_assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON "TestQuestionAssessment" FOR EACH ROW EXECUTE FUNCTION test_question_assessment_guard();

-- ── Versions, draft changes, events, prompt history: append-only (actor columns may become NULL) ────────────────────────
CREATE OR REPLACE FUNCTION question_marking_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- an actor column may become NULL (account deleted); nothing else changes (jsonb: no per-table field references)
  IF TG_TABLE_NAME IN ('TestMarkDraftChange', 'TestTaskEvent')
     AND (to_jsonb(NEW) - 'actorId') = (to_jsonb(OLD) - 'actorId')
     AND to_jsonb(NEW) -> 'actorId' = 'null'::jsonb THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'TestQuestionPromptHistory'
     AND (to_jsonb(NEW) - 'changedById') = (to_jsonb(OLD) - 'changedById')
     AND to_jsonb(NEW) -> 'changedById' = 'null'::jsonb THEN RETURN NEW; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_assessment_version_append_only BEFORE UPDATE OR DELETE ON "TestAssessmentVersion" FOR EACH ROW EXECUTE FUNCTION question_marking_append_only();
CREATE TRIGGER test_mark_draft_change_append_only BEFORE UPDATE OR DELETE ON "TestMarkDraftChange" FOR EACH ROW EXECUTE FUNCTION question_marking_append_only();
CREATE TRIGGER test_task_event_append_only BEFORE UPDATE OR DELETE ON "TestTaskEvent" FOR EACH ROW EXECUTE FUNCTION question_marking_append_only();
CREATE TRIGGER test_question_prompt_history_append_only BEFORE UPDATE OR DELETE ON "TestQuestionPromptHistory" FOR EACH ROW EXECUTE FUNCTION question_marking_append_only();

-- ── Access rows: only the counter and the last time change; never deleted ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION test_paper_access_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'count' - 'lastAt') IS DISTINCT FROM (to_jsonb(OLD) - 'count' - 'lastAt') OR NEW."count" < OLD."count" THEN
    RAISE EXCEPTION '%: only the count and the last time change', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_paper_access_guard BEFORE UPDATE OR DELETE ON "TestPaperAccess" FOR EACH ROW EXECUTE FUNCTION test_paper_access_guard();
CREATE TRIGGER test_staff_paper_access_guard BEFORE UPDATE OR DELETE ON "TestStaffPaperAccess" FOR EACH ROW EXECUTE FUNCTION test_paper_access_guard();

-- ── Decisions: on the FIRST task; marks equal the source version's; append-only apart from superseding once ───────────
CREATE OR REPLACE FUNCTION test_question_decision_guard() RETURNS trigger AS $$
DECLARE
  first_task record;
  v record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestQuestionDecision is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Allowed: superseding a current decision once; decidedById / supersededById becoming NULL (account deleted).
    IF (to_jsonb(NEW) - 'supersededAt' - 'supersededById' - 'supersedeReason' - 'decidedById')
       IS DISTINCT FROM (to_jsonb(OLD) - 'supersededAt' - 'supersededById' - 'supersedeReason' - 'decidedById')
       OR (NEW."decidedById" IS DISTINCT FROM OLD."decidedById" AND NEW."decidedById" IS NOT NULL)
       OR (OLD."supersededAt" IS NOT NULL AND (
             (NEW."supersededAt", NEW."supersedeReason") IS DISTINCT FROM (OLD."supersededAt", OLD."supersedeReason")
             OR (NEW."supersededById" IS DISTINCT FROM OLD."supersededById" AND NEW."supersededById" IS NOT NULL)))
       OR (OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NULL AND NEW."supersededById" IS NOT NULL) THEN
      RAISE EXCEPTION 'TestQuestionDecision %: a decision is only superseded, once', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  SELECT t."id", t."round"::text AS round, q."maxMarks" INTO first_task
    FROM "TestQuestionTask" t JOIN "TestQuestion" q ON q."id" = t."questionId" WHERE t."id" = NEW."taskId";
  IF first_task.round <> 'FIRST' THEN
    RAISE EXCEPTION 'TestQuestionDecision: a decision belongs to the FIRST task' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."marks" > first_task."maxMarks" THEN
    RAISE EXCEPTION 'TestQuestionDecision: % marks exceed the question''s maximum of %', NEW."marks", first_task."maxMarks" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TestQuestionDecision: created current only' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sourceVersionId" IS NOT NULL THEN
    SELECT tv."marks", a."taskId", t."round"::text AS round, t."cycle", t."firstTaskId" INTO v
      FROM "TestAssessmentVersion" tv JOIN "TestQuestionAssessment" a ON a."id" = tv."assessmentId"
      JOIN "TestQuestionTask" t ON t."id" = a."taskId" WHERE tv."id" = NEW."sourceVersionId";
    IF v."marks" IS DISTINCT FROM NEW."marks" THEN
      RAISE EXCEPTION 'TestQuestionDecision: the marks must equal the source version''s (% vs %)', NEW."marks", v."marks" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" IN ('APPROVED_AS_MARKED', 'FIRST') AND v."taskId" <> NEW."taskId" THEN
      RAISE EXCEPTION 'TestQuestionDecision: % must come from the FIRST task''s assessment', NEW."source" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."source" = 'SECOND' AND (v.round <> 'SECOND' OR v."firstTaskId" <> NEW."taskId" OR v."cycle" <> NEW."cycle") THEN
      RAISE EXCEPTION 'TestQuestionDecision: SECOND must come from that cycle''s second assessment' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER test_question_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON "TestQuestionDecision" FOR EACH ROW EXECUTE FUNCTION test_question_decision_guard();

-- ── Commit-time invariant 1: a FIRST task is APPROVED iff it has exactly one current decision ──────────────────────────
CREATE OR REPLACE FUNCTION check_question_decision_invariant() RETURNS trigger AS $$
DECLARE
  tid text;
  st text;
  current_n integer;
BEGIN
  -- (separate IFs: PL/pgSQL resolves every field of an expression, so NEW."taskId" must not be read on a task row)
  IF TG_TABLE_NAME = 'TestQuestionTask' THEN tid := NEW."id"; ELSE tid := NEW."taskId"; END IF;
  SELECT t."status"::text INTO st FROM "TestQuestionTask" t WHERE t."id" = tid AND t."round" = 'FIRST';
  IF st IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO current_n FROM "TestQuestionDecision" d WHERE d."taskId" = tid AND d."supersededAt" IS NULL;
  IF (st = 'APPROVED') <> (current_n = 1) OR current_n > 1 THEN
    RAISE EXCEPTION 'Question task %: APPROVED needs exactly one current decision (status %, current decisions %)', tid, st, current_n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER question_decision_invariant_task AFTER INSERT OR UPDATE ON "TestQuestionTask"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_question_decision_invariant();
CREATE CONSTRAINT TRIGGER question_decision_invariant_decision AFTER INSERT OR UPDATE ON "TestQuestionDecision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_question_decision_invariant();

-- ── Commit-time invariant 2: a QUESTION-mode paper's status is the projection of its FIRST tasks; APPROVED or PUBLISHED
--    iff finalMarkingId is a COMPOSED marking of it whose scores equal the current decisions and whose total is their sum ─
CREATE OR REPLACE FUNCTION check_question_paper_invariant() RETURNS trigger AS $$
DECLARE
  sid text;
  sub record;
  projected text;
  m record;
  bad integer;
BEGIN
  IF TG_TABLE_NAME = 'TestSubmission' THEN sid := NEW."id"; ELSE sid := NEW."submissionId"; END IF;
  SELECT s."id", s."status"::text AS status, s."finalMarkingId", t."markingMode"::text AS mode, t."id" AS "testId"
    INTO sub FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId" WHERE s."id" = sid;
  IF sub.mode IS DISTINCT FROM 'QUESTION' THEN RETURN NULL; END IF;
  projected := question_paper_status(sid);
  IF NOT (sub.status = projected OR (sub.status = 'PUBLISHED' AND projected = 'APPROVED')) THEN
    RAISE EXCEPTION 'Paper %: status % is not its projection %', sid, sub.status, projected USING ERRCODE = 'check_violation';
  END IF;
  IF sub.status IN ('APPROVED', 'PUBLISHED') THEN
    SELECT k."kind"::text AS kind, k."submissionId", k."status"::text AS status, k."totalMarks" INTO m FROM "TestMarking" k WHERE k."id" = sub."finalMarkingId";
    IF m.kind IS DISTINCT FROM 'COMPOSED' OR m."submissionId" IS DISTINCT FROM sid OR m.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'Paper %: an approved question-marked paper needs its COMPOSED final marking', sid USING ERRCODE = 'check_violation';
    END IF;
    -- every required question exactly once, equal to its current decision; nothing else; total = sum
    SELECT count(*) INTO bad FROM (
      SELECT q."id" AS qid, d."marks" AS want, sc."marks" AS got
        FROM "TestQuestion" q
        LEFT JOIN "TestQuestionTask" ft ON ft."submissionId" = sid AND ft."questionId" = q."id" AND ft."round" = 'FIRST'
        LEFT JOIN "TestQuestionDecision" d ON d."taskId" = ft."id" AND d."supersededAt" IS NULL
        LEFT JOIN "TestMarkingScore" sc ON sc."markingId" = sub."finalMarkingId" AND sc."questionId" = q."id"
       WHERE q."testId" = sub."testId") x
     WHERE x.want IS NULL OR x.got IS DISTINCT FROM x.want;
    IF bad > 0 OR EXISTS (SELECT 1 FROM "TestMarkingScore" sc JOIN "TestQuestion" q ON q."id" = sc."questionId"
                           WHERE sc."markingId" = sub."finalMarkingId" AND q."testId" <> sub."testId")
       OR m."totalMarks" IS DISTINCT FROM (SELECT sum(sc."marks") FROM "TestMarkingScore" sc WHERE sc."markingId" = sub."finalMarkingId") THEN
      RAISE EXCEPTION 'Paper %: the COMPOSED marking does not match the current question decisions', sid USING ERRCODE = 'check_violation';
    END IF;
  ELSIF sub."finalMarkingId" IS NOT NULL THEN
    RAISE EXCEPTION 'Paper %: only an approved paper has a final marking', sid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER question_paper_invariant_submission AFTER INSERT OR UPDATE ON "TestSubmission"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_question_paper_invariant();
CREATE CONSTRAINT TRIGGER question_paper_invariant_task AFTER INSERT OR UPDATE ON "TestQuestionTask"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."round" = 'FIRST') EXECUTE FUNCTION check_question_paper_invariant();
