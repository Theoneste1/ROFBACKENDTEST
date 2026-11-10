// Tests for scripts/api-snapshot.mjs — run: node --test scripts/api-snapshot.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, compare, shapeOf } from './api-snapshot.mjs';

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });

/** A small API that exercises refs, arrays of objects, nested refs, recursion, enums, nullability and constraints. */
function fixture() {
  return {
    openapi: '3.0.0',
    info: { title: 'Fixture', version: '1' },
    paths: {
      '/api/v1/items': {
        post: {
          operationId: 'ItemsController_create',
          tags: ['Items'],
          'x-roles': ['ADMIN', 'MENTOR'],
          security: [{ bearer: [] }],
          parameters: [{ name: 'dryRun', in: 'query', required: false, schema: { type: 'boolean' } }],
          requestBody: { required: true, ...json(ref('CreateItemDto')) },
          responses: {
            201: json({
              type: 'object',
              required: ['id', 'tags', 'owner'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] },
                score: { type: 'integer', nullable: true },
                count: { type: 'integer' },
                tags: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, weight: { type: 'number' } } } },
                owner: ref('Owner'),
              },
            }),
            400: json(ref('Error')),
          },
        },
      },
      '/api/v1/items/{id}': {
        get: {
          operationId: 'ItemsController_findOne',
          tags: ['Items'],
          'x-roles': ['STUDENT', 'ADMIN'],
          security: [{ bearer: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'view', in: 'query', required: false, schema: { type: 'string', enum: ['full', 'summary'] } },
          ],
          responses: { 200: json(ref('Owner')) },
        },
      },
    },
    components: {
      schemas: {
        CreateItemDto: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', maxLength: 100 },
            kind: { type: 'string', enum: ['NOTE', 'BOOK'] },
            count: { type: 'integer', minimum: 0 },
            note: { type: 'string', nullable: true },
            meta: { type: 'object', properties: { source: { type: 'string' } } },
          },
        },
        Owner: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, profile: ref('Profile') } },
        Profile: { type: 'object', properties: { displayName: { type: 'string' }, parent: ref('Profile') } },
        Error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  };
}

function diff(mutate) {
  const before = fixture();
  const after = structuredClone(before);
  mutate(after);
  return compare(buildSnapshot(before), buildSnapshot(after));
}
const S = (doc) => doc.components.schemas;
const createResp = (doc) => doc.paths['/api/v1/items'].post.responses[201].content['application/json'].schema;
const has = (list, ...parts) => list.some((l) => parts.every((p) => l.includes(p)));
const none = (res) => res.breaking.length === 0 && res.review.length === 0 && res.additive.length === 0;

/** Saved contract snapshots (docs/baseline). CURRENT_SNAPSHOT is the latest approved contract. */
const P0_03_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-08.json';
const P1_04_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-09-p1-04.json';
const P1_05_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-09-p1-05.json';
const P1_06_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-06.json';
const P1_08_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-08.json';
const P1_09_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-09.json';
const P1_10_SNAPSHOT = 'docs/baseline/api-snapshot-2026-11-10-p1-10.json';
const CURRENT_SNAPSHOT = P1_10_SNAPSHOT;

describe('identity', () => {
  test('identical documents produce no changes', () => {
    const res = diff(() => {});
    assert.equal(res.identical, true);
    assert.ok(none(res));
  });

  test('recursive schemas are compared without looping', () => {
    const res = diff((d) => { S(d).Profile.properties.displayName.type = 'integer'; });
    assert.ok(has(res.breaking, 'profile.displayName', 'type changed from string to integer'));
  });
});

describe('1. newly required request-body fields', () => {
  test('a new required field is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.code = { type: 'string' }; S(d).CreateItemDto.required.push('code'); });
    assert.ok(has(res.breaking, 'code', 'new required field'));
  });
  test('an existing optional field becoming required is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.required.push('kind'); });
    assert.ok(has(res.breaking, 'kind', 'now required'));
  });
  test('a new optional field is additive, not breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.code = { type: 'string' }; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'code', 'new optional field'));
  });
  test('a required field becoming optional is additive', () => {
    const res = diff((d) => { S(d).CreateItemDto.required = []; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'title', 'now optional'));
  });
});

