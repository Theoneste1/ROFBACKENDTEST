-- post-Phase-1 release pre-check (BEFORE `prisma migrate deploy` of the ten migrations after M14): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release post-phase1     (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/post-phase1-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with post-phase1-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST: all 14 Phase 1 migrations applied; none of the eleven post-Phase-1 ones; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000')                                                   AS post_phase1_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                    AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST all be 0: nothing the eleven migrations create exists yet'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
          AND table_name IN ('ApplicationInfoRequest', 'BulkOperation', 'BulkOperationItem', 'FormAvailability', 'NotificationOutbox', 'TeacherApplication',
                          'TeacherStudentAssignment', 'UserPermissionOverrideStudent', 'UserStatusChange')) AS tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
          AND typname IN ('AccountStatus', 'BulkItemOutcome', 'BulkOperationStatus', 'CoachEducationLevel', 'FormKey', 'FormMode',
                          'NotificationOutboxStatus', 'OlympiadSubject', 'TeacherApplicationStatus', 'DelegationStudentScope', 'TeacherStudentSource')) AS enums,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
          AND (table_name, column_name) IN (('User', 'accountStatus'), ('User', 'avatarFileId'), ('User', 'country'), ('User', 'dateOfBirth'),
               ('User', 'guardianPhone'), ('User', 'homeDistrict'), ('User', 'homeProvince'), ('User', 'homeSector'), ('User', 'olympiadInterests'),
               ('User', 'phone'), ('MentorRequest', 'country'), ('MentorRequest', 'educationLevel'), ('MentorRequest', 'occupation'),
               ('MentorRequest', 'olympiadInterests'),
               ('MentorRequest', 'affiliation'), ('MentorRequest', 'expertise'), ('MentorRequest', 'phone'), ('MentorRequest', 'rejectionReason'),
               ('MentorRequest', 'relevantExperience'), ('MentorRequest', 'yearsOfExperience'), ('MentorRequest', 'avatarFileId'),
               ('UserPermissionOverride', 'studentScope'), ('UserPermissionOverride', 'reviewNeededAt'), ('UserPermissionOverride', 'reviewReason'))) AS columns,
       (SELECT count(*) FROM pg_trigger WHERE tgname IN ('user_account_status_sync', 'user_bulk_membership_guard')) AS triggers;

\echo '== 3. MUST be present (Phase 1 guards the new triggers work alongside): user_last_super_admin_guard, audit_log_append_only'
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('user_last_super_admin_guard', 'audit_log_append_only') ORDER BY tgname;

\echo '== 4. compare: users by role and isActive. account_states backfills isActive=false → SUSPENDED, every other account → ACTIVE'
SELECT "role", "isActive", count(*) FROM "User" GROUP BY "role", "isActive" ORDER BY "role", "isActive";

\echo '== 5. compare: active Super Administrators (MUST be unchanged after the migration)'
SELECT count(*) AS active_super_admins FROM "User" WHERE "role" = 'SUPER_ADMIN' AND "isActive";

\echo '== 6. compare: the registration switches form_availability carries over (student: missing or anything but false → OPEN; teacher: only true → OPEN)'
SELECT "key", "value"::text FROM "SystemSetting" WHERE "key" IN ('registration.studentSelfSignup', 'registration.teacherSelfSignup') ORDER BY "key";

\echo '== 7. information: rows the new columns start empty on'
SELECT (SELECT count(*) FROM "MentorRequest") AS mentor_requests, (SELECT count(*) FROM "FileObject") AS file_objects;

ROLLBACK;
