-- Teacher self-registration (owner-approved, after Phase 1 M1–M14): Teacher applications reviewed by an
-- Administrator. Additive only: two enums, one table, two nullable User columns (phone, country — set when
-- an application is approved); no existing row changes.
--
-- At most one PENDING application per username and per e-mail, enforced by the database too (two partial
-- unique indexes, WHERE status = 'PENDING'): a REJECTED or APPROVED application never blocks a new one.
-- Prisma's schema language cannot express them without a preview feature, so they are created here only
-- (like M4/M10's functions and triggers) and documented on the model; `prisma migrate diff` does not
-- report them as drift (verified locally).
--
-- Explicit transaction: everything is created together or not at all.
-- Rollback: docs/migrations/20261201000000_teacher_applications.rollback.sql

BEGIN;
-- CreateEnum
CREATE TYPE "TeacherApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OlympiadSubject" AS ENUM ('MATHEMATICS', 'COMPUTING', 'PHYSICS');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "country" TEXT,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "TeacherApplication" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "phone" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "olympiadInterests" "OlympiadSubject"[],
    "status" "TeacherApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "schoolId" TEXT,
    "proposedSchoolName" TEXT,
    "schoolProvince" TEXT NOT NULL,
    "schoolDistrict" TEXT NOT NULL,
    "schoolSector" TEXT,
    "homeDistrict" TEXT NOT NULL,
    "homeSector" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "rejectionReason" TEXT,
    "decisionNote" TEXT,
    "userId" TEXT,
    "assignedSchoolId" TEXT,

    CONSTRAINT "TeacherApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherApplication_userId_key" ON "TeacherApplication"("userId");

-- CreateIndex
CREATE INDEX "TeacherApplication_status_createdAt_idx" ON "TeacherApplication"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TeacherApplication_schoolId_idx" ON "TeacherApplication"("schoolId");

-- CreateIndex
CREATE INDEX "TeacherApplication_assignedSchoolId_idx" ON "TeacherApplication"("assignedSchoolId");

-- CreateIndex
CREATE INDEX "TeacherApplication_decidedById_idx" ON "TeacherApplication"("decidedById");

-- AddForeignKey
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_assignedSchoolId_fkey" FOREIGN KEY ("assignedSchoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One PENDING application per username / e-mail (partial unique indexes, see above).
CREATE UNIQUE INDEX "TeacherApplication_pending_username_key" ON "TeacherApplication"("username") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "TeacherApplication_pending_email_key" ON "TeacherApplication"("email") WHERE "status" = 'PENDING';

COMMIT;
