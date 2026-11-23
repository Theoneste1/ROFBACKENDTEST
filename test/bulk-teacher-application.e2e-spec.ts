/**
 * The TEACHER_APPLICATION record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md): reject many
 * Teacher applications at once through /admin/bulk/TEACHER_APPLICATION, with the single route's code
 * (POST /admin/teacher-applications/:id/reject), permission (users.manageTeachers + the TEACHER role policy), e-mail and
 * audit rows (plus the operation id). There is no bulk approve.
 */
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';
import { bulkKit } from './support/bulk-kit.js';

// An unlisted school's official code (owner 2026-11-22): unique per registration, Southern Province (first digit 2).
let codeSeq = 0;
const nextCode = () => String(292000 + ++codeSeq);

describe('Bulk TEACHER_APPLICATION actions', () => {
  let ctx: TestContext;
  let admin: string;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const APPS = '/api/v1/admin/teacher-applications';
  let k: ReturnType<typeof bulkKit>;
  let n = 0;

  async function application(over: Record<string, unknown> = {}) {
    n += 1;
    return (await p().teacherApplication.create({ data: {
      firstName: 'Tina', lastName: `Applicant${n}`, username: `bulkta.${n}`, email: `bulkta.${n}@test.local`, passwordHash: 'x', phone: '+250788123456',
      country: 'RW', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye',
      proposedSchoolName: 'GS Bulk Hill', schoolSector: 'Ngoma', proposedSchoolCode: nextCode(), proposedSchoolOwnership: 'PRIVATE', proposedSchoolAccommodation: 'DAY', homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma', ...over,
    }, select: { id: true } })).id;
  }
  async function makeAdmin(username: string) {
    await p().user.create({ data: { username, firstName: 'Other', lastName: 'Admin', email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    return login(ctx, username);
  }
  const audit = (entityId: string) => p().auditLog.findMany({ where: { action: 'REJECT_TEACHER_APPLICATION', entityId } });
  const mails = (email: string) => p().emailDelivery.findMany({ where: { recipientEmail: email, subject: { contains: 'Your teacher application' } } });

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    k = bulkKit(ctx, 'TEACHER_APPLICATION');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('only reject is offered — never a bulk approve', async () => {
    const t = (await http().get(`${k.G}/actions`).set(bearer(admin)).expect(200)).body.entityTypes.find((x: any) => x.entityType === 'TEACHER_APPLICATION');
    expect(t.actions.map((a: any) => [a.action, a.permissions, a.requiresReason])).toEqual([['reject', ['users.bulkManage', 'users.manageTeachers'], true]]);
    const id = await application();
    expect(await k.code(k.preview(admin, { action: 'approve', selection: { mode: 'ids', ids: [id] } }))).toEqual([400, 'BULK_ACTION_UNKNOWN']);
  });

  it('preview by filter (status, as GET /admin/teacher-applications): count, sample, warnings', async () => {
    const pending = [await application(), await application()];
    const rejected = await application({ status: 'REJECTED', passwordHash: null, rejectionReason: 'Earlier' });
    const pv = await k.preview(admin, { action: 'reject', selection: { mode: 'filter', filter: { status: 'PENDING' } } }).expect(200);
    const listed = await http().get(APPS).query({ status: 'PENDING', limit: 100 }).set(bearer(admin)).expect(200);
    expect(pv.body.total).toBe(listed.body.data.length);
    expect(pv.body.sample.map((s: any) => s.id)).toEqual(expect.arrayContaining(pending));
    expect(pv.body.sample[0]).toEqual(expect.objectContaining({ username: expect.stringMatching(/^bulkta\./), status: 'PENDING', proposedSchoolName: 'GS Bulk Hill' }));
    expect(pv.body.sample[0]).not.toHaveProperty('passwordHash');
    const byIds = await k.preview(admin, { action: 'reject', selection: { mode: 'ids', ids: [...pending, rejected] } }).expect(200);
    expect(byIds.body).toMatchObject({ total: 3, requiresReason: true, warnings: [{ code: 'ALREADY_IN_STATE', count: 1 }] });
    expect(await k.code(k.preview(admin, { action: 'reject', selection: { mode: 'filter', filter: { status: 'NOPE' } } }))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('reject by ids: reason required; SUCCEEDED / SKIPPED; the applicant e-mailed once; audit identical to the single route plus the operation id', async () => {
    const single = await application();
    await http().post(`${APPS}/${single}/reject`).set(bearer(admin)).send({ reason: 'Not a teacher at this school' }).expect(200);
    const [singleAudit] = await audit(single);
    const [a, b] = [await application(), await application()];
    const approved = await application({ status: 'APPROVED', passwordHash: null });
    const rejected = await application({ status: 'REJECTED', passwordHash: null, rejectionReason: 'Earlier' });
    const pv = await k.preview(admin, { action: 'reject', selection: { mode: 'ids', ids: [a, b, approved, rejected] } }).expect(200);
    expect(pv.body.warnings.map((w: any) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 1], ['ALREADY_DECIDED', 1]]);
    expect(await k.code(k.execute(admin, k.confirmBody(pv)))).toEqual([400, 'REASON_REQUIRED']);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'Not a teacher at this school' })).expect(202);
    const opId = res.body.operation.id;
    await k.drain();
    expect(await k.outcomes(admin, opId)).toEqual({
      [a]: ['SUCCEEDED', null], [b]: ['SUCCEEDED', null], [approved]: ['SKIPPED', 'ALREADY_DECIDED'], [rejected]: ['SKIPPED', 'ALREADY_IN_STATE'],
    });
    expect(await k.progress(admin, opId)).toMatchObject({ status: 'COMPLETED', succeeded: 2, skipped: 2, failed: 0 });
    expect((await k.items(admin, opId)).find((i) => i.entityId === a)).toMatchObject({ application: { id: a, status: 'REJECTED' } });
    for (const id of [a, b]) {
      const row = await p().teacherApplication.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'REJECTED', rejectionReason: 'Not a teacher at this school', decidedById: ctx.ids.admin, passwordHash: null });
      const rows = await audit(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: singleAudit.actorId, actorRole: singleAudit.actorRole, entity: 'TeacherApplication' });
      expect(rows[0].metadata).toEqual({ ...(singleAudit.metadata as object), operationId: opId });
      const m = await mails(row.email);
      expect(m).toHaveLength(1);
      expect(m[0].body).toContain('Reason: Not a teacher at this school');
    }
    expect(await mails((await p().teacherApplication.findUniqueOrThrow({ where: { id: approved } })).email)).toHaveLength(0);
    expect((await p().teacherApplication.findUniqueOrThrow({ where: { id: approved } })).status).toBe('APPROVED');
  });

  it('reject by filter', async () => {
    // Every other PENDING application is decided first, so the filter matches exactly these.
    await p().teacherApplication.updateMany({ where: { status: 'PENDING' }, data: { status: 'REJECTED', passwordHash: null } });
    const ids = [await application(), await application(), await application()];
    const pv = await k.preview(admin, { action: 'reject', selection: { mode: 'filter', filter: { status: 'PENDING' } } }).expect(200);
    expect(pv.body.total).toBe(3);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'The programme is full' })).expect(202);
    await k.drain();
    await waitForEvents();
    expect(await k.progress(admin, res.body.operation.id)).toMatchObject({ status: 'COMPLETED', succeeded: 3 });
    expect(await p().teacherApplication.count({ where: { id: { in: ids }, status: 'REJECTED', rejectionReason: 'The programme is full' } })).toBe(3);
  });

  it('permissions: users.manageTeachers is required on top of users.bulkManage (preview, execute, per application)', async () => {
    const ids = [await application()];
    const other = await makeAdmin('bulkta.noperm');
    const u = await p().user.findUniqueOrThrow({ where: { username: 'bulkta.noperm' } });
    const deny = () => p().userPermissionOverride.create({ data: { userId: u.id, permission: 'users.manageTeachers', effect: 'DENY', reason: 'bulk test' } });
    const o1 = await deny();
    expect(await k.code(k.preview(other, { action: 'reject', selection: { mode: 'ids', ids } }))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await http().post(`${APPS}/${ids[0]}/reject`).set(bearer(other)).send({ reason: 'Try' })).status).toBe(403);
    await p().userPermissionOverride.delete({ where: { id: o1.id } });
    const pv = await k.preview(other, { action: 'reject', selection: { mode: 'ids', ids } }).expect(200);
    const res = await k.execute(other, k.confirmBody(pv, { reason: 'Too late' })).expect(202);
    await deny();
    await k.drain();
    expect(await k.outcomes(admin, res.body.operation.id)).toEqual({ [ids[0]]: ['FAILED', 'PERMISSION_REQUIRED'] });
    expect((await p().teacherApplication.findUniqueOrThrow({ where: { id: ids[0] } })).status).toBe('PENDING');
  });

  it('an application decided between preview and execute: filter → 409; ids → skipped, never decided twice', async () => {
    await p().teacherApplication.updateMany({ where: { status: 'PENDING' }, data: { status: 'REJECTED', passwordHash: null } });
    const [a, b] = [await application(), await application()];
    const pv = await k.preview(admin, { action: 'reject', selection: { mode: 'filter', filter: { status: 'PENDING' } } }).expect(200);
    await http().post(`${APPS}/${a}/reject`).set(bearer(admin)).send({ reason: 'Decided by hand' }).expect(200);
    expect(await k.code(k.execute(admin, k.confirmBody(pv, { reason: 'All of them' })))).toEqual([409, 'SELECTION_CHANGED']);
    const pv2 = await k.preview(admin, { action: 'reject', selection: { mode: 'ids', ids: [b] } }).expect(200);
    await http().post(`${APPS}/${b}/reject`).set(bearer(admin)).send({ reason: 'Decided by hand' }).expect(200);
    const res = await k.execute(admin, k.confirmBody(pv2, { reason: 'All of them' })).expect(202);
    await k.drain();
    expect(await k.outcomes(admin, res.body.operation.id)).toEqual({ [b]: ['SKIPPED', 'ALREADY_IN_STATE'] });
    expect(await audit(b)).toHaveLength(1);
    expect((await p().teacherApplication.findUniqueOrThrow({ where: { id: b } })).rejectionReason).toBe('Decided by hand');
  });
});
