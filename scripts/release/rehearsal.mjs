#!/usr/bin/env node
/**
 * Migration rehearsal on a Neon BRANCH of production — never production itself.
 * Checklist: docs/operations/REHEARSAL-NEON-CHECKLIST.md (Phase 1) and docs/operations/RELEASE-POST-PHASE1.md.
 *
 * Every command takes --release <phase1|post-phase1|areas-2026|late-2026|dec-2026|levels-2026|launch-2026> (default phase1, the kit's original behaviour):
 *   phase1       the 14 Phase 1 migrations (M1–M14); refuses a checkout or database with anything after M14.
 *   post-phase1  the 11 migrations after M14 (scripts/release/releases.mjs); the target must already hold Phase 1;
 *                refuses a checkout without exactly those eleven, or a checkout or database with anything after them.
 *   areas-2026   the design-area migrations after those eleven (area 1 as simplified by the owner 2026-11-19: countries;
 *                the primary teacher of a school, owner decision 2026-11-19; Test Management Phases 1 to 4, 2026-11-19);
 *                the target must already hold Phase 1 and post-Phase-1; same checkout and database rules.
 *   late-2026    the migrations after the design areas (the sign-up work, owner 2026-11-20: gender at every sign-up; the
 *                home location on every registration form); the target must already hold the three releases before it.
 *   dec-2026     the "Other" Olympiad interest (owner, 2026-11-21); the target must already hold the four releases before it
 *                (production since 2026-11-21).
 *   levels-2026  the Olympiad levels (owner, 2026-11-21: Junior / Middle / Senior, separate from the grade); the target
 *                must already hold the five releases before it (production since 2026-11-22).
 *   launch-2026  the launch release (owner, 2026-11-22/23): directory sync mode, the unlisted school of a teacher
 *                application, registration data, coach programme access, activation per sign-up form, news subscribers;
 *                the target must already hold the six releases before it. Runbook: docs/releases/launch-2026.md.
 *   For every release but phase1, a NEWER checkout (later migrations after the release's) is accepted by the commands
 *   that run only the release's own files and checks: check-target, precheck, postcheck, rollback, rollback-history,
 *   dump, restore. deploy, diff and status act on every migration of the checkout and still refuse it (exit 5).
 *   The DATABASE must never record a migration after the release's last (exit 5), whatever the command.
 *
 * rollback is resumable: before running anything it reads the catalogue and checks each migration against its complete
 * object list (scripts/release/releases.mjs, MIGRATION_OBJECTS: tables, columns, enums and enum values, indexes,
 * constraints, triggers, functions, objects it drops, and for M1–M8 the history row). A migration of which NOTHING remains
 * is skipped ("already rolled back"); one of which some objects remain and some are gone is refused with the list (half
 * rolled back — none of its files run); otherwise its pre-switch and rollback files run as before. A check-only migration
 * (no marker at all: 20261220000000_test_file_purposes, whose rollback keeps its enum values and changes nothing) has its
 * file run every time the rollback reaches it, so its guard is never skipped. Every data-loss guard is
 * kept: a guard that refuses stops the run with nothing of that file applied; the same command run again continues there.
 *   --acknowledge <id>     (rollback only; repeatable, each id once) supplies the acknowledgement one guard checks, from the
 *                          FIXED allow-list ACKNOWLEDGEMENTS in releases.mjs (only the release's own ids), e.g.
 *                          --acknowledge registration-details  sets rof.registration_details_rollback =
 *                          'discard-registration-details' on the rollback connection. Unknown, malformed or repeated ids are
 *                          refused before any connection (exit 2). Every acknowledgement in effect (from --acknowledge or from
 *                          PGOPTIONS "-c rof.…=…", which still works) is printed.
 *   --stop-after <n>       (rollback only) stops after n files have run — for rehearsing an interruption and its resumption.
 * dump / restore need pg_dump and pg_restore at least as new as the server: on PATH, or in the folder PG_BIN names
 * (PowerShell: $env:PG_BIN = "C:\Program Files\PostgreSQL\18\bin"; Git Bash: export PG_BIN="C:/Program Files/PostgreSQL/18/bin").
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
import { ACKNOWLEDGEMENTS, MIGRATION_OBJECTS, RELEASE_NAMES, afterRelease, checkoutProblem, releaseAcknowledgements, releaseFrom, releasePreSwitchFiles,
  releaseRollbackFiles, resolveAcknowledgements } from './releases.mjs';
import { catalogLabels, historyLabels, markers } from './catalog.mjs';

export { PHASE1 };
const WRITES = new Set(['deploy', 'rollback', 'rollback-history', 'dump', 'restore']);
/**
 * Commands that run only the release's own files and checks (or none): for post-phase1 and areas-2026 they accept a
 * checkout with later migrations. deploy, diff and status act on every migration of the checkout and keep the strict rule.
 */
