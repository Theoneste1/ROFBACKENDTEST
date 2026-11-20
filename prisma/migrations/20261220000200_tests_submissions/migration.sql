-- Test Management (WS3, owner spec and plan approved 2026-11-19), migration M-c (Phase 2): deadline extensions and
-- submissions with every version kept. NEW tables only — Test / TestQuestion / TestFile / MarkerAuthorization rows, the
-- course-assignment pipeline (Assignment, Submission, MentorReview …) and every existing row are untouched.
--
--   TestExtension               whole test, one student or one teacher; new deadline, mandatory reason, who granted it
--                               and when, edit, cancellation (who, when, reason). The test's own closesAt and
--                               originalClosesAt never change. At most one ACTIVE extension per target (partial unique
--                               indexes TestExtension_one_active_test / _student / _teacher).
--   TestSubmission              one per student per test; an opaque public code (shown to markers from Phase 3); the
--                               current version; the status (SUBMITTED in Phase 2; the full approved flow is in the enum).
--   TestSubmissionVersion       EVERY version, append-only (trigger): submitter, STUDENT or TEACHER, the teacher, the
--                               database time, the deadline that applied then, whether it came in under an extension,
--                               the typed answer and the number of pages; idempotent per client key.
--   TestAnswerPage              uploaded answer pages (FilePurpose TEST_ANSWER), one page at a time; pending until a
--                               version commits them, then never changed again (trigger).
--   TestSubmissionStatusChange  append-only status history (trigger).
--
-- Deadlines are computed by the application's TestDeadlineService from database time only.
-- Rollback: docs/migrations/20261220000200_tests_submissions.rollback.sql.

-- CreateEnum
CREATE TYPE "TestExtensionKind" AS ENUM ('TEST', 'STUDENT', 'TEACHER');

