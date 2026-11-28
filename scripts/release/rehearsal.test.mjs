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
import { AREAS_2026_MIGRATIONS, AREAS_2026_OBJECTS, BANKING_2026_MIGRATIONS, BANKING_2026_OBJECTS, QUESTION_MARKING_2027_MIGRATIONS, QUESTION_MARKING_2027_OBJECTS, QUESTION_MARKING_EVIDENCE, SESSION_2027_MIGRATIONS, SESSION_2027_OBJECTS, REPORTS_2027_MIGRATIONS, REPORTS_2027_OBJECTS, MIGRATION_OBJECTS, evidenceManifest, evidenceProblem, evidenceQueries, DEC_2026_MIGRATIONS, DEC_2026_OBJECTS, LEVELS_2026_MIGRATIONS, LEVELS_2026_OBJECTS, LAUNCH_2026_MIGRATIONS, LAUNCH_2026_OBJECTS, LATE_2026_MIGRATIONS, LATE_2026_OBJECTS, POST_PHASE1_MIGRATIONS, POST_PHASE1_OBJECTS, RELEASES, afterRelease, checkoutProblem, releaseFrom, releasePreSwitchFiles, releaseRollbackFiles } from './releases.mjs';

/**
 * This checkout as it was for Phase 1: its migrations without the eleven post-Phase-1 ones and the design-area ones
 * (the Phase 1 tests' fixture). Each later release is removed the same way, as the eleven were.
 */
const AFTER_PHASE1 = [...POST_PHASE1_MIGRATIONS, ...AREAS_2026_MIGRATIONS, ...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS];
const phase1Dirs = () => migrationDirs(REPO_ROOT).filter((d) => !AFTER_PHASE1.includes(d));
/** This checkout as it was for post-Phase-1: without the design-area migrations (the post-Phase-1 tests' fixture). */
const postPhase1Dirs = () => migrationDirs(REPO_ROOT).filter((d) => !AREAS_2026_MIGRATIONS.includes(d) && !LATE_2026_MIGRATIONS.includes(d) && !DEC_2026_MIGRATIONS.includes(d) && !LEVELS_2026_MIGRATIONS.includes(d) && !LAUNCH_2026_MIGRATIONS.includes(d) && !BANKING_2026_MIGRATIONS.includes(d) && !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
/** This checkout as it was for the design areas: without the late-2026 migrations (the design-area tests' fixture). */
const areasDirs = () => migrationDirs(REPO_ROOT).filter((d) => !LATE_2026_MIGRATIONS.includes(d) && !DEC_2026_MIGRATIONS.includes(d) && !LEVELS_2026_MIGRATIONS.includes(d) && !LAUNCH_2026_MIGRATIONS.includes(d) && !BANKING_2026_MIGRATIONS.includes(d) && !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
/** This checkout as it was for late-2026: without the dec-2026 migration (the late-2026 tests' fixture). */
const lateDirs = () => migrationDirs(REPO_ROOT).filter((d) => !DEC_2026_MIGRATIONS.includes(d) && !LEVELS_2026_MIGRATIONS.includes(d) && !LAUNCH_2026_MIGRATIONS.includes(d) && !BANKING_2026_MIGRATIONS.includes(d) && !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
/** This checkout as it was for dec-2026: without the levels-2026 migration (the dec-2026 tests' fixture). */
const decDirs = () => migrationDirs(REPO_ROOT).filter((d) => !LEVELS_2026_MIGRATIONS.includes(d) && !LAUNCH_2026_MIGRATIONS.includes(d) && !BANKING_2026_MIGRATIONS.includes(d) && !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
/** This checkout as it was for levels-2026: without the launch-2026 migrations (the levels-2026 tests' fixture). */
const levelsDirs = () => migrationDirs(REPO_ROOT).filter((d) => !LAUNCH_2026_MIGRATIONS.includes(d) && !BANKING_2026_MIGRATIONS.includes(d) && !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
/** This checkout as it was for launch-2026: without the banking-2026 and question-marking-2027 migrations (the launch-2026 tests' fixture). */
const launchDirs = () => migrationDirs(REPO_ROOT).filter((d) => !BANKING_2026_MIGRATIONS.includes(d) && !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));

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
  }, { drop: AFTER_PHASE1 });
});

test('the runner accepts the original 14-migration checkout: it passes the later-migration guard and goes on to the target check', () => {
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--confirm', 'ep-anything');
    assert.notEqual(r.status, 5, r.stderr);
    assert.doesNotMatch(r.stderr, /after M14/);
    assert.match(r.stdout, /verifier guard: db-drill-verify rev 2/);
    // No .env.production.local / DRILL_DATABASE_URL in the copy: the target guard refuses next (fail-closed).
    assert.ok(r.status !== 0, 'no target configured, so the target guard refuses');
  }, { drop: AFTER_PHASE1 });
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

test('post-Phase-1: the eleven migrations are exactly those between M14 and teacher_student_access in this checkout, in apply order', () => {
  const dirs = migrationDirs(REPO_ROOT);
  const between = dirs.filter((d) => d.slice(0, 14) > LAST_PHASE1_TIMESTAMP && d.slice(0, 14) <= RELEASES['post-phase1'].last);
  assert.deepEqual(between, POST_PHASE1_MIGRATIONS);
  assert.deepEqual([...POST_PHASE1_MIGRATIONS].sort(), POST_PHASE1_MIGRATIONS);
  assert.deepEqual(laterMigrations(dirs).slice(0, POST_PHASE1_MIGRATIONS.length), POST_PHASE1_MIGRATIONS);
});

