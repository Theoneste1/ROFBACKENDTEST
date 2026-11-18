-- Application details and "request more information" (2026-11-17; ADR-009; REG-05, REG-06, REG-10).
-- Additive only: nullable columns on TeacherApplication (position, yearsOfExperience) and MentorRequest (phone, rejectionReason,
-- affiliation, expertise, relevantExperience, yearsOfExperience), and the ApplicationInfoRequest table. No existing
-- row changes. An information request keeps the application PENDING (the one-PENDING-per-identity indexes and the
-- approve / reject paths are unchanged).
-- Database rules the Prisma schema cannot express (documented on the model):
--   * exactly one of teacherApplicationId / mentorRequestId;
--   * at most one OPEN request (not answered, not cancelled) per application (partial unique indexes);
--   * years of experience 0–60.
-- Also (REG-02, 2026-11-18, before any shared run): an optional profile picture on both applications (avatarFileId,
-- unique, ON DELETE SET NULL), moved to the account on approval.
-- Explicit transaction: everything is created together or not at all.
-- Rollback: docs/migrations/20261209000000_application_details.rollback.sql
BEGIN;
-- AlterTable
ALTER TABLE "MentorRequest" ADD COLUMN     "affiliation" TEXT,
ADD COLUMN     "avatarFileId" TEXT,
ADD COLUMN     "expertise" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "relevantExperience" TEXT,
ADD COLUMN     "yearsOfExperience" INTEGER;

-- AlterTable
ALTER TABLE "TeacherApplication" ADD COLUMN     "avatarFileId" TEXT,
ADD COLUMN     "position" TEXT,
ADD COLUMN     "yearsOfExperience" INTEGER;

-- CreateTable
CREATE TABLE "ApplicationInfoRequest" (
    "id" TEXT NOT NULL,
    "teacherApplicationId" TEXT,
    "mentorRequestId" TEXT,
    "question" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "ApplicationInfoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationInfoRequest_tokenHash_key" ON "ApplicationInfoRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "ApplicationInfoRequest_teacherApplicationId_requestedAt_idx" ON "ApplicationInfoRequest"("teacherApplicationId", "requestedAt");

-- CreateIndex
CREATE INDEX "ApplicationInfoRequest_mentorRequestId_requestedAt_idx" ON "ApplicationInfoRequest"("mentorRequestId", "requestedAt");

-- CreateIndex
CREATE INDEX "ApplicationInfoRequest_requestedById_idx" ON "ApplicationInfoRequest"("requestedById");

-- AddForeignKey
ALTER TABLE "ApplicationInfoRequest" ADD CONSTRAINT "ApplicationInfoRequest_teacherApplicationId_fkey" FOREIGN KEY ("teacherApplicationId") REFERENCES "TeacherApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationInfoRequest" ADD CONSTRAINT "ApplicationInfoRequest_mentorRequestId_fkey" FOREIGN KEY ("mentorRequestId") REFERENCES "MentorRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationInfoRequest" ADD CONSTRAINT "ApplicationInfoRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Profile pictures of applications (REG-02).
CREATE UNIQUE INDEX "TeacherApplication_avatarFileId_key" ON "TeacherApplication"("avatarFileId");
CREATE UNIQUE INDEX "MentorRequest_avatarFileId_key" ON "MentorRequest"("avatarFileId");
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_avatarFileId_fkey" FOREIGN KEY ("avatarFileId") REFERENCES "FileObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MentorRequest" ADD CONSTRAINT "MentorRequest_avatarFileId_fkey" FOREIGN KEY ("avatarFileId") REFERENCES "FileObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rules (see the header).
ALTER TABLE "ApplicationInfoRequest" ADD CONSTRAINT "ApplicationInfoRequest_one_application_check"
  CHECK (("teacherApplicationId" IS NULL) <> ("mentorRequestId" IS NULL));
CREATE UNIQUE INDEX "ApplicationInfoRequest_open_teacher_key" ON "ApplicationInfoRequest"("teacherApplicationId")
  WHERE "answeredAt" IS NULL AND "cancelledAt" IS NULL AND "teacherApplicationId" IS NOT NULL;
CREATE UNIQUE INDEX "ApplicationInfoRequest_open_mentor_key" ON "ApplicationInfoRequest"("mentorRequestId")
  WHERE "answeredAt" IS NULL AND "cancelledAt" IS NULL AND "mentorRequestId" IS NOT NULL;
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_yearsOfExperience_check"
  CHECK ("yearsOfExperience" IS NULL OR "yearsOfExperience" BETWEEN 0 AND 60);
ALTER TABLE "MentorRequest" ADD CONSTRAINT "MentorRequest_yearsOfExperience_check"
  CHECK ("yearsOfExperience" IS NULL OR "yearsOfExperience" BETWEEN 0 AND 60);

COMMIT;

-- One coach application per attempt (2026-11-18, final review): a reapplication after a rejection is a NEW row, so an
-- earlier attempt's questions and answers stay with that attempt and never appear as another applicant's history.
-- The username and e-mail stay unique among applications that are not REJECTED (at most one PENDING or APPROVED
-- application per username and per e-mail), like TeacherApplication's partial unique indexes.
DROP INDEX IF EXISTS "MentorRequest_username_key";
DROP INDEX IF EXISTS "MentorRequest_email_key";
CREATE UNIQUE INDEX "MentorRequest_active_username_key" ON "MentorRequest"("username") WHERE "status" <> 'REJECTED';
CREATE UNIQUE INDEX "MentorRequest_active_email_key" ON "MentorRequest"("email") WHERE "status" <> 'REJECTED';
CREATE INDEX "MentorRequest_username_idx" ON "MentorRequest"("username");
CREATE INDEX "MentorRequest_email_idx" ON "MentorRequest"("email");
