-- post-Phase-1 release post-check (AFTER `prisma migrate deploy` of the eleven migrations after M14): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release post-phase1    (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/post-phase1-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with post-phase1-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST: 14 Phase 1 + 11 post-Phase-1 migrations applied; nothing failed or rolled back; nothing after 20261210000000'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)       AS phase1_applied,
       count(*) FILTER (WHERE migration_name IN ('20261201000000_teacher_applications', '20261202000000_notification_outbox',
                          '20261203000000_student_olympiad_interests', '20261204000000_registration_details', '20261205000000_avatar_file_purpose',
                          '20261206000000_account_states', '20261207000000_bulk_operations', '20261207000100_bulk_membership_guard',
                          '20261208000000_form_availability', '20261209000000_application_details', '20261210000000_teacher_student_access') AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name > '20261210000000_teacher_student_access')                                           AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                             AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 9, 11, 24, 2, 1: tables, enums, columns, triggers created, and the AVATAR file purpose'
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
       (SELECT count(*) FROM pg_trigger WHERE tgname IN ('user_account_status_sync', 'user_bulk_membership_guard') AND tgenabled = 'O') AS triggers,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FilePurpose' AND e.enumlabel = 'AVATAR') AS avatar_purpose;

\echo '== 3. MUST all be 0: account states backfilled (isActive=false → SUSPENDED, otherwise ACTIVE) and kept in sync with isActive'
SELECT count(*) FILTER (WHERE "isActive" = false AND "accountStatus" <> 'SUSPENDED')        AS inactive_not_suspended,
       count(*) FILTER (WHERE "isActive" = true AND "accountStatus" <> 'ACTIVE')            AS active_not_active,
       count(*) FILTER (WHERE "accountStatus" IN ('DEACTIVATED', 'ARCHIVED'))               AS unexpected_new_states
  FROM "User";

\echo '== 4. compare: users by role and isActive — MUST equal the pre-check'
SELECT "role", "isActive", count(*) FROM "User" GROUP BY "role", "isActive" ORDER BY "role", "isActive";

\echo '== 5. compare: active Super Administrators — MUST equal the pre-check'
SELECT count(*) AS active_super_admins FROM "User" WHERE "role" = 'SUPER_ADMIN' AND "isActive";

\echo '== 6. MUST: four forms; student and teacher registration as the pre-check switches predicted; coach and contact OPEN; no schedule, no custom text'
SELECT f."key", f."mode", f."opensAt", f."closesAt",
       (f."closedMessage" IS NULL AND f."instructions" IS NULL AND f."contactEmail" IS NULL AND f."supportUrl" IS NULL) AS default_texts,
       s."value"::text AS old_switch
  FROM "FormAvailability" f
  LEFT JOIN "SystemSetting" s ON s."key" = CASE f."key" WHEN 'STUDENT_REGISTRATION' THEN 'registration.studentSelfSignup'
                                                         WHEN 'TEACHER_REGISTRATION' THEN 'registration.teacherSelfSignup' END
 ORDER BY f."key";

\echo '== 7. MUST all be 0: the new tables start empty (no bulk operation, status change, teacher application or teacher–student link yet)'
SELECT (SELECT count(*) FROM "BulkOperation") AS bulk_operations, (SELECT count(*) FROM "BulkOperationItem") AS bulk_items,
       (SELECT count(*) FROM "UserStatusChange") AS status_changes, (SELECT count(*) FROM "TeacherApplication") AS teacher_applications,
       (SELECT count(*) FROM "TeacherStudentAssignment") AS teacher_students, (SELECT count(*) FROM "UserPermissionOverrideStudent") AS selected_students;

\echo '== 7b. MUST be 0, 0: every teacher delegation GRANT has studentScope SCHOOL (today''s behaviour); no other override has one'
SELECT count(*) FILTER (WHERE "effect" = 'GRANT' AND "permission" IN ('students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf')
                          AND "studentScope" IS DISTINCT FROM 'SCHOOL') AS delegations_not_school,
       count(*) FILTER (WHERE NOT ("effect" = 'GRANT' AND "permission" IN ('students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf'))
                          AND "studentScope" IS NOT NULL) AS others_with_scope
  FROM "UserPermissionOverride";

\echo '== 8. MUST be present and enabled: the Phase 1 guards next to the new triggers'
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgname IN ('user_last_super_admin_guard', 'audit_log_append_only', 'user_account_status_sync', 'user_bulk_membership_guard') ORDER BY tgname;

ROLLBACK;
