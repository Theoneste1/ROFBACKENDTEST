/**
 * Account states (2026-11-16): ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED — transitions, reasons, the restore
 * confirmation and stillBlockedBy, permissions, the role policy (Super Admin, boundary flag), the last Super Admin,
 * session invalidation, login per state, history and audit, no deletion, history preserved, the compatible
 * PATCH /status. Runs on its own freshly reset test database (never production).
 */
import { AccountStatusService } from '../src/users/account-status.service.js';
import { LEGACY_SUSPEND_REASON } from '../src/users/users.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Account states', () => {
  let ctx: TestContext;
  let admin: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const status = (id: string, body: Record<string, unknown>, token = admin) =>
    http().post(`/api/v1/admin/users/${id}/status-changes`).set(bearer(token)).send(body);
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const stateOf = async (id: string) => p().user.findUniqueOrThrow({ where: { id }, select: { accountStatus: true, isActive: true } });
  const loginCode = async (username: string) => (await http().post('/api/v1/auth/login').send({ username, password: PASSWORD })).body?.code ?? 'OK';

  /** An activated account with the standard test password. */
  async function makeUser(username: string, role: 'MENTOR' | 'ADMIN' | 'SUPER_ADMIN' | 'TEACHER' = 'MENTOR', extra: Record<string, unknown> = {}) {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    return p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } });
  }

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
  });
  afterEach(() => { delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED; });
  afterAll(async () => { await ctx?.app.close(); });

  it('every account starts ACTIVE; the list shows and filters accountStatus', async () => {
    const res = await http().get('/api/v1/admin/users').query({ accountStatus: 'ACTIVE', limit: 100 }).set(bearer(admin)).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((u: any) => u.accountStatus === 'ACTIVE' && u.isActive === true)).toBe(true);
    await http().get('/api/v1/admin/users').query({ accountStatus: 'SOMETHING' }).set(bearer(admin)).expect(400);
  });

  it('deactivate → sessions end at once (access and refresh), login says ACCOUNT_DEACTIVATED; reactivate needs no reason', async () => {
    const u = await makeUser('st.deact');
    const session = await http().post('/api/v1/auth/login').send({ username: 'st.deact', password: PASSWORD }).expect(200);
    await http().get('/api/v1/me').set(bearer(session.body.access_token)).expect(200);

    expect(await code(status(u.id, { toStatus: 'DEACTIVATED' }))).toEqual([400, 'REASON_REQUIRED']);
    const res = await status(u.id, { toStatus: 'DEACTIVATED', reason: 'Left the programme for this year' }).expect(200);
    expect(res.body.user).toMatchObject({ accountStatus: 'DEACTIVATED', isActive: false });
    expect(res.body.change).toMatchObject({ fromStatus: 'ACTIVE', toStatus: 'DEACTIVATED', reason: 'Left the programme for this year', actor: { username: 'admin' } });

    await http().get('/api/v1/me').set(bearer(session.body.access_token)).expect(401);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: session.body.refresh_token }).expect(401);
    expect(await loginCode('st.deact')).toBe('ACCOUNT_DEACTIVATED');

    const back = await status(u.id, { toStatus: 'ACTIVE' }).expect(200);
    expect(back.body).toMatchObject({ user: { accountStatus: 'ACTIVE', isActive: true }, stillBlockedBy: [] });
    expect(await loginCode('st.deact')).toBe('OK');
  });

  it('suspend → ACCOUNT_SUSPENDED; a suspended account cannot be deactivated; lift; then archive → ACCOUNT_ARCHIVED', async () => {
    const u = await makeUser('st.susp');
    await status(u.id, { toStatus: 'SUSPENDED', reason: 'Investigation pending' }).expect(200);
    expect(await loginCode('st.susp')).toBe('ACCOUNT_SUSPENDED');
    expect(await code(status(u.id, { toStatus: 'SUSPENDED', reason: 'again' }))).toEqual([409, 'STATUS_UNCHANGED']);
    expect(await code(status(u.id, { toStatus: 'DEACTIVATED', reason: 'not allowed' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
    await status(u.id, { toStatus: 'ACTIVE' }).expect(200);
    await status(u.id, { toStatus: 'ARCHIVED', reason: 'Graduated' }).expect(200);
    expect(await stateOf(u.id)).toEqual({ accountStatus: 'ARCHIVED', isActive: false });
    expect(await loginCode('st.susp')).toBe('ACCOUNT_ARCHIVED');
    for (const to of ['DEACTIVATED', 'SUSPENDED']) {
      expect(await code(status(u.id, { toStatus: to, reason: 'not from archive' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
    }
  });

  it('restoring an archived account needs a reason AND confirm: true; it then signs in again', async () => {
    const u = await makeUser('st.restore');
    await status(u.id, { toStatus: 'ARCHIVED', reason: 'Graduated' }).expect(200);
    expect(await code(status(u.id, { toStatus: 'ACTIVE', confirm: true }))).toEqual([400, 'REASON_REQUIRED']);
    expect(await code(status(u.id, { toStatus: 'ACTIVE', reason: 'Back for coaching' }))).toEqual([400, 'CONFIRMATION_REQUIRED']);
    expect(await code(status(u.id, { toStatus: 'ACTIVE', reason: 'Back for coaching', confirm: false }))).toEqual([400, 'CONFIRMATION_REQUIRED']);
    expect(await stateOf(u.id)).toEqual({ accountStatus: 'ARCHIVED', isActive: false });
    const res = await status(u.id, { toStatus: 'ACTIVE', reason: 'Back for coaching', confirm: true }).expect(200);
    expect(res.body).toMatchObject({ user: { accountStatus: 'ACTIVE' }, stillBlockedBy: [] });
    expect(await loginCode('st.restore')).toBe('OK');
  });

  it('a restore sets the state only: never activated, not approved, locked and disabled-role accounts stay blocked (stillBlockedBy)', async () => {
    const never = await makeUser('st.never', 'MENTOR', { activatedAt: null, isApproved: false });
    const locked = await makeUser('st.locked', 'MENTOR', { lockedUntil: new Date(Date.now() + 15 * 60_000) });
    const teacher = await makeUser('st.teacher', 'TEACHER');   // TEACHERS_ENABLED is off in tests
    for (const u of [never, locked, teacher]) await status(u.id, { toStatus: 'ARCHIVED', reason: 'Archive for the test' }).expect(200);

    const r1 = await status(never.id, { toStatus: 'ACTIVE', reason: 'Restore for the test', confirm: true }).expect(200);
    expect(r1.body.stillBlockedBy).toEqual(['NOT_ACTIVATED', 'PENDING_APPROVAL']);
    expect(await p().user.findUniqueOrThrow({ where: { id: never.id } })).toMatchObject({ accountStatus: 'ACTIVE', activatedAt: null, isApproved: false });
    expect(await loginCode('st.never')).toBe('ACCOUNT_NOT_ACTIVATED');

    const r2 = await status(locked.id, { toStatus: 'ACTIVE', reason: 'Restore for the test', confirm: true }).expect(200);
    expect(r2.body.stillBlockedBy).toEqual(['LOCKED']);
    expect((await p().user.findUniqueOrThrow({ where: { id: locked.id } })).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await http().post('/api/v1/auth/login').send({ username: 'st.locked', password: PASSWORD })).status).toBe(401);   // a lock answers like a wrong password

    const r3 = await status(teacher.id, { toStatus: 'ACTIVE', reason: 'Restore for the test', confirm: true }).expect(200);
    expect(r3.body.stillBlockedBy).toEqual(['ROLE_DISABLED']);
    expect((await p().user.findUniqueOrThrow({ where: { id: teacher.id } })).role).toBe('TEACHER');
  });

  it('history: every change, newest first, with who and why; one USER_STATUS_CHANGED audit row each', async () => {
    const u = await makeUser('st.hist');
    await status(u.id, { toStatus: 'DEACTIVATED', reason: 'Reason one' }).expect(200);
    await status(u.id, { toStatus: 'ACTIVE' }).expect(200);
    await status(u.id, { toStatus: 'ARCHIVED', reason: 'Reason three' }).expect(200);
    const h = await http().get(`/api/v1/admin/users/${u.id}/status-history`).query({ limit: 2 }).set(bearer(admin)).expect(200);
    expect(h.body.accountStatus).toBe('ARCHIVED');
    expect(h.body.meta.total).toBe(3);
    expect(h.body.data.map((c: any) => [c.fromStatus, c.toStatus, c.reason])).toEqual([['ACTIVE', 'ARCHIVED', 'Reason three'], ['DEACTIVATED', 'ACTIVE', null]]);
    expect(h.body.data[0].actor).toMatchObject({ username: 'admin' });
    expect(h.body.data[0].requestId).toEqual(expect.any(String));
    const audit = await p().auditLog.findMany({ where: { action: 'USER_STATUS_CHANGED', entityId: u.id }, orderBy: { createdAt: 'asc' } });
    expect(audit).toHaveLength(3);
    expect(audit[0].metadata).toMatchObject({ before: { accountStatus: 'ACTIVE' }, after: { accountStatus: 'DEACTIVATED' }, reason: 'Reason one', sessionsEnded: true });
    expect(audit[2].actorId).toBe(ctx.ids.admin);
    await http().get(`/api/v1/admin/users/${u.id}/status-history`).set(bearer(await login(ctx, 'mentor.j'))).expect(403);
  });

  it('blocking voids unused password-reset and activation links (no old link reopens the account)', async () => {
    const u = await makeUser('st.links');
    await p().passwordResetToken.create({ data: { userId: u.id, tokenHash: 'h-reset-st-links', expiresAt: new Date(Date.now() + 3_600_000) } });
    await p().accountActivationToken.create({ data: { userId: u.id, purpose: 'INVITATION', tokenHash: 'h-act-st-links', expiresAt: new Date(Date.now() + 3_600_000) } });
    await status(u.id, { toStatus: 'SUSPENDED', reason: 'Links test' }).expect(200);
    expect((await p().passwordResetToken.findFirstOrThrow({ where: { userId: u.id } })).usedAt).not.toBeNull();
    expect((await p().accountActivationToken.findFirstOrThrow({ where: { userId: u.id } })).revokedAt).not.toBeNull();
  });

  it('refusals: own account, unknown account, a Coach caller, a missing per-transition permission', async () => {
    expect(await code(status(ctx.ids.admin, { toStatus: 'SUSPENDED', reason: 'self' }))).toEqual([400, 'CANNOT_CHANGE_OWN_STATUS']);
    expect((await status('11111111-1111-4111-8111-111111111111', { toStatus: 'SUSPENDED', reason: 'nobody' })).status).toBe(404);
    expect(await code(status(ctx.ids.studentJunior, { toStatus: 'SUSPENDED', reason: 'coach' }, await login(ctx, 'mentor.j')))).toEqual([403, 'PERMISSION_REQUIRED']);

    // An Administrator denied users.archive (individual override) can still suspend, but not archive.
    const limited = await makeUser('adm.limited', 'ADMIN');
    await p().userPermissionOverride.create({ data: { userId: limited.id, permission: 'users.archive', effect: 'DENY', reason: 'test' } });
    const token = await login(ctx, 'adm.limited');
    const target = await makeUser('st.target');
    expect(await code(status(target.id, { toStatus: 'ARCHIVED', reason: 'no permission' }, token))).toEqual([403, 'PERMISSION_REQUIRED']);
    await status(target.id, { toStatus: 'SUSPENDED', reason: 'allowed' }, token).expect(200);
    expect(await code(status(target.id, { toStatus: 'ARCHIVED', reason: 'no permission' }, token))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('the role policy applies: an ADMIN cannot change a Super Admin; with the boundary on, not another ADMIN either', async () => {
    const sa = await makeUser('st.sa', 'SUPER_ADMIN');
    expect(await code(status(sa.id, { toStatus: 'SUSPENDED', reason: 'admin on SA' }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
    const other = await makeUser('st.otheradmin', 'ADMIN');
    process.env.SUPER_ADMIN_BOUNDARY_ENABLED = 'true';
    expect(await code(status(other.id, { toStatus: 'SUSPENDED', reason: 'boundary' }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
    const saToken = await login(ctx, 'st.sa');
    await status(other.id, { toStatus: 'SUSPENDED', reason: 'boundary, by the Super Admin' }, saToken).expect(200);
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    await status(other.id, { toStatus: 'ACTIVE' }).expect(200);   // flag off: the ADMIN manages ADMINs again
  });

  it('the last active Super Admin cannot be deactivated, suspended or archived (service and database)', async () => {
    const svc = ctx.app.get(AccountStatusService);
    const sas = await p().user.findMany({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } });
    expect(sas).toHaveLength(1);
    const operator = { id: '00000000-0000-4000-8000-000000000001', role: 'SUPER_ADMIN', overrides: [] } as any;
    for (const toStatus of ['DEACTIVATED', 'SUSPENDED', 'ARCHIVED'] as const) {
      await expect(svc.change(sas[0].id, { toStatus, reason: 'last one' }, operator)).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    }
    await expect(p().$executeRawUnsafe(`UPDATE "User" SET "accountStatus" = 'ARCHIVED' WHERE "id" = '${sas[0].id}'`)).rejects.toThrow(/LAST_SUPER_ADMIN/);
    expect(await stateOf(sas[0].id)).toEqual({ accountStatus: 'ACTIVE', isActive: true });
  });

  it('DELETE never deletes (409 PERMANENT_DELETION_DISABLED); archiving keeps every record; restoring brings it all back', async () => {
    const id = ctx.ids.studentJunior;
    await p().notification.create({ data: { userId: id, type: 'SYSTEM', title: 'Kept', body: 'Kept across states' } as any }).catch(async () => undefined);
    // Every row that points at the account, in every table, before archiving.
    const fks = await p().$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT kcu.table_name, kcu.column_name FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'User' AND ccu.column_name = 'id'`;
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const f of fks) {
        if (f.table_name === 'UserStatusChange' || f.table_name === 'AuditLog' || f.table_name === 'RefreshToken') continue;   // these grow
        const r = await p().$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${f.table_name}" WHERE "${f.column_name}" = $1`, id);
        if (r[0].n) out[`${f.table_name}.${f.column_name}`] = r[0].n;
      }
      return out;
    };
    const before = await counts();
    expect(Object.keys(before).length).toBeGreaterThan(0);

    expect(await code(http().delete(`/api/v1/admin/users/${id}`).set(bearer(admin)))).toEqual([409, 'PERMANENT_DELETION_DISABLED']);
    expect(await p().user.count({ where: { id } })).toBe(1);

    await status(id, { toStatus: 'ARCHIVED', reason: 'Archive with history' }).expect(200);
    expect(await counts()).toEqual(before);
    await status(id, { toStatus: 'ACTIVE', reason: 'Restore with history', confirm: true }).expect(200);
    expect(await counts()).toEqual(before);
    expect(await loginCode('student.j')).toBe('OK');
  });

  it('PATCH /status stays compatible: false → SUSPENDED (recorded with its reason), true → ACTIVE, an archived account is refused', async () => {
    const u = await makeUser('st.legacy');
    const off = await http().patch(`/api/v1/admin/users/${u.id}/status`).set(bearer(admin)).send({ isActive: false }).expect(200);
    expect(off.body).toMatchObject({ isActive: false, accountStatus: 'SUSPENDED' });
    expect(await p().userStatusChange.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'desc' } })).toMatchObject({ toStatus: 'SUSPENDED', reason: LEGACY_SUSPEND_REASON });
    expect(await loginCode('st.legacy')).toBe('ACCOUNT_SUSPENDED');
    const on = await http().patch(`/api/v1/admin/users/${u.id}/status`).set(bearer(admin)).send({ isActive: true }).expect(200);
    expect(on.body).toMatchObject({ isActive: true, accountStatus: 'ACTIVE' });
    await status(u.id, { toStatus: 'ARCHIVED', reason: 'archived' }).expect(200);
    expect(await code(http().patch(`/api/v1/admin/users/${u.id}/status`).set(bearer(admin)).send({ isActive: true }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
    expect(await code(http().patch(`/api/v1/admin/users/${ctx.ids.admin}/status`).set(bearer(admin)).send({ isActive: false }))).toEqual([400, 'CANNOT_SUSPEND_SELF']);
  });

  it('other accounts are unaffected: they still sign in and use the API', async () => {
    for (const username of ['admin', 'mentor.j', 'student.j2']) expect(await loginCode(username)).toBe('OK');
    await http().get('/api/v1/me').set(bearer(await login(ctx, 'student.j2'))).expect(200);
  });
});
