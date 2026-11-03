-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: account_activation                      (additive, data-preserving)
--
-- Adds account activation (admin invitations and optional e-mail verification):
--   • User.activatedAt — NULL means the account has not been activated yet
--   • AccountActivationToken — single-use activation links (hash only)
--
-- BACKFILL: every existing account that has a password is treated as already
-- activated (activatedAt = createdAt), so nobody who can log in today is
-- locked out by this change. Nothing is dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "ActivationPurpose" AS ENUM ('INVITATION', 'EMAIL_VERIFICATION');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "activatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AccountActivationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "ActivationPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountActivationToken_tokenHash_key" ON "AccountActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccountActivationToken_userId_idx" ON "AccountActivationToken"("userId");

-- CreateIndex
CREATE INDEX "AccountActivationToken_expiresAt_idx" ON "AccountActivationToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "AccountActivationToken" ADD CONSTRAINT "AccountActivationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountActivationToken" ADD CONSTRAINT "AccountActivationToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- BACKFILL: existing accounts with a password keep working.
UPDATE "User" SET "activatedAt" = "createdAt" WHERE "passwordHash" IS NOT NULL AND "activatedAt" IS NULL;
