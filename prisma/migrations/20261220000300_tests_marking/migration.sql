-- Test Management (WS3, owner spec and plan approved 2026-11-19), migration M-d part 1 (Phase 3): distribution to markers,
-- blind marking, second marking, review, approval and locking, the mark-change log. NEW tables, three new enums and ONE
-- new nullable column (TestSubmission.finalMarkingId) only — every existing row, the Phase 1 and 2 tables' data and the
-- course-assignment pipeline (Assignment, Submission, MentorReview …) are untouched. Publication is Phase 4.
--
--   TestMarkerAssignment  a submission given to an authorised coach (FIRST or SECOND marking): who assigned it, when, how
--                         (distribution, manual, reassignment, second marking) and why; at most one CURRENT assignment per
--                         submission and kind (partial unique index TestMarkerAssignment_one_current); a reassignment ends
--                         the current one (who, when, why) — rows are never deleted, an ended row never changes (trigger).
--   TestMarking           FIRST, SECOND or ADJUSTMENT (subject Head Coach only, G4) marks of the version marked; DRAFT →
--                         SUBMITTED → APPROVED, or RETURNED for correction; whole marks (G7) never above the test's maximum
--                         (CHECK + trigger); once SUBMITTED or APPROVED its marks never change (trigger).
--   TestMarkingScore      per-question marks and comment, never above the question's maximum, only for a question of the
--                         same test, only while the marking is a draft or returned (trigger).
--   TestMarkChange        append-only log of every mark change: marking, question (NULL: the total), old, new, who, when,
--                         why (trigger).
--   TestReview            append-only reviewer decisions: approve, return (comment), request second marking, choose first /
--                         second / adjusted marks (reason), unlock (reason) (CHECK + trigger).
--   TestSubmission.finalMarkingId  the marking whose marks count.
-- The submission status flow continues in TestSubmissionStatusChange (append-only since Phase 2).
-- Rollback: docs/migrations/20261220000300_tests_marking.rollback.sql.

-- CreateEnum
CREATE TYPE "TestMarkingKind" AS ENUM ('FIRST', 'SECOND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TestMarkingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED');

-- CreateEnum
CREATE TYPE "TestReviewAction" AS ENUM ('APPROVED', 'RETURNED', 'SECOND_MARKING_REQUESTED', 'MARK_CHOSEN', 'UNLOCKED');

-- AlterTable
ALTER TABLE "TestSubmission" ADD COLUMN     "finalMarkingId" TEXT;

-- CreateTable
CREATE TABLE "TestMarkerAssignment" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" "TestMarkingKind" NOT NULL,
    "coachId" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reason" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" TEXT,

    CONSTRAINT "TestMarkerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestMarking" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" "TestMarkingKind" NOT NULL,
    "assignmentId" TEXT,
    "markerId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" "TestMarkingStatus" NOT NULL DEFAULT 'DRAFT',
    "totalMarks" INTEGER,
    "comment" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestMarking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestMarkingScore" (
    "id" TEXT NOT NULL,
    "markingId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "marks" INTEGER,
    "comment" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestMarkingScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestMarkChange" (
    "id" TEXT NOT NULL,
    "markingId" TEXT NOT NULL,
    "questionId" TEXT,
    "oldMarks" INTEGER,
    "newMarks" INTEGER,
    "changedById" TEXT,
    "changedByRole" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestMarkChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestReview" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "action" "TestReviewAction" NOT NULL,
    "markingId" TEXT,
    "chosenKind" "TestMarkingKind",
    "comment" TEXT,
    "fromStatus" "TestSubmissionStatus" NOT NULL,
    "toStatus" "TestSubmissionStatus" NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "clientKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestMarkerAssignment_submissionId_kind_idx" ON "TestMarkerAssignment"("submissionId", "kind");

-- CreateIndex
CREATE INDEX "TestMarkerAssignment_coachId_endedAt_idx" ON "TestMarkerAssignment"("coachId", "endedAt");

