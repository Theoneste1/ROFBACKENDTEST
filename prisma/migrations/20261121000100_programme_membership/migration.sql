-- M2 (Phase 1, P1-07): programme membership (plan §7.1).
-- Programme = existing Discipline row (Mathematics keeps its id). Additive only:
-- one new enum and one new table; no existing table, column or constraint changes.
-- Rollback: docs/migrations/20261121000100_programme_membership.rollback.sql

-- CreateEnum
CREATE TYPE "MembershipSource" AS ENUM ('BACKFILL', 'MANUAL');
-- CreateTable
CREATE TABLE "ProgrammeMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "disciplineId" TEXT NOT NULL,
    "source" "MembershipSource" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    CONSTRAINT "ProgrammeMembership_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "ProgrammeMembership_disciplineId_isActive_idx" ON "ProgrammeMembership"("disciplineId", "isActive");
-- CreateIndex
CREATE INDEX "ProgrammeMembership_addedById_idx" ON "ProgrammeMembership"("addedById");
-- CreateIndex
CREATE INDEX "ProgrammeMembership_endedById_idx" ON "ProgrammeMembership"("endedById");
-- CreateIndex
CREATE UNIQUE INDEX "ProgrammeMembership_userId_disciplineId_key" ON "ProgrammeMembership"("userId", "disciplineId");
-- AddForeignKey
ALTER TABLE "ProgrammeMembership" ADD CONSTRAINT "ProgrammeMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgrammeMembership" ADD CONSTRAINT "ProgrammeMembership_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgrammeMembership" ADD CONSTRAINT "ProgrammeMembership_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ProgrammeMembership" ADD CONSTRAINT "ProgrammeMembership_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