export const CHECKOUT_RELEASE_ONLY = new Set(['check-target', 'precheck', 'postcheck', 'rollback', 'rollback-history', 'dump', 'restore']);
const DOCS_MIGRATIONS = join(REPO_ROOT, 'docs/migrations');
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

/** How to point the kit at the PostgreSQL client tools (printed with every PG_BIN / pg_dump problem). */
export const PG_BIN_HINT = [
  'Install the PostgreSQL client tools (the server\'s major version or newer) and point PG_BIN at their bin folder:',
  '  PowerShell:  $env:PG_BIN = "C:\\Program Files\\PostgreSQL\\18\\bin"',
  '  Git Bash:    export PG_BIN="C:/Program Files/PostgreSQL/18/bin"',
  '  or add that folder to PATH.',
].join('\n');

/**
 * Finds and checks pg_dump and pg_restore (pure apart from the injected `run` / `isDir` / `isFile`).
 * PG_BIN set: an absolute path to an existing folder holding both tools (pg_dump.exe / pg_restore.exe on Windows), each
 * answering --version with the same major version. PG_BIN unset: both must be found on PATH.
 * @returns {{ ok: true, dir: string | null, dump: { bin: string, major: number }, restore: { bin: string, major: number } }
 *   | { ok: false, reason: string }}
 */
export function findPgTools({ env = process.env, platform = process.platform, run = spawnSync,
  isDir = (p) => existsSync(p) && statSync(p).isDirectory(), isFile = (p) => existsSync(p) && statSync(p).isFile() } = {}) {
  const exe = (name) => (platform === 'win32' ? `${name}.exe` : name);
  const dir = env.PG_BIN ? env.PG_BIN.trim().replace(/^"(.*)"$/, '$1') : null;
  if (dir !== null) {
    const absolute = platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\)/.test(dir) || isAbsolute(dir) : isAbsolute(dir);
    if (!dir || !absolute) return { ok: false, reason: `PG_BIN must be the absolute path of the folder holding pg_dump and pg_restore (it is "${dir}").\n${PG_BIN_HINT}` };
    if (!isDir(dir)) return { ok: false, reason: `PG_BIN names a folder that does not exist: "${dir}".\n${PG_BIN_HINT}` };
  }
  const tools = {};
  for (const name of ['pg_dump', 'pg_restore']) {
    const bin = dir !== null ? join(dir, exe(name)) : name;
    if (dir !== null && !isFile(bin)) return { ok: false, reason: `PG_BIN ("${dir}") has no ${exe(name)}.\n${PG_BIN_HINT}` };
    const v = run(bin, ['--version'], { encoding: 'utf8' });
    if (v.error || v.status !== 0) {
      return { ok: false, reason: `${name} ${dir !== null ? `in PG_BIN ("${dir}") could not be run` : 'was not found on PATH and PG_BIN is not set'}.\n${PG_BIN_HINT}` };
    }
    const major = toolMajor(v.stdout ?? '');
    if (!Number.isFinite(major)) return { ok: false, reason: `${bin} --version did not report a PostgreSQL version ("${String(v.stdout ?? '').trim()}").\n${PG_BIN_HINT}` };
    tools[name] = { bin, major };
  }
  if (tools.pg_dump.major !== tools.pg_restore.major) {
    return { ok: false, reason: `pg_dump (${tools.pg_dump.major}) and pg_restore (${tools.pg_restore.major}) are from different PostgreSQL versions; use one bin folder.\n${PG_BIN_HINT}` };
  }
  return { ok: true, dir, dump: tools.pg_dump, restore: tools.pg_restore };
}