-- CreateIndex
CREATE INDEX "TestMarkerAssignment_assignedById_idx" ON "TestMarkerAssignment"("assignedById");

-- CreateIndex
CREATE INDEX "TestMarkerAssignment_endedById_idx" ON "TestMarkerAssignment"("endedById");

-- CreateIndex
CREATE UNIQUE INDEX "TestMarking_assignmentId_key" ON "TestMarking"("assignmentId");

-- CreateIndex
CREATE INDEX "TestMarking_submissionId_kind_idx" ON "TestMarking"("submissionId", "kind");

-- CreateIndex
CREATE INDEX "TestMarking_markerId_status_idx" ON "TestMarking"("markerId", "status");

-- CreateIndex
CREATE INDEX "TestMarking_versionId_idx" ON "TestMarking"("versionId");

-- CreateIndex
CREATE INDEX "TestMarkingScore_questionId_idx" ON "TestMarkingScore"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "TestMarkingScore_markingId_questionId_key" ON "TestMarkingScore"("markingId", "questionId");

-- CreateIndex
CREATE INDEX "TestMarkChange_markingId_createdAt_idx" ON "TestMarkChange"("markingId", "createdAt");

-- CreateIndex
CREATE INDEX "TestMarkChange_questionId_idx" ON "TestMarkChange"("questionId");

-- CreateIndex
CREATE INDEX "TestMarkChange_changedById_idx" ON "TestMarkChange"("changedById");

-- CreateIndex
CREATE INDEX "TestReview_submissionId_createdAt_idx" ON "TestReview"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "TestReview_markingId_idx" ON "TestReview"("markingId");

