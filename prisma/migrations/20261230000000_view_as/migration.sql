-- "View as" (owner decision 2026-11-23): an administrator views the platform as a lower-ranked user, read only.
-- Additive: one new table. Rollback: docs/migrations/20261230000000_view_as.rollback.sql.
CREATE TABLE "ViewAsSession" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT,
    "ticketHash" TEXT,
    "ticketExpiresAt" TIMESTAMP(3) NOT NULL,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,

    CONSTRAINT "ViewAsSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ViewAsSession_ticketHash_key" ON "ViewAsSession"("ticketHash");
CREATE INDEX "ViewAsSession_actorId_createdAt_idx" ON "ViewAsSession"("actorId", "createdAt");
CREATE INDEX "ViewAsSession_targetId_createdAt_idx" ON "ViewAsSession"("targetId", "createdAt");

ALTER TABLE "ViewAsSession" ADD CONSTRAINT "ViewAsSession_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ViewAsSession" ADD CONSTRAINT "ViewAsSession_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
