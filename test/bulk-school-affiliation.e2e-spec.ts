/**
 * The SCHOOL_AFFILIATION record type of the bulk engine (2026-11-20; docs/operations/bulk-operations.md): verify or
 * reject many students' school claims at once through /admin/bulk/SCHOOL_AFFILIATION, with the single routes' code
 * (POST /admin/school-affiliations/:id/verify|reject), permission (schools.manage), notices and audit rows (plus the
 * operation id).
 */
import { SchoolAffiliationService } from '../src/schools/affiliations/school-affiliation.service.js';
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';
import { bulkKit } from './support/bulk-kit.js';

describe('Bulk SCHOOL_AFFILIATION actions', () => {
  let ctx: TestContext;
  let admin: string;
  let hash: string;
  let schoolA: string, schoolB: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const A = '/api/v1/admin/school-affiliations';
  let k: ReturnType<typeof bulkKit>;
  let seq = 0;

  /** A student at a school with a current PENDING claim (claimedName: a "not listed" claim matched to it). Returns the claim id. */
  async function claim(schoolId: string | null, claimedName?: string) {
    const n = ++seq;
    const u = await p().user.create({ data: {
      username: `bulkaff.s${n}`, firstName: 'Bulk', lastName: `S${n}`, email: `bulkaff.s${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId,
    } });
    return p().$transaction((tx) => ctx.app.get(SchoolAffiliationService).claim(tx, {
      studentId: u.id, schoolId, source: 'ADMIN', reason: 'NEW_CLAIM', actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' },
      ...(claimedName && { claimed: { name: claimedName, country: 'RW' } }),
    }));
  }
  async function makeAdmin(username: string) {
    await p().user.create({ data: { username, firstName: 'Other', lastName: 'Admin', email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
    return login(ctx, username);
  }
  const audit = (action: string, entityId: string) => p().auditLog.findMany({ where: { action, entityId } });
  const statusOf = async (id: string) => (await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id } })).status;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    schoolA = (await p().school.create({ data: { name: 'BULKAFF SCHOOL A', location: 'Huye', code: '220901', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } })).id;
    schoolB = (await p().school.create({ data: { name: 'BULKAFF SCHOOL B', location: 'Huye', code: '220902', province: 'Southern Province', district: 'Huye', sector: 'Tumba' } })).id;
    k = bulkKit(ctx, 'SCHOOL_AFFILIATION');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('preview by filter (the list filters; current claims by default): count, sample, warnings', async () => {
    const pending = [await claim(schoolB), await claim(schoolB)];
    const verified = await claim(schoolB);
    await http().post(`${A}/${verified}/verify`).set(bearer(admin)).send({}).expect(200);
    const pv = await k.preview(admin, { action: 'verify', selection: { mode: 'filter', filter: { schoolId: schoolB } } }).expect(200);
    expect(pv.body).toMatchObject({ entityType: 'SCHOOL_AFFILIATION', total: 3, requiresReason: false, warnings: [{ code: 'ALREADY_IN_STATE', count: 1 }] });
    expect(pv.body.sample.map((s: any) => s.id).sort()).toEqual([...pending, verified].sort());
    expect(pv.body.sample[0]).toMatchObject({ status: expect.any(String), student: { username: expect.stringMatching(/^bulkaff\./) }, school: { id: schoolB, name: 'BULKAFF SCHOOL B' } });
    const onlyPending = await k.preview(admin, { action: 'verify', selection: { mode: 'filter', filter: { schoolId: schoolB, status: 'PENDING' } } }).expect(200);
    expect(onlyPending.body).toMatchObject({ total: 2, warnings: [] });
    const list = await http().get(A).query({ schoolId: schoolB, status: 'PENDING' }).set(bearer(admin)).expect(200);
    expect(list.body.data.map((c: any) => c.id).sort()).toEqual([...pending].sort());
    expect(await k.code(k.preview(admin, { action: 'verify', selection: { mode: 'filter', filter: { status: 'MAYBE' } } }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await k.code(k.preview(admin, { action: 'revoke', selection: { mode: 'ids', ids: pending } }))).toEqual([400, 'BULK_ACTION_UNKNOWN']);
  });

  it('verify by ids: SUCCEEDED / SKIPPED / FAILED per claim; audit identical to the single route plus the operation id; the notice once', async () => {
    const single = await claim(schoolA);
    const ok = await claim(schoolA);
    const notListed = await claim(schoolA, 'Bulk Aff Hill School');
    const rejected = await claim(schoolA);
    const noSchool = await claim(null, 'Somewhere Unknown');
    const closed = await claim(schoolA);
    await http().post(`${A}/${rejected}/reject`).set(bearer(admin)).send({ reason: 'Wrong school' }).expect(200);
    await http().post(`${A}/${single}/verify`).set(bearer(admin)).send({ note: 'Checked the register' }).expect(200);
    const [singleAudit] = await audit('SCHOOL_AFFILIATION_VERIFIED', single);

    const ids = [ok, notListed, rejected, noSchool, closed];
    const pv = await k.preview(admin, { action: 'verify', selection: { mode: 'ids', ids } }).expect(200);
    expect(pv.body.warnings.map((w: any) => [w.code, w.count])).toEqual([['NOT_APPLICABLE', 1], ['AFFILIATION_SCHOOL_REQUIRED', 1]]);
    // The closed school is deactivated after the preview (same records → the confirmation still holds).
    const closedSchool = (await p().school.create({ data: { name: 'BULKAFF CLOSED', location: 'Huye', code: '220903', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } })).id;
    const closedStudent = (await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: closed } })).studentId;
    await p().$transaction(async (tx) => {
      await ctx.app.get(SchoolAffiliationService).supersede(tx, closedStudent, 'SCHOOL_CHANGE', { actorId: ctx.ids.admin, actorRole: 'ADMIN' });
      await tx.user.update({ where: { id: closedStudent }, data: { schoolId: closedSchool } });
    });
    const closedClaim = await claim(closedSchool);
    await p().school.update({ where: { id: closedSchool }, data: { isActive: false } });
    const pv2 = await k.preview(admin, { action: 'verify', selection: { mode: 'ids', ids: [ok, notListed, rejected, noSchool, closed, closedClaim] } }).expect(200);
    const res = await k.execute(admin, k.confirmBody(pv2, { reason: 'Checked the register' })).expect(202);
    const opId = res.body.operation.id;
    await k.drain();
    await waitForEvents();

    expect(await k.outcomes(admin, opId)).toEqual({
      [ok]: ['SUCCEEDED', null], [notListed]: ['SUCCEEDED', null], [rejected]: ['SKIPPED', 'NOT_APPLICABLE'],
      [noSchool]: ['FAILED', 'AFFILIATION_SCHOOL_REQUIRED'], [closed]: ['SKIPPED', 'AFFILIATION_SUPERSEDED'], [closedClaim]: ['FAILED', 'SCHOOL_INACTIVE'],
    });
    expect(await k.progress(admin, opId)).toMatchObject({ status: 'COMPLETED_WITH_FAILURES', succeeded: 2, skipped: 2, failed: 2 });
    expect(await statusOf(ok)).toBe('VERIFIED');
    expect(await statusOf(noSchool)).toBe('PENDING');
    expect(await statusOf(closedClaim)).toBe('PENDING');
    const [bulkAudit] = await audit('SCHOOL_AFFILIATION_VERIFIED', ok);
    const { studentId: _s1, schoolId: _c1, ...singleRest } = singleAudit.metadata as any;
    const { studentId: s2, schoolId: c2, ...bulkRest } = bulkAudit.metadata as any;
    expect(bulkRest).toEqual({ ...singleRest, operationId: opId });
    expect([s2, c2]).toEqual([(await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: ok } })).studentId, schoolA]);
    expect(bulkAudit).toMatchObject({ actorId: singleAudit.actorId, actorRole: singleAudit.actorRole, entity: 'StudentSchoolAffiliation' });
    // The "not listed" claim's student is told once (school.request.verified), as by the single route; the others are not.
    const notListedStudent = (await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: notListed } })).studentId;
    expect(await p().notificationOutbox.count({ where: { type: 'school.request.verified', dedupeKey: `school.request.verified:student:${notListedStudent}:school:${schoolA}` } })).toBe(1);
    expect(await p().notificationOutbox.count({ where: { type: 'school.request.verified', entityId: ok } })).toBe(0);
  });

  it('reject by filter: reason required and shown to the student; audit identical to the single route plus the operation id', async () => {
    const school = (await p().school.create({ data: { name: 'BULKAFF REJECT', location: 'Huye', code: '220904', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } })).id;
    const single = await claim(school);
    await http().post(`${A}/${single}/reject`).set(bearer(admin)).send({ reason: 'Not on the school register' }).expect(200);
    const [singleAudit] = await audit('SCHOOL_AFFILIATION_REJECTED', single);
    const claims = [await claim(school), await claim(school)];
    const pv = await k.preview(admin, { action: 'reject', selection: { mode: 'filter', filter: { schoolId: school, status: 'PENDING' } } }).expect(200);
    expect(pv.body).toMatchObject({ total: 2, requiresReason: true });
    expect(await k.code(k.execute(admin, k.confirmBody(pv)))).toEqual([400, 'REASON_REQUIRED']);
    const res = await k.execute(admin, k.confirmBody(pv, { reason: 'Not on the school register' })).expect(202);
    await k.drain();
    expect(await k.progress(admin, res.body.operation.id)).toMatchObject({ status: 'COMPLETED', succeeded: 2 });
    for (const id of claims) {
      const row = await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'REJECTED', decisionReason: 'Not on the school register', decidedById: ctx.ids.admin });
      const [a] = await audit('SCHOOL_AFFILIATION_REJECTED', id);
      const { studentId: _x, ...rest } = a.metadata as any;
      const { studentId: _y, ...singleRest } = singleAudit.metadata as any;
      expect(rest).toEqual({ ...singleRest, operationId: res.body.operation.id });
      // The student sees the reason (what GET /me/school-affiliation returns).
      const me = await ctx.app.get(SchoolAffiliationService).mine({ id: row.studentId } as never);
      expect(me.current).toMatchObject({ status: 'REJECTED', reason: 'Not on the school register' });
    }
  });

  it('permissions: schools.manage is required on top of users.bulkManage', async () => {
    const ids = [await claim(schoolA)];
    const other = await makeAdmin('bulkaff.noperm');
    const u = await p().user.findUniqueOrThrow({ where: { username: 'bulkaff.noperm' } });
    await p().userPermissionOverride.create({ data: { userId: u.id, permission: 'schools.manage', effect: 'DENY', reason: 'bulk test' } });
    expect(await k.code(k.preview(other, { action: 'verify', selection: { mode: 'ids', ids } }))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await k.code(k.preview(other, { action: 'reject', selection: { mode: 'ids', ids } }))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await http().post(`${A}/${ids[0]}/verify`).set(bearer(other)).send({})).status).toBe(403);
    // A Coach (no users.bulkManage) is refused before anything else.
    expect((await k.preview(await login(ctx, 'mentor.j'), { action: 'verify', selection: { mode: 'ids', ids } })).status).toBe(403);
    expect(await statusOf(ids[0])).toBe('PENDING');
  });

  it('a claim changed between preview and execute: filter → 409 SELECTION_CHANGED; ids → skipped (decided meanwhile)', async () => {
    const school = (await p().school.create({ data: { name: 'BULKAFF RACE', location: 'Huye', code: '220905', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } })).id;
    const [a, b] = [await claim(school), await claim(school)];
    const pv = await k.preview(admin, { action: 'verify', selection: { mode: 'filter', filter: { schoolId: school, status: 'PENDING' } } }).expect(200);
    await http().post(`${A}/${a}/reject`).set(bearer(admin)).send({ reason: 'Decided by hand' }).expect(200);
    expect(await k.code(k.execute(admin, k.confirmBody(pv)))).toEqual([409, 'SELECTION_CHANGED']);

    const pv2 = await k.preview(admin, { action: 'verify', selection: { mode: 'ids', ids: [b] } }).expect(200);
    await http().post(`${A}/${b}/verify`).set(bearer(admin)).send({}).expect(200);
    const res = await k.execute(admin, k.confirmBody(pv2)).expect(202);
    await k.drain();
    expect(await k.outcomes(admin, res.body.operation.id)).toEqual({ [b]: ['SKIPPED', 'ALREADY_IN_STATE'] });
    expect(await audit('SCHOOL_AFFILIATION_VERIFIED', b)).toHaveLength(1);
  });
});
