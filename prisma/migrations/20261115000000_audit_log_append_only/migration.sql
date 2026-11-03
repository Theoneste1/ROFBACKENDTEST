-- Audit trail integrity. No existing audit data is changed except filling the
-- new actorUsername column.
--   AuditLog.actorUsername: the actor's username, kept even if the account is
--   later deleted (actorId is then cleared by ON DELETE SET NULL).
--   Trigger audit_log_fill_actor: fills actorUsername on every insert.
--   Trigger audit_log_append_only: rejects UPDATE and DELETE of audit rows. The
--   only permitted change is actorId becoming NULL with every other column
--   unchanged (the foreign key's ON DELETE SET NULL).
-- TRUNCATE (used only by the test suite on its disposable database) is not a
-- row operation and is unaffected.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorUsername" TEXT;

-- Backfill: the username of each existing entry's actor.
UPDATE "AuditLog" a
   SET "actorUsername" = u."username"
  FROM "User" u
 WHERE u."id" = a."actorId" AND a."actorUsername" IS NULL;

CREATE OR REPLACE FUNCTION audit_log_fill_actor() RETURNS trigger AS $$
BEGIN
  IF NEW."actorId" IS NOT NULL AND NEW."actorUsername" IS NULL THEN
    SELECT u."username" INTO NEW."actorUsername" FROM "User" u WHERE u."id" = NEW."actorId";
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_fill_actor
  BEFORE INSERT ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_fill_actor();

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
     AND (NEW."id", NEW."actorRole", NEW."actorUsername", NEW."action", NEW."entity", NEW."entityId", NEW."metadata"::text, NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."actorRole", OLD."actorUsername", OLD."action", OLD."entity", OLD."entityId", OLD."metadata"::text, OLD."createdAt")
  THEN
    -- The actor's account was deleted (ON DELETE SET NULL); the username stays.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
