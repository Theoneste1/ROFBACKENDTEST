#!/usr/bin/env node
/**
 * Generates the API documentation from the compiled application, so it always
 * matches the code:
 *
 *   docs/api/openapi.json                     OpenAPI 3 specification (with x-roles)
 *   docs/api/ROF-LMS.postman_collection.json  Postman collection (v2.1)
 *   docs/API.md                               Endpoint reference
 *   docs/AUTHORIZATION.md                     Authorization matrix
 *
 * Usage:  npm run docs:api      (builds first: the Swagger plugin reads DTOs at build time)
 *
 * The application is created in memory only to read its routes — it does not
 * listen, connect to the database or start background jobs.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';           // main.js must not start a server
process.env.WORKERS_ENABLED = 'false';
process.env.JWT_SECRET ??= 'x'.repeat(48);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import(toUrl('dist/app/app.module.js'));
const { configureApp } = await import(toUrl('dist/main.js'));
const { buildOpenApiDocument } = await import(toUrl('dist/openapi.js'));

function toUrl(rel) {
  const p = join(root, rel).replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(p) ? `file:///${p}` : `file://${p}`;
}

const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
configureApp(app);
const doc = buildOpenApiDocument(app);
await app.close().catch(() => {});

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const ops = [];
for (const [path, item] of Object.entries(doc.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (op) ops.push({ path, method, op, tag: op.tags?.[0] ?? 'Other' });
  }
}
ops.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
const tags = [...new Set(ops.map((o) => o.tag))];

// ─── OpenAPI ──────────────────────────────────────────────────────────────────
mkdirSync(join(root, 'docs/api'), { recursive: true });
writeFileSync(join(root, 'docs/api/openapi.json'), JSON.stringify(doc, null, 2) + '\n');

// ─── Schema helpers ───────────────────────────────────────────────────────────
const resolve = (s) => (s?.$ref ? doc.components.schemas[s.$ref.split('/').pop()] : s);

function example(schema, name = '', depth = 0) {
  const s = resolve(schema) ?? {};
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined && depth > 0) return s.default;
  if (s.enum) return s.enum[0];
  if (s.allOf) return example(s.allOf[0], name, depth);
  if (s.oneOf || s.anyOf) return example((s.oneOf ?? s.anyOf)[0], name, depth);
  switch (s.type) {
    case 'integer': case 'number': return s.minimum ?? 1;
    case 'boolean': return true;
    case 'array':   return depth > 3 ? [] : [example(s.items, name, depth + 1)];
    case 'object':
    case undefined: {
      if (!s.properties) return {};
      if (depth > 3) return {};
      const required = new Set(s.required ?? []);
      const keys = Object.keys(s.properties).filter((k) => required.size === 0 || required.has(k));
      return Object.fromEntries(keys.map((k) => [k, example(s.properties[k], k, depth + 1)]));
    }
    case 'string': {
      if (s.format === 'uuid' || /Id$/.test(name)) return '00000000-0000-4000-8000-000000000000';
      if (s.format === 'date-time') return '2026-12-01T09:00:00.000Z';
      if (s.format === 'email' || /email/i.test(name)) return 'name@example.org';
      if (s.format === 'binary') return '';
      if (/password/i.test(name)) return 'Str0ng!Passw0rd';
      if (/url/i.test(name)) return 'https://meet.google.com/abc-defg-hij';
      if (s.pattern === '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$') return '2026-12-01';
      return s.minLength && s.minLength > 3 ? `${name || 'text'} `.repeat(Math.ceil(s.minLength / (name.length + 1) + 1)).trim() : (name || 'text');
    }
    default: return null;
  }
}

function fields(schema) {
  const s = resolve(schema);
  if (!s?.properties) return [];
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties).map(([k, p]) => {
    const r = resolve(p) ?? {};
    const type = r.enum ? r.enum.join(' \\| ') : r.type === 'array' ? `${resolve(r.items)?.type ?? 'object'}[]` : (r.format ? `${r.type} (${r.format})` : r.type ?? 'object');
    return { name: k, type, required: required.has(k), description: (r.description ?? '').replace(/\n+/g, ' ') };
  });
}

const bodyOf = (op) => {
  const c = op.requestBody?.content ?? {};
  if (c['multipart/form-data']) return { kind: 'multipart', schema: c['multipart/form-data'].schema };
  if (c['application/json']) return { kind: 'json', schema: c['application/json'].schema };
  return null;
};
const roles = (op) => op['x-roles'] ?? ['STUDENT', 'MENTOR', 'ADMIN'];
const firstPara = (text = '') => text.replace(/^\*\*Access:\*\*[^\n]*\n*/, '').split(/\n\n/)[0].replace(/\n/g, ' ').trim();
const anchor = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const generated = `<!-- Generated by scripts/generate-api-docs.mjs from the code. Do not edit by hand: run \`npm run docs:api\`. -->`;

