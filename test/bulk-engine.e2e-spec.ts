/**
 * The generic bulk engine (2026-11-19; docs/operations/bulk-operations.md):
 *  - /admin/bulk/USER/* equal /admin/users/bulk/* (same engine, same results; a confirmation from one works on the other);
 *  - GET /admin/bulk/actions lists what the caller may run, from their effective permissions;
 *  - users.bulkManage alone is never sufficient: for EVERY USER action, an Administrator denied one of the action's own
 *    permissions is refused at preview, at execute (permission removed after the preview) and per record (removed after
 *    the operation was created);
 *  - the v2 confirmation: expired, another administrator, another action / parameters / ids / filter / record set,
 *    tampered, malformed and v1 tokens are refused, and nothing is created;
 *  - idempotency: the same key twice and concurrently → one operation;
 *  - reassignTeacher: only students assigned to the first teacher move; school links never change; one notice;
 *  - a non-USER record type (registered by this test, guarded by SHARE table locks): membership races, stale-claim
 *    takeover and exactly-once processing on the same engine.
 * Runs on its own freshly reset test database (never production).
 */
import pg from 'pg';
import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';

import { BulkOperationsService } from '../src/bulk/bulk-operations.service.js';
import { BulkOperationsWorker, type ClaimedItem } from '../src/bulk/bulk-operations.worker.js';
import { BulkRegistry } from '../src/bulk/bulk-registry.js';
import type { BulkEntityHandler, Db, EngineSelection, ItemContext } from '../src/bulk/bulk-handler.js';
import { ACTION_RULES, BULK_ACTIONS } from '../src/users/bulk/bulk-rules.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

class TestSchoolSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';
  @ValidateIf((o: TestSchoolSelectionDto) => o.mode === 'ids') @IsArray() @IsUUID('all', { each: true }) ids?: string[];
  @ValidateIf((o: TestSchoolSelectionDto) => o.mode === 'filter') @IsObject() filter?: { search?: string };
}
class TestSchoolParamsDto { @IsOptional() @IsString() note?: string }

