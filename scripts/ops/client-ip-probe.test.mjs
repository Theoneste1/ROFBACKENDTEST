// The client-address probe (scripts/ops/client-ip-probe.mjs), run as it is deployed: a child process with only PORT
// set, called over HTTP. Checks the response shape, the echoed header allowlist (incl. the cf-ray / x-nf-request-id
// hop markers), that sensitive headers are never echoed, and that nothing is logged per request or written to disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE = fileURLToPath(new URL('./client-ip-probe.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let child; let port; let stdout = ''; let stderr = '';
let rootBefore;

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const snapshot = (dir) => readdirSync(dir).filter((f) => f !== 'node_modules' && f !== '.git').map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).sort().join('|');
const call = (path, headers = {}, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, headers });

before(async () => {
  port = await freePort();
  rootBefore = snapshot(ROOT);
  child = spawn(process.execPath, [PROBE], { env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  for (let i = 0; i < 100 && !stdout.includes('client-ip probe on'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(stdout, /client-ip probe on :\d+/);
});
after(() => { child?.kill(); });

test('response fields and headers are unchanged: path, socketAddress, headers, reqIp (5 candidates); JSON, no-store', async () => {
  const r = await call('/api/v1/probe');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.deepEqual(Object.keys(body), ['path', 'socketAddress', 'headers', 'reqIp']);
  assert.equal(body.path, '/api/v1/probe');
  assert.deepEqual(body.headers, {});
  assert.deepEqual(Object.keys(body.reqIp), ['TRUST_PROXY=1', 'TRUST_PROXY=2', 'TRUST_PROXY=3', 'TRUST_PROXY=false', 'TRUST_PROXY=true']);
});

test('the hop markers cf-ray and x-nf-request-id are echoed when present, and absent otherwise', async () => {
  const withMarkers = await (await call('/x', { 'CF-Ray': '8f1c2d3e4a5b6c7d-JNB', 'X-Nf-Request-Id': '01JABCDEF0123456789XYZ' })).json();
  assert.equal(withMarkers.headers['cf-ray'], '8f1c2d3e4a5b6c7d-JNB');
  assert.equal(withMarkers.headers['x-nf-request-id'], '01JABCDEF0123456789XYZ');
  const without = await (await call('/x')).json();
  assert.equal('cf-ray' in without.headers, false);
  assert.equal('x-nf-request-id' in without.headers, false);
});

test('only allowlisted headers are echoed: cookies, authorization and other sensitive headers never are', async () => {
  const body = await (await call('/x', {
    Authorization: 'Bearer secret-token-value', Cookie: 'rof_refresh=secret-cookie-value', 'Proxy-Authorization': 'Basic c2VjcmV0',
    'X-Api-Key': 'secret-api-key', 'X-Forwarded-For': '6.6.6.6, 7.7.7.7', 'CF-Connecting-IP': '8.8.8.8', 'CF-Ray': 'abc-JNB',
  })).json();
  assert.deepEqual(Object.keys(body.headers).sort(), ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for']);
  assert.doesNotMatch(JSON.stringify(body), /secret|Bearer|rof_refresh|c2VjcmV0/);
  // The TRUST_PROXY candidates still resolve as before (hop counts from the right).
  assert.equal(body.reqIp['TRUST_PROXY=1'], '7.7.7.7');
  assert.equal(body.reqIp['TRUST_PROXY=2'], '6.6.6.6');
});

test('any method and path get the same JSON answer (POST included); nothing is logged per request; nothing is written', async () => {
  const r = await call('/anything?x=%3Cscript%3E', { 'X-Nf-Request-Id': 'abc' }, 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal((await r.json()).path, '/anything?x=%3Cscript%3E');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stdout.trim().split('\n').length, 1, 'only the start-up line');
  assert.doesNotMatch(stdout, /6\.6\.6\.6|8\.8\.8\.8|abc|secret/);
  assert.equal(stderr, '');
  assert.equal(snapshot(ROOT), rootBefore, 'no file created or changed in the checkout root');
});
