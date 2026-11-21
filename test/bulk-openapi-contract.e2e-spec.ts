/**
 * OpenAPI contract of the generic bulk routes (2026-11-19): every real response — success and error — is checked
 * against the GENERATED document (docs/api/openapi.json, which CI keeps equal to the code): the documented status
 * exists, the body matches its schema exactly (required fields, types, nullability, no undocumented field), and every
 * error code observed is one the route documents. The documented examples are checked against the same schemas.
 * Runs on its own freshly reset test database (never production).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BulkOperationsService } from '../src/bulk/bulk-operations.service.js';
import { BulkOperationsWorker } from '../src/bulk/bulk-operations.worker.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

type Schema = Record<string, any>;
const doc = JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'api', 'openapi.json'), 'utf8'));
const deref = (s: Schema): Schema => (s?.$ref ? deref(doc.components.schemas[s.$ref.split('/').pop()]) : s);

/** Structural validation (the subset of OpenAPI 3.0 these schemas use); returns the problems found. */
function check(value: unknown, schema: Schema, at = '$', out: string[] = []): string[] {
  if (schema.$ref) return check(value, deref(schema), at, out);
  if (value === null) {
    if (!schema.nullable) out.push(`${at}: null is not allowed`);
    return out;
  }
  if (schema.allOf) { for (const s of schema.allOf) check(value, s, at, out); return out; }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  const type = schema.type ?? (schema.properties ? 'object' : undefined);
  switch (type) {
    case 'string':
      if (typeof value !== 'string') out.push(`${at}: expected a string`);
      else if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) out.push(`${at}: not a date-time`);
      break;
    case 'integer': if (!Number.isInteger(value)) out.push(`${at}: expected an integer`); break;
    case 'number': if (typeof value !== 'number') out.push(`${at}: expected a number`); break;
    case 'boolean': if (typeof value !== 'boolean') out.push(`${at}: expected a boolean`); break;
    case 'array':
      if (!Array.isArray(value)) out.push(`${at}: expected an array`);
      else value.forEach((v, i) => check(v, schema.items ?? {}, `${at}[${i}]`, out));
      break;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) { out.push(`${at}: expected an object`); break; }
      const props = schema.properties ?? {};
      for (const r of schema.required ?? []) if (!(r in (value as object))) out.push(`${at}.${r}: required, missing`);
      for (const [k, v] of Object.entries(value as object)) {
        if (k in props) check(v, props[k], `${at}.${k}`, out);
        else if (schema.additionalProperties !== true) out.push(`${at}.${k}: not documented`);
      }
      break;
    }
    default: break;   // no type: anything
  }
  return out;
}