/** The tools must be at least as new as the server (pg_dump refuses an older client; a dump is read by pg_restore of its version or newer). */
export function pgToolsProblem(tools, server) {
  if (!(tools.dump.major >= server)) {
    return `pg_dump / pg_restore ${tools.dump.major} (${tools.dir ? `PG_BIN "${tools.dir}"` : 'from PATH'}) are older than the server (PostgreSQL ${server}).\n${PG_BIN_HINT.replace(/18/g, String(server))}`;
  }
  return null;
}

function pgTools() {
  const tools = findPgTools();
  if (!tools.ok) throw new Error(`refused: ${tools.reason}`);
  return tools;
}

async function serverVersion(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return serverMajor((await client.query('SHOW server_version_num')).rows[0].server_version_num); } finally { await client.end(); }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function dump(target, out) {
  const problem = checkDumpDir(out, { attributesOf: windowsAttributes });
  if (problem) throw new Error(`refused: ${problem}`);
  const tools = pgTools();
  const versionProblem = pgToolsProblem(tools, await serverVersion(target.url));
  if (versionProblem) throw new Error(`refused: ${versionProblem}`);
  const file = join(out, `rehearsal-${endpointId(target.url)}-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const r = spawnSync(tools.dump.bin,['--format=custom', '--no-owner', '--no-acl', `--file=${file}`, `--dbname=${conninfoFrom(target.url)}`],
    { stdio: ['ignore', 'inherit', 'inherit'], env: pgToolEnv(process.env, target.url) });
  if (r.status !== 0) { rmSync(file, { force: true }); throw new Error(`pg_dump failed (exit ${r.status}); the partial file was deleted`); }
  const list = spawnSync(tools.restore.bin, ['--list', file], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('pg_restore --list could not read the dump');
  const tables = list.stdout.split(/\r?\n/).filter((l) => / TABLE DATA /.test(l)).length;
  console.log(`dump: ${basename(file)} in the --out folder; ${statSync(file).size} bytes; ${tables} TABLE DATA entries; sha256 ${sha256(file)}`);
}

async function restore(target, file) {
  if (!file || !isAbsolute(file) || !existsSync(file)) throw new Error('give --dump as the absolute path of an existing dump');
  const problem = checkDumpDir(dirname(file), { attributesOf: windowsAttributes });
  if (problem) throw new Error(`refused: the dump's folder — ${problem}`);
  const tools = pgTools();
  const versionProblem = pgToolsProblem(tools, await serverVersion(target.url));
  if (versionProblem) throw new Error(`refused: ${versionProblem}`);
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    const n = Number((await client.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')")).rows[0].n);
    if (n !== 0) throw new Error(`refused: the restore target is not empty (${n} tables); create an empty database for the drill`);
  } finally { await client.end(); }
  const r = spawnSync(tools.restore.bin, ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${conninfoFrom(target.url)}`, file],
    { stdio: ['ignore', 'inherit', 'inherit'], env: pgToolEnv(process.env, target.url) });
  if (r.status !== 0) throw new Error(`pg_restore failed (exit ${r.status}); drop and recreate the target database before retrying`);
  console.log('restore: complete. Next: node scripts/db-drill-verify.mjs --baseline pre-phase1 --trigger-test --json <file>');
}

/**
 * Runs a psql-style file on its own connection. `settings`: [name, value] session settings set first (the
 * acknowledgements). A failing statement throws; closing the connection then discards the file's open transaction, so a
 * rollback file (BEGIN … COMMIT) is applied entirely or not at all.
 */
async function runSqlFile(url, file, { readOnly, settings = [], log = console.log, table = console.table }) {
  const client = new pg.Client({ connectionString: url });
  client.on('notice', (n) => log(`NOTICE: ${n.message}`));
  await client.connect();
  try {
    if (readOnly) await client.query('SET default_transaction_read_only = on');
    for (const [name, value] of settings) await client.query('SELECT set_config($1, $2, false)', [name, value]);
    for (const seg of segments(readFileSync(file, 'utf8'))) {
      if (typeof seg === 'object') { log(seg.echo); continue; }
      const res = await client.query(seg);
      for (const r of [res].flat()) if (r.rows?.length) table(r.rows);
    }
  } finally {
    await client.end();
  }
}

// ── Resumable rollback: per-migration state and acknowledgements (tested against a real database in
//    test/release-rollback-resume.e2e-spec.ts) ─────────────────────────────────────────────────────────────────────────

/** The migration a docs/migrations file belongs to. */
export const migrationOfFile = (file) => file.replace(/\.(rollback|pre-switch)\.sql$/, '');

/** The release's pre-switch files and rollback files (each newest first), from the names in docs/migrations. */
export function releaseFiles(release, names) {
  if (release.name === 'phase1') return { preSwitch: [], rollback: rollbackFiles(names) };
  return { preSwitch: releasePreSwitchFiles(release, names), rollback: releaseRollbackFiles(release, names) };
}

/**
 * The data-loss guards written in the release's files: every `current_setting('rof.…', true) IS DISTINCT FROM '…'` and
 * every `coalesce(current_setting('rof.…', true), '') <> '…'` (the two forms used in docs/migrations; they refuse alike
 * unless the setting holds exactly that value), as { migration, setting, value } (comments ignored). The tests compare it
 * with the fixed allow-list ACKNOWLEDGEMENTS.
 */
export function guardsInFiles(release, { docsDir = DOCS_MIGRATIONS, names = readdirSync(docsDir) } = {}) {
  const { preSwitch, rollback } = releaseFiles(release, names);
  const out = [];
  for (const file of [...preSwitch, ...rollback]) {
    const sql = readFileSync(join(docsDir, file), 'utf8').replace(/--[^\n]*/g, '');
    const forms = [/current_setting\(\s*'(rof\.[a-z0-9_]+)'\s*,\s*true\s*\)\s*IS DISTINCT FROM\s*'([^']*)'/gi,
      /coalesce\(\s*current_setting\(\s*'(rof\.[a-z0-9_]+)'\s*,\s*true\s*\)\s*,\s*''\s*\)\s*<>\s*'([^']*)'/gi];
    for (const [, setting, value] of forms.flatMap((re) => [...sql.matchAll(re)])) {
      if (!out.some((g) => g.setting === setting && g.value === value)) out.push({ migration: migrationOfFile(file), setting, value });
    }
  }
  return out.sort((a, b) => a.setting.localeCompare(b.setting));
}

/** Every value given for a repeatable option, in order (`--acknowledge a --acknowledge b` → ['a', 'b']); a missing value is ''. */
export function optionValues(args, name) {
  return args.flatMap((a, i) => (a === name ? [String(args[i + 1] ?? '')] : a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []));
}

/**
 * Each migration's state from the catalogue labels (pure), newest first:
 *   present — every marker of MIGRATION_OBJECTS holds; absent — none holds (already rolled back);
 *   partial — some hold, some do not (half rolled back). `remaining`: the markers that still hold.
 *   A check-only migration (MIGRATION_OBJECTS checkOnly: no marker) is always present with `checkOnly: true`.
 */
export function statesFrom(labels, release) {
  return [...release.migrations].sort().reverse().map((migration) => {
    const o = MIGRATION_OBJECTS[migration];
    if (!o) throw new Error(`no object list for ${migration} in scripts/release/releases.mjs (MIGRATION_OBJECTS)`);
    if (o.checkOnly) {
      if (markers(migration, o).length) throw new Error(`${migration} is check-only but its object list has markers`);
      return { migration, state: 'present', checkOnly: true, remaining: [], gone: [] };
    }
    const all = markers(migration, o);
    if (!all.length) throw new Error(`the object list of ${migration} is empty`);
    const describe = ([label, whenApplied]) => (whenApplied ? label : `${label} still dropped`);
    const holds = all.filter(([label, whenApplied]) => labels.has(label) === whenApplied);
    const missing = all.filter(([label, whenApplied]) => labels.has(label) !== whenApplied);
    return { migration, state: missing.length === 0 ? 'present' : holds.length === 0 ? 'absent' : 'partial',
      remaining: holds.map(describe), gone: missing.map(describe) };
  });
}

/** Each of the release's migrations' state, newest first, read from the target's catalogue (read only). */
export async function migrationStates(client, release) {
  const labels = await catalogLabels(client);
  for (const l of await historyLabels(client, release.migrations)) labels.add(l);
  return statesFrom(labels, release);
}

/**
 * What `rollback` does from these states (pure): pre-switch files first, then the rollback files, newest first; a file
 * whose migration is in place runs, one whose migration is already rolled back is skipped. Refused (nothing runs) when a
 * migration is half rolled back, or when an older migration is rolled back while a newer one is not.
 * @returns {{ ok: true, steps: { file: string, migration: string, kind: 'pre-switch' | 'rollback', run: boolean }[] } | { ok: false, reason: string }}
 */
export function rollbackPlan(states, { preSwitch, rollback }) {
  const partial = states.filter((s) => s.state === 'partial');
  if (partial.length) {
    return { ok: false, reason: `refused: half rolled back — ${partial.map((s) => `${s.migration}: still there: ${s.remaining.join(', ')}; already gone: ${s.gone.join(', ')}`).join(' | ')}. `
      + 'A migration is skipped only when EVERY object it creates is gone; this one is neither in place nor rolled back, so none of its files run. Nothing was changed. '
      + 'Restore the target from its backup, or complete that migration\'s rollback by hand after review, then run the command again.' };
  }
  // A check-only migration says nothing about the order (it is always "present"); only the others count.
  const firstPresent = states.findIndex((s) => s.state === 'present' && !s.checkOnly);
  const gap = firstPresent < 0 ? [] : states.slice(firstPresent).filter((s) => s.state === 'absent');
  if (gap.length) {
    return { ok: false, reason: `refused: ${gap.map((s) => s.migration).join(', ')} ${gap.length === 1 ? 'is' : 'are'} already rolled back while the newer `
      + `${states[firstPresent].migration} is not. The kit rolls back newest first, so it did not leave this state. Nothing was changed.` };
  }
  const stateOf = new Map(states.map((s) => [s.migration, s.state]));
  const checkOnly = new Set(states.filter((s) => s.checkOnly).map((s) => s.migration));
  const step = (kind) => (file) => {
    const migration = migrationOfFile(file);
    if (!stateOf.has(migration)) throw new Error(`${file} does not belong to the release's migrations`);
    return { file, migration, kind, run: stateOf.get(migration) === 'present', checkOnly: checkOnly.has(migration) };
  };
  return { ok: true, steps: [...preSwitch.map(step('pre-switch')), ...rollback.map(step('rollback'))] };
}

/**
 * The release's rollback, resumable after an interruption (see the header). Throws on a refusal or a failing file (a
 * failing file changes nothing); returns what ran. `acknowledgements` come from resolveAcknowledgements (releases.mjs).
 * @param {string} url the target (the migration role's connection)
 * @param {object} release from releaseFrom()
 * @param {{ acknowledgements?: { id: string, setting: string, value: string }[], stopAfter?: number,
 *   log?: (line: string) => void, table?: (rows: object[]) => void, docsDir?: string }} [options]
 * @returns {Promise<{ ran: string[], skipped: string[], stopped: boolean }>}
 */
export async function rollbackRelease(url, release, { acknowledgements = [], stopAfter, log = console.log, table = console.table, docsDir = DOCS_MIGRATIONS } = {}) {
  const files = releaseFiles(release, readdirSync(docsDir));
  const settings = acknowledgements.map((a) => [a.setting, a.value]);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let plan;
  try {
    // Every acknowledgement in effect on the rollback connection, whatever its source (--acknowledge, or PGOPTIONS "-c …").
    for (const [name, value] of settings) await client.query('SELECT set_config($1, $2, false)', [name, value]);
    let any = false;
    for (const id of releaseAcknowledgements(release)) {
      const { setting, value } = ACKNOWLEDGEMENTS[id];
      const current = (await client.query('SELECT current_setting($1, true) AS v', [setting])).rows[0].v;
      if (!current) continue;
      any = true;
      const source = settings.some(([n]) => n === setting) ? `--acknowledge ${id}` : 'PGOPTIONS or a role/database setting';
      log(`acknowledgement: ${setting} = '${current}' (${source}) — ${current === value
        ? 'that guard will let the data it protects be DISCARDED' : `not '${value}': that guard still refuses`}`);
    }
    if (!any) log('acknowledgements: none (every data-loss guard refuses while its data exists)');
    plan = rollbackPlan(await migrationStates(client, release), files);
  } finally {
    await client.end();
  }
  if (!plan.ok) throw new Error(plan.reason);
  const ran = [];
  const skipped = [];
  for (const s of plan.steps) {
    if (!s.run) {
      log(`=== ${s.file} — skipped: ${s.migration} is already rolled back (every object it creates is gone)`);
      skipped.push(s.file);
      continue;
    }
    if (stopAfter !== undefined && ran.length >= stopAfter) {
      log(`stopped after ${ran.length} file(s) as asked (--stop-after ${stopAfter}). Run the same command again to continue.`);
      return { ran, skipped, stopped: true };
    }
    log(s.checkOnly ? `=== ${s.file} (check only: it changes nothing and runs every time; its migration's objects are kept)` : `=== ${s.file}`);
    try {
      await runSqlFile(url, join(docsDir, s.file), { readOnly: false, settings, log, table });
    } catch (e) {
      throw new Error(`${s.file}: ${e.message}\n  Nothing of this file was applied (its transaction was discarded); ${ran.length} file(s) ran before it in this run. `
        + 'Run the same command again to continue from here — with --acknowledge <id> if a guard refused, after a backup that holds the data.');
    }
    ran.push(s.file);
    if (s.kind === 'rollback' && !s.checkOnly) {
      const check = new pg.Client({ connectionString: url });
      await check.connect();
      try {
        const after = (await migrationStates(check, release)).find((x) => x.migration === s.migration);
        if (after.state !== 'absent') throw new Error(`${s.file} ran, but ${s.migration} is not fully rolled back (still there: ${after.remaining.join(', ')}). Stopped; investigate before going on.`);
      } finally {
        await check.end();
      }
    }
  }
  return { ran, skipped, stopped: false };
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

/** Deletes the history rows of `names` that exist (none when there is no history table) and says which. */
async function deleteHistory(client, names, log) {
  const has = (await client.query(`SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok;
  const found = has ? (await client.query('SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ANY($1) ORDER BY 1', [names])).rows.map((r) => r.migration_name) : [];
  const del = found.length ? await client.query('DELETE FROM "_prisma_migrations" WHERE migration_name = ANY($1)', [found]) : { rowCount: 0 };
  log(`deleted ${del.rowCount} history row(s): ${found.join(', ') || 'none'}`);
}

/**
 * post-Phase-1 / design-areas rollback-history: refuses while any table, enum, column, trigger or function the release's
 * migrations create is still there (release.objects), or while any of its migrations is not fully rolled back by its
 * complete object list (MIGRATION_OBJECTS); then deletes exactly their history rows (none left: "deleted 0", exit 0 —
 * running it again is harmless). Returns the exit code.
 */
export async function rollbackHistoryRelease(url, release, { log = console.log, error = console.error, root = REPO_ROOT } = {}) {
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
    for (const st of await migrationStates(client, release)) for (const r of st.remaining) remaining.push(`${r} (${st.migration})`);
    if (remaining.length) {
      error(`✗ refused: the ${label} rollback is not complete (${[...new Set(remaining)].join(', ')}). Run \`rollback --release ${release.name}\` first.`);
      return 1;
    }
    const dirs = migrationDirs(root).filter((d) => release.migrations.includes(d));
    if (dirs.length !== release.migrations.length) throw new Error(`expected ${release.migrations.length} ${label} migration directories, found ${dirs.length}`);
    await deleteHistory(client, dirs, log);
    return 0;
  } finally {
    await client.end();
  }
}

/** Phase 1 rollback-history: as before (M9–M14 objects gone, School_name_key restored), plus their complete object lists. */
export async function rollbackHistoryPhase1(url, release, { log = console.log, error = console.error, root = REPO_ROOT } = {}) {
  const client = new pg.Client({ connectionString: url });
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
    for (const st of await migrationStates(client, release)) {
      if (!HISTORY_ONLY.some((p) => st.migration.startsWith(`${p}_`))) continue;
      for (const r of st.remaining) remaining.push(`${r} (${st.migration})`);
    }
    if (remaining.length) {
      error(`✗ refused: the M9–M14 rollback is not complete (${remaining.join(', ')}). Run \`rollback\` first.`);
      return 1;
    }
    const exact = readdirSync(join(root, 'prisma/migrations')).filter((d) => HISTORY_ONLY.some((p) => d.startsWith(`${p}_`)));
    if (exact.length !== HISTORY_ONLY.length) throw new Error(`expected ${HISTORY_ONLY.length} M9–M14 migration directories, found ${exact.length}`);
    await deleteHistory(client, exact, log);
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

  // --acknowledge and --stop-after: rollback only; checked against the fixed allow-list before anything is read or connected.
  const ackValues = optionValues(rest, '--acknowledge');
  const stopValues = optionValues(rest, '--stop-after');
  if ((ackValues.length || stopValues.length) && command !== 'rollback') {
    console.error('✗ --acknowledge and --stop-after are options of `rollback` only.');
    return 2;
  }
  const acks = resolveAcknowledgements(ackValues, release);
  if (!acks.ok) { console.error(`✗ refused: ${acks.reason}`); return 2; }
  if (stopValues.length > 1 || (stopValues.length && !/^[1-9]\d{0,3}$/.test(stopValues[0]))) {
    console.error('✗ --stop-after takes one whole number of files (1 or more).');
    return 2;
  }
  const stopAfter = stopValues.length ? Number(stopValues[0]) : undefined;

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
    // post-Phase-1 / design areas: the release's migrations in the checkout (exit 5, before any target is read). Nothing
    // after them for deploy / diff / status, which act on every migration of the checkout; the other commands run only
    // the release's own files and checks, so a newer checkout is accepted for them.
    const problem = checkoutProblem(release, migrationDirs(REPO_ROOT), { allowLater: CHECKOUT_RELEASE_ONLY.has(command) });
    if (problem) { console.error(`✗ refused: ${problem}`); return 5; }
    const later = afterRelease(release, migrationDirs(REPO_ROOT));
    if (later.length) console.log(`checkout: ${later.length} later migration(s) present (${later.join(', ')}); ${command} uses only ${release.label}'s files.`);
  }
  if (['dump', 'restore'].includes(command)) {
    const tools = findPgTools();
    if (!tools.ok) { console.error(`✗ refused: ${tools.reason}`); return 2; }
    console.log(`pg tools: pg_dump / pg_restore ${tools.dump.major} (${tools.dir ? `PG_BIN ${tools.dir}` : 'from PATH'})`);
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
    // Every release after post-Phase-1 builds on all the releases before it: all of them must already be recorded.
    if (release.requires && release.name !== 'post-phase1' && command !== 'restore') {
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
      // Pre-switch steps first (in production they run while the new release still serves; see the runbook §4).
      const result = await rollbackRelease(schemaUrl, release, { acknowledgements: acks.acks, stopAfter });
      console.log(`rollback: ${result.ran.length} file(s) run, ${result.skipped.length} skipped (already rolled back)${result.stopped ? ', stopped by --stop-after' : ''}.`);
      if (result.stopped) break;
      console.log(release.name === 'phase1'
        ? 'Next: rollback-history (M9–M14 rows), then `status` ("Following migrations have not yet been applied:" + the 14 names; exit 1).'
        : release.name === 'post-phase1'
          ? 'Next: rollback-history --release post-phase1 (the eleven rows), then `status --release post-phase1` (the eleven names not yet applied; exit 1).'
          : `Next: rollback-history --release ${release.name} (its ${release.count} rows), then \`status --release ${release.name}\` (those names not yet applied; exit 1).`);
      break;
    }
    case 'rollback-history':
      code = release.name === 'phase1' ? await rollbackHistoryPhase1(schemaUrl, release) : await rollbackHistoryRelease(schemaUrl, release);
      break;
  }
  console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}
