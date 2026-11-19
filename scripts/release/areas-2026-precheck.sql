-- Design-areas release pre-check (BEFORE `prisma migrate deploy` of the countries migration; area 1 as simplified by the
-- owner, 2026-11-19): READ ONLY.
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

\echo '== 2. MUST both be 0: nothing the countries migration creates exists yet'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Country')) AS tables,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'School_countryCode_fkey') AS school_country_fk;

\echo '== 3. MUST be empty: school country codes that are not two upper-case letters (the School → Country foreign key refuses any code that is not ISO 3166-1 alpha-2; the migration names them)'
SELECT DISTINCT "countryCode" FROM "School" WHERE "countryCode" !~ '^[A-Z]{2}$' ORDER BY 1;

\echo '== 4. compare: schools by country (MUST be unchanged after the migration)'
SELECT "countryCode", count(*) FROM "School" GROUP BY "countryCode" ORDER BY 1;

ROLLBACK;
