/**
 * P1-09 — individual permission overrides (plan §6.3, §6.4, §11.3).
 */
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionOverridesService } from '../src/permission-overrides/permission-overrides.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Permission overrides (P1-09)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, student: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const base = (id: string) => `/api/v1/admin/users/${id}/permission-overrides`;
  const code = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const deny = (permission: string, extra: object = {}) => ({ permission, effect: 'DENY', reason: 'Test restriction', ...extra });
  const ownResults = (token: string) => http().get('/api/v1/me/results').set(bearer(token));

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    await p().user.create({ data: { username: 'ov.super', firstName: 'O', lastName: 'S', email: 'ov.super@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
    superAdmin = await login(ctx, 'ov.super');
    student = await login(ctx, 'student.j');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    vi.useRealTimers();
    await ctx?.app.close();
  });

  it('only a Super Admin changes overrides; administrators may read effective permissions and the catalogue; anonymous refused', async () => {
    expect(await code(http().post(base(ctx.ids.studentJunior)).set(bearer(admin)).send(deny('submissions.viewOwn')))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await code(http().get(base(ctx.ids.studentJunior)).set(bearer(admin)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await code(http().post(base(ctx.ids.studentJunior)).set(bearer(student)).send(deny('submissions.viewOwn')))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await http().get(base(ctx.ids.studentJunior))).status).toBe(401);
    const cat = await http().get('/api/v1/admin/permissions/catalogue').set(bearer(admin)).expect(200);
    expect(cat.body.overridePolicy).toMatchObject({ grantable: { TEACHER: ['assignments.prepare'] }, neverGrantable: expect.arrayContaining(['reviews.grade']) });
    await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}/permissions`).set(bearer(admin)).expect(200);
    await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}/permissions`).set(bearer(student)).expect(403);
    expect(await p().userPermissionOverride.count()).toBe(0);
  });

  it('refuses everything outside the approved list (400 OVERRIDE_NOT_ALLOWED), self-overrides (403) and Super Admin targets', async () => {
    const teacher = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Ov', lastName: 'Teacher', username: 'ov.teacher', email: 'ov.teacher@test.local', password: 'Str0ng!Passw0rd', role: 'TEACHER',
    }).expect(201);
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const sa = await p().user.create({ data: { username: 'ov.super2', firstName: 'O', lastName: 'S2', email: 'ov.super2@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
    const cases: Array<[string, string, object, number, string]> = [
      ['GRANT assignments.prepare to a teacher outside any TeacherAssignment', teacher.body.id,
        { permission: 'assignments.prepare', effect: 'GRANT', reason: 'Draft help', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }, 400, 'OVERRIDE_NOT_ALLOWED'],
      ['GRANT without a scope', teacher.body.id, { permission: 'assignments.prepare', effect: 'GRANT', reason: 'Draft help' }, 400, 'OVERRIDE_NOT_ALLOWED'],
      ['GRANT of a never-grantable permission', ctx.ids.mentorJunior, { permission: 'reviews.grade', effect: 'GRANT', reason: 'x grading' }, 400, 'OVERRIDE_NOT_ALLOWED'],
      ['GRANT to a non-listed role', ctx.ids.mentorJunior, { permission: 'assignments.prepare', effect: 'GRANT', reason: 'more', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }, 400, 'OVERRIDE_NOT_ALLOWED'],
      ['GRANT of a non-listed permission to a teacher', teacher.body.id, { permission: 'users.manage', effect: 'GRANT', reason: 'admin' }, 400, 'OVERRIDE_NOT_ALLOWED'],
      ['DENY of a permission the role does not have', ctx.ids.studentJunior, deny('users.manage'), 400, 'OVERRIDE_NOT_ALLOWED'],
      ['an unknown permission', ctx.ids.studentJunior, deny('no.such'), 400, 'OVERRIDE_NOT_ALLOWED'],
      ['any override on (another) Super Admin', sa.id, deny('users.manage'), 400, 'OVERRIDE_NOT_ALLOWED'],
      ['an expiry in the past', ctx.ids.studentJunior, deny('submissions.viewOwn', { expiresAt: new Date(Date.now() - 60_000).toISOString() }), 400, 'OVERRIDE_NOT_ALLOWED'],
    ];
    for (const [label, target, body, status, c] of cases) {
      expect([label, ...(await code(http().post(base(target)).set(bearer(superAdmin)).send(body)))]).toEqual([label, status, c]);
    }
    expect(await p().userPermissionOverride.count()).toBe(0);
    expect(await p().auditLog.count({ where: { action: 'PERMISSION_OVERRIDE_CREATE' } })).toBe(0);
  });

  it('a self-override by a Super Admin on their own account is 403', async () => {
    // The self rule is checked first (403), before any other rule.
    const sa = await p().user.findUniqueOrThrow({ where: { username: 'ov.super' } });
    expect(await code(http().post(base(sa.id)).set(bearer(superAdmin)).send(deny('courses.view')))).toEqual([403, 'OVERRIDE_NOT_ALLOWED']);
  });

  let denyId: string;

  it('DENY vs a role default: denied on the next request (same token), shown in /me/permissions and the effective view; audited in the same transaction', async () => {
    await ownResults(student).expect(200);   // allowed by default
    const created = await http().post(base(ctx.ids.studentJunior)).set(bearer(superAdmin)).send(deny('submissions.viewOwn')).expect(201);
    denyId = created.body.id;
    expect(created.body).toMatchObject({ permission: 'submissions.viewOwn', effect: 'DENY', active: true, createdBy: { username: 'ov.super' } });
    expect(await code(ownResults(student))).toEqual([403, 'PERMISSION_REQUIRED']);
    const me = await http().get('/api/v1/me/permissions').set(bearer(student)).expect(200);
    expect(me.body.permissions).not.toContain('submissions.viewOwn');
    expect(me.body.overrides).toEqual([{ permission: 'submissions.viewOwn', effect: 'DENY', courseId: null, divisionId: null, expiresAt: null }]);
    const eff = await http().get(`/api/v1/admin/users/${ctx.ids.studentJunior}/permissions`).set(bearer(admin)).expect(200);
    expect(eff.body.permissions.map((x: any) => x.permission)).not.toContain('submissions.viewOwn');
    // Other students are unaffected.
    const other = await login(ctx, 'student.j2');
    await http().get('/api/v1/me/permissions').set(bearer(other)).expect(200).expect((r) => expect(r.body.permissions).toContain('submissions.viewOwn'));
    // Exactly one audit row, with the details.
    const audit = await p().auditLog.findMany({ where: { action: 'PERMISSION_OVERRIDE_CREATE' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: denyId, metadata: { targetUserId: ctx.ids.studentJunior, permission: 'submissions.viewOwn', effect: 'DENY', reason: 'Test restriction' } });
    // A duplicate active override is refused.
    expect(await code(http().post(base(ctx.ids.studentJunior)).set(bearer(superAdmin)).send(deny('submissions.viewOwn')))).toEqual([409, 'OVERRIDE_EXISTS']);
  });

  it('resource rules are unchanged for an overridden user (another student’s submission is still 404)', async () => {
    const otherSub = await p().submission.findFirst({ where: { studentId: { not: ctx.ids.studentJunior } }, select: { id: true } });
    const target = otherSub?.id ?? '00000000-0000-0000-0000-000000000000';
    expect((await http().get(`/api/v1/submissions/${target}`).set(bearer(student))).status).toBe(404);
  });

  it('revoke: access is restored on the next request without re-login; audited once; a second revoke is 409', async () => {
    const r = await http().delete(`${base(ctx.ids.studentJunior)}/${denyId}`).set(bearer(superAdmin)).expect(200);
    expect(r.body).toMatchObject({ active: false, revokedBy: { username: 'ov.super' } });
    await ownResults(student).expect(200);
    expect(await p().auditLog.count({ where: { action: 'PERMISSION_OVERRIDE_REVOKE', entityId: denyId } })).toBe(1);
    expect(await code(http().delete(`${base(ctx.ids.studentJunior)}/${denyId}`).set(bearer(superAdmin)))).toEqual([409, 'OVERRIDE_ALREADY_REVOKED']);
    const list = await http().get(base(ctx.ids.studentJunior)).set(bearer(superAdmin)).expect(200);
    expect(list.body.map((x: any) => [x.id, x.active])).toEqual([[denyId, false]]);   // history kept
  });

  it('DENY on an administrator: refused on that permission until revoked', async () => {
    const created = await http().post(base(ctx.ids.admin)).set(bearer(superAdmin)).send(deny('users.manage')).expect(201);
    expect(await code(http().get('/api/v1/admin/users').set(bearer(admin)))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().get('/api/v1/admin/audit-logs').set(bearer(admin)).expect(200);   // other permissions unaffected
    await http().delete(`${base(ctx.ids.admin)}/${created.body.id}`).set(bearer(superAdmin)).expect(200);
    await http().get('/api/v1/admin/users').set(bearer(admin)).expect(200);
  });

  it('expiry: stops applying at expiresAt with workers off and no job run; the job then records it exactly once', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const created = await http().post(base(ctx.ids.studentJunior)).set(bearer(superAdmin)).send(deny('submissions.viewOwn', { expiresAt: expiresAt.toISOString() })).expect(201);
    expect(await code(ownResults(student))).toEqual([403, 'PERMISSION_REQUIRED']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(expiresAt.getTime() + 1000));   // clock-controlled: past expiresAt; no job has run
      await ownResults(student).expect(200);
      expect(await p().auditLog.count({ where: { action: 'PERMISSION_OVERRIDE_EXPIRED' } })).toBe(0);
      const job = ctx.app.get(PermissionOverridesService);
      expect(await job.recordExpired()).toBe(1);
      expect(await job.recordExpired()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    const rows = await p().auditLog.findMany({ where: { action: 'PERMISSION_OVERRIDE_EXPIRED' } });
    expect(rows.map((r) => r.entityId)).toEqual([created.body.id]);
  });

  it('a failing audit write rolls the create and the revoke back with it', async () => {
    const audit = ctx.app.get(AuditService);
    const spy = vi.spyOn(audit, 'log').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    try {
      expect((await http().post(base(ctx.ids.studentJunior2)).set(bearer(superAdmin)).send(deny('leaderboard.view'))).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect(await p().userPermissionOverride.count({ where: { userId: ctx.ids.studentJunior2 } })).toBe(0);

    const ok = await http().post(base(ctx.ids.studentJunior2)).set(bearer(superAdmin)).send(deny('leaderboard.view')).expect(201);
    const spy2 = vi.spyOn(audit, 'log').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    try {
      expect((await http().delete(`${base(ctx.ids.studentJunior2)}/${ok.body.id}`).set(bearer(superAdmin))).status).toBe(500);
    } finally { spy2.mockRestore(); }
    expect((await p().userPermissionOverride.findUniqueOrThrow({ where: { id: ok.body.id } })).revokedAt).toBeNull();
  });
});
