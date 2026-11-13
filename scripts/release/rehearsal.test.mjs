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

// ── Later-migration guard (owner decision 2026-11-13) ─────────────────────────────────────────────

const LATER = ['20261201000000_teacher_applications', '20261202000000_notification_outbox'];

test('laterMigrations: nothing after M14 in the original state (this checkout: 17 + 14 migrations); M14 itself is not "later"', () => {
  const dirs = migrationDirs(REPO_ROOT);
  assert.equal(dirs.filter((d) => PHASE1.test(d)).length, 14);
  assert.deepEqual(laterMigrations(dirs), []);
  assert.deepEqual(laterMigrations([`${LAST_PHASE1_TIMESTAMP}_school_directory_sync_approval`, '20261120000000_email_html_body']), []);
});

test('laterMigrations: the 16-migration state (two migrations after M14) is detected, by name order, from directories or history rows', () => {
  const sixteen = [...migrationDirs(REPO_ROOT), ...LATER];
  assert.equal(sixteen.filter((d) => PHASE1.test(d) || LATER.includes(d)).length, 16);
  assert.deepEqual(laterMigrations(sixteen), LATER);
  assert.deepEqual(laterMigrations([...LATER].reverse()), LATER);
  assert.deepEqual(laterMigrations(['20261121001400_m15']), ['20261121001400_m15']);
});

/**
 * A throw-away copy of this checkout's scripts and migrations (node_modules linked, never copied),
 * optionally with extra migration directories; removed afterwards without touching the real node_modules.
 */
function withCheckoutCopy(extra, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rof-kit-guard-'));
  const modules = join(root, 'node_modules');
  try {
    cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(join(REPO_ROOT, 'prisma'), join(root, 'prisma'), { recursive: true });
    cpSync(join(REPO_ROOT, 'docs/migrations'), join(root, 'docs/migrations'), { recursive: true });
    symlinkSync(join(REPO_ROOT, 'node_modules'), modules, 'junction');
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
  });
});

test('the runner accepts the original 14-migration checkout: it passes the later-migration guard and goes on to the target check', () => {
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--confirm', 'ep-anything');
    assert.notEqual(r.status, 5, r.stderr);
    assert.doesNotMatch(r.stderr, /after M14/);
    assert.match(r.stdout, /verifier guard: db-drill-verify rev 2/);
    // No .env.production.local / DRILL_DATABASE_URL in the copy: the target guard refuses next (fail-closed).
    assert.ok(r.status !== 0, 'no target configured, so the target guard refuses');
  });
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