const createdBy = (dirs, re) => dirs.flatMap((d) => [...readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').matchAll(re)].map((m) => m.slice(1).join('.'))).sort();

test('post-Phase-1: rollback-history checks exactly the tables, enums, columns, triggers and functions the eleven migrations create', () => {
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
  assert.throws(() => releaseRollbackFiles(release, files.slice(1)), /expected 11 .* found 10/);
  // The teacher–student pre-switch step exists, belongs to this release and is not counted as a rollback file.
  assert.deepEqual(releasePreSwitchFiles(release, readdirSync('docs/migrations')), ['20261210000000_teacher_student_access.pre-switch.sql']);
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

test('releaseFrom / afterRelease / checkoutProblem: default phase1; post-phase1 needs its eleven and nothing after them', () => {
  assert.equal(releaseFrom([]).name, 'phase1');
  assert.equal(releaseFrom(['--release', 'post-phase1']).name, 'post-phase1');
  assert.equal(releaseFrom(['--release', 'phase2']), null);
  const post = releaseFrom(['--release', 'post-phase1']);
  const dirs = postPhase1Dirs();
  assert.equal(checkoutProblem(post, dirs), null);
  assert.match(checkoutProblem(post, [...dirs, '20261211000000_next']), /1 migration\(s\) after .* \(20261211000000_next\)/);
  assert.match(checkoutProblem(post, dirs.filter((d) => d !== '20261204000000_registration_details')), /expected the 11 .* found 10/);
  assert.deepEqual(afterRelease(post, ['20261210000000_teacher_student_access', '20261211000000_x', '20261121001300_y']), ['20261211000000_x']);
  assert.deepEqual(afterRelease(releaseFrom([]), POST_PHASE1_MIGRATIONS), POST_PHASE1_MIGRATIONS);
});

test('the runner: post-phase1 passes the checkout guard on this checkout; a later migration, a missing one, phase1 here, or an unknown release are refused', () => {
  // "This checkout" as it was for post-Phase-1: the design-area migrations removed (the post-Phase-1 fixture).
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
  }, { drop: [...AREAS_2026_MIGRATIONS, ...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy(['20261211000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'post-phase1', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after post-Phase-1 .*20261211000000_next/);
  }, { drop: [...AREAS_2026_MIGRATIONS, ...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'status', '--release', 'post-phase1');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /expected the 11 migrations of post-Phase-1 .* found 10/);
  }, { drop: ['20261206000000_account_states', ...AREAS_2026_MIGRATIONS, ...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  // This checkout as it is (the design-area and late-2026 migrations after the eleven): post-phase1 refuses it, as the kit's rule
  // "nothing after the release's last" requires — run post-phase1 from a checkout whose last migration is its last.
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--release', 'post-phase1', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    const later = [...AREAS_2026_MIGRATIONS, ...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS];
    assert.equal(later.length, 25);
    assert.ok(r.stderr.includes(`${later.length} migration(s) after post-Phase-1 (11 migrations after M14)'s last (${later.join(', ')})`), r.stderr);
  });
});

// ── design-areas release (--release areas-2026; area 1 as simplified by the owner, 2026-11-19: countries) ──────────

test('areas-2026: exactly the migrations after the post-Phase-1 eleven in this checkout, in apply order; nothing after them', () => {
  const dirs = areasDirs();
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['post-phase1'].last), AREAS_2026_MIGRATIONS);
  assert.deepEqual([...AREAS_2026_MIGRATIONS].sort(), AREAS_2026_MIGRATIONS);
  const areas = releaseFrom(['--release', 'areas-2026']);
  assert.equal(areas.name, 'areas-2026');
  assert.equal(checkoutProblem(areas, dirs), null);
  assert.match(checkoutProblem(areas, [...dirs, '20261221000000_next']), /1 migration\(s\) after design areas .* \(20261221000000_next\)/);
  assert.match(checkoutProblem(areas, dirs.filter((d) => d !== AREAS_2026_MIGRATIONS[0])), /expected the 7 .* found 6/);
  // It builds on Phase 1 and the eleven: a database is ready for it only with all 25 recorded.
  assert.equal(areas.requires.count, 14 + POST_PHASE1_MIGRATIONS.length);
  assert.equal(dirs.filter((d) => areas.requires.owns(d)).length, 25);
  for (const m of AREAS_2026_MIGRATIONS) assert.equal(areas.requires.owns(m), false);
});

test('areas-2026: rollback-history checks exactly the tables, enums, columns, triggers and functions its migrations create', () => {
  const o = AREAS_2026_OBJECTS;
  assert.deepEqual([...o.tables].sort(), createdBy(AREAS_2026_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g));
  assert.deepEqual([...o.enums].sort(), createdBy(AREAS_2026_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g));
  assert.deepEqual([...new Set(createdBy(AREAS_2026_MIGRATIONS, /CREATE TRIGGER ([a-z_]+)/g))], [...o.triggers].sort());
  assert.deepEqual([...new Set(createdBy(AREAS_2026_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g))], [...o.functions].sort());
  const added = AREAS_2026_MIGRATIONS.flatMap((d) => {
    let table = null;
    return readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').split(/\r?\n/).flatMap((line) => {
      const t = /ALTER TABLE "([A-Za-z]+)"/.exec(line); if (t) table = t[1];
      const c = /ADD COLUMN +"([A-Za-z]+)"/.exec(line);
      return c && !o.tables.includes(table) ? [`${table}.${c[1]}`] : [];
    });
  }).sort();
  assert.deepEqual(o.columns.map(([t, c]) => `${t}.${c}`).sort(), added);
});

test('areas-2026: one rollback file per migration, newest first, each refusing while it would lose data; no pre-switch step', () => {
  const release = releaseFrom(['--release', 'areas-2026']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, [...AREAS_2026_MIGRATIONS].reverse().map((m) => `${m}.rollback.sql`));
  assert.throws(() => releaseRollbackFiles(release, files.slice(1)), /expected 7 .* found 6/);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  for (const f of files) {
    const text = readFileSync(`docs/migrations/${f}`, 'utf8');
    assert.doesNotThrow(() => segments(text), f);
    assert.match(text, /RAISE EXCEPTION '[A-Z_]+_REFUSED/, f);
    assert.doesNotMatch(text.replace(/--[^\n]*/g, ''), /_prisma_migrations/, `${f}: history is a separate, approved step`);
  }
  // The post-Phase-1 release never runs them, and vice versa.
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'post-phase1']), docs).some((f) => f.startsWith('20261211') || f.startsWith('20261212') || f.startsWith('20261220')), false);
});

test('areas-2026: the pre- and post-check SQL are read only, use only \\echo, and name every object the release creates', () => {
  for (const file of [RELEASES['areas-2026'].precheck, RELEASES['areas-2026'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    const o = AREAS_2026_OBJECTS;
    for (const name of [...o.tables, ...o.triggers, ...o.functions, ...o.columns.map(([, c]) => c)]) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('the runner: areas-2026 passes the checkout guard on this checkout; a later or a missing migration is refused', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'areas-2026', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: areas-2026 — design areas \(7 migrations after post-Phase-1\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
  }, { drop: [...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy(['20261221000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'areas-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after design areas .*20261221000000_next/);
  }, { drop: [...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'status', '--release', 'areas-2026');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /expected the 7 migrations of design areas .* found 6/);
  }, { drop: ['20261211000000_countries_reference', ...LATE_2026_MIGRATIONS, ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
});

// ── late-2026 release (--release late-2026; the sign-up work, owner 2026-11-20: gender; home location) ──────────────

test('late-2026: exactly the migrations after the design areas in this checkout, in apply order; nothing after them', () => {
  const dirs = lateDirs();
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['areas-2026'].last), LATE_2026_MIGRATIONS);
  assert.deepEqual([...LATE_2026_MIGRATIONS].sort(), LATE_2026_MIGRATIONS);
  const late = releaseFrom(['--release', 'late-2026']);
  assert.equal(late.name, 'late-2026');
  assert.equal(checkoutProblem(late, dirs), null);
  assert.match(checkoutProblem(late, [...dirs, '20261230000000_next']), /1 migration\(s\) after late 2026 .* \(20261230000000_next\)/);
  assert.match(checkoutProblem(late, dirs.filter((d) => d !== LATE_2026_MIGRATIONS[0])), /expected the 3 .* found 2/);
  // It builds on Phase 1, post-Phase-1 and the design areas: a database is ready for it only with all 32 recorded.
  assert.equal(late.requires.count, 14 + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length);
  assert.equal(dirs.filter((d) => late.requires.owns(d)).length, 32);
  for (const m of LATE_2026_MIGRATIONS) assert.equal(late.requires.owns(m), false);
});

test('late-2026: rollback-history checks exactly the enums and columns its migrations create', () => {
  const o = LATE_2026_OBJECTS;
  assert.deepEqual([...o.tables].sort(), createdBy(LATE_2026_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g));
  assert.deepEqual([...o.enums].sort(), createdBy(LATE_2026_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g));
  assert.deepEqual([...new Set(createdBy(LATE_2026_MIGRATIONS, /CREATE TRIGGER ([a-z_]+)/g))], [...o.triggers].sort());
  assert.deepEqual([...new Set(createdBy(LATE_2026_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g))], [...o.functions].sort());
  const added = LATE_2026_MIGRATIONS.flatMap((d) => {
    let table = null;
    return readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').split(/\r?\n/).flatMap((line) => {
      const t = /ALTER TABLE "([A-Za-z]+)"/.exec(line); if (t) table = t[1];
      const c = /ADD COLUMN +"([A-Za-z]+)"/.exec(line);
      return c && !o.tables.includes(table) ? [`${table}.${c[1]}`] : [];
    });
  }).sort();
  assert.deepEqual(o.columns.map(([t, c]) => `${t}.${c}`).sort(), added);
});

test('late-2026: one rollback file per migration, newest first, each refusing while it would lose data; no pre-switch step', () => {
  const release = releaseFrom(['--release', 'late-2026']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, [...LATE_2026_MIGRATIONS].reverse().map((m) => `${m}.rollback.sql`));
  assert.throws(() => releaseRollbackFiles(release, files.slice(1)), /expected 3 .* found 2/);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  for (const f of files) {
    const text = readFileSync(`docs/migrations/${f}`, 'utf8');
    assert.doesNotThrow(() => segments(text), f);
    assert.match(text, /RAISE EXCEPTION '[A-Z_]+_REFUSED/, f);
    assert.doesNotMatch(text.replace(/--[^\n]*/g, ''), /_prisma_migrations/, `${f}: history is a separate, approved step`);
  }
  // The design-area release never runs them, and vice versa.
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'areas-2026']), docs).some((f) => f.startsWith('20261221')), false);
});

