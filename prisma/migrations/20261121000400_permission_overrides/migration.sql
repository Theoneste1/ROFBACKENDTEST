-- M5 (Phase 1, P1-09): individual permission overrides (plan §6.3, §6.4).
-- Additive only: one enum and one table; no existing table, column or row changes.
-- Explicit transaction: everything is created together or not at all.
-- Rollback: docs/migrations/20261121000400_permission_overrides.rollback.sql

BEGIN;

-- CreateEnum
CREATE TYPE "OverrideEffect" AS ENUM ('GRANT', 'DENY');
-- CreateTable
CREATE TABLE "UserPermissionOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "OverrideEffect" NOT NULL,
    "courseId" TEXT,
    "divisionId" TEXT,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    "expiryRecordedAt" TIMESTAMP(3),
    CONSTRAINT "UserPermissionOverride_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "UserPermissionOverride_userId_revokedAt_idx" ON "UserPermissionOverride"("userId", "revokedAt");
-- CreateIndex
CREATE INDEX "UserPermissionOverride_expiresAt_idx" ON "UserPermissionOverride"("expiresAt");
-- CreateIndex
CREATE INDEX "UserPermissionOverride_createdById_idx" ON "UserPermissionOverride"("createdById");
-- CreateIndex
CREATE INDEX "UserPermissionOverride_revokedById_idx" ON "UserPermissionOverride"("revokedById");
-- CreateIndex
CREATE INDEX "UserPermissionOverride_courseId_idx" ON "UserPermissionOverride"("courseId");
-- CreateIndex
CREATE INDEX "UserPermissionOverride_divisionId_idx" ON "UserPermissionOverride"("divisionId");
-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
