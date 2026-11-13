// Tests for scripts/db-drill-verify.mjs — run: node --test scripts/db-drill-verify.test.mjs
// No database is contacted: the guard and the tables check are pure functions, and the
// CLI tests use --check-target (or stop at the guard) with synthetic URLs only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envValues, hostOf, resolveDrillTarget, checkTables, expectedState, REPO_ROOT, VERIFIER } from './db-drill-verify.mjs';
import { PHASE1 } from './release/phase1.mjs';

// Synthetic hosts (not real endpoints).
const PROD_DIRECT = 'postgresql://u:prodsecret@ep-prod-aaa111.c-1.us-east-2.aws.example.tech/neondb?sslmode=require';
const PROD_POOLED = 'postgresql://u:prodsecret@ep-prod-aaa111-pooler.c-1.us-east-2.aws.example.tech/neondb?sslmode=require';
const DRILL_POOLED = 'postgresql://u:drillsecret@ep-drill-bbb222-pooler.c-1.us-east-2.aws.example.tech/neondb?sslmode=require';
const DRILL_DIRECT = 'postgresql://u:drillsecret@ep-drill-bbb222.c-1.us-east-2.aws.example.tech/neondb?sslmode=require';
const LOCAL = 'postgresql://rof:rof@localhost:5432/rof?schema=public';

const resolveWith = (o) => resolveDrillTarget({ drillUrls: [DRILL_POOLED], productionUrls: [PROD_DIRECT], appUrls: [LOCAL], ...o });

describe('envValues', () => {
  test('reads plain, quoted, exported and spaced assignments; ignores other keys and comments', () => {
    const text = [
      '# DATABASE_URL=commented-out',
      'DATABASE_URL="a"',
      "export DATABASE_URL='b'",
      '  DATABASE_URL = c  ',
      'OTHER_DATABASE_URL=x',
      'DATABASE_URL_2=y',
    ].join('\r\n');
    assert.deepEqual(envValues(text, 'DATABASE_URL'), ['a', 'b', 'c']);
  });
  test('returns an empty list when the key is absent', () => {
    assert.deepEqual(envValues('FOO=1\n', 'DATABASE_URL'), []);
  });
});

describe('hostOf', () => {
  test('pooled and direct endpoints of one branch normalise to the same host, case-insensitively', () => {
    assert.equal(hostOf(PROD_POOLED), hostOf(PROD_DIRECT));
    assert.equal(hostOf(PROD_DIRECT.replace('ep-prod', 'EP-PROD')), hostOf(PROD_DIRECT));
  });
  test('invalid or host-less values give null', () => {
    assert.equal(hostOf('not a url'), null);
    assert.equal(hostOf(''), null);
    assert.equal(hostOf('file:///tmp/x'), null);
  });
});

