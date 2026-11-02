-- Migration: add_course_resources
--
-- Adds ResourceType enum and CourseResource table.
-- Resources (books, notes, past papers, etc.) are nested inside courses.

-- ─── 1. ResourceType enum ─────────────────────────────────────────────────────
CREATE TYPE "ResourceType" AS ENUM (
  'BOOK',
  'EBOOK',
  'NOTE',
  'PAST_PAPER',
  'ATTACHMENT'
);

-- ─── 2. CourseResource table ──────────────────────────────────────────────────
CREATE TABLE "CourseResource" (
    "id"               TEXT          NOT NULL,
    "courseId"         TEXT          NOT NULL,
    "type"             "ResourceType" NOT NULL,
    "title"            TEXT          NOT NULL,
    "description"      TEXT,
    "fileUrl"          TEXT,
    "originalFilename" TEXT,
    "mimeType"         TEXT,
    "fileSize"         INTEGER,
    "sortOrder"        INTEGER       NOT NULL DEFAULT 0,
    "isPublished"      BOOLEAN       NOT NULL DEFAULT false,
    "publishedAt"      TIMESTAMP(3),
    "uploadedById"     TEXT          NOT NULL,
    "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseResource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourseResource_courseId_idx"    ON "CourseResource"("courseId");
CREATE INDEX "CourseResource_type_idx"        ON "CourseResource"("type");
CREATE INDEX "CourseResource_isPublished_idx" ON "CourseResource"("isPublished");
CREATE INDEX "CourseResource_sortOrder_idx"   ON "CourseResource"("sortOrder");

ALTER TABLE "CourseResource"
    ADD CONSTRAINT "CourseResource_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseResource"
    ADD CONSTRAINT "CourseResource_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
