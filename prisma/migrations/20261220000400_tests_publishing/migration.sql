-- Test Management (WS3, owner spec and plan approved 2026-11-19), migration M-d part 2 (Phase 4): results publication with
-- the Administrator override, withdrawal of a published result on unlock (G6), and the design-only option to show
-- rankings to students. NEW tables, three new nullable / defaulted columns, CHECKs and guard triggers only — every
-- existing row, the Phase 1–3 tables' data and the course-assignment pipeline (Assignment, Submission, MentorReview …)
-- are untouched. Nothing is published by this migration (no submission is PUBLISHED before it: the pre-check says so).
--
--   TestPublication       one publication of a test's results: who, when, how many approved results it published, the
--                         counts seen at that moment, and — Administrators only, enforced by the API — the override of
--                         unapproved results with its mandatory reason (CHECK). Append-only (trigger).
--   TestResultWithdrawal  G6: an unlock of a PUBLISHED result withdraws it from the student's and teachers' views until it
--                         is approved and published again: the publication it left, the unlock decision (one per
--                         decision), who, when, why (CHECK). Append-only (trigger).
--   TestSubmission.publicationId / publishedAt
--                         the current publication of the result: set exactly while the status is PUBLISHED (CHECK).
--   Test.studentRankingsVisible
--                         DESIGN ONLY (owner spec 10.3): always false (CHECK Test_student_rankings_design_only); enabling
--                         rankings for students later = a migration dropping that CHECK + a reviewed API change.
-- Rollback: docs/migrations/20261220000400_tests_publishing.rollback.sql.

-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "studentRankingsVisible" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TestSubmission" ADD COLUMN     "publicationId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TestPublication" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "publishedById" TEXT,
    "actorRole" TEXT NOT NULL,
    "override" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "publishedCount" INTEGER NOT NULL,
    "counts" JSONB NOT NULL,
    "clientKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestResultWithdrawal" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "withdrawnById" TEXT,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestResultWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestPublication_publishedById_idx" ON "TestPublication"("publishedById");

-- CreateIndex
CREATE UNIQUE INDEX "TestPublication_testId_number_key" ON "TestPublication"("testId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TestPublication_testId_clientKey_key" ON "TestPublication"("testId", "clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "TestResultWithdrawal_reviewId_key" ON "TestResultWithdrawal"("reviewId");

-- CreateIndex
CREATE INDEX "TestResultWithdrawal_submissionId_createdAt_idx" ON "TestResultWithdrawal"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "TestResultWithdrawal_publicationId_idx" ON "TestResultWithdrawal"("publicationId");

-- CreateIndex
CREATE INDEX "TestResultWithdrawal_withdrawnById_idx" ON "TestResultWithdrawal"("withdrawnById");

-- CreateIndex
CREATE INDEX "TestSubmission_publicationId_idx" ON "TestSubmission"("publicationId");

-- AddForeignKey
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "TestPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPublication" ADD CONSTRAINT "TestPublication_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestPublication" ADD CONSTRAINT "TestPublication_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResultWithdrawal" ADD CONSTRAINT "TestResultWithdrawal_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResultWithdrawal" ADD CONSTRAINT "TestResultWithdrawal_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "TestPublication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResultWithdrawal" ADD CONSTRAINT "TestResultWithdrawal_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "TestReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResultWithdrawal" ADD CONSTRAINT "TestResultWithdrawal_withdrawnById_fkey" FOREIGN KEY ("withdrawnById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;




-- Publications: numbered from 1 per test; a non-negative count; the override carries its reason, and only an override
-- does (a blank reason is no reason); the counts snapshot is a JSON object.
ALTER TABLE "TestPublication" ADD CONSTRAINT "TestPublication_number_positive" CHECK ("number" >= 1);
ALTER TABLE "TestPublication" ADD CONSTRAINT "TestPublication_count_nonnegative" CHECK ("publishedCount" >= 0);
ALTER TABLE "TestPublication" ADD CONSTRAINT "TestPublication_override_reason" CHECK (
  ("override" AND "overrideReason" IS NOT NULL AND length(btrim("overrideReason")) > 0)
  OR (NOT "override" AND "overrideReason" IS NULL));
ALTER TABLE "TestPublication" ADD CONSTRAINT "TestPublication_counts_object" CHECK (jsonb_typeof("counts") = 'object');
-- Withdrawals always say why.
ALTER TABLE "TestResultWithdrawal" ADD CONSTRAINT "TestResultWithdrawal_reason_present" CHECK (length(btrim("reason")) > 0);
-- A result is published (visible to the student and their school's teachers) exactly while its status is PUBLISHED, and
-- then it names its publication and the time.
ALTER TABLE "TestSubmission" ADD CONSTRAINT "TestSubmission_published_state" CHECK (
  ("status" = 'PUBLISHED') = ("publicationId" IS NOT NULL) AND ("publicationId" IS NULL) = ("publishedAt" IS NULL));
-- Design only: rankings are never shown to students in this release.
ALTER TABLE "Test" ADD CONSTRAINT "Test_student_rankings_design_only" CHECK (NOT "studentRankingsVisible");

-- Publications: append-only; the only permitted change is publishedById becoming NULL (account deleted).
CREATE OR REPLACE FUNCTION test_publication_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."publishedById" IS NOT NULL AND NEW."publishedById" IS NULL
     AND (NEW."id", NEW."testId", NEW."number", NEW."actorRole", NEW."override", NEW."overrideReason", NEW."publishedCount",
          NEW."counts", NEW."clientKey", NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."testId", OLD."number", OLD."actorRole", OLD."override", OLD."overrideReason", OLD."publishedCount",
          OLD."counts", OLD."clientKey", OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TestPublication is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_publication_append_only
  BEFORE UPDATE OR DELETE ON "TestPublication"
  FOR EACH ROW EXECUTE FUNCTION test_publication_append_only();

-- Withdrawals: append-only; the only permitted change is withdrawnById becoming NULL (account deleted).
CREATE OR REPLACE FUNCTION test_result_withdrawal_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."withdrawnById" IS NOT NULL AND NEW."withdrawnById" IS NULL
     AND (NEW."id", NEW."submissionId", NEW."publicationId", NEW."reviewId", NEW."actorRole", NEW."reason", NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."submissionId", OLD."publicationId", OLD."reviewId", OLD."actorRole", OLD."reason", OLD."createdAt")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'TestResultWithdrawal is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_result_withdrawal_append_only
  BEFORE UPDATE OR DELETE ON "TestResultWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION test_result_withdrawal_append_only();
