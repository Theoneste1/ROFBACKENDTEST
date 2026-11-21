/**
 * The COACH_APPLICATION record type of the bulk engine — mentor requests (2026-11-20; docs/operations/bulk-operations.md):
 * approve or reject many coach applications at once through /admin/bulk/COACH_APPLICATION, with the single routes' code
 * (PATCH /mentor-requests/:id/approve|reject), permission (mentorRequests.decide), notices, e-mails and audit rows (plus
 * the operation id). A picture is never approved in bulk.
 */
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';
import { bulkKit } from './support/bulk-kit.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('Bulk COACH_APPLICATION actions', () => {
  let ctx: TestContext;
  let admin: string;
  let hash: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const MR = '/api/v1/mentor-requests';
  let k: ReturnType<typeof bulkKit>;
  let n = 0;

  /** A coach application through the public form; with `picture`, the optional picture is uploaded. */
  async function apply(picture = false) {
    n += 1;
    const r = await http().post(MR).send({
      firstName: 'Cora', lastName: `Coach${n}`, username: `bulkca.${n}`, email: `bulkca.${n}@test.local`, password: 'Mentor123',
      gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'],
    }).expect(201);
    if (picture) await http().put('/api/v1/auth/register/avatar').field('token', r.body.avatarUploadToken).attach('file', PNG, 'me.png').expect(200);
    return r.body.id as string;
  }
  async function makeAdmin(username: string) {
    await p().user.create({ data: { username, firstName: 'Other', lastName: 'Admin', email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    return login(ctx, username);
  }
  const audit = (action: string, entityId: string) => p().auditLog.findMany({ where: { action, entityId } });
  const request = (id: string) => p().mentorRequest.findUniqueOrThrow({ where: { id } });
  /** Leaves only the given applications PENDING (filters then match exactly them). */
  const onlyPending = async () => p().mentorRequest.updateMany({ where: { status: 'PENDING' }, data: { status: 'REJECTED', passwordHash: null } });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    k = bulkKit(ctx, 'COACH_APPLICATION');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('is listed with approve and reject (mentorRequests.decide; reason optional)', async () => {
    const t = (await http().get(`${k.G}/actions`).set(bearer(admin)).expect(200)).body.entityTypes.find((x: any) => x.entityType === 'COACH_APPLICATION');
    expect(t.actions.map((a: any) => [a.action, a.permissions, a.requiresReason])).toEqual([
      ['approve', ['users.bulkManage', 'mentorRequests.decide'], false],
      ['reject', ['users.bulkManage', 'mentorRequests.decide'], false],
    ]);
    const id = await apply();
    // No approvePicture (or any other) parameter: a picture is never approved in bulk.
    expect(await k.code(k.preview(admin, { action: 'approve', params: { approvePicture: true }, selection: { mode: 'ids', ids: [id] } }))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('preview by filter (status, as GET /mentor-requests): count, sample, warnings (pictures discarded)', async () => {
    await onlyPending();
    const ids = [await apply(), await apply(true)];
    const pv = await k.preview(admin, { action: 'approve', selection: { mode: 'filter', filter: { status: 'PENDING' } } }).expect(200);
    expect(pv.body).toMatchObject({ entityType: 'COACH_APPLICATION', total: 2, requiresReason: false, warnings: [{ code: 'PICTURE_DISCARDED', count: 1 }] });
    expect(pv.body.sample.map((s: any) => s.id).sort()).toEqual([...ids].sort());
    expect(pv.body.sample[0]).not.toHaveProperty('passwordHash');
    const listed = await http().get(MR).query({ status: 'PENDING' }).set(bearer(admin)).expect(200);
    expect(listed.body.data.map((r: any) => r.id).sort()).toEqual([...ids].sort());
  });

  it('approve by ids: accounts created, picture discarded, notice once; SKIPPED decided ones; FAILED identity taken; audit as the single route plus the operation id', async () => {
    const single = await apply();
    await http().patch(`${MR}/${single}/approve`).set(bearer(admin)).send({}).expect(200);
    const [singleAudit] = await audit('APPROVE_MENTOR_REQUEST', single);
    const plain = await apply();
    const withPicture = await apply(true);
    const rejected = await apply();
    await http().patch(`${MR}/${rejected}/reject`).set(bearer(admin)).send({}).expect(200);
    const clash = await apply();
    const pv = await k.preview(admin, { action: 'approve', selection: { mode: 'ids', ids: [plain, withPicture, rejected, single, clash] } }).expect(200);
    expect(pv.body.warnings.map((w: any) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 1], ['ALREADY_DECIDED', 1], ['PICTURE_DISCARDED', 1]]);
    // The clash's username is taken by an account after the preview.
    const clashRow = await request(clash);
    await p().user.create({ data: { username: clashRow.username, firstName: 'Taken', lastName: 'Name', email: 'taken@test.local', role: 'MENTOR', passwordHash: hash } });

    const res = await k.execute(admin, k.confirmBody(pv)).expect(202);
    const opId = res.body.operation.id;
    await k.drain();
    await waitForEvents();
    expect(await k.outcomes(admin, opId)).toEqual({
      [plain]: ['SUCCEEDED', null], [withPicture]: ['SUCCEEDED', null], [rejected]: ['SKIPPED', 'ALREADY_DECIDED'],
      [single]: ['SKIPPED', 'ALREADY_IN_STATE'], [clash]: ['FAILED', 'IDENTITY_TAKEN'],
    });
    expect(await k.progress(admin, opId)).toMatchObject({ status: 'COMPLETED_WITH_FAILURES', succeeded: 2, skipped: 2, failed: 1 });
    expect((await request(clash)).status).toBe('PENDING');   // refused: nothing changed

    for (const id of [plain, withPicture]) {
      const row = await request(id);
      expect(row).toMatchObject({ status: 'APPROVED', passwordHash: null, avatarFileId: null });
      const coach = await p().user.findUniqueOrThrow({ where: { username: row.username } });
      expect(coach).toMatchObject({ role: 'MENTOR', avatarFileId: null });
      const [a] = await audit('APPROVE_MENTOR_REQUEST', id);
      expect(a).toMatchObject({ actorId: singleAudit.actorId, actorRole: singleAudit.actorRole, entity: 'MentorRequest' });
      expect(Object.keys(a.metadata as object).sort()).toEqual([...Object.keys(singleAudit.metadata as object), 'operationId'].sort());
      expect(a.metadata).toMatchObject({ newUserId: coach.id, picture: id === withPicture ? 'DISCARDED' : 'NONE', operationId: opId });
      // One approval notice, as the single route writes it.
      expect(await p().notificationOutbox.count({ where: { type: 'coach.application.approved', dedupeKey: `coach.application.approved:${id}` } })).toBe(1);
    }
  });

  it('reject by filter, with and without a reason: the applicant is e-mailed after commit; audit as the single route plus the operation id', async () => {
    const single = await apply();
    await http().patch(`${MR}/${single}/reject`).set(bearer(admin)).send({ reason: 'No coaching experience yet' }).expect(200);
    const [singleAudit] = await audit('REJECT_MENTOR_REQUEST', single);
    await onlyPending();
    const ids = [await apply(), await apply(true)];
    const pv = await k.preview(admin, { action: 'reject', selection: { mode: 'filter', filter: { status: 'PENDING' } } }).expect(200);
    expect(pv.body).toMatchObject({ total: 2, warnings: [] });
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'No coaching experience yet' })).expect(202);
    await k.drain();
    await waitForEvents();
    expect(await k.progress(admin, res.body.operation.id)).toMatchObject({ status: 'COMPLETED', succeeded: 2 });
    for (const id of ids) {
      const row = await request(id);
      expect(row).toMatchObject({ status: 'REJECTED', rejectionReason: 'No coaching experience yet', passwordHash: null, avatarFileId: null });
      const [a] = await audit('REJECT_MENTOR_REQUEST', id);
      expect(a.metadata).toEqual({ ...(singleAudit.metadata as object), operationId: res.body.operation.id });
      const mails = await p().emailDelivery.findMany({ where: { recipientEmail: row.email } });
      expect(mails).toHaveLength(1);
      expect(mails[0].body).toContain('Reason: No coaching experience yet');
    }

    // Without a reason (optional, as on the single route): no reason anywhere.
    const plain = await apply();
    const pv2 = await k.preview(admin, { action: 'reject', selection: { mode: 'ids', ids: [plain] } }).expect(200);
    const r2 = await k.execute(admin, k.confirmBody(pv2)).expect(202);
    await k.drain();
    await waitForEvents();
    expect((await request(plain))).toMatchObject({ status: 'REJECTED', rejectionReason: null });
    expect((await audit('REJECT_MENTOR_REQUEST', plain))[0].metadata).toEqual({ operationId: r2.body.operation.id });
    const [mail] = await p().emailDelivery.findMany({ where: { recipientEmail: (await request(plain)).email } });
    expect(mail.body).not.toContain('Reason:');
  });

  it('permissions: mentorRequests.decide is required on top of users.bulkManage (preview, execute, per application)', async () => {
    const id = await apply();
    const other = await makeAdmin('bulkca.noperm');
    const u = await p().user.findUniqueOrThrow({ where: { username: 'bulkca.noperm' } });
    const deny = () => p().userPermissionOverride.create({ data: { userId: u.id, permission: 'mentorRequests.decide', effect: 'DENY', reason: 'bulk test' } });
    const o = await deny();
    expect(await k.code(k.preview(other, { action: 'approve', selection: { mode: 'ids', ids: [id] } }))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await http().patch(`${MR}/${id}/approve`).set(bearer(other)).send({})).status).toBe(403);
    await p().userPermissionOverride.delete({ where: { id: o.id } });
    const pv = await k.preview(other, { action: 'approve', selection: { mode: 'ids', ids: [id] } }).expect(200);
    await deny();
    expect(await k.code(k.execute(other, k.confirmBody(pv)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await request(id)).status).toBe('PENDING');
  });

  it('an application decided between preview and execute: filter → 409; ids → skipped, never decided twice', async () => {
    await onlyPending();
    const [a, b] = [await apply(), await apply()];
    const pv = await k.preview(admin, { action: 'approve', selection: { mode: 'filter', filter: { status: 'PENDING' } } }).expect(200);
    await http().patch(`${MR}/${a}/reject`).set(bearer(admin)).send({}).expect(200);
    expect(await k.code(k.execute(admin, k.confirmBody(pv)))).toEqual([409, 'SELECTION_CHANGED']);
    const pv2 = await k.preview(admin, { action: 'approve', selection: { mode: 'ids', ids: [b] } }).expect(200);
    await http().patch(`${MR}/${b}/approve`).set(bearer(admin)).send({}).expect(200);
    const res = await k.execute(admin, k.confirmBody(pv2)).expect(202);
    await k.drain();
    expect(await k.outcomes(admin, res.body.operation.id)).toEqual({ [b]: ['SKIPPED', 'ALREADY_IN_STATE'] });
    expect(await audit('APPROVE_MENTOR_REQUEST', b)).toHaveLength(1);
    expect(await p().user.count({ where: { username: (await request(b)).username } })).toBe(1);
  });
});