describe('2. removed request fields and incompatible request types', () => {
  test('a removed request field is breaking', () => {
    const res = diff((d) => { delete S(d).CreateItemDto.properties.kind; });
    assert.ok(has(res.breaking, 'kind', 'field removed'));
  });
  test('a removed nested request field is breaking', () => {
    const res = diff((d) => { delete S(d).CreateItemDto.properties.meta.properties.source; });
    assert.ok(has(res.breaking, 'meta.source', 'field removed'));
  });
  test('an incompatible request type change is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.title.type = 'integer'; });
    assert.ok(has(res.breaking, 'title', 'type changed from string to integer'));
  });
  test('integer widened to number in a request is additive', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.count.type = 'number'; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'count', 'integer widened to number'));
  });
  test('a request field no longer accepting null is breaking; newly accepting null is additive', () => {
    const r1 = diff((d) => { delete S(d).CreateItemDto.properties.note.nullable; });
    assert.ok(has(r1.breaking, 'note', 'null no longer accepted'));
    const r2 = diff((d) => { S(d).CreateItemDto.properties.title.nullable = true; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'title', 'null now accepted'));
  });
  test('tightened request constraints are breaking; loosened ones are additive', () => {
    const tight = diff((d) => { S(d).CreateItemDto.properties.title.maxLength = 50; S(d).CreateItemDto.properties.count.minimum = 1; });
    assert.ok(has(tight.breaking, 'title', 'maxLength 100 → 50'));
    assert.ok(has(tight.breaking, 'count', 'minimum 0 → 1'));
    const loose = diff((d) => { S(d).CreateItemDto.properties.title.maxLength = 200; });
    assert.equal(loose.breaking.length, 0);
    assert.ok(has(loose.additive, 'title', 'maxLength 100 → 200'));
  });
  test('a request body becoming required, or being removed, is breaking', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items/{id}'].get.requestBody = { required: true, ...json({ type: 'object', properties: {} }) }; });
    assert.ok(has(r1.breaking, 'GET /api/v1/items/{id}', 'request body added'));
    const r2 = diff((d) => { delete d.paths['/api/v1/items'].post.requestBody; });
    assert.ok(has(r2.breaking, 'request body removed'));
  });
});

describe('3. removed nested response fields (arrays and refs)', () => {
  test('a field removed inside an array of objects is breaking', () => {
    const res = diff((d) => { delete createResp(d).properties.tags.items.properties.weight; });
    assert.ok(has(res.breaking, 'tags[].weight', 'field removed'));
  });
  test('a field removed inside a referenced schema is breaking', () => {
    const res = diff((d) => { delete S(d).Owner.properties.profile; });
    assert.ok(has(res.breaking, 'owner.profile', 'field removed'));
    assert.ok(has(res.breaking, 'GET /api/v1/items/{id}', 'profile', 'field removed'));
  });
  test('a field removed two refs deep is breaking', () => {
    const res = diff((d) => { delete S(d).Profile.properties.displayName; });
    assert.ok(has(res.breaking, 'owner.profile.displayName', 'field removed'));
  });
  test('a new nested response field is additive, not breaking', () => {
    const res = diff((d) => { createResp(d).properties.tags.items.properties.colour = { type: 'string' }; S(d).Owner.properties.email = { type: 'string' }; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'tags[].colour', 'new field'));
    assert.ok(has(res.additive, 'owner.email', 'new field'));
  });
  test('a response field no longer always present needs review', () => {
    const res = diff((d) => { createResp(d).required = ['id', 'tags']; });
    assert.ok(has(res.review, 'owner', 'no longer always present'));
    assert.equal(res.breaking.length, 0);
  });
  test('a removed response status or content type is breaking', () => {
    const r1 = diff((d) => { delete d.paths['/api/v1/items'].post.responses[400]; });
    assert.ok(has(r1.breaking, 'response 400 removed'));
    const r2 = diff((d) => { const c = d.paths['/api/v1/items/{id}'].get.responses[200].content; c['application/xml'] = c['application/json']; delete c['application/json']; });
    assert.ok(has(r2.breaking, 'content type application/json removed'));
  });
});

describe('4. incompatible type changes', () => {
  test('a response field type change is breaking', () => {
    const res = diff((d) => { createResp(d).properties.id.type = 'integer'; });
    assert.ok(has(res.breaking, 'response 201', '.id', 'type changed from string to integer'));
  });
  test('object ↔ array is breaking', () => {
    const res = diff((d) => { createResp(d).properties.owner = { type: 'array', items: ref('Owner') }; });
    assert.ok(has(res.breaking, 'owner', 'type changed from object to array'));
  });
  test('a response field that may now be null is breaking; no longer null is additive', () => {
    const r1 = diff((d) => { createResp(d).properties.id.nullable = true; });
    assert.ok(has(r1.breaking, '.id', 'may now be null'));
    const r2 = diff((d) => { delete createResp(d).properties.score.nullable; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'score', 'no longer null'));
  });
  test('integer → number in a response is breaking (clients may expect whole numbers)', () => {
    const res = diff((d) => { createResp(d).properties.count.type = 'number'; });
    assert.ok(has(res.breaking, 'count', 'type changed from integer to number'));
  });
  test('a changed string format is breaking', () => {
    const res = diff((d) => { createResp(d).properties.id.format = 'date-time'; });
    assert.ok(has(res.breaking, '.id', 'format changed from uuid to date-time'));
  });
  test('a parameter type change is breaking', () => {
    const res = diff((d) => { d.paths['/api/v1/items/{id}'].get.parameters[0].schema = { type: 'integer' }; });
    assert.ok(has(res.breaking, 'path parameter id', 'type changed from string to integer'));
  });
});