// ─── Authorization matrix ─────────────────────────────────────────────────────
{
  const tick = (op, role) => (roles(op).includes('PUBLIC') || roles(op).includes(role) ? '✓' : '');
  const lines = [
    '# Authorization matrix', '', generated, '',
    'Who may call each endpoint, read from the `@Roles` / `@Public` metadata the guards enforce',
    '(`JwtAuthGuard` → `RolesGuard`). A ✓ means the role passes the role check; the',
    'service then applies record-level rules:', '',
    '| Rule | Applies to |',
    '|---|---|',
    '| Students act only on their own records (submissions, results, notifications, profile) | submissions, results, notifications, me/* |',
    '| Students see only their own division, in published courses | courses, resources, assignments, threads, live sessions |',
    '| Mentors see and change only their assigned course × division scopes | assignments, resources, threads, live sessions, analytics |',
    '| Mentors see only submissions currently assigned to them; only the assigned mentor grades | submissions, reviews |',
    '| Administrators manage the workflow but cannot grade or write academic feedback | mark / review endpoints are MENTOR-only |',
    '| Unpublished, hidden or other people\'s records answer 404 (not 403), so their existence is not revealed | everywhere |',
    '',
    `Totals: ${ops.length} endpoints — ${ops.filter((o) => roles(o.op).includes('PUBLIC')).length} public, ` +
      `${ops.filter((o) => roles(o.op).length === 1 && roles(o.op)[0] === 'ADMIN').length} administrator-only.`,
    '',
  ];
  for (const tag of tags) {
    lines.push(`## ${tag}`, '', '| Method | Path | Public | Student | Mentor | Admin |', '|---|---|:-:|:-:|:-:|:-:|');
    for (const { path, method, op } of ops.filter((o) => o.tag === tag)) {
      const pub = roles(op).includes('PUBLIC') ? '✓' : '';
      lines.push(`| ${method.toUpperCase()} | \`${path}\` | ${pub} | ${tick(op, 'STUDENT')} | ${tick(op, 'MENTOR')} | ${tick(op, 'ADMIN')} |`);
    }
    lines.push('');
  }
  writeFileSync(join(root, 'docs/AUTHORIZATION.md'), lines.join('\n'));
}

// ─── Endpoint reference ───────────────────────────────────────────────────────
{
  const lines = [
    '# API reference', '', generated, '',
    `Base URL: \`/api/v1\` (the health check is \`/health\`). ${ops.length} endpoints.`,
    'Interactive documentation: `/api/docs` (Swagger UI, not in production unless `SWAGGER_ENABLED=true`).',
    'Machine-readable: [`docs/api/openapi.json`](api/openapi.json); Postman: [`docs/api/ROF-LMS.postman_collection.json`](api/ROF-LMS.postman_collection.json).',
    '',
    '**Conventions.** Send `Authorization: Bearer <access_token>` (from `POST /api/v1/auth/login`).',
    'Lists return `{ data, meta: { total, page, limit, totalPages } }` with `?page=&limit=` (max 100).',
    'Errors return `{ statusCode, error, code, message, details?, requestId }`; branch on `code`.',
    'Unknown body or query fields are rejected (`VALIDATION_FAILED`).',
    '',
    '## Contents', '',
    ...tags.map((t) => `- [${t}](#${anchor(t)}) (${ops.filter((o) => o.tag === t).length})`),
    '',
  ];
  for (const tag of tags) {
    lines.push(`## ${tag}`, '');
    for (const { path, method, op } of ops.filter((o) => o.tag === tag)) {
      lines.push(`### ${method.toUpperCase()} \`${path}\``, '');
      const who = roles(op).includes('PUBLIC') ? 'Public' : roles(op).join(', ');
      lines.push(`**Access:** ${who}`, '');
      const summary = op.summary || firstPara(op.description);
      if (summary) lines.push(summary, '');
      const params = (op.parameters ?? []).filter((p) => p.in === 'path' || p.in === 'query');
      if (params.length) {
        lines.push('| Parameter | In | Type | Required | Notes |', '|---|---|---|:-:|---|');
        for (const p of params) {
          const sch = resolve(p.schema) ?? {};
          const type = sch.enum ? sch.enum.join(' \\| ') : sch.type ?? 'string';
          lines.push(`| \`${p.name}\` | ${p.in} | ${type} | ${p.required ? '✓' : ''} | ${(p.description ?? '').replace(/\n+/g, ' ')} |`);
        }
        lines.push('');
      }
      const body = bodyOf(op);
      if (body) {
        const f = fields(body.schema);
        if (f.length) {
          lines.push(`Body (${body.kind === 'multipart' ? 'multipart/form-data' : 'JSON'}):`, '', '| Field | Type | Required | Notes |', '|---|---|:-:|---|');
          for (const x of f) lines.push(`| \`${x.name}\` | ${x.type} | ${x.required ? '✓' : ''} | ${x.description} |`);
          lines.push('');
        }
      }
    }
  }
  writeFileSync(join(root, 'docs/API.md'), lines.join('\n'));
}