-- CreateEnum
CREATE TYPE "TestSubmissionStatus" AS ENUM ('SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'APPROVED', 'PUBLISHED', 'RETURNED', 'AWAITING_SECOND_MARKING');

-- CreateEnum
CREATE TYPE "TestSubmitterRole" AS ENUM ('STUDENT', 'TEACHER');

-- CreateTable
CREATE TABLE "TestExtension" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "kind" "TestExtensionKind" NOT NULL,
    "studentId" TEXT,
    "teacherId" TEXT,
    "newDeadline" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "editedById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "TestExtension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSubmission" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "publicCode" TEXT NOT NULL,
    "status" "TestSubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "currentVersionId" TEXT,
    "versionCount" INTEGER NOT NULL DEFAULT 0,
    "firstSubmittedAt" TIMESTAMP(3),
    "lastSubmittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSubmissionVersion" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "clientKey" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "submitterRole" "TestSubmitterRole" NOT NULL,
    "teacherId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "applicableDeadline" TIMESTAMP(3) NOT NULL,
    "underExtension" BOOLEAN NOT NULL,
    "extensionId" TEXT,
    "typedAnswer" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TestSubmissionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestAnswerPage" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "uploadKey" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploaderRole" "TestSubmitterRole" NOT NULL,
    "versionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestAnswerPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSubmissionStatusChange" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fromStatus" "TestSubmissionStatus",
    "toStatus" "TestSubmissionStatus" NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestSubmissionStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestExtension_testId_cancelledAt_idx" ON "TestExtension"("testId", "cancelledAt");

-- CreateIndex
CREATE INDEX "TestExtension_studentId_idx" ON "TestExtension"("studentId");

-- CreateIndex
CREATE INDEX "TestExtension_teacherId_idx" ON "TestExtension"("teacherId");

-- CreateIndex
CREATE INDEX "TestExtension_grantedById_idx" ON "TestExtension"("grantedById");

-- CreateIndex
CREATE INDEX "TestExtension_editedById_idx" ON "TestExtension"("editedById");

-- CreateIndex
CREATE INDEX "TestExtension_cancelledById_idx" ON "TestExtension"("cancelledById");

-- CreateIndex
CREATE UNIQUE INDEX "TestSubmission_publicCode_key" ON "TestSubmission"("publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "TestSubmission_currentVersionId_key" ON "TestSubmission"("currentVersionId");

-- CreateIndex
CREATE INDEX "TestSubmission_studentId_idx" ON "TestSubmission"("studentId");

-- CreateIndex
CREATE INDEX "TestSubmission_testId_status_idx" ON "TestSubmission"("testId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TestSubmission_testId_studentId_key" ON "TestSubmission"("testId", "studentId");

-- CreateIndex
CREATE INDEX "TestSubmissionVersion_submittedById_idx" ON "TestSubmissionVersion"("submittedById");

-- CreateIndex
CREATE INDEX "TestSubmissionVersion_teacherId_idx" ON "TestSubmissionVersion"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "TestSubmissionVersion_submissionId_number_key" ON "TestSubmissionVersion"("submissionId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TestSubmissionVersion_submissionId_clientKey_key" ON "TestSubmissionVersion"("submissionId", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "TestAnswerPage_fileId_key" ON "TestAnswerPage"("fileId");

-- CreateIndex
CREATE INDEX "TestAnswerPage_versionId_pageNumber_idx" ON "TestAnswerPage"("versionId", "pageNumber");

-- CreateIndex
CREATE INDEX "TestAnswerPage_studentId_idx" ON "TestAnswerPage"("studentId");

-- CreateIndex
CREATE INDEX "TestAnswerPage_uploadedById_idx" ON "TestAnswerPage"("uploadedById");

-- CreateIndex
CREATE UNIQUE INDEX "TestAnswerPage_testId_studentId_uploadKey_pageNumber_key" ON "TestAnswerPage"("testId", "studentId", "uploadKey", "pageNumber");

-- CreateIndex
CREATE INDEX "TestSubmissionStatusChange_submissionId_createdAt_idx" ON "TestSubmissionStatusChange"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "TestSubmissionStatusChange_actorId_idx" ON "TestSubmissionStatusChange"("actorId");

-- AddForeignKey
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "TestSubmissionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAnswerPage" ADD CONSTRAINT "TestAnswerPage_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAnswerPage" ADD CONSTRAINT "TestAnswerPage_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAnswerPage" ADD CONSTRAINT "TestAnswerPage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAnswerPage" ADD CONSTRAINT "TestAnswerPage_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAnswerPage" ADD CONSTRAINT "TestAnswerPage_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TestSubmissionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionStatusChange" ADD CONSTRAINT "TestSubmissionStatusChange_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionStatusChange" ADD CONSTRAINT "TestSubmissionStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The extension's target matches its kind; a cancellation always has its time and its reason; a reason is never blank.
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_target_matches_kind" CHECK (
  ("kind" = 'TEST'    AND "studentId" IS NULL     AND "teacherId" IS NULL) OR
  ("kind" = 'STUDENT' AND "studentId" IS NOT NULL AND "teacherId" IS NULL) OR
  ("kind" = 'TEACHER' AND "teacherId" IS NOT NULL AND "studentId" IS NULL));
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_cancellation_complete" CHECK (("cancelledAt" IS NULL) = ("cancelReason" IS NULL));
ALTER TABLE "TestExtension" ADD CONSTRAINT "TestExtension_reason_present" CHECK (length(btrim("reason")) > 0);
-- Versions are numbered from 1; a TEACHER version names the teacher, who is its submitter; every version has an answer.
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_versionCount_nonnegative" CHECK ("versionCount" >= 0);
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_number_positive" CHECK ("number" >= 1);
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_pageCount_nonnegative" CHECK ("pageCount" >= 0);
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_teacher_consistent" CHECK (
  (("submitterRole" = 'TEACHER') = ("teacherId" IS NOT NULL)) AND ("teacherId" IS NULL OR "teacherId" = "submittedById"));
ALTER TABLE "TestSubmissionVersion" ADD CONSTRAINT "TestSubmissionVersion_has_answer" CHECK ("typedAnswer" IS NOT NULL OR "pageCount" > 0);
ALTER TABLE "TestAnswerPage" ADD CONSTRAINT "TestAnswerPage_pageNumber_positive" CHECK ("pageNumber" >= 1);

-- At most one ACTIVE extension per target (concurrent grants can never create two).
CREATE UNIQUE INDEX "TestExtension_one_active_test" ON "TestExtension"("testId") WHERE "kind" = 'TEST' AND "cancelledAt" IS NULL;
CREATE UNIQUE INDEX "TestExtension_one_active_student" ON "TestExtension"("testId", "studentId") WHERE "kind" = 'STUDENT' AND "cancelledAt" IS NULL;
CREATE UNIQUE INDEX "TestExtension_one_active_teacher" ON "TestExtension"("testId", "teacherId") WHERE "kind" = 'TEACHER' AND "cancelledAt" IS NULL;

-- Every version is kept exactly as submitted: no UPDATE, no DELETE (TRUNCATE, used only by the test suite on its
-- disposable database, is not a row operation).
CREATE OR REPLACE FUNCTION test_submission_version_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TestSubmissionVersion is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_submission_version_append_only
  BEFORE UPDATE OR DELETE ON "TestSubmissionVersion"
  FOR EACH ROW EXECUTE FUNCTION test_submission_version_append_only();

-- Status history: append-only; the only permitted change is actorId becoming NULL (ON DELETE SET NULL of the account).
CREATE OR REPLACE FUNCTION test_submission_status_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
     AND (NEW."id", NEW."submissionId", NEW."fromStatus", NEW."toStatus", NEW."actorRole", NEW."reason", NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."submissionId", OLD."fromStatus", OLD."toStatus", OLD."actorRole", OLD."reason", OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TestSubmissionStatusChange is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_submission_status_append_only
  BEFORE UPDATE OR DELETE ON "TestSubmissionStatusChange"
  FOR EACH ROW EXECUTE FUNCTION test_submission_status_append_only();

-- A page that belongs to a version never changes again and is never removed (a pending page may be replaced, removed,
-- or committed — versionId set once).
CREATE OR REPLACE FUNCTION test_answer_page_committed_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."versionId" IS NOT NULL THEN
    RAISE EXCEPTION 'TestAnswerPage % belongs to a submitted version: % is not allowed', OLD."id", TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_answer_page_committed_guard
  BEFORE UPDATE OR DELETE ON "TestAnswerPage"
  FOR EACH ROW EXECUTE FUNCTION test_answer_page_committed_guard();
