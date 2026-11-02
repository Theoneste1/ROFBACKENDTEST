-- Migration: add_school_and_home_location
--
-- Creates a normalised School lookup table and adds two nullable columns
-- to User (schoolId FK, homeLocation).  All existing rows are unaffected —
-- both columns default to NULL.

-- ─── 1. Create the School table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "School" (
    "id"        TEXT        NOT NULL,
    "name"      TEXT        NOT NULL,
    "location"  TEXT        NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- School name must be unique (normalised to title-case in application layer)
CREATE UNIQUE INDEX IF NOT EXISTS "School_name_key" ON "School"("name");
CREATE INDEX        IF NOT EXISTS "School_name_idx"  ON "School"("name");

-- ─── 2. Add nullable columns to User ─────────────────────────────────────────
ALTER TABLE "User"
    ADD COLUMN IF NOT EXISTS "schoolId"     TEXT,
    ADD COLUMN IF NOT EXISTS "homeLocation" TEXT;

-- ─── 3. Foreign key: User.schoolId → School.id ───────────────────────────────
--    SET NULL on delete so removing a school record does not delete users.
ALTER TABLE "User"
    ADD CONSTRAINT "User_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 4. Index on the FK for join performance ─────────────────────────────────
CREATE INDEX IF NOT EXISTS "User_schoolId_idx" ON "User"("schoolId");
