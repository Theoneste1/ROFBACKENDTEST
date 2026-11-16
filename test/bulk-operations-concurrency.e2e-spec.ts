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
import { BulkOperationsWorker, type ClaimedItem } from '../src/users/bulk/bulk-operations.worker.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Bulk user operations — atomicity, recovery and cancellation (review fixes)', () => {
  let ctx: TestContext;
  let admin: string;
  let worker: BulkOperationsWorker;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  let keyN = 0;
  const key = () => `conc-key-${++keyN}-${Date.now()}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Resolves to 'pending' if the promise has not settled within `ms`. */
  const settledWithin = (pr: Promise<unknown>, ms: number) => Promise.race([pr.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);
  const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { open, wait }; };

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
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await ctx?.app.close(); });

  // A (selection atomicity) is covered with the membership lock in bulk-operations-membership.e2e-spec.ts.

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

    it('a worker whose claim was taken over (stalled before its item transaction) changes nothing; the new claim applies it once', async () => {
      const ids = await makeUsers('stall', 1);
      const res = await execute(await confirmed('archive', { mode: 'ids', ids }, { reason: 'Stall test' })).expect(202);
      const opId = res.body.operation.id;
      const orig = worker.statusPrecheck.bind(worker);
      const reached = gate(); const go = gate();
      vi.spyOn(worker, 'statusPrecheck').mockImplementationOnce(async (id) => { const s = await orig(id); reached.open(); await go.wait; return s; });
      const slow = worker.processBatch();
      await reached.wait;                                    // the first worker stalls before its item transaction
      await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "claimToken" = 'taken-over' WHERE "operationId" = '${opId}'`);
      go.open();
      await slow;
      expect(await p().userStatusChange.count({ where: { operationId: opId } })).toBe(0);   // claim lost: nothing changed
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

  describe('C2 — the status re-check and the change share one transaction, for every action (owner review, round 2)', () => {
    type Kind = 'suspend' | 'assignRole' | 'changeClassification' | 'message';
    let setN = 0;
    /** Three accounts and a confirmed operation of this kind. */
    async function setUp(kind: Kind) {
      const junior = await p().division.findFirstOrThrow({ where: { code: 'JUNIOR' } });
      const students = kind === 'assignRole' || kind === 'changeClassification';
      const ids = await makeUsers(`c2${kind.slice(0, 4).toLowerCase()}${++setN}`, 3,
        students ? { role: 'STUDENT', gradeLevel: 'S2', divisionId: junior.id } : {});
      const params = kind === 'assignRole' ? { role: 'MENTOR' } : kind === 'changeClassification' ? { gradeLevel: 'S5' }
        : kind === 'message' ? { subject: 'Cancel test', body: 'This must not be sent after a cancel.' } : undefined;
      const res = await execute(await confirmed(kind, { mode: 'ids', ids }, kind === 'suspend' ? { reason: 'Cancel test' } : {}, params)).expect(202);
      return { ids, opId: res.body.operation.id as string };
    }
    /** Whether the operation changed (or e-mailed) this account. */
    async function changed(kind: Kind, opId: string, userId: string) {
      const u = await p().user.findUniqueOrThrow({ where: { id: userId } });
      if (kind === 'suspend') return (await p().userStatusChange.count({ where: { operationId: opId, userId } })) === 1 && u.accountStatus === 'SUSPENDED';
      if (kind === 'assignRole') return u.role === 'MENTOR';
      if (kind === 'changeClassification') return u.gradeLevel === 'S5';
      const op = await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } });
      return (await p().emailDelivery.count({ where: { jobId: op.emailJobId!, recipientId: userId } })) === 1;
    }
    async function outcomes(opId: string) {
      return p().bulkOperationItem.findMany({ where: { operationId: opId }, select: { userId: true, outcome: true, code: true } });
    }
    const cancel = (opId: string) => http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)).then((r) => r);

    it.each(['suspend', 'assignRole', 'changeClassification', 'message'] as const)(
      '%s (i): paused after the unlocked status check, the cancel commits → nothing changed or e-mailed, SKIPPED (CANCELLED)', async (kind) => {
        const { ids, opId } = await setUp(kind);
        const orig = worker.statusPrecheck.bind(worker);
        const reached = gate(); const go = gate();
        vi.spyOn(worker, 'statusPrecheck').mockImplementationOnce(async (id) => { const s = await orig(id); reached.open(); await go.wait; return s; });
        const batch = worker.processBatch();
        await reached.wait;                                  // the first account passed the check (RUNNING) …
        const c = await cancel(opId);                        // … and the cancel commits before its transaction
        expect([c.status, c.body.status]).toEqual([200, 'CANCELLING']);
        go.open();
        await batch;
        await drain();
        for (const id of ids) expect(await changed(kind, opId, id)).toBe(false);
        expect((await outcomes(opId)).every((i) => i.outcome === 'SKIPPED' && i.code === 'CANCELLED')).toBe(true);
        expect((await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } })).status).toBe('CANCELLED');
      });

    it.each(['suspend', 'assignRole', 'changeClassification', 'message'] as const)(
      '%s (ii): the worker holds the operation lock → the cancel waits; that account SUCCEEDED and changed, later ones cancelled', async (kind) => {
        const { ids, opId } = await setUp(kind);
        const orig = worker.lockOperation.bind(worker);
        const reached = gate(); const go = gate();
        vi.spyOn(worker, 'lockOperation').mockImplementationOnce(async (tx, id) => { const s = await orig(tx, id); reached.open(); await go.wait; return s; });
        const batch = worker.processBatch();
        await reached.wait;                                  // the first account's transaction holds the operation FOR SHARE
        const c = cancel(opId);
        expect(await settledWithin(c, 1000)).toBe('pending');   // the cancel waits for it
        go.open();
        expect((await c).status).toBe(200);
        await batch;
        await drain();
        const items = await outcomes(opId);
        const first = items.filter((i) => i.outcome === 'SUCCEEDED');
        expect(first).toHaveLength(1);
        for (const i of items) expect([i.userId, i.outcome === 'SUCCEEDED']).toEqual([i.userId, await changed(kind, opId, i.userId)]);
        expect(items.filter((i) => i.code === 'CANCELLED')).toHaveLength(2);
        expect(ids).toContain(first[0].userId);
        expect((await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } })).status).toBe('CANCELLED');
      });

    it('deadlock freedom: a cancel racing two workers claiming and processing, 20 rounds — always truthful, never stuck', async () => {
      for (let round = 0; round < 20; round++) {
        await makeUsers(`dl${round}x`, 40);
        const res = await execute(await confirmed('suspend', { mode: 'filter', filter: { search: `dl${round}x` } }, { reason: 'Deadlock test' })).expect(202);
        const opId = res.body.operation.id;
        const [, , c] = await Promise.all([
          worker.processBatch(),
          worker.processBatch(),
          (async () => { await sleep((round % 5) * 10); return http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)); })(),
        ]);
        expect([200, 409]).toContain(c.status);
        await drain();
        const op = await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } });
        expect(['CANCELLED', 'COMPLETED']).toContain(op.status);
        await assertTruthful(opId);
      }
    }, 300_000);
  });

  it('the login of an unrelated account still works', async () => {
    await http().post('/api/v1/auth/login').send({ username: 'student.j2', password: PASSWORD }).expect(200);
  });
});
