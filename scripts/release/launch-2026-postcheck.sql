-- Launch-2026 release post-check (AFTER `prisma migrate deploy` of the seven migrations after levels-2026; owner
-- 2026-11-22/23): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release launch-2026  (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/launch-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with launch-2026-precheck.sql taken just before the migrations. Runbook: docs/releases/launch-2026.md.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 7, 0, 0: the seven launch migrations applied; nothing after 20261230000000_view_as; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name IN ('20261225000000_school_sync_mode', '20261225000100_teacher_unlisted_school',
                          '20261226000000_registration_data', '20261227000000_coach_programme_access',
                          '20261228000000_form_email_verification', '20261229000000_subscribers', '20261230000000_view_as')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS launch_applied,
       count(*) FILTER (WHERE migration_name > '20261230000000_view_as')                       AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 5, 6, 9: the five tables, the six types and the nine columns on existing tables'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
           AND table_name IN ('RegistrationSavedFilter', 'CoachProgrammeRestriction', 'Subscriber', 'Mailing', 'ViewAsSession'))              AS launch_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
           AND typname IN ('SchoolSyncMode', 'CoachCapability', 'SubscriberKind', 'SubscriberSource', 'SubscriberStatus', 'MailingStatus')) AS launch_types,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
              (table_name = 'SchoolSyncRun' AND column_name = 'mode')
           OR (table_name = 'TeacherApplication' AND column_name IN ('proposedSchoolCode', 'proposedSchoolCell', 'proposedSchoolVillage',
                                                                      'proposedSchoolOwnership', 'proposedSchoolAccommodation'))
           OR (table_name = 'MentorRequest' AND column_name = 'userId')
           OR (table_name = 'FormAvailability' AND column_name = 'requireEmailVerification')
           OR (table_name = 'EmailDelivery' AND column_name = 'subscriberId')))                                              AS launch_columns;

\echo '== 3. MUST be: SchoolSyncMode FULL,NEW_ONLY; CoachCapability STUDENTS,COURSES,MARKING,RESULTS; SubscriberKind PARENT,STUDENT,TEACHER,SCHOOL,OTHER; SubscriberSource WEBSITE,ADMIN,IMPORT; SubscriberStatus ACTIVE,UNSUBSCRIBED; MailingStatus QUEUED,SENDING,SENT,FAILED,CANCELLED'
SELECT t.typname AS type, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS "values"
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
 WHERE t.typnamespace = 'public'::regnamespace
   AND t.typname IN ('SchoolSyncMode', 'CoachCapability', 'SubscriberKind', 'SubscriberSource', 'SubscriberStatus', 'MailingStatus')
 GROUP BY t.typname ORDER BY t.typname;

\echo '== 4. MUST be: SchoolSyncRun.mode "SchoolSyncMode" NOT NULL default FULL; FormAvailability.requireEmailVerification boolean NOT NULL default false; the other seven nullable, no default (proposedSchoolAccommodation "SchoolAccommodation", the rest text)'
SELECT c.table_name || '.' || c.column_name AS "column", CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS type,
       c.is_nullable AS nullable, coalesce(c.column_default, '') AS "default"
  FROM information_schema.columns c
 WHERE c.table_schema = 'public' AND (
        (c.table_name = 'SchoolSyncRun' AND c.column_name = 'mode')
     OR (c.table_name = 'TeacherApplication' AND c.column_name LIKE 'proposedSchool%' AND c.column_name <> 'proposedSchoolName')
     OR (c.table_name = 'MentorRequest' AND c.column_name = 'userId')
     OR (c.table_name = 'FormAvailability' AND c.column_name = 'requireEmailVerification')
     OR (c.table_name = 'EmailDelivery' AND c.column_name = 'subscriberId'))
 ORDER BY 1;

