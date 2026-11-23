-- Registration data (owner 2026-11-23). Additive only: one nullable column, one new table. No existing row is removed.

-- 1. The coach application → the Coach account its approval created.
ALTER TABLE "MentorRequest" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "MentorRequest_userId_key" ON "MentorRequest"("userId");
ALTER TABLE "MentorRequest" ADD CONSTRAINT "MentorRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Earlier approvals: the account named by the approval's own audit entry (metadata.newUserId) — exact, not guessed.
-- One application per account (the latest approval wins if an account was ever named twice).
UPDATE "MentorRequest" mr
SET "userId" = a.uid
FROM (
  SELECT DISTINCT ON (al."metadata"->>'newUserId') al."entityId" AS request_id, al."metadata"->>'newUserId' AS uid
  FROM "AuditLog" al
  JOIN "User" u ON u."id" = al."metadata"->>'newUserId'
  WHERE al."action" = 'APPROVE_MENTOR_REQUEST' AND al."entity" = 'MentorRequest' AND al."metadata" ? 'newUserId'
  ORDER BY al."metadata"->>'newUserId', al."createdAt" DESC
) a
WHERE mr."id" = a.request_id AND mr."status" = 'APPROVED' AND mr."userId" IS NULL;

-- Approved applications without such an entry (approved before it recorded the account): the account with the same
-- e-mail address that is (or was promoted from) a Coach, when exactly one application and one account match.
UPDATE "MentorRequest" mr
SET "userId" = u."id"
FROM "User" u
WHERE mr."status" = 'APPROVED' AND mr."userId" IS NULL
  AND lower(u."email") = lower(mr."email") AND u."role" IN ('MENTOR', 'HEAD_COACH')
  AND NOT EXISTS (SELECT 1 FROM "MentorRequest" o WHERE o."userId" = u."id")
  AND (SELECT count(*) FROM "MentorRequest" o2 WHERE o2."status" = 'APPROVED' AND lower(o2."email") = lower(mr."email")) = 1;

-- 2. Saved filters.
CREATE TABLE "RegistrationSavedFilter" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "filter" JSONB NOT NULL,
  "columns" JSONB NOT NULL,
  "sort" JSONB NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegistrationSavedFilter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RegistrationSavedFilter_ownerId_name_key" ON "RegistrationSavedFilter"("ownerId", "name");
CREATE INDEX "RegistrationSavedFilter_shared_idx" ON "RegistrationSavedFilter"("shared");
ALTER TABLE "RegistrationSavedFilter" ADD CONSTRAINT "RegistrationSavedFilter_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
