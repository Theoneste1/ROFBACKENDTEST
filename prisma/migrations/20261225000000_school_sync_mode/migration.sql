-- School directory sync: what a run may propose (additive; existing runs keep FULL).
--   FULL      every difference with a matched school is proposed (S2 as approved 2026-11-11)
--   NEW_ONLY  schools already in the directory (matched by code) are recognised and left untouched;
--             only schools with a new official code are proposed
CREATE TYPE "SchoolSyncMode" AS ENUM ('FULL', 'NEW_ONLY');
ALTER TABLE "SchoolSyncRun" ADD COLUMN "mode" "SchoolSyncMode" NOT NULL DEFAULT 'FULL';