// ─── Postman collection ───────────────────────────────────────────────────────
{
  const toPostmanPath = (p) => p.replace(/^\//, '').replace(/\{([^}]+)\}/g, ':$1');
  const item = (path, method, op) => {
    const isPublic = roles(op).includes('PUBLIC');
    const urlPath = toPostmanPath(path).replace(/^api\/v1\//, '');
    const params = op.parameters ?? [];
    const request = {
      method: method.toUpperCase(),
      ...(isPublic && { auth: { type: 'noauth' } }),
      header: [],
      url: {
        raw: path.startsWith('/api/v1') ? `{{baseUrl}}/${urlPath}` : `{{host}}/${urlPath}`,
        host: [path.startsWith('/api/v1') ? '{{baseUrl}}' : '{{host}}'],
        path: urlPath.split('/'),
        variable: params.filter((p) => p.in === 'path').map((p) => ({ key: p.name, value: '' , description: p.description ?? '' })),
        query: params.filter((p) => p.in === 'query').map((p) => ({
          key: p.name, value: String(example(p.schema, p.name) ?? ''), disabled: !p.required, description: p.description ?? '',
        })),
      },
      description: (op.description ?? '').trim(),
    };
    const body = bodyOf(op);
    if (body?.kind === 'json') {
      request.header.push({ key: 'Content-Type', value: 'application/json' });
      request.body = { mode: 'raw', raw: JSON.stringify(example(body.schema), null, 2), options: { raw: { language: 'json' } } };
    } else if (body?.kind === 'multipart') {
      const s = resolve(body.schema) ?? {};
      request.body = {
        mode: 'formdata',
        formdata: Object.entries(s.properties ?? {}).map(([k, p]) => {
          const r = resolve(p) ?? {};
          const isFile = r.format === 'binary' || (r.type === 'array' && resolve(r.items)?.format === 'binary');
          return isFile ? { key: k, type: 'file', src: [] } : { key: k, type: 'text', value: String(example(r, k) ?? '') };
        }),
      };
    }
    const entry = { name: `${method.toUpperCase()} ${path.replace(/^\/api\/v1/, '')}`, request };
    if (op.operationId === 'AuthController_login') {
      entry.event = [{
        listen: 'test',
        script: { type: 'text/javascript', exec: [
          'const body = pm.response.json();',
          'if (body.access_token) pm.collectionVariables.set("accessToken", body.access_token);',
        ] },
      }];
      request.body = { mode: 'raw', raw: JSON.stringify({ username: '{{username}}', password: '{{password}}' }, null, 2), options: { raw: { language: 'json' } } };
    }
    return entry;
  };

  const collection = {
    info: {
      name: 'ROF LMS API',
      description:
        'Generated from the code (scripts/generate-api-docs.mjs). Set `username` and `password`, run Auth → POST /auth/login ' +
        '(it stores the access token), then call any request. Each request description states who may call it.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    variable: [
      { key: 'host', value: 'http://localhost:3000' },
      { key: 'baseUrl', value: 'http://localhost:3000/api/v1' },
      { key: 'username', value: 'admin' },
      { key: 'password', value: '' },
      { key: 'accessToken', value: '' },
    ],
    item: tags.map((tag) => ({ name: tag, item: ops.filter((o) => o.tag === tag).map((o) => item(o.path, o.method, o.op)) })),
  };
  writeFileSync(join(root, 'docs/api/ROF-LMS.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
}

// ─── Route list (for the coverage check) ──────────────────────────────────────
writeFileSync(join(root, 'docs/api/routes.json'), JSON.stringify(ops.map((o) => ({ method: o.method.toUpperCase(), path: o.path, roles: roles(o.op), tag: o.tag })), null, 2) + '\n');

console.log(`API docs generated: ${ops.length} endpoints in ${tags.length} groups.`);
process.exit(0);
