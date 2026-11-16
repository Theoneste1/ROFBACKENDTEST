-- Profile pictures: a new file purpose and a reference from the account to its current picture.
-- Additive: one enum value, one nullable column (unique; ON DELETE SET NULL). Existing accounts get no
-- picture and keep their avatarUrl (if any) unchanged. The reference keeps the current picture out of the
-- nightly orphan-file cleanup; a replaced or removed picture loses it and is cleaned like any other orphan.
-- Rollback: docs/migrations/20261205000000_avatar_file_purpose.rollback.sql
-- IF NOT EXISTS: the rollback cannot drop an enum value (PostgreSQL), so a re-deploy after a rollback must not add
-- AVATAR again. Changed 2026-11-17 (before any production run); see docs/migrations/README.md for the checksum note.

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'AVATAR';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarFileId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_avatarFileId_key" ON "User"("avatarFileId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_avatarFileId_fkey" FOREIGN KEY ("avatarFileId") REFERENCES "FileObject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
