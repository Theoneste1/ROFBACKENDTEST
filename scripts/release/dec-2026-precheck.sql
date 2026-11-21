-- Dec-2026 release pre-check (BEFORE `prisma migrate deploy` of the "Other" Olympiad interest and the locked test
-- submissions, owner 2026-11-21): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release dec-2026      (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/dec-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with dec-2026-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 14, 11, 7, 3, 0, 0: Phase 1, post-Phase-1, the design areas and late-2026 applied; none of the dec-2026 ones; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)  AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000' AND migration_name < '20261211000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261211000000' AND migration_name < '20261221000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS areas_applied,
       count(*) FILTER (WHERE migration_name >= '20261221000000' AND migration_name < '20261223000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS late_applied,
       count(*) FILTER (WHERE migration_name >= '20261223000000')                                                       AS dec_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                        AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 0, 0: nothing made by the dec-2026 migrations exists yet (the olympiadInterestOther columns; the TestResubmissionAuthorization table)'
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'olympiadInterestOther'
           AND table_name IN ('User', 'MentorRequest', 'TeacherApplication')) AS other_interest_columns,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'TestResubmissionAuthorization') AS resubmission_tables;

\echo '== 3. compare: accounts and applications, and their subject interests (MUST be unchanged after the migration: additive only)'
SELECT (SELECT count(*) FROM "User")                                            AS users,
       (SELECT count(*) FROM "User" WHERE cardinality("olympiadInterests") > 0) AS users_with_subjects,
       (SELECT count(*) FROM "MentorRequest")                                   AS coach_applications,
       (SELECT count(*) FROM "TeacherApplication")                              AS teacher_applications;

\echo '== 4. compare: test submissions and their versions (MUST be unchanged after the migration: each is simply locked from now on)'
SELECT (SELECT count(*) FROM "TestSubmission")        AS submissions,
       (SELECT count(*) FROM "TestSubmissionVersion") AS versions;

ROLLBACK;
