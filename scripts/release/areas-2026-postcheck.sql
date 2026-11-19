-- Design-areas release post-check (AFTER `prisma migrate deploy` of the countries migration): READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release areas-2026    (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/areas-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with areas-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST: the countries migration applied; nothing failed or rolled back; nothing after 20261211000000'
SELECT count(*) FILTER (WHERE migration_name = '20261211000000_countries_reference'
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS areas_applied,
       count(*) FILTER (WHERE migration_name > '20261211000000_countries_reference')            AS later,
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

ROLLBACK;
