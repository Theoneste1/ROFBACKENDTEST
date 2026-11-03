-- Additive only: no existing data is changed or removed.
--   AssignmentStatus gains CLOSED (published, no longer accepting submissions).
--   Assignment.description (short summary) and Assignment.closedAt.
--   AssignmentEvent: append-only assignment history, backfilled below from
--   the audit log so existing assignments keep their past.

-- CreateEnum
CREATE TYPE "AssignmentEventType" AS ENUM ('CREATED', 'UPDATED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'SUBMITTED_FOR_REVIEW', 'RECALLED', 'PUBLISHED', 'REJECTED', 'UNPUBLISHED', 'CLOSED', 'REOPENED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "AssignmentStatus" ADD VALUE 'CLOSED';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT;

-- CreateTable
CREATE TABLE "AssignmentEvent" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "type" "AssignmentEventType" NOT NULL,
    "fromStatus" "AssignmentStatus",
    "toStatus" "AssignmentStatus",
    "actorId" TEXT,
    "note" TEXT,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssignmentEvent_assignmentId_createdAt_idx" ON "AssignmentEvent"("assignmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AssignmentEvent_actorId_idx" ON "AssignmentEvent"("actorId");

-- AddForeignKey
ALTER TABLE "AssignmentEvent" ADD CONSTRAINT "AssignmentEvent_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentEvent" ADD CONSTRAINT "AssignmentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Backfill history from the audit log ────────────────────────────────────
INSERT INTO "AssignmentEvent" ("id", "assignmentId", "type", "toStatus", "actorId", "note", "changes", "createdAt")
SELECT gen_random_uuid()::text,
       a."id",
       m."type"::"AssignmentEventType",
       m."toStatus"::"AssignmentStatus",
       l."actorId",
       CASE WHEN l."action" = 'REJECT_ASSIGNMENT' THEN l."metadata"->>'rejectionNote' END,
       CASE WHEN l."action" IN ('UPDATE_ASSIGNMENT', 'REMOVE_ASSIGNMENT_FILE') THEN l."metadata" END,
       l."createdAt"
FROM "AuditLog" l
JOIN "Assignment" a ON a."id" = l."entityId"
JOIN (VALUES
  ('CREATE_ASSIGNMENT',            'CREATED',              'DRAFT'),
  ('UPDATE_ASSIGNMENT',            'UPDATED',              NULL),
  ('REMOVE_ASSIGNMENT_FILE',       'ATTACHMENT_REMOVED',   NULL),
  ('SUBMIT_ASSIGNMENT_FOR_REVIEW', 'SUBMITTED_FOR_REVIEW', 'PENDING_APPROVAL'),
  ('RECALL_ASSIGNMENT',            'RECALLED',             'DRAFT'),
  ('PUBLISH_ASSIGNMENT',           'PUBLISHED',            'PUBLISHED'),
  ('REJECT_ASSIGNMENT',            'REJECTED',             'REJECTED'),
  ('UNPUBLISH_ASSIGNMENT',         'UNPUBLISHED',          'DRAFT'),
  ('ARCHIVE_ASSIGNMENT',           'ARCHIVED',             'ARCHIVED')
) AS m("action", "type", "toStatus") ON m."action" = l."action"
WHERE l."entity" = 'Assignment';

-- Assignments created without an audit entry (e.g. seeded) still get a start.
INSERT INTO "AssignmentEvent" ("id", "assignmentId", "type", "toStatus", "actorId", "note", "createdAt")
SELECT gen_random_uuid()::text, a."id", 'CREATED', 'DRAFT', a."createdById", 'Recorded when history tracking was added', a."createdAt"
FROM "Assignment" a
WHERE NOT EXISTS (SELECT 1 FROM "AssignmentEvent" e WHERE e."assignmentId" = a."id" AND e."type" = 'CREATED');

-- ── Integrity ──────────────────────────────────────────────────────────────
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_closedAt_check"
  CHECK ("closedAt" IS NULL OR "publishedAt" IS NOT NULL);
