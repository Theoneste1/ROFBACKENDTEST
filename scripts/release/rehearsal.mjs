#!/usr/bin/env node
/**
 * Migration rehearsal on a Neon BRANCH of production — never production itself.
 * Checklist: docs/operations/REHEARSAL-NEON-CHECKLIST.md (Phase 1) and docs/operations/RELEASE-POST-PHASE1.md.
 *
 * Every command takes --release <phase1|post-phase1|areas-2026> (default phase1, the kit's original behaviour):
 *   phase1       the 14 Phase 1 migrations (M1–M14); refuses a checkout or database with anything after M14.
 *   post-phase1  the 11 migrations after M14 (scripts/release/releases.mjs); the target must already hold Phase 1;
 *                refuses a checkout without exactly those eleven, or a checkout or database with anything after them.
 *   areas-2026   the design-area migrations after those eleven (area 1 as simplified by the owner 2026-11-19: countries;
 *                the primary teacher of a school, owner decision 2026-11-19; Test Management Phases 1 to 3, 2026-11-19);
 *                the target must already hold Phase 1 and post-Phase-1; same checkout and database rules.
 *
 *   node scripts/release/rehearsal.mjs check-target                 guard only, no connection
 *   node scripts/release/rehearsal.mjs precheck                     the release's precheck SQL (read only)
 *   node scripts/release/rehearsal.mjs status                       prisma migrate status
 *   node scripts/release/rehearsal.mjs deploy   --confirm <ep-id>   prisma migrate deploy        (WRITES to the branch)
 *   node scripts/release/rehearsal.mjs diff                         prisma migrate diff … --exit-code
 *   node scripts/release/rehearsal.mjs postcheck                    the release's postcheck SQL (read only)
 *   node scripts/release/rehearsal.mjs rollback --confirm <ep-id>   the release's docs/migrations rollbacks, newest first (WRITES)
 *   node scripts/release/rehearsal.mjs rollback-history --confirm <ep-id>
 *                                                                   deletes the release's history rows once its objects are
 *                                                                   gone: M9–M14 (phase1) or all eleven (post-phase1) (WRITES)
 *   node scripts/release/rehearsal.mjs dump --out <dir> --confirm <ep-id>
 *                                                                   pg_dump of the target into an EFS-encrypted
 *                                                                   folder outside the repository and OneDrive
 *   node scripts/release/rehearsal.mjs restore --dump <file> --confirm <ep-id>
 *                                                                   pg_restore into the target, which must be empty (WRITES)
 *
 * Run it from the root of the checkout it belongs to (refused otherwise): it reads `.env*.local` from
 * the working directory and its SQL files, migrations and Prisma configuration from this checkout.
 * The kit never dumps production: `dump` goes through the same guard as every other command. The
 * production dump of the release window is a separate, owner-approved step (RELEASE-PHASE1-RUNBOOK §2).
 *
 * Target: DRILL_DATABASE_URL in `.env.drill.local` (git-ignored), checked by the same fail-closed guard
 * as scripts/db-drill-verify.mjs: the production host must be known from `.env.production.local` and
 * the target must differ from it and from every database the app is configured to use. A pooled
 * string is switched to the branch's direct endpoint (Prisma's migration lock needs it).
 * Migration role (optional): DRILL_MIGRATION_DATABASE_URL in the same file — the branch's table OWNER (e.g. neondb_owner),
 * used only by the commands that change schema or migration history (status, deploy, diff, rollback, rollback-history,
 * dump, restore); the read-only checks keep the application role. It passes the same guard and must also be on the SAME
 * endpoint as DRILL_DATABASE_URL and must NOT carry a password used in .env.production.local (a branch copies its
 * parent's role passwords: reset the owner's password on the branch first). See resolveMigrationTarget.
 * Writing commands also need --confirm with the target's endpoint id (the first part of its host,
 * "ep-…", read from the Neon console), so a wrong file cannot be written to by accident.
 * Prisma's child process gets DATABASE_URL = the checked target and no DOTENV_* switches (childEnv).
 * Never prints the connection string or a password. Prisma's own output and pg/Prisma connection
 * errors may show the branch host and user name (not secret).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { REPO_ROOT, VERIFIER, envValues, resolveDrillTarget, readTargetInputs } from '../db-drill-verify.mjs';
import { PHASE1, PHASE1_COUNT, laterMigrations, migrationDirs } from './phase1.mjs';
import { RELEASE_NAMES, afterRelease, checkoutProblem, releaseFrom, releasePreSwitchFiles, releaseRollbackFiles } from './releases.mjs';

export { PHASE1 };
const WRITES = new Set(['deploy', 'rollback', 'rollback-history', 'dump', 'restore']);
const HISTORY_ONLY = ['20261121000800', '20261121000900', '20261121001000', '20261121001100', '20261121001200', '20261121001300'];
/** Objects M9–M14 create. Their history rows may only be removed once every one of them is gone. */
export const M9_M14_TABLES = ['StudentSchoolAffiliation', 'EducationLevel', 'Programme', 'SchoolContact', 'SchoolDataSource',
  'SchoolEducationLevel', 'SchoolExternalId', 'SchoolProgramme', 'SchoolSourceRecord', 'SchoolSyncChange', 'SchoolSyncItem', 'SchoolSyncRun'];
