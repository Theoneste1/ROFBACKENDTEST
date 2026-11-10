/**
 * P1-08 — Super Admin: role rules, step-up, promotion, boundary flag, the
 * last-Super-Admin rule (service + M4 trigger), operator commands (bootstrap /
 * break-glass) and the administrator request audit.
 */
import pg from 'pg';

import { TokenService } from '../src/auth/token.service.js';
import { SuperAdminOperationsService } from '../src/super-admin/super-admin-operations.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Super Admin (P1-08)', () => {
  let ctx: TestContext;
  let admin: string;
  let ops: SuperAdminOperationsService;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };

  /** An active, activated ADMIN with the standard test password. */
  async function makeAdmin(username: string) {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    return p().user.create({ data: {
      username, firstName: username, lastName: 'A', email: `${username}@test.local`, role: 'ADMIN', passwordHash: hash, activatedAt: new Date(),
    } });
  }
  const roleOf = async (id: string) => (await p().user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role;

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    ops = ctx.app.get(SuperAdminOperationsService);
  });
  afterAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    await ctx?.app.close();
  });

  describe('bootstrap (operator command, not an HTTP route)', () => {
    it('refuses without a reason, on a username mismatch, or for a target that is not an active ADMIN — nothing changes', async () => {
      const a = await makeAdmin('boot.target');
      await expect(ops.bootstrap({ username: 'boot.target', confirmUsername: 'boot.target', reason: '' })).rejects.toMatchObject({ code: 'OPERATOR_INPUT_REQUIRED' });
      await expect(ops.bootstrap({ username: 'boot.target', confirmUsername: 'boot.targex', reason: 'first owner' })).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
      await expect(ops.bootstrap({ username: 'mentor.j', confirmUsername: 'mentor.j', reason: 'first owner' })).rejects.toMatchObject({ code: 'NOT_AN_ACTIVE_ADMIN' });
      await p().user.update({ where: { id: a.id }, data: { isActive: false } });
      await expect(ops.bootstrap({ username: 'boot.target', confirmUsername: 'boot.target', reason: 'first owner' })).rejects.toMatchObject({ code: 'NOT_AN_ACTIVE_ADMIN' });
      await p().user.update({ where: { id: a.id }, data: { isActive: true } });
      expect(await p().user.count({ where: { role: 'SUPER_ADMIN' } })).toBe(0);
      expect(await p().auditLog.count({ where: { action: 'SUPER_ADMIN_BOOTSTRAP' } })).toBe(0);
    });

    it('succeeds once: role, sessions ended, audit row in the same transaction, Super Admins e-mailed; a second bootstrap is refused', async () => {
      const oldToken = await login(ctx, 'boot.target');
      const target = await p().user.findUniqueOrThrow({ where: { username: 'boot.target' } });
      await ops.bootstrap({ username: 'boot.target', confirmUsername: 'boot.target', reason: 'Initial Super Admin (owner)' });
      expect(await roleOf(target.id)).toBe('SUPER_ADMIN');
      await http().get('/api/v1/admin/users').set(bearer(oldToken)).expect(401);
      const audit = await p().auditLog.findMany({ where: { action: 'SUPER_ADMIN_BOOTSTRAP' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: null, actorRole: 'OPERATOR', entityId: target.id, metadata: { reason: 'Initial Super Admin (owner)' } });
      expect(await p().emailDelivery.count({ where: { recipientEmail: 'boot.target@test.local', subject: { contains: 'Super Administrator change' } } })).toBe(1);

      await makeAdmin('boot.second');
      await expect(ops.bootstrap({ username: 'boot.second', confirmUsername: 'boot.second', reason: 'again' })).rejects.toMatchObject({ code: 'SUPER_ADMIN_EXISTS' });
      expect(await p().user.count({ where: { role: 'SUPER_ADMIN' } })).toBe(1);
    });
  });

  describe('role rules, step-up and promotion', () => {
    let sa: string;
    beforeAll(async () => { sa = await login(ctx, 'boot.target'); });

    it('step-up: an ADMIN role change needs the actor\'s current password (missing / wrong → 403 STEP_UP_REQUIRED)', async () => {
      const id = ctx.ids.mentorSenior;
      expect(await code(http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'ADMIN' }))).toEqual([403, 'STEP_UP_REQUIRED']);
      expect(await code(http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'ADMIN', currentPassword: 'wrong-password' }))).toEqual([403, 'STEP_UP_REQUIRED']);
      expect(await roleOf(id)).toBe('MENTOR');
      await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'ADMIN', currentPassword: PASSWORD }).expect(200);
      expect(await roleOf(id)).toBe('ADMIN');
      // Demotion from ADMIN needs it too; non-privileged role changes do not.
      expect(await code(http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'MENTOR' }))).toEqual([403, 'STEP_UP_REQUIRED']);
      await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'MENTOR', currentPassword: PASSWORD }).expect(200);
      await http().patch(`/api/v1/admin/users/${ctx.ids.studentSenior}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
      await http().patch(`/api/v1/admin/users/${ctx.ids.studentSenior}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S5' }).expect(200);
    });

    it('an ADMIN can never create, promote to or act on SUPER_ADMIN', async () => {
      const target = await makeAdmin('promo.byadmin');
      expect(await code(http().patch(`/api/v1/admin/users/${target.id}`).set(bearer(admin)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect(await code(http().post('/api/v1/admin/users').set(bearer(admin)).send({ firstName: 'X', lastName: 'Y', username: 'mk.sa', email: 'mk.sa@test.local', password: 'Str0ng!Passw0rd', role: 'SUPER_ADMIN' }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      const saId = (await p().user.findUniqueOrThrow({ where: { username: 'boot.target' } })).id;
      expect(await code(http().patch(`/api/v1/admin/users/${saId}/status`).set(bearer(admin)).send({ isActive: false }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect(await roleOf(target.id)).toBe('ADMIN');
    });

    it('a SUPER_ADMIN promotes an active ADMIN with step-up: audited, sessions ended, every Super Admin e-mailed; never self, never a non-admin', async () => {
      const target = await makeAdmin('promo.target');
      const targetToken = await login(ctx, 'promo.target');
      expect(await code(http().patch(`/api/v1/admin/users/${target.id}`).set(bearer(sa)).send({ role: 'SUPER_ADMIN' }))).toEqual([403, 'STEP_UP_REQUIRED']);
      expect(await code(http().patch(`/api/v1/admin/users/${ctx.ids.mentorJunior}`).set(bearer(sa)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      const saId = (await p().user.findUniqueOrThrow({ where: { username: 'boot.target' } })).id;
      expect(await code(http().patch(`/api/v1/admin/users/${saId}`).set(bearer(sa)).send({ role: 'ADMIN', currentPassword: PASSWORD }))).toEqual([400, 'CANNOT_CHANGE_OWN_ROLE']);

      const before = await p().emailDelivery.count({ where: { subject: { contains: 'Super Administrator change' } } });
      await http().patch(`/api/v1/admin/users/${target.id}`).set(bearer(sa)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD }).expect(200);
      expect(await roleOf(target.id)).toBe('SUPER_ADMIN');
      await http().get('/api/v1/admin/users').set(bearer(targetToken)).expect(401);
      expect(await p().auditLog.count({ where: { action: 'SUPER_ADMIN_PROMOTE', entityId: target.id } })).toBe(1);
      expect(await p().emailDelivery.count({ where: { subject: { contains: 'Super Administrator change' } } })).toBe(before + 2);   // both Super Admins
    });

    it('transfer step with a failure injected after the role write rolls everything back (role, sessions, audit)', async () => {
      const target = await makeAdmin('promo.fail');
      const tokens = ctx.app.get(TokenService);
      const spy = vi.spyOn(tokens, 'revokeAllForUser').mockRejectedValueOnce(new Error('injected failure'));
      const auditBefore = await p().auditLog.count({ where: { entityId: target.id } });
      const tvaBefore = (await p().user.findUniqueOrThrow({ where: { id: target.id } })).tokensValidAfter;
      try {
        expect((await http().patch(`/api/v1/admin/users/${target.id}`).set(bearer(sa)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD })).status).toBe(500);
      } finally { spy.mockRestore(); }
      const after = await p().user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.role).toBe('ADMIN');
      expect(after.tokensValidAfter).toEqual(tvaBefore);
      expect(await p().auditLog.count({ where: { entityId: target.id, action: { in: ['CHANGE_USER_ROLE', 'SUPER_ADMIN_PROMOTE', 'UPDATE_USER'] } } })).toBe(auditBefore);
    });

    it('a SUPER_ADMIN may demote another Super Admin (step-up) while one remains', async () => {
      const other = await p().user.findUniqueOrThrow({ where: { username: 'promo.target' } });
      await http().patch(`/api/v1/admin/users/${other.id}`).set(bearer(sa)).send({ role: 'ADMIN', currentPassword: PASSWORD }).expect(200);
      expect(await roleOf(other.id)).toBe('ADMIN');
      expect(await p().auditLog.count({ where: { action: 'SUPER_ADMIN_DEMOTE', entityId: other.id } })).toBe(1);
    });
  });

  describe('last active Super Admin (service rule + M4 trigger)', () => {
    const saId = () => p().user.findUniqueOrThrow({ where: { username: 'boot.target' } }).then((u) => u.id);

    it.each([
      ['demotion', (id: string) => `UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = '${id}'`],
      ['deactivation', (id: string) => `UPDATE "User" SET "isActive" = false WHERE "id" = '${id}'`],
      ['deletion', (id: string) => `DELETE FROM "User" WHERE "id" = '${id}'`],
    ])('direct SQL %s of the last one is refused by the database', async (_, sql) => {
      const id = await saId();
      await expect(p().$executeRawUnsafe(sql(id))).rejects.toThrow(/LAST_SUPER_ADMIN/);
      expect(await p().user.count({ where: { role: 'SUPER_ADMIN', isActive: true } })).toBe(1);
    });

    it('with two active Super Admins, one may be demoted by SQL; ordinary updates of a Super Admin row are unaffected', async () => {
      const id = await saId();
      await p().user.update({ where: { id }, data: { firstName: 'Owner' } });   // not a removal
      const two = await makeAdmin('sql.second');
      await p().user.update({ where: { id: two.id }, data: { role: 'SUPER_ADMIN' } });
      await p().$executeRawUnsafe(`UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = '${two.id}'`);
      expect(await roleOf(two.id)).toBe('ADMIN');
    });

    it('concurrent demotion of the last two: at most one succeeds, one active Super Admin remains', async (test) => {
      // Needs a database that serves concurrent connections (PostgreSQL; not the local single-connection prisma dev server).
      const probe = async () => {
        const a = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); const b = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, query_timeout: 2000 });
        await a.connect(); await b.connect();
        try { await a.query('BEGIN'); await a.query('SELECT 1'); return await b.query('SELECT 1').then(() => true, () => false); }
        finally { await a.query('ROLLBACK').catch(() => undefined); await a.end().catch(() => undefined); await b.end().catch(() => undefined); }
      };
      if (!(await probe())) {
        if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
        test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      }
      const first = await saId();
      const second = await makeAdmin('race.second');
      await p().user.update({ where: { id: second.id }, data: { role: 'SUPER_ADMIN' } });
      const c1 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      const c2 = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c1.connect(); await c2.connect();
      try {
        await c1.query('BEGIN'); await c2.query('BEGIN');
        await c1.query(`UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = $1`, [first]);
        const pending = c2.query(`UPDATE "User" SET "role" = 'ADMIN' WHERE "id" = $1`, [second.id]).then(() => 'ok', (e) => String(e.message));
        await c1.query('COMMIT');
        const outcome = await pending;
        await c2.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK');
        expect(outcome).toMatch(/LAST_SUPER_ADMIN/);
      } finally {
        await c1.end(); await c2.end();
      }
      expect(await p().user.count({ where: { role: 'SUPER_ADMIN', isActive: true } })).toBe(1);
      // restore the original Super Admin for later tests
      await p().user.update({ where: { id: second.id }, data: { role: 'SUPER_ADMIN' } }).catch(() => undefined);
      await p().user.update({ where: { id: first }, data: { role: 'SUPER_ADMIN' } }).catch(() => undefined);
    });
  });

  let superAdminToken: string;

  describe('break-glass (operator command)', () => {
    it('refuses without reason or approval reference, for a non-Super-Admin reset, or promote-admin while a Super Admin exists', async () => {
      const base = { username: 'boot.target', reason: 'Owner lost e-mail access', approvalRef: 'APR-1' };
      await expect(ops.breakGlass({ ...base, mode: 'reset-credentials', reason: '' })).rejects.toMatchObject({ code: 'OPERATOR_INPUT_REQUIRED' });
      await expect(ops.breakGlass({ ...base, mode: 'reset-credentials', approvalRef: '' })).rejects.toMatchObject({ code: 'OPERATOR_INPUT_REQUIRED' });
      await expect(ops.breakGlass({ ...base, mode: 'reset-credentials', username: 'admin' })).rejects.toMatchObject({ code: 'NOT_A_SUPER_ADMIN' });
      await makeAdmin('glass.promote');
      await expect(ops.breakGlass({ ...base, mode: 'promote-admin', username: 'glass.promote' })).rejects.toMatchObject({ code: 'SUPER_ADMIN_EXISTS' });
      expect(await p().auditLog.count({ where: { action: 'SUPER_ADMIN_BREAK_GLASS' } })).toBe(0);
    });

    it('reset-credentials: one-time password works, the old one does not, sessions end, one audit row with the approval reference', async () => {
      const oldToken = await login(ctx, 'boot.target');
      const r = await ops.breakGlass({ mode: 'reset-credentials', username: 'boot.target', reason: 'Owner lost e-mail access', approvalRef: 'APR-2', operatorNote: 'by phone' });
      expect(r.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      await http().get('/api/v1/admin/users').set(bearer(oldToken)).expect(401);
      await http().post('/api/v1/auth/login').send({ username: 'boot.target', password: PASSWORD }).expect(401);
      const relog = await http().post('/api/v1/auth/login').send({ username: 'boot.target', password: r.temporaryPassword }).expect(200);
      superAdminToken = relog.body.access_token;
      const audit = await p().auditLog.findMany({ where: { action: 'SUPER_ADMIN_BREAK_GLASS' } });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ mode: 'reset-credentials', approvalRef: 'APR-2', operatorNote: 'by phone' });
      expect(JSON.stringify(audit[0].metadata)).not.toContain(r.temporaryPassword!);
    });
  });

  describe('SUPER_ADMIN_BOUNDARY_ENABLED', () => {
    afterEach(() => { delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED; });

    it('on, with an active Super Admin: ADMIN refused on ADMIN accounts; every other ADMIN action unchanged; off again restores at once', async () => {
      const other = await makeAdmin('bound.other');
      process.env.SUPER_ADMIN_BOUNDARY_ENABLED = 'true';
      expect(await code(http().patch(`/api/v1/admin/users/${other.id}`).set(bearer(admin)).send({ firstName: 'X' }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect(await code(http().post('/api/v1/auth/register/admin').set(bearer(admin)).send({ firstName: 'X', lastName: 'Y', username: 'bound.new', email: 'bound.new@test.local', password: 'Str0ng!Passw0rd' }))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      await http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).send({ firstName: 'Still' }).expect(200);
      delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
      await http().patch(`/api/v1/admin/users/${other.id}`).set(bearer(admin)).send({ firstName: 'Back' }).expect(200);
    });

    it('on, with NO active Super Admin: not enforced (no lockout)', async () => {
      const sas = await p().user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true } });
      // Make the Super Admins non-active the only way the trigger allows: add a temporary one, then remove all but it, then it.
      const temp = await makeAdmin('bound.temp');
      try {
        await p().user.update({ where: { id: temp.id }, data: { role: 'SUPER_ADMIN' } });
        for (const s of sas) await p().user.update({ where: { id: s.id }, data: { role: 'ADMIN' } });
        await p().$executeRawUnsafe(`ALTER TABLE "User" DISABLE TRIGGER user_last_super_admin_guard`);
        try {
          await p().user.update({ where: { id: temp.id }, data: { role: 'ADMIN' } });
        } finally {
          await p().$executeRawUnsafe(`ALTER TABLE "User" ENABLE TRIGGER user_last_super_admin_guard`);   // always re-enabled
        }
        const enabled = await p().$queryRaw<Array<{ state: string }>>`SELECT tgenabled::text AS state FROM pg_trigger WHERE tgname = 'user_last_super_admin_guard'`;
        expect(enabled[0].state).toBe('O');   // enabled again
        expect(await p().user.count({ where: { role: 'SUPER_ADMIN', isActive: true } })).toBe(0);
        process.env.SUPER_ADMIN_BOUNDARY_ENABLED = 'true';
        const other = await p().user.findUniqueOrThrow({ where: { username: 'bound.other' } });
        await http().patch(`/api/v1/admin/users/${other.id}`).set(bearer(admin)).send({ firstName: 'NoLockout' }).expect(200);
      } finally {
        for (const s of sas) await p().user.update({ where: { id: s.id }, data: { role: 'SUPER_ADMIN' } });
      }
    });
  });

  describe('administrator request audit', () => {
    const rows = () => p().auditLog.findMany({ where: { action: 'ADMIN_REQUEST' }, orderBy: { createdAt: 'asc' } });
    /** The row is written when the response has finished: wait (bounded) until n new rows exist. */
    async function newRows(before: number, n: number) {
      for (let i = 0; i < 50; i++) {
        const all = await rows();
        if (all.length >= before + n) return all.slice(before);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`expected ${n} new ADMIN_REQUEST row(s)`);
    }

    it('records each state-changing ADMIN request — success and controller failure — once, with route template, ids, final status and request id; no bodies, not reads, not other roles', async () => {
      const before = (await rows()).length;
      const res = await http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}?note=query-secret`).set(bearer(admin)).set('X-Request-Id', 'audit-test-1')
        .send({ firstName: 'Audited', homeLocation: 'Secret-Place' }).expect(200);
      expect(res.headers['x-request-id']).toBe('audit-test-1');
      await http().patch('/api/v1/admin/users/00000000-0000-0000-0000-000000000000').set(bearer(admin)).set('X-Request-Id', 'audit-test-2').send({ firstName: 'Nobody' }).expect(404);
      const mine = await newRows(before, 2);
      await http().get('/api/v1/admin/users').set(bearer(admin)).expect(200);          // read: not recorded
      const student = await login(ctx, 'student.j');
      await http().patch('/api/v1/me').set(bearer(student)).send({ homeLocation: 'Kigali' });   // not an administrator
      await http().post('/api/v1/auth/login').send({ username: 'admin', password: 'wrong-password' });   // unauthenticated
      expect((await rows()).length).toBe(before + 2);   // exactly one row per administrator request, nothing else

      expect(mine.map((r) => [(r.metadata as any).requestId, (r.metadata as any).outcome])).toEqual([['audit-test-1', 200], ['audit-test-2', 404]]);
      expect(mine[0]).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN', entity: 'Request',
        metadata: { method: 'PATCH', route: '/api/v1/admin/users/:id', params: { id: ctx.ids.studentJunior } } });
      expect(Object.keys(mine[0].metadata as object).sort()).toEqual(['method', 'outcome', 'params', 'requestId', 'route']);
      const stored = JSON.stringify(mine);
      for (const secret of ['Secret-Place', 'query-secret', 'note=', 'Audited']) expect(stored).not.toContain(secret);
    });

    it.each([
      ['ADMIN', 'admin', () => http().patch('/api/v1/submissions/00000000-0000-0000-0000-000000000000/start-review'), '/api/v1/submissions/:id/start-review'],
      ['SUPER_ADMIN', 'boot.target', () => http().post('/api/v1/submissions').field('assignmentId', '00000000-0000-0000-0000-000000000000'), '/api/v1/submissions'],
    ] as const)('%s request refused by the permission guard (403) is recorded exactly once with actor, status and request id', async (role, username, make, route) => {
      const user = await p().user.findUniqueOrThrow({ where: { username } });
      const token = role === 'SUPER_ADMIN' ? superAdminToken : admin;
      const before = (await rows()).length;
      const requestId = `guard-denied-${role.toLowerCase()}`;
      const res = await make().set(bearer(token)).set('X-Request-Id', requestId);
      expect([res.status, res.body.code]).toEqual([403, 'PERMISSION_REQUIRED']);
      const [row] = await newRows(before, 1);
      await http().get('/api/v1/admin/users').set(bearer(admin)).expect(200);   // settle: a later request adds nothing
      expect((await rows()).length).toBe(before + 1);
      expect(row).toMatchObject({ actorId: user.id, actorRole: role, entity: 'Request',
        metadata: { route, outcome: 403, requestId } });
    });
  });
});
