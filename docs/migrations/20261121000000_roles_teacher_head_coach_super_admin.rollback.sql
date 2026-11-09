-- Rollback for M1 (20261121000000_roles_teacher_head_coach_super_admin).
--
-- PostgreSQL cannot drop an enum value, so the type is recreated without the
-- three values. Safe ONLY while no row uses them: the first block aborts the
-- whole transaction otherwise. Run manually, with approval, in one transaction;
-- it also removes the migration's row so `prisma migrate` matches again.
--
-- Objects that compare a column with a "Role" literal (e.g. the CHECK
-- constraint User_student_division_check, or a partial index) are dropped and
-- re-created against the recreated type, so none is lost. Rehearsed on a local
-- disposable database (apply → rollback refused while in use → rollback →
-- re-apply → no schema drift).
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "role"::text IN ('TEACHER', 'HEAD_COACH', 'SUPER_ADMIN')) THEN
    RAISE EXCEPTION 'M1 rollback refused: accounts hold TEACHER, HEAD_COACH or SUPER_ADMIN';
  END IF;
END $$;

ALTER TYPE "Role" RENAME TO "Role_m1";
CREATE TYPE "Role" AS ENUM ('STUDENT', 'MENTOR', 'ADMIN');

DO $$
DECLARE
  c         record;
  chk_tbl   text[] := ARRAY[]::text[];
  chk_name  text[] := ARRAY[]::text[];
  chk_body  text[] := ARRAY[]::text[];
  idx_body  text[] := ARRAY[]::text[];
  stmt      text;
  n         int;
BEGIN
  -- 1. Save and drop CHECK constraints and indexes whose definition uses the old type.
  FOR c IN
    SELECT con.conname AS cname, cls.relname AS tname, pg_get_constraintdef(con.oid) AS cbody
      FROM pg_constraint con JOIN pg_class cls ON cls.oid = con.conrelid
     WHERE con.contype = 'c' AND cls.relnamespace = current_schema()::regnamespace
       AND pg_get_constraintdef(con.oid) LIKE '%"Role_m1"%'
  LOOP
    chk_tbl  := array_append(chk_tbl,  c.tname::text);
    chk_name := array_append(chk_name, c.cname::text);
    chk_body := array_append(chk_body, c.cbody);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.tname, c.cname);
  END LOOP;

  FOR c IN
    SELECT indexname AS iname, indexdef AS ibody FROM pg_indexes
     WHERE schemaname = current_schema() AND indexdef LIKE '%"Role_m1"%'
  LOOP
    idx_body := array_append(idx_body, c.ibody);
    EXECUTE format('DROP INDEX %I', c.iname);
  END LOOP;

  -- 2. Every column of the old type (found from the catalogue, so none is missed).
  FOR c IN
    SELECT table_name AS tname, column_name AS colname, column_default AS coldefault
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND udt_name = 'Role_m1'
  LOOP
    IF c.coldefault IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP DEFAULT', c.tname, c.colname);
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE "Role" USING %I::text::"Role"', c.tname, c.colname, c.colname);
    IF c.coldefault IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT %s', c.tname, c.colname,
                     replace(c.coldefault, '"Role_m1"', '"Role"'));
    END IF;
  END LOOP;

  -- 3. Re-create the saved objects against the new type.
  n := coalesce(array_length(chk_tbl, 1), 0);
  FOR i IN 1 .. n LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', chk_tbl[i], chk_name[i],
                   replace(chk_body[i], '"Role_m1"', '"Role"'));
  END LOOP;
  FOREACH stmt IN ARRAY idx_body LOOP
    EXECUTE replace(stmt, '"Role_m1"', '"Role"');
  END LOOP;
END $$;

DROP TYPE "Role_m1";

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261121000000_roles_teacher_head_coach_super_admin';

COMMIT;