describe('resolveDrillTarget — production guard fails closed', () => {
  test('accepts a distinct recovery branch and switches a pooled string to the direct endpoint', () => {
    const r = resolveWith({});
    assert.equal(r.ok, true);
    assert.equal(r.pooled, true);
    assert.equal(hostOf(r.url), hostOf(DRILL_DIRECT));
    assert.ok(!new URL(r.url).hostname.includes('-pooler'));
  });
  test('a direct drill string is kept as is', () => {
    const r = resolveWith({ drillUrls: [DRILL_DIRECT] });
    assert.equal(r.ok, true);
    assert.equal(r.pooled, false);
  });
  test('refuses the production host (direct)', () => {
    const r = resolveWith({ drillUrls: [PROD_DIRECT] });
    assert.deepEqual([r.ok, r.code], [false, 3]);
  });
  test('refuses the production host when only the pooled/direct form differs', () => {
    assert.equal(resolveWith({ drillUrls: [PROD_POOLED] }).code, 3);
    assert.equal(resolveWith({ drillUrls: [PROD_DIRECT], productionUrls: [PROD_POOLED] }).code, 3);
  });
  test('refuses when ANY production DATABASE_URL definition matches', () => {
    assert.equal(resolveWith({ drillUrls: [DRILL_DIRECT], productionUrls: [PROD_DIRECT, DRILL_POOLED] }).code, 3);
  });
  test('fails closed (exit 4) when the production configuration has no DATABASE_URL', () => {
    const r = resolveWith({ productionUrls: [] });
    assert.deepEqual([r.ok, r.code], [false, 4]);
    assert.match(r.reason, /production host unknown/);
  });
  test('fails closed (exit 4) when a production DATABASE_URL is not a valid URL', () => {
    assert.equal(resolveWith({ productionUrls: ['<paste here>'] }).code, 4);
    assert.equal(resolveWith({ productionUrls: [PROD_DIRECT, ''] }).code, 4);
  });
  test('refuses a database the app is configured to use (.env / .env.local / environment)', () => {
    assert.equal(resolveWith({ appUrls: [LOCAL, DRILL_DIRECT] }).code, 3);
    assert.match(resolveWith({ appUrls: [DRILL_POOLED] }).reason, /app is configured to use/);
  });
  test('ignores unparseable app URLs (they cannot match) but still requires the production host', () => {
    assert.equal(resolveWith({ appUrls: ['garbage'] }).ok, true);
  });
  test('rejects a missing, duplicated or invalid DRILL_DATABASE_URL (exit 2)', () => {
    assert.equal(resolveWith({ drillUrls: [] }).code, 2);
    assert.equal(resolveWith({ drillUrls: [DRILL_DIRECT, DRILL_POOLED] }).code, 2);
    assert.equal(resolveWith({ drillUrls: ['nonsense'] }).code, 2);
  });
  test('reasons never contain a connection string or password', () => {
    for (const o of [{ drillUrls: [PROD_DIRECT] }, { productionUrls: [] }, { appUrls: [DRILL_DIRECT] }, { drillUrls: ['nonsense'] }]) {
      const r = resolveWith(o);
      assert.doesNotMatch(r.reason, /postgres|secret|example\.tech/);
    }
  });
  // node-postgres resolves the host differently from `new URL().hostname` in these cases; each one
  // used to pass the guard while connecting to production (review of 4d21ed5).
  test('refuses a drill URL whose query parameters could redirect the connection (host, hostaddr, port, service, options)', () => {
    for (const p of ['host=ep-prod-aaa111.c-1.us-east-2.aws.example.tech', 'hostaddr=10.0.0.1', 'port=6543', 'service=prod', 'options=-c%20x%3Dy']) {
      const r = resolveWith({ drillUrls: [`${DRILL_DIRECT}&${p}`] });
      assert.equal(r.code, 3, p);
      assert.doesNotMatch(r.reason, /secret|example\.tech/);
    }
  });
  test('refuses the production host when it is percent-encoded or has a trailing dot', () => {
    assert.equal(resolveWith({ drillUrls: [PROD_DIRECT.replace('@ep-prod', '@%65p-prod')] }).code, 3);
    assert.equal(resolveWith({ drillUrls: [PROD_DIRECT.replace('example.tech/', 'example.tech./')] }).code, 3);
  });
  test('refuses a host that shares the production endpoint id (first label), whatever the rest', () => {
    assert.equal(resolveWith({ drillUrls: [PROD_DIRECT.replace('c-1.us-east-2', 'c-9.eu-west-1')] }).code, 3);
  });
  test('the accepted URL carries exactly the checked host (decoded, no trailing dot, direct endpoint)', () => {
    const r = resolveWith({ drillUrls: [DRILL_POOLED.replace('example.tech/', 'example.tech./').replace('@ep-drill', '@%65p-drill')] });
    assert.equal(r.ok, true);
    assert.equal(new URL(r.url).hostname, 'ep-drill-bbb222.c-1.us-east-2.aws.example.tech');
    assert.equal(r.pooled, true);
  });
});

describe('checkTables', () => {
  const models = ['Course', 'User'];
  test('passes when tables match the models exactly (plus _prisma_migrations)', () => {
    assert.deepEqual(checkTables(models, ['Course', 'User', '_prisma_migrations']), { ok: true, missingTables: [], extraTables: [] });
  });
  test('fails on a missing table', () => {
    const r = checkTables(models, ['User', '_prisma_migrations']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingTables, ['Course']);
  });
  test('fails on an unexpected table', () => {
    const r = checkTables(models, ['Course', 'User', 'LegacyBackup', '_prisma_migrations']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.extraTables, ['LegacyBackup']);
    assert.deepEqual(r.missingTables, []);
  });
  test('fails and reports both when tables are missing and unexpected', () => {
    const r = checkTables(models, ['User', 'Stray']);
    assert.deepEqual(r, { ok: false, missingTables: ['Course'], extraTables: ['Stray'] });
  });
});

