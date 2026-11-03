-- Additive only: no data is changed or removed.
--   Course.discussionsEnabled  — admins can turn a course's discussions off (default: on).
--   CourseResource.author/source/year/tags — descriptive metadata for books, notes and past papers.

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "discussionsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CourseResource" ADD COLUMN     "author" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "year" INTEGER;

-- CreateIndex
CREATE INDEX "CourseResource_tags_idx" ON "CourseResource" USING GIN ("tags");


-- Sanity limits (also validated in the API).
ALTER TABLE "CourseResource" ADD CONSTRAINT "CourseResource_year_check"
  CHECK ("year" IS NULL OR "year" BETWEEN 1800 AND 2200);
ALTER TABLE "CourseResource" ADD CONSTRAINT "CourseResource_tags_check"
  CHECK (cardinality("tags") <= 20);
