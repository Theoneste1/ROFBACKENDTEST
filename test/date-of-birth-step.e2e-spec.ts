/**
 * First-sign-in date of birth (owner decision 9.3, 2026-11-18).
 *
 * Self-registration requires a date of birth. A student created by an Administrator, invited or imported may have
 * none: at sign-in they are asked for it, and until they give it every route except GET /me, GET /me/permissions,
 * PUT /me/date-of-birth and sign-out answers 403 DATE_OF_BIRTH_REQUIRED. Students who have one, and other roles,
 * are never asked.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';
import { todayInRwanda } from '../src/auth/dto/registration-details.rules.js';

describe('First-sign-in date of birth (decision 9.3)', () => {
  let ctx: TestContext;
  let admin: string, schoolId: string;
  const http = () => ctx.http();
  const PASSWORD = 'Str0ng!Passw0rd';
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const lastLinkToken = async (email: string) => {
    const mail = await ctx.prisma.emailDelivery.findFirstOrThrow({
      where: { recipientEmail: email, body: { contains: '/activate?token=' } }, orderBy: { createdAt: 'desc' },
    });
    return decodeURIComponent(/\/activate\?token=([^\s]+)/.exec(mail.body!)![1]);
  };
  const bornYearsAgo = (years: number) => {
    const [y, m, d] = todayInRwanda().split('-').map(Number);
    const dt = new Date(Date.UTC(y - years, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 3);
    return dt.toISOString().slice(0, 10);
  };

  /** The student is held at the step: profile readable, everything else refused with the code. */
  const expectHeld = async (token: string) => {
    const me = await http().get('/api/v1/me').set(bearer(token)).expect(200);
    expect(me.body).toMatchObject({ role: 'STUDENT', dateOfBirth: null, dateOfBirthRequired: true });
    await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200);
    // One request at a time (each supertest request starts and stops the server).
    for (const req of [
      () => http().get('/api/v1/me/enrollments').set(bearer(token)),
      () => http().get('/api/v1/courses').set(bearer(token)),
      () => http().get('/api/v1/assignments').set(bearer(token)),
      () => http().patch('/api/v1/me').set(bearer(token)).send({ firstName: 'Renamed' }),
    ]) {
      expect(await status(req())).toEqual([403, 'DATE_OF_BIRTH_REQUIRED']);
    }
  };
  /** Gives the date of birth and checks the student is released. */
  const completeStep = async (token: string, id: string) => {
    const dob = bornYearsAgo(14);
    const res = await http().put('/api/v1/me/date-of-birth').set(bearer(token)).send({ dateOfBirth: dob }).expect(200);
    expect(res.body).toMatchObject({ id, dateOfBirthRequired: false });
    expect(String(res.body.dateOfBirth).slice(0, 10)).toBe(dob);
    await http().get('/api/v1/me/enrollments').set(bearer(token)).expect(200);
    await http().get('/api/v1/courses').set(bearer(token)).expect(200);
    expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body.dateOfBirthRequired).toBe(false);
    // Given once: not changed here afterwards.
    expect(await status(http().put('/api/v1/me/date-of-birth').set(bearer(token)).send({ dateOfBirth: bornYearsAgo(12) })))
      .toEqual([409, 'DATE_OF_BIRTH_ALREADY_SET']);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'DATE_OF_BIRTH_ADDED', entityId: id } });
    expect(audit).toMatchObject({ actorId: id, actorRole: 'STUDENT', metadata: { source: 'FIRST_SIGN_IN', dateOfBirthGiven: true } });
    expect(JSON.stringify(audit.metadata)).not.toContain(dob);
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    schoolId = (await ctx.prisma.school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('a student created by an Administrator without a date of birth: asked at sign-in, held until they give it, then released', async () => {
    const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Dob', lastName: 'Admin', username: 'dob.admin', email: 'dob.admin@test.local', password: PASSWORD,
      role: 'STUDENT', gradeLevel: 'S2', schoolId,
    }).expect(201);
    expect(created.body.dateOfBirth ?? null).toBeNull();
    const signIn = await http().post('/api/v1/auth/login').send({ username: 'dob.admin', password: PASSWORD }).expect(200);
    expect(signIn.body.user).toMatchObject({ dateOfBirthRequired: true });
    const token = signIn.body.access_token as string;
    await expectHeld(token);

    // Invalid dates: the registration rules (real past date, age 5–30), nothing stored.
    for (const dateOfBirth of [undefined, '', '2012-02-30', '01/05/2012', bornYearsAgo(3), bornYearsAgo(31), '2099-01-01']) {
      expect([dateOfBirth, await status(http().put('/api/v1/me/date-of-birth').set(bearer(token)).send({ dateOfBirth }))])
        .toEqual([dateOfBirth, [400, 'VALIDATION_FAILED']]);
    }
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: created.body.id } })).dateOfBirth).toBeNull();
    await completeStep(token, created.body.id);
  });

  it('an invited student: asked after activating the invitation', async () => {
    const res = await http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
      firstName: 'Dob', lastName: 'Invited', email: 'dob.invited@example.com', gradeLevel: 'S3', schoolId,
    }).expect(201);
    await http().post('/api/v1/auth/activate').send({ token: await lastLinkToken('dob.invited@example.com'), password: PASSWORD }).expect(200);
    const token = await login(ctx, res.body.user.username, PASSWORD);
    await expectHeld(token);
    await completeStep(token, res.body.user.id);
  });

  it('an imported student: asked after activating the invitation', async () => {
    // Import places students by school code (schoolReferenceRequired): give the test school one.
    await ctx.prisma.school.update({ where: { id: schoolId }, data: { code: '119901' } });
    const body = ['firstName,lastName,email,role,gradeLevel,schoolCode,schoolName,schoolLocation,homeLocation,username',
      'Dob,Imported,dob.imported@example.com,STUDENT,S4,119901,,,Kigali,dob.imported'].join('\r\n');
    const res = await http().post('/api/v1/admin/users/import').set(bearer(admin))
      .attach('file', Buffer.from(body, 'utf8'), { filename: 'students.csv', contentType: 'text/csv' }).expect(200);
    expect(res.body).toMatchObject({ created: 1, failed: 0 });
    await http().post('/api/v1/auth/activate').send({ token: await lastLinkToken('dob.imported@example.com'), password: PASSWORD }).expect(200);
    const id = (await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'dob.imported' } })).id;
    const token = await login(ctx, 'dob.imported', PASSWORD);
    await expectHeld(token);
    await completeStep(token, id);
  });

  it('students who already have a date of birth (self-registered or seeded) and other roles are never asked', async () => {
    const reg = await http().post('/api/v1/auth/register/student').send({
      firstName: 'Dob', lastName: 'Self', username: 'dob.self', email: 'dob.self@test.local', password: 'Secret123',
      dateOfBirth: bornYearsAgo(15), gender: 'MALE', guardianPhone: '0722000111', gradeLevel: 'S2', schoolId, homeLocation: 'Huye',
    });
    expect(reg.status).toBe(201);
    await ctx.prisma.user.update({ where: { id: reg.body.id }, data: { activatedAt: new Date(), isApproved: true } });
    expect(String(reg.body.dateOfBirth).slice(0, 10)).toBe(bornYearsAgo(15));
    for (const token of [await login(ctx, 'dob.self', 'Secret123'), await login(ctx, 'student.j')]) {
      expect((await http().get('/api/v1/me').set(bearer(token)).expect(200)).body.dateOfBirthRequired).toBe(false);
      await http().get('/api/v1/me/enrollments').set(bearer(token)).expect(200);
      expect(await status(http().put('/api/v1/me/date-of-birth').set(bearer(token)).send({ dateOfBirth: bornYearsAgo(14) }))).toEqual([409, 'DATE_OF_BIRTH_ALREADY_SET']);
    }
    // A coach and an administrator have no date of birth and are not held; the step is for students only.
    const coach = await login(ctx, 'mentor.j');
    expect((await http().get('/api/v1/me').set(bearer(coach)).expect(200)).body.dateOfBirthRequired).toBe(false);
    await http().get('/api/v1/courses').set(bearer(coach)).expect(200);
    expect(await status(http().put('/api/v1/me/date-of-birth').set(bearer(coach)).send({ dateOfBirth: bornYearsAgo(14) }))).toEqual([403, 'FORBIDDEN']);
    expect((await http().get('/api/v1/admin/users').set(bearer(admin))).status).toBe(200);
  });

  describe('Administrator corrections (owner approval 2026-11-18)', () => {
    let studentId: string;
    const correct = (id: string, body: object, token = admin) => http().put(`/api/v1/admin/users/${id}/date-of-birth`).set(bearer(token)).send(body);
    beforeAll(async () => {
      const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'Dob', lastName: 'Fix', username: 'dob.fix', email: 'dob.fix@test.local', password: PASSWORD, role: 'STUDENT', gradeLevel: 'S2', schoolId,
      }).expect(201);
      studentId = created.body.id;
    });

    it('a reason is mandatory; the date follows the registration rules; only students; refused to non-administrators', async () => {
      for (const body of [{ dateOfBirth: bornYearsAgo(13) }, { dateOfBirth: bornYearsAgo(13), reason: '' }, { dateOfBirth: bornYearsAgo(13), reason: 'abc' },
        { dateOfBirth: bornYearsAgo(3), reason: 'Wrong year on the form' }, { dateOfBirth: '2012-02-30', reason: 'Wrong year on the form' }]) {
        expect([body, await status(correct(studentId, body))]).toEqual([body, [400, 'VALIDATION_FAILED']]);
      }
      expect(await status(correct(ctx.ids.mentorJunior, { dateOfBirth: bornYearsAgo(30), reason: 'Not a student at all' }))).toEqual([400, 'NOT_A_STUDENT']);
      const coach = await login(ctx, 'mentor.j');
      const student = await login(ctx, 'student.j');
      for (const token of [coach, student]) expect((await status(correct(studentId, { dateOfBirth: bornYearsAgo(13), reason: 'Trying to change it' }, token)))[0]).toBe(403);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: studentId } })).dateOfBirth).toBeNull();
    });

    it('a correction records the old and new dates, the reason, who and when; a held student is released; history lists it', async () => {
      const token = await login(ctx, 'dob.fix', PASSWORD);
      expect(await status(http().get('/api/v1/courses').set(bearer(token)))).toEqual([403, 'DATE_OF_BIRTH_REQUIRED']);
      const first = bornYearsAgo(13);
      const res = await correct(studentId, { dateOfBirth: first, reason: 'From the school register' }).expect(200);
      expect(String(res.body.dateOfBirth).slice(0, 10)).toBe(first);
      await http().get('/api/v1/courses').set(bearer(token)).expect(200);   // released at once
      const second = bornYearsAgo(14);
      await correct(studentId, { dateOfBirth: second, reason: 'Parent sent the birth certificate' }).expect(200);
      expect(await status(correct(studentId, { dateOfBirth: second, reason: 'Same date again' }))).toEqual([409, 'DATE_OF_BIRTH_UNCHANGED']);
      const audit = await ctx.prisma.auditLog.findMany({ where: { action: 'DATE_OF_BIRTH_CORRECTED', entityId: studentId }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => [a.actorId, a.actorRole, a.metadata])).toEqual([
        [ctx.ids.admin, 'ADMIN', { from: null, to: first, reason: 'From the school register' }],
        [ctx.ids.admin, 'ADMIN', { from: first, to: second, reason: 'Parent sent the birth certificate' }],
      ]);
      const history = (await http().get(`/api/v1/admin/users/${studentId}/date-of-birth-history`).set(bearer(admin)).expect(200)).body;
      expect(history.map((h: any) => [h.kind, h.from, h.to, h.reason, h.by?.username])).toEqual([
        ['CORRECTED', first, second, 'Parent sent the birth certificate', 'admin'],
        ['CORRECTED', null, first, 'From the school register', 'admin'],
      ]);
      expect((await status(http().get(`/api/v1/admin/users/${studentId}/date-of-birth-history`).set(bearer(token))))[0]).toBe(403);
      // The student still cannot change it.
      expect(await status(http().put('/api/v1/me/date-of-birth').set(bearer(token)).send({ dateOfBirth: bornYearsAgo(12) }))).toEqual([409, 'DATE_OF_BIRTH_ALREADY_SET']);
    });
  });

  it('a held student can still sign out everywhere; an Administrator can still manage the account', async () => {
    const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Dob', lastName: 'Out', username: 'dob.out', email: 'dob.out@test.local', password: PASSWORD, role: 'STUDENT', gradeLevel: 'S2', schoolId,
    }).expect(201);
    const token = await login(ctx, 'dob.out', PASSWORD);
    await http().get(`/api/v1/admin/users/${created.body.id}`).set(bearer(admin)).expect(200);
    await http().post('/api/v1/auth/logout-all').set(bearer(token)).expect(200);
    await http().get('/api/v1/me').set(bearer(token)).expect(401);
  });
});