describe('CLI guard (no database connection)', () => {
  const script = resolve('scripts/db-drill-verify.mjs');
  const run = (files, env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-guard-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    const childEnv = { ...process.env, ...env };
    if (!('DATABASE_URL' in env)) delete childEnv.DATABASE_URL;
    return spawnSync(process.execPath, [script, '--check-target'], { cwd: dir, env: childEnv, encoding: 'utf8' });
  };
  const noSecrets = (r) => assert.doesNotMatch(r.stdout + r.stderr, /secret|example\.tech|postgres(ql)?:\/\//);

  test('passes with a distinct drill branch and a production copy present', () => {
    const r = run({ '.env.drill.local': `DRILL_DATABASE_URL="${DRILL_POOLED}"\n`, '.env.production.local': `DATABASE_URL="${PROD_DIRECT}"\n`, '.env': `DATABASE_URL="${LOCAL}"\n` });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No connection made/);
    noSecrets(r);
  });
  test('exits 4 when .env.production.local is absent (fails closed)', () => {
    const r = run({ '.env.drill.local': `DRILL_DATABASE_URL=${DRILL_DIRECT}\n` });
    assert.equal(r.status, 4);
    noSecrets(r);
  });
  test('exits 3 when the drill host is the production host', () => {
    const r = run({ '.env.drill.local': `DRILL_DATABASE_URL=${PROD_POOLED}\n`, '.env.production.local': `export DATABASE_URL='${PROD_DIRECT}'\n` });
    assert.equal(r.status, 3);
    noSecrets(r);
  });
  test('exits 3 when the drill host is DATABASE_URL in .env', () => {
    const r = run({ '.env.drill.local': `DRILL_DATABASE_URL=${DRILL_DIRECT}\n`, '.env.production.local': `DATABASE_URL=${PROD_DIRECT}\n`, '.env': `DATABASE_URL=${DRILL_POOLED}\n` });
    assert.equal(r.status, 3);
    noSecrets(r);
  });
  test('exits 3 when the drill host is DATABASE_URL in the environment', () => {
    const r = run({ '.env.drill.local': `DRILL_DATABASE_URL=${DRILL_DIRECT}\n`, '.env.production.local': `DATABASE_URL=${PROD_DIRECT}\n` }, { DATABASE_URL: DRILL_DIRECT });
    assert.equal(r.status, 3);
    noSecrets(r);
  });
  test('exits 2 when .env.drill.local is missing', () => {
    const r = run({ '.env.production.local': `DATABASE_URL=${PROD_DIRECT}\n` });
    assert.equal(r.status, 2);
  });
  // The backup drill must run THIS verifier (the reviewed checkout's), never an older copy: it names
  // itself first, and refuses a redirecting URL even when started from another working directory.
  test('names itself (rev 2) and refuses a host query parameter when run from any working directory', () => {
    const r = run({ '.env.drill.local': `DRILL_DATABASE_URL=${DRILL_DIRECT}&host=ep-prod-aaa111.c-1.us-east-2.aws.example.tech\n`, '.env.production.local': `DATABASE_URL=${PROD_DIRECT}\n` });
    assert.equal(r.status, 3);
    assert.equal(r.stdout.split(/\r?\n/)[0], `verifier: ${VERIFIER}`);
    assert.match(VERIFIER, /rev 2 \(hardened target guard\)/);
    noSecrets(r);
  });
  test('refuses an unknown --baseline before reading any target (exit 2)', () => {
    const r = spawnSync(process.execPath, [script, '--baseline', 'main'], { cwd: mkdtempSync(join(tmpdir(), 'drill-guard-')), encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--baseline must be one of: pre-phase1/);
  });
});

describe('expected state — derived from this checkout only', () => {
  const full = expectedState(REPO_ROOT, null);
  const base = expectedState(REPO_ROOT, 'pre-phase1');
  const phase1Sql = readdirSync(join(REPO_ROOT, 'prisma/migrations')).filter((d) => PHASE1.test(d))
    .map((d) => readFileSync(join(REPO_ROOT, 'prisma/migrations', d, 'migration.sql'), 'utf8'));

  test('default: every migration and model of this checkout', () => {
    assert.equal(full.migrations.filter((m) => PHASE1.test(m)).length, 14);
    assert.equal(full.migrations.length, base.migrations.length + 14);
  });
  test('pre-phase1 = production main: 17 migrations ending with 20261120000000_email_html_body, 46 models', () => {
    assert.equal(base.migrations.length, 17);
    assert.equal(base.migrations.at(-1), '20261120000000_email_html_body');
    assert.equal(base.migrations.some((m) => PHASE1.test(m)), false);
    assert.equal(base.models.length, 46);
  });
  test('the subtraction is exact: Phase 1 never drops or renames a table, and every table it creates is a model', () => {
    // Schema tables are always quoted in the migrations; M8's unquoted temporary table does not count.
    for (const sql of phase1Sql) assert.doesNotMatch(sql, /DROP TABLE (IF EXISTS )?(public\.)?"|ALTER TABLE (public\.)?"\w+" RENAME TO/);
    const created = [...new Set(phase1Sql.flatMap((s) => [...s.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])))].sort();
    assert.deepEqual(full.models.filter((m) => !base.models.includes(m)).sort(), created);
  });
  test('the checkout is the one the script belongs to, not the working directory', () => {
    assert.equal(resolve(REPO_ROOT), resolve(import.meta.dirname, '..'));
  });
});
