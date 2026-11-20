/**
 * REG-13 — registration timeline (GET /admin/users/:id/registration-timeline, users.manage): stages and events in
 * order, from the existing records; safe details only; administrators only.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Registration timeline (e2e)', () => {
  let ctx: TestContext;
  let admin: string, coach: string, ngoma: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const tl = (id: string, token = admin) => http().get(`/api/v1/admin/users/${id}/registration-timeline`).set(bearer(token));

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    ngoma = (await p().school.create({ data: {
      name: 'gs ngoma tl', code: '229921', nameKey: 'gs ngoma tl', location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
      province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
    } })).id;
    await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': true, 'registration.requireEmailVerification': false }).expect(200);
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('student: registered → school claim → verified → state change, in order, with stages', async () => {
    const reg = await http().post('/api/v1/auth/register/student').send({
      firstName: 'Tia', lastName: 'Line', username: 'tl.student', email: 'tl.student@test.local', password: 'Secret123',
      dateOfBirth: '2011-01-02', gender: 'FEMALE', gradeLevel: 'S2', homeLocation: 'Huye', schoolCode: '229921', phone: '0788 111 222', guardianPhone: '0722 333 444',
    }).expect(201);
    const claim = await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: reg.body.id, supersededAt: null } });
    await http().post(`/api/v1/admin/school-affiliations/${claim.id}/verify`).set(bearer(admin)).send({}).expect((r) => { if (r.status >= 300) throw new Error(`verify ${r.status} ${JSON.stringify(r.body)}`); });
    await http().post(`/api/v1/admin/users/${reg.body.id}/status-changes`).set(bearer(admin)).send({ toStatus: 'SUSPENDED', reason: 'Checking the account' }).expect((r) => { if (r.status >= 300) throw new Error(`status ${r.status}`); });

    const res = await tl(reg.body.id).expect(200);
    expect(res.body.stages).toMatchObject({ approved: true, accountStatus: 'SUSPENDED', schoolVerification: 'VERIFIED', source: null });
    const actions = res.body.events.map((e: any) => e.action);
    expect(actions[0]).toBe('REGISTER');
    expect(actions).toEqual(expect.arrayContaining(['SCHOOL_AFFILIATION_VERIFIED', 'USER_STATUS_CHANGED']));
    expect(actions.indexOf('SCHOOL_AFFILIATION_VERIFIED')).toBeLessThan(actions.indexOf('USER_STATUS_CHANGED'));
    const times = res.body.events.map((e: any) => Date.parse(e.at));
    // Oldest first (the registration leads the steps written in its own transaction).
    expect(times.slice(1).sort((a: number, b: number) => a - b)).toEqual(times.slice(1));
    expect(times[0] - Math.min(...times)).toBeLessThanOrEqual(2000);
    expect(res.body.events[0]).toMatchObject({ label: 'Registered (self-registration)', actor: 'SELF', actorUsername: null });
    const change = res.body.events.find((e: any) => e.action === 'USER_STATUS_CHANGED');
    expect(change).toMatchObject({ actor: 'ADMIN', actorUsername: 'admin' });
    // Never contact data or dates of birth.
    const text = JSON.stringify(res.body);
    for (const secret of ['tl.student@test.local', '788111222', '722333444', '2011-01-02']) expect(text).not.toContain(secret);
  });

  it('teacher: the application\'s events (question, answer, decision) lead to the account', async () => {
    const app = await http().post('/api/v1/auth/register/teacher').send({
      firstName: 'Ted', lastName: 'Line', username: 'tl.teacher', email: 'tl.teacher@test.local', password: 'Secret123', confirmPassword: 'Secret123', gender: 'MALE',
      country: 'RW', phone: '0788123456', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye',
      schoolId: ngoma, homeDistrict: 'Huye', homeSector: 'Ngoma', position: 'Teacher',
    }).expect(201);
    await http().post(`/api/v1/admin/teacher-applications/${app.body.id}/request-info`).set(bearer(admin)).send({ question: 'Which classes do you teach?' }).expect(200);
    const mail = await p().emailDelivery.findFirstOrThrow({ where: { recipientEmail: 'tl.teacher@test.local', body: { contains: 'applications/respond?token=' } } });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.body ?? "")![1];
    await http().post('/api/v1/applications/info-requests/answer').send({ token, answer: 'S1 to S3' }).expect(200);
    await http().post(`/api/v1/admin/teacher-applications/${app.body.id}/approve`).set(bearer(admin)).send({}).expect(200);
    const user = await p().user.findUniqueOrThrow({ where: { username: 'tl.teacher' } });

    const res = await tl(user.id).expect(200);
    expect(res.body.stages.source).toBe('TEACHER_APPLICATION');
    expect(res.body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining([
      'SUBMIT_TEACHER_APPLICATION', 'APPLICATION_INFO_REQUESTED', 'APPLICATION_INFO_ANSWERED', 'APPROVE_TEACHER_APPLICATION',
    ]));
    const asked = res.body.events.find((e: any) => e.action === 'APPLICATION_INFO_REQUESTED');
    expect(asked.details).toMatchObject({ question: 'Which classes do you teach?' });
    expect(res.body.events.find((e: any) => e.action === 'SUBMIT_TEACHER_APPLICATION').actor).toBe('APPLICANT');
  });

  it('administrators only; unknown account 404', async () => {
    const someone = (await p().user.findFirstOrThrow({ where: { role: 'STUDENT' } })).id;
    await tl(someone, coach).expect(403);
    await http().get(`/api/v1/admin/users/${someone}/registration-timeline`).expect(401);
    await tl('00000000-0000-4000-8000-000000000000').expect(404);
  });
});
