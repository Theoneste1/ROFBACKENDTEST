-- Launch-2026 release pre-check (BEFORE `prisma migrate deploy` of the seven migrations after levels-2026: directory sync
-- mode, the unlisted school of a teacher application, registration data, coach programme access, activation per sign-up
-- form, news subscribers, "view as"; owner 2026-11-22/23): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release launch-2026   (Neon rehearsal branch or local copy; guarded)
--   psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/launch-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with launch-2026-postcheck.sql right after the migrations. Runbook: docs/releases/launch-2026.md.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 14, 11, 7, 3, 2, 1, 0, 0: every release up to levels-2026 applied; nothing from 20261225000000 on; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)  AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000' AND migration_name < '20261211000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261211000000' AND migration_name < '20261221000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS areas_applied,
       count(*) FILTER (WHERE migration_name >= '20261221000000' AND migration_name < '20261223000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS late_applied,
       count(*) FILTER (WHERE migration_name >= '20261223000000' AND migration_name < '20261224000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS dec_applied,
       count(*) FILTER (WHERE migration_name = '20261224000000_divisions_levels'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS levels_applied,
       count(*) FILTER (WHERE migration_name >= '20261225000000')                                                       AS launch_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                        AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0, 0: nothing made by the launch migrations exists yet (tables, types, columns)'
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

\echo '== 3. NOTE the value (no row = never set = false): the single activation setting the previous release reads. After the release every sign-up form starts with activation OFF, whatever this says; if it is true, decide which forms to switch on right after the release'
SELECT "key", "value"::text AS value FROM "SystemSetting" WHERE "key" = 'registration.requireEmailVerification';

\echo '== 4. compare: rows the migrations must leave unchanged (users by role, schools, sync runs, applications, forms, e-mails)'
SELECT "role"::text AS role, count(*) AS users FROM "User" GROUP BY 1 ORDER BY 1;
SELECT (SELECT count(*) FROM "School")              AS schools,
       (SELECT count(*) FROM "SchoolSyncRun")       AS sync_runs,
       (SELECT count(*) FROM "TeacherApplication")  AS teacher_applications,
       (SELECT count(*) FROM "MentorRequest")       AS coach_applications,
       (SELECT count(*) FROM "FormAvailability")    AS forms,
       (SELECT count(*) FROM "EmailJob")            AS email_jobs,
       (SELECT count(*) FROM "EmailDelivery")       AS email_deliveries,
       (SELECT count(*) FROM "MarkerAuthorization") AS marker_authorisations;

\echo '== 5. compare: what the backfills will do — approved coach applications (each gets its account where the audit log or one e-mail match says so), and revoked marking authorisations carried over as MARKING restrictions'
SELECT (SELECT count(*) FROM "MentorRequest" WHERE "status" = 'APPROVED') AS approved_coach_applications,
       (SELECT count(*) FROM (
          SELECT DISTINCT ON (a."coachId", a."disciplineId") a."coachId", a."disciplineId"
            FROM "MarkerAuthorization" a
           WHERE a."revokedAt" IS NOT NULL
           ORDER BY a."coachId", a."disciplineId", a."revokedAt" DESC
        ) x
        JOIN "User" u ON u."id" = x."coachId" AND u."role" = 'MENTOR'
       WHERE EXISTS (SELECT 1 FROM "ProgrammeMembership" m WHERE m."userId" = x."coachId" AND m."disciplineId" = x."disciplineId" AND m."isActive")
         AND NOT EXISTS (SELECT 1 FROM "MarkerAuthorization" b WHERE b."coachId" = x."coachId" AND b."disciplineId" = x."disciplineId" AND b."revokedAt" IS NULL)
       ) AS revocations_to_carry_over;

ROLLBACK;