describe('Generic bulk engine', () => {
  let ctx: TestContext;
  let admin: string;
  let service: BulkOperationsService;
  let worker: BulkOperationsWorker;
  let registry: BulkRegistry;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  let keyN = 0;
  const key = () => `engine-key-${++keyN}-${Date.now()}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settledWithin = (pr: Promise<unknown>, ms: number) => Promise.race([pr.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);
  const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { open, wait }; };
  async function connect() { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; }

  const G = '/api/v1/admin/bulk';
  const preview = (type: string, body: object, token = admin) => http().post(`${G}/${type}/preview`).set(bearer(token)).send(body);
  const execute = (type: string, body: object, token = admin) => http().post(`${G}/${type}`).set(bearer(token)).send(body);
  const oldPreview = (body: object, token = admin) => http().post('/api/v1/admin/users/bulk/preview').set(bearer(token)).send(body);
  const oldExecute = (body: object, token = admin) => http().post('/api/v1/admin/users/bulk').set(bearer(token)).send(body);
  const confirmBody = (pv: any, extra: object = {}) => ({
    action: pv.body.action, selection: pv.body.selection, ...(pv.body.params && Object.keys(pv.body.params).length && { params: pv.body.params }),
    selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total, confirm: true, idempotencyKey: key(), ...extra,
  });
  async function drain() { while ((await worker.processBatch()) > 0) { /* until nothing is pending */ } }
  async function makeUsers(prefix: string, count: number, data: Record<string, unknown> = {}) {
    await p().user.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        username: `${prefix}.${i}`, firstName: prefix, lastName: `N${i}`, email: `${prefix}.${i}@test.local`,
        role: 'MENTOR' as const, passwordHash: hash, activatedAt: new Date(), ...data,
      })),
    });
    return (await p().user.findMany({ where: { username: { startsWith: `${prefix}.` } }, select: { id: true }, orderBy: { username: 'asc' } })).map((u) => u.id);
  }
  async function makeAdmin(username: string) {
    await p().user.create({ data: { username, firstName: 'Second', lastName: 'Admin', email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    return login(ctx, username);
  }
  const deny = async (username: string, permission: string) => {
    const u = await p().user.findUniqueOrThrow({ where: { username } });
    return p().userPermissionOverride.create({ data: { userId: u.id, permission, effect: 'DENY', reason: 'engine test' } });
  };
  const opCount = () => p().bulkOperation.count();

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    service = ctx.app.get(BulkOperationsService);
    worker = ctx.app.get(BulkOperationsWorker);
    registry = ctx.app.get(BulkRegistry);
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  // ─── Backward compatibility: /admin/bulk/USER = /admin/users/bulk ──────────

  it('USER: the generic routes and /admin/users/bulk preview the same; a confirmation from either executes on the other', async () => {
    const ids = await makeUsers('compat', 4);
    const body = { action: 'suspend', selection: { mode: 'filter', filter: { search: 'compat' } } };
    const a = await preview('USER', body).expect(200);
    const b = await oldPreview(body).expect(200);
    const strip = (x: any) => ({ ...x, selectionToken: undefined, confirmationExpiresAt: undefined });
    expect(strip(a.body)).toEqual(strip(b.body));
    expect(a.body).toMatchObject({ entityType: 'USER', total: 4, requiresReason: true, requiresStepUp: false });
    expect(Date.parse(a.body.confirmationExpiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    // A generic preview executed on the old route, and the other way round.
    const r1 = await oldExecute(confirmBody(a, { reason: 'Compat one' })).expect(202);
    expect(r1.body.operation).toMatchObject({ entityType: 'USER', action: 'suspend', total: 4 });
    await drain();
    const c = await oldPreview({ action: 'activate', selection: { mode: 'ids', ids } }).expect(200);
    const r2 = await execute('USER', confirmBody(c)).expect(202);
    await drain();
    // Progress and items read the same on both routes; items carry entityId (and userId, user for USER).
    const og = await http().get(`/api/v1/admin/users/bulk/${r2.body.operation.id}`).set(bearer(admin)).expect(200);
    const gg = await http().get(`${G}/operations/${r2.body.operation.id}`).set(bearer(admin)).expect(200);
    expect(gg.body).toEqual(og.body);
    expect(gg.body).toMatchObject({ status: 'COMPLETED', succeeded: 4, entityType: 'USER' });
    const oi = await http().get(`/api/v1/admin/users/bulk/${r2.body.operation.id}/items`).set(bearer(admin)).expect(200);
    const gi = await http().get(`${G}/operations/${r2.body.operation.id}/items`).set(bearer(admin)).expect(200);
    expect(gi.body).toEqual(oi.body);
    expect(gi.body.data[0]).toEqual(expect.objectContaining({ entityId: gi.body.data[0].userId, outcome: 'SUCCEEDED', user: expect.objectContaining({ username: expect.stringMatching(/^compat\./) }) }));
    // The generic list holds both; ?entityType filters; export through the generic route needs users.export too.
    const list = await http().get(`${G}/operations`).query({ entityType: 'USER' }).set(bearer(admin)).expect(200);
    expect(list.body.data.map((o: any) => o.id)).toEqual(expect.arrayContaining([r1.body.operation.id, r2.body.operation.id]));
    const csv = await http().post(`${G}/USER/export`).set(bearer(admin)).send({ selection: { mode: 'ids', ids } }).expect(200);
    expect(csv.text).toMatch(/compat\.0/);
    expect(csv.text).not.toMatch(/dateOfBirth|phone/i);
    // Unknown record types and actions; the record type's own validation applies on the generic route.
    expect(await code(preview('NOPE', body))).toEqual([404, 'BULK_ENTITY_UNKNOWN']);
    expect(await code(preview('USER', { ...body, action: 'delete' }))).toEqual([400, 'BULK_ACTION_UNKNOWN']);
    expect(await code(preview('USER', { ...body, selection: { mode: 'filter', filter: { role: 'NOT_A_ROLE' } } }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(preview('USER', { ...body, selection: { mode: 'filter', filter: { unknownFilter: 1 } } }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(preview('USER', { action: 'assignRole', params: { role: 'SUPER_ADMIN' }, selection: { mode: 'ids', ids } }))).toEqual([400, 'ROLE_NOT_ALLOWED_IN_BULK']);
    expect(await code(preview('user', body))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('GET /admin/bulk/actions: only the actions the caller may run now; never for roles without users.bulkManage', async () => {
    const all = await http().get(`${G}/actions`).set(bearer(admin)).expect(200);
    const user = all.body.entityTypes.find((t: any) => t.entityType === 'USER');
    expect(user).toMatchObject({ maxIds: 1000, maxSelection: 50000, export: { permission: 'users.export' } });
    expect(user.actions.map((a: any) => a.action).sort()).toEqual([...BULK_ACTIONS].sort());
    expect(user.actions.find((a: any) => a.action === 'suspend')).toEqual({
      action: 'suspend', permissions: ['users.bulkManage', 'users.manage', 'users.suspend'], requiresReason: true, consequence: ACTION_RULES.suspend.consequence,
    });
    const limited = await makeAdmin('engine.limited');
    await deny('engine.limited', 'users.archive');
    await deny('engine.limited', 'email.bulkSend');
    const mine = await http().get(`${G}/actions`).set(bearer(limited)).expect(200);
    const names = mine.body.entityTypes.find((t: any) => t.entityType === 'USER').actions.map((a: any) => a.action);
    expect(names).not.toContain('archive');
    expect(names).not.toContain('restore');
    expect(names).not.toContain('message');
    expect(names).toContain('suspend');
    for (const u of ['mentor.j', 'student.j']) {
      expect(await code(http().get(`${G}/actions`).set(bearer(await login(ctx, u))))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
  });

  // ─── Authorization: users.bulkManage is necessary, never sufficient ─────────

  describe('every USER action needs its own permission(s) at preview, execute and per record', () => {
    let teacherId: string;
    let studentId: string;
    const paramsOf = (action: string): Record<string, unknown> | undefined => ({
      assignRole: { role: 'MENTOR' }, changeClassification: { gradeLevel: 'S3' }, message: { subject: 'Engine test', body: 'Engine test body.' },
      assignTeacher: { teacherId }, unassignTeacher: { teacherId },
      grantDelegation: { teacherId, permission: 'students.viewProfile' }, revokeDelegation: { teacherId, permission: 'students.viewProfile' },
      reassignTeacher: { fromTeacherId: teacherId, toTeacherId: ctx.ids.admin },
    } as Record<string, Record<string, unknown>>)[action];

    beforeAll(async () => {
      teacherId = (await p().user.create({ data: { username: 'engine.teacher', firstName: 'E', lastName: 'T', email: 'engine.teacher@test.local', role: 'TEACHER', passwordHash: hash, activatedAt: new Date() } })).id;
      [studentId] = await makeUsers('engauth', 1, { role: 'STUDENT', gradeLevel: 'S2', divisionId: ctx.ids.junior });
    });

    it.each([...BULK_ACTIONS])('%s', async (action) => {
      const perms = ACTION_RULES[action].permissions;
      expect(perms.length).toBeGreaterThan(0);
      const params = action === 'reassignTeacher' ? { fromTeacherId: teacherId, toTeacherId: (await p().user.create({ data: { username: `engine.t2.${action}`, firstName: 'E', lastName: 'T2', email: `engine.t2.${action}@test.local`, role: 'TEACHER', passwordHash: hash, activatedAt: new Date() } })).id } : paramsOf(action);
      const selection = { mode: 'ids', ids: [studentId] };
      const body = { action, selection, ...(params && { params }) };
      const extra = ACTION_RULES[action].reason === 'required' ? { reason: 'Engine authorization test' } : {};
      for (const [i, perm] of perms.entries()) {
        const name = `engine.a${BULK_ACTIONS.indexOf(action)}.${i}`;
        const token = await makeAdmin(name);
        // Preview and execute work while the permission is held…
        const pv = await preview('USER', body, token).expect(200);
        await oldPreview(body, token).expect(200);
        const before = await opCount();
        const ov = await deny(name, perm);
        // …refused at preview (both routes) and at execute once it is denied, even with a valid confirmation.
        expect(await code(preview('USER', body, token))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await code(oldPreview(body, token))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await code(execute('USER', confirmBody(pv, extra), token))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await code(oldExecute(confirmBody(pv, extra), token))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await opCount()).toBe(before);
        // Denied after the operation was created → the record FAILS with PERMISSION_REQUIRED; nothing is changed.
        await p().userPermissionOverride.delete({ where: { id: ov.id } });
        const pv2 = await preview('USER', body, token).expect(200);
        const res = await execute('USER', confirmBody(pv2, extra), token).expect(202);
        await deny(name, perm);
        const auditBefore = await p().auditLog.count({ where: { entityId: studentId } });
        await drain();
        const items = await p().bulkOperationItem.findMany({ where: { operationId: res.body.operation.id } });
        expect(items.map((x) => [x.outcome, x.code])).toEqual([['FAILED', 'PERMISSION_REQUIRED']]);
        expect(await p().auditLog.count({ where: { entityId: studentId } })).toBe(auditBefore);
      }
    });
  });

  // ─── The v2 confirmation ────────────────────────────────────────────────────

  it('confirmation: expired, another administrator, another action / params / ids / filter / record set, tampered, malformed and v1 — all refused, nothing created', async () => {
    const ids = await makeUsers('tok', 3);
    const sel = { mode: 'ids', ids: ids.slice(0, 2) };
    const pv = await preview('USER', { action: 'suspend', selection: sel }).expect(200);
    const ok = confirmBody(pv, { reason: 'Token test' });
    const before = await opCount();

    // Expired: a confirmation for exactly this request, signed 16 minutes ago.
    const expired = service.signToken({ actorId: ctx.ids.admin, entityType: 'USER', action: 'suspend', params: {}, selection: sel, ids: [...sel.ids].sort() }, new Date(Date.now() - 16 * 60_000));
    expect(await code(execute('USER', { ...ok, selectionToken: expired.token }))).toEqual([410, 'CONFIRMATION_EXPIRED']);
    expect(await code(oldExecute({ ...ok, selectionToken: expired.token }))).toEqual([410, 'CONFIRMATION_EXPIRED']);
    // Another administrator, with the very same request.
    const other = await makeAdmin('engine.other');
    expect(await code(execute('USER', ok, other))).toEqual([403, 'CONFIRMATION_WRONG_ADMINISTRATOR']);
    expect(await code(oldExecute(ok, other))).toEqual([403, 'CONFIRMATION_WRONG_ADMINISTRATOR']);
    // Another action, other parameters, other ids, a filter instead of ids, another record set.
    expect(await code(execute('USER', { ...ok, action: 'archive' }))).toEqual([409, 'SELECTION_CHANGED']);
    const role = await preview('USER', { action: 'assignRole', params: { role: 'MENTOR' }, selection: sel }).expect(200);
    expect(await code(execute('USER', { ...confirmBody(role), params: { role: 'TEACHER' } }))).toEqual([409, 'SELECTION_CHANGED']);
    expect(await code(execute('USER', { ...ok, selection: { mode: 'ids', ids: [ids[0], ids[2]] } }))).toEqual([409, 'SELECTION_CHANGED']);
    expect(await code(execute('USER', { ...ok, selection: { mode: 'filter', filter: { search: 'tok.0' } }, expectedTotal: 1 }))).toEqual([409, 'SELECTION_CHANGED']);
    const fsel = { mode: 'filter', filter: { search: 'tok' } };
    const fpv = await preview('USER', { action: 'suspend', selection: fsel }).expect(200);
    await makeUsers('tokx', 1);   // one more account now matches the filter
    expect(await code(execute('USER', confirmBody(fpv, { reason: 'Token test' })))).toEqual([409, 'SELECTION_CHANGED']);
    // Tampered (count, expiry pushed out, actor swapped, signature), malformed, the old unsigned v1 digest.
    const parts = pv.body.selectionToken.split('.');
    const swap = (i: number, v: string) => parts.map((x: string, j: number) => (j === i ? v : x)).join('.');
    for (const t of [swap(2, '3'), swap(3, String(Number(parts[3]) + 86_400)), swap(5, parts[5].slice(0, 42) + (parts[5].endsWith('A') ? 'B' : 'A')), `v1.2.${'a'.repeat(64)}`, 'not-a-token-at-all']) {
      expect(await code(execute('USER', { ...ok, selectionToken: t }))).toEqual([400, 'CONFIRMATION_INVALID']);
    }
    const otherAdmin = await p().user.findUniqueOrThrow({ where: { username: 'engine.other' } });
    expect(await code(execute('USER', { ...ok, selectionToken: swap(1, otherAdmin.id) }, other))).toEqual([400, 'CONFIRMATION_INVALID']);
    expect(await opCount()).toBe(before);
    // The genuine confirmation still works.
    await execute('USER', ok).expect(202);
    await drain();
  });

  // ─── Idempotency ────────────────────────────────────────────────────────────

  it('idempotency: the same key again, and concurrently, gives one operation; each account is changed once', async () => {
    const ids = await makeUsers('idem', 5);
    const pv = await preview('USER', { action: 'suspend', selection: { mode: 'ids', ids } }).expect(200);
    const body = confirmBody(pv, { reason: 'Idempotency test' });
    const results = await Promise.all([execute('USER', body), execute('USER', body), oldExecute(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    expect(new Set(results.map((r) => r.body.operation.id)).size).toBe(1);
    expect(await p().bulkOperation.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);
    await Promise.all([drain(), drain()]);
    const again = await execute('USER', body).expect(200);
    expect(again.body.operation).toMatchObject({ status: 'COMPLETED', succeeded: 5 });
    for (const id of ids) expect(await p().userStatusChange.count({ where: { userId: id, operationId: again.body.operation.id } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_STARTED', entityId: again.body.operation.id } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_FINISHED', entityId: again.body.operation.id } })).toBe(1);
  });

  // ─── Single-use confirmation ───────────────────────────────────────────────

  it('a confirmation creates one operation: reused with another key → 409 CONFIRMATION_USED on both routes, nothing created; the same key → the same operation', async () => {
    const ids = await makeUsers('once', 3);
    const pv = await preview('USER', { action: 'suspend', selection: { mode: 'ids', ids } }).expect(200);
    const body = confirmBody(pv, { reason: 'Single use' });
    const first = await execute('USER', body).expect(202);
    const before = await opCount();
    expect(await code(execute('USER', { ...body, idempotencyKey: key() }))).toEqual([409, 'CONFIRMATION_USED']);
    expect(await code(oldExecute({ ...body, idempotencyKey: key() }))).toEqual([409, 'CONFIRMATION_USED']);
    expect(await opCount()).toBe(before);
    const same = await oldExecute(body).expect(200);
    expect(same.body.operation.id).toBe(first.body.operation.id);
    await drain();
    // Still refused once the first operation has finished.
    expect(await code(execute('USER', { ...body, idempotencyKey: key() }))).toEqual([409, 'CONFIRMATION_USED']);
    for (const id of ids) expect(await p().userStatusChange.count({ where: { userId: id, toStatus: 'SUSPENDED' } })).toBe(1);
  });

  it('a used confirmation cannot be replayed by respelling its signature (the unused bits of its last character): 400, nothing created', async () => {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const ids = await makeUsers('respell', 2);
    const pv = await preview('USER', { action: 'suspend', selection: { mode: 'ids', ids } }).expect(200);
    const body = confirmBody(pv, { reason: 'Respelled replay' });
    await execute('USER', body).expect(202);
    const before = await opCount();
    const t: string = body.selectionToken;
    const last = ALPHABET.indexOf(t.at(-1)!);
    const respelled = [0, 1, 2, 3].map((low) => ALPHABET[(last & ~3) | low]).filter((ch) => ch !== t.at(-1)).map((ch) => t.slice(0, -1) + ch);
    expect(respelled).toHaveLength(3);
    for (const variant of respelled) {
      expect(await code(execute('USER', { ...body, selectionToken: variant, idempotencyKey: key() }))).toEqual([400, 'CONFIRMATION_INVALID']);
      expect(await code(oldExecute({ ...body, selectionToken: variant, idempotencyKey: key() }))).toEqual([400, 'CONFIRMATION_INVALID']);
    }
    expect(await opCount()).toBe(before);
    await drain();
    for (const id of ids) expect(await p().userStatusChange.count({ where: { userId: id, toStatus: 'SUSPENDED' } })).toBe(1);
  });

  it('concurrent executes of one confirmation with different keys: exactly one operation, the others 409 CONFIRMATION_USED', async () => {
    const ids = await makeUsers('oncec', 4);
    const pv = await preview('USER', { action: 'suspend', selection: { mode: 'ids', ids } }).expect(200);
    const body = confirmBody(pv, { reason: 'Single use, concurrently' });
    const results = await Promise.all([
      execute('USER', { ...body, idempotencyKey: key() }), execute('USER', { ...body, idempotencyKey: key() }),
      oldExecute({ ...body, idempotencyKey: key() }), oldExecute({ ...body, idempotencyKey: key() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(['CONFIRMATION_USED', 'CONFIRMATION_USED', 'CONFIRMATION_USED']);
    expect(await p().bulkOperation.count({ where: { selectionToken: body.selectionToken } })).toBe(1);
    await drain();
    for (const id of ids) expect(await p().userStatusChange.count({ where: { userId: id, toStatus: 'SUSPENDED' } })).toBe(1);
  });

  it('message: one confirmation can never e-mail anyone twice (another key, concurrently, or after it finished)', async () => {
    const ids = await makeUsers('oncemail', 3);
    const subject = `Once only ${Date.now()}`;
    const pv = await preview('USER', { action: 'message', params: { subject, body: 'Sent exactly once.' }, selection: { mode: 'ids', ids } }).expect(200);
    const body = confirmBody(pv);
    const results = await Promise.all([execute('USER', body), execute('USER', { ...body, idempotencyKey: key() }), oldExecute({ ...body, idempotencyKey: key() })]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
    await drain();
    expect(await code(execute('USER', { ...body, idempotencyKey: key() }))).toEqual([409, 'CONFIRMATION_USED']);
    // The winner's key (any of the three may have won the race) returns its operation; nothing new.
    const winner = results.find((r) => r.status === 202)!.body.operation;
    expect((await execute('USER', { ...body, idempotencyKey: winner.idempotencyKey }).expect(200)).body.operation.id).toBe(winner.id);
    await drain();
    const jobs = await p().emailJob.findMany({ where: { subject } });
    expect(jobs).toHaveLength(1);
    for (const id of ids) expect(await p().emailDelivery.count({ where: { jobId: jobs[0].id, recipientId: id } })).toBe(1);
    expect(await p().emailDelivery.count({ where: { jobId: jobs[0].id } })).toBe(3);
  });

  it('the database enforces it too: a second operation row with the same v2 confirmation is refused; v1 digests may repeat', async () => {
    const op = await p().bulkOperation.findFirstOrThrow({ where: { selectionToken: { startsWith: 'v2.' } } });
    const row = (k: string, token: string) => ({ actorRole: 'ADMIN', action: 'suspend', params: {}, selection: {}, selectionToken: token, total: 0, idempotencyKey: k });
    await expect(p().bulkOperation.create({ data: row(key(), op.selectionToken) })).rejects.toMatchObject({ code: 'P2002' });
    const v1 = `v1.0.${'c'.repeat(64)}`;
    await p().bulkOperation.create({ data: row(key(), v1) });
    await p().bulkOperation.create({ data: row(key(), v1) });
    await p().bulkOperation.deleteMany({ where: { selectionToken: v1 } });
  });

  it('rolling deploy: an item inserted without entityId (the previous release) gets its userId; an explicit entityId is kept', async () => {
    const op = await p().bulkOperation.findFirstOrThrow({ where: { entityType: 'USER' } });
    const [a, b] = await makeUsers('rolling', 2);
    // Exactly the previous release's statement (no entityId column).
    await p().$executeRawUnsafe(`INSERT INTO "BulkOperationItem" ("id", "operationId", "userId") SELECT gen_random_uuid()::text, $1, u FROM unnest($2::text[]) AS u ON CONFLICT ("operationId", "userId") DO NOTHING`, op.id, [a]);
    await p().$executeRawUnsafe(`INSERT INTO "BulkOperationItem" ("id", "operationId", "entityId", "userId") VALUES (gen_random_uuid()::text, $1, 'explicit-entity', $2)`, op.id, b);
    expect((await p().bulkOperationItem.findFirstOrThrow({ where: { operationId: op.id, userId: a } })).entityId).toBe(a);
    expect((await p().bulkOperationItem.findFirstOrThrow({ where: { operationId: op.id, userId: b } })).entityId).toBe('explicit-entity');
    // Neither given: still NOT NULL.
    await expect(p().$executeRawUnsafe(`INSERT INTO "BulkOperationItem" ("id", "operationId") VALUES (gen_random_uuid()::text, $1)`, op.id)).rejects.toThrow(/entityId|null value/);
    await p().bulkOperationItem.deleteMany({ where: { operationId: op.id, userId: { in: [a, b] } } });
  });

  // ─── reassignTeacher ────────────────────────────────────────────────────────

  it('reassignTeacher: only students assigned to the first teacher move; others skipped; school links untouched; one notice; retry changes nothing', async () => {
    const school = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    const mk = async (username: string, role: 'TEACHER' | 'STUDENT', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Rea', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const from = await mk('rea.from', 'TEACHER');
    const to = await mk('rea.to', 'TEACHER');
    for (const teacherId of [from, to]) await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: school }).expect(201);
    const junior = { gradeLevel: 'S2' as const, divisionId: ctx.ids.junior, schoolId: school };
    const [moves, notAssigned, both, cross] = await Promise.all(['rea.s1', 'rea.s2', 'rea.s3', 'rea.s4'].map((u) => mk(u, 'STUDENT', junior)));
    for (const s of [moves, notAssigned, both]) {
      await p().studentSchoolAffiliation.create({ data: { studentId: s, schoolId: school, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } });
    }
    await http().post('/api/v1/admin/teacher-students').set(bearer(admin)).send({ teacherId: from, studentIds: [moves, both] }).expect(200);
    await http().post('/api/v1/admin/teacher-students').set(bearer(admin)).send({ teacherId: from, studentIds: [cross], reason: 'Outside the schools' }).expect(200);
    await http().post('/api/v1/admin/teacher-students').set(bearer(admin)).send({ teacherId: to, studentIds: [both] }).expect(200);
    const schoolLinks = await p().teacherSchoolAssignment.findMany({ orderBy: { id: 'asc' } });
    const claims = await p().studentSchoolAffiliation.findMany({ orderBy: { id: 'asc' } });
    const notices = () => p().notificationOutbox.count({ where: { type: 'teacher.students.assigned', recipientUserId: to } });
    const noticesBefore = await notices();

    // The same checks as the single route.
    expect(await code(preview('USER', { action: 'reassignTeacher', params: { fromTeacherId: from, toTeacherId: from }, selection: { mode: 'ids', ids: [moves] } }))).toEqual([400, 'SAME_TEACHER']);
    expect(await code(preview('USER', { action: 'reassignTeacher', params: { fromTeacherId: from, toTeacherId: ctx.ids.mentorJunior }, selection: { mode: 'ids', ids: [moves] } }))).toEqual([400, 'NOT_A_TEACHER']);
    expect(await code(preview('USER', { action: 'reassignTeacher', params: { fromTeacherId: from }, selection: { mode: 'ids', ids: [moves] } }))).toEqual([400, 'VALIDATION_FAILED']);

    const selection = { mode: 'ids', ids: [moves, notAssigned, both, cross, ctx.ids.mentorJunior] };
    const pv = await preview('USER', { action: 'reassignTeacher', params: { fromTeacherId: from, toTeacherId: to }, selection }).expect(200);
    expect(pv.body.warnings.map((w: any) => w.code)).toEqual(expect.arrayContaining(['NOT_STUDENTS', 'NOT_ASSIGNED_TO_SOURCE']));
    const body = confirmBody(pv);
    const res = await execute('USER', body).expect(202);
    await drain();
    const items = await p().bulkOperationItem.findMany({ where: { operationId: res.body.operation.id } });
    expect(Object.fromEntries(items.map((i) => [i.entityId, [i.outcome, i.code]]))).toEqual({
      [moves]: ['SUCCEEDED', null],
      [notAssigned]: ['SKIPPED', 'NOT_ASSIGNED_TO_SOURCE'],
      [both]: ['SUCCEEDED', 'ALREADY_ASSIGNED_TO_NEW_TEACHER'],
      [cross]: ['FAILED', 'REASON_REQUIRED'],          // outside the new teacher's schools, no reason: nothing changes
      [ctx.ids.mentorJunior]: ['SKIPPED', 'NOT_A_STUDENT'],
    });
    const active = async (t: string, s: string) => (await p().teacherStudentAssignment.findUnique({ where: { teacherId_studentId: { teacherId: t, studentId: s } } }))?.isActive ?? false;
    expect([await active(from, moves), await active(to, moves)]).toEqual([false, true]);
    expect([await active(from, both), await active(to, both)]).toEqual([false, true]);
    expect([await active(from, cross), await active(to, cross)]).toEqual([true, false]);
    expect(await active(to, notAssigned)).toBe(false);
    // Ownership and school links never change.
    expect(await p().teacherSchoolAssignment.findMany({ orderBy: { id: 'asc' } })).toEqual(schoolLinks);
    expect(await p().studentSchoolAffiliation.findMany({ orderBy: { id: 'asc' } })).toEqual(claims);
    expect((await p().user.findUniqueOrThrow({ where: { id: moves } })).schoolId).toBe(school);
    // Audit equals the changes: one assignment (moves) + the two ends.
    const audit = await p().auditLog.findMany({ where: { metadata: { path: ['operationId'], equals: res.body.operation.id } } });
    expect(audit.map((a) => a.action).sort()).toEqual(['TEACHER_STUDENT_ASSIGNED', 'TEACHER_STUDENT_UNASSIGNED', 'TEACHER_STUDENT_UNASSIGNED']);
    expect(audit.find((a) => a.action === 'TEACHER_STUDENT_ASSIGNED')!.metadata).toMatchObject({ studentId: moves, reassignedFrom: from, source: 'BULK' });
    expect(await notices()).toBe(noticesBefore + 1);
    // Retry with the same key: the same operation; nothing more happens.
    await execute('USER', body).expect(200);
    await drain();
    expect(await notices()).toBe(noticesBefore + 1);
    expect(await p().auditLog.count({ where: { metadata: { path: ['operationId'], equals: res.body.operation.id } } })).toBe(3);
  });

  // ─── A non-USER record type on the same engine ──────────────────────────────

  describe('a second record type (TEST_SCHOOL, registered by this test): the engine is generic', () => {
    const touched: string[] = [];
    const where = (s: EngineSelection) => (s.mode === 'ids' ? { id: { in: s.ids } } : { name: { contains: String(s.filter.search ?? ''), mode: 'insensitive' as const } });
    const handler: BulkEntityHandler = {
      entityType: 'TEST_SCHOOL', noun: 'schools', maxIds: 1000, maxSelection: 50_000, itemKey: 'school', skipCodes: new Set(),
      selectionDto: TestSchoolSelectionDto, paramsDto: TestSchoolParamsDto,
      membership: { kind: 'tableShare', tables: ['School'] },
      actions: { touch: { permissions: ['schools.manage'], reason: 'optional', consequence: 'Each school gets one audit row (test only).' } },
      normaliseSelection: (s) => (s.mode === 'ids' ? { mode: 'ids', ids: [...new Set(s.ids)].sort() } : { mode: 'filter', filter: { search: s.filter.search } }),
      normaliseParams: () => ({}),
      validate: async () => {},
      count: (db: Db, s) => db.school.count({ where: where(s) }),
      scanIds: async (db: Db, s) => (await db.school.findMany({ where: where(s), select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id),
      preview: async (ids) => ({ sample: ids.slice(0, 10), warnings: [], requiresStepUp: false }),
      describe: async (db: Db, ids) => new Map((await db.school.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((s) => [s.id, s])),
      processItem: async (c: ItemContext) => {
        await c.tx.auditLog.create({ data: { actorId: c.actor.id, actorRole: c.actor.role, action: 'TEST_SCHOOL_TOUCHED', entity: 'School', entityId: c.entityId, metadata: { operationId: c.op.id } } });
        touched.push(c.entityId);
        return { outcome: 'SUCCEEDED' };
      },
    };
    const makeSchools = async (prefix: string, n: number) => {
      await p().school.createMany({ data: Array.from({ length: n }, (_, i) => ({ name: `${prefix} ${i}`, location: 'Kigali' })) });
      return (await p().school.findMany({ where: { name: { startsWith: prefix } }, select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
    };
    const itemIds = async (opId: string) => (await p().bulkOperationItem.findMany({ where: { operationId: opId }, select: { entityId: true, userId: true } }));
    const scan = async (search: string) => (await p().school.findMany({ where: { name: { contains: search, mode: 'insensitive' } }, select: { id: true } })).map((s) => s.id).sort();
    function pauseAfterLock() {
      const orig = service.lockTables.bind(service);
      const reached = gate(); const go = gate();
      vi.spyOn(service, 'lockTables').mockImplementationOnce(async (tx, tables) => { await orig(tx, tables); reached.open(); await go.wait; });
      return { reached: reached.wait, go: go.open };
    }

    beforeAll(() => registry.register(handler));
    afterAll(() => registry.unregister('TEST_SCHOOL'));

    it('preview, execute, items (entityId, userId null), actions list, old routes never show it', async () => {
      const ids = await makeSchools('Gen Alpha', 3);
      const pv = await preview('TEST_SCHOOL', { action: 'touch', selection: { mode: 'filter', filter: { search: 'gen alpha' } } }).expect(200);
      expect(pv.body).toMatchObject({ entityType: 'TEST_SCHOOL', total: 3 });
      const res = await execute('TEST_SCHOOL', confirmBody(pv)).expect(202);
      expect(res.body.operation).toMatchObject({ entityType: 'TEST_SCHOOL', action: 'touch', total: 3 });
      await drain();
      const items = await http().get(`${G}/operations/${res.body.operation.id}/items`).set(bearer(admin)).expect(200);
      expect(items.body.data.map((i: any) => [i.entityId, i.userId, i.outcome, i.school?.id]).sort()).toEqual(ids.map((id) => [id, null, 'SUCCEEDED', id]).sort());
      expect((await http().get(`${G}/actions`).set(bearer(admin)).expect(200)).body.entityTypes.map((t: any) => t.entityType)).toEqual(expect.arrayContaining(['TEST_SCHOOL', 'USER']));
      // The USER-only routes do not see another type's operation.
      await http().get(`/api/v1/admin/users/bulk/${res.body.operation.id}`).set(bearer(admin)).expect(404);
      expect((await http().get('/api/v1/admin/users/bulk').set(bearer(admin)).expect(200)).body.data.map((o: any) => o.id)).not.toContain(res.body.operation.id);
      // The same idempotency key cannot be reused for another record type.
      const upv = await preview('USER', { action: 'suspend', selection: { mode: 'ids', ids: [ctx.ids.mentorSenior] } }).expect(200);
      expect(await code(execute('USER', { ...confirmBody(upv, { reason: 'Key reuse' }), idempotencyKey: res.body.operation.idempotencyKey }))).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      // No export for this type; users.bulkManage alone is not enough for its action either.
      expect(await code(http().post(`${G}/TEST_SCHOOL/export`).set(bearer(admin)).send({ selection: { mode: 'ids', ids } }))).toEqual([404, 'BULK_EXPORT_UNAVAILABLE']);
      await makeAdmin('engine.noschools');
      await deny('engine.noschools', 'schools.manage');
      expect(await code(preview('TEST_SCHOOL', { action: 'touch', selection: { mode: 'ids', ids } }, await login(ctx, 'engine.noschools')))).toEqual([403, 'PERMISSION_REQUIRED']);
    });

    it('membership: a matching school inserted, or renamed into the filter, while the operation is created waits and is consistently excluded', async () => {
      await makeSchools('Gen Beta', 3);
      const pv = await preview('TEST_SCHOOL', { action: 'touch', selection: { mode: 'filter', filter: { search: 'gen beta' } } }).expect(200);
      const before = await scan('gen beta');
      const outside = (await makeSchools('Elsewhere Beta', 1))[0];
      const pause = pauseAfterLock();
      const creating = execute('TEST_SCHOOL', confirmBody(pv)).then((r) => r);   // supertest sends on then()
      await pause.reached;
      const c1 = await connect(); const c2 = await connect();
      try {
        const insert = c1.query(`INSERT INTO "School" ("id", "name", "location", "updatedAt") VALUES (gen_random_uuid()::text, 'Gen Beta late', 'Kigali', NOW())`);
        const rename = c2.query(`UPDATE "School" SET "name" = 'Gen Beta renamed' WHERE "id" = $1`, [outside]);
        expect(await settledWithin(insert, 400)).toBe('pending');    // the SHARE lock holds writers
        expect(await settledWithin(rename, 100)).toBe('pending');
        pause.go();
        const res = await creating;
        expect(res.status).toBe(202);
        await insert; await rename;
        const items = (await itemIds(res.body.operation.id)).map((i) => i.entityId).sort();
        expect(items).toEqual(before);                                 // exactly the confirmed set at commit
        expect(await scan('gen beta')).toHaveLength(before.length + 2); // the late writes landed after it
      } finally { await c1.end(); await c2.end(); }
      await drain();
    });

    it('membership: a write in flight is waited for; the changed set → 409 SELECTION_CHANGED, nothing created', async () => {
      await makeSchools('Gen Gamma', 2);
      const pv = await preview('TEST_SCHOOL', { action: 'touch', selection: { mode: 'filter', filter: { search: 'gen gamma' } } }).expect(200);
      const c = await connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO "School" ("id", "name", "location", "updatedAt") VALUES (gen_random_uuid()::text, 'Gen Gamma new', 'Kigali', NOW())`);
        const before = await opCount();
        const creating = execute('TEST_SCHOOL', confirmBody(pv)).then((r) => r);   // supertest sends on then()
        expect(await settledWithin(creating, 500)).toBe('pending');
        await c.query('COMMIT');
        expect(await code(creating)).toEqual([409, 'SELECTION_CHANGED']);
        expect(await opCount()).toBe(before);
      } finally { await c.end(); }
    });

    it('recovery: a crash between the change and its result, then a stale-claim takeover → applied exactly once; concurrent workers never double-process', async () => {
      const ids = await makeSchools('Gen Delta', 4);
      const pv = await preview('TEST_SCHOOL', { action: 'touch', selection: { mode: 'ids', ids } }).expect(200);
      const res = await execute('TEST_SCHOOL', confirmBody(pv)).expect(202);
      const opId = res.body.operation.id;
      const orig = worker.record.bind(worker);
      let stage = 0;
      vi.spyOn(worker, 'record').mockImplementation(async (tx, item: ClaimedItem, outcome, ...rest) => {
        if (stage === 0 && outcome === 'SUCCEEDED' && item.entityId === ids[1]) { stage = 1; throw new Error('simulated crash after the change'); }
        if (stage === 1 && outcome === 'FAILED') { stage = 2; throw new Error('simulated crash: the database went away'); }
        return orig(tx, item, outcome, ...rest);
      });
      await expect(worker.processBatch()).rejects.toThrow(/database went away/);
      vi.restoreAllMocks();
      const touchedOf = (id: string) => p().auditLog.count({ where: { action: 'TEST_SCHOOL_TOUCHED', entityId: id } });
      expect(await touchedOf(ids[1])).toBe(0);   // rolled back with its result
      expect((await p().bulkOperationItem.findFirstOrThrow({ where: { operationId: opId, entityId: ids[1] } })).outcome).toBe('PROCESSING');
      // Not yet stale: nobody takes it over.
      expect(await worker.processBatch()).toBe(0);
      await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "operationId" = '${opId}' AND "outcome" = 'PROCESSING'`);
      await Promise.all([drain(), drain(), drain()]);
      for (const id of ids) expect(await touchedOf(id)).toBe(1);
      const op = await http().get(`${G}/operations/${opId}`).set(bearer(admin)).expect(200);
      expect(op.body).toMatchObject({ status: 'COMPLETED', succeeded: 4, failed: 0, skipped: 0, pending: 0, processing: 0 });
      expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_FINISHED', entityId: opId } })).toBe(1);
      // Cancel after the end: refused; the results stay.
      expect(await code(http().post(`${G}/operations/${opId}/cancel`).set(bearer(admin)))).toEqual([409, 'OPERATION_FINISHED']);
    });

    it('cancel: pending records are skipped (CANCELLED), none of them touched', async () => {
      const ids = await makeSchools('Gen Epsilon', 3);
      const pv = await preview('TEST_SCHOOL', { action: 'touch', selection: { mode: 'ids', ids } }).expect(200);
      const res = await execute('TEST_SCHOOL', confirmBody(pv)).expect(202);
      const c = await http().post(`${G}/operations/${res.body.operation.id}/cancel`).set(bearer(admin)).expect(200);
      expect(c.body).toMatchObject({ status: 'CANCELLED', skipped: 3 });
      await drain();
      expect(await p().auditLog.count({ where: { action: 'TEST_SCHOOL_TOUCHED', entityId: { in: ids } } })).toBe(0);
    });
  });
});
