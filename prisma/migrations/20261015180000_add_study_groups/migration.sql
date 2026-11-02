-- Migration: add_study_groups
--
-- Creates StudyGroup and StudyGroupMember tables.
--
-- GroupRole is a local enum — it carries NO global authorization weight.
-- A user with groupRole = 'MENTOR' inside a study group is NOT a global Mentor
-- and cannot perform any globally-Mentor-restricted actions.

-- ─── 1. GroupRole enum ───────────────────────────────────────────────────────
CREATE TYPE "GroupRole" AS ENUM ('STUDENT', 'MENTOR');

-- ─── 2. StudyGroup table ─────────────────────────────────────────────────────
CREATE TABLE "StudyGroup" (
    "id"          TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "description" TEXT         NOT NULL,
    "tags"        TEXT,
    "isActive"    BOOLEAN      NOT NULL DEFAULT true,
    "createdById" TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudyGroup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StudyGroup_isActive_idx"    ON "StudyGroup"("isActive");
CREATE INDEX IF NOT EXISTS "StudyGroup_createdById_idx" ON "StudyGroup"("createdById");

ALTER TABLE "StudyGroup"
    ADD CONSTRAINT "StudyGroup_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. StudyGroupMember table ───────────────────────────────────────────────
CREATE TABLE "StudyGroupMember" (
    "id"          TEXT         NOT NULL,
    "groupId"     TEXT         NOT NULL,
    "userId"      TEXT         NOT NULL,
    "groupRole"   "GroupRole"  NOT NULL DEFAULT 'STUDENT',
    "joinedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt"   TIMESTAMP(3),
    "removedById" TEXT,

    CONSTRAINT "StudyGroupMember_pkey" PRIMARY KEY ("id")
);

-- One active membership record per (group × user).
CREATE UNIQUE INDEX IF NOT EXISTS "StudyGroupMember_groupId_userId_key"
    ON "StudyGroupMember"("groupId", "userId");

CREATE INDEX IF NOT EXISTS "StudyGroupMember_groupId_idx" ON "StudyGroupMember"("groupId");
CREATE INDEX IF NOT EXISTS "StudyGroupMember_userId_idx"  ON "StudyGroupMember"("userId");

ALTER TABLE "StudyGroupMember"
    ADD CONSTRAINT "StudyGroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "StudyGroup"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudyGroupMember"
    ADD CONSTRAINT "StudyGroupMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