export const M9_M14_ENUMS = ['ProgrammeCategory', 'SchoolAccommodation', 'SchoolAffiliationSource', 'SchoolAffiliationStatus', 'SchoolContactType',
  'SchoolContactVisibility', 'SchoolExternalIdKind', 'SchoolSource', 'SchoolSyncChangeKind', 'SchoolSyncConflictState', 'SchoolSyncDecision',
  'SchoolSyncItemOutcome', 'SchoolSyncRunStatus'];

/**
 * The environment of the Prisma child process: DATABASE_URL is the checked target, and every DOTENV_*
 * switch is removed — prisma7.config.ts loads `.env` with dotenv, and DOTENV_OVERRIDE / DOTENV_PATH /
 * DOTENV_CONFIG_* in the shell would let `.env` (or another file) replace the target.
 */
export function childEnv(env, url) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^DOTENV_/i.test(k)));
  out.DATABASE_URL = url;
  return out;
}

/** The Phase 1 rollback files, newest first; exactly 14 or an error. */
export function rollbackFiles(names) {
  const files = names.filter((f) => PHASE1.test(f) && f.endsWith('.rollback.sql')).sort().reverse();
  if (files.length !== PHASE1_COUNT) throw new Error(`expected ${PHASE1_COUNT} Phase 1 rollback files in docs/migrations, found ${files.length}`);
  return files;
}

/** The endpoint id of a database URL ("ep-…", the first label of the host, "-pooler" removed). */
export function endpointId(url) {
  return new URL(url).hostname.replace('-pooler', '').split('.')[0].toLowerCase();
}

/** Commands that run as the migration role when DRILL_MIGRATION_DATABASE_URL is set (they change schema or history). */
export const MIGRATION_ROLE_COMMANDS = new Set(['status', 'deploy', 'diff', 'rollback', 'rollback-history', 'dump', 'restore']);

/**
 * The connection for schema changes (pure). Without DRILL_MIGRATION_DATABASE_URL: the application target, as before.
 * With it: the same guard as the application target, the SAME endpoint, and never a production password (compared in
 * memory, never printed). @returns {{ ok: true, url: string, role: string, separate: boolean } | { ok: false, code: number, reason: string }}
 */
