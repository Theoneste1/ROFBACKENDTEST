// node --test scripts/release/rehearsal.test.mjs — pure helpers of the rehearsal runner (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { endpointId, segments, rollbackFiles, PHASE1 } from './rehearsal.mjs';

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
