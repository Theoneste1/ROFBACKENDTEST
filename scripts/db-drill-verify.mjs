#!/usr/bin/env node
/**
 * Backup/restore drill verification (P0-04) — read-only checks of a RESTORED
 * database (e.g. a Neon branch created from production "Past data").
 *
 *   node scripts/db-drill-verify.mjs [--trigger-test] [--json <file>]
 *   node scripts/db-drill-verify.mjs --check-target   (target guard only; no connection)
 *
 * Connection: DRILL_DATABASE_URL from `.env.drill.local` (git-ignored). A pooled
 * Neon string ("-pooler" host) is switched to the same branch's direct
 * endpoint in memory, so the read-only session setting holds.
 *
 * Target guard (fails closed — nothing connects unless every rule passes):
 *   - The production host MUST be established from the production
 *     configuration: every DATABASE_URL in `.env.production.local` (the
 *     documented local copy of Render's DATABASE_URL, deploy/render/README.md).
 *     If that file or value is missing or not a valid URL → exit 4.
 *   - The drill host must differ from the production host and from every
 *     database the app is configured to use: DATABASE_URL in `.env`,
 *     `.env.local` and the process environment → otherwise exit 3.
 *   - Hosts are compared case-insensitively with "-pooler" removed, so the
 *     pooled and direct endpoints of one Neon branch count as the same host.
 *
 * Safety:
 *   - Every check runs in a READ ONLY session.
 *   - --trigger-test runs ONE `UPDATE "AuditLog"` inside a transaction that is
 *     always rolled back, to prove the append-only trigger rejects edits.
 *   - Never prints connection strings, record contents or personal data: only
 *     counts, names of tables/constraints/triggers, and hashes of sorted ids.
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 drill URL missing or
 * invalid · 3 refused (target is production or an app database) · 4 production
 * host could not be established.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/** Every value of `key` in a dotenv-style text (supports `export KEY=`, spaces around `=`, quotes). */