-- CreateIndex
CREATE INDEX "TestReview_actorId_idx" ON "TestReview"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "TestReview_submissionId_clientKey_key" ON "TestReview"("submissionId", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "TestSubmission_finalMarkingId_key" ON "TestSubmission"("finalMarkingId");

-- AddForeignKey
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_finalMarkingId_fkey" FOREIGN KEY ("finalMarkingId") REFERENCES "TestMarking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "TestMarkerAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_markerId_fkey" FOREIGN KEY ("markerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TestSubmissionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkingScore" ADD CONSTRAINT "TestMarkingScore_markingId_fkey" FOREIGN KEY ("markingId") REFERENCES "TestMarking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkingScore" ADD CONSTRAINT "TestMarkingScore_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TestQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkChange" ADD CONSTRAINT "TestMarkChange_markingId_fkey" FOREIGN KEY ("markingId") REFERENCES "TestMarking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkChange" ADD CONSTRAINT "TestMarkChange_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "TestQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestMarkChange" ADD CONSTRAINT "TestMarkChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestReview" ADD CONSTRAINT "TestReview_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestReview" ADD CONSTRAINT "TestReview_markingId_fkey" FOREIGN KEY ("markingId") REFERENCES "TestMarking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestReview" ADD CONSTRAINT "TestReview_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Assignments: FIRST or SECOND marking only; a known method; an ending always has its time and its reason; at most one
-- current assignment per submission and kind (concurrent assignments can never create two).
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_kind_markers" CHECK ("kind" IN ('FIRST', 'SECOND'));
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_method_known" CHECK ("method" IN ('DISTRIBUTION', 'MANUAL', 'REASSIGNMENT', 'SECOND_MARKING'));
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_ending_complete" CHECK (("endedAt" IS NULL) = ("endReason" IS NULL));
ALTER TABLE "TestMarkerAssignment" ADD CONSTRAINT "TestMarkerAssignment_reason_present" CHECK ("reason" IS NULL OR length(btrim("reason")) > 0);
CREATE UNIQUE INDEX "TestMarkerAssignment_one_current" ON "TestMarkerAssignment"("submissionId", "kind") WHERE "endedAt" IS NULL;

-- Markings: whole, non-negative marks; an ADJUSTMENT has no assignment, a FIRST / SECOND marking has one; a submitted or
-- approved marking has its total and its submission time; approvedAt exactly while APPROVED.
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_total_nonnegative" CHECK ("totalMarks" IS NULL OR "totalMarks" >= 0);
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_revision_positive" CHECK ("revision" >= 1);
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_assignment_matches_kind" CHECK (("kind" = 'ADJUSTMENT') = ("assignmentId" IS NULL));
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_submitted_complete" CHECK (
  "status" NOT IN ('SUBMITTED', 'APPROVED') OR ("totalMarks" IS NOT NULL AND "submittedAt" IS NOT NULL));
ALTER TABLE "TestMarking" ADD CONSTRAINT "TestMarking_approved_time" CHECK (("status" = 'APPROVED') = ("approvedAt" IS NOT NULL));
ALTER TABLE "TestMarkingScore" ADD CONSTRAINT "TestMarkingScore_marks_nonnegative" CHECK ("marks" IS NULL OR "marks" >= 0);
ALTER TABLE "TestMarkChange" ADD CONSTRAINT "TestMarkChange_marks_nonnegative" CHECK (("oldMarks" IS NULL OR "oldMarks" >= 0) AND ("newMarks" IS NULL OR "newMarks" >= 0));
ALTER TABLE "TestMarkChange" ADD CONSTRAINT "TestMarkChange_is_a_change" CHECK ("oldMarks" IS DISTINCT FROM "newMarks");
-- Reviews: a return, a choice and an unlock always say why; a choice names the marks chosen (and only a choice does).
ALTER TABLE "TestReview" ADD CONSTRAINT "TestReview_comment_required" CHECK (
  "action" NOT IN ('RETURNED', 'MARK_CHOSEN', 'UNLOCKED') OR ("comment" IS NOT NULL AND length(btrim("comment")) > 0));
ALTER TABLE "TestReview" ADD CONSTRAINT "TestReview_choice_complete" CHECK (("action" = 'MARK_CHOSEN') = ("chosenKind" IS NOT NULL));

-- An assignment is never deleted; while current, it may only be ended (time, who, why); its own facts never change; an
-- ended assignment never changes again. The only other permitted change: assignedById / endedById becoming NULL (ON
-- DELETE SET NULL of the account).
CREATE OR REPLACE FUNCTION test_marker_assignment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestMarkerAssignment is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW."id", NEW."submissionId", NEW."kind", NEW."coachId", NEW."assignedAt", NEW."method", NEW."reason")
     IS DISTINCT FROM (OLD."id", OLD."submissionId", OLD."kind", OLD."coachId", OLD."assignedAt", OLD."method", OLD."reason")
     OR (NEW."assignedById" IS DISTINCT FROM OLD."assignedById" AND NEW."assignedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'TestMarkerAssignment %: an assignment''s facts never change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."endedAt" IS NOT NULL AND (
       (NEW."endedAt", NEW."endReason") IS DISTINCT FROM (OLD."endedAt", OLD."endReason")
       OR (NEW."endedById" IS DISTINCT FROM OLD."endedById" AND NEW."endedById" IS NOT NULL)) THEN
    RAISE EXCEPTION 'TestMarkerAssignment % has ended: it never changes again', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_marker_assignment_guard
  BEFORE UPDATE OR DELETE ON "TestMarkerAssignment"
  FOR EACH ROW EXECUTE FUNCTION test_marker_assignment_guard();

