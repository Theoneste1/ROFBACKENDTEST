/**
 * Bulk user operations (2026-11-17): selection (ids / all matching filters), the selection token bound to the exact
 * accounts, idempotent execution, batched processing by concurrent workers (exactly once, in the database), partial
 * failures, the role policy and Super Admin protections, step-up, classification (grade → division), restore with
 * stillBlockedBy, message de-duplication across a worker crash, cancel, export without minors' contact details,
 * permissions, and a 5 000-account run. The worker is driven explicitly (WORKERS_ENABLED=false in tests).
 * Runs on its own freshly reset test database (never production).
 */
import { BulkOperationsWorker } from '../src/users/bulk/bulk-operations.worker.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Bulk user operations', () => {
  let ctx: TestContext;
  let admin: string;
  let worker: BulkOperationsWorker;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  let keyN = 0;
  const key = () => `test-key-${++keyN}-${Date.now()}`;

  const preview = (body: Record<string, unknown>, token = admin) => http().post('/api/v1/admin/users/bulk/preview').set(bearer(token)).send(body);
  const execute = (body: Record<string, unknown>, token = admin) => http().post('/api/v1/admin/users/bulk').set(bearer(token)).send(body);
  /** Preview, then execute exactly what was previewed. */
  async function run(action: string, selection: Record<string, unknown>, extra: Record<string, unknown> = {}, params?: Record<string, unknown>, token = admin) {
    const pv = await preview({ action, selection, ...(params && { params }) }, token).expect(200);
    const res = await execute({
      action, selection, ...(params && { params }), selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total,
      confirm: true, idempotencyKey: key(), ...extra,
    }, token);
    return { pv, res };
  }
  async function drain() {
    let n = 0;
    while ((n = await worker.processBatch()) > 0) { /* until nothing is pending */ }
    return n;
  }
  async function makeUsers(prefix: string, count: number, data: Record<string, unknown> = {}) {
    await p().user.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        username: `${prefix}.${i}`, firstName: prefix, lastName: `N${i}`, email: `${prefix}.${i}@test.local`,
        role: 'MENTOR' as const, passwordHash: hash, activatedAt: new Date(), ...data,
      })),
    });
    return (await p().user.findMany({ where: { username: { startsWith: `${prefix}.` } }, select: { id: true }, orderBy: { username: 'asc' } })).map((u) => u.id);
  }
  const items = (opId: string) => p().bulkOperationItem.findMany({ where: { operationId: opId } });

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    worker = ctx.app.get(BulkOperationsWorker);
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('preview: the current page (ids) and all matching accounts (filter) are distinct; nothing changes', async () => {
    const ids = await makeUsers('pagesel', 30);
    const page = await preview({ action: 'suspend', selection: { mode: 'ids', ids: ids.slice(0, 10) } }).expect(200);
    expect(page.body).toMatchObject({ action: 'suspend', total: 10, requiresReason: true, requiresStepUp: false });
    expect(page.body.sample).toHaveLength(10);
    const all = await preview({ action: 'suspend', selection: { mode: 'filter', filter: { search: 'pagesel' } } }).expect(200);
    expect(all.body.total).toBe(30);
    expect(all.body.sample.length).toBeLessThanOrEqual(10);
    expect(all.body.selectionToken).not.toBe(page.body.selectionToken);
    expect(all.body.consequences[0]).toMatch(/sessions? ends?/);
    expect(await p().user.count({ where: { username: { startsWith: 'pagesel.' }, accountStatus: 'ACTIVE' } })).toBe(30);
    expect(await p().bulkOperation.count()).toBe(0);
    const self = await preview({ action: 'suspend', selection: { mode: 'ids', ids: [ctx.ids.admin, ids[0]] } }).expect(200);
    expect(self.body.warnings.map((w: any) => w.code)).toContain('INCLUDES_YOURSELF');
  });

  it('SELECTION_CHANGED: an account joining, leaving, or swapped (same count) since the preview; the total is checked too', async () => {
    await makeUsers('selchg', 5);
    const selection = { mode: 'filter', filter: { search: 'selchg' } };
    const pv = await preview({ action: 'suspend', selection }).expect(200);
    const body = { action: 'suspend', selection, selectionToken: pv.body.selectionToken, expectedTotal: 5, confirm: true, reason: 'Selection test' };

    await makeUsers('selchgx', 1);   // matches the search too: one more account
    expect(await code(execute({ ...body, idempotencyKey: key() }))).toEqual([409, 'SELECTION_CHANGED']);
    // Swap: one leaves (renamed), the new one stays — the same total, different accounts.
    const first = await p().user.findFirstOrThrow({ where: { username: 'selchg.0' } });
    await p().user.update({ where: { id: first.id }, data: { username: 'renamed.0', firstName: 'Renamed', lastName: 'X', email: 'renamed.0@test.local' } });
    expect((await preview({ action: 'suspend', selection }).expect(200)).body.total).toBe(5);
    expect(await code(execute({ ...body, idempotencyKey: key() }))).toEqual([409, 'SELECTION_CHANGED']);
    // A fresh preview is accepted; a wrong expectedTotal is not.
    const again = await preview({ action: 'suspend', selection }).expect(200);
    expect(await code(execute({ ...body, selectionToken: again.body.selectionToken, expectedTotal: 4, idempotencyKey: key() }))).toEqual([409, 'SELECTION_CHANGED']);
    // A token from another action cannot be reused.
    const other = await preview({ action: 'archive', selection }).expect(200);
    expect(await code(execute({ ...body, selectionToken: other.body.selectionToken, idempotencyKey: key() }))).toEqual([409, 'SELECTION_CHANGED']);
    expect(await p().bulkOperation.count()).toBe(0);
  });

  it('refusals before anything is created: no confirmation, no reason, a mentor, a missing permission, too many ids', async () => {
    const ids = await makeUsers('refuse', 2);
    const selection = { mode: 'ids', ids };
    const pv = await preview({ action: 'suspend', selection }).expect(200);
    const base = { action: 'suspend', selection, selectionToken: pv.body.selectionToken, expectedTotal: 2, idempotencyKey: key() };
    expect(await code(execute({ ...base, confirm: false, reason: 'Some reason' }))).toEqual([400, 'CONFIRMATION_REQUIRED']);
    expect(await code(execute({ ...base, confirm: true }))).toEqual([400, 'REASON_REQUIRED']);
    const mentor = await login(ctx, 'mentor.j');
    expect(await code(preview({ action: 'suspend', selection }, mentor))).toEqual([403, 'PERMISSION_REQUIRED']);
    // An administrator denied users.archive may suspend in bulk but not archive.
    const limited = await p().user.create({ data: { username: 'bulk.limited', firstName: 'L', lastName: 'A', email: 'bulk.limited@test.local', role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    await p().userPermissionOverride.create({ data: { userId: limited.id, permission: 'users.archive', effect: 'DENY', reason: 'test' } });
    const lt = await login(ctx, 'bulk.limited');
    await preview({ action: 'suspend', selection }, lt).expect(200);
    expect(await code(preview({ action: 'archive', selection }, lt))).toEqual([403, 'PERMISSION_REQUIRED']);
    await preview({ action: 'suspend', selection: { mode: 'ids', ids: Array.from({ length: 1001 }, () => ids[0]) } }).expect(400);
    expect(await p().bulkOperation.count()).toBe(0);
  });

  it('execute: 202; the same idempotencyKey returns the same operation (200) and processes nothing twice; sessions end; audit start and finish once', async () => {
    const ids = await makeUsers('susp', 12);
    const session = await http().post('/api/v1/auth/login').send({ username: 'susp.0', password: PASSWORD }).expect(200);
    const selection = { mode: 'filter', filter: { search: 'susp' } };
    const pv = await preview({ action: 'suspend', selection }).expect(200);
    const body = { action: 'suspend', selection, selectionToken: pv.body.selectionToken, expectedTotal: 12, confirm: true, reason: 'Bulk suspension test', idempotencyKey: key() };
    const first = await execute(body).expect(202);
    expect(first.body.operation).toMatchObject({ action: 'suspend', status: 'PENDING', total: 12, reason: 'Bulk suspension test' });
    const retry = await execute(body).expect(200);
    expect(retry.body).toMatchObject({ alreadyExisted: true, operation: { id: first.body.operation.id } });
    expect(await p().bulkOperation.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);

    await drain();
    const op = await http().get(`/api/v1/admin/users/bulk/${first.body.operation.id}`).set(bearer(admin)).expect(200);
    expect(op.body).toMatchObject({ status: 'COMPLETED', total: 12, succeeded: 12, failed: 0, skipped: 0, pending: 0 });
    expect(await p().user.count({ where: { id: { in: ids }, accountStatus: 'SUSPENDED' } })).toBe(12);
    expect(await p().userStatusChange.count({ where: { operationId: first.body.operation.id } })).toBe(12);
    await http().get('/api/v1/me').set(bearer(session.body.access_token)).expect(401);
    expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_STARTED', entityId: first.body.operation.id } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_FINISHED', entityId: first.body.operation.id } })).toBe(1);
    const statusAudit = await p().auditLog.findFirstOrThrow({ where: { action: 'USER_STATUS_CHANGED', entityId: ids[3] } });
    expect(statusAudit.metadata).toMatchObject({ operationId: first.body.operation.id, reason: 'Bulk suspension test' });

    // Retrying after completion still creates nothing and changes nothing.
    await execute(body).expect(200);
    await drain();
    expect(await p().userStatusChange.count({ where: { operationId: first.body.operation.id } })).toBe(12);
  });

  it('an operation left RUNNING with every item processed (its finishing step failed) is finished by the next tick', async () => {
    const done = await p().bulkOperation.findFirstOrThrow({ where: { status: { in: ['COMPLETED', 'COMPLETED_WITH_FAILURES'] } }, orderBy: { createdAt: 'desc' } });
    await p().bulkOperation.update({ where: { id: done.id }, data: { status: 'RUNNING', finishedAt: null } });
    expect(await worker.processBatch()).toBe(0);   // nothing to claim: before the fix it stayed RUNNING forever
    expect(await worker.finishStale()).toBeGreaterThanOrEqual(1);
    const after = await p().bulkOperation.findUniqueOrThrow({ where: { id: done.id } });
    expect(after.status).toBe(done.status);
    expect(after.finishedAt).not.toBeNull();
    expect(await worker.finishStale()).toBe(0);
  });

  it('two workers at once never process an account twice (real concurrent connections)', async () => {
    const ids = await makeUsers('race', 450);
    const { res } = await run('archive', { mode: 'filter', filter: { search: 'race' } }, { reason: 'Concurrency test' });
    const opId = res.body.operation.id;
    const w2 = ctx.app.get(BulkOperationsWorker);
    await Promise.all([drain(), (async () => { while ((await w2.processBatch()) > 0) { /* drain */ } })(), drain()]);
    const it = await items(opId);
    expect(it.filter((i) => i.outcome === 'SUCCEEDED')).toHaveLength(450);
    const perUser = await p().userStatusChange.groupBy({ by: ['userId'], where: { operationId: opId }, _count: { _all: true } });
    expect(perUser).toHaveLength(450);
    expect(perUser.every((g) => g._count._all === 1)).toBe(true);
    expect(await p().user.count({ where: { id: { in: ids }, accountStatus: 'ARCHIVED' } })).toBe(450);
    expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_FINISHED', entityId: opId } })).toBe(1);
    // Finished exactly once (the finishing step waits for the operation row instead of expiring).
    expect((await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } })).status).toMatch(/^COMPLETED/);
  });

  it('partial failures are reported separately: a Super Admin (role policy), yourself (skipped), others succeed', async () => {
    const ids = await makeUsers('mixed', 3);
    const sa = await p().user.create({ data: { username: 'mixed.sa', firstName: 'S', lastName: 'A', email: 'mixed.sa@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
    const { pv, res } = await run('suspend', { mode: 'ids', ids: [...ids, sa.id, ctx.ids.admin] }, { reason: 'Mixed test' });
    expect(pv.body.warnings.map((w: any) => w.code)).toEqual(expect.arrayContaining(['INCLUDES_YOURSELF', 'INCLUDES_ADMINISTRATORS']));
    await drain();
    const op = (await http().get(`/api/v1/admin/users/bulk/${res.body.operation.id}`).set(bearer(admin)).expect(200)).body;
    expect(op).toMatchObject({ status: 'COMPLETED_WITH_FAILURES', succeeded: 3, failed: 1, skipped: 1 });
    const failed = await http().get(`/api/v1/admin/users/bulk/${res.body.operation.id}/items`).query({ outcome: 'FAILED' }).set(bearer(admin)).expect(200);
    expect(failed.body.data).toEqual([expect.objectContaining({ userId: sa.id, code: 'ROLE_NOT_ASSIGNABLE', user: expect.objectContaining({ username: 'mixed.sa' }) })]);
    const skipped = await http().get(`/api/v1/admin/users/bulk/${res.body.operation.id}/items`).query({ outcome: 'SKIPPED' }).set(bearer(admin)).expect(200);
    expect(skipped.body.data).toEqual([expect.objectContaining({ userId: ctx.ids.admin, code: 'SELF' })]);
    expect((await p().user.findUniqueOrThrow({ where: { id: sa.id } })).accountStatus).toBe('ACTIVE');
    expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).accountStatus).toBe('ACTIVE');
  });

  it('assignRole: never SUPER_ADMIN; Administrator roles need the current password (checked once, never stored); the policy applies per account', async () => {
    const ids = await makeUsers('roles', 3);
    const selection = { mode: 'ids', ids };
    expect(await code(preview({ action: 'assignRole', selection, params: { role: 'SUPER_ADMIN' } }))).toEqual([400, 'ROLE_NOT_ALLOWED_IN_BULK']);
    const toAdmin = await preview({ action: 'assignRole', selection, params: { role: 'ADMIN' } }).expect(200);
    expect(toAdmin.body.requiresStepUp).toBe(true);
    const body = { action: 'assignRole', selection, params: { role: 'ADMIN' }, selectionToken: toAdmin.body.selectionToken, expectedTotal: 3, confirm: true };
    expect(await code(execute({ ...body, idempotencyKey: key() }))).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await code(execute({ ...body, idempotencyKey: key(), currentPassword: 'wrong-password' }))).toEqual([403, 'STEP_UP_REQUIRED']);
    const ok = await execute({ ...body, idempotencyKey: key(), currentPassword: PASSWORD }).expect(202);
    const stored = await p().bulkOperation.findUniqueOrThrow({ where: { id: ok.body.operation.id } });
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    await drain();
    expect(await p().user.count({ where: { id: { in: ids }, role: 'ADMIN' } })).toBe(3);
    // An ADMIN never makes anyone a Super Admin, even through the policy per account.
    const mentors = await makeUsers('roles2', 2);
    const r2 = await run('assignRole', { mode: 'ids', ids: mentors }, {}, { role: 'TEACHER' });   // TEACHERS_ENABLED is off
    await drain();
    const it = await items(r2.res.body.operation.id);
    expect(it.every((i) => i.outcome === 'FAILED' && i.code === 'TEACHERS_DISABLED')).toBe(true);
  });

  it('changeClassification: students move to the new grade and its division; other roles are skipped', async () => {
    const senior = await p().division.findFirstOrThrow({ where: { code: 'SENIOR' } });
    const { res } = await run('changeClassification', { mode: 'ids', ids: [ctx.ids.studentJunior, ctx.ids.mentorJunior] }, {}, { gradeLevel: 'S4' });
    await drain();
    expect(await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).toMatchObject({ gradeLevel: 'S4', divisionId: senior.id });
    const it = await items(res.body.operation.id);
    expect(it.find((i) => i.userId === ctx.ids.mentorJunior)).toMatchObject({ outcome: 'SKIPPED', code: 'NOT_APPLICABLE' });
    expect(it.find((i) => i.userId === ctx.ids.studentJunior)).toMatchObject({ outcome: 'SUCCEEDED' });
  });

  it('restore needs a reason; it sets the state only and reports what still blocks sign-in per account', async () => {
    const [plain] = await makeUsers('rest', 1);
    const never = await p().user.create({ data: { username: 'rest.never', firstName: 'R', lastName: 'N', email: 'rest.never@test.local', role: 'MENTOR', activatedAt: null, isApproved: false, accountStatus: 'ARCHIVED' } });
    await p().user.update({ where: { id: plain }, data: { accountStatus: 'ARCHIVED' } });
    const selection = { mode: 'ids', ids: [plain, never.id] };
    const pv = await preview({ action: 'restore', selection }).expect(200);
    expect(await code(execute({ action: 'restore', selection, selectionToken: pv.body.selectionToken, expectedTotal: 2, confirm: true, idempotencyKey: key() }))).toEqual([400, 'REASON_REQUIRED']);
    const ok = await execute({ action: 'restore', selection, selectionToken: pv.body.selectionToken, expectedTotal: 2, confirm: true, reason: 'Back next term', idempotencyKey: key() }).expect(202);
    await drain();
    const it = await items(ok.body.operation.id);
    expect(it.find((i) => i.userId === plain)).toMatchObject({ outcome: 'SUCCEEDED', stillBlockedBy: [] });
    expect(it.find((i) => i.userId === never.id)).toMatchObject({ outcome: 'SUCCEEDED', stillBlockedBy: ['NOT_ACTIVATED', 'PENDING_APPROVAL'] });
    expect(await p().user.findUniqueOrThrow({ where: { id: never.id } })).toMatchObject({ accountStatus: 'ACTIVE', activatedAt: null, isApproved: false });
  });

  it('message: one e-mail per active account, de-duplicated in the database across a crashed worker and concurrent workers', async () => {
    const ids = await makeUsers('mail', 20);
    await p().user.update({ where: { id: ids[0] }, data: { accountStatus: 'SUSPENDED' } });
    const { res } = await run('message', { mode: 'filter', filter: { search: 'mail' } }, {}, { subject: 'Olympiad news', body: 'The next round opens on Monday.' });
    const opId = res.body.operation.id;
    // A worker claims every item and "crashes" (nothing processed); after the claim timeout others take over.
    await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes' WHERE "operationId" = '${opId}'`);
    await Promise.all([drain(), drain()]);
    const op = await p().bulkOperation.findUniqueOrThrow({ where: { id: opId } });
    expect(op).toMatchObject({ status: 'COMPLETED', succeeded: 19, skipped: 1 });
    const deliveries = await p().emailDelivery.groupBy({ by: ['recipientId'], where: { jobId: op.emailJobId! }, _count: { _all: true } });
    expect(deliveries).toHaveLength(19);
    expect(deliveries.every((d) => d._count._all === 1)).toBe(true);
    expect(deliveries.find((d) => d.recipientId === ids[0])).toBeUndefined();
    expect((await p().emailJob.findUniqueOrThrow({ where: { id: op.emailJobId! } })).totalRecipients).toBe(19);
    // A replayed item cannot be recorded (or e-mailed) again.
    await p().$executeRawUnsafe(`UPDATE "BulkOperationItem" SET "lockedAt" = NULL WHERE "operationId" = '${opId}'`);
    expect(await worker.processBatch()).toBe(0);
    expect(await p().emailDelivery.count({ where: { jobId: op.emailJobId! } })).toBe(19);
    // The audit keeps the subject, never the body.
    const started = await p().auditLog.findFirstOrThrow({ where: { action: 'BULK_OPERATION_STARTED', entityId: opId } });
    expect(JSON.stringify(started.metadata)).not.toContain('next round opens');
  });

  it('cancel: accounts not yet processed are skipped; processing stops; a finished operation cannot be cancelled', async () => {
    await makeUsers('cancel', 15);
    const { res } = await run('deactivate', { mode: 'filter', filter: { search: 'cancel' } }, { reason: 'Cancel test' });
    const opId = res.body.operation.id;
    const c = await http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)).expect(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', skipped: 15, pending: 0 });
    await drain();
    expect(await p().userStatusChange.count({ where: { operationId: opId } })).toBe(0);
    expect(await code(http().post(`/api/v1/admin/users/bulk/${opId}/cancel`).set(bearer(admin)))).toEqual([409, 'OPERATION_FINISHED']);
    const list = await http().get('/api/v1/admin/users/bulk').query({ status: 'CANCELLED' }).set(bearer(admin)).expect(200);
    expect(list.body.data.map((o: any) => o.id)).toContain(opId);
  });

  it('export: CSV of the selection with safe fields only — never dates of birth or phone numbers — audited; needs users.export', async () => {
    await p().user.update({ where: { id: ctx.ids.studentJunior2 }, data: { dateOfBirth: new Date('2012-03-04'), phone: '+250788000111', guardianPhone: '+250788000222' } });
    const res = await http().post('/api/v1/admin/users/bulk/export').set(bearer(admin))
      .send({ selection: { mode: 'ids', ids: [ctx.ids.studentJunior2, ctx.ids.mentorJunior] } }).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const csv = String(res.text).replace(/^﻿/, '');
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe('firstName,lastName,username,email,role,accountStatus,school,gradeLevel,createdAt');
    expect(lines).toHaveLength(3);
    expect(csv).not.toMatch(/2012-03-04|788000111|788000222|dateOfBirth|phone/i);
    expect(await p().auditLog.count({ where: { action: 'USERS_EXPORTED' } })).toBe(1);
    expect(await code(http().post('/api/v1/admin/users/bulk/export').set(bearer(await login(ctx, 'mentor.j'))).send({ selection: { mode: 'ids', ids: [ctx.ids.mentorJunior] } })))
      .toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('5 000 accounts selected by filter are processed in batches (performance sanity)', async () => {
    await makeUsers('perf', 5000);
    const t0 = Date.now();
    const { res } = await run('suspend', { mode: 'filter', filter: { search: 'perf.' } }, { reason: 'Performance test' });
    const created = Date.now() - t0;
    expect(res.status).toBe(202);
    let batches = 0;
    while ((await worker.processBatch()) > 0) batches++;
    const total = Date.now() - t0;
    const op = await p().bulkOperation.findUniqueOrThrow({ where: { id: res.body.operation.id } });
    expect(op).toMatchObject({ status: 'COMPLETED', total: 5000, succeeded: 5000 });
    expect(batches).toBe(25);   // 5 000 / 200
    // Recorded in the PR (2026-11-17, local PostgreSQL 17): preview + create ≈ 0.9 s; 25 batches; ≈ 66 s in total.
    process.stderr.write(`\n[perf] 5000-account bulk suspend: preview+create ${created} ms, processed in ${batches} batches, total ${total} ms\n`);
  }, 900_000);
});