describe('5. enum changes', () => {
  test('a removed request enum value is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.kind.enum = ['NOTE']; });
    assert.ok(has(res.breaking, 'kind', 'enum values removed: BOOK'));
  });
  test('a removed query-parameter enum value is breaking', () => {
    const res = diff((d) => { d.paths['/api/v1/items/{id}'].get.parameters[1].schema.enum = ['full']; });
    assert.ok(has(res.breaking, 'query parameter view', 'enum values removed: summary'));
  });
  test('a new request enum value is additive', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.kind.enum = ['NOTE', 'BOOK', 'EBOOK']; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'kind', 'enum values added: EBOOK'));
  });
  test('restricting a free request value to an enum is breaking', () => {
    const res = diff((d) => { S(d).CreateItemDto.properties.title.enum = ['A', 'B']; });
    assert.ok(has(res.breaking, 'title', 'values now restricted'));
  });
  test('a new response enum value needs review (not silently additive, not breaking)', () => {
    const res = diff((d) => { createResp(d).properties.status.enum = ['DRAFT', 'PUBLISHED', 'ARCHIVED']; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.review, 'status', 'enum values added: ARCHIVED'));
  });
  test('a removed response enum value is additive', () => {
    const res = diff((d) => { createResp(d).properties.status.enum = ['PUBLISHED']; });
    assert.equal(res.breaking.length, 0);
    assert.ok(has(res.additive, 'status', 'enum values removed: DRAFT'));
  });
});

describe('6. operation identity, roles and parameters', () => {
  test('a changed operationId is breaking', () => {
    const res = diff((d) => { d.paths['/api/v1/items'].post.operationId = 'ItemsController_add'; });
    assert.ok(has(res.breaking, 'POST /api/v1/items', 'operationId changed from ItemsController_create to ItemsController_add'));
  });
  test('an unchanged operationId reports nothing', () => {
    assert.ok(none(diff((d) => { d.paths['/api/v1/items'].post.operationId = 'ItemsController_create'; })));
  });
  test('a removed operation is breaking; an added one is additive', () => {
    const r1 = diff((d) => { delete d.paths['/api/v1/items/{id}']; });
    assert.ok(has(r1.breaking, 'GET /api/v1/items/{id}', 'operation removed'));
    const r2 = diff((d) => { d.paths['/api/v1/extra'] = { get: { operationId: 'x', responses: { 200: {} } } }; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'GET /api/v1/extra', 'operation added'));
  });
  test('narrowed roles are breaking; widened roles are additive', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items'].post['x-roles'] = ['ADMIN']; });
    assert.ok(has(r1.breaking, 'roles removed: MENTOR'));
    const r2 = diff((d) => { d.paths['/api/v1/items'].post['x-roles'] = ['ADMIN', 'MENTOR', 'TEACHER']; });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'roles added: TEACHER'));
  });
  test('protected → public needs a security review; public → protected is breaking', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items'].post.security = []; });
    assert.ok(has(r1.review, 'now public'));
    const before = fixture(); before.paths['/api/v1/items'].post.security = [];
    const r2 = compare(buildSnapshot(before), buildSnapshot(fixture()));
    assert.ok(has(r2.breaking, 'now requires authentication'));
  });
  test('a new required parameter is breaking; a new optional one is additive; a removed one is breaking', () => {
    const r1 = diff((d) => { d.paths['/api/v1/items'].post.parameters.push({ name: 'schoolId', in: 'query', required: true, schema: { type: 'string' } }); });
    assert.ok(has(r1.breaking, 'new required query parameter "schoolId"'));
    const r2 = diff((d) => { d.paths['/api/v1/items'].post.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }); });
    assert.equal(r2.breaking.length, 0);
    assert.ok(has(r2.additive, 'new optional query parameter "page"'));
    const r3 = diff((d) => { d.paths['/api/v1/items'].post.parameters = []; });
    assert.ok(has(r3.breaking, 'query parameter "dryRun" removed'));
  });
});

