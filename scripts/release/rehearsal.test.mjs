// node --test scripts/release/rehearsal.test.mjs — pure helpers of the rehearsal runner (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { endpointId, segments, rollbackFiles, childEnv, checkDumpDir, conninfoFrom, pgToolEnv, toolMajor, serverMajor, isInside,
  PHASE1, M9_M14_TABLES, M9_M14_ENUMS } from './rehearsal.mjs';
import { LAST_PHASE1_TIMESTAMP, laterMigrations, migrationDirs } from './phase1.mjs';
import { REPO_ROOT } from '../db-drill-verify.mjs';
import { POST_PHASE1_MIGRATIONS, POST_PHASE1_OBJECTS, RELEASES, afterRelease, checkoutProblem, releaseFrom, releaseRollbackFiles } from './releases.mjs';

/** This checkout as it was for Phase 1: its migrations without the nine post-Phase-1 ones (the Phase 1 tests' fixture). */
const phase1Dirs = () => migrationDirs(REPO_ROOT).filter((d) => !POST_PHASE1_MIGRATIONS.includes(d));

// ── Later-migration guard (owner decision 2026-11-13) ─────────────────────────────────────────────

const LATER = ['20261201000000_teacher_applications', '20261202000000_notification_outbox'];

test('laterMigrations: nothing after M14 in the Phase 1 state (17 + 14 migrations); M14 itself is not "later"', () => {
  const dirs = phase1Dirs();
  assert.equal(dirs.filter((d) => PHASE1.test(d)).length, 14);
  assert.deepEqual(laterMigrations(dirs), []);
  assert.deepEqual(laterMigrations([`${LAST_PHASE1_TIMESTAMP}_school_directory_sync_approval`, '20261120000000_email_html_body']), []);
});

test('laterMigrations: the 16-migration state (two migrations after M14) is detected, by name order, from directories or history rows', () => {
  const sixteen = [...phase1Dirs(), ...LATER];
  assert.equal(sixteen.filter((d) => PHASE1.test(d) || LATER.includes(d)).length, 16);
  assert.deepEqual(laterMigrations(sixteen), LATER);
  assert.deepEqual(laterMigrations([...LATER].reverse()), LATER);
  assert.deepEqual(laterMigrations(['20261121001400_m15']), ['20261121001400_m15']);
});

/**
 * A throw-away copy of this checkout's scripts and migrations (node_modules linked, never copied),
 * optionally with extra migration directories; removed afterwards without touching the real node_modules.
 */
function withCheckoutCopy(extra, fn, { drop = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rof-kit-guard-'));
  const modules = join(root, 'node_modules');
  try {
    cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(join(REPO_ROOT, 'prisma'), join(root, 'prisma'), { recursive: true });
    cpSync(join(REPO_ROOT, 'docs/migrations'), join(root, 'docs/migrations'), { recursive: true });
    symlinkSync(join(REPO_ROOT, 'node_modules'), modules, 'junction');
    for (const name of drop) rmSync(join(root, 'prisma/migrations', name), { recursive: true, force: true });
    for (const name of extra) {
      mkdirSync(join(root, 'prisma/migrations', name));
      writeFileSync(join(root, 'prisma/migrations', name, 'migration.sql'), 'SELECT 1;\n');
    }
    return fn(root);
  } finally {
    if (existsSync(modules)) unlinkSync(modules);           // the link only
    assert.ok(existsSync(join(REPO_ROOT, 'node_modules')), 'the real node_modules is untouched');
    rmSync(root, { recursive: true, force: true });
  }
}

const run = (root, ...args) => spawnSync(process.execPath, [join(root, 'scripts/release/rehearsal.mjs'), ...args],
  { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '' } });

test('the runner refuses a checkout with migrations after M14 (16-migration state): exit 5 for every command, before reading any target', () => {
  withCheckoutCopy(LATER, (root) => {
    for (const command of ['check-target', 'precheck', 'status', 'deploy', 'diff', 'postcheck', 'rollback', 'rollback-history', 'dump', 'restore']) {
      const r = run(root, command, '--confirm', 'ep-anything');
      assert.equal(r.status, 5, `${command}: ${r.stderr}`);
      assert.match(r.stderr, /refused: this checkout has 2 migration\(s\) after M14 \(20261201000000_teacher_applications, 20261202000000_notification_outbox\)/);
    }
  }, { drop: POST_PHASE1_MIGRATIONS });
});

