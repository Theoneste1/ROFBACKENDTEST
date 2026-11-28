-- Submission reports (owner 2026-11-28): the corrections of a submission's test and/or level ("Reassign submission"),
-- append-only; and report sharing with schools, with an expiry and a revocation kept for the history. Additive: one new
-- table and four nullable columns; no existing row changes. Rollback: docs/migrations/20270103000000_submission_reports.rollback.sql.

-- AlterTable
ALTER TABLE "CustomReportGrant" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT,
ADD COLUMN     "schoolId" TEXT;

-- CreateTable
CREATE TABLE "TestSubmissionCorrection" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "fromTestId" TEXT NOT NULL,
    "fromTestTitle" TEXT NOT NULL,
    "fromSubjectId" TEXT NOT NULL,
    "fromSubjectName" TEXT NOT NULL,
    "fromTestDivision" TEXT NOT NULL,
    "fromLevel" TEXT,
    "toTestId" TEXT NOT NULL,
    "toTestTitle" TEXT NOT NULL,
    "toSubjectId" TEXT NOT NULL,
    "toSubjectName" TEXT NOT NULL,
    "toTestDivision" TEXT NOT NULL,
    "toLevel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestSubmissionCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestSubmissionCorrection_submissionId_createdAt_idx" ON "TestSubmissionCorrection"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "CustomReportGrant_schoolId_idx" ON "CustomReportGrant"("schoolId");

-- AddForeignKey
ALTER TABLE "CustomReportGrant" ADD CONSTRAINT "CustomReportGrant_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionCorrection" ADD CONSTRAINT "TestSubmissionCorrection_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSubmissionCorrection" ADD CONSTRAINT "TestSubmissionCorrection_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A grant names exactly one grantee — a user, a role or (new) a school — matching its key.
ALTER TABLE "CustomReportGrant" DROP CONSTRAINT "CustomReportGrant_one_grantee";
ALTER TABLE "CustomReportGrant" ADD CONSTRAINT "CustomReportGrant_one_grantee"
  CHECK (("userId" IS NOT NULL AND "role" IS NULL AND "schoolId" IS NULL AND "grantee" = 'user:' || "userId")
      OR ("userId" IS NULL AND "role" IS NOT NULL AND "schoolId" IS NULL AND "grantee" = 'role:' || "role"::text)
      OR ("userId" IS NULL AND "role" IS NULL AND "schoolId" IS NOT NULL AND "grantee" = 'school:' || "schoolId"));

-- A correction is history: never changed or removed.
CREATE OR REPLACE FUNCTION test_submission_correction_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TestSubmissionCorrection % is append-only: % is not allowed', OLD."id", TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER test_submission_correction_append_only
  BEFORE UPDATE OR DELETE ON "TestSubmissionCorrection"
  FOR EACH ROW EXECUTE FUNCTION test_submission_correction_append_only();
