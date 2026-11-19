-- Design-areas release post-check (AFTER `prisma migrate deploy` of the design-area migrations: countries; primary teacher;
-- generic bulk engine):
-- READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release areas-2026    (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/areas-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with areas-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 3, 0, 0: the three design-area migrations applied; nothing failed or rolled back; nothing after 20261213000000'
SELECT count(*) FILTER (WHERE migration_name IN ('20261211000000_countries_reference', '20261212000000_teacher_school_primary',
                                                 '20261213000000_bulk_operations_generic')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS areas_applied,
       count(*) FILTER (WHERE migration_name > '20261213000000_bulk_operations_generic')        AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 1: the table and the School → Country foreign key'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Country')) AS tables,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'School_countryCode_fkey') AS school_country_fk;

\echo '== 3. MUST be 249, +250: every ISO 3166-1 alpha-2 country seeded; Rwanda''s calling code'
SELECT count(*) AS countries, (SELECT "phonePrefix" FROM "Country" WHERE "code" = 'RW') AS rwanda_prefix FROM "Country";

\echo '== 4. MUST be 0: schools whose country is not in the table (the foreign key makes this impossible)'
SELECT count(*) AS schools_without_country FROM "School" s LEFT JOIN "Country" c ON c."code" = s."countryCode" WHERE c."code" IS NULL;

\echo '== 5. compare: schools by country (MUST equal the pre-check)'
SELECT "countryCode", count(*) FROM "School" GROUP BY "countryCode" ORDER BY 1;

\echo '== 6. MUST be 1, 1, 1: the TeacherSchoolRole enum, the role column and the one-primary-per-school index'
SELECT (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'TeacherSchoolRole') AS teacher_school_role_enum,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'TeacherSchoolAssignment' AND column_name = 'role') AS teacher_school_role_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'TeacherSchoolAssignment_one_primary_per_school') AS one_primary_index;

\echo '== 7. MUST all be 0: two active primaries in a school; an active primary of an account that is not ACTIVE; an ended primary'
SELECT (SELECT count(*) FROM (SELECT "schoolId" FROM "TeacherSchoolAssignment" WHERE "isActive" AND "role" = 'PRIMARY'
                                GROUP BY "schoolId" HAVING count(*) > 1) d)                                           AS schools_with_two_primaries,
       (SELECT count(*) FROM "TeacherSchoolAssignment" t JOIN "User" u ON u."id" = t."teacherId"
         WHERE t."isActive" AND t."role" = 'PRIMARY' AND u."accountStatus" <> 'ACTIVE')                               AS inactive_account_primaries,
       (SELECT count(*) FROM "TeacherSchoolAssignment" WHERE NOT "isActive" AND "role" = 'PRIMARY')                   AS ended_primaries;

\echo '== 8. MUST be 0 right after the migration: schools whose primary is not their earliest active link of an ACTIVE account (createdAt, then id)'
SELECT count(*) AS primary_not_earliest
  FROM (SELECT DISTINCT ON (t."schoolId") t."schoolId", t."role"
          FROM "TeacherSchoolAssignment" t JOIN "User" u ON u."id" = t."teacherId"
         WHERE t."isActive" AND u."accountStatus" = 'ACTIVE'
         ORDER BY t."schoolId", t."createdAt", t."id") e
 WHERE e."role" <> 'PRIMARY';

\echo '== 9. compare: teacher–school links (MUST equal the pre-check: none made, ended or removed)'
SELECT count(*) AS links, count(*) FILTER (WHERE "isActive") AS active_links, count(*) FILTER (WHERE NOT "isActive") AS ended_links
  FROM "TeacherSchoolAssignment";

\echo '== 10. compare: what the migration did (MUST equal the first six values of the pre-check report; its seventh, ties resolved by id, is information only)'
WITH per AS (
  SELECT s."id",
         count(t."id") FILTER (WHERE t."isActive")                          AS active_links,
         count(t."id") FILTER (WHERE t."isActive" AND t."role" = 'PRIMARY')   AS primaries,
         count(t."id") FILTER (WHERE t."isActive" AND t."role" = 'SECONDARY') AS secondaries
    FROM "School" s
    LEFT JOIN "TeacherSchoolAssignment" t ON t."schoolId" = s."id"
   GROUP BY s."id"
)
SELECT count(*)                                                AS schools_examined,
       count(*) FILTER (WHERE active_links > 0)               AS schools_with_teachers,
       count(*) FILTER (WHERE primaries > 0)                  AS schools_assigned_a_primary,
       count(*) FILTER (WHERE secondaries > 0)                AS schools_with_secondaries,
       count(*) FILTER (WHERE active_links = 0)               AS schools_without_teachers,
       count(*) FILTER (WHERE active_links > 0 AND primaries = 0) AS exceptions
  FROM per;

\echo '== 11. MUST be 1, 1, 1, 0: BulkOperation.entityType, BulkOperationItem.entityId (NOT NULL), the (operationId, entityId) unique index; USER items whose userId differs from entityId'
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperation' AND column_name = 'entityType') AS bulk_entity_type_column,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'BulkOperationItem' AND column_name = 'entityId' AND is_nullable = 'NO') AS bulk_entity_id_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'BulkOperationItem_operationId_entityId_key') AS bulk_entity_unique_index,
       (SELECT count(*) FROM "BulkOperationItem" i JOIN "BulkOperation" o ON o."id" = i."operationId"
         WHERE o."entityType" = 'USER' AND i."userId" IS DISTINCT FROM i."entityId") AS user_items_not_backfilled;

\echo '== 12. MUST be 0 right after the migration: operations of another record type than USER'
SELECT count(*) AS non_user_operations FROM "BulkOperation" WHERE "entityType" <> 'USER';

\echo '== 13. compare: bulk operations and their items (MUST equal pre-check section 7)'
SELECT count(*) AS operations, count(*) FILTER (WHERE "emailJobId" IS NOT NULL) AS with_email_job,
       count(DISTINCT "action") AS actions, md5(string_agg("id" || ':' || "action" || ':' || "status"::text || ':' || "total" || ':' || coalesce("emailJobId", '-'), ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperation";
SELECT "outcome"::text, count(*) AS items, md5(string_agg("operationId" || ':' || "userId", ',' ORDER BY "id")) AS fingerprint
  FROM "BulkOperationItem" GROUP BY "outcome" ORDER BY 1;

ROLLBACK;