export function envValues(text, key) {
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`);
  return text.split(/\r?\n/).map((l) => l.match(re)).filter(Boolean)
    .map((m) => m[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim());
}

/**
 * Normalised host of a database URL, as node-postgres will resolve it: percent-decoded, lower case,
 * trailing dots and "-pooler" removed. Null when it is not a valid URL with a host.
 */
export function hostOf(url) {
  try {
    const h = decodeURIComponent(new URL(url).hostname).toLowerCase().replace(/\.+$/, '').replace('-pooler', '');
    return h || null;
  } catch { return null; }
}

/** The first label of a normalised host (a Neon endpoint id, "ep-…"). */
const firstLabel = (host) => host.split('.')[0];

/**
 * Query parameters with which node-postgres (pg-connection-string) or libpq would connect somewhere
 * other than the URL's host. A drill URL carrying any of them is refused: the guard could not vouch
 * for the host actually used.
 */
export const REDIRECTING_PARAMS = ['host', 'hostaddr', 'port', 'service', 'options'];

/**
 * Decide whether the drill target may be used. Pure: no I/O.
 * @param {{ drillUrls: string[], productionUrls: string[], appUrls: string[] }} input
 *   drillUrls — DRILL_DATABASE_URL values; productionUrls — DATABASE_URL values from the
 *   production configuration; appUrls — DATABASE_URL values the app may use locally.
 * @returns {{ ok: true, url: string, pooled: boolean } | { ok: false, code: number, reason: string }}
 */
export function resolveDrillTarget({ drillUrls, productionUrls, appUrls }) {
  if (drillUrls.length === 0) return { ok: false, code: 2, reason: 'DRILL_DATABASE_URL not found in .env.drill.local' };
  if (drillUrls.length > 1) return { ok: false, code: 2, reason: 'DRILL_DATABASE_URL is defined more than once in .env.drill.local' };
  const drillHost = hostOf(drillUrls[0]);
  if (!drillHost) return { ok: false, code: 2, reason: 'DRILL_DATABASE_URL is not a valid database URL' };
  const params = new URL(drillUrls[0]).searchParams;
  const redirecting = REDIRECTING_PARAMS.filter((p) => params.has(p));
  if (redirecting.length) {
    return { ok: false, code: 3, reason: `REFUSED: DRILL_DATABASE_URL carries ${redirecting.join(', ')} query parameter(s), which could connect elsewhere than its host. Use the connection string exactly as the Neon console shows it.` };
  }

  if (productionUrls.length === 0) {
    return { ok: false, code: 4, reason: 'production host unknown: DATABASE_URL not found in .env.production.local — refusing to run against an unverified target' };
  }
  const prodHosts = productionUrls.map(hostOf);
  if (prodHosts.some((h) => !h)) {
    return { ok: false, code: 4, reason: 'production host unknown: DATABASE_URL in .env.production.local is not a valid URL — refusing to run against an unverified target' };
  }
  // Compared by full host AND by endpoint id (first label): a Neon branch has its own endpoint id.
  if (prodHosts.includes(drillHost) || prodHosts.map(firstLabel).includes(firstLabel(drillHost))) {
    return { ok: false, code: 3, reason: 'REFUSED: the drill host is the production host. Point DRILL_DATABASE_URL at the recovery branch.' };
  }
  if (appUrls.map(hostOf).filter(Boolean).includes(drillHost)) {
    return { ok: false, code: 3, reason: 'REFUSED: the drill host is a database the app is configured to use (.env, .env.local or DATABASE_URL in the environment). Use a dedicated recovery branch.' };
  }

  // A pooled (PgBouncer, transaction mode) connection does not keep session
  // settings such as READ ONLY between transactions. Use the same branch's
  // direct endpoint (Neon: the host without "-pooler"), in memory only.
  // The URL handed on carries exactly the host the guard checked (decoded, no trailing dot).
  const u = new URL(drillUrls[0]);
  const pooled = u.hostname.toLowerCase().includes('-pooler');
  u.hostname = drillHost;
  return { ok: true, url: u.toString(), pooled };
}

/** Tables check: every Prisma model has its table and there are no unexpected tables (besides `_prisma_migrations`). */
export function checkTables(models, tables) {
  const missingTables = models.filter((m) => !tables.includes(m));
  const extraTables = tables.filter((t) => !models.includes(t) && t !== '_prisma_migrations');
  return { ok: missingTables.length === 0 && extraTables.length === 0, missingTables, extraTables };
}

/** Reads the guard inputs from the working directory and the environment. */
export function readTargetInputs(env = process.env) {
  const values = (file, key) => (existsSync(file) ? envValues(readFileSync(file, 'utf8'), key) : []);
  return {
    drillUrls: values('.env.drill.local', 'DRILL_DATABASE_URL'),
    productionUrls: values('.env.production.local', 'DATABASE_URL'),
    appUrls: [...values('.env', 'DATABASE_URL'), ...values('.env.local', 'DATABASE_URL'), ...(env.DATABASE_URL ? [env.DATABASE_URL] : [])],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const TRIGGER_TEST = args.includes('--trigger-test');
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

  const target = resolveDrillTarget(readTargetInputs());
  if (!target.ok) { console.error(`✗ ${target.reason}`); process.exit(target.code); }
  if (args.includes('--check-target')) {
    console.log(`✔ target guard passed: production host established; drill host differs from production and app databases${target.pooled ? ' (pooled string → direct endpoint)' : ''}. No connection made.`);
    process.exit(0);
  }
  const { url: drillUrl, pooled } = target;

  const results = { startedAt: new Date().toISOString(), target: { configuredAsPooled: pooled, connectedVia: 'direct endpoint' }, checks: [] };
  const record = (name, ok, detail) => { results.checks.push({ name, ok, detail }); console.log(`${ok ? '✔' : '✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
  const q = async (c, sql, params) => (await c.query(sql, params)).rows;

  const t0 = Date.now();
  const client = new pg.Client({ connectionString: drillUrl });
  await client.connect();
  const connectMs = Date.now() - t0;
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    await client.query("SET statement_timeout = '60s'");

    // 1. Connection and server
    const [info] = await q(client, `select version() v, current_database() db, current_setting('transaction_read_only') ro, pg_size_pretty(pg_database_size(current_database())) size`);
    results.target.database = info.db;
    results.target.connectMs = connectMs;
    record('connected (read-only session)', info.ro === 'on', `database ${info.db}, ${info.v.split(' on ')[0]}, size ${info.size}, connect ${connectMs} ms${pooled ? ' (configured string was pooled; connected to the direct endpoint)' : ''}`);

    // 2. Migrations
    const migDirs = readdirSync('prisma/migrations', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const migs = await q(client, `select migration_name, finished_at is not null finished, rolled_back_at is not null rolled_back from "_prisma_migrations" order by migration_name`);
    const applied = migs.filter((m) => m.finished && !m.rolled_back).map((m) => m.migration_name);
    const failed = migs.filter((m) => !m.finished || m.rolled_back).map((m) => m.migration_name);
    const missing = migDirs.filter((d) => !applied.includes(d));
    const unknown = applied.filter((a) => !migDirs.includes(a));
    record('migrations: all repository migrations applied, none failed', failed.length === 0 && missing.length === 0 && unknown.length === 0,
      { repository: migDirs.length, applied: applied.length, failed, missing, unknown });

    // 3. Tables expected from the Prisma schema — none missing, none unexpected
    const models = [...readFileSync('prisma/schema.prisma', 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]).sort();
    const tables = (await q(client, `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).map((r) => r.table_name);
    const tableCheck = checkTables(models, tables);
    record('tables: every Prisma model has its table, no unexpected tables', tableCheck.ok,
      { models: models.length, tablesInDb: tables.length, missingTables: tableCheck.missingTables, extraTables: tableCheck.extraTables });

    // 4. Exact row counts
    const counts = {};
    for (const t of tables) counts[t] = (await q(client, `select count(*)::int n from "${t}"`))[0].n;
    results.rowCounts = counts;
    record('row counts (exact)', true, `${Object.values(counts).reduce((a, b) => a + b, 0)} rows in ${tables.length} tables; non-empty: ${Object.entries(counts).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`).join(', ')}`);

    // 5. Foreign-key integrity (no orphans)
    const fks = await q(client, `
      select con.conname, cl.relname child, pcl.relname parent,
             array_agg(ca.attname::text order by k.ord) child_cols, array_agg(pa.attname::text order by k.ord) parent_cols
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
      join pg_class pcl on pcl.oid = con.confrelid
      join lateral unnest(con.conkey, con.confkey) with ordinality as k(ck, pk, ord) on true
      join pg_attribute ca on ca.attrelid = con.conrelid and ca.attnum = k.ck
      join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = k.pk
      where con.contype = 'f' group by con.conname, cl.relname, pcl.relname`);
    const orphans = [];
    for (const fk of fks) {
      const join = fk.child_cols.map((c, i) => `p."${fk.parent_cols[i]}" = c."${c}"`).join(' and ');
      const notNull = fk.child_cols.map((c) => `c."${c}" is not null`).join(' and ');
      const n = (await q(client, `select count(*)::int n from "${fk.child}" c where ${notNull} and not exists (select 1 from "${fk.parent}" p where ${join})`))[0].n;
      if (n > 0) orphans.push(`${fk.conname}: ${n}`);
    }
    record('foreign keys: no orphaned rows', orphans.length === 0, { foreignKeysChecked: fks.length, orphans });

    // 6. Constraints, indexes, triggers
    const [obj] = await q(client, `select
      (select count(*)::int from pg_indexes where schemaname='public') indexes,
      (select count(*)::int from pg_constraint c join pg_namespace n on n.oid=c.connamespace and n.nspname='public' where contype='p') primary_keys,
      (select count(*)::int from pg_constraint c join pg_namespace n on n.oid=c.connamespace and n.nspname='public' where contype='u') unique_constraints`);
    const triggers = (await q(client, `select t.tgname, c.relname, t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal order by 1`));
    const want = ['audit_log_append_only', 'audit_log_fill_actor'];
    const presentEnabled = want.filter((w) => triggers.some((t) => t.tgname === w && t.tgenabled !== 'D'));
    record('indexes and constraints present', obj.indexes > 0 && obj.primary_keys >= models.length, obj);
    record('audit-log triggers present and enabled', presentEnabled.length === want.length, triggers.map((t) => `${t.tgname} on ${t.relname} (${t.tgenabled === 'O' ? 'enabled' : t.tgenabled})`));

    // 7. Integrity fingerprints (hash of sorted ids — no content)
    const fp = {};
    for (const t of tables) {
      const hasId = (await q(client, `select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='id'`, [t])).length > 0;
      if (!hasId || counts[t] === 0) continue;
      const [{ h }] = await q(client, `select md5(string_agg(id::text, ',' order by id::text)) h from "${t}"`);
      fp[t] = h.slice(0, 16);
    }
    results.idFingerprints = fp;
    record('id fingerprints computed (for comparison with later restores)', true, `${Object.keys(fp).length} tables`);

    // 8. Representative aggregates (no personal data)
    const agg = {
      usersByRole: Object.fromEntries((await q(client, `select role::text r, count(*)::int n from "User" group by 1 order by 1`)).map((r) => [r.r, r.n])),
      usersActiveActivatedApproved: (await q(client, `select count(*) filter (where "isActive")::int active, count(*) filter (where "activatedAt" is not null)::int activated, count(*) filter (where "isApproved")::int approved from "User"`))[0],
      usersWithPasswordHash: (await q(client, `select count(*)::int n from "User" where "passwordHash" is not null`))[0].n,
      coursesByStatus: Object.fromEntries((await q(client, `select status::text s, count(*)::int n from "Course" group by 1 order by 1`)).map((r) => [r.s, r.n])),
      divisions: (await q(client, `select code::text c from "Division" order by 1`)).map((r) => r.c),
      currentAcademicYear: (await q(client, `select name, status::text from "AcademicYear" where "isCurrent"`))[0] ?? null,
      auditLogLatest: (await q(client, `select max("createdAt") t from "AuditLog"`))[0].t,
      filesByPurpose: Object.fromEntries((await q(client, `select purpose::text p, count(*)::int n from "FileObject" group by 1 order by 1`)).map((r) => [r.p, r.n])),
    };
    results.aggregates = agg;
    record('representative aggregates readable', true, agg);
  } finally {
    await client.end();
  }

  // 9. Optional: append-only trigger test — separate connection, always rolled back
  if (TRIGGER_TEST) {
    const c2 = new pg.Client({ connectionString: drillUrl });
    await c2.connect();
    let rejected = false, message = '';
    try {
      await c2.query('BEGIN');
      try {
        const r = await c2.query(`UPDATE "AuditLog" SET "action" = "action" WHERE "id" = (SELECT "id" FROM "AuditLog" ORDER BY "createdAt" LIMIT 1)`);
        message = `UPDATE was NOT rejected (${r.rowCount} row(s)) — trigger not effective`;
      } catch (err) {
        rejected = true;
        message = `rejected: ${String(err.message).split('\n')[0].slice(0, 120)}`;
      }
    } finally {
      await c2.query('ROLLBACK').catch(() => {});
      await c2.end();
    }
    record('audit log is append-only (UPDATE inside a rolled-back transaction)', rejected, message);
  }

  results.finishedAt = new Date().toISOString();
  results.durationMs = Date.now() - t0;
  const failedChecks = results.checks.filter((c) => !c.ok);
  console.log(`\n${results.checks.length - failedChecks.length}/${results.checks.length} checks passed in ${results.durationMs} ms`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2) + '\n');
  process.exit(failedChecks.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
