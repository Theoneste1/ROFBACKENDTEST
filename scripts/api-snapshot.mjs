#!/usr/bin/env node
/**
 * API snapshot: a stable, comparable record of the public API contract.
 *
 *   node scripts/api-snapshot.mjs write <file> [--openapi <openapi.json>]
 *   node scripts/api-snapshot.mjs compare <baseline> [--openapi <openapi.json>] [--strict] [--strict-review]
 *
 * `write` records the contract of an OpenAPI document (default
 * docs/api/openapi.json — run `npm run docs:api` first). `compare` diffs the
 * current document against a saved snapshot and classifies every change:
 *
 *   BREAKING  an existing client can fail: removed operation/status/content type,
 *             changed operation ID, narrowed roles, public → protected, new
 *             required request field or parameter, removed request field or
 *             parameter (the API rejects unknown fields), incompatible type,
 *             removed or newly restricted request enum values, tightened request
 *             constraints, removed response field (at any depth, through arrays
 *             and $refs), response field that may now be null or absent…
 *   REVIEW    possibly breaking, needs a human decision: response enum gains a
 *             value, union (anyOf/oneOf) gains a variant, response field no
 *             longer always present, operation becomes public, response format
 *             removed.
 *   ADDITIVE  backward compatible: new operations/fields/optional parameters,
 *             loosened request rules, extra enum values accepted…
 *
 * --strict exits 1 on any BREAKING change; --strict-review also on REVIEW.
 * Limitations are documented in docs/baseline/BASELINE-2026-11-08.md §5.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_VERSION = 2;
const DEFAULT_OPENAPI = 'docs/api/openapi.json';
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const CONSTRAINTS = ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'minItems', 'maxItems'];

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/** Normalised, order-independent shape of a JSON schema. */
export function shapeOf(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.$ref) return { ref: schema.$ref.split('/').pop() };
  const base = {};
  if (schema.nullable) base.nullable = true;
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[k])) return { ...base, [k]: schema[k].map(shapeOf) };
  }
  if (schema.type === 'array' || schema.items) {
    return { ...base, type: 'array', items: shapeOf(schema.items), ...pick(schema, ['minItems', 'maxItems']) };
  }
  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties ?? {};
    return {
      ...base,
      type: 'object',
      required: [...(schema.required ?? [])].sort(),
      properties: Object.fromEntries(Object.keys(props).sort().map((p) => [p, shapeOf(props[p])])),
      ...(schema.additionalProperties !== undefined && {
        additionalProperties: typeof schema.additionalProperties === 'object' ? shapeOf(schema.additionalProperties) : !!schema.additionalProperties,
      }),
    };
  }
  return {
    ...base,
    type: schema.type ?? 'any',
    ...(schema.format && { format: schema.format }),
    ...(schema.enum && { enum: [...schema.enum].map(String).sort() }),
    ...pick(schema, CONSTRAINTS),
  };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

function contentShape(content) {
  if (!content) return null;
  return Object.fromEntries(Object.keys(content).sort().map((t) => [t, shapeOf(content[t].schema)]));
}

