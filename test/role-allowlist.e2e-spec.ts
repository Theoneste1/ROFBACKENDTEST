/**
 * P1-05 — role allow-list on every path, TEACHERS_ENABLED / HEAD_COACHES_ENABLED
 * (off by default) and the M1 role values.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const NEW_ROLES = ['TEACHER', 'HEAD_COACH', 'SUPER_ADMIN'] as const;
const REFUSAL: Record<(typeof NEW_ROLES)[number], string> = {
  TEACHER: 'TEACHERS_DISABLED', HEAD_COACH: 'HEAD_COACHES_DISABLED', SUPER_ADMIN: 'ROLE_NOT_ASSIGNABLE',
};
const person = (username: string, extra: Record<string, unknown> = {}) => ({
  firstName: 'Allow', lastName: 'List', username, email: `${username}@test.local`, ...extra,
});

describe('Role allow-list — flags off (default)', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();
  const upload = (csv: string, dryRun: boolean) =>
    http().post('/api/v1/admin/users/import').query({ dryRun }).set(bearer(admin))
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'users.csv', contentType: 'text/csv' });

  beforeAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('M1: the database accepts the three new role values (inert: no account holds them)', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ v: string }>>`
      SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'Role' ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.v)).toEqual(['STUDENT', 'MENTOR', 'ADMIN', 'TEACHER', 'HEAD_COACH', 'SUPER_ADMIN']);
    expect(await ctx.prisma.user.count({ where: { role: { in: [...NEW_ROLES] } } })).toBe(0);
  });

  it.each(NEW_ROLES)('POST /admin/users refuses %s and creates nothing', async (role) => {
    const before = await ctx.prisma.user.count();
    const res = await http().post('/api/v1/admin/users').set(bearer(admin))
      .send(person(`create.${role.toLowerCase()}`, { password: 'Str0ng!Passw0rd', role })).expect(403);
    expect(res.body.code).toBe(REFUSAL[role]);
    expect(await ctx.prisma.user.count()).toBe(before);
  });

  it.each(NEW_ROLES)('POST /admin/users/invite refuses %s and creates nothing', async (role) => {
    const before = await ctx.prisma.user.count();
    const res = await http().post('/api/v1/admin/users/invite').set(bearer(admin))
      .send(person(`invite.${role.toLowerCase()}`, { role })).expect(403);
    expect(res.body.code).toBe(REFUSAL[role]);
    expect(await ctx.prisma.user.count()).toBe(before);
  });

  it('CSV import reports refused roles as row errors and creates only allowed rows', async () => {
    const csv = [
      'firstName,lastName,email,role',
      'Ok,Coach,csv.coach@test.local,MENTOR',
      'No,Teacher,csv.teacher@test.local,TEACHER',
      'No,Head,csv.head@test.local,HEAD_COACH',
      'No,Super,csv.super@test.local,SUPER_ADMIN',
    ].join('\r\n');
    const before = await ctx.prisma.user.count();
    const dry = await upload(csv, true).expect(200);
    expect(dry.body).toMatchObject({ valid: 1, created: 0, failed: 3 });
    expect(await ctx.prisma.user.count()).toBe(before);

    const res = await upload(csv, false).expect(200);
    expect(res.body).toMatchObject({ created: 1, failed: 3 });
    const errs = Object.fromEntries(res.body.errors.map((e: any) => [e.row, e.errors.join(' ')]));
    expect(errs[3]).toContain('TEACHERS_DISABLED');
    expect(errs[4]).toContain('HEAD_COACHES_DISABLED');
    expect(errs[5]).toContain('ROLE_NOT_ASSIGNABLE');
    expect(await ctx.prisma.user.count({ where: { role: { in: [...NEW_ROLES] } } })).toBe(0);
    expect(await ctx.prisma.user.count()).toBe(before + 1);
  });

  it.each(NEW_ROLES)('PATCH /admin/users/:id refuses a change to %s and changes nothing', async (role) => {
    const target = ctx.ids.mentorSenior;
    const before = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target }, select: { role: true, tokensValidAfter: true } });
    const res = await http().patch(`/api/v1/admin/users/${target}`).set(bearer(admin)).send({ role }).expect(403);
    expect(res.body.code).toBe(REFUSAL[role]);
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: target }, select: { role: true, tokensValidAfter: true } });
    expect(after).toEqual(before);   // role unchanged, sessions not ended
    expect(await ctx.prisma.mentorAssignment.count({ where: { mentorId: target, isActive: true } })).toBeGreaterThan(0);
  });

  it('existing roles keep working on every path', async () => {
    await http().post('/api/v1/admin/users').set(bearer(admin))
      .send(person('ok.admin', { password: 'Str0ng!Passw0rd', role: 'ADMIN' })).expect(201);
    await http().post('/api/v1/admin/users/invite').set(bearer(admin))
      .send(person('ok.coach', { role: 'MENTOR' })).expect(201);
    await http().post('/api/v1/auth/register/admin').set(bearer(admin))
      .send(person('ok.admin2', { password: 'Str0ng!Passw0rd' })).expect(201);
    await http().patch(`/api/v1/admin/users/${ctx.ids.studentSenior}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    await http().patch(`/api/v1/admin/users/${ctx.ids.studentSenior}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S5' }).expect(200);
  });

  it('an ADMIN cannot act on a SUPER_ADMIN account through the user API (edit, role, status, delete, invitation, reset)', async () => {
    const hash = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const sa = await ctx.prisma.user.create({
      data: { ...person('the.super'), role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() },
    });
    const pending = await ctx.prisma.user.create({ data: { ...person('pending.super'), role: 'SUPER_ADMIN' } });
    const snapshot = () => ctx.prisma.user.findUniqueOrThrow({
      where: { id: sa.id }, select: { role: true, firstName: true, isActive: true, tokensValidAfter: true },
    });
    const before = await snapshot();

    const refused = async (req: Promise<any>) => {
      const res = await req;
      expect([res.status, res.body.code]).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
    };
    await refused(http().patch(`/api/v1/admin/users/${sa.id}`).set(bearer(admin)).send({ firstName: 'Hijack' }));
    await refused(http().patch(`/api/v1/admin/users/${sa.id}`).set(bearer(admin)).send({ role: 'ADMIN' }));
    await refused(http().patch(`/api/v1/admin/users/${sa.id}/status`).set(bearer(admin)).send({ isActive: false }));
    await refused(http().delete(`/api/v1/admin/users/${sa.id}`).set(bearer(admin)));
    await refused(http().post(`/api/v1/admin/users/${sa.id}/send-password-reset`).set(bearer(admin)));
    await refused(http().post(`/api/v1/admin/users/${pending.id}/resend-invitation`).set(bearer(admin)));

    expect(await snapshot()).toEqual(before);
    expect(await ctx.prisma.user.count({ where: { id: { in: [sa.id, pending.id] } } })).toBe(2);
    expect(await ctx.prisma.passwordResetToken.count({ where: { userId: sa.id } })).toBe(0);
    // No cleanup by DELETE: the last active Super Admin cannot be removed (M4 trigger, P1-08).
    // The next suite starts from a TRUNCATEd database, which the row-level trigger does not cover.
  });

  it('non-administrators still cannot reach the user API at all', async () => {
    const coach = await login(ctx, 'mentor.j');
    await http().post('/api/v1/admin/users').set(bearer(coach))
      .send(person('nope', { password: 'Str0ng!Passw0rd', role: 'STUDENT' })).expect(403);
  });
});

describe('Role allow-list — flags on (TEACHERS_ENABLED / HEAD_COACHES_ENABLED = true)', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('ADMIN may create TEACHER and HEAD_COACH accounts; SUPER_ADMIN stays refused', async () => {
    for (const role of ['TEACHER', 'HEAD_COACH'] as const) {
      const res = await http().post('/api/v1/admin/users').set(bearer(admin))
        .send(person(`on.${role.toLowerCase()}`, { password: 'Str0ng!Passw0rd', role })).expect(201);
      expect(res.body.role).toBe(role);
    }
    const sa = await http().post('/api/v1/admin/users').set(bearer(admin))
      .send(person('on.super', { password: 'Str0ng!Passw0rd', role: 'SUPER_ADMIN' })).expect(403);
    expect(sa.body.code).toBe('ROLE_NOT_ASSIGNABLE');
  });

  it('a new-role account gets least privilege on existing routes (no route grants it access yet)', async () => {
    for (const username of ['on.teacher', 'on.head_coach']) {
      const token = await login(ctx, username, 'Str0ng!Passw0rd');
      const perms = await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200);
      expect(perms.body.roleLabel).toBe(username === 'on.teacher' ? 'Teacher' : 'Head Coach');
      await http().get('/api/v1/admin/users').set(bearer(token)).expect(403);
      if (username === 'on.teacher') {
        await http().get('/api/v1/me/teaching').set(bearer(token)).expect(403);
        await http().get('/api/v1/courses').set(bearer(token)).expect(403);
      } else {
        // H4 (P1-10): a Head Coach's own teaching scopes and courses — none without an Administrator-created assignment.
        expect((await http().get('/api/v1/me/teaching').set(bearer(token)).expect(200)).body).toEqual([]);
        expect((await http().get('/api/v1/courses').set(bearer(token)).expect(200)).body).toEqual([]);
      }
    }
  });

  it('ADMIN may change a coach to TEACHER (coach assignments end) and back', async () => {
    const id = ctx.ids.mentorSenior;
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'TEACHER' }).expect(200);
    expect(await ctx.prisma.mentorAssignment.count({ where: { mentorId: id, isActive: true } })).toBe(0);
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
  });
});
