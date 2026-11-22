-- Dec-2026 release post-check (AFTER `prisma migrate deploy` of the "Other" Olympiad interest and the locked test
-- submissions, owner 2026-11-21): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release dec-2026     (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/dec-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with dec-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 2, 0, 0: the two dec-2026 migrations applied; nothing failed or rolled back; nothing after 20261223000100'
SELECT count(*) FILTER (WHERE migration_name IN ('20261223000000_olympiad_interest_other', '20261223000100_test_resubmission_lock')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS dec_applied,
       count(*) FILTER (WHERE migration_name > '20261223000100_test_resubmission_lock')         AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 3, 3: a nullable olympiadInterestOther on User, MentorRequest and TeacherApplication, each with its 2-100 character CHECK'
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'olympiadInterestOther'
           AND is_nullable = 'YES' AND table_name IN ('User', 'MentorRequest', 'TeacherApplication'))                 AS other_interest_columns,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'c'
           AND conname IN ('User_olympiadInterestOther_length', 'MentorRequest_olympiadInterestOther_length',
                           'TeacherApplication_olympiadInterestOther_length'))                                       AS length_checks;

\echo '== 3. MUST be 0, 0, 0 right after the migration: nobody has an other interest yet'
SELECT (SELECT count(*) FROM "User" WHERE "olympiadInterestOther" IS NOT NULL)               AS users_with_other,
       (SELECT count(*) FROM "MentorRequest" WHERE "olympiadInterestOther" IS NOT NULL)      AS coach_applications_with_other,
       (SELECT count(*) FROM "TeacherApplication" WHERE "olympiadInterestOther" IS NOT NULL) AS teacher_applications_with_other;

\echo '== 4. compare: accounts and applications, and their subject interests (MUST equal pre-check section 3)'
SELECT (SELECT count(*) FROM "User")                                            AS users,
       (SELECT count(*) FROM "User" WHERE cardinality("olympiadInterests") > 0) AS users_with_subjects,
       (SELECT count(*) FROM "MentorRequest")                                   AS coach_applications,
       (SELECT count(*) FROM "TeacherApplication")                              AS teacher_applications;

\echo '== 5. MUST be 1, 1, 3: the TestResubmissionAuthorization table, its one-open-per-submission index and its 3 CHECKs'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TestResubmissionAuthorization') AS resubmission_tables,
       (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'TestResubmissionAuthorization_one_open')                 AS one_open_index,
       (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname IN ('TestResubmissionAuthorization_reason_length',
           'TestResubmissionAuthorization_used_or_cancelled', 'TestResubmissionAuthorization_used_version'))                                AS checks;

\echo '== 6. MUST be 0 right after the migration: no authorization yet'
SELECT count(*) AS authorizations FROM "TestResubmissionAuthorization";

\echo '== 7. compare: test submissions and their versions (MUST equal pre-check section 4)'
SELECT (SELECT count(*) FROM "TestSubmission")        AS submissions,
       (SELECT count(*) FROM "TestSubmissionVersion") AS versions;

ROLLBACK;