export function buildSnapshot(doc) {
  const operations = [];
  for (const path of Object.keys(doc.paths ?? {}).sort()) {
    for (const method of Object.keys(doc.paths[path]).sort()) {
      const op = doc.paths[path][method];
      if (!op || typeof op !== 'object' || !op.responses) continue;
      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        operationId: op.operationId ?? null,
        tags: [...(op.tags ?? [])].sort(),
        roles: [...(op['x-roles'] ?? [])].sort(),
        public: Array.isArray(op.security) && op.security.length === 0,
        parameters: (op.parameters ?? [])
          .map((p) => ({ name: p.name, in: p.in, required: !!p.required, schema: shapeOf(p.schema) }))
          .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`)),
        requestBody: op.requestBody ? { required: !!op.requestBody.required, content: contentShape(op.requestBody.content) } : null,
        responses: Object.fromEntries(Object.keys(op.responses).sort().map((s) => [s, contentShape(op.responses[s].content)])),
      });
    }
  }
  const schemas = Object.fromEntries(Object.keys(doc.components?.schemas ?? {}).sort().map((n) => [n, shapeOf(doc.components.schemas[n])]));
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    api: { title: doc.info?.title, version: doc.info?.version, openapi: doc.openapi },
    counts: { operations: operations.length, paths: Object.keys(doc.paths ?? {}).length, schemas: Object.keys(schemas).length },
    fingerprint: sha({ operations, schemas }),
    operations,
    schemas,
  };
}

// ─── Comparison ───────────────────────────────────────────────────────────────

class Report {
  breaking = [];
  review = [];
  additive = [];
  add(kind, where, message) {
    this[kind].push(`${where}: ${message}`);
  }
}

/** Schema kind used to detect incompatible type changes. */
function kindOf(s) {
  if (!s) return 'none';
  if (s.anyOf || s.oneOf) return 'union';
  if (s.allOf) return 'allOf';
  return s.type ?? 'any';
}

function resolve(s, schemas, seen) {
  let cur = s, guard = 0;
  while (cur?.ref && guard++ < 50) {
    if (seen) seen.add(cur.ref);
    cur = schemas[cur.ref] ?? { type: 'missing-ref', ref: cur.ref };
  }
  return cur;
}

/**
 * Compare two schema shapes in a direction:
 *   'request'  — the client sends data that must still be accepted;
 *   'response' — the client reads data whose shape must still hold.
 */
function diffSchema(b, c, ctx, where) {
  if (!b && !c) return;
  if (b?.ref && c?.ref) {
    const recursionKey = `${ctx.dir}|${b.ref}|${c.ref}`;
    if (ctx.stack.has(recursionKey)) return; // recursive schema: this pair is already being compared
    ctx.stack.add(recursionKey);
    try { diffResolved(resolve(b, ctx.bSchemas), resolve(c, ctx.cSchemas), ctx, where); } finally { ctx.stack.delete(recursionKey); }
    return;
  }
  diffResolved(resolve(b, ctx.bSchemas), resolve(c, ctx.cSchemas), ctx, where);
}

function diffResolved(b, c, ctx, where) {
  const { r, dir } = ctx;
  const req = dir === 'request';
  if (!b && c) { r.add('additive', where, 'schema added'); return; }
  if (b && !c) { r.add('breaking', where, 'schema removed'); return; }
  if (c.type === 'missing-ref') { r.add('breaking', where, `references a missing schema "${c.ref}"`); return; }

  // Nullability
  if (!!b.nullable !== !!c.nullable) {
    if (req) r.add(b.nullable ? 'breaking' : 'additive', where, b.nullable ? 'null no longer accepted' : 'null now accepted');
    else r.add(c.nullable ? 'breaking' : 'additive', where, c.nullable ? 'may now be null' : 'no longer null');
  }

  // Type / kind
  const kb = kindOf(b), kc = kindOf(c);
  if (kb !== kc) {
    if (kb === 'any') r.add(req ? 'breaking' : 'additive', where, `type narrowed from any to ${kc}`);
    else if (kc === 'any') r.add(req ? 'additive' : 'breaking', where, `type widened from ${kb} to any`);
    else if (req && kb === 'integer' && kc === 'number') r.add('additive', where, 'integer widened to number');
    else r.add('breaking', where, `type changed from ${kb} to ${kc}`);
    return; // children are not comparable after a kind change
  }

  if (kb === 'union') return diffUnion(b, c, ctx, where);
  if (kb === 'allOf') {
    if (JSON.stringify(b.allOf) !== JSON.stringify(c.allOf)) r.add('review', where, 'allOf composition changed');
    return;
  }
  if (kb === 'array') {
    diffConstraints(b, c, ctx, where);
    return diffSchema(b.items, c.items, ctx, `${where}[]`);
  }
  if (kb === 'object') return diffObject(b, c, ctx, where);

  // Scalars: format, enum, constraints
  if (b.format !== c.format) {
    if (b.format && c.format) r.add('breaking', where, `format changed from ${b.format} to ${c.format}`);
    else if (c.format) r.add(req ? 'breaking' : 'additive', where, `format ${c.format} added`);
    else r.add(req ? 'additive' : 'review', where, `format ${b.format} removed`);
  }
  diffEnum(b, c, ctx, where);
  diffConstraints(b, c, ctx, where);
}

function diffEnum(b, c, { r, dir }, where) {
  const req = dir === 'request';
  if (!b.enum && !c.enum) return;
  if (!b.enum) { r.add(req ? 'breaking' : 'additive', where, `values now restricted to [${c.enum.join(', ')}]`); return; }
  if (!c.enum) { r.add(req ? 'additive' : 'review', where, 'enum restriction removed (any value)'); return; }
  const removed = b.enum.filter((v) => !c.enum.includes(v));
  const added = c.enum.filter((v) => !b.enum.includes(v));
  if (removed.length) r.add(req ? 'breaking' : 'additive', where, `enum values removed: ${removed.join(', ')}`);
  if (added.length) r.add(req ? 'additive' : 'review', where, `enum values added: ${added.join(', ')}`);
}

function diffConstraints(b, c, { r, dir }, where) {
  if (dir !== 'request') return; // response limits are informational
  const tighter = { minLength: (o, n) => n > o, maxLength: (o, n) => n < o, minimum: (o, n) => n > o, maximum: (o, n) => n < o,
    exclusiveMinimum: (o, n) => n > o, exclusiveMaximum: (o, n) => n < o, minItems: (o, n) => n > o, maxItems: (o, n) => n < o };
  for (const k of CONSTRAINTS) {
    const o = b[k], n = c[k];
    if (o === n) continue;
    if (k === 'pattern') {
      r.add(n === undefined ? 'additive' : 'breaking', where, n === undefined ? 'pattern removed' : o === undefined ? `pattern ${n} added` : `pattern changed to ${n}`);
    } else if (o === undefined) r.add('breaking', where, `${k} ${n} added`);
    else if (n === undefined) r.add('additive', where, `${k} removed`);
    else r.add(tighter[k](o, n) ? 'breaking' : 'additive', where, `${k} ${o} → ${n}`);
  }
}

function diffObject(b, c, ctx, where) {
  const { r, dir } = ctx;
  const req = dir === 'request';
  const bp = b.properties ?? {}, cp = c.properties ?? {};
  const bReq = new Set(b.required ?? []), cReq = new Set(c.required ?? []);
  const at = (p) => (where ? `${where}.${p}` : p);

  for (const p of Object.keys(bp)) {
    if (!(p in cp)) {
      r.add('breaking', at(p), req ? 'field removed (the API rejects unknown fields)' : 'field removed');
      continue;
    }
    if (req) {
      if (!bReq.has(p) && cReq.has(p)) r.add('breaking', at(p), 'field is now required');
      if (bReq.has(p) && !cReq.has(p)) r.add('additive', at(p), 'field is now optional');
    } else {
      if (bReq.has(p) && !cReq.has(p)) r.add('review', at(p), 'field no longer always present');
      if (!bReq.has(p) && cReq.has(p)) r.add('additive', at(p), 'field now always present');
    }
    diffSchema(bp[p], cp[p], ctx, at(p));
  }
  for (const p of Object.keys(cp)) {
    if (p in bp) continue;
    if (req && cReq.has(p)) r.add('breaking', at(p), 'new required field');
    else r.add('additive', at(p), req ? 'new optional field' : 'new field');
  }
  if (req && b.additionalProperties === true && c.additionalProperties === false) {
    r.add('breaking', where || '(body)', 'additional properties no longer accepted');
  }
}

function diffUnion(b, c, { r, dir }, where) {
  const k = b.anyOf ? 'anyOf' : 'oneOf';
  const bv = new Set((b[k] ?? b.anyOf ?? b.oneOf).map((v) => JSON.stringify(v)));
  const cv = new Set((c[k] ?? c.anyOf ?? c.oneOf).map((v) => JSON.stringify(v)));
  const removed = [...bv].filter((v) => !cv.has(v)).length;
  const added = [...cv].filter((v) => !bv.has(v)).length;
  if (dir === 'request') {
    if (removed) r.add('breaking', where, `${removed} accepted variant(s) removed`);
    if (added) r.add('additive', where, `${added} accepted variant(s) added`);
  } else {
    if (added) r.add('review', where, `${added} possible variant(s) added`);
    if (removed) r.add('additive', where, `${removed} variant(s) no longer returned`);
  }
}

function diffContent(bc, cc, ctx, where, label) {
  const { r } = ctx;
  if (!bc && !cc) return;
  if (bc && !cc) { r.add('breaking', where, `${label} body removed`); return; }
  if (!bc && cc) { r.add(ctx.dir === 'request' ? 'breaking' : 'additive', where, `${label} body added`); return; }
  for (const t of Object.keys(bc)) {
    if (!(t in cc)) r.add('breaking', where, `${label} content type ${t} removed`);
    else diffSchema(bc[t], cc[t], ctx, `${where} › ${label} ${t}`);
  }
  for (const t of Object.keys(cc)) if (!(t in bc)) r.add('additive', where, `${label} content type ${t} added`);
}

export function compare(base, cur) {
  const r = new Report();
  const mk = (dir) => ({ r, dir, bSchemas: base.schemas ?? {}, cSchemas: cur.schemas ?? {}, stack: new Set() });
  const bOps = new Map(base.operations.map((o) => [o.key, o]));
  const cOps = new Map(cur.operations.map((o) => [o.key, o]));

  for (const [k, b] of bOps) {
    const c = cOps.get(k);
    if (!c) { r.add('breaking', k, 'operation removed'); continue; }
    if (b.operationId !== c.operationId) r.add('breaking', k, `operationId changed from ${b.operationId} to ${c.operationId}`);
    if (JSON.stringify(b.tags) !== JSON.stringify(c.tags)) r.add('additive', k, `tags changed to [${c.tags.join(', ')}]`);
    const lost = b.roles.filter((x) => !c.roles.includes(x)), gained = c.roles.filter((x) => !b.roles.includes(x));
    if (lost.length) r.add('breaking', k, `roles removed: ${lost.join(', ')}`);
    if (gained.length) r.add('additive', k, `roles added: ${gained.join(', ')}`);
    if (b.public !== c.public) r.add(c.public ? 'review' : 'breaking', k, c.public ? 'now public (no authentication) — security review' : 'now requires authentication');

    // Parameters
    const pk = (p) => `${p.in}:${p.name}`;
    const bp = new Map(b.parameters.map((p) => [pk(p), p])), cp = new Map(c.parameters.map((p) => [pk(p), p]));
    for (const [key, p] of bp) {
      const q = cp.get(key);
      if (!q) { r.add('breaking', k, `${p.in} parameter "${p.name}" removed`); continue; }
      if (!p.required && q.required) r.add('breaking', k, `${p.in} parameter "${p.name}" is now required`);
      if (p.required && !q.required) r.add('additive', k, `${p.in} parameter "${p.name}" is now optional`);
      diffSchema(p.schema, q.schema, mk('request'), `${k} › ${p.in} parameter ${p.name}`);
    }
    for (const [key, q] of cp) {
      if (!bp.has(key)) r.add(q.required ? 'breaking' : 'additive', k, `new ${q.required ? 'required' : 'optional'} ${q.in} parameter "${q.name}"`);
    }

    // Request body
    if (b.requestBody && c.requestBody && !b.requestBody.required && c.requestBody.required) r.add('breaking', k, 'request body is now required');
    if (!b.requestBody && c.requestBody && !c.requestBody.required) r.add('additive', k, 'optional request body added');
    else diffContent(b.requestBody?.content, c.requestBody?.content, mk('request'), k, 'request');

    // Responses
    for (const s of Object.keys(b.responses)) {
      if (!(s in c.responses)) { r.add('breaking', k, `response ${s} removed`); continue; }
      diffContent(b.responses[s], c.responses[s], mk('response'), k, `response ${s}`);
    }
    for (const s of Object.keys(c.responses)) if (!(s in b.responses)) r.add('additive', k, `response ${s} added`);
  }
  for (const k of cOps.keys()) if (!bOps.has(k)) r.add('additive', k, 'operation added');

  // Component schemas no longer defined (their uses are checked through the operations above).
  for (const n of Object.keys(base.schemas ?? {})) if (!(n in (cur.schemas ?? {}))) r.add('additive', `schema ${n}`, 'no longer defined (check uses above)');
  for (const n of Object.keys(cur.schemas ?? {})) if (!(n in (base.schemas ?? {}))) r.add('additive', `schema ${n}`, 'added');

  const uniq = (a) => [...new Set(a)].sort();
  return {
    identical: base.fingerprint === cur.fingerprint,
    versionMismatch: base.snapshotVersion !== cur.snapshotVersion,
    breaking: uniq(r.breaking),
    review: uniq(r.review),
    additive: uniq(r.additive),
  };
}

// ─── Command line (only when run directly) ────────────────────────────────────

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(argv) {
  const [cmd, file, ...rest] = argv;
  const openapi = argValue(rest, '--openapi') ?? DEFAULT_OPENAPI;
  const current = () => buildSnapshot(JSON.parse(readFileSync(openapi, 'utf8')));
  if (cmd === 'write' && file) {
    const snap = current();
    writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
    console.log(`API snapshot written to ${file}: ${snap.counts.operations} operations, ${snap.counts.paths} paths, ${snap.counts.schemas} schemas, fingerprint ${snap.fingerprint.slice(0, 16)}`);
    return 0;
  }
  if (cmd === 'compare' && file) {
    const base = JSON.parse(readFileSync(file, 'utf8'));
    const res = compare(base, current());
    if (res.versionMismatch) console.log(`Note: snapshot format v${base.snapshotVersion ?? 1} vs v${SNAPSHOT_VERSION}; regenerate the baseline snapshot with this version for an exact comparison.`);
    if (res.identical) console.log('API identical to the baseline.');
    console.log(`Breaking changes: ${res.breaking.length}`); res.breaking.forEach((l) => console.log(`  ✗ ${l}`));
    console.log(`Needs review: ${res.review.length}`); res.review.forEach((l) => console.log(`  ? ${l}`));
    console.log(`Additive changes: ${res.additive.length}`); res.additive.forEach((l) => console.log(`  + ${l}`));
    if (rest.includes('--strict') && res.breaking.length) return 1;
    if (rest.includes('--strict-review') && (res.breaking.length || res.review.length)) return 1;
    return 0;
  }
  console.error('usage: node scripts/api-snapshot.mjs write <file> [--openapi <file>] | compare <baseline> [--openapi <file>] [--strict] [--strict-review]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