test('the runner accepts the original 14-migration checkout: it passes the later-migration guard and goes on to the target check', () => {
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--confirm', 'ep-anything');
    assert.notEqual(r.status, 5, r.stderr);
    assert.doesNotMatch(r.stderr, /after M14/);
    assert.match(r.stdout, /verifier guard: db-drill-verify rev 2/);
    // No .env.production.local / DRILL_DATABASE_URL in the copy: the target guard refuses next (fail-closed).
    assert.ok(r.status !== 0, 'no target configured, so the target guard refuses');
  }, { drop: POST_PHASE1_MIGRATIONS });
});

const BRANCH = 'postgresql://rof_user:s%40cret%27pw@ep-branch-222.c-1.us-east-2.aws.example.tech/neondb?sslmode=require';

test('dump folder: absolute, existing, outside the repository and OneDrive, EFS-encrypted — otherwise refused', () => {
  const base = mkdtempSync(join(tmpdir(), 'rof-dump-'));
  const enc = () => 'Directory, Encrypted';
  const win = { platform: 'win32', attributesOf: enc, env: {} };
  assert.match(checkDumpDir('relative\\dir', win), /absolute/);
  assert.match(checkDumpDir(join(base, 'missing'), win), /does not exist/);
  assert.match(checkDumpDir(join(REPO_ROOT, 'scripts'), win), /inside the repository/);
  const od = join(base, 'Personal Cloud'); mkdirSync(join(od, 'b'), { recursive: true });
  assert.match(checkDumpDir(join(od, 'b'), { ...win, env: { OneDrive: od } }), /OneDrive/);
  const named = join(base, 'OneDrive - ROF', 'x'); mkdirSync(named, { recursive: true });
  assert.match(checkDumpDir(named, win), /OneDrive/);
  assert.match(checkDumpDir(base, { ...win, attributesOf: () => 'Directory' }), /not EFS-encrypted/);
  assert.match(checkDumpDir(base, { ...win, attributesOf: () => '' }), /not EFS-encrypted/);
  assert.match(checkDumpDir(base, { ...win, platform: 'linux' }), /Windows \(EFS\) only/);
  assert.equal(checkDumpDir(base, win), null);
});

test('isInside: same folder and sub-folders only; a sibling with a common prefix is outside', () => {
  assert.equal(isInside('C:\\a\\b', 'C:\\a', true), true);
  assert.equal(isInside('c:\\A', 'C:\\a', true), true);
  assert.equal(isInside('C:\\ab', 'C:\\a', true), false);
});

test('pg tools get no password on the command line: conninfo without it, PGPASSWORD in their environment only', () => {
  const ci = conninfoFrom(BRANCH);
  assert.equal(ci, "host='ep-branch-222.c-1.us-east-2.aws.example.tech' port='5432' dbname='neondb' user='rof_user' sslmode='require'");
  assert.doesNotMatch(ci, /cret|password/);
  assert.match(conninfoFrom('postgresql://u@h.example.tech/d'), /sslmode='require'/);
  assert.equal(conninfoFrom("postgresql://o'k@h.example.tech/d").includes("user='o\\'k'"), true);
  const env = pgToolEnv({ PATH: 'x', PGHOST: 'prod', PGSERVICE: 'prod', PGPASSFILE: 'f', pgpassword: 'old', DOTENV_PATH: 'y' }, BRANCH);
  assert.deepEqual(env, { PATH: 'x', PGPASSWORD: "s@cret'pw" });
});

test('versions: pg_dump major from --version, server major from server_version_num', () => {
  assert.equal(toolMajor('pg_dump (PostgreSQL) 18.1'), 18);
  assert.equal(toolMajor('pg_dump (PostgreSQL) 17.5 (Debian 17.5-1)'), 17);
  assert.ok(Number.isNaN(toolMajor('nonsense')));
  assert.equal(serverMajor('180006'), 18);
});

test('refuses to run from any directory other than its own checkout root (exit 2, before reading any target)', () => {
  const r = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts/release/rehearsal.mjs'), 'check-target'],
    { cwd: mkdtempSync(join(tmpdir(), 'rof-cwd-')), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /run this from the root of the checkout/);
});