export function resolveMigrationTarget(appTarget, { migrationUrls, productionUrls, appUrls }) {
  const roleOf = (u) => decodeURIComponent(new URL(u).username);
  if (migrationUrls.length === 0) return { ok: true, url: appTarget.url, role: roleOf(appTarget.url), separate: false };
  if (migrationUrls.length > 1) return { ok: false, code: 2, reason: 'DRILL_MIGRATION_DATABASE_URL is defined more than once in .env.drill.local' };
  const m = resolveDrillTarget({ drillUrls: migrationUrls, productionUrls, appUrls });
  if (!m.ok) return { ok: false, code: m.code, reason: m.reason.replace('DRILL_DATABASE_URL', 'DRILL_MIGRATION_DATABASE_URL') };
  if (endpointId(m.url) !== endpointId(appTarget.url) || new URL(m.url).hostname !== new URL(appTarget.url).hostname) {
    return { ok: false, code: 3, reason: 'REFUSED: DRILL_MIGRATION_DATABASE_URL is not on the same endpoint as DRILL_DATABASE_URL.' };
  }
  const password = decodeURIComponent(new URL(m.url).password);
  const prodPasswords = productionUrls.map((u) => { try { return decodeURIComponent(new URL(u).password); } catch { return null; } }).filter(Boolean);
  if (!password || prodPasswords.includes(password)) {
    return { ok: false, code: 3, reason: 'REFUSED: DRILL_MIGRATION_DATABASE_URL carries a production password (a branch copies the parent role passwords). Reset that role password ON THE BRANCH in the Neon console, then use the new string.' };
  }
  return { ok: true, url: m.url, role: roleOf(m.url), separate: true };
}

/** Splits a psql-style file into SQL segments and `\echo` lines; any other meta-command is refused. */
export function segments(text) {
  const out = [];
  let current = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const echo = /^\\echo\s+'?(.*?)'?\s*$/.exec(line);
    if (echo) { out.push(current.join('\n')); out.push({ echo: echo[1] }); current = []; continue; }
    if (line.startsWith('\\')) throw new Error(`unsupported psql meta-command: ${line}`);
    current.push(line);
  }
  out.push(current.join('\n'));
  return out.filter((s) => typeof s === 'object' || s.replace(/--[^\n]*/g, '').trim());
}

// ── Backup drill helpers (pure, tested) ─────────────────────────────────────────────────────────────

/** Same path, compared case-insensitively on Windows. */
const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
/** `child` is `parent` or inside it. */
export function isInside(child, parent, win = process.platform === 'win32') {
  const norm = (p) => (win ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where a dump may be written: an absolute, existing folder, outside the repository and outside every
 * OneDrive folder (synced to the cloud), with the Windows EFS "Encrypted" attribute — so the dump is
 * never stored unencrypted. `attributesOf(dir)` returns the folder's attribute string (injected for tests).
 */
export function checkDumpDir(dir, { env = process.env, repoRoot = REPO_ROOT, platform = process.platform, attributesOf } = {}) {
  if (!dir || !isAbsolute(dir)) return 'give --out as an absolute folder path';
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 'the --out folder does not exist';
  if (isInside(dir, repoRoot, platform === 'win32')) return 'the --out folder is inside the repository';
  const oneDrives = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map((k) => env[k]).filter(Boolean);
  if (oneDrives.some((o) => isInside(dir, o, platform === 'win32')) || /(^|[\\/])onedrive( - [^\\/]*)?([\\/]|$)/i.test(dir)) {
    return 'the --out folder is inside OneDrive (synced to the cloud)';
  }
  if (platform !== 'win32') return 'the encrypted-folder check is implemented for Windows (EFS) only';
  if (!/\bEncrypted\b/.test(attributesOf(dir) ?? '')) return 'the --out folder is not EFS-encrypted (cipher /e <folder>)';
  return null;
}

/** libpq conninfo for a URL, WITHOUT the password (given to the child through PGPASSWORD only). */
export function conninfoFrom(url) {
  const u = new URL(url);
  const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const parts = { host: decodeURIComponent(u.hostname), port: u.port || '5432', dbname: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username), sslmode: u.searchParams.get('sslmode') ?? 'require' };
  return Object.entries(parts).filter(([, v]) => v).map(([k, v]) => `${k}=${q(v)}`).join(' ');
}

/** Environment of pg_dump / pg_restore: no PG* variable from the shell (PGSERVICE, PGHOST… could redirect), PGPASSWORD from the URL. */
export function pgToolEnv(env, url) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !/^PG/i.test(k) && !/^DOTENV_/i.test(k)));
  const password = decodeURIComponent(new URL(url).password);
  if (password) out.PGPASSWORD = password;
  return out;
}