describe('shapeOf', () => {
  test('records nullable, enum, format and request constraints', () => {
    assert.deepEqual(shapeOf({ type: 'string', nullable: true, enum: ['b', 'a'], format: 'uuid', maxLength: 5 }),
      { nullable: true, type: 'string', format: 'uuid', enum: ['a', 'b'], maxLength: 5 });
  });
});

describe('command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-snapshot-test-'));
  const run = (...args) => spawnSync(process.execPath, ['scripts/api-snapshot.mjs', ...args], { encoding: 'utf8' });
  const base = join(dir, 'base.json');
  const okDoc = join(dir, 'ok.json');
  const breakingDoc = join(dir, 'breaking.json');
  const additiveDoc = join(dir, 'additive.json');
  const reviewDoc = join(dir, 'review.json');
  writeFileSync(okDoc, JSON.stringify(fixture()));
  const b = fixture(); delete S(b).Profile.properties.displayName; writeFileSync(breakingDoc, JSON.stringify(b));
  const a = fixture(); S(a).Owner.properties.email = { type: 'string' }; writeFileSync(additiveDoc, JSON.stringify(a));
  const r = fixture(); createResp(r).properties.status.enum.push('ARCHIVED'); writeFileSync(reviewDoc, JSON.stringify(r));

  test('write, then compare with itself: identical, exit 0 with --strict', () => {
    assert.equal(run('write', base, '--openapi', okDoc).status, 0);
    const out = run('compare', base, '--openapi', okDoc, '--strict');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /API identical to the baseline\./);
    assert.match(out.stdout, /Breaking changes: 0/);
  });
  test('a deliberate breaking change makes --strict exit 1', () => {
    run('write', base, '--openapi', okDoc);
    const out = run('compare', base, '--openapi', breakingDoc, '--strict');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /Breaking changes: [1-9]/);
  });
  test('without --strict a breaking change still exits 0 (report only)', () => {
    assert.equal(run('compare', base, '--openapi', breakingDoc).status, 0);
  });
  test('an additive change passes --strict', () => {
    const out = run('compare', base, '--openapi', additiveDoc, '--strict');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /Breaking changes: 0/);
    assert.match(out.stdout, /Additive changes: [1-9]/);
  });
  test('a review-only change passes --strict but fails --strict-review', () => {
    assert.equal(run('compare', base, '--openapi', reviewDoc, '--strict').status, 0);
    assert.equal(run('compare', base, '--openapi', reviewDoc, '--strict-review').status, 1);
  });
});

describe('real API (docs/api/openapi.json)', () => {
  test('the current OpenAPI document compared with itself: zero changes', () => {
    const doc = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8'));
    const res = compare(buildSnapshot(doc), buildSnapshot(doc));
    assert.equal(res.identical, true);
    assert.ok(none(res));
  });
  test('the current approved snapshot (P1-04) matches the current document exactly', () => {
    assert.ok(existsSync(CURRENT_SNAPSHOT), `${CURRENT_SNAPSHOT} is missing`);
    const saved = JSON.parse(readFileSync(CURRENT_SNAPSHOT, 'utf8'));
    const res = compare(saved, buildSnapshot(JSON.parse(readFileSync('docs/api/openapi.json', 'utf8'))));
    assert.equal(res.versionMismatch, false, 'snapshot must be regenerated with the current snapshot version');
    assert.equal(res.identical, true);
    assert.ok(none(res));
  });
});

/**
 * Approved contract history. Each step from one saved snapshot to the next must
 * contain exactly the approved changes, so no unapproved change can be folded
 * into a new snapshot. The P0-03 snapshot is historical evidence and is never
 * regenerated.
 */

