-- Test Management (WS3, owner spec and plan approved 2026-11-19), migration M-b: the core tables. NEW tables only — the
-- course-assignment pipeline (Course, Assignment, Submission, MentorReview …) and every existing row are untouched.
--
--   Test                 title, subject (Discipline), division JUNIOR | SENIOR | ALL (mandatory, default ALL), answer
--                        format, opensAt / closesAt (+ originalClosesAt, kept when the deadline later moves), maxMarks
--                        (whole number, G7), status DRAFT | PUBLISHED, who created it.
--   TestQuestion         optional questions (order, prompt, whole-number maxMarks); their sum must equal Test.maxMarks
--                        before publishing (enforced by the application).
--   TestFile             the paper and the marking guide (one of each per test; private FileObjects).
--   MarkerAuthorization  coaches authorised to mark a subject (Admin or the subject's Head Coach; revoked with a reason;
--                        at most one active per coach and subject). Separate from coach olympiadInterests: an interest
--                        never grants marking.
--
-- Data: the Physics and Computing subjects (Discipline codes PHYSICS, COMPUTING) are created if missing (idempotent, by
-- code); Mathematics and every other Discipline row are left exactly as they are. The application's default programme
-- membership (new students and coaches join Mathematics) keeps working with three subjects (G3, same release).
-- Rollback: docs/migrations/20261220000100_tests_core.rollback.sql.

-- CreateEnum
CREATE TYPE "TestDivision" AS ENUM ('JUNIOR', 'SENIOR', 'ALL');

-- CreateEnum
CREATE TYPE "TestAnswerFormat" AS ENUM ('UPLOAD_ONLY', 'TYPED_ONLY', 'BOTH');

-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "TestFileKind" AS ENUM ('PAPER', 'MARKING_GUIDE');

-- CreateTable
CREATE TABLE "Test" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "disciplineId" TEXT NOT NULL,
    "division" "TestDivision" NOT NULL DEFAULT 'ALL',
    "answerFormat" "TestAnswerFormat" NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "originalClosesAt" TIMESTAMP(3) NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "status" "TestStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestQuestion" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestFile" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "kind" "TestFileKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarkerAuthorization" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "disciplineId" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantReason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "MarkerAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Test_disciplineId_status_idx" ON "Test"("disciplineId", "status");

-- CreateIndex
CREATE INDEX "Test_createdById_idx" ON "Test"("createdById");

-- CreateIndex
CREATE INDEX "Test_opensAt_idx" ON "Test"("opensAt");

-- CreateIndex
CREATE UNIQUE INDEX "TestQuestion_testId_order_key" ON "TestQuestion"("testId", "order");

-- CreateIndex
CREATE INDEX "TestFile_fileId_idx" ON "TestFile"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "TestFile_testId_kind_key" ON "TestFile"("testId", "kind");

-- CreateIndex
CREATE INDEX "MarkerAuthorization_disciplineId_revokedAt_idx" ON "MarkerAuthorization"("disciplineId", "revokedAt");

-- CreateIndex
CREATE INDEX "MarkerAuthorization_coachId_revokedAt_idx" ON "MarkerAuthorization"("coachId", "revokedAt");

-- CreateIndex
CREATE INDEX "MarkerAuthorization_grantedById_idx" ON "MarkerAuthorization"("grantedById");

-- CreateIndex
CREATE INDEX "MarkerAuthorization_revokedById_idx" ON "MarkerAuthorization"("revokedById");

-- AddForeignKey
ALTER TABLE "Test" ADD CONSTRAINT "Test_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Test" ADD CONSTRAINT "Test_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestQuestion" ADD CONSTRAINT "TestQuestion_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestFile" ADD CONSTRAINT "TestFile_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestFile" ADD CONSTRAINT "TestFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarkerAuthorization" ADD CONSTRAINT "MarkerAuthorization_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarkerAuthorization" ADD CONSTRAINT "MarkerAuthorization_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarkerAuthorization" ADD CONSTRAINT "MarkerAuthorization_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarkerAuthorization" ADD CONSTRAINT "MarkerAuthorization_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Whole-number marks, always positive; a test window that opens before it closes; questions numbered from 1.
ALTER TABLE "Test" ADD CONSTRAINT "Test_maxMarks_positive" CHECK ("maxMarks" > 0);
ALTER TABLE "Test" ADD CONSTRAINT "Test_window_valid" CHECK ("opensAt" < "closesAt");
ALTER TABLE "TestQuestion" ADD CONSTRAINT "TestQuestion_maxMarks_positive" CHECK ("maxMarks" > 0);
ALTER TABLE "TestQuestion" ADD CONSTRAINT "TestQuestion_order_positive" CHECK ("order" >= 1);
-- A revocation always has its time and its reason.
ALTER TABLE "MarkerAuthorization" ADD CONSTRAINT "MarkerAuthorization_revocation_complete"
  CHECK (("revokedAt" IS NULL) = ("revokeReason" IS NULL));

-- At most one ACTIVE authorisation per coach and subject (concurrent grants can never create two).
CREATE UNIQUE INDEX "MarkerAuthorization_one_active_per_coach_subject" ON "MarkerAuthorization"("coachId", "disciplineId") WHERE "revokedAt" IS NULL;

-- The Physics and Computing subjects (idempotent by code; an existing row is left exactly as it is).
INSERT INTO "Discipline" ("id", "code", "name", "description", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'PHYSICS',   'Physics',   'Olympiad physics.',   true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       (gen_random_uuid()::text, 'COMPUTING', 'Computing', 'Olympiad computing.', true, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
