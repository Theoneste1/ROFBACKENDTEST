-- Account states (2026-11-16): ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED, with a history of every change.
-- Additive: one enum, one column with a default, one table, indexes and a trigger. No row is deleted.
--
-- Backfill: accounts with isActive = false were "suspended" (the only blocked state until now) and become
-- SUSPENDED; every other account is ACTIVE (the column default).
--
-- user_account_status_sync keeps isActive = (accountStatus = 'ACTIVE') on every INSERT and UPDATE, whichever of
-- the two a statement writes, so every existing check on isActive — login, refresh, the JWT guard, the M4
-- last-Super-Admin trigger and the Super Admin boundary — applies to every blocked state. Its name sorts before
-- user_last_super_admin_guard, so PostgreSQL runs it first (BEFORE triggers fire in name order) and the guard
-- sees the synchronised isActive.
-- Rollback: docs/migrations/20261206000000_account_states.rollback.sql

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'SUSPENDED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

-- Backfill (before the sync trigger exists).
UPDATE "User" SET "accountStatus" = 'SUSPENDED' WHERE "isActive" = false;

-- CreateTable
CREATE TABLE "UserStatusChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromStatus" "AccountStatus" NOT NULL,
    "toStatus" "AccountStatus" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "operationId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserStatusChange_userId_createdAt_idx" ON "UserStatusChange"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserStatusChange_operationId_idx" ON "UserStatusChange"("operationId");

-- CreateIndex
CREATE INDEX "User_accountStatus_idx" ON "User"("accountStatus");

-- CreateIndex
CREATE INDEX "User_role_accountStatus_idx" ON "User"("role", "accountStatus");

-- AddForeignKey
ALTER TABLE "UserStatusChange" ADD CONSTRAINT "UserStatusChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStatusChange" ADD CONSTRAINT "UserStatusChange_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- isActive ⇄ accountStatus, for every writer (the application, scripts, direct SQL).
--   accountStatus written → isActive follows it.
--   only isActive written → true means ACTIVE; false keeps a blocked state, or makes an ACTIVE account SUSPENDED
--   (today's meaning of isActive = false).
CREATE OR REPLACE FUNCTION user_account_status_sync() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."accountStatus" <> 'ACTIVE' THEN
      NEW."isActive" := false;
    ELSIF NOT NEW."isActive" THEN
      NEW."accountStatus" := 'SUSPENDED';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."accountStatus" IS DISTINCT FROM OLD."accountStatus" THEN
    NEW."isActive" := (NEW."accountStatus" = 'ACTIVE');
  ELSIF NEW."isActive" IS DISTINCT FROM OLD."isActive" THEN
    IF NEW."isActive" THEN
      NEW."accountStatus" := 'ACTIVE';
    ELSIF OLD."accountStatus" = 'ACTIVE' THEN
      NEW."accountStatus" := 'SUSPENDED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_account_status_sync
  BEFORE INSERT OR UPDATE ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_account_status_sync();
