#!/usr/bin/env node
/**
 * API snapshot: a stable, comparable record of the public API contract.
 *
 *   node scripts/api-snapshot.mjs write <file>            # snapshot of docs/api/openapi.json
 *   node scripts/api-snapshot.mjs compare <baseline> [--strict]
 *        compares the current docs/api/openapi.json with a saved snapshot;
 *        --strict exits 1 when a breaking change is found.
 *
 * Regenerate the OpenAPI document first (`npm run docs:api`). The snapshot
 * records every operation (method, path, roles, public/protected, parameters,
 * request body, response statuses and schemas) and every component schema
 * (properties, types, required fields). Breaking = removed/renamed operations,
 * removed response fields, new required request fields, narrowed roles,
 * removed status codes. Additive = everything else.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const OPENAPI = 'docs/api/openapi.json';
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

function shapeOf(schema) {
  if (!schema) return null;
  if (schema.$ref) return { ref: schema.$ref.split('/').pop() };
  if (schema.type === 'array') return { array: shapeOf(schema.items) };
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    const k = schema.allOf ? 'allOf' : schema.oneOf ? 'oneOf' : 'anyOf';
    return { [k]: schema[k].map(shapeOf) };
  }
  if (schema.properties) {
    return {
      type: 'object',
      required: [...(schema.required ?? [])].sort(),
      properties: Object.fromEntries(Object.keys(schema.properties).sort().map((p) => [p, shapeOf(schema.properties[p])])),
    };
  }
  return { type: schema.type ?? 'any', ...(schema.format && { format: schema.format }), ...(schema.enum && { enum: [...schema.enum].sort() }) };
}

function contentShape(content) {
  if (!content) return null;
  return Object.fromEntries(Object.keys(content).sort().map((t) => [t, shapeOf(content[t].schema)]));
}

export function buildSnapshot(doc) {
  const operations = [];
  for (const path of Object.keys(doc.paths).sort()) {
    for (const method of Object.keys(doc.paths[path]).sort()) {
      const op = doc.paths[path][method];
      if (typeof op !== 'object' || !op.responses) continue;
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
    snapshotVersion: 1,
    api: { title: doc.info?.title, version: doc.info?.version, openapi: doc.openapi },
    counts: { operations: operations.length, paths: Object.keys(doc.paths).length, schemas: Object.keys(schemas).length },
    fingerprint: sha({ operations, schemas }),
    operations,
    schemas,
  };
}

function props(shape) {
  return shape?.properties ? Object.keys(shape.properties) : [];
}

export function compare(base, cur) {
  const breaking = [], additive = [];
  const bOps = new Map(base.operations.map((o) => [o.key, o]));
  const cOps = new Map(cur.operations.map((o) => [o.key, o]));
  for (const [k, b] of bOps) {
    const c = cOps.get(k);
    if (!c) { breaking.push(`operation removed: ${k}`); continue; }
    const lostRoles = b.roles.filter((r) => !c.roles.includes(r));
    if (lostRoles.length) breaking.push(`${k}: roles removed ${lostRoles.join(',')}`);
    const newRoles = c.roles.filter((r) => !b.roles.includes(r));
    if (newRoles.length) additive.push(`${k}: roles added ${newRoles.join(',')}`);
    if (b.public !== c.public) (c.public ? additive : breaking).push(`${k}: ${c.public ? 'now public' : 'no longer public'}`);
    for (const p of c.parameters) {
      const old = b.parameters.find((x) => x.name === p.name && x.in === p.in);
      if (!old && p.required) breaking.push(`${k}: new required ${p.in} parameter "${p.name}"`);
      else if (!old) additive.push(`${k}: new optional ${p.in} parameter "${p.name}"`);
    }
    for (const p of b.parameters) if (!c.parameters.find((x) => x.name === p.name && x.in === p.in)) breaking.push(`${k}: ${p.in} parameter "${p.name}" removed`);
    for (const s of Object.keys(b.responses)) if (!(s in c.responses)) breaking.push(`${k}: response ${s} removed`);
    for (const s of Object.keys(c.responses)) if (!(s in b.responses)) additive.push(`${k}: response ${s} added`);
    if (JSON.stringify(b.requestBody) !== JSON.stringify(c.requestBody)) additive.push(`${k}: request body changed (check schema diff below)`);
    for (const s of Object.keys(b.responses)) {
      if (s in c.responses && JSON.stringify(b.responses[s]) !== JSON.stringify(c.responses[s])) {
        const bj = b.responses[s]?.['application/json'], cj = c.responses[s]?.['application/json'];
        const lost = props(bj).filter((p) => !props(cj).includes(p));
        (lost.length ? breaking : additive).push(`${k}: response ${s} changed${lost.length ? ` — fields removed: ${lost.join(', ')}` : ''}`);
      }
    }
  }
  for (const k of cOps.keys()) if (!bOps.has(k)) additive.push(`operation added: ${k}`);
  for (const [n, b] of Object.entries(base.schemas)) {
    const c = cur.schemas[n];
    if (!c) { breaking.push(`schema removed: ${n}`); continue; }
    const lost = props(b).filter((p) => !props(c).includes(p));
    if (lost.length) breaking.push(`schema ${n}: properties removed ${lost.join(', ')}`);
    const newReq = (c.required ?? []).filter((r) => !(b.required ?? []).includes(r));
    if (newReq.length) breaking.push(`schema ${n}: newly required ${newReq.join(', ')}`);
    const added = props(c).filter((p) => !props(b).includes(p));
    if (added.length) additive.push(`schema ${n}: properties added ${added.join(', ')}`);
  }
  for (const n of Object.keys(cur.schemas)) if (!(n in base.schemas)) additive.push(`schema added: ${n}`);
  return { breaking, additive, identical: base.fingerprint === cur.fingerprint };
}

// Command line (only when run directly, not when imported).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [cmd, file, ...flags] = isMain ? process.argv.slice(2) : [];
const current = () => buildSnapshot(JSON.parse(readFileSync(OPENAPI, 'utf8')));
if (!isMain) {
  // imported as a module
} else if (cmd === 'write' && file) {
  const snap = current();
  writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
  console.log(`API snapshot written to ${file}: ${snap.counts.operations} operations, ${snap.counts.paths} paths, ${snap.counts.schemas} schemas, fingerprint ${snap.fingerprint.slice(0, 16)}`);
} else if (cmd === 'compare' && file) {
  const r = compare(JSON.parse(readFileSync(file, 'utf8')), current());
  if (r.identical) console.log('API identical to the baseline.');
  console.log(`Breaking changes: ${r.breaking.length}`); r.breaking.forEach((l) => console.log(`  ✗ ${l}`));
  console.log(`Additive changes: ${r.additive.length}`); r.additive.forEach((l) => console.log(`  + ${l}`));
  if (flags.includes('--strict') && r.breaking.length) process.exit(1);
} else {
  console.error('usage: node scripts/api-snapshot.mjs write <file> | compare <baseline> [--strict]');
  process.exit(2);
}
