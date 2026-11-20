-- Late-2026 release post-check (AFTER `prisma migrate deploy` of the sign-up migrations: gender at every sign-up; home
-- location on every registration form): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release late-2026    (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/late-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with late-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 2, 0, 0: both late-2026 migrations applied; nothing failed or rolled back; nothing after 20261221000100'
SELECT count(*) FILTER (WHERE migration_name IN ('20261221000000_registration_gender', '20261221000100_home_location')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS late_applied,
       count(*) FILTER (WHERE migration_name > '20261221000100_home_location')                  AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 3, 4: the Gender enum; a nullable gender column on User, MentorRequest and TeacherApplication; the new home place columns'
SELECT (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'Gender') AS gender_enum,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'gender' AND is_nullable = 'YES'
           AND table_name IN ('User', 'MentorRequest', 'TeacherApplication')) AS gender_columns,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
           AND ((table_name = 'TeacherApplication' AND column_name = 'homeProvince')
             OR (table_name = 'MentorRequest' AND column_name IN ('homeProvince', 'homeDistrict', 'homeSector')))) AS home_place_columns;
-- Named for the release kit's object check: 'Gender' 'gender' 'homeProvince' 'homeDistrict' 'homeSector'

\echo '== 3. MUST be YES, YES: a teacher application''s home district and sector are optional (international applicants give none)'
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'TeacherApplication' AND column_name IN ('homeDistrict', 'homeSector') ORDER BY 1;

\echo '== 4. MUST be 0, 0, 0 right after the migration: nothing has a gender or a coach home place yet'
SELECT (SELECT count(*) FROM "User" WHERE "gender" IS NOT NULL) AS users_with_gender,
       (SELECT count(*) FROM "TeacherApplication" WHERE "homeProvince" IS NOT NULL) AS teacher_applications_with_province,
       (SELECT count(*) FROM "MentorRequest" WHERE "homeDistrict" IS NOT NULL) AS coach_applications_with_home;

\echo '== 5. compare: accounts, teacher applications and coach applications (MUST equal pre-check section 3)'
SELECT (SELECT count(*) FROM "User") AS users,
       (SELECT count(*) FROM "TeacherApplication") AS teacher_applications,
       (SELECT count(*) FROM "TeacherApplication" WHERE "homeDistrict" IS NOT NULL AND "homeSector" IS NOT NULL) AS teacher_applications_with_home,
       (SELECT count(*) FROM "MentorRequest") AS coach_applications;

ROLLBACK;
