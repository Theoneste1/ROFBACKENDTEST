/**
 * Bulk user operations — review fixes A, B and C (2026-11-17), with real concurrent connections and pause hooks:
 *  A. the exact matching set is validated and the operation created atomically: a membership change before the
 *     locks → 409 SELECTION_CHANGED; a change to a selected account while the locks are held waits for the operation;
 *     an account joining after the locks → 409. No stale selection is ever accepted.
 *  B. a crash between a role / grade change and its result cannot happen (one transaction): after the retry the item
 *     is SUCCEEDED (never SKIPPED) and the change was applied exactly once.
 *  C. cancel vs the worker: a cancel waits for an item being changed; claimed items finish truthfully; pending items
 *     are skipped untouched; the operation becomes CANCELLED once nothing is processing. Invariant everywhere: an
 *     item is SUCCEEDED if and only if its account was changed by the operation.
 * Runs on its own freshly reset test database (never production).
 */
import pg from 'pg';

import { BulkOperationsService } from '../src/users/bulk/bulk-operations.service.js';
import { BulkOperationsWorker, type ClaimedItem } from '../src/users/bulk/bulk-operations.worker.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Bulk user operations — atomicity, recovery and cancellation (review fixes)', () => {
  let ctx: TestContext;
  let admin: string;
  let worker: BulkOperationsWorker;
  let service: BulkOperationsService;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  let keyN = 0;
  const key = () => `conc-key-${++keyN}-${Date.now()}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Resolves to 'pending' if the promise has not settled within `ms`. */
  const settledWithin = (pr: Promise<unknown>, ms: number) => Promise.race([pr.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);
  const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { open, wait }; };
  async function sql(text: string, values: unknown[] = []) {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try { return await c.query(text, values); } finally { await c.end(); }
  }

  const preview = (body: Record<string, unknown>) => http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send(body);
  const execute = (body: Record<string, unknown>) => http().post('/api/v1/admin/users/bulk').set(bearer(admin)).send(body);
  async function confirmed(action: string, selection: Record<string, unknown>, extra: Record<string, unknown> = {}, params?: Record<string, unknown>) {
    const pv = await preview({ action, selection, ...(params && { params }) }).expect(200);
    return { action, selection, ...(params && { params }), selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total, confirm: true, idempotencyKey: key(), ...extra };
  }
  async function drain() { while ((await worker.processBatch()) > 0) { /* until nothing is claimable */ } }
  async function makeUsers(prefix: string, count: number, data: Record<string, unknown> = {}) {
    await p().user.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        username: `${prefix}.${String(i).padStart(4, '0')}`, firstName: prefix, lastName: `N${i}`, email: `${prefix}.${i}@test.local`,
        role: 'MENTOR' as const, passwordHash: hash, activatedAt: new Date(), ...data,
      })),
    });
    return (await p().user.findMany({ where: { username: { startsWith: `${prefix}.` } }, select: { id: true }, orderBy: { username: 'asc' } })).map((u) => u.id);
  }
  /** The invariant: SUCCEEDED ⇔ the operation changed the account's state; nothing pending or processing is left. */
  async function assertTruthful(opId: string) {
    const items = await p().bulkOperationItem.findMany({ where: { operationId: opId } });
    const changed = new Set((await p().userStatusChange.findMany({ where: { operationId: opId }, select: { userId: true } })).map((c) => c.userId));
    expect(items.filter((i) => i.outcome === 'PENDING' || i.outcome === 'PROCESSING')).toEqual([]);
    for (const i of items) expect([i.userId, i.outcome === 'SUCCEEDED']).toEqual([i.userId, changed.has(i.userId)]);
    const perUser = await p().userStatusChange.groupBy({ by: ['userId'], where: { operationId: opId }, _count: { _all: true } });
    expect(perUser.every((g) => g._count._all === 1)).toBe(true);
    // Cancelled accounts were not touched.
    const cancelled = items.filter((i) => i.code === 'CANCELLED').map((i) => i.userId);
    expect(await p().user.count({ where: { id: { in: cancelled }, accountStatus: { not: 'ACTIVE' } } })).toBe(0);
    return items;
  }

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    worker = ctx.app.get(BulkOperationsWorker);
    service = ctx.app.get(BulkOperationsService);
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await ctx?.app.close(); });

  describe('A — the confirmed set is validated and the operation created atomically', () => {
    it('a selected account changes role (another connection) between the preview and the locks → 409, nothing created', async () => {
      const ids = await makeUsers('atoma', 4);
      const body = await confirmed('suspend', { mode: 'filter', filter: { search: 'atoma', role: 'MENTOR' } }, { reason: 'Atomicity test' });
      const orig = service.lockSelection.bind(service);
      const reached = gate(); const go = gate();
      vi.spyOn(service, 'lockSelection').mockImplementationOnce(async (tx, list) => { reached.open(); await go.wait; return orig(tx, list); });
      const pending = execute(body).then((r) => r);
      await reached.wait;                                   // execute is inside its transaction, before the locks
      await sql(`UPDATE "User" SET "role" = 'TEACHER' WHERE "id" = $1`, [ids[1]]);   // commits at once (not locked yet)
      go.open();
      const res = await pending;
      expect([res.status, res.body.code]).toEqual([409, 'SELECTION_CHANGED']);
      expect(await p().bulkOperation.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(0);
    });

    it('a change to a selected account while the locks are held waits for the operation; the operation holds exactly the confirmed set', async () => {
      const ids = await makeUsers('atomb', 4);
      const body = await confirmed('suspend', { mode: 'filter', filter: { search: 'atomb', role: 'MENTOR' } }, { reason: 'Atomicity test' });
      const orig = service.lockSelection.bind(service);
      const reached = gate(); const go = gate();
      vi.spyOn(service, 'lockSelection').mockImplementationOnce(async (tx, list) => { await orig(tx, list); reached.open(); await go.wait; });
      const pending = execute(body).then((r) => r);
      await reached.wait;                                   // the four accounts are locked FOR SHARE
      const write = sql(`UPDATE "User" SET "role" = 'TEACHER' WHERE "id" = $1`, [ids[2]]);
      expect(await settledWithin(write, 800)).toBe('pending');   // blocked by the operation's lock
      go.open();
      const res = await pending;
      expect(res.status).toBe(202);
      await write;                                          // lands after the operation was created
      const items = await p().bulkOperationItem.findMany({ where: { operationId: res.body.operation.id }, select: { userId: true } });
      expect(items.map((i) => i.userId).sort()).toEqual([...ids].sort());   // exactly the confirmed set
      expect((await p().user.findUniqueOrThrow({ where: { id: ids[2] } })).role).toBe('TEACHER');
      await drain();
      await assertTruthful(res.body.operation.id);
    });

    it('an account that starts matching while execute holds the locks (status change by another connection) → 409', async () => {
      await makeUsers('atomc', 3);
      const [joiner] = await makeUsers('atomcx', 1, { accountStatus: 'SUSPENDED' });
      const body = await confirmed('deactivate', { mode: 'filter', filter: { search: 'atomc', accountStatus: 'ACTIVE' } }, { reason: 'Atomicity test' });
      expect(body.expectedTotal).toBe(3);
      const orig = service.lockSelection.bind(service);
      const reached = gate(); const go = gate();
      vi.spyOn(service, 'lockSelection').mockImplementationOnce(async (tx, list) => { await orig(tx, list); reached.open(); await go.wait; });
      const pending = execute(body).then((r) => r);
      await reached.wait;
      await sql(`UPDATE "User" SET "accountStatus" = 'ACTIVE' WHERE "id" = $1`, [joiner]);   // not locked: commits
      go.open();
      const res = await pending;
      expect([res.status, res.body.code]).toEqual([409, 'SELECTION_CHANGED']);
      expect(await p().bulkOperation.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(0);
    });

    it('a grade change of a selected student between preview and execute (another connection) → 409', async () => {
      const junior = await p().division.findFirstOrThrow({ where: { code: 'JUNIOR' } });
      const ids = await makeUsers('atomd', 3, { role: 'STUDENT', gradeLevel: 'S2', divisionId: junior.id });
      const body = await confirmed('suspend', { mode: 'filter', filter: { search: 'atomd', gradeLevel: 'S2' } }, { reason: 'Atomicity test' });
      await sql(`UPDATE "User" SET "gradeLevel" = 'S3' WHERE "id" = $1`, [ids[0]]);
      const res = await execute(body);
      expect([res.status, res.body.code]).toEqual([409, 'SELECTION_CHANGED']);
    });
  });

  describe('B — a role or grade change and its result commit together', () => {
    async function crashOnce(userId: string) {
      const orig = worker.record.bind(worker);
      let stage = 0;
      vi.spyOn(worker, 'record').mockImplementation(async (tx, item: ClaimedItem, outcome, ...rest) => {
        if (stage === 0 && outcome === 'SUCCEEDED' && item.userId === userId) { stage = 1; throw new Error('simulated crash after the change'); }
        if (stage === 1 && outcome === 'FAILED') { stage = 2; throw new Error('simulated crash: the database went away'); }
        return orig(tx, item, outcome, ...rest);
      });
    }

    it.each([
      ['assignRole', { role: 'MENTOR' }, 'CHANGE_USER_ROLE', (u: any) => u.role === 'MENTOR'],
      ['changeClassification', { gradeLevel: 'S5' }, 'CHANGE_STUDENT_ENROLLMENT', (u: any) => u.gradeLevel === 'S5'],
    ] as const)('%s: a crash between the change and its result → after the retry SUCCEEDED (never SKIPPED), applied once', async (action, params, auditAction, applied) => {
      const junior = await p().division.findFirstOrThrow({ where: { code: 'JUNIOR' } });
      const ids = await makeUsers(`crash${action.length}`, 3, { role: 'STUDENT', gradeLevel: 'S2', divisionId: junior.id });
      const res = await execute(await confirmed(action, { mode: 'ids', ids }, {}, params)).expect(202);
      const opId = res.body.operation.id;
      await crashOnce(ids[1]);
      await expect(worker.processBatch()).rejects.toThrow(/database went away/);   // the worker "dies" mid-batch
      vi.restoreAllMocks();
      // Nothing of the crashed account's change survived (one transaction), and its item is still claimed.
      expect(applied(await p().user.findUniqueOrThrow({ where: { id: ids[1] } }))).toBe(false);
      expect((await p().bulkOperationItem.findFirstOrThrow({ where: { operationId: opId, userId: ids[1] } })).outcome).toBe('PROCESSING');
      // Its claim expires; another worker takes over.
      await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "operationId" = '${opId}' AND "outcome" = 'PROCESSING'`);
      await drain();
      const items = await p().bulkOperationItem.findMany({ where: { operationId: opId } });
      expect(items.map((i) => i.outcome)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
      for (const id of ids) {
        expect(applied(await p().user.findUniqueOrThrow({ where: { id } }))).toBe(true);
        expect(await p().auditLog.count({ where: { action: auditAction, entityId: id } })).toBe(1);
      }
      expect((await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } })).status).toBe('COMPLETED');
    });

    it('a stalled worker that lost its claim cannot record — its change is rolled back; the new claim applies it once', async () => {
      const ids = await makeUsers('stall', 1);
      const res = await execute(await confirmed('archive', { mode: 'ids', ids }, { reason: 'Stall test' })).expect(202);
      const opId = res.body.operation.id;
      const orig = worker.record.bind(worker);
      const reached = gate(); const go = gate();
      vi.spyOn(worker, 'record').mockImplementationOnce(async (...a) => { reached.open(); await go.wait; return orig(...a); });
      const slow = worker.processBatch();
      await reached.wait;                                    // the first worker is inside its transaction, stalled
      // Meanwhile its claim is considered expired and taken over (the stalled transaction holds the user row: the
      // second change waits, so the takeover is driven by a separate claim of the item).
      await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "claimToken" = 'taken-over' WHERE "operationId" = '${opId}'`);
      go.open();
      await slow;
      expect(await p().userStatusChange.count({ where: { operationId: opId } })).toBe(0);   // rolled back: claim lost
      expect((await p().user.findUniqueOrThrow({ where: { id: ids[0] } })).accountStatus).toBe('ACTIVE');
      await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "operationId" = '${opId}'`);
      await drain();
      await assertTruthful(opId);
      expect(await p().userStatusChange.count({ where: { operationId: opId } })).toBe(1);
    });
  });

  describe('C — cancel and the worker', () => {
    it('cancel while a worker is changing a claimed account: the cancel waits; claimed items end truthfully; pending items are skipped untouched', async () => {
      await makeUsers('cancelmid', 205);   // one batch of 200 is claimed; 5 stay pending
      const res = await execute(await confirmed('suspend', { mode: 'filter', filter: { search: 'cancelmid' } }, { reason: 'Cancel test' })).expect(202);
      const opId = res.body.operation.id;
      const orig = worker.record.bind(worker);
      const reached = gate(); const go = gate();
      let first = true;
      vi.spyOn(worker, 'record').mockImplementation(async (tx, item, outcome, ...rest) => {
        if (first && outcome === 'SUCCEEDED') { first = false; reached.open(); await go.wait; }
        return orig(tx, item, outcome, ...rest);
      });
      const batch = worker.processBatch();
      await reached.wait;                                    // account 1's change is written, its transaction open
      const cancel = http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)).then((r) => r);
      expect(await settledWithin(cancel, 800)).toBe('pending');   // waits for the item being changed
      go.open();
      const c = await cancel;
      expect(c.status).toBe(200);
      expect(['CANCELLING', 'CANCELLED']).toContain(c.body.status);
      await batch;
      await drain();
      const op = await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } });
      expect(op.status).toBe('CANCELLED');
      const items = await assertTruthful(opId);
      expect(items.filter((i) => i.outcome === 'SUCCEEDED').length).toBeGreaterThanOrEqual(1);
      expect(items.filter((i) => i.code === 'CANCELLED').length).toBeGreaterThanOrEqual(5);
      expect(op.succeeded + op.skipped + op.failed).toBe(205);
      expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_FINISHED', entityId: opId } })).toBe(1);
    });

    it('cancel racing the claim of a batch (repeated): every outcome is truthful, nothing is left processing', async () => {
      for (let round = 0; round < 6; round++) {
        await makeUsers(`race${round}x`, 230);
        const res = await execute(await confirmed('archive', { mode: 'filter', filter: { search: `race${round}x` } }, { reason: 'Race test' })).expect(202);
        const opId = res.body.operation.id;
        const [, cancel] = await Promise.all([
          worker.processBatch(),
          (async () => { await sleep(round * 15); return http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)); })(),
        ]);
        expect([200, 409]).toContain(cancel.status);
        await drain();
        const op = await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } });
        expect(['CANCELLED', 'COMPLETED']).toContain(op.status);
        if (cancel.status === 200) expect(op.status).toBe('CANCELLED');
        await assertTruthful(opId);
        expect(op.succeeded + op.skipped + op.failed).toBe(230);
      }
    }, 300_000);

    it('a cancel that committed before an item\'s processing started: that item is skipped, nothing changed', async () => {
      const ids = await makeUsers('precancel', 3);
      const res = await execute(await confirmed('deactivate', { mode: 'ids', ids }, { reason: 'Pre-cancel test' })).expect(202);
      const opId = res.body.operation.id;
      const claimed = await worker.claim();                  // the worker claimed the items …
      expect(claimed).toHaveLength(3);
      const c = await http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)).expect(200);
      expect(c.body).toMatchObject({ status: 'CANCELLING', processing: 3 });   // … so the cancel cannot skip them
      // The claim is processed after the cancel: nothing is changed, each is recorded as skipped (cancelled).
      await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "operationId" = '${opId}'`);
      await drain();
      expect((await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } })).status).toBe('CANCELLED');
      const items = await assertTruthful(opId);
      expect(items.every((i) => i.outcome === 'SKIPPED' && i.code === 'CANCELLED')).toBe(true);
      expect(await p().user.count({ where: { id: { in: ids }, accountStatus: 'ACTIVE' } })).toBe(3);
    });
  });

  it('the login of an unrelated account still works', async () => {
    await http().post('/api/v1/auth/login').send({ username: 'student.j2', password: PASSWORD }).expect(200);
  });
});
