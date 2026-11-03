-- Additive only: three new columns with safe defaults. No data is changed.
--   User.failedLoginCount / lockedUntil: per-account login lockout.
--   User.tokensValidAfter: access tokens issued earlier are rejected.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "tokensValidAfter" TIMESTAMP(3);

