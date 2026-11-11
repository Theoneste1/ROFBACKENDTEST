/**
 * Account management: invitations and activation, e-mail verification,
 * admin password resets, CSV import, enrolment protection, mentor
 * assignments, deactivation — and the audit trail they leave.
 */
import { createTestApp, login, bearer, inDays, PASSWORD, type TestContext } from './helpers.js';

const NEW_PASSWORD = 'Activate123';

describe('User management (e2e)', () => {
  let ctx: TestContext;
  let admin: string, studentJ: string, mentorJ: string;

  /** The token from the most recent e-mail sent to an address. */
  const lastLinkToken = async (email: string, path: 'activate' | 'reset-password' = 'activate') => {
    const mail = await ctx.prisma.emailDelivery.findFirstOrThrow({
      where: { recipientEmail: email, body: { contains: `/${path}?token=` } }, orderBy: { createdAt: 'desc' },
    });
    return decodeURIComponent(new RegExp(`/${path}\\?token=([^\\s]+)`).exec(mail.body!)![1]);
  };

  const audited = (action: string, entityId?: string) =>
    ctx.prisma.auditLog.count({ where: { action, ...(entityId && { entityId }) } });

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, studentJ, mentorJ] = await Promise.all([login(ctx, 'admin'), login(ctx, 'student.j'), login(ctx, 'mentor.j')]);
    // Official schools the invitations and the CSV import refer to (PR B: they never create one).
    for (const [code, name] of [['110998', 'Groupe Scolaire Kigali'], ['110997', 'Lycée de Kigali, Annexe']]) {
      await ctx.prisma.school.create({ data: {
        name, code, location: 'Kacyiru, Gasabo', province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru', source: 'OFFICIAL_LIST',
      } });
    }
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('invitations and activation', () => {
    let invitedId: string;

    it('admin invites a student: account exists, enrolled, but cannot log in', async () => {
      const res = await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
        firstName: 'Aline', lastName: 'Mukamana', email: 'Aline.M@example.com', gradeLevel: 'S4',
        // By code; the optional name check ignores case (PR B — a name alone is refused, never created).
        schoolCode: '110998', schoolName: 'groupe scolaire kigali',
      }).expect(201);

      expect(res.body.user).toMatchObject({
        email: 'aline.m@example.com', username: 'aline.m', role: 'STUDENT', gradeLevel: 'S4',
        activatedAt: null, division: { code: 'SENIOR' }, school: { name: 'Groupe Scolaire Kigali' },
      });
      expect(new Date(res.body.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      invitedId = res.body.user.id;

      const enrolment = await ctx.prisma.studentEnrollment.findFirstOrThrow({ where: { studentId: invitedId } });
      expect(enrolment).toMatchObject({ academicYearId: ctx.ids.year, gradeLevel: 'S4', status: 'ACTIVE' });

      await ctx.http().post('/api/v1/auth/login').send({ username: 'aline.m', password: NEW_PASSWORD }).expect(401);
      expect(await audited('INVITE_USER', invitedId)).toBe(1);
    });

    it('the link shows who it is for, requires a strong password, and works once', async () => {
      const token = await lastLinkToken('aline.m@example.com');

      const info = await ctx.http().post('/api/v1/auth/activation/inspect').send({ token }).expect(200);
      expect(info.body).toMatchObject({ purpose: 'INVITATION', requiresPassword: true, firstName: 'Aline', email: 'a***m@example.com' });

      const noPassword = await ctx.http().post('/api/v1/auth/activate').send({ token }).expect(400);
      expect(noPassword.body.code).toBe('PASSWORD_REQUIRED');
      await ctx.http().post('/api/v1/auth/activate').send({ token, password: 'short' }).expect(400);

      const ok = await ctx.http().post('/api/v1/auth/activate').send({ token, password: NEW_PASSWORD }).expect(200);
      expect(ok.body.username).toBe('aline.m');

      const again = await ctx.http().post('/api/v1/auth/activate').send({ token, password: NEW_PASSWORD }).expect(400);
      expect(again.body.code).toBe('INVALID_ACTIVATION_TOKEN');

      await login(ctx, 'aline.m', NEW_PASSWORD);
      expect(await audited('ACTIVATE_ACCOUNT', invitedId)).toBe(1);
    });

    it('re-sending an invitation invalidates the previous link', async () => {
      const res = await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin))
        .send({ firstName: 'Paul', lastName: 'Mentor', email: 'paul@example.com', role: 'MENTOR' }).expect(201);
      expect(res.body.user.gradeLevel).toBeNull();
      const first = await lastLinkToken('paul@example.com');

      await ctx.http().post(`/api/v1/admin/users/${res.body.user.id}/resend-invitation`).set(bearer(admin)).expect(200);
      const second = await lastLinkToken('paul@example.com');
      expect(second).not.toBe(first);

      const stale = await ctx.http().post('/api/v1/auth/activation/inspect').send({ token: first }).expect(400);
      expect(stale.body.code).toBe('INVALID_ACTIVATION_TOKEN');
      await ctx.http().post('/api/v1/auth/activate').send({ token: second, password: NEW_PASSWORD }).expect(200);

      const done = await ctx.http().post(`/api/v1/admin/users/${res.body.user.id}/resend-invitation`).set(bearer(admin)).expect(409);
      expect(done.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('expired links are refused', async () => {
      const res = await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin))
        .send({ firstName: 'Old', lastName: 'Link', email: 'old.link@example.com', gradeLevel: 'S1' }).expect(201);
      const token = await lastLinkToken('old.link@example.com');
      await ctx.prisma.accountActivationToken.updateMany({ where: { userId: res.body.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await ctx.http().post('/api/v1/auth/activate').send({ token, password: NEW_PASSWORD }).expect(400);
    });

    it('validates invitations and keeps them admin-only', async () => {
      const dup = await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin))
        .send({ firstName: 'X', lastName: 'Y', email: 'aline.m@example.com', gradeLevel: 'S2' }).expect(409);
      expect(dup.body.code).toBe('IDENTITY_TAKEN');
      const noGrade = await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin))
        .send({ firstName: 'X', lastName: 'Y', email: 'x.y@example.com' }).expect(400);
      expect(noGrade.body.code).toBe('VALIDATION_FAILED');
      await ctx.http().post('/api/v1/admin/users/invite').set(bearer(mentorJ))
        .send({ firstName: 'X', lastName: 'Y', email: 'x.y@example.com', gradeLevel: 'S2' }).expect(403);
    });

    it('lists pending invitations', async () => {
      const res = await ctx.http().get('/api/v1/admin/users').query({ isActivated: false }).set(bearer(admin)).expect(200);
      expect(res.body.data.map((u: any) => u.email)).toEqual(['old.link@example.com']);
    });
  });

  describe('e-mail verification for self-registration', () => {
    it('when enabled, students confirm their e-mail before logging in', async () => {
      await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin))
        .send({ 'registration.requireEmailVerification': true }).expect(200);

      const reg = await ctx.http().post('/api/v1/auth/register/student').send({
        firstName: 'Eric', lastName: 'Nkusi', username: 'eric.n', email: 'eric@example.com', password: 'Student123',
        gradeLevel: 'S2', schoolName: 'Test School', schoolLocation: 'Kigali', homeLocation: 'Kigali',
      }).expect(201);
      expect(reg.body.requiresEmailVerification).toBe(true);

      const blocked = await ctx.http().post('/api/v1/auth/login').send({ username: 'eric.n', password: 'Student123' }).expect(403);
      expect(blocked.body.code).toBe('ACCOUNT_NOT_ACTIVATED');

      // "Resend" answers the same for unknown addresses.
      const unknown = await ctx.http().post('/api/v1/auth/resend-activation').send({ email: 'nobody@example.com' }).expect(200);
      const known = await ctx.http().post('/api/v1/auth/resend-activation').send({ email: 'eric@example.com' }).expect(200);
      expect(known.body).toEqual(unknown.body);

      const token = await lastLinkToken('eric@example.com');
      const info = await ctx.http().post('/api/v1/auth/activation/inspect').send({ token }).expect(200);
      expect(info.body).toMatchObject({ purpose: 'EMAIL_VERIFICATION', requiresPassword: false });
      await ctx.http().post('/api/v1/auth/activate').send({ token }).expect(200);
      await login(ctx, 'eric.n', 'Student123');

      await ctx.http().patch('/api/v1/admin/settings').set(bearer(admin))
        .send({ 'registration.requireEmailVerification': false }).expect(200);
    });
  });

  describe('admin-triggered password reset', () => {
    it('e-mails a reset link; the admin never sees the password', async () => {
      const res = await ctx.http().post(`/api/v1/admin/users/${ctx.ids.studentJunior}/send-password-reset`).set(bearer(admin)).expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/token/i);

      const token = await lastLinkToken('student.j@test.local', 'reset-password');
      await ctx.http().post('/api/v1/auth/reset-password').send({ token, newPassword: 'Changed123' }).expect(200);
      studentJ = await login(ctx, 'student.j', 'Changed123');

      const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'REQUEST_PASSWORD_RESET', entityId: ctx.ids.studentJunior } });
      expect(log.actorId).toBe(ctx.ids.admin);
    });
  });

  describe('CSV import', () => {
    const csv = [
      'firstName,lastName,email,role,gradeLevel,schoolCode,schoolName,schoolLocation,homeLocation,username',
      'Grace,Uwase,grace@example.com,,S5,110997,"LYCEE DE KIGALI ANNEXE",Kigali,Kigali,',
      'Jean,Habimana,jean.mentor@example.com,mentor,,,,,,jean.h',
      'No,Grade,nograde@example.com,STUDENT,,,,,,',
      'Bad,Email,not-an-email,STUDENT,S1,,,,,',
      'Grace,Again,GRACE@example.com,STUDENT,S2,,,,,',
      'Taken,Already,student.s@test.local,STUDENT,S3,,,,,',
      // PR B: a school by name only is a row error (never created); a name that does not match the code too.
      'Name,Only,name.only@example.com,STUDENT,S2,,"Brand New School",Huye,,',
      'Wrong,Name,wrong.name@example.com,STUDENT,S2,110997,"Lycée de Huye",,,',
    ].join('\r\n');

    const upload = (body: string, dryRun: boolean) =>
      ctx.http().post('/api/v1/admin/users/import').query({ dryRun }).set(bearer(admin))
        .attach('file', Buffer.from(body, 'utf8'), { filename: 'students.csv', contentType: 'text/csv' });

    it('dry run reports every problem and creates nothing', async () => {
      const before = await ctx.prisma.user.count();
      const schools = await ctx.prisma.school.count();
      const res = await upload(csv, true).expect(200);
      expect(res.body).toMatchObject({ dryRun: true, totalRows: 8, valid: 2, created: 0, failed: 6 });
      expect(res.body.errors.map((e: any) => e.row)).toEqual([4, 5, 6, 7, 8, 9]);
      expect(res.body.errors.find((e: any) => e.row === 6).errors.join()).toContain('repeats row 2');
      expect(res.body.errors.find((e: any) => e.row === 7).errors.join()).toContain('already exists');
      expect(res.body.errors.find((e: any) => e.row === 8).errors.join()).toMatch(/"Brand New School" was given by name only/);
      expect(res.body.errors.find((e: any) => e.row === 9).errors.join()).toMatch(/"Lycée De Huye" does not match the school with code 110997 \("Lycée de Kigali, Annexe"\)/);
      expect(await ctx.prisma.user.count()).toBe(before);
      expect(await ctx.prisma.school.count()).toBe(schools);
    });

    it('import invites the valid rows (placed, enrolled, e-mailed) and reports the rest', async () => {
      const schools = await ctx.prisma.school.count();
      const res = await upload(csv, false).expect(200);
      expect(res.body).toMatchObject({ dryRun: false, created: 2, failed: 6 });
      expect(await ctx.prisma.school.count()).toBe(schools);   // no school created (PR B)
      expect(await ctx.prisma.user.count({ where: { email: { in: ['name.only@example.com', 'wrong.name@example.com'] } } })).toBe(0);

      const grace = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'grace@example.com' }, include: { school: true, studentEnrollments: true },
      });
      expect(grace).toMatchObject({ username: 'grace', role: 'STUDENT', gradeLevel: 'S5', divisionId: ctx.ids.senior, activatedAt: null });
      expect(grace.school?.name).toBe('Lycée de Kigali, Annexe');   // the existing school its code names
      expect(grace.studentEnrollments).toHaveLength(1);

      const jean = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'jean.mentor@example.com' } });
      expect(jean).toMatchObject({ username: 'jean.h', role: 'MENTOR', gradeLevel: null });

      await lastLinkToken('grace@example.com');
      expect(await audited('IMPORT_USERS')).toBe(1);
    });

    it('rejects a bad header, a non-UTF-8 file and an empty upload', async () => {
      const header = await upload('first,last,email\nA,B,a@b.com', true).expect(400);
      expect(header.body.code).toBe('INVALID_CSV_HEADER');
      expect(header.body.details.missing).toEqual(['firstName', 'lastName']);

      const binary = await ctx.http().post('/api/v1/admin/users/import').set(bearer(admin))
        .attach('file', Buffer.from([0xff, 0xfe, 0x00, 0x41]), 'x.csv').expect(415);
      expect(binary.body.code).toBe('INVALID_CSV');

      await ctx.http().post('/api/v1/admin/users/import').set(bearer(admin)).expect(400);
      await upload(csv, true).set(bearer(studentJ)).expect(403);
    });
  });

  describe('enrolment protection', () => {
    it('students cannot change their own grade or division', async () => {
      await ctx.http().patch('/api/v1/me').set(bearer(studentJ)).send({ gradeLevel: 'S6' }).expect(400);
      await ctx.http().patch('/api/v1/me').set(bearer(studentJ)).send({ divisionId: ctx.ids.senior }).expect(400);
      const me = await ctx.http().get('/api/v1/me').set(bearer(studentJ)).expect(200);
      expect(me.body.gradeLevel).toBe('S2');
    });

    it('only admins can change an enrolment, and it is audited', async () => {
      const enrolment = await ctx.prisma.studentEnrollment.findFirstOrThrow({ where: { studentId: ctx.ids.studentJunior } });
      await ctx.http().patch(`/api/v1/admin/enrollments/${enrolment.id}`).set(bearer(studentJ)).send({ gradeLevel: 'S4' }).expect(403);
      await ctx.http().patch(`/api/v1/admin/enrollments/${enrolment.id}`).set(bearer(mentorJ)).send({ gradeLevel: 'S4' }).expect(403);

      await ctx.http().patch(`/api/v1/admin/enrollments/${enrolment.id}`).set(bearer(admin)).send({ gradeLevel: 'S3' }).expect(200);
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } });
      expect(user).toMatchObject({ gradeLevel: 'S3', divisionId: ctx.ids.junior });
      expect(await audited('UPDATE_ENROLLMENT', enrolment.id)).toBe(1);

      // A student only ever sees their own enrolments.
      const mine = await ctx.http().get('/api/v1/me/enrollments').set(bearer(studentJ)).expect(200);
      expect(mine.body.every((e: any) => e.gradeLevel === 'S3')).toBe(true);
      await ctx.http().get(`/api/v1/admin/academic-years/${ctx.ids.year}/enrollments`).set(bearer(studentJ)).expect(403);
    });
  });

  describe('mentor management', () => {
    it('one mentor can teach several courses in both divisions; unassigning removes access', async () => {
      const assign = (courseId: string, divisionId: string) =>
        ctx.http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
          .send({ mentorId: ctx.ids.mentorJunior, courseId, divisionId }).expect(201);

      await assign(ctx.ids.geometry, ctx.ids.junior);
      const senior = await assign(ctx.ids.geometry, ctx.ids.senior);

      const teaching = await ctx.http().get('/api/v1/me/teaching').set(bearer(mentorJ)).expect(200);
      expect(teaching.body.map((t: any) => `${t.course.code}/${t.division.code}`).sort())
        .toEqual(['ALGEBRA/JUNIOR', 'GEOMETRY/JUNIOR', 'GEOMETRY/SENIOR']);

      await ctx.http().get(`/api/v1/analytics/courses/${ctx.ids.geometry}`).query({ divisionId: ctx.ids.senior }).set(bearer(mentorJ)).expect(200);
      await ctx.http().delete(`/api/v1/admin/mentor-assignments/${senior.body.id}`).set(bearer(admin)).expect(200);
      await ctx.http().get(`/api/v1/analytics/courses/${ctx.ids.geometry}`).query({ divisionId: ctx.ids.senior }).set(bearer(mentorJ)).expect(403);

      const notMentor = await ctx.http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
        .send({ mentorId: ctx.ids.studentJunior, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }).expect(400);
      expect(notMentor.body.code).toBe('NOT_A_MENTOR');
    });
  });

  describe('deactivation and reactivation', () => {
    it('a deactivated account loses access at once and its activation links stop working', async () => {
      const token = await login(ctx, 'student.j2');
      await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}/status`).set(bearer(admin)).send({ isActive: false }).expect(200);
      await ctx.http().get('/api/v1/me').set(bearer(token)).expect(401);

      const invited = await ctx.http().post('/api/v1/admin/users/invite').set(bearer(admin))
        .send({ firstName: 'Sus', lastName: 'Pended', email: 'sus@example.com', gradeLevel: 'S1' }).expect(201);
      const link = await lastLinkToken('sus@example.com');
      await ctx.http().patch(`/api/v1/admin/users/${invited.body.user.id}/status`).set(bearer(admin)).send({ isActive: false }).expect(200);
      await ctx.http().post('/api/v1/auth/activation/inspect').send({ token: link }).expect(404);

      await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentJunior2}/status`).set(bearer(admin)).send({ isActive: true }).expect(200);
      await login(ctx, 'student.j2');
      expect(await audited('UPDATE_USER_STATUS', ctx.ids.studentJunior2)).toBe(2);
    });

    it('students cannot read other users\' records', async () => {
      await ctx.http().get(`/api/v1/admin/users/${ctx.ids.studentSenior}`).set(bearer(studentJ)).expect(403);
      await ctx.http().get('/api/v1/admin/users').set(bearer(mentorJ)).expect(403);
      // Leaderboards never expose e-mail addresses.
      const board = await ctx.http().get('/api/v1/leaderboard').set(bearer(studentJ)).expect(200);
      expect(JSON.stringify(board.body)).not.toContain('@');
      void inDays; void PASSWORD;
    });
  });
});
