-- Late-2026 release pre-check (BEFORE `prisma migrate deploy` of the sign-up migrations, owner 2026-11-20: gender at
-- every sign-up; home location on every registration form; and the generic bulk engine): READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release late-2026     (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/late-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with late-2026-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 14, 11, 7, 0, 0: Phase 1, post-Phase-1 and the seven design-area migrations applied; none of the late-2026 ones; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)  AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000' AND migration_name < '20261211000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261211000000' AND migration_name < '20261221000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS areas_applied,
       count(*) FILTER (WHERE migration_name >= '20261221000000')                                                       AS late_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                        AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST all be 0: nothing made by the late-2026 migrations exists yet (the Gender enum; the gender and home place columns)'
SELECT (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'Gender') AS gender_enum,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'gender'
           AND table_name IN ('User', 'MentorRequest', 'TeacherApplication')) AS gender_columns,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
           AND ((table_name = 'TeacherApplication' AND column_name = 'homeProvince')
             OR (table_name = 'MentorRequest' AND column_name IN ('homeProvince', 'homeDistrict', 'homeSector')))) AS home_place_columns;
-- Named for the release kit's object check: 'Gender' 'gender' 'homeProvince' 'homeDistrict' 'homeSector'

\echo '== 2b. MUST all be 0: nothing made by the generic bulk engine exists yet'
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperation' AND column_name = 'entityType') AS bulk_entity_type_column,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperationItem' AND column_name = 'entityId') AS bulk_entity_id_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'BulkOperation_selectionToken_v2_key') AS bulk_single_use_index,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'bulk_item_entity_from_user') AS bulk_item_trigger,
       (SELECT count(*) FROM pg_proc WHERE proname = 'bulk_item_entity_from_user') AS bulk_item_function;

\echo '== 3. compare: accounts, teacher applications and coach applications (MUST be unchanged after the migration: additive only)'
SELECT (SELECT count(*) FROM "User") AS users,
       (SELECT count(*) FROM "TeacherApplication") AS teacher_applications,
       (SELECT count(*) FROM "TeacherApplication" WHERE "homeDistrict" IS NOT NULL AND "homeSector" IS NOT NULL) AS teacher_applications_with_home,
       (SELECT count(*) FROM "MentorRequest") AS coach_applications;

\echo '== 4. compare: bulk operations and their items (MUST be unchanged after the migration: every existing one becomes a USER operation, items keep userId and gain entityId = userId)'
SELECT count(*) AS operations, count(*) FILTER (WHERE "emailJobId" IS NOT NULL) AS with_email_job,
       count(DISTINCT "action") AS actions, md5(string_agg("id" || ':' || "action" || ':' || "status"::text || ':' || "total" || ':' || coalesce("emailJobId", '-'), ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperation";
SELECT "outcome"::text, count(*) AS items, md5(string_agg("operationId" || ':' || "userId", ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperationItem" GROUP BY "outcome" ORDER BY 1;

\echo '== 5. MUST be 0: items whose userId is missing (the migration backfills entityId from it and makes entityId NOT NULL)'
SELECT count(*) AS items_without_user FROM "BulkOperationItem" WHERE "userId" IS NULL;

ROLLBACK;
