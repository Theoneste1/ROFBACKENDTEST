/**
 * Activate now (owner 2026-11-24): an administrator activates an account "Awaiting setup" (never activated) whose person
 * chose their own password, so they sign in without confirming their e-mail.
 *  - single: POST /admin/users/:id/activate-now — students, teachers and coaches sign in afterwards; their unused
 *    activation links stop working (revoked, never deleted); audit ACTIVATE_ACCOUNT { via: 'admin', activatedBy };
 *  - refusals: already active, no password yet, not ACTIVE (deactivated / suspended / archived), rank (an
 *    Administrator never acts on an Administrator or Super Administrator), users.changeStatus denied, one's own account;
 *    403 for teachers, coaches and students; 401 anonymous;
 *  - bulk action activateNow: the preview counts who will be activated and each skip reason; execute applies the same
 *    rules per account, audited per account with the operation id.
 * Runs on its own freshly reset test database (never production).
 */
import { ActivationService } from '../src/auth/activation.service.js';
import { BulkOperationsWorker } from '../src/bulk/bulk-operations.worker.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Activate now', () => {
  let ctx: TestContext;
  let admin: string;
  let hash: string;
  let worker: BulkOperationsWorker;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const activateNow = (id: string, token: string | null = admin) => {
    const req = http().post(`/api/v1/admin/users/${id}/activate-now`);
    return token ? req.set(bearer(token)) : req;
  };
  const loginCode = async (username: string) => (await http().post('/api/v1/auth/login').send({ username, password: PASSWORD })).body?.code ?? 'OK';
  let n = 0;
  const key = () => `activate-now-${++n}-${Date.now()}`;

  type Role = 'STUDENT' | 'TEACHER' | 'MENTOR' | 'ADMIN' | 'SUPER_ADMIN';
  /** An account awaiting setup (never activated) with the standard test password, unless overridden. */
  async function awaiting(username: string, role: Role = 'STUDENT', extra: Record<string, unknown> = {}) {
    return p().user.create({
      data: {
        username, firstName: username, lastName: 'Waiting', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: null,
        ...(role === 'STUDENT' && { gradeLevel: 'S2', divisionId: ctx.ids.junior, dateOfBirth: new Date('2010-05-01T00:00:00Z') }),
        ...extra,
      },
    });
  }
  async function makeAdmin(username: string, role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN') {
    await p().user.create({ data: { username, firstName: username, lastName: 'Admin', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
    return login(ctx, username);
  }
  const auditsFor = (entityId: string) => p().auditLog.findMany({ where: { action: 'ACTIVATE_ACCOUNT', entityId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    worker = ctx.app.get(BulkOperationsWorker);
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  // ─── One account ────────────────────────────────────────────────────────────

  it('the same account activated twice at the same moment (double click, two administrators): one succeeds, the other is told it is already active; one audit entry (QA 2026-11-24)', async () => {
    const u = await awaiting('an.twice');
    const results = await Promise.all([activateNow(u.id), activateNow(u.id), activateNow(u.id)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body).toMatchObject({ code: 'ALREADY_ACTIVATED', message: 'This account is already active. The person can sign in.' });
    }
    expect(await auditsFor(u.id)).toHaveLength(1);
    expect(await loginCode('an.twice')).toBe('OK');
  });

  it.each([['STUDENT', 'an.student'], ['TEACHER', 'an.teacher'], ['MENTOR', 'an.coach']] as const)(
    'a self-registered %s awaiting setup is activated and signs in at once; links revoked; audited', async (role, username) => {
      const u = await awaiting(username, role);
      expect(await loginCode(username)).toBe('ACCOUNT_NOT_ACTIVATED');
      // The account page knows the person chose a password (never the hash itself).
      const detail = await http().get(`/api/v1/admin/users/${u.id}`).set(bearer(admin)).expect(200);
      expect(detail.body).toMatchObject({ activatedAt: null, hasPassword: true });
      expect(detail.body).not.toHaveProperty('passwordHash');
      // A live e-mail confirmation link, and an older one already used (left as it is).
      const link = await ctx.app.get(ActivationService).issue(u.id, 'EMAIL_VERIFICATION', null);
      const used = await p().accountActivationToken.create({
        data: { userId: u.id, purpose: 'EMAIL_VERIFICATION', tokenHash: `used-${username}`, expiresAt: new Date(Date.now() + 3_600_000), usedAt: new Date('2026-01-01') },
      });

      const res = await activateNow(u.id).expect(200);
      expect(res.body).toMatchObject({
        user: { id: u.id, username, role, accountStatus: 'ACTIVE', isActive: true, activatedAt: expect.any(String) },
        stillBlockedBy: [], message: 'The account is active. The person can sign in now.',
      });
      expect(await loginCode(username)).toBe('OK');

      // The unused link is revoked (kept), so it can never be used; the used one is untouched.
      const tokens = await p().accountActivationToken.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } });
      expect(tokens).toHaveLength(2);
      expect(tokens.find((t) => t.id === used.id)).toMatchObject({ revokedAt: null, usedAt: new Date('2026-01-01') });
      expect(tokens.find((t) => t.id !== used.id)?.revokedAt).toBeInstanceOf(Date);
      expect((await http().post('/api/v1/auth/activate').send({ token: link.token })).status).toBeGreaterThanOrEqual(400);

      const [audit] = await auditsFor(u.id);
      expect(audit).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN', entity: 'User' });
      expect(audit.metadata).toMatchObject({ via: 'admin', activatedBy: ctx.ids.admin, linksRevoked: 1, operationId: null, stillBlockedBy: [] });

      // Idempotent: a second call changes nothing and says so in plain words.
      const again = await activateNow(u.id).expect(409);
      expect(again.body).toMatchObject({ code: 'ALREADY_ACTIVATED', message: 'This account is already active. The person can sign in.' });
      expect(await auditsFor(u.id)).toHaveLength(1);
    });

  it('an invited person without a password → 409 NO_PASSWORD_YET (resend the invitation instead); nothing changes', async () => {
    const u = await awaiting('an.invited', 'STUDENT', { passwordHash: null });
    const link = await ctx.app.get(ActivationService).issue(u.id, 'INVITATION', ctx.ids.admin);
    expect((await http().get(`/api/v1/admin/users/${u.id}`).set(bearer(admin)).expect(200)).body.hasPassword).toBe(false);
    const res = await activateNow(u.id).expect(409);
    expect(res.body).toMatchObject({
      code: 'NO_PASSWORD_YET', message: 'This person has not set a password yet. Resend the invitation instead; they choose a password from its link.',
    });
    expect((await p().user.findUniqueOrThrow({ where: { id: u.id } })).activatedAt).toBeNull();
    expect((await p().accountActivationToken.findFirstOrThrow({ where: { userId: u.id } })).revokedAt).toBeNull();
    expect(link.token).toBeTruthy();
    expect(await auditsFor(u.id)).toHaveLength(0);
  });

  it.each([['DEACTIVATED', 'Reactivate it first'], ['SUSPENDED', 'Lift the suspension first'], ['ARCHIVED', 'Restore it first']] as const)(
    'a %s account → 409 ACCOUNT_NOT_ACTIVE, saying what to do first; nothing changes', async (status, step) => {
      const u = await awaiting(`an.${status.toLowerCase()}`, 'STUDENT', { accountStatus: status, isActive: false });
      const res = await activateNow(u.id).expect(409);
      expect(res.body.code).toBe('ACCOUNT_NOT_ACTIVE');
      expect(res.body.message).toContain(step);
      expect((await p().user.findUniqueOrThrow({ where: { id: u.id } })).activatedAt).toBeNull();
      expect(await auditsFor(u.id)).toHaveLength(0);
    });

  it('rank: an Administrator never activates a Super Administrator, nor (Super Admin boundary on) another Administrator; a Super Administrator may', async () => {
    const otherAdmin = await awaiting('an.admin2', 'ADMIN');
    const superAdmin = await awaiting('an.super2', 'SUPER_ADMIN');
    const sa = await makeAdmin('an.super', 'SUPER_ADMIN');
    // Super Administrator privacy (owner 2026-11-28): for an Administrator a Super Administrator does not exist — 404.
    expect(await code(activateNow(superAdmin.id))).toEqual([404, 'NOT_FOUND']);
    process.env.SUPER_ADMIN_BOUNDARY_ENABLED = 'true';
    try {
      expect(await code(activateNow(otherAdmin.id))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
    } finally {
      delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    }
    expect((await p().user.findUniqueOrThrow({ where: { id: otherAdmin.id } })).activatedAt).toBeNull();
    expect((await p().user.findUniqueOrThrow({ where: { id: superAdmin.id } })).activatedAt).toBeNull();

    await activateNow(otherAdmin.id, sa).expect(200);
    await activateNow(superAdmin.id, sa).expect(200);
    expect(await loginCode('an.admin2')).toBe('OK');
    const [audit] = await auditsFor(superAdmin.id);
    expect(audit).toMatchObject({ actorRole: 'SUPER_ADMIN' });
    expect(audit.metadata).toMatchObject({ via: 'admin', activatedBy: (await p().user.findUniqueOrThrow({ where: { username: 'an.super' } })).id });
  });

  it('permissions: users.changeStatus denied → 403 PERMISSION_REQUIRED; own account refused; 404 unknown; teachers, coaches, students 403; anonymous 401', async () => {
    const u = await awaiting('an.perm');
    const limited = await makeAdmin('an.limited');
    const limitedUser = await p().user.findUniqueOrThrow({ where: { username: 'an.limited' } });
    await p().userPermissionOverride.create({ data: { userId: limitedUser.id, permission: 'users.changeStatus', effect: 'DENY', reason: 'activate-now test' } });
    expect(await code(activateNow(u.id, limited))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await code(activateNow(limitedUser.id, limited))).toEqual([400, 'CANNOT_CHANGE_OWN_STATUS']);
    expect(await code(activateNow('00000000-0000-4000-8000-000000000000'))).toEqual([404, 'NOT_FOUND']);

    await p().user.create({ data: { username: 'an.teacher.caller', firstName: 'T', lastName: 'C', email: 'an.teacher.caller@test.local', role: 'TEACHER', passwordHash: hash, activatedAt: new Date() } });
    for (const who of ['an.teacher.caller', 'mentor.j', 'student.j']) {
      expect(await code(activateNow(u.id, await login(ctx, who)))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
    expect((await activateNow(u.id, null)).status).toBe(401);
    expect((await p().user.findUniqueOrThrow({ where: { id: u.id } })).activatedAt).toBeNull();
    expect(await auditsFor(u.id)).toHaveLength(0);
  });

  it('another block stays and is reported: a coach still waiting for approval is activated, stillBlockedBy PENDING_APPROVAL', async () => {
    const u = await awaiting('an.pending', 'MENTOR', { isApproved: false });
    const res = await activateNow(u.id).expect(200);
    expect(res.body.stillBlockedBy).toEqual(['PENDING_APPROVAL']);
    expect(await loginCode('an.pending')).toBe('ACCOUNT_PENDING_APPROVAL');
  });

  // ─── Bulk ───────────────────────────────────────────────────────────────────

  it('bulk activateNow: the preview counts who will be activated and why the others are skipped; execute applies the same rules, audited with the operation id', async () => {
    const ok1 = await awaiting('bulk.ok1');
    const ok2 = await awaiting('bulk.ok2', 'TEACHER');
    const ok3 = await awaiting('bulk.ok3', 'MENTOR');
    const done = await awaiting('bulk.done', 'STUDENT', { activatedAt: new Date() });
    const noPw1 = await awaiting('bulk.nopw1', 'STUDENT', { passwordHash: null });
    const noPw2 = await awaiting('bulk.nopw2', 'MENTOR', { passwordHash: null });
    const susp = await awaiting('bulk.susp', 'STUDENT', { accountStatus: 'SUSPENDED', isActive: false });
    // Super Administrator privacy (owner 2026-11-28): for an Administrator a Super Administrator's id is like an unknown id —
    // not part of the selection at all (it was SKIPPED ROLE_NOT_MANAGEABLE before).
    const adm = await awaiting('bulk.super', 'SUPER_ADMIN');
    const ids = [ok1, ok2, ok3, done, noPw1, noPw2, susp, adm].map((u) => u.id).concat(ctx.ids.admin);

    const body = { action: 'activateNow', selection: { mode: 'ids', ids } };
    const pv = await http().post('/api/v1/admin/bulk/USER/preview').set(bearer(admin)).send(body).expect(200);
    expect(pv.body).toMatchObject({ action: 'activateNow', total: 8, willApply: 3, requiresReason: false, requiresStepUp: false });
    expect(pv.body.consequences[0]).toMatch(/without confirming their e-mail/);
    const byCode = Object.fromEntries(pv.body.warnings.map((w: any) => [w.code, w.count]));
    expect(byCode).toEqual({ INCLUDES_YOURSELF: 1, ACCOUNT_NOT_ACTIVE: 1, ALREADY_ACTIVATED: 1, NO_PASSWORD_YET: 2 });
    for (const w of pv.body.warnings) expect(w.message.length).toBeGreaterThan(20);
    // The /admin/users/bulk preview is the same engine.
    const old = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send(body).expect(200);
    expect(old.body.willApply).toBe(3);

    const ex = await http().post('/api/v1/admin/bulk/USER').set(bearer(admin)).send({
      action: 'activateNow', selection: pv.body.selection, selectionToken: pv.body.selectionToken, expectedTotal: 8, confirm: true, idempotencyKey: key(),
    }).expect(202);
    const opId = ex.body.operation.id;
    while ((await worker.processBatch()) > 0) { /* until nothing is pending */ }
    const op = await http().get(`/api/v1/admin/bulk/operations/${opId}`).set(bearer(admin)).expect(200);
    expect(op.body).toMatchObject({ status: 'COMPLETED', total: 8, succeeded: 3, skipped: 5, failed: 0 });

    const items = await http().get(`/api/v1/admin/bulk/operations/${opId}/items`).query({ limit: 100 }).set(bearer(admin)).expect(200);
    const outcome = Object.fromEntries(items.body.data.map((i: any) => [i.entityId, [i.outcome, i.code ?? null]]));
    expect(outcome).toEqual({
      [ok1.id]: ['SUCCEEDED', null], [ok2.id]: ['SUCCEEDED', null], [ok3.id]: ['SUCCEEDED', null],
      [done.id]: ['SKIPPED', 'ALREADY_ACTIVATED'], [noPw1.id]: ['SKIPPED', 'NO_PASSWORD_YET'], [noPw2.id]: ['SKIPPED', 'NO_PASSWORD_YET'],
      [susp.id]: ['SKIPPED', 'ACCOUNT_NOT_ACTIVE'], [ctx.ids.admin]: ['SKIPPED', 'SELF'],
    });

    for (const [u, name] of [[ok1, 'bulk.ok1'], [ok2, 'bulk.ok2'], [ok3, 'bulk.ok3']] as const) {
      expect(await loginCode(name)).toBe('OK');
      const audits = await auditsFor(u.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN' });
      expect(audits[0].metadata).toMatchObject({ via: 'admin', activatedBy: ctx.ids.admin, operationId: opId });
    }
    for (const u of [done, noPw1, noPw2, susp, adm]) expect(await auditsFor(u.id)).toHaveLength(0);
    for (const u of [noPw1, noPw2, susp, adm]) expect((await p().user.findUniqueOrThrow({ where: { id: u.id } })).activatedAt).toBeNull();
    // The bulk operation itself is audited with its id, like every bulk action.
    expect(await p().auditLog.count({ where: { entityId: opId } })).toBeGreaterThan(0);
  });

  it('bulk activateNow by filter: "Awaiting setup" (isActivated=false) selects exactly the accounts never activated', async () => {
    await awaiting('flt.a1');
    await awaiting('flt.a2');
    await awaiting('flt.done', 'STUDENT', { activatedAt: new Date() });
    const pv = await http().post('/api/v1/admin/bulk/USER/preview').set(bearer(admin))
      .send({ action: 'activateNow', selection: { mode: 'filter', filter: { search: 'flt.', isActivated: false } } }).expect(200);
    expect(pv.body).toMatchObject({ total: 2, willApply: 2, warnings: [] });
  });

  it('bulk activateNow needs users.changeStatus: denied → 403 PERMISSION_REQUIRED at preview', async () => {
    const u = await awaiting('bulk.perm');
    const t = await makeAdmin('bulk.limited');
    const lu = await p().user.findUniqueOrThrow({ where: { username: 'bulk.limited' } });
    await p().userPermissionOverride.create({ data: { userId: lu.id, permission: 'users.changeStatus', effect: 'DENY', reason: 'activate-now bulk test' } });
    expect(await code(http().post('/api/v1/admin/bulk/USER/preview').set(bearer(t)).send({ action: 'activateNow', selection: { mode: 'ids', ids: [u.id] } })))
      .toEqual([403, 'PERMISSION_REQUIRED']);
  });
});
