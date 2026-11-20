-- Late-2026 release post-check (AFTER `prisma migrate deploy` of the sign-up migrations: gender at every sign-up; home
-- location on every registration form; and the generic bulk engine): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release late-2026    (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/late-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with late-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 3, 0, 0: the three late-2026 migrations applied; nothing failed or rolled back; nothing after 20261222000000'
SELECT count(*) FILTER (WHERE migration_name IN ('20261221000000_registration_gender', '20261221000100_home_location',
                                                 '20261222000000_bulk_operations_generic')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS late_applied,
       count(*) FILTER (WHERE migration_name > '20261222000000_bulk_operations_generic')        AS later,
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

\echo '== 6. MUST be 1, 1, 1, 1, 1, 1, 0: BulkOperation.entityType, BulkOperationItem.entityId (NOT NULL), the (operationId, entityId) unique index, the single-use index on v2 confirmations, the trigger bulk_item_entity_from_user and its function; USER items whose userId differs from entityId'
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperation' AND column_name = 'entityType') AS bulk_entity_type_column,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperationItem' AND column_name = 'entityId' AND is_nullable = 'NO') AS bulk_entity_id_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'BulkOperationItem_operationId_entityId_key') AS bulk_entity_unique_index,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'BulkOperation_selectionToken_v2_key') AS bulk_single_use_index,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'bulk_item_entity_from_user') AS bulk_item_trigger,
       (SELECT count(*) FROM pg_proc WHERE proname = 'bulk_item_entity_from_user') AS bulk_item_function,
       (SELECT count(*) FROM "BulkOperationItem" i JOIN "BulkOperation" o ON o."id" = i."operationId"
         WHERE o."entityType" = 'USER' AND i."userId" IS DISTINCT FROM i."entityId") AS user_items_not_backfilled;

\echo '== 7. MUST be 0 right after the migration: operations of another record type than USER'
SELECT count(*) AS non_user_operations FROM "BulkOperation" WHERE "entityType" <> 'USER';

\echo '== 8. compare: bulk operations and their items (MUST equal pre-check section 4)'
SELECT count(*) AS operations, count(*) FILTER (WHERE "emailJobId" IS NOT NULL) AS with_email_job,
       count(DISTINCT "action") AS actions, md5(string_agg("id" || ':' || "action" || ':' || "status"::text || ':' || "total" || ':' || coalesce("emailJobId", '-'), ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperation";
SELECT "outcome"::text, count(*) AS items, md5(string_agg("operationId" || ':' || "userId", ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperationItem" GROUP BY "outcome" ORDER BY 1;

ROLLBACK;
