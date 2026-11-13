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
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { resolveDrillTarget, readTargetInputs } from '../db-drill-verify.mjs';

const WRITES = new Set(['deploy', 'rollback', 'rollback-history']);
/** Phase 1 migration names: 20261121000000_… to 20261121001300_… (M1–M14). */
export const PHASE1 = /^2026112100[01]\d00_/;
const PHASE1_COUNT = 14;
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
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env: childEnv(process.env, url) });
  return r.status ?? 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const known = ['check-target', 'precheck', 'status', 'deploy', 'diff', 'postcheck', 'rollback', 'rollback-history'];
  if (!known.includes(command)) { console.error(`usage: node scripts/release/rehearsal.mjs <${known.join('|')}> [--confirm <ep-id>]`); return 2; }

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
    case 'precheck': await runSqlFile(target.url, 'scripts/release/phase1-precheck.sql', { readOnly: true }); break;
    case 'postcheck': await runSqlFile(target.url, 'scripts/release/phase1-postcheck.sql', { readOnly: true }); break;
    case 'status': code = prisma(target.url, ['migrate', 'status']); break;
    case 'deploy': code = prisma(target.url, ['migrate', 'deploy']); break;
    case 'diff': code = prisma(target.url, ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code']); break;
    case 'rollback': {
      for (const f of rollbackFiles(readdirSync('docs/migrations'))) {
        console.log(`=== ${f}`);
        await runSqlFile(target.url, `docs/migrations/${f}`, { readOnly: false });
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
        const exact = readdirSync('prisma/migrations').filter((d) => HISTORY_ONLY.some((p) => d.startsWith(`${p}_`)));
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
