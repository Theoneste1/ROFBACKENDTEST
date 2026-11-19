-- Design-areas release pre-check (BEFORE `prisma migrate deploy` of the design-area migrations: the countries reference
-- list, area 1 as simplified by the owner, 2026-11-19; the primary teacher of a school, owner decision 2026-11-19; the
-- generic bulk engine, 2026-11-19):
-- READ ONLY.
--
--   node scripts/release/rehearsal.mjs precheck --release areas-2026     (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/areas-2026-precheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with areas-2026-postcheck.sql right after the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST: 14 Phase 1 + 11 post-Phase-1 migrations applied; none of the design-area ones; nothing failed or rolled back'
SELECT count(*) FILTER (WHERE migration_name LIKE '2026112100%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)  AS phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261201000000' AND migration_name < '20261211000000'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)                                       AS post_phase1_applied,
       count(*) FILTER (WHERE migration_name >= '20261211000000')                                                       AS areas_or_later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                                        AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST all be 0: nothing made by the design-area migrations exists yet (countries; primary teacher; generic bulk engine)'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Country')) AS tables,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'School_countryCode_fkey') AS school_country_fk,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'TeacherSchoolRole') AS teacher_school_role_enum,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'TeacherSchoolAssignment' AND column_name = 'role') AS teacher_school_role_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'TeacherSchoolAssignment_one_primary_per_school') AS one_primary_index,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperation' AND column_name = 'entityType') AS bulk_entity_type_column,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperationItem' AND column_name = 'entityId') AS bulk_entity_id_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'BulkOperation_selectionToken_v2_key') AS bulk_single_use_index,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'bulk_item_entity_from_user') AS bulk_item_trigger,
       (SELECT count(*) FROM pg_proc WHERE proname = 'bulk_item_entity_from_user') AS bulk_item_function;

\echo '== 3. MUST be empty: school country codes that are not two upper-case letters (the School → Country foreign key refuses any code that is not ISO 3166-1 alpha-2; the migration names them)'
SELECT DISTINCT "countryCode" FROM "School" WHERE "countryCode" !~ '^[A-Z]{2}$' ORDER BY 1;

\echo '== 4. compare: schools by country (MUST be unchanged after the migration)'
SELECT "countryCode", count(*) FROM "School" GROUP BY "countryCode" ORDER BY 1;

\echo '== 5. compare: teacher–school links (MUST be unchanged after the migration: it creates, ends and removes none)'
SELECT count(*) AS links, count(*) FILTER (WHERE "isActive") AS active_links, count(*) FILTER (WHERE NOT "isActive") AS ended_links
  FROM "TeacherSchoolAssignment";

\echo '== 6. report: what the primary-teacher migration will do (the earliest active link of an ACTIVE account per school becomes PRIMARY)'
--   schools_examined            every school
--   schools_with_teachers       at least one active link
--   schools_assigned_a_primary  at least one active link of an ACTIVE account: its earliest (createdAt, then id) becomes PRIMARY
--   schools_with_secondaries    at least one active link that stays SECONDARY
--   schools_without_teachers    no active link
--   exceptions                  active links, but none of an ACTIVE account: no primary (an Administrator chooses one later)
--   ties_resolved_by_id         the earliest createdAt is shared by two or more eligible links: the lowest id wins
WITH per AS (
  SELECT s."id",
         count(t."id") FILTER (WHERE t."isActive")                                AS active_links,
         count(t."id") FILTER (WHERE t."isActive" AND u."accountStatus" = 'ACTIVE') AS eligible,
         min(t."createdAt") FILTER (WHERE t."isActive" AND u."accountStatus" = 'ACTIVE') AS first_at
    FROM "School" s
    LEFT JOIN "TeacherSchoolAssignment" t ON t."schoolId" = s."id"
    LEFT JOIN "User" u ON u."id" = t."teacherId"
   GROUP BY s."id"
)
SELECT count(*)                                                                           AS schools_examined,
       count(*) FILTER (WHERE active_links > 0)                                          AS schools_with_teachers,
       count(*) FILTER (WHERE eligible > 0)                                              AS schools_assigned_a_primary,
       count(*) FILTER (WHERE active_links - CASE WHEN eligible > 0 THEN 1 ELSE 0 END > 0) AS schools_with_secondaries,
       count(*) FILTER (WHERE active_links = 0)                                          AS schools_without_teachers,
       count(*) FILTER (WHERE active_links > 0 AND eligible = 0)                         AS exceptions,
       (SELECT count(*) FROM per p WHERE p.eligible > 1 AND (
          SELECT count(*) FROM "TeacherSchoolAssignment" t JOIN "User" u ON u."id" = t."teacherId"
           WHERE t."schoolId" = p."id" AND t."isActive" AND u."accountStatus" = 'ACTIVE' AND t."createdAt" = p.first_at) > 1) AS ties_resolved_by_id
  FROM per;

\echo '== 7. compare: bulk operations and their items (MUST be unchanged after the migration: every existing one becomes a USER operation, items keep userId and gain entityId = userId)'
SELECT count(*) AS operations, count(*) FILTER (WHERE "emailJobId" IS NOT NULL) AS with_email_job,
       count(DISTINCT "action") AS actions, md5(string_agg("id" || ':' || "action" || ':' || "status"::text || ':' || "total" || ':' || coalesce("emailJobId", '-'), ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperation";
SELECT "outcome"::text, count(*) AS items, md5(string_agg("operationId" || ':' || "userId", ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperationItem" GROUP BY "outcome" ORDER BY 1;

\echo '== 8. MUST be 0: items whose userId is missing (the migration backfills entityId from it and makes entityId NOT NULL)'
SELECT count(*) AS items_without_user FROM "BulkOperationItem" WHERE "userId" IS NULL;

ROLLBACK;