-- A marking is never deleted and never moves to another submission, kind, assignment or marker; its total never exceeds
-- the test's maximum; once SUBMITTED or APPROVED its marks, comment and version marked never change (a return or an
-- unlock changes the status only).
CREATE OR REPLACE FUNCTION test_marking_guard() RETURNS trigger AS $$
DECLARE
  max_marks integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TestMarking is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."submissionId", NEW."kind", NEW."assignmentId", NEW."markerId", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."submissionId", OLD."kind", OLD."assignmentId", OLD."markerId", OLD."createdAt") THEN
      RAISE EXCEPTION 'TestMarking %: its submission, kind, assignment and marker never change', OLD."id" USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."status" IN ('SUBMITTED', 'APPROVED')
       AND (NEW."totalMarks", NEW."comment", NEW."versionId") IS DISTINCT FROM (OLD."totalMarks", OLD."comment", OLD."versionId") THEN
      RAISE EXCEPTION 'TestMarking % is %: its marks are locked', OLD."id", OLD."status" USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW."totalMarks" IS NOT NULL THEN
    SELECT t."maxMarks" INTO max_marks FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId" WHERE s."id" = NEW."submissionId";
    IF NEW."totalMarks" > max_marks THEN
      RAISE EXCEPTION 'TestMarking %: % marks exceed the test''s maximum of %', NEW."id", NEW."totalMarks", max_marks USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_marking_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "TestMarking"
  FOR EACH ROW EXECUTE FUNCTION test_marking_guard();

-- A question's marks: only while the marking is a DRAFT or RETURNED; only for a question of the marked test; never above
-- the question's maximum.
CREATE OR REPLACE FUNCTION test_marking_score_guard() RETURNS trigger AS $$
DECLARE
  marking_status text;
  marking_test text;
  question_test text;
  question_max integer;
BEGIN
  SELECT m."status"::text, s."testId" INTO marking_status, marking_test
    FROM "TestMarking" m JOIN "TestSubmission" s ON s."id" = m."submissionId"
   WHERE m."id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."markingId" ELSE NEW."markingId" END);
  IF marking_status NOT IN ('DRAFT', 'RETURNED') THEN
    RAISE EXCEPTION 'TestMarking is %: its marks are locked', marking_status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."markingId", NEW."questionId") IS DISTINCT FROM (OLD."markingId", OLD."questionId") THEN
    RAISE EXCEPTION 'TestMarkingScore %: its marking and question never change', OLD."id" USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT q."testId", q."maxMarks" INTO question_test, question_max FROM "TestQuestion" q WHERE q."id" = NEW."questionId";
  IF question_test IS DISTINCT FROM marking_test THEN
    RAISE EXCEPTION 'TestMarkingScore: question % is not a question of the marked test', NEW."questionId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."marks" > question_max THEN
    RAISE EXCEPTION 'TestMarkingScore: % marks exceed the question''s maximum of %', NEW."marks", question_max USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_marking_score_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "TestMarkingScore"
  FOR EACH ROW EXECUTE FUNCTION test_marking_score_guard();

-- The mark-change log: append-only; the only permitted change is changedById becoming NULL (account deleted).
CREATE OR REPLACE FUNCTION test_mark_change_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."changedById" IS NOT NULL AND NEW."changedById" IS NULL
     AND (NEW."id", NEW."markingId", NEW."questionId", NEW."oldMarks", NEW."newMarks", NEW."changedByRole", NEW."reason", NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."markingId", OLD."questionId", OLD."oldMarks", OLD."newMarks", OLD."changedByRole", OLD."reason", OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TestMarkChange is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_mark_change_append_only
  BEFORE UPDATE OR DELETE ON "TestMarkChange"
  FOR EACH ROW EXECUTE FUNCTION test_mark_change_append_only();

-- Review decisions: append-only; the only permitted change is actorId becoming NULL (account deleted).
CREATE OR REPLACE FUNCTION test_review_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
     AND (NEW."id", NEW."submissionId", NEW."action", NEW."markingId", NEW."chosenKind", NEW."comment", NEW."fromStatus", NEW."toStatus",
          NEW."actorRole", NEW."clientKey", NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."submissionId", OLD."action", OLD."markingId", OLD."chosenKind", OLD."comment", OLD."fromStatus", OLD."toStatus",
          OLD."actorRole", OLD."clientKey", OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TestReview is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_review_append_only
  BEFORE UPDATE OR DELETE ON "TestReview"
  FOR EACH ROW EXECUTE FUNCTION test_review_append_only();
