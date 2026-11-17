/**
 * Sensitive personal data (ACC-16 / SEC-03): a student's phone, close-family (guardian) phone and date of birth.
 * - the account holder sees their own (GET /me);
 * - Administrators see them for ONE account (GET /admin/users/:id); lists show phones masked;
 * - the bulk CSV export never contains them;
 * - Coaches, Head Coaches, Teachers and other students cannot read the administrators' user routes at all.
 * (Teacher and Head Coach student views never include contact data: test/teachers.e2e-spec.ts,
 * test/head-coach-monitoring.e2e-spec.ts.)
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Contact data access (e2e)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, coach: string, other: string, headCoach: string, teacher: string;
  let studentId: string, studentToken: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    other = await login(ctx, 'student.j');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = (username: string, role: 'SUPER_ADMIN' | 'HEAD_COACH' | 'TEACHER') => p().user.create({ data: {
      username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(),
    } });
    await mk('cd.super', 'SUPER_ADMIN');
    await mk('cd.head', 'HEAD_COACH');
    await mk('cd.teacher', 'TEACHER');
    [superAdmin, headCoach, teacher] = await Promise.all(['cd.super', 'cd.head', 'cd.teacher'].map((u) => login(ctx, u)));
    const s = await p().user.create({ data: {
      username: 'cd.student', firstName: 'Ana', lastName: 'Minor', email: 'cd.student@test.local', role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, homeLocation: 'Huye',
      phone: '+250788123456', guardianPhone: '+250722000111', dateOfBirth: new Date('2012-05-01T00:00:00Z'),
    } });
    studentId = s.id;
    studentToken = await login(ctx, 'cd.student');
  });

  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('the account holder sees their own details', async () => {
    const me = await http().get('/api/v1/me').set(bearer(studentToken)).expect(200);
    expect(me.body).toMatchObject({ phone: '+250788123456', guardianPhone: '+250722000111' });
    expect(String(me.body.dateOfBirth)).toMatch(/^2012-05-01/);
  });

  it('Administrators: one account in full; lists masked', async () => {
    for (const token of [admin, superAdmin]) {
      const one = await http().get(`/api/v1/admin/users/${studentId}`).set(bearer(token)).expect(200);
      expect(one.body).toMatchObject({ phone: '+250788123456', guardianPhone: '+250722000111' });
      const list = await http().get('/api/v1/admin/users').query({ search: 'cd.student' }).set(bearer(token)).expect(200);
      const row = list.body.data.find((u: any) => u.id === studentId);
      expect(row).toMatchObject({ phone: '+250••••••456', guardianPhone: '+250••••••111' });
      expect(JSON.stringify(list.body)).not.toContain('788123456');
      expect(JSON.stringify(list.body)).not.toContain('722000111');
    }
  });

  it('the bulk CSV export never contains phones or dates of birth', async () => {
    const res = await http().post('/api/v1/admin/users/bulk/export').set(bearer(admin))
      .send({ selection: { mode: 'ids', ids: [studentId] } }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c: Buffer) => (d += c)); r.on('end', () => cb(null, d)); })
      .expect(200);
    const csv = String(res.body);
    expect(csv.split('\n')[0]).not.toMatch(/phone|birth/i);
    expect(csv).not.toContain('788123456');
    expect(csv).not.toContain('2012-05-01');
  });

  it('every other role is refused the administrators\' user routes', async () => {
    for (const token of [coach, headCoach, teacher, other]) {
      const one = await http().get(`/api/v1/admin/users/${studentId}`).set(bearer(token));
      expect([one.status, JSON.stringify(one.body).includes('722000111')]).toEqual([403, false]);
      const list = await http().get('/api/v1/admin/users').set(bearer(token));
      expect([list.status, JSON.stringify(list.body).includes('722000111')]).toEqual([403, false]);
    }
  });
});