describe('Generic bulk routes — OpenAPI contract', () => {
  let ctx: TestContext;
  let admin: string;
  let mentor: string;
  let other: string;
  let hash: string;
  const observed = new Set<string>();
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  let keyN = 0;
  const key = () => `contract-${++keyN}-${Date.now()}`;
  const G = '/api/v1/admin/bulk';

  /** Checks a real response against the documented response of (path, method, its status). */
  async function conforms(req: any, path: string, method: string, expectStatus?: number) {
    const res = await req;
    const op = doc.paths[path]?.[method];
    expect(op, `${method} ${path} is documented`).toBeTruthy();
    if (expectStatus !== undefined) expect([path, res.status, res.body?.code]).toEqual([path, expectStatus, res.body?.code]);
    const documented = op.responses[String(res.status)];
    expect(documented, `${method} ${path} documents ${res.status}`).toBeTruthy();
    const [type, media] = Object.entries(documented.content ?? {})[0] as [string, any];
    expect(res.headers['content-type']).toContain(type);
    if (type === 'application/json') expect(check(res.body, media.schema)).toEqual([]);
    else expect(typeof res.text).toBe('string');
    if (res.status >= 400) {
      expect(documented.description).toContain(res.body.code);
      expect(Object.keys(media.examples ?? {})).toContain(res.body.code);
      observed.add(`${method} ${path} ${res.body.code}`);
    }
    return res;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    mentor = await login(ctx, 'mentor.j');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    await p().user.createMany({
      data: [0, 1, 2, 3].map((i) => ({ username: `contract.${i}`, firstName: 'Contract', lastName: `N${i}`, email: `contract.${i}@test.local`, role: 'MENTOR' as const, passwordHash: hash, activatedAt: new Date() })),
    });
    await p().user.create({ data: { username: 'ctadmin2', firstName: 'C', lastName: 'Admin', email: 'ctadmin2@test.local', role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    other = await login(ctx, 'ctadmin2');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('every documented example matches its own schema', () => {
    let n = 0;
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      if (!path.startsWith(G)) continue;
      for (const op of Object.values<any>(item)) {
        for (const [status, r] of Object.entries<any>(op.responses)) {
          const media: any = r.content?.['application/json'];
          if (!media || status === 'default') continue;
          if (media.example !== undefined) { expect([path, status, check(media.example, media.schema)]).toEqual([path, status, []]); n++; }
          for (const [code, ex] of Object.entries<any>(media.examples ?? {})) {
            expect([path, status, code, check(ex.value, media.schema), ex.value.statusCode]).toEqual([path, status, code, [], Number(status)]);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(30);
  });

  it('preview, execute (202, then 200 replay), progress, items, list, actions, cancel and export conform', async () => {
    const ids = (await p().user.findMany({ where: { username: { startsWith: 'contract.' }, role: 'MENTOR' }, select: { id: true } })).map((u) => u.id);
    const selection = { mode: 'filter', filter: { search: 'contract.' } };
    const pv = await conforms(http().post(`${G}/USER/preview`).set(bearer(admin)).send({ action: 'suspend', selection }), `${G}/{entityType}/preview`, 'post', 200);
    const body = { action: 'suspend', selection, selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total, confirm: true, idempotencyKey: key(), reason: 'Contract test' };
    const created = await conforms(http().post(`${G}/USER`).set(bearer(admin)).send(body), `${G}/{entityType}`, 'post', 202);
    expect(created.body.alreadyExisted).toBe(false);
    const replay = await conforms(http().post(`${G}/USER`).set(bearer(admin)).send(body), `${G}/{entityType}`, 'post', 200);
    expect(replay.body).toMatchObject({ alreadyExisted: true, operation: { id: created.body.operation.id } });
    const worker = ctx.app.get(BulkOperationsWorker);
    while ((await worker.processBatch()) > 0) { /* drain */ }
    const id = created.body.operation.id;
    await conforms(http().get(`${G}/operations/${id}`).set(bearer(admin)), `${G}/operations/{id}`, 'get', 200);
    const items = await conforms(http().get(`${G}/operations/${id}/items`).query({ limit: 3 }).set(bearer(admin)), `${G}/operations/{id}/items`, 'get', 200);
    expect(items.body.data[0].user).toBeTruthy();
    await conforms(http().get(`${G}/operations/${id}/items`).query({ outcome: 'FAILED' }).set(bearer(admin)), `${G}/operations/{id}/items`, 'get', 200);
    await conforms(http().get(`${G}/operations`).query({ entityType: 'USER' }).set(bearer(admin)), `${G}/operations`, 'get', 200);
    await conforms(http().get(`${G}/actions`).set(bearer(admin)), `${G}/actions`, 'get', 200);
    const csv = await conforms(http().post(`${G}/USER/export`).set(bearer(admin)).send({ selection: { mode: 'ids', ids } }), `${G}/{entityType}/export`, 'post', 200);
    expect(csv.text.split(/\r?\n/)[0]).toContain('firstName,lastName,username,email,role,accountStatus,school,gradeLevel,createdAt');
    // Cancel: a fresh operation, then cancelling it again.
    const pv2 = await http().post(`${G}/USER/preview`).set(bearer(admin)).send({ action: 'activate', selection: { mode: 'ids', ids } }).expect(200);
    const op2 = await http().post(`${G}/USER`).set(bearer(admin)).send({ action: 'activate', selection: { mode: 'ids', ids }, selectionToken: pv2.body.selectionToken, expectedTotal: 4, confirm: true, idempotencyKey: key() }).expect(202);
    await conforms(http().post(`${G}/operations/${op2.body.operation.id}/cancel`).set(bearer(admin)), `${G}/operations/{id}/cancel`, 'post', 200);
    await conforms(http().post(`${G}/operations/${op2.body.operation.id}/cancel`).set(bearer(admin)), `${G}/operations/{id}/cancel`, 'post', 409);
  });

  it('errors: each conforms to the Error schema and its code is one the route documents', async () => {
    const ids = (await p().user.findMany({ where: { username: { startsWith: 'contract.' }, role: 'MENTOR' }, select: { id: true } })).map((u) => u.id);
    const missing = '00000000-0000-4000-8000-000000000000';
    const PV = `${G}/{entityType}/preview`, EX = `${G}/{entityType}`, EXP = `${G}/{entityType}/export`;
    const pv = (b: object, t = admin) => http().post(`${G}/USER/preview`).set(bearer(t)).send(b);
    const ex = (b: object, t = admin) => http().post(`${G}/USER`).set(bearer(t)).send(b);
    const sel = { mode: 'ids', ids };

    // Every route: 401 without a token, 403 for a Coach.
    const routes: Array<[string, string, (t?: string) => any]> = [
      [`${G}/actions`, 'get', (t) => (t ? http().get(`${G}/actions`).set(bearer(t)) : http().get(`${G}/actions`))],
      [`${G}/operations`, 'get', (t) => (t ? http().get(`${G}/operations`).set(bearer(t)) : http().get(`${G}/operations`))],
      [`${G}/operations/{id}`, 'get', (t) => (t ? http().get(`${G}/operations/${missing}`).set(bearer(t)) : http().get(`${G}/operations/${missing}`))],
      [`${G}/operations/{id}/items`, 'get', (t) => (t ? http().get(`${G}/operations/${missing}/items`).set(bearer(t)) : http().get(`${G}/operations/${missing}/items`))],
      [`${G}/operations/{id}/cancel`, 'post', (t) => (t ? http().post(`${G}/operations/${missing}/cancel`).set(bearer(t)) : http().post(`${G}/operations/${missing}/cancel`))],
      [PV, 'post', (t) => (t ? pv({ action: 'suspend', selection: sel }, t) : http().post(`${G}/USER/preview`).send({}))],
      [EX, 'post', (t) => (t ? ex({}, t) : http().post(`${G}/USER`).send({}))],
      [EXP, 'post', (t) => (t ? http().post(`${G}/USER/export`).set(bearer(t)).send({ selection: sel }) : http().post(`${G}/USER/export`).send({}))],
    ];
    for (const [path, method, call] of routes) {
      await conforms(call(), path, method, 401);
      await conforms(call(mentor), path, method, 403);
    }

    // Lists, progress, items, cancel.
    await conforms(http().get(`${G}/operations`).query({ status: 'NOPE' }).set(bearer(admin)), `${G}/operations`, 'get', 400);
    await conforms(http().get(`${G}/operations/not-a-uuid`).set(bearer(admin)), `${G}/operations/{id}`, 'get', 400);
    await conforms(http().get(`${G}/operations/${missing}`).set(bearer(admin)), `${G}/operations/{id}`, 'get', 404);
    await conforms(http().get(`${G}/operations/${missing}/items`).query({ outcome: 'NOPE' }).set(bearer(admin)), `${G}/operations/{id}/items`, 'get', 400);
    await conforms(http().get(`${G}/operations/not-a-uuid/items`).set(bearer(admin)), `${G}/operations/{id}/items`, 'get', 400);
    await conforms(http().get(`${G}/operations/${missing}/items`).set(bearer(admin)), `${G}/operations/{id}/items`, 'get', 404);
    await conforms(http().post(`${G}/operations/not-a-uuid/cancel`).set(bearer(admin)), `${G}/operations/{id}/cancel`, 'post', 400);
    await conforms(http().post(`${G}/operations/${missing}/cancel`).set(bearer(admin)), `${G}/operations/{id}/cancel`, 'post', 404);

    // Preview.
    await conforms(pv({ action: 'suspend', selection: { mode: 'filter', filter: { role: 'NOPE' } } }), PV, 'post', 400);
    await conforms(pv({ action: 'delete', selection: sel }), PV, 'post', 400);
    await conforms(pv({ action: 'assignRole', params: { role: 'SUPER_ADMIN' }, selection: sel }), PV, 'post', 400);
    await conforms(pv({ action: 'reassignTeacher', params: { fromTeacherId: ids[0], toTeacherId: ids[0] }, selection: sel }), PV, 'post', 400);
    await conforms(pv({ action: 'assignTeacher', params: { teacherId: ids[0] }, selection: sel }), PV, 'post', 400);
    await conforms(pv({ action: 'assignTeacher', params: { teacherId: missing }, selection: sel }), PV, 'post', 404);
    await conforms(http().post(`${G}/NOPE/preview`).set(bearer(admin)).send({ action: 'suspend', selection: sel }), PV, 'post', 404);

    // Execute.
    const fresh = async (action = 'suspend', selection: object = sel, params?: object) =>
      (await pv({ action, selection, ...(params && { params }) }).expect(200)).body;
    const bodyOf = (v: any, extra: object = {}) => ({
      action: v.action, selection: v.selection, ...(Object.keys(v.params).length && { params: v.params }), selectionToken: v.selectionToken,
      expectedTotal: v.total, confirm: true, idempotencyKey: key(), reason: 'Contract errors', ...extra,
    });
    const v = await fresh();
    await conforms(ex({ action: 'suspend' }), EX, 'post', 400);                                                     // VALIDATION_FAILED
    await conforms(ex(bodyOf(v, { confirm: false })), EX, 'post', 400);                                             // CONFIRMATION_REQUIRED
    await conforms(ex(bodyOf(v, { reason: '' })), EX, 'post', 400);                                                 // REASON_REQUIRED
    await conforms(ex(bodyOf(v, { selectionToken: 'v1.4.' + 'a'.repeat(64) })), EX, 'post', 400);                  // CONFIRMATION_INVALID
    const none = await fresh('suspend', { mode: 'filter', filter: { search: 'no-account-matches-this' } });
    await conforms(ex(bodyOf(none)), EX, 'post', 400);                                                              // EMPTY_SELECTION
    await conforms(ex(bodyOf(v), other), EX, 'post', 403);                                                          // CONFIRMATION_WRONG_ADMINISTRATOR
    const stepUp = await fresh('assignRole', sel, { role: 'ADMIN' });
    await conforms(ex(bodyOf(stepUp)), EX, 'post', 403);                                                            // STEP_UP_REQUIRED
    await conforms(ex(bodyOf(v, { action: 'archive' })), EX, 'post', 409);                                          // SELECTION_CHANGED
    const expired = ctx.app.get(BulkOperationsService).signToken(
      { actorId: ctx.ids.admin, entityType: 'USER', action: 'suspend', params: {}, selection: v.selection, ids: [...ids].sort() }, new Date(Date.now() - 16 * 60_000));
    await conforms(ex(bodyOf(v, { selectionToken: expired.token })), EX, 'post', 410);                              // CONFIRMATION_EXPIRED
    await ex(bodyOf(v)).expect(202);
    await conforms(ex(bodyOf(v)), EX, 'post', 409);                                                                 // CONFIRMATION_USED
    await conforms(http().post(`${G}/NOPE`).set(bearer(admin)).send(bodyOf(v)), EX, 'post', 404);                  // BULK_ENTITY_UNKNOWN

    // Export.
    await conforms(http().post(`${G}/USER/export`).set(bearer(admin)).send({ selection: { mode: 'ids', ids: ['x'] } }), EXP, 'post', 400);
    await conforms(http().post(`${G}/NOPE/export`).set(bearer(admin)).send({ selection: sel }), EXP, 'post', 404);

    const codes = [...observed].map((o) => o.split(' ').pop()).sort();
    for (const c of ['BAD_REQUEST', 'BULK_ACTION_UNKNOWN', 'BULK_ENTITY_UNKNOWN', 'CONFIRMATION_EXPIRED', 'CONFIRMATION_INVALID', 'CONFIRMATION_REQUIRED',
      'CONFIRMATION_USED', 'CONFIRMATION_WRONG_ADMINISTRATOR', 'EMPTY_SELECTION', 'NOT_A_TEACHER', 'NOT_FOUND', 'OPERATION_FINISHED',
      'PERMISSION_REQUIRED', 'REASON_REQUIRED', 'ROLE_NOT_ALLOWED_IN_BULK', 'SAME_TEACHER', 'SELECTION_CHANGED', 'STEP_UP_REQUIRED', 'UNAUTHORIZED',
      'VALIDATION_FAILED']) expect(codes).toContain(c);
  });
});
