/**
 * Super Administrator change notices and outer transactions (owner review of #59, round 2). When a role change runs
 * inside an OUTER transaction (bulk assignRole; UsersService.update with { tx, afterCommit }), its "Super Administrator
 * change" notice is queued only after that transaction commits:
 *  - an outer rollback (a failure injected after the change) sends nothing — no e-mail row, no notice call;
 *  - a successful commit sends it exactly once (one e-mail per active Super Admin);
 *  - a retry of the same bulk item sends nothing more;
 *  - the ordinary, non-bulk path (no outer transaction) still sends exactly once.
 * Runs on its own freshly reset test database (never production).
 */
import { AccountEmailsService } from '../src/notifications/account-emails.service.js';
import { BulkOperationsWorker, type ClaimedItem } from '../src/users/bulk/bulk-operations.worker.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Super Administrator notices after commit (outer transactions)', () => {
  let ctx: TestContext;
  let worker: BulkOperationsWorker;
  let users: UsersService;
  let emails: AccountEmailsService;
  let hash: string;
  let sa1: { id: string; role: string; username: string };
  let saToken: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  let n = 0;
  const notices = () => p().emailDelivery.count({ where: { subject: { contains: 'Super Administrator change' } } });
  const superAdmins = () => p().user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
  async function make(username: string, role: 'ADMIN' | 'SUPER_ADMIN') {
    return p().user.create({ data: { username, firstName: username, lastName: 'N', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
  }
  const caller = () => ({ id: sa1.id, role: 'SUPER_ADMIN', username: sa1.username, overrides: [] }) as never;

  beforeAll(async () => {
    ctx = await createTestApp();
    worker = ctx.app.get(BulkOperationsWorker);
    users = ctx.app.get(UsersService);
    emails = ctx.app.get(AccountEmailsService);
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    sa1 = await make('notice.sa1', 'SUPER_ADMIN');
    saToken = await login(ctx, 'notice.sa1');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await ctx?.app.close(); });

  it('UsersService.update inside an outer transaction that rolls back: no notice at all', async () => {
    const target = await make(`notice.t${++n}`, 'ADMIN');
    const spy = vi.spyOn(emails, 'superAdminChanged');
    const before = await notices();
    const afterCommit: Array<() => Promise<void>> = [];
    await expect(p().$transaction(async (tx) => {
      await users.update(target.id, { role: 'SUPER_ADMIN' } as never, caller(), { stepUpVerified: true, tx, afterCommit });
      throw new Error('injected failure after the change');
    })).rejects.toThrow('injected failure');
    // The caller runs afterCommit only after a commit — here there was none.
    expect(afterCommit).toHaveLength(1);                     // queued, not sent
    expect(spy).not.toHaveBeenCalled();
    expect(await notices()).toBe(before);
    expect((await p().user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ADMIN');   // rolled back
  });

  it('UsersService.update inside an outer transaction that commits: the notice is sent once, after the commit', async () => {
    const target = await make(`notice.t${++n}`, 'ADMIN');
    const spy = vi.spyOn(emails, 'superAdminChanged');
    const before = await notices();
    const afterCommit: Array<() => Promise<void>> = [];
    await p().$transaction(async (tx) => {
      await users.update(target.id, { role: 'SUPER_ADMIN' } as never, caller(), { stepUpVerified: true, tx, afterCommit });
      expect(spy).not.toHaveBeenCalled();                    // nothing before the commit
    });
    for (const fn of afterCommit) await fn();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await notices()).toBe(before + (await superAdmins()));   // one e-mail to each active Super Admin
    // Demote it again (same path) so later tests start from one Super Admin besides sa1.
    const back: Array<() => Promise<void>> = [];
    await p().$transaction(async (tx) => { await users.update(target.id, { role: 'ADMIN' } as never, caller(), { stepUpVerified: true, tx, afterCommit: back }); });
    for (const fn of back) await fn();
  });

  it('bulk assignRole: a crash after the change sends nothing; the retried item sends exactly once; another retry sends nothing more', async () => {
    const other = await make(`notice.sa${++n}`, 'SUPER_ADMIN');
    const before = await notices();
    const selection = { mode: 'ids', ids: [other.id] };
    const pv = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(saToken)).send({ action: 'assignRole', selection, params: { role: 'ADMIN' } }).expect(200);
    expect(pv.body.requiresStepUp).toBe(true);
    const body = { action: 'assignRole', selection, params: { role: 'ADMIN' }, selectionToken: pv.body.selectionToken, expectedTotal: 1, confirm: true, idempotencyKey: `notice-${Date.now()}`, currentPassword: PASSWORD };
    const res = await http().post('/api/v1/admin/users/bulk').set(bearer(saToken)).send(body).expect(202);
    const opId = res.body.operation.id;

    // The worker "dies" right after the change (inside the item transaction): everything rolls back.
    const orig = worker.record.bind(worker);
    let stage = 0;
    vi.spyOn(worker, 'record').mockImplementation(async (tx, item: ClaimedItem, outcome, ...rest) => {
      if (stage === 0 && outcome === 'SUCCEEDED') { stage = 1; throw new Error('simulated crash after the change'); }
      if (stage === 1 && outcome === 'FAILED') { stage = 2; throw new Error('simulated crash: the database went away'); }
      return orig(tx, item, outcome, ...rest);
    });
    const spy = vi.spyOn(emails, 'superAdminChanged');
    await expect(worker.processBatch()).rejects.toThrow(/database went away/);
    expect(spy).not.toHaveBeenCalled();
    expect(await notices()).toBe(before);
    expect((await p().user.findUniqueOrThrow({ where: { id: other.id } })).role).toBe('SUPER_ADMIN');
    vi.restoreAllMocks();

    // The claim expires; the item is retried: the change is applied and the notice sent once.
    const recipients = await superAdmins();                  // before the demotion: sa1 and the target
    await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "operationId" = '${opId}'`);
    const spy2 = vi.spyOn(emails, 'superAdminChanged');
    while ((await worker.processBatch()) > 0) { /* drain */ }
    expect(spy2).toHaveBeenCalledTimes(1);
    expect((await p().user.findUniqueOrThrow({ where: { id: other.id } })).role).toBe('ADMIN');
    expect(await p().bulkOperationItem.findFirstOrThrow({ where: { operationId: opId } })).toMatchObject({ outcome: 'SUCCEEDED' });
    const sent = await notices();
    expect(sent - before).toBeGreaterThanOrEqual(1);
    expect(sent - before).toBeLessThanOrEqual(recipients);   // one per Super Admin at sending time

    // Retrying the same item (and the same request) sends nothing more.
    await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = NULL WHERE "operationId" = '${opId}'`);
    expect(await worker.processBatch()).toBe(0);
    await http().post('/api/v1/admin/users/bulk').set(bearer(saToken)).send(body).expect(200);
    while ((await worker.processBatch()) > 0) { /* drain */ }
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(await notices()).toBe(sent);
  });

  it('the ordinary, non-bulk path (no outer transaction) still sends exactly once', async () => {
    const target = await make(`notice.t${++n}`, 'ADMIN');
    const spy = vi.spyOn(emails, 'superAdminChanged');
    const before = await notices();
    await http().patch(`/api/v1/admin/users/${target.id}`).set(bearer(saToken)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD }).expect(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await notices()).toBe(before + (await superAdmins()));
  });
});
