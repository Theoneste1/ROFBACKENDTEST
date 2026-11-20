/**
 * The ASSIGNMENT record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md): publish, close and
 * archive many assignments at once through /admin/bulk/ASSIGNMENT, with the single routes' code
 * (PATCH /assignments/:id/publish | close | archive), permission (assignments.publish), history and audit rows (plus the
 * operation id). Wrong statuses are skipped; publishing past the deadline fails, as the single route refuses it.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';
import { bulkKit } from './support/bulk-kit.js';

describe('Bulk ASSIGNMENT actions', () => {
  let ctx: TestContext;
  let admin: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  let k: ReturnType<typeof bulkKit>;
  const FUTURE = () => new Date(Date.now() + 30 * 86_400_000);

  async function make(prefix: string, statuses: string[], data: Record<string, unknown> = {}) {
    const ids: string[] = [];
    for (const [i, status] of statuses.entries()) {
      ids.push((await p().assignment.create({
        data: {
          title: `${prefix} ${i}`, instructions: 'Solve the problems.', deadline: FUTURE(), points: 10, maximumMarks: 10,
          courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year, createdById: ctx.ids.mentorJunior,
          status: status as never, ...(status === 'PUBLISHED' && { publishedAt: new Date(), approvedById: ctx.ids.admin }), ...data,
        },
        select: { id: true },
      })).id);
    }
    return ids;
  }
  const statusOf = async (ids: string[]) =>
    (await p().assignment.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })).reduce<Record<string, string>>((m, r) => ({ ...m, [r.id]: r.status }), {});
  const audits = (action: string, entityId: string) => p().auditLog.findMany({ where: { action, entityId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    k = bulkKit(ctx, 'ASSIGNMENT');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('is listed for an Administrator with its actions, permissions and reason rules', async () => {
    const r = await http().get(`${k.G}/actions`).set(bearer(admin)).expect(200);
    const t = r.body.entityTypes.find((x: any) => x.entityType === 'ASSIGNMENT');
    expect(t).toMatchObject({ maxIds: 1000, maxSelection: 10_000, export: null });
    expect(t.actions.map((a: any) => [a.action, a.permissions, a.requiresReason])).toEqual([
      ['publish', ['users.bulkManage', 'assignments.publish'], false],
      ['close', ['users.bulkManage', 'assignments.publish'], false],
      ['archive', ['users.bulkManage', 'assignments.publish'], true],
    ]);
  });

  it('publish by filter (GET /assignments filters): pending ones published, others skipped, past deadline failed; single-route audit + operation id', async () => {
    const [single, a, b] = await make('Bulk publish Kigoma', ['PENDING_APPROVAL', 'PENDING_APPROVAL', 'PENDING_APPROVAL']);
    const [draft, published] = await make('Bulk publish Kigoma other', ['DRAFT', 'PUBLISHED']);
    const [late] = await make('Bulk publish Kigoma late', ['PENDING_APPROVAL'], { deadline: new Date(Date.now() - 86_400_000) });
    await http().patch(`/api/v1/assignments/${single}/publish`).set(bearer(admin)).expect(200);
    const [singleAudit] = await audits('PUBLISH_ASSIGNMENT', single);

    const filter = { q: '  bulk publish kigoma ', statuses: ['PENDING_APPROVAL', 'DRAFT', 'PUBLISHED'] };
    const pv = await k.preview(admin, { action: 'publish', selection: { mode: 'filter', filter } }).expect(200);
    // single is now PUBLISHED: it matches and is skipped.
    expect(pv.body).toMatchObject({ entityType: 'ASSIGNMENT', total: 6, requiresReason: false, selection: { mode: 'filter', filter: { q: 'bulk publish kigoma' } } });
    expect(pv.body.warnings.map((w: any) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 2], ['NOT_APPLICABLE', 1], ['DEADLINE_IN_PAST', 1]]);
    expect(Object.keys(pv.body.sample[0]).sort()).toEqual(['course', 'deadline', 'division', 'id', 'status', 'title']);
    // The list sees the same assignments.
    const list = await http().get('/api/v1/assignments').query({ q: 'bulk publish kigoma', statuses: 'PENDING_APPROVAL,DRAFT,PUBLISHED' }).set(bearer(admin)).expect(200);
    expect(list.body.meta.total).toBe(6);
    // Unknown filters and paging are refused like on the list.
    for (const f of [{ unknown: 1 }, { page: 2 }, { status: 'NOPE' }]) {
      expect(await k.code(k.preview(admin, { action: 'publish', selection: { mode: 'filter', filter: f } }))).toEqual([400, 'VALIDATION_FAILED']);
    }

    const res = await k.execute(admin, k.confirmBody(pv)).expect(202);
    const opId = res.body.operation.id;
    await k.drain();
    expect(await k.outcomes(admin, opId)).toEqual({
      [single]: ['SKIPPED', 'ALREADY_IN_STATE'], [a]: ['SUCCEEDED', null], [b]: ['SUCCEEDED', null],
      [draft]: ['SKIPPED', 'NOT_APPLICABLE'], [published]: ['SKIPPED', 'ALREADY_IN_STATE'], [late]: ['FAILED', 'DEADLINE_IN_PAST'],
    });
    expect(await k.progress(admin, opId)).toMatchObject({ status: 'COMPLETED_WITH_FAILURES', succeeded: 2, skipped: 3, failed: 1 });
    expect(await statusOf([a, b, draft, late])).toEqual({ [a]: 'PUBLISHED', [b]: 'PUBLISHED', [draft]: 'DRAFT', [late]: 'PENDING_APPROVAL' });
    const [bulkAudit] = await audits('PUBLISH_ASSIGNMENT', a);
    expect(bulkAudit).toMatchObject({ actorId: singleAudit.actorId, actorRole: singleAudit.actorRole, entity: 'Assignment' });
    expect(bulkAudit.metadata).toEqual({ ...(singleAudit.metadata as object), title: 'Bulk publish Kigoma 1', operationId: opId });
    // The history records the publication like the single route.
    expect(await p().assignmentEvent.count({ where: { assignmentId: a, type: 'PUBLISHED' } })).toBe(1);
    expect(await audits('PUBLISH_ASSIGNMENT', draft)).toHaveLength(0);
    const items = await k.items(admin, opId);
    expect(items.find((i) => i.entityId === a)).toMatchObject({ assignment: { id: a, title: 'Bulk publish Kigoma 1', status: 'PUBLISHED' } });
  });

  it('close by ids: the reason is the note; archive needs a reason and records it', async () => {
    const [x, y, draft] = await make('Bulk close Huye', ['PUBLISHED', 'PUBLISHED', 'DRAFT']);
    const pv = await k.preview(admin, { action: 'close', selection: { mode: 'ids', ids: [x, y, draft] } }).expect(200);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'Term ended' })).expect(202);
    await k.drain();
    expect(await k.outcomes(admin, res.body.operation.id)).toEqual({ [x]: ['SUCCEEDED', null], [y]: ['SUCCEEDED', null], [draft]: ['SKIPPED', 'NOT_APPLICABLE'] });
    expect((await p().assignmentEvent.findFirstOrThrow({ where: { assignmentId: x, type: 'CLOSED' } })).note).toBe('Term ended');
    expect((await audits('CLOSE_ASSIGNMENT', x))[0].metadata).toMatchObject({ note: 'Term ended', from: 'PUBLISHED', to: 'CLOSED', operationId: res.body.operation.id });

    const pv2 = await k.preview(admin, { action: 'archive', selection: { mode: 'ids', ids: [x, draft] } }).expect(200);
    expect(pv2.body.requiresReason).toBe(true);
    expect(await k.code(k.execute(admin, k.confirmBody(pv2)))).toEqual([400, 'REASON_REQUIRED']);
    const res2 = await k.execute(admin, k.confirmBody(pv2, { reason: 'Old term' })).expect(202);
    await k.drain();
    expect(await statusOf([x, draft])).toEqual({ [x]: 'ARCHIVED', [draft]: 'ARCHIVED' });
    expect((await p().assignmentEvent.findFirstOrThrow({ where: { assignmentId: draft, type: 'ARCHIVED' } })).note).toBe('Old term');
    expect((await audits('ARCHIVE_ASSIGNMENT', draft))[0].metadata).toMatchObject({ note: 'Old term', from: 'DRAFT', to: 'ARCHIVED', operationId: res2.body.operation.id });
  });

  it('the single routes still behave as before (publish, close, archive)', async () => {
    const [pend, pub, arch] = await make('Bulk single Nyanza', ['PENDING_APPROVAL', 'PUBLISHED', 'DRAFT']);
    expect((await http().patch(`/api/v1/assignments/${pend}/publish`).set(bearer(admin)).expect(200)).body).toMatchObject({ id: pend, status: 'PUBLISHED' });
    expect((await http().patch(`/api/v1/assignments/${pub}/close`).set(bearer(admin)).send({ note: 'Early' }).expect(200)).body).toMatchObject({ id: pub, status: 'CLOSED' });
    expect((await http().patch(`/api/v1/assignments/${arch}/archive`).set(bearer(admin)).expect(200)).body).toMatchObject({ id: arch, status: 'ARCHIVED' });
    expect((await audits('ARCHIVE_ASSIGNMENT', arch))[0].metadata).toEqual({ from: 'DRAFT', to: 'ARCHIVED' });
    // Wrong status: the single route still refuses (409 INVALID_STATE).
    const r = await http().patch(`/api/v1/assignments/${arch}/close`).set(bearer(admin)).send({});
    expect(r.status).toBe(409);
  });

  it('permissions: assignments.publish is needed on top of users.bulkManage', async () => {
    const [id] = await make('Bulk perm Rusizi', ['PENDING_APPROVAL']);
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    const u = await p().user.create({ data: { username: 'bulk.asg.noperm', firstName: 'Other', lastName: 'Admin', email: 'bulk.asg.noperm@test.local', role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    await p().userPermissionOverride.create({ data: { userId: u.id, permission: 'assignments.publish', effect: 'DENY', reason: 'bulk assignment test' } });
    const other = await login(ctx, 'bulk.asg.noperm');
    expect(await k.code(k.preview(other, { action: 'publish', selection: { mode: 'ids', ids: [id] } }))).toEqual([403, 'PERMISSION_REQUIRED']);
    const types = (await http().get(`${k.G}/actions`).set(bearer(other)).expect(200)).body.entityTypes.map((t: any) => t.entityType);
    expect(types).not.toContain('ASSIGNMENT');
  });
});
