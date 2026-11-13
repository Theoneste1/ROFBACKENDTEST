// node --test scripts/release/rehearsal.test.mjs — pure helpers of the rehearsal runner (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { endpointId, segments, rollbackFiles, childEnv, PHASE1, M9_M14_TABLES, M9_M14_ENUMS } from './rehearsal.mjs';

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