const created = (kind, prefixes) => readdirSync('prisma/migrations')
  .filter((d) => prefixes.some((p) => d.startsWith(p)))
  .flatMap((d) => [...readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').matchAll(new RegExp(`CREATE ${kind} "([A-Za-z]+)"`, 'g'))].map((m) => m[1]))
  .sort();
const M9_M14 = ['20261121000800_', '20261121000900_', '20261121001000_', '20261121001100_', '20261121001200_', '20261121001300_'];

test('rollback-history checks every table and enum that M9–M14 create', () => {
  assert.deepEqual([...M9_M14_TABLES].sort(), created('TABLE', M9_M14));
  assert.deepEqual([...M9_M14_ENUMS].sort(), created('TYPE', M9_M14));
});

test('childEnv: DATABASE_URL is the target; DOTENV_* switches (which could make dotenv replace it) are removed', () => {
  const env = childEnv({ PATH: 'x', DATABASE_URL: 'postgresql://app', DOTENV_OVERRIDE: 'true', DOTENV_PATH: '.env.production.local',
    DOTENV_CONFIG_OVERRIDE: 'true', dotenv_config_path: 'y' }, 'postgresql://target');
  assert.deepEqual(env, { PATH: 'x', DATABASE_URL: 'postgresql://target' });
});

test('endpointId: the first host label, pooled and direct forms alike', () => {
  assert.equal(endpointId('postgresql://u:p@ep-cool-band-123-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require'), 'ep-cool-band-123');
  assert.equal(endpointId('postgresql://u:p@EP-Cool-Band-123.c-8.us-east-2.aws.neon.tech/neondb'), 'ep-cool-band-123');
});

test('PHASE1 matches exactly M1–M14', () => {
  const migrations = readdirSync('prisma/migrations').filter((d) => PHASE1.test(d));
  assert.equal(migrations.length, 14);
  assert.equal(migrations.sort()[0], '20261121000000_roles_teacher_head_coach_super_admin');
  assert.equal(migrations.sort()[13], '20261121001300_school_directory_sync_approval');
  assert.equal(PHASE1.test('20261120000000_email_html_body'), false);
});

test('rollbackFiles: the 14 repository rollbacks, newest first; anything else refused', () => {
  const files = rollbackFiles(readdirSync('docs/migrations'));
  assert.equal(files.length, 14);
  assert.match(files[0], /^20261121001300_/);
  assert.match(files[13], /^20261121000000_/);
  assert.throws(() => rollbackFiles(['README.md']), /expected 14/);
  assert.throws(() => rollbackFiles(files.slice(1)), /found 13/);
});

test('segments: \\echo lines kept in order, other meta-commands refused, comment-only segments dropped', () => {
  assert.deepEqual(segments("BEGIN;\n\\echo '== a'\nSELECT 1;\n-- note\n\\echo '== b'\n-- only a comment\nROLLBACK;"),
    ['BEGIN;', { echo: '== a' }, 'SELECT 1;\n-- note', { echo: '== b' }, '-- only a comment\nROLLBACK;']);
  assert.throws(() => segments('\\set x 1'), /unsupported psql meta-command/);
});

// ── post-Phase-1 release (--release post-phase1) ──────────────────────────────────────────────────

test('post-Phase-1: the nine migrations are exactly those between M14 and form_availability in this checkout, in apply order', () => {
  const dirs = migrationDirs(REPO_ROOT);
  const between = dirs.filter((d) => d.slice(0, 14) > LAST_PHASE1_TIMESTAMP && d.slice(0, 14) <= RELEASES['post-phase1'].last);
  assert.deepEqual(between, POST_PHASE1_MIGRATIONS);
  assert.deepEqual([...POST_PHASE1_MIGRATIONS].sort(), POST_PHASE1_MIGRATIONS);
  assert.deepEqual(laterMigrations(dirs).slice(0, 9), POST_PHASE1_MIGRATIONS);
});

const createdBy = (dirs, re) => dirs.flatMap((d) => [...readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').matchAll(re)].map((m) => m.slice(1).join('.'))).sort();

test('post-Phase-1: rollback-history checks exactly the tables, enums, columns, triggers and functions the nine migrations create', () => {
  const o = POST_PHASE1_OBJECTS;
  assert.deepEqual([...o.tables].sort(), createdBy(POST_PHASE1_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g));
  assert.deepEqual([...o.enums].sort(), createdBy(POST_PHASE1_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g));
  assert.deepEqual([...new Set(createdBy(POST_PHASE1_MIGRATIONS, /CREATE TRIGGER ([a-z_]+)/g))], [...o.triggers].sort());
  assert.deepEqual([...new Set(createdBy(POST_PHASE1_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g))], [...o.functions].sort());
  // Columns: every ADD COLUMN on a table that already existed before the release (new tables are dropped whole).
  const added = POST_PHASE1_MIGRATIONS.flatMap((d) => {
    let table = null;
    return readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').split(/\r?\n/).flatMap((line) => {
      const t = /ALTER TABLE "([A-Za-z]+)"/.exec(line); if (t) table = t[1];
      const c = /ADD COLUMN +"([A-Za-z]+)"/.exec(line);
      return c && !o.tables.includes(table) ? [`${table}.${c[1]}`] : [];
    });
  }).sort();
  assert.deepEqual(o.columns.map(([t, c]) => `${t}.${c}`).sort(), added);
});

test('post-Phase-1: one rollback file per migration, run newest first; anything missing is refused', () => {
  const release = releaseFrom(['--release', 'post-phase1']);
  const files = releaseRollbackFiles(release, readdirSync('docs/migrations'));
  assert.deepEqual(files, [...POST_PHASE1_MIGRATIONS].reverse().map((m) => `${m}.rollback.sql`));
  assert.throws(() => releaseRollbackFiles(release, files.slice(1)), /expected 9 .* found 8/);
  // The Phase 1 rollbacks are never part of it, and vice versa.
  assert.equal(rollbackFiles(readdirSync('docs/migrations')).length, 14);
  for (const f of files) assert.doesNotThrow(() => segments(readFileSync(`docs/migrations/${f}`, 'utf8')), f);
});

test('post-Phase-1: the pre- and post-check SQL are read only and use only \\echo (no other psql meta-command)', () => {
  for (const file of [RELEASES['post-phase1'].precheck, RELEASES['post-phase1'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    // The SQL statements only (segments() leaves out the \echo headings, which are prose).
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    // Every post-Phase-1 table and enum named in the checks exists in the release (no stale names).
    for (const name of [...POST_PHASE1_OBJECTS.tables, ...POST_PHASE1_OBJECTS.enums]) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('releaseFrom / afterRelease / checkoutProblem: default phase1; post-phase1 needs its nine and nothing after them', () => {
  assert.equal(releaseFrom([]).name, 'phase1');
  assert.equal(releaseFrom(['--release', 'post-phase1']).name, 'post-phase1');
  assert.equal(releaseFrom(['--release', 'phase2']), null);
  const post = releaseFrom(['--release', 'post-phase1']);
  const dirs = migrationDirs(REPO_ROOT);
  assert.equal(checkoutProblem(post, dirs), null);
  assert.match(checkoutProblem(post, [...dirs, '20261209000000_next']), /1 migration\(s\) after .* \(20261209000000_next\)/);
  assert.match(checkoutProblem(post, dirs.filter((d) => d !== '20261204000000_registration_details')), /expected the 9 .* found 8/);
  assert.deepEqual(afterRelease(post, ['20261208000000_form_availability', '20261209000000_x', '20261121001300_y']), ['20261209000000_x']);
  assert.deepEqual(afterRelease(releaseFrom([]), POST_PHASE1_MIGRATIONS), POST_PHASE1_MIGRATIONS);
});

test('the runner: post-phase1 passes the checkout guard on this checkout; a later migration, a missing one, phase1 here, or an unknown release are refused', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'post-phase1', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: post-phase1/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
    const p1 = run(root, 'precheck');
    assert.equal(p1.status, 5);
    assert.match(p1.stderr, /after M14 .*use --release post-phase1/);
    const bad = run(root, 'precheck', '--release', 'phase2');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--release must be one of: phase1, post-phase1/);
  });
  withCheckoutCopy(['20261209000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'post-phase1', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after post-Phase-1 .*20261209000000_next/);
  });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'status', '--release', 'post-phase1');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /expected the 9 migrations of post-Phase-1 .* found 8/);
  }, { drop: ['20261206000000_account_states'] });
});
