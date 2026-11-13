#!/usr/bin/env node
/**
 * Phase 1 migration rehearsal on a Neon BRANCH of production — never production itself.
 * Checklist: docs/operations/REHEARSAL-NEON-CHECKLIST.md.
 *
 *   node scripts/release/rehearsal.mjs check-target                 guard only, no connection
 *   node scripts/release/rehearsal.mjs precheck                     scripts/release/phase1-precheck.sql (read only)
 *   node scripts/release/rehearsal.mjs status                       prisma migrate status
 *   node scripts/release/rehearsal.mjs deploy   --confirm <ep-id>   prisma migrate deploy        (WRITES to the branch)
 *   node scripts/release/rehearsal.mjs diff                         prisma migrate diff … --exit-code
 *   node scripts/release/rehearsal.mjs postcheck                    scripts/release/phase1-postcheck.sql (read only)
 *   node scripts/release/rehearsal.mjs rollback --confirm <ep-id>   docs/migrations rollbacks M14 → M1 (WRITES)
 *   node scripts/release/rehearsal.mjs rollback-history --confirm <ep-id>
 *                                                                   deletes the M9–M14 history rows (WRITES)
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
import { REPO_ROOT, VERIFIER, resolveDrillTarget, readTargetInputs } from '../db-drill-verify.mjs';
import { PHASE1, PHASE1_COUNT } from './phase1.mjs';

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

function prisma(url, args) {
  const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: REPO_ROOT, env: childEnv(process.env, url) });
  return r.status ?? 1;
}

const opt = (rest, name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const known = ['check-target', 'precheck', 'status', 'deploy', 'diff', 'postcheck', 'rollback', 'rollback-history', 'dump', 'restore'];
  if (!known.includes(command)) { console.error(`usage: node scripts/release/rehearsal.mjs <${known.join('|')}> [--confirm <ep-id>]`); return 2; }
  if (!samePath(process.cwd(), REPO_ROOT)) {
    console.error('✗ refused: run this from the root of the checkout the script belongs to (cd there first).');
    return 2;
  }
  console.log(`verifier guard: ${VERIFIER}`);

  const target = resolveDrillTarget(readTargetInputs());
  if (!target.ok) { console.error(`✗ ${target.reason}`); return target.code; }
  const ep = endpointId(target.url);
  if (WRITES.has(command)) {
    const confirm = rest.includes('--confirm') ? String(rest[rest.indexOf('--confirm') + 1] ?? '').toLowerCase() : '';
    if (confirm !== ep) { console.error('✗ refused: --confirm must be the rehearsal branch endpoint id (ep-…) shown in the Neon console.'); return 3; }
  }
  console.log(`target: rehearsal branch endpoint ${WRITES.has(command) ? ep : '(guard passed)'} via direct endpoint`);
  const started = Date.now();
  let code = 0;

  switch (command) {
    case 'check-target': console.log('✔ guard passed. No connection made.'); break;
    case 'precheck': await runSqlFile(target.url, join(REPO_ROOT, 'scripts/release/phase1-precheck.sql'), { readOnly: true }); break;
    case 'postcheck': await runSqlFile(target.url, join(REPO_ROOT, 'scripts/release/phase1-postcheck.sql'), { readOnly: true }); break;
    case 'dump': await dump(target, opt(rest, '--out')); break;
    case 'restore': await restore(target, opt(rest, '--dump')); break;
    case 'status': code = prisma(target.url, ['migrate', 'status']); break;
    case 'deploy': code = prisma(target.url, ['migrate', 'deploy']); break;
    case 'diff': code = prisma(target.url, ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code']); break;
    case 'rollback': {
      for (const f of rollbackFiles(readdirSync(join(REPO_ROOT, 'docs/migrations')))) {
        console.log(`=== ${f}`);
        await runSqlFile(target.url, join(REPO_ROOT, 'docs/migrations', f), { readOnly: false });
      }
      console.log('Next: rollback-history (M9–M14 rows), then `status` ("Following migrations have not yet been applied:" + the 14 names; exit 1).');
      break;
    }
    case 'rollback-history': {
      const client = new pg.Client({ connectionString: target.url });
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
