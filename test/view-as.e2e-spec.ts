/**
 * "View as" (owner decision 2026-11-23), end to end: an administrator sees the platform exactly as a lower-ranked user
 * does, READ ONLY.
 *  - start (users.impersonate) → single-use 60-second ticket → 30-minute viewing token (no refresh, no cookie);
 *  - GET /me and the portal's reads are the viewed user's; GET /me carries `viewAs`;
 *  - every change is refused (403 VIEW_AS_READ_ONLY) — sampled by hand AND swept over every registered non-GET route —
 *    and nothing changes in the database; GET side effects (course first open, activity) do not happen;
 *  - the rank rule: lower roles only, never a Super Administrator, never yourself; a Head Coach only by a GRANT;
 *  - a DENY override or a suspension of the viewer ends running sessions at once (401 VIEW_AS_ENDED);
 *  - tickets: single use, expire, unknown refused; the viewing token never reaches a normal session;
 *  - audit rows for start and end; the viewed user's own sessions are untouched.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { JwtService } from '@nestjs/jwt';

import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';
import { markViewing, runWithRequestContext } from '../src/common/request-context.js';

const READ_ONLY = 'VIEW_AS_READ_ONLY';
const ENDED = 'VIEW_AS_ENDED';

describe('View as, read only (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  let admin: string, superAdmin: string;
  let saId: string, sa2Id: string, admin2Id: string, teacherId: string, hcId: string, suspendedId: string;
  const code = async (req: any): Promise<[number, string | null]> => { const r = await req; return [r.status, r.body?.code ?? null]; };

  /** Start as `actor` and exchange the ticket: the viewing token and the exchange body. */
  async function view(actor: string, targetId: string, reason?: string) {
    const start = await http().post(`/api/v1/admin/users/${targetId}/view-as`).set(bearer(actor)).send(reason ? { reason } : {});
    if (start.status !== 201) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
    const ex = await http().post('/api/v1/auth/view-as/exchange').send({ ticket: start.body.ticket });
    if (ex.status !== 200) throw new Error(`exchange failed: ${ex.status} ${JSON.stringify(ex.body)}`);
    return { token: ex.body.accessToken as string, body: ex.body, ticket: start.body.ticket as string, startBody: start.body, exchange: ex };
  }

  /** Every table's content (except the audit log and the viewing sessions themselves), as one hash per table. */
  async function fingerprint(): Promise<Record<string, string>> {
    const tables = await p().$queryRaw<Array<{ t: string }>>`
      SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'
        AND tablename NOT IN ('AuditLog', 'ViewAsSession', '_prisma_migrations') ORDER BY 1`;
    const out: Record<string, string> = {};
    for (const { t } of tables) {
      const [row] = await p().$queryRawUnsafe<Array<{ h: string }>>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`);
      out[t] = row.h;
    }
    return out;
  }

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    const make = async (username: string, role: 'SUPER_ADMIN' | 'ADMIN' | 'TEACHER' | 'HEAD_COACH' | 'STUDENT', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username.split('.')[1] ?? username, lastName: 'Viewas', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    saId = await make('va.super', 'SUPER_ADMIN');
    sa2Id = await make('va.super2', 'SUPER_ADMIN');
    admin2Id = await make('va.admin2', 'ADMIN');
    teacherId = await make('va.teacher', 'TEACHER');
    hcId = await make('va.hc', 'HEAD_COACH');
    suspendedId = await make('va.suspended', 'STUDENT', { isActive: false, accountStatus: 'SUSPENDED', gradeLevel: 'S2', divisionId: ctx.ids.junior, dateOfBirth: new Date('2011-01-01T00:00:00Z') });
    admin = await login(ctx, 'admin');
    superAdmin = await login(ctx, 'va.super');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  describe('starting', () => {
    it('401 anonymous; 403 for students, teachers, coaches and Head Coaches without the permission', async () => {
      const url = `/api/v1/admin/users/${ctx.ids.studentJunior}/view-as`;
      expect(await code(http().post(url).send({}))).toEqual([401, 'UNAUTHORIZED']);
      for (const username of ['student.j', 'va.teacher', 'mentor.j', 'va.hc']) {
        expect([username, ...(await code(http().post(url).set(bearer(await login(ctx, username))).send({})))]).toEqual([username, 403, 'PERMISSION_REQUIRED']);
      }
      expect(await p().viewAsSession.count()).toBe(0);
    });

    it('returns a single-use ticket (stored hashed, about 60 seconds), never a token; audited VIEW_AS_STARTED with the reason and request id', async () => {
      const res = await http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/view-as`).set(bearer(admin)).set('X-Request-Id', 'req-view-1')
        .send({ reason: 'Parent says the dashboard is empty' }).expect(201);
      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'ticket']);
      const left = new Date(res.body.expiresAt).getTime() - Date.now();
      expect(left).toBeGreaterThan(30_000);
      expect(left).toBeLessThanOrEqual(60_000);
      expect(res.headers['set-cookie']).toBeUndefined();
      const row = await p().viewAsSession.findFirstOrThrow({ where: { actorId: ctx.ids.admin, targetId: ctx.ids.studentJunior } });
      expect(row.ticketHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ticketHash).not.toContain(res.body.ticket);
      expect(row).toMatchObject({ reason: 'Parent says the dashboard is empty', startedAt: null, requestId: 'req-view-1' });
      const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'VIEW_AS_STARTED', entityId: row.id } });
      expect(audit).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN' });
      expect(audit.metadata).toMatchObject({ targetUserId: ctx.ids.studentJunior, targetRole: 'STUDENT', reason: 'Parent says the dashboard is empty', requestId: 'req-view-1' });
    });

    it('tickets: single use; unknown refused; an expired one refused', async () => {
      const first = await view(admin, ctx.ids.studentJunior2);
      expect(await code(http().post('/api/v1/auth/view-as/exchange').send({ ticket: first.ticket }))).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      expect(await code(http().post('/api/v1/auth/view-as/exchange').send({ ticket: 'x'.repeat(43) }))).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      expect(await code(http().post('/api/v1/auth/view-as/exchange').send({}))).toEqual([400, 'VALIDATION_FAILED']);
      const late = await http().post(`/api/v1/admin/users/${ctx.ids.studentJunior2}/view-as`).set(bearer(admin)).send({}).expect(201);
      await p().viewAsSession.updateMany({ where: { startedAt: null, targetId: ctx.ids.studentJunior2 }, data: { ticketExpiresAt: new Date(Date.now() - 1000) } });
      const refused = await http().post('/api/v1/auth/view-as/exchange').send({ ticket: late.body.ticket }).expect(403);
      expect(refused.body.code).toBe('VIEW_AS_NOT_ALLOWED');
      expect(refused.body.message).toMatch(/works once, for one minute/);
    });

    it('the exchange gives a 30-minute viewing token: no refresh token, no cookie', async () => {
      const { body, exchange } = await view(admin, ctx.ids.studentJunior);
      expect(exchange.headers['set-cookie']).toBeUndefined();
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'expiresAt', 'tokenType', 'viewAs']);
      expect(JSON.stringify(body)).not.toMatch(/refresh/i);
      const left = new Date(body.expiresAt).getTime() - Date.now();
      expect(left).toBeGreaterThan(29 * 60_000);
      expect(left).toBeLessThanOrEqual(30 * 60_000);
      expect(body.viewAs).toMatchObject({ actor: { id: ctx.ids.admin, role: 'ADMIN' }, target: { id: ctx.ids.studentJunior, name: 'student.j Test', role: 'STUDENT' } });
      const claims = JSON.parse(Buffer.from(body.accessToken.split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({ sub: ctx.ids.studentJunior, va: { actorId: ctx.ids.admin, sessionId: body.viewAs.sessionId } });
      expect(claims.exp - claims.iat).toBe(1800);
    });
  });

  describe('who may be viewed (lower roles only)', () => {
    const start = (token: string, id: string) => code(http().post(`/api/v1/admin/users/${id}/view-as`).set(bearer(token)).send({}));

    it('an Administrator views a student, teacher, coach and Head Coach — each sees exactly their own portal', async () => {
      for (const [id, role, username] of [
        [ctx.ids.studentJunior, 'STUDENT', 'student.j'], [teacherId, 'TEACHER', 'va.teacher'], [ctx.ids.mentorJunior, 'MENTOR', 'mentor.j'], [hcId, 'HEAD_COACH', 'va.hc'],
      ] as const) {
        const ownToken = await login(ctx, username);   // signing in sets lastLoginAt: before viewing, so both reads agree
        const { token } = await view(admin, id);
        const me = (await http().get('/api/v1/me').set(bearer(token)).expect(200)).body;
        expect(me).toMatchObject({ id, username, role, viewAs: { actor: { id: ctx.ids.admin, role: 'ADMIN' }, target: { id, role } } });
        const own = (await http().get('/api/v1/me').set(bearer(ownToken)).expect(200)).body;
        const { viewAs: _viewAs, ...profile } = me;
        expect(profile).toEqual(own);
        const perms = (await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body;
        expect(perms.role).toBe(role);
        expect(perms.permissions).not.toContain('users.impersonate');
        // An administrator-only read is refused, exactly as for that user.
        expect((await http().get('/api/v1/admin/users').set(bearer(token))).status).toBe(403);
      }
    });

    it('nobody views a Super Administrator, an Administrator (unless Super Admin) or themselves', async () => {
      // Super Administrator privacy (owner 2026-11-28): for an Administrator a Super Administrator does not exist (404).
      expect(await start(admin, saId)).toEqual([404, 'NOT_FOUND']);
      expect(await start(admin, admin2Id)).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      expect(await start(admin, ctx.ids.admin)).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      expect(await start(superAdmin, sa2Id)).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      expect(await start(superAdmin, saId)).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      expect(await start(admin, '00000000-0000-4000-8000-000000000999')).toEqual([404, 'NOT_FOUND']);
      const msg = (await http().post(`/api/v1/admin/users/${admin2Id}/view-as`).set(bearer(admin)).send({})).body.message;
      expect(msg).toBe('You can only view the platform as users with a lower role than yours, so not as an administrator.');
    });

    it('a Super Administrator views an Administrator (and sees the admin portal, read only)', async () => {
      const { token } = await view(superAdmin, admin2Id);
      expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body).toMatchObject({ id: admin2Id, role: 'ADMIN' });
      expect((await http().get('/api/v1/admin/users').set(bearer(token))).status).toBe(200);
    });

    it('a suspended account can still be viewed (read only)', async () => {
      const { token } = await view(admin, suspendedId);
      expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body).toMatchObject({ id: suspendedId, viewAs: { target: { id: suspendedId } } });
      expect(await p().user.findUniqueOrThrow({ where: { id: suspendedId }, select: { accountStatus: true } })).toEqual({ accountStatus: 'SUSPENDED' });
    });

    it('a Head Coach with a GRANT override views a coach, never an administrator or another Head Coach', async () => {
      const hc = await login(ctx, 'va.hc');
      expect(await start(hc, ctx.ids.mentorJunior)).toEqual([403, 'PERMISSION_REQUIRED']);
      const grant = await http().post(`/api/v1/admin/users/${hcId}/permission-overrides`).set(bearer(superAdmin))
        .send({ permission: 'users.impersonate', effect: 'GRANT', reason: 'Support lead' }).expect(201);
      const { token } = await view(hc, ctx.ids.mentorJunior);
      expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body).toMatchObject({ id: ctx.ids.mentorJunior, role: 'MENTOR' });
      expect(await start(hc, ctx.ids.admin)).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      const otherHc = (await p().user.create({ data: { username: 'va.hc2', firstName: 'H2', lastName: 'Viewas', email: 'va.hc2@test.local', role: 'HEAD_COACH', activatedAt: new Date() } })).id;
      expect(await start(hc, otherHc)).toEqual([403, 'VIEW_AS_NOT_ALLOWED']);
      // Never grantable to a Student, Teacher or Coach.
      for (const id of [ctx.ids.studentJunior, teacherId, ctx.ids.mentorJunior]) {
        expect(await code(http().post(`/api/v1/admin/users/${id}/permission-overrides`).set(bearer(superAdmin)).send({ permission: 'users.impersonate', effect: 'GRANT', reason: 'Not for this role' })))
          .toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
      }
      // Revoking the GRANT ends the Head Coach's running session at once.
      await http().delete(`/api/v1/admin/users/${hcId}/permission-overrides/${grant.body.id}`).set(bearer(superAdmin)).send({ reason: 'done' }).expect(200);
      expect(await code(http().get('/api/v1/me').set(bearer(token)))).toEqual([401, ENDED]);
    });
  });

  describe('read only', () => {
    it('GET /me, notifications and courses are the student\'s; reading has no side effect (no first open, no activity, notifications stay unread)', async () => {
      const n = await p().notification.create({ data: { userId: ctx.ids.studentJunior, category: 'ACCOUNT', type: 'general', title: 'Hello', body: 'Unread', data: {} } });
      await p().courseEnrollment.deleteMany({ where: { studentId: ctx.ids.studentJunior } });
      const before = await fingerprint();
      const activity = await p().activityLog.count();
      const { token } = await view(admin, ctx.ids.studentJunior);
      const list = (await http().get('/api/v1/notifications').set(bearer(token)).expect(200)).body;
      expect(JSON.stringify(list)).toContain(n.id);
      await http().get(`/api/v1/notifications/${n.id}`).set(bearer(token)).expect(200);
      expect((await http().get('/api/v1/notifications/unread-count').set(bearer(token)).expect(200)).body.unread).toBeGreaterThanOrEqual(1);
      const courses = (await http().get('/api/v1/courses').set(bearer(token)).expect(200)).body;
      expect(JSON.stringify(courses)).toContain(ctx.ids.algebra);
      const course = (await http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(token)).expect(200)).body;
      expect(course).toMatchObject({ id: ctx.ids.algebra, enrollmentStatus: 'UNROLLED' });
      await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200);
      await http().get('/api/v1/me/enrollments').set(bearer(token)).expect(200);
      await new Promise((r) => setTimeout(r, 200));   // fire-and-forget writes would have landed by now
      expect(await fingerprint()).toEqual(before);
      expect(await p().activityLog.count()).toBe(activity);
      expect((await p().notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull();
      // The same read by the student themselves does record the first open (the side effect is real).
      await http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(await login(ctx, 'student.j'))).expect(200);
      expect(await p().courseEnrollment.count({ where: { studentId: ctx.ids.studentJunior } })).toBe(1);
    });

    it('every change is refused with the plain message and nothing changes (profile, password, gender, picture, notification, submission, discussion, sign-out everywhere, refresh)', async () => {
      const { token } = await view(admin, ctx.ids.studentJunior);
      const n = await p().notification.create({ data: { userId: ctx.ids.studentJunior, category: 'ACCOUNT', type: 'general', title: 'Hi', body: 'x', data: {} } });
      const before = await fingerprint();
      const v = bearer(token);
      const attempts: Array<[string, () => any]> = [
        ['PATCH /me', () => http().patch('/api/v1/me').set(v).send({ firstName: 'Changed' })],
        ['PATCH /auth/password', () => http().patch('/api/v1/auth/password').set(v).send({ currentPassword: PASSWORD, newPassword: 'N3w-Passw0rd!x' })],
        ['PUT /me/gender', () => http().put('/api/v1/me/gender').set(v).send({ gender: 'FEMALE' })],
        ['PUT /me/avatar', () => http().put('/api/v1/me/avatar').set(v).attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'a.jpg')],
        ['DELETE /me/avatar', () => http().delete('/api/v1/me/avatar').set(v)],
        ['PATCH /notifications/:id/read', () => http().patch(`/api/v1/notifications/${n.id}/read`).set(v)],
        ['POST /notifications/read-all', () => http().post('/api/v1/notifications/read-all').set(v)],
        ['POST /submissions', () => http().post('/api/v1/submissions').set(v).field('assignmentId', '00000000-0000-4000-8000-000000000001').field('textAnswer', 'x')],
        ['POST /courses/:id/threads', () => http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(v).send({ title: 'T', body: 'B' })],
        ['POST /me/tests/:id/submission', () => http().post('/api/v1/me/tests/00000000-0000-4000-8000-000000000001/submission').set(v).send({})],
        ['POST /auth/logout-all', () => http().post('/api/v1/auth/logout-all').set(v)],
        ['POST /auth/refresh', () => http().post('/api/v1/auth/refresh').set(v).send({})],
      ];
      for (const [name, req] of attempts) {
        const res = await req();
        expect([name, res.status, res.body.code]).toEqual([name, 403, READ_ONLY]);
        // A public route (refresh) has no signed-in user, so it cannot name the viewed user.
        const who = name === 'POST /auth/refresh' ? 'another user' : 'student.j Test';
        expect([name, res.body.message]).toEqual([name, `You are viewing the platform as ${who}. Nothing can be changed in this view. Return to your own account to make changes.`]);
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(await fingerprint()).toEqual(before);
    });

    it('a Super Admin viewing an Administrator: administrator changes (users, bulk, marking, settings) are refused; the refused attempt is audited as the viewer', async () => {
      const { token, body } = await view(superAdmin, admin2Id);
      const v = bearer(token);
      const before = await fingerprint();
      for (const [name, req] of [
        ['POST /admin/users', () => http().post('/api/v1/admin/users').set(v).send({ username: 'x.new', firstName: 'X', lastName: 'Y', email: 'x@test.local', role: 'STUDENT' })],
        ['PATCH /admin/users/:id', () => http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(v).send({ firstName: 'Z' })],
        ['POST /admin/users/:id/status-changes', () => http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/status-changes`).set(v).send({ toStatus: 'SUSPENDED', reason: 'x' })],
        ['POST /admin/users/bulk', () => http().post('/api/v1/admin/users/bulk').set(v).send({})],
        ['POST /admin/bulk/preview', () => http().post('/api/v1/admin/bulk/preview').set(v).send({})],
        ['POST /admin/users/:id/view-as', () => http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/view-as`).set(v).send({})],
        ['POST /auth/register/admin', () => http().post('/api/v1/auth/register/admin').set(v).send({})],
      ] as Array<[string, () => any]>) {
        const res = await req();
        expect([name, res.status, res.body.code]).toEqual([name, 403, READ_ONLY]);
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(await fingerprint()).toEqual(before);
      const rows = await p().auditLog.findMany({ where: { action: 'ADMIN_REQUEST', createdAt: { gte: new Date(Date.now() - 60_000) } } });
      const mine = rows.filter((r) => (r.metadata as any)?.viewingAs?.sessionId === body.viewAs.sessionId);
      expect(mine.length).toBeGreaterThanOrEqual(6);
      for (const r of mine) expect(r).toMatchObject({ actorId: saId, actorRole: 'SUPER_ADMIN' });
      expect(rows.filter((r) => r.actorId === admin2Id)).toEqual([]);
    });

    it('sweep: EVERY registered non-GET route is refused with a viewing token (student and administrator viewed), except ending the session, signing out of the tab and exchanging a ticket', async () => {
      const routes = (JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'api', 'routes.json'), 'utf8')) as Array<{ method: string; path: string }>)
        .filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
      expect(routes.length).toBeGreaterThan(200);
      const ALLOWED = ['POST /api/v1/auth/logout', 'POST /api/v1/auth/view-as/end', 'POST /api/v1/auth/view-as/exchange'];
      const viewers = [(await view(admin, ctx.ids.studentJunior2)).token, (await view(superAdmin, admin2Id)).token];
      const before = await fingerprint();
      const id = '00000000-0000-4000-8000-0000000000aa';
      for (const token of viewers) {
        for (const r of routes) {
          const key = `${r.method} ${r.path}`;
          if (ALLOWED.includes(key)) continue;
          const url = r.path.replace(/\{[^}]+\}/g, id);
          const res = await (http() as any)[r.method.toLowerCase()](url).set(bearer(token)).send({});
          expect([key, res.status, res.body?.code]).toEqual([key, 403, READ_ONLY]);
        }
      }
      expect(routes.map((r) => `${r.method} ${r.path}`).filter((k) => ALLOWED.includes(k)).sort()).toEqual(ALLOWED);
      await new Promise((r) => setTimeout(r, 300));
      expect(await fingerprint()).toEqual(before);
    }, 180_000);

    it('the database itself refuses writes while viewing (backstop behind the guard), and allows them otherwise', async () => {
      const name = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentSenior } })).firstName;
      await runWithRequestContext(async () => {
        markViewing({ sessionId: 's', actorId: ctx.ids.admin, actorRole: 'ADMIN', targetId: ctx.ids.studentSenior });
        await expect(p().user.update({ where: { id: ctx.ids.studentSenior }, data: { firstName: 'Hacked' } })).rejects.toMatchObject({ code: READ_ONLY });
        await expect(p().$executeRaw`UPDATE "User" SET "firstName" = 'Hacked' WHERE "id" = ${ctx.ids.studentSenior}`).rejects.toMatchObject({ code: READ_ONLY });
        await expect(p().$transaction(async (tx) => tx.notification.create({ data: { userId: ctx.ids.studentSenior, category: 'ACCOUNT', type: 'general', title: 'x', body: 'x', data: {} } })))
          .rejects.toMatchObject({ code: READ_ONLY });
        expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentSenior } })).firstName).toBe(name);
      });
      expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentSenior } })).firstName).toBe(name);
      await p().user.update({ where: { id: ctx.ids.studentSenior }, data: { firstName: name } });
    });
  });

  describe('ending', () => {
    it('POST /auth/view-as/end closes the session (audited); the token stops working; ending again is harmless', async () => {
      const { token, body } = await view(admin, ctx.ids.studentJunior, 'Check the dashboard');
      expect((await http().post('/api/v1/auth/view-as/end').set(bearer(token)).expect(200)).body).toMatchObject({ ended: true });
      expect(await code(http().get('/api/v1/me').set(bearer(token)))).toEqual([401, ENDED]);
      const row = await p().viewAsSession.findUniqueOrThrow({ where: { id: body.viewAs.sessionId } });
      expect(row).toMatchObject({ endedReason: 'ENDED_BY_ACTOR' });
      expect(row.endedAt).not.toBeNull();
      const audit = await p().auditLog.findMany({ where: { action: 'VIEW_AS_ENDED', entityId: row.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN' });
      expect(audit[0].metadata).toMatchObject({ targetUserId: ctx.ids.studentJunior, reason: 'ENDED_BY_ACTOR' });
      expect((await http().post('/api/v1/auth/view-as/end').set(bearer(token)).expect(200)).body).toMatchObject({ ended: true });
      expect(await p().auditLog.count({ where: { action: 'VIEW_AS_ENDED', entityId: row.id } })).toBe(1);
      expect((await http().post('/api/v1/auth/view-as/end').expect(200)).body).toMatchObject({ ended: false });
      expect((await http().post('/api/v1/auth/view-as/end').set(bearer(admin)).expect(200)).body).toMatchObject({ ended: false });
    });

    it('a DENY override on the viewer ends their running session at once (VIEW_AS_ENDED); they cannot start another', async () => {
      const admin2 = await login(ctx, 'va.admin2');
      const { token, body } = await view(admin2, ctx.ids.studentJunior);
      await http().get('/api/v1/me').set(bearer(token)).expect(200);
      const deny = await http().post(`/api/v1/admin/users/${admin2Id}/permission-overrides`).set(bearer(superAdmin))
        .send({ permission: 'users.impersonate', effect: 'DENY', reason: 'Not needed' }).expect(201);
      const res = await http().get('/api/v1/me').set(bearer(token)).expect(401);
      expect(res.body.code).toBe(ENDED);
      expect(res.body.message).toMatch(/This viewing session has ended/);
      expect(await p().viewAsSession.findUniqueOrThrow({ where: { id: body.viewAs.sessionId } })).toMatchObject({ endedReason: 'PERMISSION_REMOVED' });
      expect(await p().auditLog.count({ where: { action: 'VIEW_AS_ENDED', entityId: body.viewAs.sessionId } })).toBe(1);
      expect(await code(http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/view-as`).set(bearer(admin2)).send({}))).toEqual([403, 'PERMISSION_REQUIRED']);
      // GET /me/permissions no longer lists it; revoking the DENY restores it.
      expect((await http().get('/api/v1/me/permissions').set(bearer(admin2)).expect(200)).body.permissions).not.toContain('users.impersonate');
      await http().delete(`/api/v1/admin/users/${admin2Id}/permission-overrides/${deny.body.id}`).set(bearer(superAdmin)).send({ reason: 'back' }).expect(200);
      expect((await http().get('/api/v1/me/permissions').set(bearer(admin2)).expect(200)).body.permissions).toContain('users.impersonate');
    });

    it('suspending the viewer ends their running session at once', async () => {
      const admin2 = await login(ctx, 'va.admin2');
      const { token, body } = await view(admin2, ctx.ids.studentJunior);
      await http().post(`/api/v1/admin/users/${admin2Id}/status-changes`).set(bearer(superAdmin)).send({ toStatus: 'SUSPENDED', reason: 'Investigation' }).expect(200);
      expect(await code(http().get('/api/v1/me').set(bearer(token)))).toEqual([401, ENDED]);
      expect(['ACTOR_INACTIVE', 'ACTOR_SIGNED_OUT']).toContain((await p().viewAsSession.findUniqueOrThrow({ where: { id: body.viewAs.sessionId } })).endedReason);
      await http().post(`/api/v1/admin/users/${admin2Id}/status-changes`).set(bearer(superAdmin)).send({ toStatus: 'ACTIVE' }).expect(200);
    });

    it('an expired session or an expired viewing token answers 401 VIEW_AS_ENDED', async () => {
      const { token, body } = await view(admin, ctx.ids.studentJunior);
      await p().viewAsSession.update({ where: { id: body.viewAs.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await code(http().get('/api/v1/me').set(bearer(token)))).toEqual([401, ENDED]);
      const fresh = await view(admin, ctx.ids.studentJunior);
      const jwt = ctx.app.get(JwtService);
      const claims = JSON.parse(Buffer.from(fresh.token.split('.')[1], 'base64url').toString());
      const expired = jwt.sign({ sub: claims.sub, jti: 'expired-1', iatMs: Date.now(), va: claims.va }, { expiresIn: -10 });
      expect(await code(http().get('/api/v1/me').set(bearer(expired)))).toEqual([401, ENDED]);
      expect(await code(http().patch('/api/v1/me').set(bearer(expired)).send({ firstName: 'x' }))).toEqual([401, ENDED]);
      // A forged viewing claim is refused (bad signature) — never accepted.
      const forged = `${fresh.token.split('.')[0]}.${Buffer.from(JSON.stringify({ ...claims, sub: saId })).toString('base64url')}.${fresh.token.split('.')[2]}`;
      expect((await http().get('/api/v1/me').set(bearer(forged))).status).toBe(401);
    });

    it('the viewing tab can never become a normal session: no refresh; signing out of it ends only the viewing session (the viewer\'s cookie is kept and still works)', async () => {
      const loginRes = await http().post('/api/v1/auth/login').send({ username: 'admin', password: PASSWORD }).expect(200);
      const cookie = (loginRes.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rof_refresh='))!.split(';')[0];
      const { token, body } = await view(loginRes.body.access_token, ctx.ids.studentJunior);
      const tokensBefore = await p().refreshToken.count({ where: { userId: ctx.ids.studentJunior } });
      expect(await code(http().post('/api/v1/auth/refresh').set(bearer(token)).set('Cookie', cookie).send({}))).toEqual([403, READ_ONLY]);
      const out = await http().post('/api/v1/auth/logout').set(bearer(token)).set('Cookie', cookie).send({}).expect(200);
      expect(out.body.message).toBe('The viewing session has ended.');
      expect(out.headers['set-cookie']).toBeUndefined();
      expect(await p().viewAsSession.findUniqueOrThrow({ where: { id: body.viewAs.sessionId } })).toMatchObject({ endedReason: 'ENDED_BY_ACTOR' });
      // The administrator's own session is intact: the cookie still refreshes.
      const refreshed = await http().post('/api/v1/auth/refresh').set('Cookie', cookie).send({}).expect(200);
      expect(refreshed.body.access_token).toBeTruthy();
      expect(await p().refreshToken.count({ where: { userId: ctx.ids.studentJunior } })).toBe(tokensBefore);
    });

    it('the viewed user\'s own sessions are untouched: their refresh still works and nothing signed them out', async () => {
      const own = await http().post('/api/v1/auth/login').send({ username: 'student.j2', password: PASSWORD }).expect(200);
      const tva = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior2 } })).tokensValidAfter;
      const { token } = await view(admin, ctx.ids.studentJunior2);
      await http().get('/api/v1/me').set(bearer(token)).expect(200);
      await http().patch('/api/v1/me').set(bearer(token)).send({ firstName: 'x' }).expect(403);
      await http().post('/api/v1/auth/view-as/end').set(bearer(token)).expect(200);
      await http().get('/api/v1/me').set(bearer(own.body.access_token)).expect(200);
      await http().post('/api/v1/auth/refresh').send({ refreshToken: own.body.refresh_token }).expect(200);
      expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior2 } })).tokensValidAfter).toEqual(tva);
    });
  });
});