\echo '== 5. MUST be 18, 1, 12, 1: the indexes (the active-restriction one partial), the CHECK on a restriction reason, the foreign keys'
SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
           'MentorRequest_userId_key', 'RegistrationSavedFilter_ownerId_name_key', 'RegistrationSavedFilter_shared_idx',
           'CoachProgrammeRestriction_coachId_liftedAt_idx', 'CoachProgrammeRestriction_disciplineId_capability_liftedAt_idx',
           'CoachProgrammeRestriction_createdById_idx', 'CoachProgrammeRestriction_liftedById_idx', 'CoachProgrammeRestriction_one_active',
           'Subscriber_email_key', 'Subscriber_status_createdAt_idx', 'Subscriber_userId_idx', 'Mailing_idempotencyKey_key',
           'Mailing_emailJobId_key', 'Mailing_createdAt_idx', 'EmailDelivery_subscriberId_idx',
           'ViewAsSession_ticketHash_key', 'ViewAsSession_actorId_createdAt_idx', 'ViewAsSession_targetId_createdAt_idx'))                                AS indexes,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'CoachProgrammeRestriction_one_active'
           AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE ("liftedAt" IS NULL)%')                                      AS one_active_partial_unique,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conname IN (
           'MentorRequest_userId_fkey', 'RegistrationSavedFilter_ownerId_fkey', 'CoachProgrammeRestriction_coachId_fkey',
           'CoachProgrammeRestriction_disciplineId_fkey', 'CoachProgrammeRestriction_createdById_fkey', 'CoachProgrammeRestriction_liftedById_fkey',
           'EmailDelivery_subscriberId_fkey', 'Subscriber_userId_fkey', 'Mailing_emailJobId_fkey', 'Mailing_createdById_fkey',
           'ViewAsSession_actorId_fkey', 'ViewAsSession_targetId_fkey'))  AS foreign_keys,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname = 'CoachProgrammeRestriction_reason_check')        AS reason_checks;

\echo '== 6. MUST be 0, 0, 0, 0, 0, 0, 0, 0: nothing new is in use yet (every run FULL, activation off on every form, no proposed school code, no saved filter, subscriber, mailing, subscriber e-mail or viewing session)'
SELECT (SELECT count(*) FROM "SchoolSyncRun" WHERE "mode" <> 'FULL')                         AS runs_not_full,
       (SELECT count(*) FROM "FormAvailability" WHERE "requireEmailVerification")            AS forms_with_activation,
       (SELECT count(*) FROM "TeacherApplication" WHERE "proposedSchoolCode" IS NOT NULL)    AS proposed_codes,
       (SELECT count(*) FROM "RegistrationSavedFilter")                                      AS saved_filters,
       (SELECT count(*) FROM "Subscriber")                                                   AS subscribers,
       (SELECT count(*) FROM "Mailing")                                                      AS mailings,
       (SELECT count(*) FROM "EmailDelivery" WHERE "subscriberId" IS NOT NULL)               AS subscriber_deliveries,
       (SELECT count(*) FROM "ViewAsSession")                                                AS viewing_sessions;

\echo '== 7. compare: MUST equal pre-check section 4 (users by role; schools, sync runs, applications, forms, e-mails, marker authorisations)'
SELECT "role"::text AS role, count(*) AS users FROM "User" GROUP BY 1 ORDER BY 1;
SELECT (SELECT count(*) FROM "School")              AS schools,
       (SELECT count(*) FROM "SchoolSyncRun")       AS sync_runs,
       (SELECT count(*) FROM "TeacherApplication")  AS teacher_applications,
       (SELECT count(*) FROM "MentorRequest")       AS coach_applications,
       (SELECT count(*) FROM "FormAvailability")    AS forms,
       (SELECT count(*) FROM "EmailJob")            AS email_jobs,
       (SELECT count(*) FROM "EmailDelivery")       AS email_deliveries,
       (SELECT count(*) FROM "MarkerAuthorization") AS marker_authorisations;

\echo '== 8. compare with pre-check section 5: coach applications linked to their account (at most the approved count; each linked account a Coach or Head Coach), and the carried-over MARKING restrictions (MUST equal revocations_to_carry_over; every one active and carried over)'
SELECT (SELECT count(*) FROM "MentorRequest" WHERE "userId" IS NOT NULL)                                AS linked_applications,
       (SELECT count(*) FROM "MentorRequest" WHERE "userId" IS NOT NULL AND "status" <> 'APPROVED')     AS linked_not_approved,
       (SELECT count(*) FROM "MentorRequest" r JOIN "User" u ON u."id" = r."userId" WHERE u."role" NOT IN ('MENTOR', 'HEAD_COACH')) AS linked_to_other_roles;
SELECT count(*) AS carried_over_restrictions,
       count(*) FILTER (WHERE "capability" = 'MARKING' AND "liftedAt" IS NULL
                          AND "reason" LIKE 'Carried over from the revoked marking authorisation:%')  AS carried_over_active_marking
  FROM "CoachProgrammeRestriction";

ROLLBACK;
