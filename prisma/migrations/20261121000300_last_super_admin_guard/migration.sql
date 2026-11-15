-- M4 (Phase 1, P1-08): the last active Super Administrator can never be removed
-- (plan §8.2, S4/AS2) — independently of the application, so direct SQL is
-- refused too.
--
-- A BEFORE UPDATE OR DELETE trigger on "User": when the row is an active
-- SUPER_ADMIN and the change would end that (role changed, deactivated, or the
-- row deleted), it first locks every active SUPER_ADMIN row (FOR UPDATE, so
-- concurrent demotions/suspensions/deletions are serialised), then refuses with
-- LAST_SUPER_ADMIN unless another active SUPER_ADMIN remains. With no Super
-- Admin at all (before the approved bootstrap) the trigger never fires.
-- No table, column or existing row changes. Explicit transaction: all or nothing.
-- Rollback: docs/migrations/20261121000300_last_super_admin_guard.rollback.sql

BEGIN;

CREATE OR REPLACE FUNCTION user_last_super_admin_guard() RETURNS trigger AS $$
DECLARE
  others int;
BEGIN
  IF OLD."role" <> 'SUPER_ADMIN' OR NOT OLD."isActive" THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."role" = 'SUPER_ADMIN' AND NEW."isActive" THEN
    RETURN NEW;   -- still an active Super Admin: nothing to protect
  END IF;

  -- Serialise against concurrent changes to the Super Admin set.
  PERFORM 1 FROM "User" WHERE "role" = 'SUPER_ADMIN' AND "isActive" FOR UPDATE;

  SELECT count(*) INTO others
    FROM "User"
   WHERE "role" = 'SUPER_ADMIN' AND "isActive" AND "id" <> OLD."id";
  IF others = 0 THEN
    RAISE EXCEPTION 'LAST_SUPER_ADMIN: at least one active Super Administrator must remain'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_last_super_admin_guard
  BEFORE UPDATE OR DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_last_super_admin_guard();

COMMIT;
