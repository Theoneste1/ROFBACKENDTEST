/**
 * P1-08 hardening (owner approval 2026-11-15): the first Super Admin bootstrap.
 *  - the seeded shared account (`admin`, or SEED_ADMIN_USERNAME) is refused — bootstrap and break-glass;
 *  - concurrent bootstraps are serialised by an advisory lock: exactly one Super Admin results;
 *  - `bootstrap --dry-run` (bootstrapPreview) reports and changes nothing;
 *  - a failed bootstrap rolls back completely; the audit row is exact; a second bootstrap is refused;
 *  - an ordinary Administrator cannot promote themselves; the last active Super Admin cannot be
 *    demoted, suspended or deleted.
 * Runs on its own freshly reset test database (fileParallelism: false; never production).
 */
import { TokenService } from '../src/auth/token.service.js';
import { SuperAdminOperationsService } from '../src/super-admin/super-admin-operations.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Super Admin bootstrap hardening', () => {
  let ctx: TestContext;
  let ops: SuperAdminOperationsService;
  let tokens: TokenService;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const superAdmins = () => p().user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
  const bootstrapAudits = () => p().auditLog.count({ where: { action: 'SUPER_ADMIN_BOOTSTRAP' } });
  const breakGlassAudits = () => p().auditLog.count({ where: { action: 'SUPER_ADMIN_BREAK_GLASS' } });
  const boot = (username: string, reason = 'Initial Super Admin (owner approval)') => ops.bootstrap({ username, confirmUsername: username, reason });
  const promote = (username: string) => ops.breakGlass({ mode: 'promote-admin', username, reason: 'Owner account lost', approvalRef: 'APR-T' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** An active, activated ADMIN with the standard test password (a "personal" administrator account). */
  async function makeAdmin(username: string, extra: Record<string, unknown> = {}) {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    return p().user.create({ data: {
      username, firstName: 'Theo', lastName: username, email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date(), ...extra,
    } });
  }
  /** Everything a bootstrap could touch, for "nothing changed" comparisons. */
  async function snapshot() {
    const [users, audits, tokensCount, emails] = await Promise.all([
      p().user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }, orderBy: { id: 'asc' },
        select: { id: true, role: true, isActive: true, activatedAt: true, tokensValidAfter: true, updatedAt: true } }),
      // ADMIN_REQUEST rows log every administrator API request, refused ones included (written after the
      // response); they record the attempt, not a change, so they are checked separately.
      p().auditLog.count({ where: { action: { not: 'ADMIN_REQUEST' } } }), p().refreshToken.count(), p().emailDelivery.count(),
    ]);
    return { users, audits, tokensCount, emails };
  }

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    delete process.env.SEED_ADMIN_USERNAME;
    ctx = await createTestApp();
    ops = ctx.app.get(SuperAdminOperationsService);
    tokens = ctx.app.get(TokenService);
  });
  afterEach(() => { delete process.env.SEED_ADMIN_USERNAME; vi.restoreAllMocks(); });
  afterAll(async () => { await ctx?.app.close(); });

  describe('bootstrap --dry-run (bootstrapPreview)', () => {
    it('reports the target and the Super Admin count, and changes nothing in the database', async () => {
      await makeAdmin('theo.personal');
      await login(ctx, 'theo.personal');   // a live session that a real bootstrap would end
      const before = await snapshot();
      const v = await ops.bootstrapPreview('theo.personal');
      expect(v).toEqual({
        username: 'theo.personal', found: true, name: 'Theo theo.personal', role: 'ADMIN', isActive: true, activated: true,
        activeSuperAdmins: 0, wouldRefuse: null,
      });
      expect(await snapshot()).toEqual(before);
    });

    it('reports the refusal the bootstrap would give: shared account, unknown, inactive, not activated, not an admin', async () => {
      await makeAdmin('dry.inactive', { isActive: false });
      await makeAdmin('dry.pending', { activatedAt: null });
      const before = await snapshot();
      expect((await ops.bootstrapPreview('admin')).wouldRefuse).toBe('SHARED_ACCOUNT_REFUSED');
      expect(await ops.bootstrapPreview('nobody.here')).toMatchObject({ found: false, wouldRefuse: 'NOT_AN_ACTIVE_ADMIN' });
      expect(await ops.bootstrapPreview('dry.inactive')).toMatchObject({ isActive: false, wouldRefuse: 'NOT_AN_ACTIVE_ADMIN' });
      expect(await ops.bootstrapPreview('dry.pending')).toMatchObject({ activated: false, wouldRefuse: 'NOT_AN_ACTIVE_ADMIN' });
      expect(await ops.bootstrapPreview('mentor.j')).toMatchObject({ role: 'MENTOR', wouldRefuse: 'NOT_AN_ACTIVE_ADMIN' });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('shared seeded administrator account', () => {
    it('the seeded `admin` account is refused by the bootstrap and by break-glass promote-admin; nothing changes', async () => {
      const before = await snapshot();
      await expect(boot('admin')).rejects.toMatchObject({ code: 'SHARED_ACCOUNT_REFUSED' });
      await expect(promote('admin')).rejects.toMatchObject({ code: 'SHARED_ACCOUNT_REFUSED' });
      expect(await snapshot()).toEqual(before);
      expect(await superAdmins()).toBe(0);
    });

    it('an account configured through SEED_ADMIN_USERNAME is refused too (and `admin` stays refused)', async () => {
      await makeAdmin('ops.shared');
      process.env.SEED_ADMIN_USERNAME = 'OPS.Shared';
      const before = await snapshot();
      await expect(boot('ops.shared')).rejects.toMatchObject({ code: 'SHARED_ACCOUNT_REFUSED' });
      await expect(promote('ops.shared')).rejects.toMatchObject({ code: 'SHARED_ACCOUNT_REFUSED' });
      await expect(boot('admin')).rejects.toMatchObject({ code: 'SHARED_ACCOUNT_REFUSED' });
      expect((await ops.bootstrapPreview('ops.shared')).wouldRefuse).toBe('SHARED_ACCOUNT_REFUSED');
      expect(await snapshot()).toEqual(before);
      expect(await bootstrapAudits()).toBe(0);
      expect(await breakGlassAudits()).toBe(0);
    });
  });

  describe('failures roll back completely', () => {
    it('a failure after the role write leaves role, sessions, audit and e-mail untouched — and releases the lock', async () => {
      const target = await makeAdmin('roll.back');
      vi.spyOn(tokens, 'revokeAllForUser').mockRejectedValueOnce(new Error('injected failure'));
      const before = await snapshot();
      await expect(boot('roll.back')).rejects.toThrow('injected failure');
      expect(await snapshot()).toEqual(before);
      expect((await p().user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('ADMIN');
      // The advisory lock is transaction-scoped: it was released by the rollback (this would hang otherwise).
      expect(await p().$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${815_2026_0001n}) AS ok`).toEqual([{ ok: true }]);
      await p().$queryRaw`SELECT pg_advisory_unlock(${815_2026_0001n})`;
    });
  });

  describe('concurrent bootstraps', () => {
    it('two simultaneous bootstraps of two personal admins: exactly one succeeds, one Super Admin, one audit row', async () => {
      await makeAdmin('race.one');
      await makeAdmin('race.two');
      // Hold each transaction open after its role write, so without the lock both would pass the count check.
      const original = tokens.revokeAllForUser.bind(tokens);
      vi.spyOn(tokens, 'revokeAllForUser').mockImplementation(async (...args: Parameters<TokenService['revokeAllForUser']>) => {
        await sleep(400);
        return original(...args);
      });
      const results = await Promise.allSettled([boot('race.one'), boot('race.two')]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ code: 'SUPER_ADMIN_EXISTS' });
      expect(await superAdmins()).toBe(1);
      expect(await bootstrapAudits()).toBe(1);
    });

    it('a second bootstrap, a break-glass promotion and a dry run are refused once a Super Admin exists', async () => {
      await makeAdmin('late.admin');
      const before = await snapshot();
      await expect(boot('late.admin')).rejects.toMatchObject({ code: 'SUPER_ADMIN_EXISTS' });
      await expect(promote('late.admin')).rejects.toMatchObject({ code: 'SUPER_ADMIN_EXISTS' });
      expect(await ops.bootstrapPreview('late.admin')).toMatchObject({ activeSuperAdmins: 1, wouldRefuse: 'SUPER_ADMIN_EXISTS' });
      expect(await snapshot()).toEqual(before);
      expect(await superAdmins()).toBe(1);
    });

    it('the audit row records the operator promotion exactly once, without secrets', async () => {
      const sa = await p().user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
      const rows = await p().auditLog.findMany({ where: { action: 'SUPER_ADMIN_BOOTSTRAP' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: null, actorRole: 'OPERATOR', entity: 'User', entityId: sa.id,
        metadata: { reason: 'Initial Super Admin (owner approval)', before: { role: 'ADMIN' }, after: { role: 'SUPER_ADMIN' } },
      });
      expect(JSON.stringify(rows[0].metadata)).not.toMatch(/password|token|hash/i);
    });
  });

  describe('administrators and the last Super Admin', () => {
    it('an ordinary Administrator cannot promote themselves (or anyone) to Super Admin', async () => {
      const self = await makeAdmin('self.promoter');
      const token = await login(ctx, 'self.promoter');
      const [status, errCode] = await code(http().patch(`/api/v1/admin/users/${self.id}`).set(bearer(token)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD }));
      expect(status).toBeGreaterThanOrEqual(400);
      expect(['ROLE_NOT_ASSIGNABLE', 'CANNOT_CHANGE_OWN_ROLE']).toContain(errCode);
      const other = await makeAdmin('self.other');
      expect(await code(http().patch(`/api/v1/admin/users/${other.id}`).set(bearer(token)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect((await p().user.findUniqueOrThrow({ where: { id: self.id } })).role).toBe('ADMIN');
      expect(await p().auditLog.count({ where: { action: 'SUPER_ADMIN_PROMOTE' } })).toBe(0);
      expect(await superAdmins()).toBe(1);
    });

    it('the last active Super Admin cannot be demoted, suspended or deleted — through the API or by SQL', async () => {
      const sa = await p().user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
      const token = await login(ctx, sa.username);
      expect((await http().patch(`/api/v1/admin/users/${sa.id}`).set(bearer(token)).send({ role: 'ADMIN', currentPassword: PASSWORD })).status).toBeGreaterThanOrEqual(400);
      expect((await http().patch(`/api/v1/admin/users/${sa.id}/status`).set(bearer(token)).send({ isActive: false })).status).toBeGreaterThanOrEqual(400);
      expect((await http().delete(`/api/v1/admin/users/${sa.id}`).set(bearer(token))).status).toBeGreaterThanOrEqual(400);
      // An ordinary Administrator cannot act on the Super Admin at all.
      const adminToken = await login(ctx, 'admin');
      // (Super Administrator privacy, owner 2026-11-28: the account does not exist for an Administrator — 404.)
      expect(await code(http().patch(`/api/v1/admin/users/${sa.id}/status`).set(bearer(adminToken)).send({ isActive: false }))).toEqual([404, 'NOT_FOUND']);
      for (const sql of [
        `UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = '${sa.id}'`,
        `UPDATE "User" SET "isActive" = false WHERE "id" = '${sa.id}'`,
        `DELETE FROM "User" WHERE "id" = '${sa.id}'`,
      ]) await expect(p().$executeRawUnsafe(sql)).rejects.toThrow(/LAST_SUPER_ADMIN/);
      expect(await p().user.findUniqueOrThrow({ where: { id: sa.id } })).toMatchObject({ role: 'SUPER_ADMIN', isActive: true });
      expect(await superAdmins()).toBe(1);
    });
  });

  describe('in-app promotion by a Super Admin (PATCH /admin/users/:id) — shared-account rule', () => {
    let saToken: string;
    const patch = (id: string, body: Record<string, unknown>, token = saToken) => http().patch(`/api/v1/admin/users/${id}`).set(bearer(token)).send(body);
    const promotions = () => p().auditLog.count({ where: { action: 'SUPER_ADMIN_PROMOTE' } });
    beforeAll(async () => {
      const sa = await p().user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
      saToken = await login(ctx, sa.username);
    });

    it('the seeded `admin` account: promotion refused with SHARED_ACCOUNT_REFUSED, even with a valid step-up; nothing changes', async () => {
      const before = await snapshot();
      expect(await code(patch(ctx.ids.admin, { role: 'SUPER_ADMIN', currentPassword: PASSWORD }))).toEqual([403, 'SHARED_ACCOUNT_REFUSED']);
      expect(await snapshot()).toEqual(before);
      expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).role).toBe('ADMIN');
      expect(await promotions()).toBe(0);
      // The refused attempt itself is on the audit trail (administrator request audit, outcome 403).
      const attempt = async () => (await p().auditLog.findMany({ where: { action: 'ADMIN_REQUEST' } }))
        .find((r) => (r.metadata as any)?.params?.id === ctx.ids.admin && (r.metadata as any)?.outcome === 403);
      for (let i = 0; i < 40 && !(await attempt()); i++) await sleep(50);
      expect(await attempt()).toBeTruthy();
    });

    it('the account configured through SEED_ADMIN_USERNAME: promotion refused too', async () => {
      const configured = await makeAdmin('ops.portal');
      process.env.SEED_ADMIN_USERNAME = 'Ops.Portal';
      const before = await snapshot();
      expect(await code(patch(configured.id, { role: 'SUPER_ADMIN', currentPassword: PASSWORD }))).toEqual([403, 'SHARED_ACCOUNT_REFUSED']);
      expect(await snapshot()).toEqual(before);
      expect(await promotions()).toBe(0);
    });

    it('no bypass by renaming: the shared account keeps its username (alone, or renamed and promoted in one request; Super Admin or Administrator)', async () => {
      const adminToken = await login(ctx, 'admin');
      const otherAdmin = await makeAdmin('rename.actor');
      const otherToken = await login(ctx, otherAdmin.username);
      const before = await snapshot();
      expect(await code(patch(ctx.ids.admin, { username: 'admin.renamed', currentPassword: PASSWORD }))).toEqual([403, 'SHARED_ACCOUNT_REFUSED']);
      expect(await code(patch(ctx.ids.admin, { username: 'admin.renamed', role: 'SUPER_ADMIN', currentPassword: PASSWORD }))).toEqual([403, 'SHARED_ACCOUNT_REFUSED']);
      expect(await code(patch(ctx.ids.admin, { username: 'admin.renamed' }, otherToken))).toEqual([403, 'SHARED_ACCOUNT_REFUSED']);
      expect(await snapshot()).toEqual(before);
      expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).username).toBe('admin');
      // Ordinary edits of the shared account still work (no lockout of the account's normal administration).
      await patch(ctx.ids.admin, { firstName: 'Shared' }, otherToken).expect(200);
      expect(adminToken).toBeTruthy();
    });

    it('a legitimate personal Administrator is still promoted: audited, sessions ended', async () => {
      const personal = await makeAdmin('personal.promote');
      const personalToken = await login(ctx, personal.username);
      await patch(personal.id, { role: 'SUPER_ADMIN', currentPassword: PASSWORD }).expect(200);
      expect((await p().user.findUniqueOrThrow({ where: { id: personal.id } })).role).toBe('SUPER_ADMIN');
      expect(await p().auditLog.count({ where: { action: 'SUPER_ADMIN_PROMOTE', entityId: personal.id } })).toBe(1);
      await http().get('/api/v1/admin/users').set(bearer(personalToken)).expect(401);
      expect(await superAdmins()).toBe(2);
    });
  });
});
