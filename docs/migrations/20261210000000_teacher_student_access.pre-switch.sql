-- PRE-SWITCH step for rolling back 20261210000000_teacher_student_access. Run it FIRST, while the NEW application
-- release is still serving — BEFORE the previous release is deployed and before the rollback file.
--
-- Why: the previous release has no student scope; every teacher delegation it reads applies to EVERY student the
-- teacher sees through their schools. If it went live while a delegation narrowed to ASSIGNED or SELECTED students
-- were still active, that delegation would WIDEN to the whole school until the rollback ran (and the rollback refuses
-- by default). This step ends every active narrowed delegation now, so nothing can widen after the code switch.
--
-- Effect: each active delegation whose studentScope is ASSIGNED or SELECTED is revoked (revokedAt = now,
-- revokeReason = 'ROLLBACK') with one audit row per delegation. Nothing is deleted; SCHOOL-scope delegations, teacher
-- assignments and selected-student rows are untouched (the rollback file decides about those). Idempotent: a second run
-- finds nothing to revoke. Harmless if the rollback is then abandoned — an Administrator re-grants what is needed.
--
-- The table lock makes a delegation granted concurrently by the running application either commit before this step
-- (and be revoked by it) or wait for it (and then be checked again by the application).
BEGIN;

LOCK TABLE "UserPermissionOverride", "UserPermissionOverrideStudent", "TeacherStudentAssignment" IN SHARE ROW EXCLUSIVE MODE;

WITH revoked AS (
  UPDATE "UserPermissionOverride"
     SET "revokedAt" = now(), "revokeReason" = 'ROLLBACK'
   WHERE "studentScope" IN ('ASSIGNED', 'SELECTED') AND "revokedAt" IS NULL
  RETURNING "id", "userId", "permission", "studentScope"
)
INSERT INTO "AuditLog" ("id", "action", "entity", "entityId", "metadata", "createdAt")
SELECT gen_random_uuid()::text, 'PERMISSION_OVERRIDE_REVOKE', 'UserPermissionOverride', "id",
       jsonb_build_object('targetUserId', "userId", 'permission', "permission", 'studentScope', "studentScope"::text,
                          'reason', 'ROLLBACK_PRE_SWITCH', 'previous', jsonb_build_object('active', true),
                          'next', jsonb_build_object('active', false), 'via', 'RELEASE_ROLLBACK'),
       CURRENT_TIMESTAMP
  FROM revoked;

-- Expect 0: no narrowed delegation is still active.
SELECT count(*) AS active_narrowed_delegations
  FROM "UserPermissionOverride" WHERE "studentScope" IN ('ASSIGNED', 'SELECTED') AND "revokedAt" IS NULL;

COMMIT;
