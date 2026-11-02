-- Migration: add_courses
--
-- Introduces a proper Course model (curriculum container) and links
-- Assignment to it via a courseId FK, replacing the old free-text "course"
-- column.
--
-- Safe migration path for existing Assignment rows:
--   1. Create CourseStatus enum.
--   2. Create Course table.
--   3. Seed one default course per distinct legacy "course" value so no
--      Assignment row is left without a valid FK.
--   4. Add courseId column (nullable initially), populate from the legacy
--      column, then add NOT NULL + FK + drop old column.

-- ─── 1. CourseStatus enum ─────────────────────────────────────────────────────
CREATE TYPE "CourseStatus" AS ENUM (
  'DRAFT',
  'PENDING_APPROVAL',
  'PUBLISHED',
  'REJECTED'
);

-- ─── 2. Course table ──────────────────────────────────────────────────────────
CREATE TABLE "Course" (
    "id"           TEXT          NOT NULL,
    "title"        TEXT          NOT NULL,
    "description"  TEXT          NOT NULL,
    "subject"      TEXT          NOT NULL,
    "status"       "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt"  TIMESTAMP(3),
    "publishedAt"  TIMESTAMP(3),
    "rejectedAt"   TIMESTAMP(3),
    "rejectionNote" TEXT,
    "createdById"  TEXT          NOT NULL,
    "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Course_status_idx"    ON "Course"("status");
CREATE INDEX IF NOT EXISTS "Course_createdById_idx" ON "Course"("createdById");
CREATE INDEX IF NOT EXISTS "Course_subject_idx"   ON "Course"("subject");

-- ─── 3. Seed a Course row for every distinct legacy "course" label ────────────
-- We need an admin user ID for createdById.  Use the first ADMIN, or if none
-- exists yet fall back to the first user, so the FK is satisfied.
DO $$
DECLARE
    v_admin_id TEXT;
BEGIN
    SELECT id INTO v_admin_id FROM "User" WHERE role = 'ADMIN' ORDER BY "createdAt" LIMIT 1;
    IF v_admin_id IS NULL THEN
        SELECT id INTO v_admin_id FROM "User" ORDER BY "createdAt" LIMIT 1;
    END IF;

    -- If there are no users at all (fresh DB), skip the seed — no Assignment
    -- rows exist either, so the FK population in step 4 is a no-op.
    IF v_admin_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO "Course" (id, title, description, subject, status, "publishedAt", "createdById", "createdAt", "updatedAt")
    SELECT
        gen_random_uuid()::text,
        a.course,
        'Migrated from legacy course label.',
        a.course,
        'PUBLISHED'::"CourseStatus",
        NOW(),
        v_admin_id,
        NOW(),
        NOW()
    FROM (SELECT DISTINCT course FROM "Assignment") a
    ON CONFLICT DO NOTHING;
END $$;

-- ─── 4. Add courseId to Assignment, populate it, make it NOT NULL ─────────────

-- 4a. Add nullable first
ALTER TABLE "Assignment" ADD COLUMN IF NOT EXISTS "courseId" TEXT;

-- 4b. Populate from the legacy course label (match by title)
UPDATE "Assignment" a
SET "courseId" = c.id
FROM "Course" c
WHERE c.title = a.course;

-- 4c. If any rows still have NULL courseId (shouldn't happen, but be safe),
--     assign the first available course.
UPDATE "Assignment"
SET "courseId" = (SELECT id FROM "Course" LIMIT 1)
WHERE "courseId" IS NULL
  AND EXISTS (SELECT 1 FROM "Course");

-- 4d. Now enforce NOT NULL
ALTER TABLE "Assignment" ALTER COLUMN "courseId" SET NOT NULL;

-- 4e. Drop the old free-text column
ALTER TABLE "Assignment" DROP COLUMN IF EXISTS "course";

-- 4f. FK + index
ALTER TABLE "Assignment"
    ADD CONSTRAINT "Assignment_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Assignment_courseId_idx" ON "Assignment"("courseId");

-- ─── 5. FK: Course.createdById → User.id ─────────────────────────────────────
ALTER TABLE "Course"
    ADD CONSTRAINT "Course_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