/** Major version from `pg_dump --version` ("pg_dump (PostgreSQL) 18.1") or a server_version_num (180006). */
export const toolMajor = (text) => Number((/\(PostgreSQL\)\s+(\d+)/.exec(text) ?? [])[1] ?? NaN);
export const serverMajor = (num) => Math.floor(Number(num) / 10_000);

function windowsAttributes(dir) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:ROF_DIR -Force).Attributes.ToString()'],
    { encoding: 'utf8', env: { ...process.env, ROF_DIR: dir } });
  return r.status === 0 ? r.stdout.trim() : '';
}

function pgTool(name) {
  const bin = process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error(`${name} not found (install the PostgreSQL 18 client tools, or set PG_BIN)`);
  return { bin, major: toolMajor(v.stdout) };
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function dump(target, out) {
  const problem = checkDumpDir(out, { attributesOf: windowsAttributes });
  if (problem) throw new Error(`refused: ${problem}`);
  const tool = pgTool('pg_dump');
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  let server;
  try { server = serverMajor((await client.query('SHOW server_version_num')).rows[0].server_version_num); } finally { await client.end(); }
  if (!(tool.major >= server)) throw new Error(`refused: pg_dump ${tool.major} is older than the server (${server})`);
  const file = join(out, `rehearsal-${endpointId(target.url)}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const r = spawnSync(tool.bin, ['--format=custom', '--no-owner', '--no-acl', `--file=${file}`, `--dbname=${conninfoFrom(target.url)}`],
    { stdio: ['ignore', 'inherit', 'inherit'], env: pgToolEnv(process.env, target.url) });
  if (r.status !== 0) { rmSync(file, { force: true }); throw new Error(`pg_dump failed (exit ${r.status}); the partial file was deleted`); }
  const list = spawnSync(pgTool('pg_restore').bin, ['--list', file], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('pg_restore --list could not read the dump');
  const tables = list.stdout.split(/\r?\n/).filter((l) => / TABLE DATA /.test(l)).length;
  console.log(`dump: ${basename(file)} in the --out folder; ${statSync(file).size} bytes; ${tables} TABLE DATA entries; sha256 ${sha256(file)}`);
}

async function restore(target, file) {
  if (!file || !isAbsolute(file) || !existsSync(file)) throw new Error('give --dump as the absolute path of an existing dump');
  const problem = checkDumpDir(dirname(file), { attributesOf: windowsAttributes });
  if (problem) throw new Error(`refused: the dump's folder — ${problem}`);
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    const n = Number((await client.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')")).rows[0].n);
    if (n !== 0) throw new Error(`refused: the restore target is not empty (${n} tables); create an empty database for the drill`);
  } finally { await client.end(); }
  const r = spawnSync(pgTool('pg_restore').bin, ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${conninfoFrom(target.url)}`, file],
    { stdio: ['ignore', 'inherit', 'inherit'], env: pgToolEnv(process.env, target.url) });
  if (r.status !== 0) throw new Error(`pg_restore failed (exit ${r.status}); drop and recreate the target database before retrying`);
  console.log('restore: complete. Next: node scripts/db-drill-verify.mjs --baseline pre-phase1 --trigger-test --json <file>');
}

async function runSqlFile(url, file, { readOnly }) {
  const client = new pg.Client({ connectionString: url });
  client.on('notice', (n) => console.log(`NOTICE: ${n.message}`));
  await client.connect();
  try {
    if (readOnly) await client.query('SET default_transaction_read_only = on');
    for (const seg of segments(readFileSync(file, 'utf8'))) {
      if (typeof seg === 'object') { console.log(seg.echo); continue; }
      const res = await client.query(seg);
      for (const r of [res].flat()) if (r.rows?.length) console.table(r.rows);
    }
  } finally {
    await client.end();
  }
}

/** migration_name of every row in _prisma_migrations (none when the table does not exist yet). Read only. */
async function appliedMigrations(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = (await client.query(`SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok;
    if (!exists) return [];
    return (await client.query('SELECT migration_name FROM "_prisma_migrations"')).rows.map((r) => r.migration_name);
  } finally {
    await client.end();
  }
}

function prisma(url, args) {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: REPO_ROOT, env: childEnv(process.env, url) });
  return r.status ?? 1;
}

const opt = (rest, name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);

/**
 * post-Phase-1 / design-areas rollback-history: refuses while any table, enum, column, trigger or function the release's
 * migrations create is still there (release.objects); then deletes exactly their history rows. Returns the exit code.
 */
async function rollbackHistoryRelease(url, release) {
  const label = release.name === 'post-phase1' ? 'post-Phase-1' : release.label;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const o = release.objects;
    const left = (await client.query(
      `SELECT (SELECT array_agg(table_name::text) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)) AS tables,
              (SELECT array_agg(typname::text) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = ANY($2)) AS enums,
              (SELECT array_agg(table_name || '.' || column_name) FROM information_schema.columns
                 WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($3)) AS columns,
              (SELECT array_agg(DISTINCT tgname::text) FROM pg_trigger WHERE tgname = ANY($4)) AS triggers,
              (SELECT array_agg(proname::text) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($5)) AS functions`,
      [o.tables, o.enums, o.columns.map(([t, c]) => `${t}.${c}`), o.triggers, o.functions])).rows[0];
    const remaining = [...(left.tables ?? []), ...(left.enums ?? []).map((e) => `enum ${e}`), ...(left.columns ?? []).map((c) => `column ${c}`),
      ...(left.triggers ?? []).map((x) => `trigger ${x}`), ...(left.functions ?? []).map((x) => `function ${x}`)];
    if (remaining.length) {
      console.error(`✗ refused: the ${label} rollback is not complete (${remaining.join(', ')}). Run \`rollback --release ${release.name}\` first.`);
      return 1;
    }
    const dirs = migrationDirs(REPO_ROOT).filter((d) => release.migrations.includes(d));
    if (dirs.length !== release.migrations.length) throw new Error(`expected ${release.migrations.length} ${label} migration directories, found ${dirs.length}`);
    const names = (await client.query('SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ANY($1) ORDER BY 1', [dirs])).rows.map((r) => r.migration_name);
    const del = await client.query('DELETE FROM "_prisma_migrations" WHERE migration_name = ANY($1)', [names]);
    console.log(`deleted ${del.rowCount} history row(s): ${names.join(', ') || 'none'}`);
    return 0;
  } finally {
    await client.end();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const known = ['check-target', 'precheck', 'status', 'deploy', 'diff', 'postcheck', 'rollback', 'rollback-history', 'dump', 'restore'];
  if (!known.includes(command)) { console.error(`usage: node scripts/release/rehearsal.mjs <${known.join('|')}> [--release <${RELEASE_NAMES.join('|')}>] [--confirm <ep-id>]`); return 2; }
  const release = releaseFrom(rest);
  if (!release) { console.error(`✗ --release must be one of: ${RELEASE_NAMES.join(', ')}`); return 2; }
  if (!samePath(process.cwd(), REPO_ROOT)) {
    console.error('✗ refused: run this from the root of the checkout the script belongs to (cd there first).');
    return 2;
  }
  console.log(`verifier guard: ${VERIFIER}`);
  console.log(`release: ${release.name} — ${release.label}`);

  if (release.name === 'phase1') {
    // Phase 1 only: a checkout with migrations after M14 would make `deploy` apply them too and leave them
    // behind on `rollback` (exit 5, before any target is read).
    const laterInCheckout = laterMigrations(migrationDirs(REPO_ROOT));
    if (laterInCheckout.length) {
      console.error(`✗ refused: this checkout has ${laterInCheckout.length} migration(s) after M14 (${laterInCheckout.join(', ')}). `
        + 'The kit rehearses exactly the 14 Phase 1 migrations: run it from a checkout whose last migration is M14'
        + ' (for the eleven migrations after M14, use --release post-phase1).');
      return 5;
    }
  } else {
    // post-Phase-1 / design areas: exactly the release's migrations in the checkout, nothing after them (exit 5, before any target is read).
    const problem = checkoutProblem(release, migrationDirs(REPO_ROOT));
    if (problem) { console.error(`✗ refused: ${problem}`); return 5; }
  }

  const target = resolveDrillTarget(readTargetInputs());
  if (!target.ok) { console.error(`✗ ${target.reason}`); return target.code; }
  const ep = endpointId(target.url);
  const inputs = readTargetInputs();
  const migration = resolveMigrationTarget(target, {
    migrationUrls: existsSync('.env.drill.local') ? envValues(readFileSync('.env.drill.local', 'utf8'), 'DRILL_MIGRATION_DATABASE_URL') : [],
    productionUrls: inputs.productionUrls, appUrls: inputs.appUrls,
  });
  if (!migration.ok) { console.error(`✗ ${migration.reason}`); return migration.code; }
  const schemaUrl = MIGRATION_ROLE_COMMANDS.has(command) ? migration.url : target.url;
  if (WRITES.has(command)) {
    const confirm = rest.includes('--confirm') ? String(rest[rest.indexOf('--confirm') + 1] ?? '').toLowerCase() : '';
    if (confirm !== ep) { console.error('✗ refused: --confirm must be the rehearsal branch endpoint id (ep-…) shown in the Neon console.'); return 3; }
  }
  console.log(`target: rehearsal branch endpoint ${WRITES.has(command) ? ep : '(guard passed)'} via direct endpoint`);
  console.log(`role: ${MIGRATION_ROLE_COMMANDS.has(command) ? migration.role : decodeURIComponent(new URL(target.url).username)}`
    + `${migration.separate ? ` (migration role ${migration.role} on the same endpoint; production password check passed)` : ''}`);
  const started = Date.now();
  let code = 0;

  // …and a database that already records a migration after the release's last is not that release's state either
  // (exit 5). check-target never connects; restore requires an empty database (no history table).
  if (!['check-target', 'restore'].includes(command)) {
    const applied = await appliedMigrations(target.url);
    const laterInDb = release.name === 'phase1' ? laterMigrations(applied) : afterRelease(release, applied);
    if (laterInDb.length) {
      console.error(release.name === 'phase1'
        ? `✗ refused: the target database records ${laterInDb.length} migration(s) after M14 (${laterInDb.join(', ')}). The kit handles exactly the 14 Phase 1 migrations.`
        : `✗ refused: the target database records ${laterInDb.length} migration(s) after ${release.label}'s last (${laterInDb.join(', ')}).`);
      return 5;
    }
    // post-Phase-1 builds on Phase 1: every M1–M14 must already be recorded (production today).
    if (release.name === 'post-phase1' && command !== 'restore') {
      const phase1Applied = applied.filter((n) => PHASE1.test(n)).length;
      if (phase1Applied !== PHASE1_COUNT) {
        console.error(`✗ refused: the target records ${phase1Applied} of the ${PHASE1_COUNT} Phase 1 migrations; post-phase1 needs all of them first.`);
        return 5;
      }
    }
    // The design areas build on Phase 1 and post-Phase-1: all of them must already be recorded.
    if (release.name === 'areas-2026' && command !== 'restore') {
      const before = applied.filter((n) => release.requires.owns(n)).length;
      if (before !== release.requires.count) {
        console.error(`✗ refused: the target records ${before} of the ${release.requires.count} ${release.requires.label} migrations; ${release.name} needs all of them first.`);
        return 5;
      }
    }
  }

  switch (command) {
    case 'check-target': console.log('✔ guard passed. No connection made.'); break;
    case 'precheck': await runSqlFile(target.url, join(REPO_ROOT, release.precheck), { readOnly: true }); break;
    case 'postcheck': await runSqlFile(target.url, join(REPO_ROOT, release.postcheck), { readOnly: true }); break;
    case 'dump': await dump({ ...target, url: schemaUrl }, opt(rest, '--out')); break;
    case 'restore': await restore({ ...target, url: schemaUrl }, opt(rest, '--dump')); break;
    case 'status': code = prisma(schemaUrl, ['migrate', 'status']); break;
    case 'deploy': code = prisma(schemaUrl, ['migrate', 'deploy']); break;
    case 'diff': code = prisma(schemaUrl, ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code']); break;
    case 'rollback': {
      const docs = readdirSync(join(REPO_ROOT, 'docs/migrations'));
      // Pre-switch steps first (in production they run while the new release still serves; see the runbook §4).
      const preSwitch = release.name === 'phase1' ? [] : releasePreSwitchFiles(release, docs);
      for (const f of [...preSwitch, ...(release.name === 'phase1' ? rollbackFiles(docs) : releaseRollbackFiles(release, docs))]) {
        console.log(`=== ${f}`);
        await runSqlFile(schemaUrl, join(REPO_ROOT, 'docs/migrations', f), { readOnly: false });
      }
      console.log(release.name === 'phase1'
        ? 'Next: rollback-history (M9–M14 rows), then `status` ("Following migrations have not yet been applied:" + the 14 names; exit 1).'
        : release.name === 'post-phase1'
          ? 'Next: rollback-history --release post-phase1 (the eleven rows), then `status --release post-phase1` (the eleven names not yet applied; exit 1).'
          : `Next: rollback-history --release ${release.name} (its ${release.count} rows), then \`status --release ${release.name}\` (those names not yet applied; exit 1).`);
      break;
    }
    case 'rollback-history': {
      if (release.name !== 'phase1') { code = await rollbackHistoryRelease(schemaUrl, release); break; }
      const client = new pg.Client({ connectionString: schemaUrl });
      await client.connect();
      try {
        const left = (await client.query(
          `SELECT (SELECT array_agg(table_name::text) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)) AS tables,
                  (SELECT array_agg(typname::text) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = ANY($2)) AS enums,
                  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_school_affiliation_integrity') AS m10_trigger,
                  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'School' AND column_name = 'source') AS m11_column,
                  NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'School_name_key') AS m12_name_key_missing`,
          [M9_M14_TABLES, M9_M14_ENUMS])).rows[0];
        const remaining = [...(left.tables ?? []), ...(left.enums ?? []).map((e) => `enum ${e}`),
          left.m10_trigger && 'trigger user_school_affiliation_integrity', left.m11_column && 'column School.source',
          left.m12_name_key_missing && 'School_name_key not restored'].filter(Boolean);
        if (remaining.length) {
          console.error(`✗ refused: the M9–M14 rollback is not complete (${remaining.join(', ')}). Run \`rollback\` first.`);
          return 1;
        }
        const exact = readdirSync(join(REPO_ROOT, 'prisma/migrations')).filter((d) => HISTORY_ONLY.some((p) => d.startsWith(`${p}_`)));
        if (exact.length !== HISTORY_ONLY.length) throw new Error(`expected ${HISTORY_ONLY.length} M9–M14 migration directories, found ${exact.length}`);
        const names = (await client.query('SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ANY($1) ORDER BY 1', [exact])).rows.map((r) => r.migration_name);
        const del = await client.query('DELETE FROM "_prisma_migrations" WHERE migration_name = ANY($1)', [names]);
        console.log(`deleted ${del.rowCount} history row(s): ${names.join(', ') || 'none'}`);
      } finally {
        await client.end();
      }
      break;
    }
  }
  console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}
