import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREFIX, plan, checkRequest } from './staging-accounts.mjs';

const branch = 'postgresql://staging:pw@ep-branch-123-pooler.eu-central-1.aws.neon.tech/neondb';
const ok = { ok: true, url: branch.replace('-pooler', ''), pooled: true };

test('plan: one Administrator and one student without a date of birth, synthetic names and .invalid e-mail only', () => {
  const [admin, student] = plan('abc123', 'div-1');
  assert.equal(admin.role, 'ADMIN');
  assert.equal(student.role, 'STUDENT');
  assert.equal(student.divisionId, 'div-1');
  assert.equal('dateOfBirth' in student, false);
  for (const a of [admin, student]) {
    assert.ok(a.username.startsWith(PREFIX));
    assert.match(a.email, /^staging\.drill\.[a-z]+-abc123@staging\.invalid$/);
  }
});

test('checkRequest: unknown command, a failed guard and a wrong or missing --confirm are refused', () => {
  assert.equal(checkRequest('drop', ['--confirm', 'ep-branch-123'], ok).ok, false);
  assert.deepEqual(checkRequest('create', ['--confirm', 'ep-branch-123'], { ok: false, code: 3, reason: 'REFUSED: production' }),
    { ok: false, code: 3, reason: 'REFUSED: production' });
  assert.equal(checkRequest('create', [], ok).code, 3);
  assert.equal(checkRequest('create', ['--confirm', 'ep-production-1'], ok).code, 3);
  assert.equal(checkRequest('create', ['--confirm', 'EP-BRANCH-123'], ok).ok, true);
  assert.equal(checkRequest('disable', ['--confirm', 'ep-branch-123'], ok).ok, true);
});

test('the command refuses (fail-closed) without the production configuration, before connecting anywhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-accounts-'));
  try {
    writeFileSync(join(dir, '.env.drill.local'), `DRILL_DATABASE_URL=${branch}\n`);
    const script = new URL('./staging-accounts.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const r = spawnSync(process.execPath, [script, 'create', '--confirm', 'ep-branch-123'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /production host unknown/);
    assert.equal(existsSync(join(dir, '.env.staging-accounts.local')), false);
    assert.doesNotMatch(r.stdout + r.stderr, /pw@/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the command refuses the production host even with a matching --confirm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-accounts-'));
  try {
    const prod = 'postgresql://owner:secret@ep-prod-9.eu-central-1.aws.neon.tech/neondb';
    writeFileSync(join(dir, '.env.drill.local'), `DRILL_DATABASE_URL=${prod}\n`);
    writeFileSync(join(dir, '.env.production.local'), `DATABASE_URL=${prod}\n`);
    const script = new URL('./staging-accounts.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const r = spawnSync(process.execPath, [script, 'create', '--confirm', 'ep-prod-9'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /REFUSED: the drill host is the production host/);
    assert.doesNotMatch(r.stdout + r.stderr, /secret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
