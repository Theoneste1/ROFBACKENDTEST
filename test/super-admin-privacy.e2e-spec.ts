/**
 * Super Administrator privacy (owner decision 2026-11-28).
 *
 * A SUPER_ADMIN account is undiscoverable by every other role (ADMIN, HEAD_COACH, MENTOR = Coach, TEACHER, STUDENT),
 * enforced in the backend: not listed, not counted, not found by id (exactly the unknown-id answer), not managed, never a
 * recipient, absent from the audit log and e-mail lists, and shown as the neutral "ROF Administration" when it appears as
 * the author of something. Super Administrators see and manage one another; the last-Super-Administrator safeguard stays.
 */
import { PublicSiteService } from '../src/public-site/public-site.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const UNKNOWN = '00000000-0000-4000-8000-0000000009ab';
const ROF = { firstName: 'ROF', lastName: 'Administration', username: 'rof.administration' };

describe('Super Administrator privacy', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const p = () => ctx.prisma;

  let saOne: string; let saTwo: string; let saPending: string;
  let saOneToken: string; let saTwoToken: string;
  let admin: string; let student: string; let coach: string; let headCoach: string; let teacher: string;
  let viewers: Array<[string, string]>;

  /** The error body with what legitimately differs between two requests (the id in path/message, time, request id) removed. */
  const shape = (status: number, body: Record<string, unknown> | undefined, id: string) => {
    const { timestamp: _t, requestId: _r, ...rest } = (body ?? {}) as Record<string, unknown>;
    return { status, body: JSON.parse(JSON.stringify(rest).split(id).join(':id')) };
  };
  type Call = (id: string) => Promise<{ status: number; body: any }>;
  /** The answer for a Super Administrator's id is exactly the answer for an unknown id. */
  async function sameAsUnknown(call: Call, saId = saOne) {
    const a = await call(saId);
    const b = await call(UNKNOWN);
    expect(shape(a.status, a.body, saId)).toEqual(shape(b.status, b.body, UNKNOWN));
    return a;
  }
  /** Nothing about the Super Administrator's row changed. */
  const snapshot = (id: string) => p().user.findUniqueOrThrow({
    where: { id },
    select: {
      role: true, accountStatus: true, isActive: true, isApproved: true, firstName: true, lastName: true, username: true, email: true,
      avatarFileId: true, avatarUrl: true, dateOfBirth: true, activatedAt: true, updatedAt: true, tokensValidAfter: true,
    },
  });
  const usernamesIn = (body: any): string[] => (body.data ?? body).map((u: any) => u.username);

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = (username: string, role: 'SUPER_ADMIN' | 'HEAD_COACH' | 'TEACHER', extra: Record<string, unknown> = {}) => p().user.create({ data: {
      username, firstName: username === 'sa.one' ? 'Gracious' : username, lastName: username === 'sa.one' ? 'Owner' : 'Priv',
      email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra,
    } });
    saOne = (await mk('sa.one', 'SUPER_ADMIN')).id;
    saTwo = (await mk('sa.two', 'SUPER_ADMIN')).id;
    // Invited, never activated (counted as "awaiting setup").
    saPending = (await mk('sa.pending', 'SUPER_ADMIN', { activatedAt: null })).id;
    await mk('priv.hc', 'HEAD_COACH');
    await mk('priv.teacher', 'TEACHER');

    saOneToken = await login(ctx, 'sa.one');
    saTwoToken = await login(ctx, 'sa.two');
    admin = await login(ctx, 'admin');
    student = await login(ctx, 'student.j');
    coach = await login(ctx, 'mentor.j');
    headCoach = await login(ctx, 'priv.hc');
    teacher = await login(ctx, 'priv.teacher');
    viewers = [['ADMIN', admin], ['STUDENT', student], ['MENTOR', coach], ['HEAD_COACH', headCoach], ['TEACHER', teacher]];

    // Each Super Administrator has a picture.
    for (const t of [saOneToken, saTwoToken]) await http().put('/api/v1/me/avatar').set(bearer(t)).attach('file', PNG, 'me.png').expect(200);
    // Something a Super Administrator did (audited), and an e-mail addressed to one.
    await http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}`).set(bearer(saOneToken)).send({ firstName: 'Renamed' }).expect(200);
    await p().emailDelivery.create({ data: { recipientEmail: 'sa.one@test.local', recipientId: saOne, subject: 'Private to the owner', status: 'FAILED', body: 'x' } });
    await p().emailDelivery.create({ data: { recipientEmail: 'SA.TWO@test.local', subject: 'Private by address', status: 'FAILED', body: 'x' } });
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  // ─── Finding a Super Administrator ────────────────────────────────────────────────────────────────────────────────

  describe('nobody but a Super Administrator finds one', () => {
    it('GET /admin/users: absent without a filter, by username / name / e-mail search and with ?role=SUPER_ADMIN; totals exclude them', async () => {
      const all = await http().get('/api/v1/admin/users').query({ limit: 100 }).set(bearer(admin)).expect(200);
      expect(usernamesIn(all.body)).not.toEqual(expect.arrayContaining(['sa.one']));
      expect(all.body.data.some((u: any) => u.role === 'SUPER_ADMIN')).toBe(false);
      expect(all.body.meta?.total ?? all.body.total).toBe(await p().user.count({ where: { role: { not: 'SUPER_ADMIN' } } }));
      for (const search of ['sa.one', 'Gracious', 'Owner', 'sa.one@test.local', 'sa.']) {
        const r = await http().get('/api/v1/admin/users').query({ search }).set(bearer(admin)).expect(200);
        expect(r.body.data).toEqual([]);
        expect(r.body.meta?.total ?? r.body.total).toBe(0);
      }
      const byRole = await http().get('/api/v1/admin/users').query({ role: 'SUPER_ADMIN' }).set(bearer(admin)).expect(200);
      expect(byRole.body.data).toEqual([]);
      expect(byRole.body.meta?.total ?? byRole.body.total).toBe(0);
    });

    it('the other roles cannot list users at all (the same refusal as before)', async () => {
      for (const [, token] of viewers.slice(1)) {
        const r = await http().get('/api/v1/admin/users').query({ search: 'sa.one' }).set(bearer(token));
        expect(r.status).toBe(403);
      }
    });

    it('GET /admin/email/users (the bulk e-mail picker): no Super Administrator, whatever the search or role filter', async () => {
      for (const q of [{}, { search: 'sa.one' }, { search: 'Gracious' }, { search: 'sa.' }, { role: 'ADMIN' }]) {
        const r = await http().get('/api/v1/admin/email/users').query({ ...q, limit: 100 }).set(bearer(admin)).expect(200);
        expect(r.body.data.some((u: any) => u.role === 'SUPER_ADMIN' || u.username.startsWith('sa.'))).toBe(false);
      }
      const none = await http().get('/api/v1/admin/email/users').query({ search: 'Gracious' }).set(bearer(admin)).expect(200);
      expect(none.body.meta?.total ?? none.body.total).toBe(0);
      const all = await http().get('/api/v1/admin/email/users').set(bearer(admin)).expect(200);
      expect(all.body.meta?.total ?? all.body.total).toBe(await p().user.count({ where: { role: { not: 'SUPER_ADMIN' } } }));
    });

    it('a Super Administrator lists, searches and filters Super Administrators', async () => {
      const r = await http().get('/api/v1/admin/users').query({ role: 'SUPER_ADMIN' }).set(bearer(saTwoToken)).expect(200);
      expect(usernamesIn(r.body).sort()).toEqual(['sa.one', 'sa.pending', 'sa.two']);
      const s = await http().get('/api/v1/admin/users').query({ search: 'Gracious' }).set(bearer(saTwoToken)).expect(200);
      expect(usernamesIn(s.body)).toEqual(['sa.one']);
      const e = await http().get('/api/v1/admin/email/users').query({ search: 'sa.' }).set(bearer(saTwoToken)).expect(200);
      expect(e.body.data.map((u: any) => u.username)).toEqual(expect.arrayContaining(['sa.one', 'sa.two']));
    });
  });

  // ─── Profile, sub-resources and picture by id ──────────────────────────────────────────────────────────────────────

  describe('nobody but a Super Administrator retrieves one by id: the answer is the unknown-id answer', () => {
    const reads = [
      '/api/v1/admin/users/:id',
      '/api/v1/admin/users/:id/registration-timeline',
      '/api/v1/admin/users/:id/status-history',
      '/api/v1/admin/users/:id/date-of-birth-history',
      '/api/v1/admin/users/:id/permissions',
      '/api/v1/admin/users/:id/banking',
      '/api/v1/admin/users/:id/permission-overrides',
      '/api/v1/admin/teachers/:id/delegations',
      '/api/v1/admin/teachers/:id/test-submission',
      '/api/v1/admin/users/:id/school-affiliations',
      '/api/v1/users/:id/avatar',
    ];

    it.each(['ADMIN', 'STUDENT', 'MENTOR', 'HEAD_COACH', 'TEACHER'])('%s: every read by id', async (role) => {
      const token = viewers.find(([r]) => r === role)![1];
      for (const path of reads) {
        const r = await sameAsUnknown((id) => http().get(path.replace(':id', id)).set(bearer(token)));
        expect(r.status).not.toBe(200);
      }
    });

    it('an ADMIN gets 404 for each of them (it may read them for anyone else)', async () => {
      for (const path of reads.filter((x) => !x.includes('permission-overrides'))) {
        const r = await http().get(path.replace(':id', saOne)).set(bearer(admin));
        expect([path, r.status]).toEqual([path, 404]);
      }
      // For a student the same reads answer.
      await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}`).set(bearer(admin)).expect(200);
      await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}/status-history`).set(bearer(admin)).expect(200);
    });

    it('a Super Administrator reads another one (profile, sub-resources) and sees their picture; and their own', async () => {
      const profile = await http().get(`/api/v1/admin/users/${saOne}`).set(bearer(saTwoToken)).expect(200);
      expect(profile.body).toMatchObject({ id: saOne, username: 'sa.one', firstName: 'Gracious', role: 'SUPER_ADMIN' });
      await http().get(`/api/v1/admin/users/${saOne}/registration-timeline`).set(bearer(saTwoToken)).expect(200);
      await http().get(`/api/v1/admin/users/${saOne}/status-history`).set(bearer(saTwoToken)).expect(200);
      await http().get(`/api/v1/admin/users/${saOne}/permissions`).set(bearer(saTwoToken)).expect(200);
      const pic = await http().get(`/api/v1/users/${saOne}/avatar`).set(bearer(saTwoToken)).expect(200);
      expect(pic.headers['content-type']).toMatch(/image\/png/);
      await http().get(`/api/v1/users/${saTwo}/avatar`).set(bearer(saTwoToken)).expect(200);
      const me = await http().get('/api/v1/me').set(bearer(saOneToken)).expect(200);
      expect(me.body).toMatchObject({ id: saOne, username: 'sa.one', firstName: 'Gracious', role: 'SUPER_ADMIN' });
      // Signing in answers with the account's own, real identity.
      const signIn = await http().post('/api/v1/auth/login').send({ username: 'sa.one', password: PASSWORD }).expect(200);
      expect(signIn.body.user).toMatchObject({ id: saOne, username: 'sa.one', firstName: 'Gracious', role: 'SUPER_ADMIN' });
    });
  });

  // ─── Managing a Super Administrator ────────────────────────────────────────────────────────────────────────────────

  describe('an ADMIN cannot manage a Super Administrator: each action answers like an unknown id and changes nothing', () => {
    it('edit, role change, status, activate-now, delete, invitation, password reset, date of birth, picture, banking, view-as', async () => {
      const before = await snapshot(saOne);
      const pendingBefore = await snapshot(saPending);
      const emails = await p().emailDelivery.count();
      const sessions = await p().refreshToken.count({ where: { userId: saOne } }).catch(() => null);
      const school = (await p().school.findFirstOrThrow({ select: { id: true } })).id;
      const actions: Array<[string, Call]> = [
        ['PATCH fields', (id) => http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ firstName: 'Hacked' })],
        ['PATCH role', (id) => http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S2', currentPassword: PASSWORD })],
        ['PATCH status', (id) => http().patch(`/api/v1/admin/users/${id}/status`).set(bearer(admin)).send({ isActive: false })],
        ['status-changes', (id) => http().post(`/api/v1/admin/users/${id}/status-changes`).set(bearer(admin)).send({ toStatus: 'SUSPENDED', reason: 'Privacy test' })],
        ['activate-now', (id) => http().post(`/api/v1/admin/users/${id}/activate-now`).set(bearer(admin))],
        ['DELETE', (id) => http().delete(`/api/v1/admin/users/${id}`).set(bearer(admin))],
        ['resend-invitation', (id) => http().post(`/api/v1/admin/users/${id}/resend-invitation`).set(bearer(admin))],
        ['send-password-reset', (id) => http().post(`/api/v1/admin/users/${id}/send-password-reset`).set(bearer(admin))],
        ['date-of-birth', (id) => http().put(`/api/v1/admin/users/${id}/date-of-birth`).set(bearer(admin)).send({ dateOfBirth: '2010-01-01', reason: 'Privacy test' })],
        ['PUT avatar', (id) => http().put(`/api/v1/admin/users/${id}/avatar`).set(bearer(admin)).attach('file', PNG, 'x.png')],
        ['DELETE avatar', (id) => http().delete(`/api/v1/admin/users/${id}/avatar`).set(bearer(admin))],
        ['PUT banking', (id) => http().put(`/api/v1/admin/users/${id}/banking`).set(bearer(admin)).send({})],
        ['view-as', (id) => http().post(`/api/v1/admin/users/${id}/view-as`).set(bearer(admin)).send({})],
        ['teacher test-submission', (id) => http().put(`/api/v1/admin/teachers/${id}/test-submission`).set(bearer(admin)).send({ allowed: false, reason: 'Privacy test' })],
        // Other records that name an account by id: the Super Administrator is "not found" there too.
        ['mentor assignment', (id) => http().post('/api/v1/admin/mentor-assignments').set(bearer(admin)).send({ mentorId: id, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior })],
        ['mentor assignment bulk', (id) => http().post('/api/v1/admin/mentor-assignments/bulk').set(bearer(admin)).send({ mentorId: id, scope: 'ALL', dryRun: true })],
        ['teacher school', (id) => http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: id, schoolId: school })],
        ['teacher students', (id) => http().post('/api/v1/admin/teacher-students').set(bearer(admin)).send({ teacherId: id, studentIds: [ctx.ids.studentJunior] })],
        ['bulk teacher', (id) => http().post('/api/v1/admin/users/bulk/preview').set(bearer(admin)).send({ action: 'assignTeacher', selection: { mode: 'ids', ids: [ctx.ids.studentJunior] }, params: { teacherId: id } })],
      ];
      for (const [name, call] of actions) {
        for (const target of [saOne, saPending]) {
          const r = await sameAsUnknown(call, target);
          expect([name, r.status]).not.toEqual([name, 200]);
          expect([name, r.status === 403 && r.body?.code === 'ROLE_NOT_ASSIGNABLE']).toEqual([name, false]);
        }
      }
      expect(await snapshot(saOne)).toEqual(before);
      expect(await snapshot(saPending)).toEqual(pendingBefore);
      expect(await p().emailDelivery.count()).toBe(emails);
      if (sessions !== null) expect(await p().refreshToken.count({ where: { userId: saOne } })).toBe(sessions);
      expect(await p().viewAsSession.count({ where: { targetId: saOne } })).toBe(0);
      expect(await p().userStatusChange.count({ where: { userId: { in: [saOne, saPending] } } })).toBe(0);
    });

    it('bulk: a Super Administrator id behaves like an unknown id (preview, execute, message, export); a role filter finds none', async () => {
      const before = await snapshot(saOne);
      const preview = (body: Record<string, unknown>, token = admin) => http().post('/api/v1/admin/users/bulk/preview').set(bearer(token)).send(body);
      for (const [action, params] of [
        ['suspend', undefined],
        ['assignRole', { role: 'MENTOR' }],
        ['message', { subject: 'Hello', body: 'Hi there' }],
        ['activateNow', undefined],
      ] as const) {
        const withSa = await preview({ action, selection: { mode: 'ids', ids: [saOne, ctx.ids.studentJunior2] }, ...(params && { params }) });
        const withUnknown = await preview({ action, selection: { mode: 'ids', ids: [UNKNOWN, ctx.ids.studentJunior2] }, ...(params && { params }) });
        expect(withSa.status).toBe(200);
        const strip = (b: any) => ({ ...b, selection: undefined, selectionToken: undefined, confirmationExpiresAt: undefined });
        expect(strip(withSa.body)).toEqual(strip(withUnknown.body));
        expect(withSa.body.total).toBe(1);
        expect(JSON.stringify(withSa.body)).not.toContain('sa.one');
        expect(withSa.body.warnings.map((w: any) => w.code)).not.toContain('INCLUDES_ADMINISTRATORS');
      }
      // Only Super Administrators selected → nothing matches, exactly as for unknown ids.
      const onlySa = await preview({ action: 'suspend', selection: { mode: 'ids', ids: [saOne, saTwo] } });
      const onlyUnknown = await preview({ action: 'suspend', selection: { mode: 'ids', ids: [UNKNOWN] } });
      expect([onlySa.status, onlySa.body.total]).toEqual([onlyUnknown.status, onlyUnknown.body.total]);
      expect(onlySa.body.total).toBe(0);
      const byFilter = await preview({ action: 'suspend', selection: { mode: 'filter', filter: { role: 'SUPER_ADMIN' } } });
      expect(byFilter.body.total).toBe(0);
      // Executing a message to a Super Administrator plus a student e-mails the student only.
      const pv = await preview({ action: 'message', selection: { mode: 'ids', ids: [saOne, ctx.ids.studentJunior2] }, params: { subject: 'Bulk hello', body: 'Hi there, a bulk note.' } }).expect(200);
      await http().post('/api/v1/admin/users/bulk').set(bearer(admin)).send({
        action: 'message', selection: { mode: 'ids', ids: [saOne, ctx.ids.studentJunior2] }, params: { subject: 'Bulk hello', body: 'Hi there, a bulk note.' },
        selectionToken: pv.body.selectionToken, expectedTotal: pv.body.total, confirm: true, idempotencyKey: `priv-${Date.now()}`,
      }).expect(202);
      expect(await p().bulkOperationItem.count({ where: { userId: saOne } })).toBe(0);
      expect(await p().emailDelivery.count({ where: { recipientId: saOne, jobId: { not: null } } })).toBe(0);
      // Export: the CSV never holds a Super Administrator.
      const csv = await http().post('/api/v1/admin/users/bulk/export').set(bearer(admin))
        .send({ selection: { mode: 'ids', ids: [saOne, saTwo, ctx.ids.studentJunior2] } }).expect(200);
      expect(csv.text).not.toMatch(/sa\.one|sa\.two|Gracious/);
      expect(csv.text.trim().split(/\r?\n/)).toHaveLength(2);
      const csvFilter = await http().post('/api/v1/admin/users/bulk/export').set(bearer(admin)).send({ selection: { mode: 'filter', filter: {} } }).expect(200);
      expect(csvFilter.text).not.toMatch(/sa\.one|sa\.two|sa\.pending|SUPER_ADMIN/);
      expect(await snapshot(saOne)).toEqual(before);
    });

    it('permission overrides (Super Admin only) and a Super Administrator\'s own bulk operations stay out of reach', async () => {
      // An ADMIN lacks permissions.manageOverrides: the same refusal for a Super Administrator and an unknown id.
      await sameAsUnknown((id) => http().post(`/api/v1/admin/users/${id}/permission-overrides`).set(bearer(admin)).send({ permission: 'users.impersonate', effect: 'GRANT', reason: 'x' }));
      // A bulk operation run by a Super Administrator is not shown to an ADMIN (audit.view), as with the audit log.
      const pv = await http().post('/api/v1/admin/users/bulk/preview').set(bearer(saOneToken))
        .send({ action: 'suspend', selection: { mode: 'ids', ids: [ctx.ids.mentorJunior2] } }).expect(200);
      const op = await http().post('/api/v1/admin/users/bulk').set(bearer(saOneToken)).send({
        action: 'suspend', selection: { mode: 'ids', ids: [ctx.ids.mentorJunior2] }, reason: 'SA bulk',
        selectionToken: pv.body.selectionToken, expectedTotal: 1, confirm: true, idempotencyKey: `sa-op-${Date.now()}`,
      }).expect(202);
      const opId = op.body.operation.id;
      const list = await http().get('/api/v1/admin/users/bulk').query({ limit: 100 }).set(bearer(admin)).expect(200);
      expect(list.body.data.map((o: any) => o.id)).not.toContain(opId);
      await sameAsUnknown((id) => http().get(`/api/v1/admin/users/bulk/${id}`).set(bearer(admin)), opId);
      const forSa = await http().get('/api/v1/admin/users/bulk').query({ limit: 100 }).set(bearer(saTwoToken)).expect(200);
      expect(forSa.body.data.map((o: any) => o.id)).toContain(opId);
    });
  });

  // ─── Embedded actors ───────────────────────────────────────────────────────────────────────────────────────────────

  describe('a Super Administrator embedded in a record is "ROF Administration" for everyone else', () => {
    it('a discussion started by a Super Administrator: masked for a student and an ADMIN, real for a Super Administrator', async () => {
      const t = await http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(saOneToken))
        .send({ title: 'Welcome from the owner', content: 'Hello everyone', divisionId: ctx.ids.junior }).expect(201);
      for (const token of [student, admin, coach]) {
        const list = await http().get(`/api/v1/courses/${ctx.ids.algebra}/threads`).query({ divisionId: ctx.ids.junior }).set(bearer(token)).expect(200);
        const row = list.body.data.find((x: any) => x.id === t.body.id);
        expect(row).toBeTruthy();
        const one = await http().get(`/api/v1/threads/${t.body.id}`).set(bearer(token)).expect(200);
        for (const body of [row, one.body]) {
          const text = JSON.stringify(body);
          expect(text).not.toMatch(/sa\.one|Gracious|Owner|sa\.one@test\.local/);
          expect(text).toContain('rof.administration');
          const author = body.author ?? body.createdBy;
          expect(author).toMatchObject({ id: saOne, ...ROF });
          if ('avatarUrl' in author) expect(author.avatarUrl).toBeNull();
          if ('role' in author) expect(author.role).toBe('ADMIN');
        }
        // The kept id leads nowhere.
        await sameAsUnknown((id) => http().get(`/api/v1/users/${id}/avatar`).set(bearer(token)));
      }
      const forSa = await http().get(`/api/v1/threads/${t.body.id}`).set(bearer(saTwoToken)).expect(200);
      expect(JSON.stringify(forSa.body)).toContain('sa.one');
      expect(JSON.stringify(forSa.body)).not.toContain('rof.administration');
    });

    it('the date-of-birth history of a student corrected by a Super Administrator names "ROF Administration" for an ADMIN', async () => {
      await http().put(`/api/v1/admin/users/${ctx.ids.studentJunior}/date-of-birth`).set(bearer(saOneToken)).send({ dateOfBirth: '2010-06-01', reason: 'Owner correction' }).expect(200);
      const forAdmin = await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}/date-of-birth-history`).set(bearer(admin)).expect(200);
      expect(forAdmin.body[0].by).toMatchObject({ id: saOne, ...ROF });
      expect(JSON.stringify(forAdmin.body)).not.toMatch(/sa\.one|Gracious/);
      const forSa = await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}/date-of-birth-history`).set(bearer(saTwoToken)).expect(200);
      expect(forSa.body[0].by).toMatchObject({ id: saOne, username: 'sa.one' });
    });
  });

  // ─── Audit log ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('audit log', () => {
    it('an ADMIN sees no entry by or about a Super Administrator — in lists, filters, counts, single entries and the CSV', async () => {
      const saRows = await p().auditLog.findMany({ where: { OR: [{ actorId: { in: [saOne, saTwo] } }, { entity: 'User', entityId: { in: [saOne, saTwo, saPending] } }] }, select: { id: true, action: true } });
      expect(saRows.length).toBeGreaterThan(0);
      const all = await http().get('/api/v1/admin/audit-logs').query({ limit: 100 }).set(bearer(admin)).expect(200);
      const ids = new Set(all.body.data.map((r: any) => r.id));
      for (const r of saRows) expect(ids.has(r.id)).toBe(false);
      expect(JSON.stringify(all.body)).not.toMatch(/sa\.one|sa\.two|Gracious/);
      const visibleTotal = all.body.meta?.total ?? all.body.total;
      expect(visibleTotal).toBe(await p().auditLog.count() - await p().auditLog.count({ where: { OR: [
        { actorRole: 'SUPER_ADMIN' }, { actorId: { in: [saOne, saTwo, saPending] } }, { entity: 'User', entityId: { in: [saOne, saTwo, saPending] } },
      ] } }));
      for (const q of [{ actorRole: 'SUPER_ADMIN' }, { category: 'SUPER_ADMIN' }, { actorId: saOne }, { entity: 'User', entityId: saOne }]) {
        const r = await http().get('/api/v1/admin/audit-logs').query(q).set(bearer(admin)).expect(200);
        expect([q, r.body.meta?.total ?? r.body.total]).toEqual([q, 0]);
      }
      await sameAsUnknown((id) => http().get(`/api/v1/admin/audit-logs/${id}`).set(bearer(admin)), saRows[0].id);
      // Counts per action exclude them.
      const actions = await http().get('/api/v1/admin/audit-logs/actions').set(bearer(admin)).expect(200);
      const visibleByAction = new Map<string, number>(actions.body.map((a: any) => [a.action, a.count]));
      const avatarSet = await p().auditLog.count({ where: { action: 'AVATAR_SET' } });
      expect(avatarSet).toBeGreaterThanOrEqual(2);
      expect(visibleByAction.get('AVATAR_SET') ?? 0).toBe(avatarSet - 2);
      const csv = await http().get('/api/v1/admin/audit-logs/export.csv').set(bearer(admin)).expect(200);
      expect(csv.text).not.toMatch(/sa\.one|sa\.two|SUPER_ADMIN/);
    });

    it('a Super Administrator sees every entry', async () => {
      const r = await http().get('/api/v1/admin/audit-logs').query({ actorRole: 'SUPER_ADMIN' }).set(bearer(saTwoToken)).expect(200);
      expect(r.body.data.length).toBeGreaterThan(0);
      const total = await http().get('/api/v1/admin/audit-logs').set(bearer(saTwoToken)).expect(200);
      expect(total.body.meta?.total ?? total.body.total).toBe(await p().auditLog.count());
    });
  });

  // ─── E-mail ────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('e-mail', () => {
    it('an ADMIN sees no delivery addressed to a Super Administrator (by account or address) and cannot retry one', async () => {
      const r = await http().get('/api/v1/admin/email/deliveries').query({ limit: 100 }).set(bearer(admin)).expect(200);
      expect(JSON.stringify(r.body)).not.toMatch(/sa\.one@|sa\.two@|Private/i);
      const hidden = await p().emailDelivery.findMany({ where: { subject: { startsWith: 'Private' } }, select: { id: true } });
      for (const d of hidden) await sameAsUnknown((id) => http().post(`/api/v1/admin/email/deliveries/${id}/retry`).set(bearer(admin)), d.id);
      const forSa = await http().get('/api/v1/admin/email/deliveries').query({ limit: 100 }).set(bearer(saTwoToken)).expect(200);
      expect(JSON.stringify(forSa.body)).toMatch(/Private to the owner/);
    });

    it('a Super Administrator is never a recipient of an ADMIN\'s e-mail: an explicit id is "not found", the role matches nobody', async () => {
      const send = (body: Record<string, unknown>) => http().post('/api/v1/admin/email/send').set(bearer(admin))
        .send({ subject: 'Hi', body: 'Hello', idempotencyKey: `k-${Math.random()}`, ...body });
      const a = await send({ recipientMode: 'EXPLICIT', recipientUserIds: [saOne] });
      const b = await send({ recipientMode: 'EXPLICIT', recipientUserIds: [UNKNOWN] });
      expect(shape(a.status, a.body, saOne)).toEqual(shape(b.status, b.body, UNKNOWN));
      expect(a.body.code).toBe('RECIPIENTS_NOT_FOUND');
      // The ADMIN role never reaches a Super Administrator (SUPER_ADMIN itself is not a valid choice for anyone).
      const role = await send({ recipientMode: 'ROLE', recipientRole: 'ADMIN' }).expect(201);
      expect(await p().emailDelivery.count({ where: { jobId: role.body.id, recipientId: { in: [saOne, saTwo, saPending] } } })).toBe(0);
      const all = await send({ recipientMode: 'ALL' }).expect(201);
      expect(await p().emailDelivery.count({ where: { jobId: all.body.id, recipientId: { in: [saOne, saTwo, saPending] } } })).toBe(0);
      // A Super Administrator may write to another one.
      await http().post('/api/v1/admin/email/send').set(bearer(saTwoToken))
        .send({ subject: 'Hi', body: 'Hello', idempotencyKey: `k-${Math.random()}`, recipientMode: 'EXPLICIT', recipientUserIds: [saOne] }).expect(201);
    });

    it('a bulk job addressed to a Super Administrator is hidden from an ADMIN', async () => {
      const job = await http().post('/api/v1/admin/email/send').set(bearer(saTwoToken))
        .send({ subject: 'Owners only', body: 'Hello', idempotencyKey: `k-${Math.random()}`, recipientMode: 'EXPLICIT', recipientUserIds: [saOne] }).expect(201);
      const list = await http().get('/api/v1/admin/email/jobs').query({ limit: 100 }).set(bearer(admin)).expect(200);
      expect(list.body.data.map((j: any) => j.id)).not.toContain(job.body.id);
      await sameAsUnknown((id) => http().get(`/api/v1/admin/email/jobs/${id}`).set(bearer(admin)), job.body.id);
      await sameAsUnknown((id) => http().get(`/api/v1/admin/email/jobs/${id}/deliveries`).set(bearer(admin)), job.body.id);
      const forSa = await http().get('/api/v1/admin/email/jobs').query({ limit: 100 }).set(bearer(saOneToken)).expect(200);
      expect(forSa.body.data.map((j: any) => j.id)).toContain(job.body.id);
    });
  });

  // ─── Counts ────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('counts never include Super Administrators for anyone else', () => {
    it('public statistics: members never count a Super Administrator', async () => {
      ctx.app.get(PublicSiteService).clearStatisticsCache();
      const r = await http().get('/api/v1/public/statistics').expect(200);
      expect(r.body.members).toBe(await p().user.count({ where: { isActive: true, isApproved: true, activatedAt: { not: null }, role: { not: 'SUPER_ADMIN' } } }));
    });

    it('reports overview and dashboard: no SUPER_ADMIN figure for an ADMIN; present for a Super Administrator', async () => {
      const o = await http().get('/api/v1/admin/reports/overview').set(bearer(admin)).expect(200);
      expect(o.body.activeUsers.SUPER_ADMIN).toBeUndefined();
      const oSa = await http().get('/api/v1/admin/reports/overview').set(bearer(saTwoToken)).expect(200);
      expect(oSa.body.activeUsers.SUPER_ADMIN).toBe(3);
      const d = await http().get('/api/v1/admin/dashboard').set(bearer(admin)).expect(200);
      expect(d.body.accountsAwaitingSetup.byRole.SUPER_ADMIN).toBeUndefined();
      const dSa = await http().get('/api/v1/admin/dashboard').set(bearer(saTwoToken)).expect(200);
      expect(dSa.body.accountsAwaitingSetup.byRole.SUPER_ADMIN).toBe(1);
    });

    it('activity: a Super Administrator\'s activity is neither listed nor counted for an ADMIN', async () => {
      await p().activityLog.createMany({ data: [{ userId: saOne, type: 'LOGIN' }, { userId: ctx.ids.studentJunior, type: 'LOGIN' }] });
      const list = await http().get('/api/v1/admin/activity').query({ limit: 100 }).set(bearer(admin)).expect(200);
      expect(list.body.data.some((a: any) => a.userId === saOne)).toBe(false);
      const one = await http().get('/api/v1/admin/activity').query({ userId: saOne }).set(bearer(admin)).expect(200);
      expect(one.body.meta?.total ?? one.body.total).toBe(0);
      const from = new Date(Date.now() - 3600_000).toISOString();
      const to = new Date(Date.now() + 3600_000).toISOString();
      const sum = await http().get('/api/v1/admin/activity/summary').query({ from, to }).set(bearer(admin)).expect(200);
      const sumSa = await http().get('/api/v1/admin/activity/summary').query({ from, to }).set(bearer(saTwoToken)).expect(200);
      const superAdminsActive = await p().user.count({ where: { role: 'SUPER_ADMIN', activityLogs: { some: { createdAt: { gte: new Date(from), lte: new Date(to) } } } } });
      expect(superAdminsActive).toBeGreaterThan(0);
      expect(sumSa.body.activeUsers - sum.body.activeUsers).toBe(superAdminsActive);
    });
  });

  // ─── Custom reports ────────────────────────────────────────────────────────────────────────────────────────────────

  describe('custom reports', () => {
    const R = '/api/v1/reports';
    it('an ADMIN\'s people and activity reports never hold a Super Administrator; SUPER_ADMIN is not offered as a role value', async () => {
      const cat = await http().get(`${R}/sources`).set(bearer(admin)).expect(200);
      expect(JSON.stringify(cat.body)).not.toContain('SUPER_ADMIN');
      const run = async (token: string, body: object) => (await http().post(`${R}/preview`).set(bearer(token)).send(body).expect(201)).body;
      const users = await run(admin, { source: 'USERS', columns: ['fullName', 'username', 'role'] });
      expect(users.meta.total).toBe(await p().user.count({ where: { role: { not: 'SUPER_ADMIN' } } }));
      expect(JSON.stringify(users.rows)).not.toMatch(/sa\.one|sa\.two|Gracious|SUPER_ADMIN/);
      const filtered = await run(admin, { source: 'USERS', columns: ['username'], filters: [{ field: 'role', op: 'eq', value: 'SUPER_ADMIN' }] });
      expect(filtered.meta.total).toBe(0);
      const activity = await run(admin, { source: 'ACTIVITY', columns: ['role'] });
      expect(JSON.stringify(activity.rows)).not.toContain('SUPER_ADMIN');
      const forSa = await run(saTwoToken, { source: 'USERS', columns: ['username'], filters: [{ field: 'role', op: 'eq', value: 'SUPER_ADMIN' }] });
      expect(forSa.meta.total).toBe(3);
    });

    it('a Super Administrator is never a grantee for an ADMIN (unknown user), and an ADMIN does not see or remove a Super Administrator\'s grant', async () => {
      const report = (await http().post(R).set(bearer(admin)).send({ name: 'Privacy report', source: 'USERS', columns: ['fullName'] }).expect(201)).body;
      const grant = (userId: string, token = admin) => http().put(`${R}/${report.id}/grants`).set(bearer(token)).send({ grants: [{ userId, canView: true, canDownload: false, canEdit: false }] });
      const a = await grant(saOne);
      const b = await grant(UNKNOWN);
      expect(shape(a.status, a.body, saOne)).toEqual(shape(b.status, b.body, UNKNOWN));
      expect(a.body.code).toBe('UNKNOWN_GRANTEE');
      // A Super Administrator shares it with another one; the ADMIN's view and edit of the grants leave that grant alone.
      await grant(saOne, saTwoToken).expect(200);
      const seen = await http().get(`${R}/${report.id}/grants`).set(bearer(admin)).expect(200);
      expect(seen.body.grants).toEqual([]);
      await grant(ctx.ids.mentorJunior).expect(200);
      expect(await p().customReportGrant.count({ where: { reportId: report.id, userId: saOne } })).toBe(1);
      const seenBySa = await http().get(`${R}/${report.id}/grants`).set(bearer(saTwoToken)).expect(200);
      expect(seenBySa.body.grants.map((g: any) => g.user?.username).sort()).toEqual(['mentor.j', 'sa.one']);
    });
  });

  // ─── Super Administrators among themselves ─────────────────────────────────────────────────────────────────────────

  describe('Super Administrators manage everyone, including one another; the last one stays', () => {
    it('suspend and reactivate an ADMIN; change a student', async () => {
      const a = await p().user.create({ data: { username: 'priv.admin2', firstName: 'A', lastName: 'Two', email: 'priv.admin2@test.local', role: 'ADMIN', activatedAt: new Date() } });
      await http().post(`/api/v1/admin/users/${a.id}/status-changes`).set(bearer(saOneToken)).send({ toStatus: 'SUSPENDED', reason: 'Owner check' }).expect(200);
      await http().post(`/api/v1/admin/users/${a.id}/status-changes`).set(bearer(saOneToken)).send({ toStatus: 'ACTIVE' }).expect(200);
      expect((await p().user.findUniqueOrThrow({ where: { id: a.id } })).accountStatus).toBe('ACTIVE');
      await http().patch(`/api/v1/admin/users/${ctx.ids.studentSenior}`).set(bearer(saOneToken)).send({ lastName: 'Changed' }).expect(200);
    });

    it('demote another Super Administrator while one remains; the last active one can never be removed', async () => {
      await http().patch(`/api/v1/admin/users/${saPending}`).set(bearer(saOneToken)).send({ role: 'ADMIN', currentPassword: PASSWORD }).expect(200);
      await http().patch(`/api/v1/admin/users/${saTwo}`).set(bearer(saOneToken)).send({ role: 'ADMIN', currentPassword: PASSWORD }).expect(200);
      expect((await p().user.findUniqueOrThrow({ where: { id: saTwo } })).role).toBe('ADMIN');
      // The demoted account is now an Administrator: it no longer finds the remaining Super Administrator.
      const demoted = await login(ctx, 'sa.two');
      await sameAsUnknown((id) => http().get(`/api/v1/admin/users/${id}`).set(bearer(demoted)));
      // sa.one is the last active Super Administrator: the database refuses to remove it.
      await expect(p().user.update({ where: { id: saOne }, data: { role: 'ADMIN' } })).rejects.toThrow(/LAST_SUPER_ADMIN/);
      await expect(p().user.update({ where: { id: saOne }, data: { isActive: false, accountStatus: 'SUSPENDED' } })).rejects.toThrow(/LAST_SUPER_ADMIN/);
      // And nobody else can reach it through the API.
      const r = await http().post(`/api/v1/admin/users/${saOne}/status-changes`).set(bearer(demoted)).send({ toStatus: 'SUSPENDED', reason: 'Take over' });
      expect(r.status).toBe(404);
      expect((await p().user.findUniqueOrThrow({ where: { id: saOne } })).role).toBe('SUPER_ADMIN');
    });
  });
});
