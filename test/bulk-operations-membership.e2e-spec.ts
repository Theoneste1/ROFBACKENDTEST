/**
 * Bulk operations — the membership guard (owner review of #59, round 2). Creating an operation holds the membership
 * advisory lock EXCLUSIVELY; every write that can change filter membership takes it SHARED (database trigger
 * user_bulk_membership_guard). Real concurrent connections and a pause hook right after the lock is acquired:
 *  (a) an account that becomes eligible while the operation is being created waits, and is consistently excluded;
 *  (b) a matching account INSERTED meanwhile waits, and is excluded;
 *  (c) a membership write already in flight is waited for; the changed set → 409 SELECTION_CHANGED, nothing created;
 *  (d) a sign-in during creation is not delayed (sign-in columns are not guarded);
 *  a deadlock (the administrator's own row deleted by direct SQL meanwhile) is retried, never hangs or half-creates;
 *  and the lock-holding time at 5 000 and 50 000 accounts is measured.
 * Invariant in every case: the operation's items equal the filter's membership at the moment it committed.
 * Runs on its own freshly reset test database (never production).
 */
import pg from 'pg';

import { BulkOperationsService } from '../src/users/bulk/bulk-operations.service.js';
import { MEMBERSHIP_COLUMNS } from '../src/users/bulk/bulk-rules.js';
import { userListWhere } from '../src/users/users.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Bulk operations — membership guard', () => {
  let ctx: TestContext;
  let admin: string;
  let service: BulkOperationsService;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  let keyN = 0;
  const key = () => `mem-key-${++keyN}-${Date.now()}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settledWithin = (pr: Promise<unknown>, ms: number) => Promise.race([pr.then(() => 'settled', () => 'settled'), sleep(ms).then(() => 'pending')]);
  const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { open, wait }; };
  async function connect() { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; }
  async function sql(text: string, values: unknown[] = []) { const c = await connect(); try { return await c.query(text, values); } finally { await c.end(); } }

  async function confirmed(filter: Record<string, unknown>, action = 'suspend') {
    const selection = { mode: 'filter', filter };
    const pv = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send({ action, selection }).expect(200);
    return { action, selection, selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total, confirm: true, idempotencyKey: key(), reason: 'Membership test' };
  }
  const execute = (body: Record<string, unknown>, token = admin) => http().post('/api/v1/admin/users/bulk').set(bearer(token)).send(body).then((r) => r);
  async function makeUsers(prefix: string, count: number, data: Record<string, unknown> = {}) {
    for (let i = 0; i < count; i += 5000) {
      await p().user.createMany({
        data: Array.from({ length: Math.min(5000, count - i) }, (_, j) => ({
          username: `${prefix}.${String(i + j).padStart(6, '0')}`, firstName: prefix, lastName: `N${i + j}`, email: `${prefix}.${i + j}@test.local`,
          role: 'MENTOR' as const, passwordHash: hash, activatedAt: new Date(), ...data,
        })),
      });
    }
    return (await p().user.findMany({ where: { username: { startsWith: `${prefix}.` } }, select: { id: true }, orderBy: { id: 'asc' } })).map((u) => u.id);
  }
  /** Pauses the next creation right after it acquired the membership lock. */
  function pauseAfterLock() {
    const orig = service.acquireMembershipLock.bind(service);
    const reached = gate(); const go = gate();
    let lockedAt = 0;
    vi.spyOn(service, 'acquireMembershipLock').mockImplementationOnce(async (tx) => { await orig(tx); lockedAt = Date.now(); reached.open(); await go.wait; });
    return { reached: reached.wait, go: go.open, lockedAt: () => lockedAt };
  }
  const itemIds = async (opId: string) => (await p().bulkOperationItem.findMany({ where: { operationId: opId }, select: { userId: true } })).map((i) => i.userId).sort();
  /** The filter membership now, with exactly the server's where clause. */
  const scan = async (filter: Record<string, unknown>) => (await p().user.findMany({ where: userListWhere(filter as never), select: { id: true } })).map((u) => u.id).sort();

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    service = ctx.app.get(BulkOperationsService);
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await ctx?.app.close(); });

  it('the trigger guards exactly the columns the filters read (and fires on INSERT and DELETE)', async () => {
    // The trigger as the database has it now (re-created by 20261224000000 with "olympiadLevel"), not as a file says.
    const [{ def }] = await p().$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'user_bulk_membership_guard'`;
    const cols = [...def.match(/UPDATE OF (.*?) ON /)![1].matchAll(/"?([A-Za-z]+)"?/g)].map((m) => m[1]).sort();
    expect(cols).toEqual([...MEMBERSHIP_COLUMNS].sort());
    const tg = await p().$queryRaw<Array<{ ins: boolean; del: boolean }>>`
      SELECT (tgtype & 4) <> 0 AS ins, (tgtype & 8) <> 0 AS del FROM pg_trigger WHERE tgname = 'user_bulk_membership_guard'`;
    expect(tg).toEqual([{ ins: true, del: true }]);
  });

  it('(a) an account that becomes eligible during creation waits; the operation excludes it consistently', async () => {
    const ids = await makeUsers('mema', 3);
    const [outsider] = await makeUsers('memax', 1, { role: 'TEACHER' });   // matches the search, not the role
    const filter = { search: 'mema', role: 'MENTOR' };
    const body = await confirmed(filter);
    const hook = pauseAfterLock();
    const res = execute(body);
    await hook.reached;
    const write = sql(`UPDATE "User" SET "role" = 'MENTOR' WHERE "id" = $1`, [outsider]);   // would make it match
    expect(await settledWithin(write, 1000)).toBe('pending');        // waits for the operation
    expect(await scan(filter)).toEqual([...ids].sort());             // membership unchanged while the lock is held
    hook.go();
    const r = await res;
    expect(r.status).toBe(202);
    expect(await itemIds(r.body.operation.id)).toEqual([...ids].sort());   // = membership at commit
    await write;                                                     // applied after the operation committed
    expect((await p().user.findUniqueOrThrow({ where: { id: outsider } })).role).toBe('MENTOR');
  });

  it('(b) a matching account INSERTED during creation waits; the operation excludes it', async () => {
    const ids = await makeUsers('memb', 3);
    const body = await confirmed({ search: 'memb' });
    const hook = pauseAfterLock();
    const res = execute(body);
    await hook.reached;
    const insert = sql(`INSERT INTO "User" (id, "firstName", "lastName", username, email, role, "activatedAt", "updatedAt")
                        VALUES (gen_random_uuid(), 'memb', 'New', 'memb.new', 'memb.new@test.local', 'MENTOR', now(), now())`);
    expect(await settledWithin(insert, 1000)).toBe('pending');
    hook.go();
    const r = await res;
    expect(r.status).toBe(202);
    expect(await itemIds(r.body.operation.id)).toEqual([...ids].sort());
    await insert;
    expect(await p().user.count({ where: { username: 'memb.new' } })).toBe(1);
  });

  it('(c) a membership write already in flight is waited for; the changed set → 409, nothing created', async () => {
    const ids = await makeUsers('memc', 3);
    const body = await confirmed({ search: 'memc', role: 'MENTOR' });
    const writer = await connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE "User" SET "role" = 'TEACHER' WHERE "id" = $1`, [ids[0]]);   // holds the shared lock
      const res = execute(body);
      expect(await settledWithin(res, 1000)).toBe('pending');        // creation waits for the in-flight write
      await writer.query('COMMIT');
      const r = await res;
      expect([r.status, r.body.code]).toEqual([409, 'SELECTION_CHANGED']);
      expect(await p().bulkOperation.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(0);
    } finally { await writer.end(); }
  });

  it('(d) a sign-in during creation is not delayed — also a failed one (sign-in columns are not guarded)', async () => {
    await makeUsers('memd', 3);
    const body = await confirmed({ search: 'memd' });
    const hook = pauseAfterLock();
    const res = execute(body);
    await hook.reached;
    const t0 = Date.now();
    await http().post('/api/v1/auth/login').send({ username: 'memd.000000', password: PASSWORD }).expect(200);   // a selected account
    await http().post('/api/v1/auth/login').send({ username: 'memd.000001', password: 'wrong-password' }).expect(401);
    expect(Date.now() - t0).toBeLessThan(3000);
    hook.go();
    expect((await res).status).toBe(202);
  });

  it('a deadlock during creation (the administrator\'s own row deleted by direct SQL) is retried — no hang, no half-created operation', async () => {
    const owner = await p().user.create({ data: { username: 'mem.owner', firstName: 'M', lastName: 'O', email: 'mem.owner@test.local', role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    // A history row the DELETE cannot cascade: the raw DELETE finally fails (the account survives).
    await p().userStatusChange.create({ data: { userId: owner.id, fromStatus: 'ACTIVE', toStatus: 'ACTIVE', actorRole: 'OPERATOR' } });
    const token = await login(ctx, 'mem.owner');
    await makeUsers('meme', 3);
    const pv = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(token)).send({ action: 'suspend', selection: { mode: 'filter', filter: { search: 'meme' } } }).expect(200);
    const body = { action: 'suspend', selection: { mode: 'filter', filter: { search: 'meme' } }, selectionToken: pv.body.selectionToken, expectedTotal: 3, confirm: true, idempotencyKey: key(), reason: 'Deadlock test' };
    const hook = pauseAfterLock();
    const res = execute(body, token);
    await hook.reached;
    const del = sql(`DELETE FROM "User" WHERE "id" = $1`, [owner.id]).then(() => 'deleted', (e) => String(e.code ?? e.message));
    await sleep(300);                                                // the DELETE holds the row, waits for the shared lock
    hook.go();                                                       // creation now needs a KEY SHARE on that row
    const [r, d] = await Promise.all([res, del]);
    expect([202, 503]).toContain(r.status);
    expect(d).not.toBe('deleted');                                   // deadlock victim (40P01) or FK refusal (23503)
    const ops = await p().bulkOperation.findMany({ where: { idempotencyKey: body.idempotencyKey } });
    expect(ops).toHaveLength(r.status === 202 ? 1 : 0);
    if (r.status === 202) expect(await p().bulkOperationItem.count({ where: { operationId: ops[0].id } })).toBe(3);
    process.stderr.write(`\n[deadlock] creation answered ${r.status}; the raw DELETE ended with ${d}\n`);
  });

  it.each([5000, 50000])('lock-holding time and the wait of a concurrent membership write, %i accounts', async (n) => {
    const prefix = `memp${n}`;
    const ids = await makeUsers(prefix, n);
    const body = await confirmed({ search: prefix });
    expect(body.expectedTotal).toBe(n);
    const orig = service.acquireMembershipLock.bind(service);
    let lockedAt = 0;
    let write = null as Promise<number> | null;
    vi.spyOn(service, 'acquireMembershipLock').mockImplementationOnce(async (tx) => {
      await orig(tx);
      lockedAt = Date.now();
      const started = Date.now();
      write = sql(`UPDATE "User" SET "role" = 'TEACHER' WHERE "id" = $1`, [ids[0]]).then(() => Date.now() - started);   // waits for the operation
    });
    const t0 = Date.now();
    const r = await execute(body);
    const done = Date.now();
    expect(r.status).toBe(202);
    const waited = await write!;
    process.stderr.write(`\n[lock ${n}] request ${done - t0} ms; lock held ≈ ${done - lockedAt} ms; a concurrent membership write waited ${waited} ms\n`);
    expect(await p().bulkOperationItem.count({ where: { operationId: r.body.operation.id } })).toBe(n);
    expect(waited).toBeGreaterThan(0);
  }, 600_000);
});
