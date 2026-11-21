-- Locked test submissions and resubmission authorizations (owner, 2026-11-21). A submitted answer is locked for the
-- student and their teachers (the services refuse another version); an Administrator may authorize ONE replacement at a
-- time, with a reason. The replacement uses the authorization (usedAt, usedVersionId) and is locked again. Additive:
-- one new table; existing submissions and versions are untouched (each is simply locked from now on).

-- CreateTable
CREATE TABLE "TestResubmissionAuthorization" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "authorizedById" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedVersionId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,

    CONSTRAINT "TestResubmissionAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TestResubmissionAuthorization_usedVersionId_key" ON "TestResubmissionAuthorization"("usedVersionId");

-- CreateIndex
CREATE INDEX "TestResubmissionAuthorization_submissionId_idx" ON "TestResubmissionAuthorization"("submissionId");

-- CreateIndex
CREATE INDEX "TestResubmissionAuthorization_authorizedById_idx" ON "TestResubmissionAuthorization"("authorizedById");

-- CreateIndex
CREATE INDEX "TestResubmissionAuthorization_cancelledById_idx" ON "TestResubmissionAuthorization"("cancelledById");

-- AddForeignKey
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TestSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_usedVersionId_fkey" FOREIGN KEY ("usedVersionId") REFERENCES "TestSubmissionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one OPEN authorization per submission (neither used nor cancelled).
CREATE UNIQUE INDEX "TestResubmissionAuthorization_one_open" ON "TestResubmissionAuthorization"("submissionId")
  WHERE "usedAt" IS NULL AND "cancelledAt" IS NULL;

-- A reason (3–500 characters); used or cancelled, never both; "used" always names the replacement version.
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_reason_length"
  CHECK (char_length("reason") BETWEEN 3 AND 500);
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_used_or_cancelled"
  CHECK (NOT ("usedAt" IS NOT NULL AND "cancelledAt" IS NOT NULL));
ALTER TABLE "TestResubmissionAuthorization" ADD CONSTRAINT "TestResubmissionAuthorization_used_version"
  CHECK (("usedAt" IS NULL) = ("usedVersionId" IS NULL));