describe('approved API contract history', () => {
  test('P0-03 (2026-11-08) → P1-04: exactly the two approved additive /me/permissions fields; nothing breaking or for review', () => {
    for (const f of [P0_03_SNAPSHOT, P1_04_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const p0 = JSON.parse(readFileSync(P0_03_SNAPSHOT, 'utf8'));
    const p104 = JSON.parse(readFileSync(P1_04_SNAPSHOT, 'utf8'));
    const res = compare(p0, p104);
    assert.equal(res.versionMismatch, false);
    assert.equal(res.identical, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/me/permissions › response 200 application/json.roleLabel: new field',
      'GET /api/v1/me/permissions › response 200 application/json.scopes: new field',
    ]);
  });

  test('P1-04 → P1-05 (role allow-list + M1): exactly the three new role values in four request enums; nothing breaking or for review', () => {
    for (const f of [P1_04_SNAPSHOT, P1_05_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_04_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_05_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'GET /api/v1/admin/users › query parameter role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
      'PATCH /api/v1/admin/users/{id} › request application/json.role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
      'POST /api/v1/admin/users › request application/json.role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
      'POST /api/v1/admin/users/invite › request application/json.role: enum values added: HEAD_COACH, SUPER_ADMIN, TEACHER',
    ]);
  });

  test('P1-05 → P1-06 (routes on permissions): only roles added — SUPER_ADMIN on administrative routes, HEAD_COACH on its course-work grants; nothing breaking or for review', () => {
    for (const f of [P1_05_SNAPSHOT, P1_06_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_05_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_06_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.equal(res.additive.length, 87);
    const added = {};
    for (const line of res.additive) {
      const m = /: roles added: (.+)$/.exec(line);
      assert.ok(m, `unexpected change: ${line}`);
      added[m[1]] = (added[m[1]] ?? 0) + 1;
    }
    assert.deepEqual(added, { SUPER_ADMIN: 73, HEAD_COACH: 13, 'HEAD_COACH, SUPER_ADMIN': 1 });
  });

  test('P1-06 → P1-08 (Super Admin): SUPER_ADMIN added to the 36 @Roles routes admitting ADMIN, plus the optional step-up field; nothing breaking or for review', () => {
    for (const f of [P1_06_SNAPSHOT, P1_08_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_06_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_08_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    const roles = res.additive.filter((l) => /: roles added: SUPER_ADMIN$/.test(l));
    const other = res.additive.filter((l) => !/: roles added: SUPER_ADMIN$/.test(l));
    assert.equal(roles.length, 36);
    assert.deepEqual(other, ['PATCH /api/v1/admin/users/{id} › request application/json.currentPassword: new optional field']);
  });

  test('P1-08 → P1-09 (permission overrides): exactly the five new operations, their request DTO and /me/permissions.overrides; nothing breaking or for review', () => {
    for (const f of [P1_08_SNAPSHOT, P1_09_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_08_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_09_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'DELETE /api/v1/admin/users/{id}/permission-overrides/{overrideId}: operation added',
      'GET /api/v1/admin/permissions/catalogue: operation added',
      'GET /api/v1/admin/users/{id}/permission-overrides: operation added',
      'GET /api/v1/admin/users/{id}/permissions: operation added',
      'GET /api/v1/me/permissions › response 200 application/json.overrides: new field',
      'POST /api/v1/admin/users/{id}/permission-overrides: operation added',
      'schema CreateOverrideDto: added',
    ]);
  });

  test('P1-09 → P1-10 (Head Coach programme scope): the programme, heads and members operations, their DTOs, /me/permissions.scopes.programmes and HEAD_COACH on coach assignments; nothing breaking or for review', () => {
    for (const f of [P1_09_SNAPSHOT, P1_10_SNAPSHOT]) assert.ok(existsSync(f), `${f} is missing`);
    const res = compare(JSON.parse(readFileSync(P1_09_SNAPSHOT, 'utf8')), JSON.parse(readFileSync(P1_10_SNAPSHOT, 'utf8')));
    assert.equal(res.versionMismatch, false);
    assert.deepEqual(res.breaking, []);
    assert.deepEqual(res.review, []);
    assert.deepEqual(res.additive, [
      'DELETE /api/v1/admin/mentor-assignments/{id}: roles added: HEAD_COACH',
      'DELETE /api/v1/admin/programmes/{id}/members/{userId}: operation added',
      'GET /api/v1/admin/mentor-assignments: roles added: HEAD_COACH',
      'GET /api/v1/admin/programmes/{id}/heads: operation added',
      'GET /api/v1/admin/programmes/{id}/members: operation added',
      'GET /api/v1/me/permissions › response 200 application/json.scopes.programmes: new field',
      'GET /api/v1/programmes: operation added',
      'POST /api/v1/admin/mentor-assignments: roles added: HEAD_COACH',
      'POST /api/v1/admin/programmes/{id}/members: operation added',
      'PUT /api/v1/admin/programmes/{id}/heads: operation added',
      'schema AddProgrammeMemberDto: added',
      'schema SetProgrammeHeadsDto: added',
    ]);
  });

  test('the P0-03 snapshot is the recorded historical evidence (fingerprint unchanged)', () => {
    const p0 = JSON.parse(readFileSync(P0_03_SNAPSHOT, 'utf8'));
    assert.equal(p0.fingerprint, '34d76bdd8e98257b66a6bf880527d0d25174806af44fc679ba298a5e3a7e59d7');
    assert.equal(p0.operations.length, 202);
  });
});
