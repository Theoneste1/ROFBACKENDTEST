-- Bulk operations: the membership guard (2026-11-17, owner review of #59). Additive: one function, one trigger.
--
-- Creating a bulk operation must see the EXACT set of accounts its filter matches at the moment it commits. Every
-- write that can change that membership — an INSERT, a DELETE, or an UPDATE of a column any bulk / list filter reads
-- (src/users/users.service.ts userListWhere: role, divisionId, gradeLevel, schoolId, isApproved, isActive,
-- accountStatus, activatedAt, and the search over firstName, lastName, username, email) — first takes the SHARED
-- transaction-level advisory lock 8152026002. Creating an operation takes it EXCLUSIVELY (BulkOperationsService),
-- so it waits for membership writes in flight and holds new ones until the operation is committed.
--
-- The database enforces it, so every writer participates: the application, scripts and direct SQL. Writes that do
-- not touch those columns (sign-ins: lastLoginAt, failedLoginCount, lockedUntil, tokensValidAfter; points; avatar…)
-- never take the lock. The filters read no other table, so no other table needs the guard.
-- Shared locks never block each other: ordinary writes are only delayed while an operation is being created.
-- Rollback: docs/migrations/20261207000100_bulk_membership_guard.rollback.sql

CREATE OR REPLACE FUNCTION user_bulk_membership_guard() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(8152026002);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_bulk_membership_guard
  BEFORE INSERT OR DELETE
      OR UPDATE OF "role", "divisionId", "gradeLevel", "schoolId", "isApproved", "isActive", "accountStatus",
                   "activatedAt", "firstName", "lastName", "username", "email"
  ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_bulk_membership_guard();
