/**
 * The SCHOOL record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md): activate, deactivate and
 * verify many schools at once through /admin/bulk/SCHOOL, with the single routes' code (PATCH /admin/schools/:id/active,
 * POST /admin/schools/:id/verify), permission (schools.manage) and audit rows (plus the operation id).
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';
import { bulkKit } from './support/bulk-kit.js';

describe('Bulk SCHOOL actions', () => {
  let ctx: TestContext;
  let admin: string;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  let k: ReturnType<typeof bulkKit>;

  async function makeSchools(prefix: string, n: number, data: Record<string, unknown> = {}) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push((await p().school.create({ data: { name: `${prefix} ${i}`, location: 'Huye', district: 'Huye', sector: 'Ngoma', ...data }, select: { id: true } })).id);
    }
    return ids;
  }
  async function makeAdmin(username: string) {
    await p().user.create({ data: { username, firstName: 'Other', lastName: 'Admin', email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    return login(ctx, username);
  }
  const deny = async (username: string, permission: string) => {
    const u = await p().user.findUniqueOrThrow({ where: { username } });
    return p().userPermissionOverride.create({ data: { userId: u.id, permission, effect: 'DENY', reason: 'bulk school test' } });
  };
  const audits = (action: string, entityId: string) => p().auditLog.findMany({ where: { action, entityId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    k = bulkKit(ctx, 'SCHOOL');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('is listed for an Administrator with its actions, permissions and reason rules', async () => {
    const r = await http().get(`${k.G}/actions`).set(bearer(admin)).expect(200);
    const t = r.body.entityTypes.find((x: any) => x.entityType === 'SCHOOL');
    expect(t).toMatchObject({ maxIds: 1000, maxSelection: 10_000, export: null });
    expect(t.actions.map((a: any) => [a.action, a.permissions, a.requiresReason])).toEqual([
      ['activate', ['users.bulkManage', 'schools.manage'], true],
      ['deactivate', ['users.bulkManage', 'schools.manage'], true],
      ['verify', ['users.bulkManage', 'schools.manage'], false],
    ]);
  });

  it('preview by filter: the GET /admin/schools filters, count, sample and warnings; nothing changes', async () => {
    const active = await makeSchools('Preview Gisagara', 3);
    const inactive = await makeSchools('Preview Gisagara closed', 2, { isActive: false });
    const pv = await k.preview(admin, { action: 'activate', selection: { mode: 'filter', filter: { q: '  preview gisagara ' } } }).expect(200);
    expect(pv.body).toMatchObject({
      entityType: 'SCHOOL', action: 'activate', total: 5, requiresReason: true, requiresStepUp: false,
      selection: { mode: 'filter', filter: { q: 'preview gisagara' } },
      warnings: [{ code: 'ALREADY_IN_STATE', count: 3, message: expect.any(String) }],
    });
    expect(pv.body.sample).toHaveLength(5);
    expect(Object.keys(pv.body.sample[0]).sort()).toEqual(['code', 'countryCode', 'district', 'id', 'isActive', 'lastVerifiedAt', 'name', 'sector']);
    expect(pv.body.sample.map((s: any) => s.id).sort()).toEqual([...active, ...inactive].sort());
    // The same filter as the list: isActive narrows it.
    const narrowed = await k.preview(admin, { action: 'activate', selection: { mode: 'filter', filter: { q: 'preview gisagara', isActive: false } } }).expect(200);
    expect(narrowed.body).toMatchObject({ total: 2, warnings: [] });
    const list = await http().get('/api/v1/admin/schools').query({ q: 'preview gisagara', isActive: 'false' }).set(bearer(admin)).expect(200);
    expect(list.body.meta?.total ?? list.body.total).toBe(2);
    // Unknown filters, list paging / sorting and parameters are refused like on the list.
    for (const filter of [{ unknown: 1 }, { page: 2 }, { sort: 'name' }, { isActive: 'maybe' }]) {
      expect(await k.code(k.preview(admin, { action: 'activate', selection: { mode: 'filter', filter } }))).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(await k.code(k.preview(admin, { action: 'activate', params: { x: 1 }, selection: { mode: 'ids', ids: active } }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await k.code(k.preview(admin, { action: 'delete', selection: { mode: 'ids', ids: active } }))).toEqual([400, 'BULK_ACTION_UNKNOWN']);
    expect(await p().school.count({ where: { id: { in: inactive }, isActive: false } })).toBe(2);
  });

  it('deactivate by ids: reason required; SUCCEEDED / SKIPPED ALREADY_IN_STATE; audit rows identical to the single route plus the operation id', async () => {
    const [single, a, b, already] = await makeSchools('Deact', 4);
    await p().school.update({ where: { id: already }, data: { isActive: false } });
    // The single route, for comparison.
    await http().patch(`/api/v1/admin/schools/${single}/active`).set(bearer(admin)).send({ isActive: false, reason: 'Closed for works' }).expect(200);
    const [singleAudit] = await audits('SCHOOL_DEACTIVATED', single);

    const pv = await k.preview(admin, { action: 'deactivate', selection: { mode: 'ids', ids: [a, b, already] } }).expect(200);
    expect(pv.body).toMatchObject({ total: 3, requiresReason: true, warnings: [{ code: 'ALREADY_IN_STATE', count: 1 }] });
    expect(await k.code(k.execute(admin, k.confirmBody(pv)))).toEqual([400, 'REASON_REQUIRED']);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'Closed for works' })).expect(202);
    const opId = res.body.operation.id;
    expect(res.body.operation).toMatchObject({ entityType: 'SCHOOL', action: 'deactivate', total: 3, reason: 'Closed for works' });
    await k.drain();

    expect(await k.progress(admin, opId)).toMatchObject({ status: 'COMPLETED', total: 3, succeeded: 2, skipped: 1, failed: 0, pending: 0, processing: 0 });
    expect(await k.outcomes(admin, opId)).toEqual({ [a]: ['SUCCEEDED', null], [b]: ['SUCCEEDED', null], [already]: ['SKIPPED', 'ALREADY_IN_STATE'] });
    const items = await k.items(admin, opId);
    expect(items.find((i) => i.entityId === a)).toMatchObject({ userId: null, school: { id: a, isActive: false, name: 'Deact 1' } });
    expect(await p().school.count({ where: { id: { in: [a, b] }, isActive: false } })).toBe(2);

    for (const id of [a, b]) {
      const rows = await audits('SCHOOL_DEACTIVATED', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: singleAudit.actorId, actorRole: singleAudit.actorRole, entity: singleAudit.entity, entityId: id });
      expect(rows[0].metadata).toEqual({ ...(singleAudit.metadata as object), operationId: opId });
    }
    // A school already inactive: nothing changed, no audit row (as the single route).
    expect(await audits('SCHOOL_DEACTIVATED', already)).toHaveLength(0);
    const started = await p().auditLog.findFirstOrThrow({ where: { action: 'BULK_OPERATION_STARTED', entityId: opId } });
    expect(started.metadata).toMatchObject({ entityType: 'SCHOOL', action: 'deactivate', total: 3, reason: 'Closed for works', selection: { mode: 'ids', count: 3 } });
    expect(await p().auditLog.count({ where: { action: 'BULK_OPERATION_FINISHED', entityId: opId } })).toBe(1);
  });

  it('activate by filter: every matching school, inactive ones reactivated, with the single route\'s audit', async () => {
    const ids = await makeSchools('Reopen Nyanza', 3, { isActive: false });
    const pv = await k.preview(admin, { action: 'activate', selection: { mode: 'filter', filter: { q: 'reopen nyanza', isActive: false } } }).expect(200);
    expect(pv.body.total).toBe(3);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'Works finished' })).expect(202);
    await k.drain();
    expect(await k.progress(admin, res.body.operation.id)).toMatchObject({ status: 'COMPLETED', succeeded: 3 });
    expect(await p().school.count({ where: { id: { in: ids }, isActive: true } })).toBe(3);
    const row = (await audits('SCHOOL_REACTIVATED', ids[0]))[0];
    expect(row.metadata).toMatchObject({ reason: 'Works finished', previous: { isActive: false }, next: { isActive: true }, operationId: res.body.operation.id });
  });

  it('verify: SUCCEEDED, SKIPPED (already verified) and FAILED (inactive, outside Rwanda) per school; the note is the reason', async () => {
    const [single, fresh] = await makeSchools('Verify Muhanga', 2);
    const [verified] = await makeSchools('Verify Muhanga done', 1, { lastVerifiedAt: new Date('2026-01-01'), lastVerifiedById: ctx.ids.admin });
    const [inactive] = await makeSchools('Verify Muhanga closed', 1, { isActive: false });
    const [kenyan] = await makeSchools('Verify Muhanga Nairobi', 1, { countryCode: 'KE', district: null, sector: null, location: 'Nairobi' });
    await http().post(`/api/v1/admin/schools/${single}/verify`).set(bearer(admin)).send({ note: 'Checked on site' }).expect(200);
    const [singleAudit] = await audits('VERIFY_SCHOOL', single);

    const pv = await k.preview(admin, { action: 'verify', selection: { mode: 'ids', ids: [fresh, verified, inactive, kenyan] } }).expect(200);
    expect(pv.body.warnings.map((w: any) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 1], ['SCHOOL_INACTIVE', 1], ['SCHOOL_DIRECTORY_RWANDA_ONLY', 1]]);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'Checked on site' })).expect(202);
    const opId = res.body.operation.id;
    await k.drain();
    expect(await k.outcomes(admin, opId)).toEqual({
      [fresh]: ['SUCCEEDED', null], [verified]: ['SKIPPED', 'ALREADY_IN_STATE'],
      [inactive]: ['FAILED', 'SCHOOL_INACTIVE'], [kenyan]: ['FAILED', 'SCHOOL_DIRECTORY_RWANDA_ONLY'],
    });
    expect(await k.progress(admin, opId)).toMatchObject({ status: 'COMPLETED_WITH_FAILURES', succeeded: 1, skipped: 1, failed: 2 });
    const [bulkAudit] = await audits('VERIFY_SCHOOL', fresh);
    expect(bulkAudit.metadata).toEqual({ ...(singleAudit.metadata as object), operationId: opId });
    expect((await p().school.findUniqueOrThrow({ where: { id: fresh } })).lastVerifiedById).toBe(ctx.ids.admin);
    // Nothing changed for the refused or skipped schools.
    expect((await p().school.findUniqueOrThrow({ where: { id: verified } })).lastVerifiedAt).toEqual(new Date('2026-01-01'));
    expect(await audits('VERIFY_SCHOOL', inactive)).toHaveLength(0);
  });

  it('permissions: users.bulkManage alone is not enough — schools.manage is refused at preview, at execute and per school', async () => {
    const ids = await makeSchools('Perm Rusizi', 2, { isActive: false });
    const other = await makeAdmin('bulk.school.noperm');
    await deny('bulk.school.noperm', 'schools.manage');
    expect(await k.code(k.preview(other, { action: 'activate', selection: { mode: 'ids', ids } }))).toEqual([403, 'PERMISSION_REQUIRED']);
    // The single route is refused too, and the type is not offered.
    expect((await http().patch(`/api/v1/admin/schools/${ids[0]}/active`).set(bearer(other)).send({ isActive: true, reason: 'Try' })).status).toBe(403);
    const types = (await http().get(`${k.G}/actions`).set(bearer(other)).expect(200)).body.entityTypes.map((t: any) => t.entityType);
    expect(types).not.toContain('SCHOOL');

    // Removed between preview and execute → 403, nothing created.
    const second = await makeAdmin('bulk.school.later');
    const pv = await k.preview(second, { action: 'activate', selection: { mode: 'ids', ids } }).expect(200);
    const override = await deny('bulk.school.later', 'schools.manage');
    const before = await p().bulkOperation.count();
    expect(await k.code(k.execute(second, k.confirmBody(pv, { reason: 'Reopen now' })))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await p().bulkOperation.count()).toBe(before);

    // Removed after the operation was created → each school FAILED PERMISSION_REQUIRED, nothing changed.
    await p().userPermissionOverride.delete({ where: { id: override.id } });
    const pv2 = await k.preview(second, { action: 'activate', selection: { mode: 'ids', ids } }).expect(200);
    const res = await k.execute(second, k.confirmBody(pv2, { reason: 'Reopen now' })).expect(202);
    await deny('bulk.school.later', 'schools.manage');
    await k.drain();
    expect(Object.values(await k.outcomes(admin, res.body.operation.id))).toEqual([['FAILED', 'PERMISSION_REQUIRED'], ['FAILED', 'PERMISSION_REQUIRED']]);
    expect(await p().school.count({ where: { id: { in: ids }, isActive: true } })).toBe(0);
  });

  it('a school changed between preview and execute: a filter selection is refused (409); an ids selection skips it', async () => {
    const ids = await makeSchools('Changed Rubavu', 3, { isActive: false });
    // Filter: one school reactivated by the single route meanwhile → no longer matches → 409, nothing created.
    const pv = await k.preview(admin, { action: 'activate', selection: { mode: 'filter', filter: { q: 'changed rubavu', isActive: false } } }).expect(200);
    expect(pv.body.total).toBe(3);
    await http().patch(`/api/v1/admin/schools/${ids[0]}/active`).set(bearer(admin)).send({ isActive: true, reason: 'Reopened early' }).expect(200);
    expect(await k.code(k.execute(admin, k.confirmBody(pv, { reason: 'Reopen all' })))).toEqual([409, 'SELECTION_CHANGED']);

    // Ids: the same records are confirmed; the one changed meanwhile is skipped when processed.
    const pv2 = await k.preview(admin, { action: 'activate', selection: { mode: 'ids', ids: ids.slice(1) } }).expect(200);
    expect(pv2.body.warnings).toEqual([]);
    await http().patch(`/api/v1/admin/schools/${ids[1]}/active`).set(bearer(admin)).send({ isActive: true, reason: 'Reopened early' }).expect(200);
    const res = await k.execute(admin, k.confirmBody(pv2, { reason: 'Reopen all' })).expect(202);
    await k.drain();
    expect(await k.outcomes(admin, res.body.operation.id)).toEqual({ [ids[1]]: ['SKIPPED', 'ALREADY_IN_STATE'], [ids[2]]: ['SUCCEEDED', null] });
    // One reactivation audit row per school: the single route's for ids[1], the bulk one for ids[2].
    expect((await audits('SCHOOL_REACTIVATED', ids[1])).map((r) => (r.metadata as any).operationId ?? null)).toEqual([null]);
    expect((await audits('SCHOOL_REACTIVATED', ids[2])).map((r) => (r.metadata as any).operationId)).toEqual([res.body.operation.id]);
  });
});
