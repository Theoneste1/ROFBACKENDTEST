-- Coach programme-wide access (owner 2026-11-23). Additive only: one enum, one table. No existing row changes; a coach's
-- programme-wide access is computed from their programme memberships, minus the restrictions recorded here.
CREATE TYPE "CoachCapability" AS ENUM ('STUDENTS', 'COURSES', 'MARKING', 'RESULTS');

CREATE TABLE "CoachProgrammeRestriction" (
  "id" TEXT NOT NULL,
  "coachId" TEXT NOT NULL,
  "disciplineId" TEXT NOT NULL,
  "capability" "CoachCapability" NOT NULL,
  "reason" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "liftedAt" TIMESTAMP(3),
  "liftedById" TEXT,
  "liftReason" TEXT,
  CONSTRAINT "CoachProgrammeRestriction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoachProgrammeRestriction_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500)
);
CREATE INDEX "CoachProgrammeRestriction_coachId_liftedAt_idx" ON "CoachProgrammeRestriction"("coachId", "liftedAt");
CREATE INDEX "CoachProgrammeRestriction_disciplineId_capability_liftedAt_idx" ON "CoachProgrammeRestriction"("disciplineId", "capability", "liftedAt");
CREATE INDEX "CoachProgrammeRestriction_createdById_idx" ON "CoachProgrammeRestriction"("createdById");
CREATE INDEX "CoachProgrammeRestriction_liftedById_idx" ON "CoachProgrammeRestriction"("liftedById");
-- At most one ACTIVE restriction per coach, programme and capability (a lifted one stays as history).
CREATE UNIQUE INDEX "CoachProgrammeRestriction_one_active" ON "CoachProgrammeRestriction"("coachId", "disciplineId", "capability") WHERE "liftedAt" IS NULL;

ALTER TABLE "CoachProgrammeRestriction" ADD CONSTRAINT "CoachProgrammeRestriction_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachProgrammeRestriction" ADD CONSTRAINT "CoachProgrammeRestriction_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "Discipline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CoachProgrammeRestriction" ADD CONSTRAINT "CoachProgrammeRestriction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachProgrammeRestriction" ADD CONSTRAINT "CoachProgrammeRestriction_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Coaches mark their programme's tests by default from now on. A coach whose marking authorisation for a subject was
-- REVOKED (and not granted again) keeps that decision: it is carried over as a MARKING restriction of that programme,
-- with the original reason, by whoever revoked it. Coaches who were never authorised gain marking by default (owner).
INSERT INTO "CoachProgrammeRestriction" ("id", "coachId", "disciplineId", "capability", "reason", "createdById", "createdAt")
SELECT gen_random_uuid()::text, x."coachId", x."disciplineId", 'MARKING',
       left('Carried over from the revoked marking authorisation: ' || coalesce(nullif(btrim(x."revokeReason"), ''), 'no reason given'), 500),
       x."revokedById", now()
  FROM (
    SELECT DISTINCT ON (a."coachId", a."disciplineId") a."coachId", a."disciplineId", a."revokedById", a."revokeReason"
      FROM "MarkerAuthorization" a
     WHERE a."revokedAt" IS NOT NULL
     ORDER BY a."coachId", a."disciplineId", a."revokedAt" DESC
  ) x
  JOIN "User" u ON u."id" = x."coachId" AND u."role" = 'MENTOR'
 WHERE EXISTS (SELECT 1 FROM "ProgrammeMembership" m WHERE m."userId" = x."coachId" AND m."disciplineId" = x."disciplineId" AND m."isActive")
   AND NOT EXISTS (SELECT 1 FROM "MarkerAuthorization" b WHERE b."coachId" = x."coachId" AND b."disciplineId" = x."disciplineId" AND b."revokedAt" IS NULL);
