#!/usr/bin/env node
/**
 * Lists API routes that no end-to-end test calls.
 *
 * Reads docs/api/routes.json (written by `npm run docs:api`) and every HTTP
 * call in test/*.e2e-spec.ts (`.get('/api/v1/…')`, `.post(\`…${id}…\`)`, …),
 * and reports each route without a matching call. Exit code 1 when any route
 * is uncovered, so CI can enforce it.
 *
 * Usage:  npm run test:coverage:routes
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const routes = JSON.parse(readFileSync(join(root, 'docs/api/routes.json'), 'utf8'));

const calls = [];
for (const file of readdirSync(join(root, 'test')).filter((f) => f.endsWith('.e2e-spec.ts'))) {
  const text = readFileSync(join(root, 'test', file), 'utf8');
  // .get('/api/v1/x') | .post(`/api/v1/x/${id}`) | get(`/admin/...`) via local helpers that prefix /api/v1
  // A path may start with a helper expression, e.g. `${base()}/${id}/restore`.
  const re = /\.(get|post|put|patch|delete)\(\s*(['`])((?:\/api\/v1)?\/[^'`]*|\$\{[^}]+\}\/[^'`]*)\2/g;
  for (const m of text.matchAll(re)) {
    let path = m[3].replace(/\$\{[^}]+\}/g, 'X').split('?')[0];
    if (!path.startsWith('/api/v1') && !path.startsWith('X') && path !== '/health') path = `/api/v1${path}`;
    calls.push({ method: m[1].toUpperCase(), path, file });
  }
  // Paths passed to local helpers, e.g. get('/admin/reports/students') or a list of paths in a loop.
  for (const m of text.matchAll(/['`](\/(?:api\/v1\/)?(?:admin|me|notifications|live-sessions|submissions|assignments|courses|threads|comments|support)[^'`]*)['`]/g)) {
    const path = m[1].replace(/\$\{[^}]+\}/g, 'X').split('?')[0];
    calls.push({ method: '*', path: path.startsWith('/api/v1') ? path : `/api/v1${path}`, file });
  }
}

const escape = (p) => p.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
// Route parameters ({id}) match any segment of a test path; a test's `${…}` (X) matches any text in a route.
const routeRx = (p) => new RegExp('^' + escape(p).replace(/\{[^}]+\}/g, '[^/]+') + '$');
// A leading X (a helper expression) stands for any prefix of the path.
const callRx  = (p) => new RegExp('^' + escape(p).replace(/^X/, '\u0000').replace(/X/g, '[^/]*').replace('\u0000', '.*') + '$');
const uncovered = routes.filter((r) => {
  const rx = routeRx(r.path);
  const literal = r.path.replace(/\{[^}]+\}/g, 'id');
  return !calls.some((c) => (c.method === r.method || c.method === '*') && (rx.test(c.path) || callRx(c.path).test(literal)));
});

console.log(`${routes.length - uncovered.length}/${routes.length} routes are called by the e2e tests.`);
for (const r of uncovered) console.log(`  not covered: ${r.method.padEnd(6)} ${r.path}  [${r.roles.join(', ')}]`);
process.exit(uncovered.length ? 1 : 0);