test('late-2026: the pre- and post-check SQL are read only, use only \\echo, and name every object the release creates', () => {
  for (const file of [RELEASES['late-2026'].precheck, RELEASES['late-2026'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    const o = LATE_2026_OBJECTS;
    for (const name of [...o.tables, ...o.enums, ...o.triggers, ...o.functions, ...o.columns.map(([, c]) => c)]) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('the runner: late-2026 passes the checkout guard on this checkout; a later or a missing migration is refused', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'late-2026', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: late-2026 — late 2026 \(3 migrations after the design areas\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
  }, { drop: [...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy(['20261230000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'late-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after late 2026 .*20261230000000_next/);
  }, { drop: [...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'status', '--release', 'late-2026');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /expected the 3 migrations of late 2026 .* found 2/);
  }, { drop: ['20261221000000_registration_gender', ...DEC_2026_MIGRATIONS, ...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
});

// ── dec-2026 release (--release dec-2026; the "Other" Olympiad interest, owner 2026-11-21) ──────────────────────────

test('dec-2026: exactly the migrations after late-2026 in this checkout; nothing after them; needs the 35 before them', () => {
  const dirs = decDirs();
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['late-2026'].last), DEC_2026_MIGRATIONS);
  const dec = releaseFrom(['--release', 'dec-2026']);
  assert.equal(dec.name, 'dec-2026');
  assert.equal(checkoutProblem(dec, dirs), null);
  assert.match(checkoutProblem(dec, [...dirs, '20261231000000_next']), /1 migration\(s\) after dec 2026 .* \(20261231000000_next\)/);
  assert.match(checkoutProblem(dec, dirs.filter((d) => d !== DEC_2026_MIGRATIONS[0])), /expected the 2 .* found 1/);
  assert.deepEqual([...DEC_2026_MIGRATIONS].sort(), DEC_2026_MIGRATIONS);
  assert.equal(dec.requires.count, 14 + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length + LATE_2026_MIGRATIONS.length);
  assert.equal(dirs.filter((d) => dec.requires.owns(d)).length, 35);
  for (const m of DEC_2026_MIGRATIONS) assert.equal(dec.requires.owns(m), false);
});

test('dec-2026: rollback-history checks exactly the tables and columns its migrations create', () => {
  const o = DEC_2026_OBJECTS;
  assert.deepEqual(createdBy(DEC_2026_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(DEC_2026_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), []);
  const added = DEC_2026_MIGRATIONS.flatMap((d) => [...readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8')
    .matchAll(/ALTER TABLE "([A-Za-z]+)" +ADD COLUMN "([A-Za-z]+)"/g)].map((m) => `${m[1]}.${m[2]}`)).sort();
  assert.deepEqual(o.columns.map(([t, c]) => `${t}.${c}`).sort(), added);
});

test('dec-2026: one rollback file per migration, newest first, each refusing while it would lose data; history is a separate step', () => {
  const release = releaseFrom(['--release', 'dec-2026']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, [...DEC_2026_MIGRATIONS].reverse().map((m) => `${m}.rollback.sql`));
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  for (const f of files) {
    const text = readFileSync(`docs/migrations/${f}`, 'utf8');
    assert.doesNotThrow(() => segments(text), f);
    assert.match(text, /RAISE EXCEPTION '[A-Z_]+_REFUSED/, f);
    assert.doesNotMatch(text.replace(/--[^\n]*/g, ''), /_prisma_migrations/, `${f}: history is a separate, approved step`);
  }
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'late-2026']), docs).some((f) => f.startsWith('20261223')), false);
});

test('dec-2026: the pre- and post-check SQL are read only, use only \\echo, and name every table and column the release creates', () => {
  for (const file of [RELEASES['dec-2026'].precheck, RELEASES['dec-2026'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    for (const name of [...DEC_2026_OBJECTS.tables, ...DEC_2026_OBJECTS.columns.map(([, c]) => c)]) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('the runner: dec-2026 passes the checkout guard on its checkout; a later migration is refused', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'dec-2026', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: dec-2026 — dec 2026 \(2 migrations after late 2026\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
  }, { drop: [...LEVELS_2026_MIGRATIONS, ...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--release', 'dec-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after dec 2026 .*20261224000000_divisions_levels/);
  }, { drop: [...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
});

// ── levels-2026 release (--release levels-2026; Olympiad levels, owner 2026-11-21) ────────────────────────────────

test('levels-2026: exactly the migration after dec-2026 in this checkout; nothing after it; needs the 37 before it', () => {
  const dirs = levelsDirs();
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['dec-2026'].last), LEVELS_2026_MIGRATIONS);
  const lv = releaseFrom(['--release', 'levels-2026']);
  assert.equal(lv.name, 'levels-2026');
  assert.equal(checkoutProblem(lv, dirs), null);
  assert.match(checkoutProblem(lv, [...dirs, '20261231000000_next']), /1 migration\(s\) after divisions and Olympiad levels .* \(20261231000000_next\)/);
  assert.match(checkoutProblem(lv, dirs.filter((d) => d !== LEVELS_2026_MIGRATIONS[0])), /expected the 1 .* found 0/);
  assert.equal(dirs.filter((d) => lv.requires.owns(d)).length, 37);
  for (const m of LEVELS_2026_MIGRATIONS) assert.equal(lv.requires.owns(m), false);
});

test('levels-2026: rollback-history checks exactly the tables, enums, columns, triggers and functions its migration creates', () => {
  const o = LEVELS_2026_OBJECTS;
  assert.deepEqual(createdBy(LEVELS_2026_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(LEVELS_2026_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), [...o.enums].sort());
  assert.deepEqual(createdBy(LEVELS_2026_MIGRATIONS, /CREATE TRIGGER ([a-z_]+)/g), [...o.triggers].sort());
  assert.deepEqual(createdBy(LEVELS_2026_MIGRATIONS, /CREATE OR REPLACE FUNCTION ([a-z_]+)/g), [...o.functions].sort());
  const added = LEVELS_2026_MIGRATIONS.flatMap((d) => {
    let table = null;
    return readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').split(/\r?\n/).flatMap((line) => {
      const t = /ALTER TABLE "([A-Za-z]+)"/.exec(line); if (t) table = t[1];
      const c = /ADD COLUMN +"([A-Za-z]+)"/.exec(line);
      return c && !o.tables.includes(table) ? [`${table}.${c[1]}`] : [];
    });
  }).sort();
  assert.deepEqual(o.columns.map(([t, c]) => `${t}.${c}`).sort(), added);
});

test('levels-2026: one rollback file, refusing while it would lose data (other divisions in use, classifications); history is a separate step', () => {
  const release = releaseFrom(['--release', 'levels-2026']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, LEVELS_2026_MIGRATIONS.map((m) => `${m}.rollback.sql`));
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  const text = readFileSync(`docs/migrations/${files[0]}`, 'utf8');
  assert.doesNotThrow(() => segments(text));
  assert.match(text, /RAISE EXCEPTION 'DIVISIONS_LEVELS_ROLLBACK_REFUSED/);
  assert.match(text, /"division" NOT IN \('JUNIOR', 'SENIOR', 'ALL'\)/);
  assert.doesNotMatch(text.replace(/--[^\n]*/g, ''), /_prisma_migrations/, 'history is a separate, approved step');
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'dec-2026']), docs).some((f) => f.startsWith('20261224')), false);
});

test('levels-2026: the pre- and post-check SQL are read only, use only \\echo, and name every object the release creates', () => {
  for (const file of [RELEASES['levels-2026'].precheck, RELEASES['levels-2026'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    const o = LEVELS_2026_OBJECTS;
    for (const name of [...o.tables, ...o.enums, ...o.triggers, ...o.functions, ...o.columns.map(([, c]) => c)]) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('the runner: levels-2026 passes the checkout guard on its checkout; a later migration is refused', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'levels-2026', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: levels-2026 — divisions and Olympiad levels \(1 migration after dec 2026\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
  }, { drop: [...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy(['20261231000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'levels-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after divisions and Olympiad levels .*20261231000000_next/);
  }, { drop: [...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  // This checkout as it is (the launch, banking, question-marking and session migrations after it): deploy refuses, naming all eleven.
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--release', 'levels-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.ok(r.stderr.includes(`12 migration(s) after divisions and Olympiad levels (1 migration after dec 2026)'s last (${[...LAUNCH_2026_MIGRATIONS, ...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS].join(', ')})`), r.stderr);
  });
});

// ── launch-2026 release (--release launch-2026; the six migrations after levels-2026, owner 2026-11-22/23) ──────────

test('launch-2026: exactly the seven migrations after levels-2026 in this checkout, in apply order; nothing after them; needs the 38 before them', () => {
  const dirs = launchDirs();
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['levels-2026'].last), LAUNCH_2026_MIGRATIONS);
  assert.deepEqual(LAUNCH_2026_MIGRATIONS, ['20261225000000_school_sync_mode', '20261225000100_teacher_unlisted_school', '20261226000000_registration_data',
    '20261227000000_coach_programme_access', '20261228000000_form_email_verification', '20261229000000_subscribers', '20261230000000_view_as']);
  assert.deepEqual([...LAUNCH_2026_MIGRATIONS].sort(), LAUNCH_2026_MIGRATIONS);
  const launch = releaseFrom(['--release', 'launch-2026']);
  assert.equal(launch.name, 'launch-2026');
  assert.equal(launch.last, '20261230000000');
  assert.equal(checkoutProblem(launch, dirs), null);
  assert.match(checkoutProblem(launch, [...dirs, '20261231000000_next']), /1 migration\(s\) after the launch release .* \(20261231000000_next\)/);
  assert.match(checkoutProblem(launch, dirs.filter((d) => d !== LAUNCH_2026_MIGRATIONS[2])), /expected the 7 .* found 6/);
  assert.equal(checkoutProblem(launch, [...dirs, '20261231000000_next'], { allowLater: true }), null);
  assert.equal(launch.requires.count, 38);
  assert.equal(dirs.filter((d) => launch.requires.owns(d)).length, 38);
  for (const m of LAUNCH_2026_MIGRATIONS) assert.equal(launch.requires.owns(m), false);
  for (const m of LEVELS_2026_MIGRATIONS) assert.equal(launch.owns(m), false);
});

test('launch-2026: rollback-history checks exactly the tables, enums and columns its migrations create (no trigger, no function)', () => {
  const o = LAUNCH_2026_OBJECTS;
  assert.deepEqual(createdBy(LAUNCH_2026_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(LAUNCH_2026_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), [...o.enums].sort());
  assert.deepEqual(createdBy(LAUNCH_2026_MIGRATIONS, /CREATE (?:OR REPLACE )?TRIGGER ([a-z_]+)/g), [...o.triggers].sort());
  assert.deepEqual(createdBy(LAUNCH_2026_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g), [...o.functions].sort());
  const added = LAUNCH_2026_MIGRATIONS.flatMap((d) => {
    let table = null;
    return readFileSync(`prisma/migrations/${d}/migration.sql`, 'utf8').split(/\r?\n/).flatMap((line) => {
      const t = /ALTER TABLE "([A-Za-z]+)"/.exec(line); if (t) table = t[1];
      const c = /ADD COLUMN +"([A-Za-z]+)"/.exec(line);
      return c && !o.tables.includes(table) ? [`${table}.${c[1]}`] : [];
    });
  }).sort();
  assert.equal(added.length, 9);
  assert.deepEqual(o.columns.map(([t, c]) => `${t}.${c}`).sort(), added);
});

test('launch-2026: one rollback file per migration, newest first, each refusing while it would lose data; history is a separate step', () => {
  const release = releaseFrom(['--release', 'launch-2026']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, [...LAUNCH_2026_MIGRATIONS].reverse().map((m) => `${m}.rollback.sql`));
  assert.throws(() => releaseRollbackFiles(release, docs.filter((f) => f !== files[0])), /expected 7 .* found 6/);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  for (const f of files) {
    const text = readFileSync(`docs/migrations/${f}`, 'utf8');
    assert.doesNotThrow(() => segments(text), f);
    assert.match(text, /RAISE EXCEPTION '[A-Z_]+_ROLLBACK_REFUSED/, f);
    assert.match(text.replace(/--[^\n]*/g, ''), /current_setting\('rof\.[a-z_]+', true\)/, `${f}: an acknowledgeable guard`);
    assert.doesNotMatch(text.replace(/--[^\n]*/g, ''), /_prisma_migrations/, `${f}: history is a separate, approved step`);
  }
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'levels-2026']), docs).some((f) => f.startsWith('2026122') && f > '20261225'), false);
});

test('launch-2026: the pre- and post-check SQL are read only, use only \\echo, and name every object the release creates', () => {
  for (const file of [RELEASES['launch-2026'].precheck, RELEASES['launch-2026'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    const o = LAUNCH_2026_OBJECTS;
    for (const name of [...o.tables, ...o.enums, ...o.columns.map(([, c]) => c)]) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('the runner: launch-2026 passes the checkout guard on this checkout; a later migration is refused by deploy, accepted by the release-only commands', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'launch-2026', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: launch-2026 — the launch release \(7 migrations after levels 2026\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
    const ack = run(root, 'rollback', '--release', 'launch-2026', '--acknowledge', 'tests', '--confirm', 'ep-anything');
    assert.equal(ack.status, 2, ack.stderr);
    assert.match(ack.stderr, /"tests" is not a guard of launch-2026's rollback files \(allowed for launch-2026: coach-restrictions, form-email-verification, saved-filters, subscribers, sync-modes, unlisted-school-details, view-as-sessions\)/);
  }, { drop: [...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy(['20261231000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'launch-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after the launch release .*20261231000000_next/);
    const rb = run(root, 'rollback', '--release', 'launch-2026', '--confirm', 'ep-anything');
    assert.notEqual(rb.status, 5, rb.stderr);
    assert.match(rb.stdout, /checkout: 1 later migration\(s\) present \(20261231000000_next\)/);
  }, { drop: [...BANKING_2026_MIGRATIONS, ...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
});
// ── banking-2026 release (--release banking-2026; the banking information after launch-2026, owner 2026-11-25) ────────

test('banking-2026: exactly the one migration after launch-2026 in this checkout; nothing after it; needs the 45 before it', () => {
  // This checkout as it was for banking-2026 (the question-marking-2027 migrations come after it).
  const dirs = migrationDirs(REPO_ROOT).filter((d) => !QUESTION_MARKING_2027_MIGRATIONS.includes(d) && !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['launch-2026'].last), BANKING_2026_MIGRATIONS);
  assert.deepEqual(BANKING_2026_MIGRATIONS, ['20261231000000_user_bank_details']);
  const banking = releaseFrom(['--release', 'banking-2026']);
  assert.equal(banking.name, 'banking-2026');
  assert.equal(banking.last, '20261231000000');
  assert.equal(checkoutProblem(banking, dirs), null);
  assert.match(checkoutProblem(banking, [...dirs, '20270101000000_next']), /1 migration\(s\) after the banking release .* \(20270101000000_next\)/);
  assert.match(checkoutProblem(banking, dirs.filter((d) => d !== BANKING_2026_MIGRATIONS[0])), /expected the 1 .* found 0/);
  assert.equal(banking.requires.count, 45);
  assert.equal(dirs.filter((d) => banking.requires.owns(d)).length, 45);
  for (const m of BANKING_2026_MIGRATIONS) assert.equal(banking.requires.owns(m), false);
  for (const m of LAUNCH_2026_MIGRATIONS) assert.equal(banking.owns(m), false);
});

test('banking-2026: rollback-history checks exactly the table its migration creates (no type, column, trigger or function)', () => {
  const o = BANKING_2026_OBJECTS;
  assert.deepEqual(createdBy(BANKING_2026_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(BANKING_2026_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), [...o.enums].sort());
  assert.deepEqual(createdBy(BANKING_2026_MIGRATIONS, /CREATE (?:OR REPLACE )?TRIGGER ([a-z_]+)/g), [...o.triggers].sort());
  assert.deepEqual(createdBy(BANKING_2026_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g), [...o.functions].sort());
  assert.doesNotMatch(readFileSync(`prisma/migrations/${BANKING_2026_MIGRATIONS[0]}/migration.sql`, 'utf8'), /ADD COLUMN/);
});

test('banking-2026: its rollback file refuses while bank details exist (acknowledgeable); history is a separate step', () => {
  const release = releaseFrom(['--release', 'banking-2026']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, ['20261231000000_user_bank_details.rollback.sql']);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  const text = readFileSync(`docs/migrations/${files[0]}`, 'utf8');
  assert.doesNotThrow(() => segments(text));
  assert.match(text, /RAISE EXCEPTION 'BANK_DETAILS_ROLLBACK_REFUSED/);
  assert.match(text.replace(/--[^\n]*/g, ''), /current_setting\('rof\.bank_details_rollback', true\)/);
  assert.doesNotMatch(text.replace(/--[^\n]*/g, ''), /_prisma_migrations/);
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'launch-2026']), docs).includes(files[0]), false);
});

test('banking-2026: the pre- and post-check SQL are read only, use only \\echo, and name the table', () => {
  for (const file of [RELEASES['banking-2026'].precheck, RELEASES['banking-2026'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    for (const name of BANKING_2026_OBJECTS.tables) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('the runner: banking-2026 passes the checkout guard on this checkout; a later migration is refused by deploy, accepted by the release-only commands', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'banking-2026', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: banking-2026 — the banking release \(1 migration after the launch release\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
    const ack = run(root, 'rollback', '--release', 'banking-2026', '--acknowledge', 'tests', '--confirm', 'ep-anything');
    assert.equal(ack.status, 2, ack.stderr);
    assert.match(ack.stderr, /"tests" is not a guard of banking-2026's rollback files \(allowed for banking-2026: bank-details\)/);
  }, { drop: [...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
  withCheckoutCopy(['20270101000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'banking-2026', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after the banking release .*20270101000000_next/);
    const rb = run(root, 'rollback', '--release', 'banking-2026', '--confirm', 'ep-anything');
    assert.notEqual(rb.status, 5, rb.stderr);
    assert.match(rb.stdout, /checkout: 1 later migration\(s\) present \(20270101000000_next\)/);
  }, { drop: [...QUESTION_MARKING_2027_MIGRATIONS, ...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
});


// ── Migration role (DRILL_MIGRATION_DATABASE_URL): the branch owner for schema changes, never production's password ──
import { resolveMigrationTarget, MIGRATION_ROLE_COMMANDS } from './rehearsal.mjs';

test('resolveMigrationTarget: unset → the application target, unchanged', () => {
  const app = { ok: true, url: 'postgresql://staging:s3@ep-branch-1.eu.aws.neon.tech/neondb', pooled: false };
  assert.deepEqual(resolveMigrationTarget(app, { migrationUrls: [], productionUrls: ['postgresql://owner:prodpw@ep-prod-9.eu.aws.neon.tech/neondb'], appUrls: [] }),
    { ok: true, url: app.url, role: 'staging', separate: false });
});

test('resolveMigrationTarget: the branch owner on the same endpoint with a branch-only password is used for schema changes', () => {
  const app = { ok: true, url: 'postgresql://staging:s3@ep-branch-1.eu.aws.neon.tech/neondb', pooled: false };
  const r = resolveMigrationTarget(app, {
    migrationUrls: ['postgresql://neondb_owner:branch-only-pw@ep-branch-1-pooler.eu.aws.neon.tech/neondb'],
    productionUrls: ['postgresql://neondb_owner:prodpw@ep-prod-9.eu.aws.neon.tech/neondb'], appUrls: [],
  });
  assert.equal(r.ok, true);
  assert.equal(r.role, 'neondb_owner');
  assert.equal(r.separate, true);
  assert.equal(new URL(r.url).hostname, 'ep-branch-1.eu.aws.neon.tech');   // direct endpoint, like the application target
  for (const c of ['deploy', 'status', 'diff', 'rollback', 'rollback-history']) assert.ok(MIGRATION_ROLE_COMMANDS.has(c));
  for (const c of ['precheck', 'postcheck', 'check-target']) assert.ok(!MIGRATION_ROLE_COMMANDS.has(c));
});

test('resolveMigrationTarget refuses: production host, another endpoint, a production password, no password, two entries', () => {
  const app = { ok: true, url: 'postgresql://staging:s3@ep-branch-1.eu.aws.neon.tech/neondb', pooled: false };
  const productionUrls = ['postgresql://neondb_owner:prodpw@ep-prod-9.eu.aws.neon.tech/neondb'];
  const run = (m) => resolveMigrationTarget(app, { migrationUrls: m, productionUrls, appUrls: [] });
  const prodHost = run(['postgresql://neondb_owner:other@ep-prod-9.eu.aws.neon.tech/neondb']);
  assert.equal(prodHost.ok, false); assert.match(prodHost.reason, /production host/);
  const other = run(['postgresql://neondb_owner:other@ep-other-2.eu.aws.neon.tech/neondb']);
  assert.equal(other.ok, false); assert.match(other.reason, /not on the same endpoint/);
  const copied = run(['postgresql://neondb_owner:prodpw@ep-branch-1.eu.aws.neon.tech/neondb']);
  assert.equal(copied.ok, false); assert.match(copied.reason, /production password/);
  assert.doesNotMatch(copied.reason, /prodpw/);
  assert.equal(run(['postgresql://neondb_owner@ep-branch-1.eu.aws.neon.tech/neondb']).ok, false);
  assert.equal(run(['postgresql://a:b@ep-branch-1.eu.aws.neon.tech/neondb', 'postgresql://a:c@ep-branch-1.eu.aws.neon.tech/neondb']).code, 2);
});

// ── Resumable rollback (2026-11-19 staging rehearsal): options and the newer-checkout rule. The database scenarios are in
//    test/release-rollback-resume.e2e-spec.ts (CI e2e job). ─────────────────────────────────────────────────────────────

test('--acknowledge / --stop-after: refused before any target is read when unknown, malformed, repeated or not on rollback', () => {
  withCheckoutCopy([], (root) => {
    const refused = (args, re) => {
      const r = run(root, ...args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stderr, /DRILL_DATABASE_URL|production/);
    };
    refused(['rollback', '--release', 'post-phase1', '--acknowledge', 'everything', '--confirm', 'ep-x'], /not a guard of post-phase1/);
    refused(['rollback', '--release', 'post-phase1', '--acknowledge', 'rof.registration_details_rollback=discard-registration-details'], /malformed/);
    refused(['rollback', '--release', 'post-phase1', '--acknowledge', 'registration-details', '--acknowledge', 'registration-details'], /given twice/);
    refused(['rollback', '--release', 'post-phase1', '--acknowledge', 'country-edits'], /not a guard of post-phase1/);
    refused(['rollback', '--release', 'post-phase1', '--acknowledge'], /malformed/);
    refused(['deploy', '--release', 'post-phase1', '--acknowledge', 'registration-details'], /options of `rollback` only/);
    refused(['rollback', '--release', 'post-phase1', '--stop-after', '0'], /--stop-after takes one whole number/);
    refused(['rollback', '--release', 'post-phase1', '--stop-after', 'x'], /--stop-after takes one whole number/);
    // A valid id passes the option checks and goes on to the target guard (fail-closed here: no target configured).
    const ok = run(root, 'rollback', '--release', 'post-phase1', '--acknowledge', 'registration-details', '--stop-after', '3', '--confirm', 'ep-x');
    assert.notEqual(ok.status, 0);
    assert.match(ok.stderr, /DRILL_DATABASE_URL not found/, ok.stderr);
  });
});

test('a newer checkout: post-phase1 rollback, rollback-history, precheck, postcheck, check-target, dump, restore pass the checkout rule; deploy, diff, status do not', () => {
  // This checkout as it is (on develop: the design-area migrations come after the eleven), plus one more.
  const later = [...afterRelease(releaseFrom(['--release', 'post-phase1']), migrationDirs(REPO_ROOT)), '20261299000000_later'].sort();
  withCheckoutCopy(['20261299000000_later'], (root) => {
    for (const command of ['check-target', 'precheck', 'postcheck', 'rollback', 'rollback-history', 'dump', 'restore']) {
      const r = run(root, command, '--release', 'post-phase1', '--confirm', 'ep-x');
      assert.notEqual(r.status, 5, `${command}: ${r.stderr}`);
      assert.ok(r.stdout.includes(`checkout: ${later.length} later migration(s) present (${later.join(', ')})`), `${command}: ${r.stdout}`);
    }
    for (const command of ['deploy', 'diff', 'status']) {
      const r = run(root, command, '--release', 'post-phase1', '--confirm', 'ep-x');
      assert.equal(r.status, 5, `${command}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`${later.length} migration(s) after post-Phase-1`), r.stderr);
    }
    // The release's own migrations must still all be there, whatever the command.
  });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'rollback', '--release', 'post-phase1', '--confirm', 'ep-x');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /expected the 11 migrations of post-Phase-1 .* found 10/);
  }, { drop: ['20261204000000_registration_details'] });
  // Phase 1 keeps its original rule for every command (owner decision 2026-11-13), as the test above shows.
});

// ── question-marking-2027 release (--release question-marking-2027; design Rev 5.2, owner approval 2026-11-26) ────────

test('question-marking-2027: exactly the two migrations after banking-2026 in this checkout; nothing after them; needs the 46 before them', () => {
  // This checkout as it was for question-marking-2027 (the session-2027 migration comes after it).
  const dirs = migrationDirs(REPO_ROOT).filter((d) => !SESSION_2027_MIGRATIONS.includes(d) && !REPORTS_2027_MIGRATIONS.includes(d));
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['banking-2026'].last), QUESTION_MARKING_2027_MIGRATIONS);
  assert.deepEqual(QUESTION_MARKING_2027_MIGRATIONS, ['20270101000000_question_marking_kind', '20270101000100_question_marking']);
  const qm = releaseFrom(['--release', 'question-marking-2027']);
  assert.equal(qm.name, 'question-marking-2027');
  assert.equal(qm.last, '20270101000100');
  assert.equal(checkoutProblem(qm, dirs), null);
  assert.match(checkoutProblem(qm, [...dirs, '20270102000000_next']), /1 migration\(s\) after question-level marking .* \(20270102000000_next\)/);
  assert.match(checkoutProblem(qm, dirs.filter((d) => d !== QUESTION_MARKING_2027_MIGRATIONS[1])), /expected the 2 .* found 1/);
  assert.equal(qm.requires.count, 46);
  assert.equal(dirs.filter((d) => qm.requires.owns(d)).length, 46);
  for (const m of QUESTION_MARKING_2027_MIGRATIONS) assert.equal(qm.requires.owns(m), false);
  for (const m of BANKING_2026_MIGRATIONS) assert.equal(qm.owns(m), false);
});

test('question-marking-2027: rollback-history checks every table, type, column, trigger and function its migrations create', () => {
  const o = QUESTION_MARKING_2027_OBJECTS;
  assert.deepEqual(createdBy(QUESTION_MARKING_2027_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(QUESTION_MARKING_2027_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), [...o.enums].sort());
  assert.deepEqual(createdBy(QUESTION_MARKING_2027_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g), [...o.functions].sort());
  // Triggers on the tables the migration creates go with those tables; the ones on existing tables are listed.
  const allTriggers = createdBy(QUESTION_MARKING_2027_MIGRATIONS, /CREATE (?:CONSTRAINT )?TRIGGER ([a-z_]+)/g);
  for (const t of o.triggers) assert.ok(allTriggers.includes(t), t);
  assert.equal(allTriggers.length, 19);
  assert.deepEqual(o.columns, [['Test', 'markingMode'], ['TestQuestion', 'promptVersion']]);
  assert.equal(MIGRATION_OBJECTS['20270101000000_question_marking_kind'].checkOnly, true);
  assert.deepEqual(MIGRATION_OBJECTS['20270101000000_question_marking_kind'].kept.enumValues, [['TestMarkingKind', 'COMPOSED']]);
});

test('question-marking-2027: the rollback files need backup EVIDENCE (never an acknowledgement); refuse while COMPOSED exists; history is separate', () => {
  const release = releaseFrom(['--release', 'question-marking-2027']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, ['20270101000100_question_marking.rollback.sql', '20270101000000_question_marking_kind.rollback.sql']);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  const main = readFileSync(`docs/migrations/${files[0]}`, 'utf8');
  const code = main.replace(/--[^\n]*/g, '');
  assert.doesNotThrow(() => segments(main));
  assert.match(code, /current_setting\('rof\.question_marking_manifest', true\)/);
  assert.match(code, /'verified'\) IS DISTINCT FROM 'true'/);
  assert.match(code, /WHERE "kind" = 'COMPOSED'[\s\S]*QUESTION_MARKING_ROLLBACK_REFUSED/);
  // No acknowledgement form: an id cannot bypass it.
  assert.doesNotMatch(code, /IS DISTINCT FROM 'discard/);
  assert.doesNotMatch(code, /_prisma_migrations/);
  // The checksums the rollback recomputes are the kit's (same expressions), for every table and subset of the manifest.
  for (const t of QUESTION_MARKING_EVIDENCE.tables) assert.ok(main.includes(`'${t}'`), t);
  for (const k of Object.keys(QUESTION_MARKING_EVIDENCE.subsets)) assert.ok(main.includes(`'${k}'`), k);
  assert.ok(code.includes(`md5(coalesce(string_agg(x::text, E''\\n'' ORDER BY x."id"), ''''))`));
  for (const q of evidenceQueries(QUESTION_MARKING_EVIDENCE).slice(0, 1)) assert.ok(q.sql.includes(`md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x."id"), ''))`), q.sql);
  // The original CHECK is restored.
  assert.ok(code.includes(`CHECK (("kind" = 'ADJUSTMENT') = ("assignmentId" IS NULL))`));
  const kind = readFileSync(`docs/migrations/${files[1]}`, 'utf8').replace(/--[^\n]*/g, '');
  assert.match(kind, /QUESTION_MARKING_KIND_ROLLBACK_REFUSED/);
  assert.doesNotMatch(kind, /\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/);
});

test('question-marking-2027: the pre- and post-check SQL are read only, use only \\echo, and name every table', () => {
  for (const file of [RELEASES['question-marking-2027'].precheck, RELEASES['question-marking-2027'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    for (const name of QUESTION_MARKING_2027_OBJECTS.tables) assert.ok(text.includes(`'${name}'`), `${file}: ${name}`);
  }
});

test('question-marking-2027 evidence: a manifest only when the restored backup equals the target; every flaw refused', () => {
  const release = releaseFrom(['--release', 'question-marking-2027']);
  const keys = [...QUESTION_MARKING_EVIDENCE.tables, ...Object.keys(QUESTION_MARKING_EVIDENCE.subsets)];
  assert.equal(evidenceQueries(QUESTION_MARKING_EVIDENCE).length, 13);
  const sums = Object.fromEntries(keys.map((k, i) => [k, { count: String(i), md5: String(i).padStart(32, 'a') }]));
  const dump = { file: 'C:/backup/x.dump', sha256: 'f'.repeat(64), bytes: 10 };
  const good = evidenceManifest({ release: release.name, scratch: sums, target: sums, dump });
  assert.equal(good.ok, true);
  assert.equal(good.manifest.verified, true);
  assert.equal(good.manifest.dumpSha256, dump.sha256);
  assert.equal(evidenceProblem(good.manifest, release, dump.sha256), null);
  // A row written after the backup: no manifest.
  const changed = evidenceManifest({ release: release.name, scratch: sums, target: { ...sums, TestTaskClaim: { count: '8', md5: 'b'.repeat(32) } }, dump });
  assert.equal(changed.ok, false);
  assert.match(changed.differences.join(), /TestTaskClaim: backup \d+ row\(s\), target 8 row\(s\)/);
  // Same count, different contents.
  const edited = evidenceManifest({ release: release.name, scratch: sums, target: { ...sums, TestQuestionTask: { ...sums.TestQuestionTask, md5: 'c'.repeat(32) } }, dump });
  assert.match(edited.differences.join(), /TestQuestionTask: .*contents differ/);
  // The manifest file itself: wrong release, unverified, a changed dump, a missing check, another release.
  assert.match(evidenceProblem({ ...good.manifest, release: 'banking-2026' }, release, dump.sha256), /for banking-2026/);
  assert.match(evidenceProblem({ ...good.manifest, verified: 'true' }, release, dump.sha256), /not verified/);
  assert.match(evidenceProblem(good.manifest, release, 'e'.repeat(64)), /sha256 does not equal/);
  assert.match(evidenceProblem(good.manifest, release, null), /sha256 does not equal/);
  const { TestTaskEvent, ...rest } = good.manifest.tables;
  assert.ok(TestTaskEvent);
  assert.match(evidenceProblem({ ...good.manifest, tables: rest }, release, dump.sha256), /lacks checks for: TestTaskEvent/);
  assert.match(evidenceProblem(good.manifest, releaseFrom(['--release', 'banking-2026']), dump.sha256), /takes no --evidence/);
});

test('the runner: question-marking-2027 passes the checkout guard; --evidence is refused unless it is a verified manifest of this release, and only on rollback', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'question-marking-2027', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: question-marking-2027 — question-level marking \(2 migrations after the banking release\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
    const ack = run(root, 'rollback', '--release', 'question-marking-2027', '--acknowledge', 'bank-details', '--confirm', 'ep-anything');
    assert.equal(ack.status, 2, ack.stderr);
    assert.match(ack.stderr, /not a guard of question-marking-2027's rollback files \(allowed for question-marking-2027: none\)/);
    const missing = run(root, 'rollback', '--release', 'question-marking-2027', '--evidence', join(root, 'nope.json'), '--confirm', 'ep-anything');
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /--evidence must name an existing manifest file/);
    const bad = join(root, 'bad.json');
    writeFileSync(bad, JSON.stringify({ release: 'question-marking-2027', verified: true, dumpFile: join(root, 'gone.dump'), dumpSha256: 'a'.repeat(64), tables: {} }));
    const unverifiable = run(root, 'rollback', '--release', 'question-marking-2027', '--evidence', bad, '--confirm', 'ep-anything');
    assert.equal(unverifiable.status, 2, unverifiable.stderr);
    assert.match(unverifiable.stderr, /sha256 does not equal/);
    const elsewhere = run(root, 'deploy', '--release', 'question-marking-2027', '--evidence', bad);
    assert.equal(elsewhere.status, 2, elsewhere.stderr);
    assert.match(elsewhere.stderr, /--evidence is an option of `rollback` only/);
    const vb = run(root, 'verify-backup', '--release', 'question-marking-2027', '--confirm', 'ep-anything');
    assert.notEqual(vb.status, 5, vb.stderr);
  }, { drop: [...SESSION_2027_MIGRATIONS, ...REPORTS_2027_MIGRATIONS] });
});

// ── session-2027 release (--release session-2027; sessions end after 60 minutes without activity, owner 2026-11-28) ──

test('session-2027: exactly the one migration after question-marking-2027 in this checkout; nothing after it; needs the 48 before it', () => {
  // This checkout as it was for session-2027 (the reports-2027 migration comes after it).
  const dirs = migrationDirs(REPO_ROOT).filter((d) => !REPORTS_2027_MIGRATIONS.includes(d));
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['question-marking-2027'].last), SESSION_2027_MIGRATIONS);
  assert.deepEqual(SESSION_2027_MIGRATIONS, ['20270102000000_session_activity']);
  const session = releaseFrom(['--release', 'session-2027']);
  assert.equal(session.name, 'session-2027');
  assert.equal(session.last, '20270102000000');
  assert.equal(checkoutProblem(session, dirs), null);
  assert.match(checkoutProblem(session, [...dirs, '20270103000000_next']), /1 migration\(s\) after session inactivity .* \(20270103000000_next\)/);
  assert.match(checkoutProblem(session, dirs.filter((d) => d !== SESSION_2027_MIGRATIONS[0])), /expected the 1 .* found 0/);
  assert.equal(session.requires.count, 48);
  assert.equal(dirs.filter((d) => session.requires.owns(d)).length, 48);
  for (const m of SESSION_2027_MIGRATIONS) assert.equal(session.requires.owns(m), false);
  for (const m of QUESTION_MARKING_2027_MIGRATIONS) assert.equal(session.owns(m), false);
});

test('session-2027: rollback-history checks exactly the column its migration adds (no table, type, trigger or function)', () => {
  const o = SESSION_2027_OBJECTS;
  assert.deepEqual(createdBy(SESSION_2027_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(SESSION_2027_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), [...o.enums].sort());
  assert.deepEqual(createdBy(SESSION_2027_MIGRATIONS, /CREATE (?:OR REPLACE )?TRIGGER ([a-z_]+)/g), [...o.triggers].sort());
  assert.deepEqual(createdBy(SESSION_2027_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g), [...o.functions].sort());
  assert.deepEqual(createdBy(SESSION_2027_MIGRATIONS, /ALTER TABLE "([A-Za-z]+)" ADD COLUMN "([A-Za-z]+)"/g), o.columns.map(([t, c]) => `${t}.${c}`).sort());
  assert.deepEqual(MIGRATION_OBJECTS['20270102000000_session_activity'].creates.columns, o.columns);
});

test('session-2027: its rollback file drops only that column; history is a separate step', () => {
  const release = releaseFrom(['--release', 'session-2027']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, ['20270102000000_session_activity.rollback.sql']);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  const text = readFileSync(`docs/migrations/${files[0]}`, 'utf8');
  assert.doesNotThrow(() => segments(text));
  const sql = text.replace(/--[^\n]*/g, '');
  assert.match(sql, /ALTER TABLE "RefreshToken" DROP COLUMN "lastActivityAt";/);
  assert.doesNotMatch(sql, /DROP TABLE|_prisma_migrations/);
  assert.equal(releaseRollbackFiles(releaseFrom(['--release', 'question-marking-2027']), docs).includes(files[0]), false);
});

test('session-2027: the pre- and post-check SQL are read only, use only \echo, and name the column', () => {
  for (const file of [RELEASES['session-2027'].precheck, RELEASES['session-2027'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    for (const [, column] of SESSION_2027_OBJECTS.columns) assert.ok(text.includes(`'${column}'`), `${file}: ${column}`);
  }
});

test('the runner: session-2027 passes the checkout guard on its checkout; a later migration is refused by deploy', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'session-2027', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: session-2027 — session inactivity \(1 migration after question-level marking\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
  }, { drop: REPORTS_2027_MIGRATIONS });
  withCheckoutCopy([], (root) => {
    const r = run(root, 'deploy', '--release', 'session-2027', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after session inactivity .*20270103000000_submission_reports/);
  });
});

// ── reports-2027 release (--release reports-2027; submission reports and report sharing, owner 2026-11-28) ──

test('reports-2027: exactly the one migration after session-2027 in this checkout; nothing after it; needs the 49 before it', () => {
  const dirs = migrationDirs(REPO_ROOT);
  assert.deepEqual(dirs.filter((d) => d.slice(0, 14) > RELEASES['session-2027'].last), REPORTS_2027_MIGRATIONS);
  assert.deepEqual(REPORTS_2027_MIGRATIONS, ['20270103000000_submission_reports']);
  const reports = releaseFrom(['--release', 'reports-2027']);
  assert.equal(reports.name, 'reports-2027');
  assert.equal(reports.last, '20270103000000');
  assert.equal(checkoutProblem(reports, dirs), null);
  assert.match(checkoutProblem(reports, [...dirs, '20270104000000_next']), /1 migration\(s\) after submission reports .* \(20270104000000_next\)/);
  assert.match(checkoutProblem(reports, dirs.filter((d) => d !== REPORTS_2027_MIGRATIONS[0])), /expected the 1 .* found 0/);
  assert.equal(reports.requires.count, 49);
  assert.equal(dirs.filter((d) => reports.requires.owns(d)).length, 49);
  for (const m of REPORTS_2027_MIGRATIONS) assert.equal(reports.requires.owns(m), false);
  for (const m of SESSION_2027_MIGRATIONS) assert.equal(reports.owns(m), false);
});

test('reports-2027: rollback-history checks exactly what its migration creates (one table, its trigger function, four grant columns)', () => {
  const o = REPORTS_2027_OBJECTS;
  assert.deepEqual(createdBy(REPORTS_2027_MIGRATIONS, /CREATE TABLE "([A-Za-z]+)"/g), [...o.tables].sort());
  assert.deepEqual(createdBy(REPORTS_2027_MIGRATIONS, /CREATE TYPE "([A-Za-z]+)"/g), [...o.enums].sort());
  assert.deepEqual(createdBy(REPORTS_2027_MIGRATIONS, /CREATE (?:OR REPLACE )?TRIGGER ([a-z_]+)/g), [...o.triggers].sort());
  assert.deepEqual(createdBy(REPORTS_2027_MIGRATIONS, /CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)/g), [...o.functions].sort());
  assert.deepEqual(MIGRATION_OBJECTS['20270103000000_submission_reports'].creates.tables, o.tables);
  assert.deepEqual(MIGRATION_OBJECTS['20270103000000_submission_reports'].creates.columns, o.columns);
  const sql = readFileSync('prisma/migrations/20270103000000_submission_reports/migration.sql', 'utf8');
  for (const [, column] of o.columns) assert.match(sql, new RegExp(`ADD COLUMN\\s+"${column}"`), column);
});

test('reports-2027: its rollback file is guarded (corrections, school grants), removes grants the previous release cannot honour, drops only what the migration added; history is a separate step', () => {
  const release = releaseFrom(['--release', 'reports-2027']);
  const docs = readdirSync('docs/migrations');
  const files = releaseRollbackFiles(release, docs);
  assert.deepEqual(files, ['20270103000000_submission_reports.rollback.sql']);
  assert.deepEqual(releasePreSwitchFiles(release, docs), []);
  const text = readFileSync(`docs/migrations/${files[0]}`, 'utf8');
  assert.doesNotThrow(() => segments(text));
  const sql = text.replace(/--[^\n]*/g, '');
  assert.match(sql, /SUBMISSION_REPORTS_ROLLBACK_REFUSED/);
  assert.match(sql, /current_setting\('rof\.submission_reports_rollback', true\)/);
  assert.match(sql, /DELETE FROM "CustomReportGrant" WHERE "schoolId" IS NOT NULL OR "revokedAt" IS NOT NULL OR "expiresAt" IS NOT NULL;/);
  assert.match(sql, /DROP TABLE "TestSubmissionCorrection";/);
  assert.match(sql, /DROP FUNCTION test_submission_correction_append_only\(\);/);
  assert.doesNotMatch(sql, /_prisma_migrations/);
});

test('reports-2027: the pre- and post-check SQL are read only and name the table and the columns', () => {
  for (const file of [RELEASES['reports-2027'].precheck, RELEASES['reports-2027'].postcheck]) {
    const text = readFileSync(file, 'utf8');
    const segs = segments(text).filter((s) => typeof s === 'string');
    assert.match(segs[0], /BEGIN TRANSACTION READ ONLY;/, file);
    assert.match(segs.at(-1), /ROLLBACK;\s*$/, file);
    assert.doesNotMatch(segs.join('\n').replace(/--[^\n]*/g, ''), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i, file);
    assert.ok(text.includes("'TestSubmissionCorrection'"), file);
    for (const [, column] of REPORTS_2027_OBJECTS.columns) assert.ok(text.includes(`'${column}'`), `${file}: ${column}`);
  }
});

test('the runner: reports-2027 passes the checkout guard on this checkout; a later migration is refused by deploy', () => {
  withCheckoutCopy([], (root) => {
    const ok = run(root, 'deploy', '--release', 'reports-2027', '--confirm', 'ep-anything');
    assert.notEqual(ok.status, 5, ok.stderr);
    assert.match(ok.stdout, /release: reports-2027 — submission reports \(1 migration after session inactivity\)/);
    assert.ok(ok.status !== 0, 'no target configured, so the target guard refuses next (fail-closed)');
  });
  withCheckoutCopy(['20270104000000_next'], (root) => {
    const r = run(root, 'deploy', '--release', 'reports-2027', '--confirm', 'ep-anything');
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /1 migration\(s\) after submission reports .*20270104000000_next/);
  });
});
