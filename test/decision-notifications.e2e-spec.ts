/**
 * Decision notifications (owner-approved): school.request.verified, teacher.application.approved,
 * coach.application.approved and permissions.granted — one outbox (NotificationOutbox) written in the
 * Administrator's transaction, e-mailed after commit (dry run: e-mail never leaves the machine), retried by
 * the sweep and the delivery-log endpoint (email.bulkSend).
 *
 * Fixtures: official schools in Southern Province / Huye / Ngoma (220001) and Tumba (220002).
 */
import { randomUUID } from 'node:crypto';
import type { MockInstance } from 'vitest';

import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';
import { MailerService } from '../src/email/mailer.service.js';
import { DecisionNotificationsService } from '../src/decision-notifications/decision-notifications.service.js';

const REGISTER = '/api/v1/auth/register/teacher';
const ADMIN_APPS = '/api/v1/admin/teacher-applications';
const DELIVERIES = '/api/v1/admin/notification-deliveries';
const AFFILIATIONS = '/api/v1/admin/school-affiliations';
const SCHOOL_SUBJECT = 'Your school is now part of the ROF Olympiad Community!';

describe('Decision notifications', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, coach: string, student: string;
  let ngoma: string, tumba: string;
  let mailer: MailerService;
  let send: MockInstance<MailerService['sendOne']>;
  let notices: DecisionNotificationsService;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const outbox = (where: object = {}) => p().notificationOutbox.findMany({ where, orderBy: { createdAt: 'asc' } });
  const mailsTo = (to: string) => send.mock.calls.map((c) => c[0]).filter((m) => m.to === to);
  /** Every action is followed by the after-commit dispatch: wait for it. */
  const settle = () => waitForEvents();

  let n = 0;
  const application = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      firstName: 'Aline', lastName: 'Teacher', username: `dn.t${n}`, email: `dn.t${n}@test.local`,
      password: 'Secret123', confirmPassword: 'Secret123', gender: 'MALE', country: 'RW', phone: '0788123456',
      olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolId: ngoma,
      homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma', ...over,
    };
  };
  const missingApplication = (over: Record<string, unknown> = {}) => {
    const { schoolId: _drop, ...rest } = application(over);
    return { ...rest, proposedSchoolName: 'GS Kabeza Hill', schoolSector: 'Tumba', ...over };
  };
  const register = async (body: Record<string, unknown>) => (await http().post(REGISTER).send(body).expect(201)).body.id as string;
  const approve = (id: string, token = admin) => http().post(`${ADMIN_APPS}/${id}/approve`).set(bearer(token)).send({});
  const verifySchool = (id: string, schoolId: string, token = admin) => http().post(`${ADMIN_APPS}/${id}/school`).set(bearer(token)).send({ schoolId });
  const setting = (key: string, value: unknown) => http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ [key]: value }).expect(200);
  let code = 220500;
  const createSchool = async (name: string) => (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({
    name, code: String(++code), province: 'Southern Province', district: 'Huye', sector: 'Tumba', location: 'Huye',
  }).expect(201)).body.id as string;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    [admin, coach, student] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));
    const official = (name: string, schoolCode: string, sector: string) => p().school.create({ data: {
      name, code: schoolCode, nameKey: name.toLowerCase(), location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
      province: 'Southern Province', district: 'Huye', sector,
    } }).then((s) => s.id);
    ngoma = await official('gs ngoma official', '220001', 'Ngoma');
    tumba = await official('gs tumba official', '220002', 'Tumba');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    await p().user.create({ data: { username: 'dn.super', firstName: 'Sam', lastName: 'Super', email: 'dn.super@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
    superAdmin = await login(ctx, 'dn.super');
    await setting('registration.teacherSelfSignup', true);

    mailer = ctx.app.get(MailerService);
    notices = ctx.app.get(DecisionNotificationsService);
    // E-mail stays on this machine (test/setup-env.ts empties RESEND_API_KEY): every send is a logged dry run.
    expect(mailer.isDryRun).toBe(true);
    send = vi.spyOn(mailer, 'sendOne');
  });
  afterEach(() => { send.mockClear(); });
  afterAll(async () => {
    send?.mockRestore();
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  // ─── school.request.verified (teacher application) ─────────────────────────

  describe('teacher application: missing-school verification', () => {
    it('e-mails the applicant (application address, first name, official name, owner text); no in-app; still PENDING; no account or assignment', async () => {
      const id = await register(missingApplication({ firstName: 'Aline', email: 'aline.applicant@test.local', username: 'aline.applicant' }));
      const school = await createSchool('Groupe Scolaire Kabeza Hill');
      const users = await p().user.count();
      const assignments = await p().teacherSchoolAssignment.count();

      const res = await verifySchool(id, school).expect(200);
      expect(res.body).toMatchObject({ id, status: 'PENDING', userId: null, school: { id: school }, schoolVerifiedBy: { id: ctx.ids.admin } });
      await settle();

      const rows = await outbox({ entityId: id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'school.request.verified', dedupeKey: `school.request.verified:teacher-application:${id}`,
        recipientEmail: 'aline.applicant@test.local', recipientUserId: null, firstName: 'Aline', inAppNotificationId: null,
        entityType: 'TeacherApplication', status: 'SENT', attempts: 1, lastError: null,
      });
      expect(rows[0].sentAt).not.toBeNull();
      const mails = mailsTo('aline.applicant@test.local');
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(SCHOOL_SUBJECT);
      expect(mails[0].text).toContain('Dear Aline,');
      expect(mails[0].text).toContain('your school, Groupe Scolaire Kabeza Hill, has been successfully verified and added to the Rwanda Olympiad Foundation\'s official school directory.');
      expect(mails[0].text).toContain('Thank you for helping us expand opportunities for students across Rwanda!');
      expect(mails[0].text).not.toMatch(/approved|Applicant|Secret123|\$2[aby]\$/);
      expect(mails[0].text).not.toContain(id);
      expect(mails[0].html).toContain('Dear Aline,');
      // Owner decisions 2026-11-14: teacher applicants get no sign-in link; the organisation is named once (footer).
      expect(mails[0].text).not.toMatch(/sign in|Sign in to ROF LMS|\/login/i);
      expect(mails[0].text.match(/^Rwanda Olympiad Foundation$/gm)).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ audience: 'TEACHER_APPLICANT' });

      expect(await p().notification.count({ where: { type: 'school.request.verified' } })).toBe(0);
      expect((await p().teacherApplication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      expect(await p().user.count()).toBe(users);
      expect(await p().teacherSchoolAssignment.count()).toBe(assignments);

      // Repeating the action: 409, no second row or e-mail.
      expect(await status(verifySchool(id, school))).toEqual([409, 'SCHOOL_ALREADY_VERIFIED']);
      await settle();
      expect(await outbox({ entityId: id })).toHaveLength(1);
      expect(mailsTo('aline.applicant@test.local')).toHaveLength(1);
    });

    it('a school without an official code (not in the public directory): the notice does not say it was added to the directory (L4)', async () => {
      const id = await register(missingApplication({ firstName: 'Nina', email: 'nina.applicant@test.local', username: 'nina.applicant' }));
      const school = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({
        name: 'GS Nina Hill', province: 'Southern Province', district: 'Huye', sector: 'Tumba', location: 'Huye',
      }).expect(201)).body.id as string;
      expect((await p().school.findUniqueOrThrow({ where: { id: school } })).code).toBeNull();
      await verifySchool(id, school).expect(200);
      await settle();
      const rows = await outbox({ entityId: id });
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({ schoolName: 'GS Nina Hill', officialDirectory: false, audience: 'TEACHER_APPLICANT' });
      const mails = mailsTo('nina.applicant@test.local');
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain('your school, GS Nina Hill, has been successfully verified by the Rwanda Olympiad Foundation.');
      expect(mails[0].text).not.toContain('official school directory');
      expect(mails[0].text).not.toMatch(/Sign in to ROF LMS|\/login/);
    });

    it('a listed-school application has nothing to verify (409); refused or unauthorised calls queue nothing', async () => {
      const listedId = await register(application());
      expect(await status(verifySchool(listedId, tumba))).toEqual([409, 'SCHOOL_ALREADY_VERIFIED']);
      const missingId = await register(missingApplication());
      expect(await status(verifySchool(missingId, randomUUID()))).toEqual([400, 'UNKNOWN_SCHOOL']);
      expect(await status(verifySchool(missingId, tumba, coach))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(verifySchool(missingId, tumba, student))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(http().post(`${ADMIN_APPS}/${missingId}/school`).send({ schoolId: tumba }))).toEqual([401, 'UNAUTHORIZED']);
      await settle();
      expect(await outbox({ entityId: { in: [listedId, missingId] } })).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ─── teacher.application.approved ──────────────────────────────────────────

  describe('teacher approval', () => {
    it('activated account: e-mail + in-app, ready to use with the login link; repeating the approval adds nothing', async () => {
      const id = await register(application({ firstName: 'Eric', username: 'dn.eric', email: 'dn.eric@test.local' }));
      const res = await approve(id).expect(200);
      await settle();
      const userId = res.body.teacher.id;
      const [row] = await outbox({ type: 'teacher.application.approved', entityId: id });
      expect(row).toMatchObject({ dedupeKey: `teacher.application.approved:${id}`, recipientUserId: userId, recipientEmail: 'dn.eric@test.local', firstName: 'Eric', status: 'SENT' });
      const inApp = await p().notification.findMany({ where: { userId, type: 'teacher.application.approved' } });
      expect(inApp).toHaveLength(1);
      expect(inApp[0]).toMatchObject({ id: row.inAppNotificationId, category: 'ACCOUNT' });
      const [mail] = mailsTo('dn.eric@test.local');
      expect(mail.text).toContain('Dear Eric,');
      expect(mail.text).toContain('as a Teacher has been approved');
      expect(mail.text).toContain('ready to use');
      expect(mail.text).toContain('http://localhost:5173/login');
      expect(mail.text).not.toMatch(/Secret123|\$2[aby]\$/);
      expect(mail.text).not.toContain(userId);

      expect(await status(approve(id))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
      await settle();
      expect(await outbox({ entityId: id })).toHaveLength(1);
      expect(await p().notification.count({ where: { userId, type: 'teacher.application.approved' } })).toBe(1);
      expect(mailsTo('dn.eric@test.local')).toHaveLength(1);
    });

    it('e-mail verification on: approved, confirm the e-mail first (separate activation message); no "ready to use", no login link', async () => {
      const id = await register(application({ firstName: 'Vera', username: 'dn.vera', email: 'dn.vera@test.local' }));
      await setting('registration.requireEmailVerification', true);
      try {
        const res = await approve(id).expect(200);
        expect(res.body.emailVerificationRequired).toBe(true);
        await settle();
        const [mail] = mailsTo('dn.vera@test.local');
        expect(mail.text).toContain('Dear Vera,');
        expect(mail.text).toContain('has been approved');
        expect(mail.text).toContain('confirm your e-mail address');
        expect(mail.text).not.toContain('ready to use');
        expect(mail.text).not.toContain('/login');
        // The activation message is still queued as before.
        expect(await p().emailDelivery.count({ where: { recipientEmail: 'dn.vera@test.local' } })).toBeGreaterThanOrEqual(1);
        expect(await p().notification.count({ where: { userId: res.body.teacher.id, type: 'teacher.application.approved' } })).toBe(1);
      } finally {
        await setting('registration.requireEmailVerification', false);
      }
    });

    it('missing-school application: verification notice, then the approval notice (two distinct events)', async () => {
      const id = await register(missingApplication({ firstName: 'Paul', username: 'dn.paul', email: 'dn.paul@test.local' }));
      expect(await status(approve(id))).toEqual([400, 'SCHOOL_NOT_VERIFIED']);
      await settle();
      expect(await outbox({ entityId: id })).toHaveLength(0);
      await verifySchool(id, await createSchool('GS Paul Official')).expect(200);
      await approve(id).expect(200);
      await settle();
      expect((await outbox({ entityId: id })).map((r) => r.type)).toEqual(['school.request.verified', 'teacher.application.approved']);
      expect(mailsTo('dn.paul@test.local').map((m) => m.subject)).toEqual([SCHOOL_SUBJECT, 'Your teacher application has been approved']);
    });

    it('rejected and pending applications: no approval notification', async () => {
      const rejected = await register(application());
      const pending = await register(application());
      await http().post(`${ADMIN_APPS}/${rejected}/reject`).set(bearer(admin)).send({ reason: 'Could not confirm' }).expect(200);
      await settle();
      expect(await outbox({ entityId: { in: [rejected, pending] } })).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ─── Decision 10: teacher-registration notices follow self-registration ────

  describe('teacher self-registration turned off (decision 10)', () => {
    // TEACHERS_ENABLED stays on (the review routes answer 403 TEACHERS_DISABLED without it); the
    // registration.teacherSelfSignup setting is turned off after the applications were submitted.
    it('approval, school verification and rejection of pending applications send no notice; the decisions still apply', async () => {
      const listed = await register(application({ firstName: 'Odile', username: 'dn.off1', email: 'dn.off1@test.local' }));
      const missing = await register(missingApplication({ firstName: 'Omar', username: 'dn.off2', email: 'dn.off2@test.local' }));
      const rejected = await register(application({ firstName: 'Olga', username: 'dn.off3', email: 'dn.off3@test.local' }));
      await setting('registration.teacherSelfSignup', false);
      try {
        const res = await approve(listed).expect(200);
        await verifySchool(missing, await createSchool('GS Omar Official')).expect(200);
        await approve(missing).expect(200);
        await http().post(`${ADMIN_APPS}/${rejected}/reject`).set(bearer(admin)).send({ reason: 'Could not confirm' }).expect(200);
        await settle();

        expect((await p().teacherApplication.findMany({ where: { id: { in: [listed, missing, rejected] } }, orderBy: { username: 'asc' } }))
          .map((a) => a.status)).toEqual(['APPROVED', 'APPROVED', 'REJECTED']);
        expect(await outbox({ entityId: { in: [listed, missing, rejected] } })).toHaveLength(0);
        expect(await p().notification.count({ where: { userId: res.body.teacher.id } })).toBe(0);
        for (const to of ['dn.off1@test.local', 'dn.off2@test.local', 'dn.off3@test.local']) expect(mailsTo(to)).toHaveLength(0);
        const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'APPROVE_TEACHER_APPLICATION', entityId: listed } });
        expect(audit.metadata).toMatchObject({ approvalNotice: 'NOT_SENT_SELF_REGISTRATION_OFF' });
        const verifiedAudit = await p().auditLog.findFirstOrThrow({ where: { action: 'VERIFY_TEACHER_APPLICATION_SCHOOL', entityId: missing } });
        expect(verifiedAudit.metadata).toMatchObject({ schoolVerifiedNotice: 'NOT_SENT_SELF_REGISTRATION_OFF' });
      } finally {
        await setting('registration.teacherSelfSignup', true);
      }
    });

    it('a notice queued while on is not e-mailed after self-registration is turned off (retry → FAILED, no automatic retry); on again it is sent', async () => {
      const id = await register(application({ firstName: 'Ines', username: 'dn.off4', email: 'dn.off4@test.local' }));
      send.mockRejectedValueOnce(new Error('provider down'));
      await approve(id).expect(200);
      await settle();
      const [row] = await outbox({ entityId: id });
      expect(row).toMatchObject({ type: 'teacher.application.approved', status: 'FAILED' });
      expect(await p().auditLog.findFirstOrThrow({ where: { action: 'APPROVE_TEACHER_APPLICATION', entityId: id } }))
        .toMatchObject({ metadata: expect.objectContaining({ approvalNotice: 'QUEUED' }) });

      await setting('registration.teacherSelfSignup', false);
      try {
        send.mockClear();
        await http().post(`${DELIVERIES}/${row.id}/retry`).set(bearer(admin)).expect(200);
        await settle();
        await notices.sweep(new Date(Date.now() + 3_600_000));
        expect(mailsTo('dn.off4@test.local')).toHaveLength(0);
        expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } }))
          .toMatchObject({ status: 'FAILED', lastError: 'Not sent: teacher self-registration is turned off.', nextAttemptAt: null });
      } finally {
        await setting('registration.teacherSelfSignup', true);
      }
      await http().post(`${DELIVERIES}/${row.id}/retry`).set(bearer(admin)).expect(200);
      await settle();
      expect(mailsTo('dn.off4@test.local')).toHaveLength(1);
      expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SENT' });
    });
  });

  // ─── coach.application.approved ────────────────────────────────────────────

  describe('coach approval', () => {
    const apply = async (username: string) => (await http().post('/api/v1/mentor-requests').send({
      firstName: 'Claude', lastName: 'Coach', username, email: `${username}@test.local`, password: 'Secret123', gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'],
    }).expect(201)).body.id as string;

    it('exactly ONE approval notice (outbox e-mail + in-app); the former approval e-mail is not queued', async () => {
      const id = await apply('dn.coach');
      const res = await http().patch(`/api/v1/mentor-requests/${id}/approve`).set(bearer(admin)).expect(200);
      await settle();
      const rows = await outbox({ entityId: id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'coach.application.approved', dedupeKey: `coach.application.approved:${id}`, recipientUserId: res.body.mentor.id, status: 'SENT' });
      expect(await p().notification.count({ where: { userId: res.body.mentor.id, type: 'coach.application.approved' } })).toBe(1);
      const mails = mailsTo('dn.coach@test.local');
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain('Dear Claude,');
      expect(mails[0].text).toContain('as a Coach has been approved');
      expect(mails[0].text).toContain('http://localhost:5173/login');
      // The old MentorRequestDecided approval e-mail (EmailDelivery outbox) is gone.
      expect(await p().emailDelivery.count({ where: { recipientEmail: 'dn.coach@test.local' } })).toBe(0);

      expect(await status(http().patch(`/api/v1/mentor-requests/${id}/approve`).set(bearer(admin)))).toEqual([409, 'INVALID_STATE_TRANSITION']);
      await settle();
      expect(await outbox({ entityId: id })).toHaveLength(1);
    });

    it('rejection: the existing rejection e-mail only; no approval notice', async () => {
      const id = await apply('dn.coach.no');
      await http().patch(`/api/v1/mentor-requests/${id}/reject`).set(bearer(admin)).expect(200);
      await settle();
      expect(await outbox({ entityId: id })).toHaveLength(0);
      const queued = await p().emailDelivery.findMany({ where: { recipientEmail: 'dn.coach.no@test.local' } });
      expect(queued).toHaveLength(1);
      expect(queued[0].subject).toContain('Your coach application');
    });
  });

  // ─── permissions.granted ───────────────────────────────────────────────────

  describe('permissions granted', () => {
    let teacherId: string;
    beforeAll(async () => {
      const id = await register(application({ firstName: 'Tina', username: 'dn.tina', email: 'dn.tina@test.local' }));
      teacherId = (await approve(id).expect(200)).body.teacher.id;
      await settle();
    });
    const delegate = (permission: string, token = admin, userId = teacherId) =>
      http().post(`/api/v1/admin/teachers/${userId}/delegations`).set(bearer(token)).send({ permission, reason: 'School coordinator duties' });
    const grants = () => outbox({ type: 'permissions.granted', recipientUserId: teacherId });

    it('a Teacher: one notice per saved grant, plain-language label and explanation; revoke and DENY add nothing', async () => {
      send.mockClear();
      const res = await delegate('students.viewProfile').expect(201);
      await settle();
      const rows = await grants();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ dedupeKey: `permissions.granted:${res.body.id}`, status: 'SENT', firstName: 'Tina' });
      const [mail] = mailsTo('dn.tina@test.local');
      expect(mail.text).toContain('Dear Tina,');
      expect(mail.text).toContain('• View student profiles: You can open the profile of a student of your assigned schools');
      expect(mail.text).not.toContain('students.viewProfile');
      expect(await p().notification.count({ where: { userId: teacherId, type: 'permissions.granted' } })).toBe(1);

      await http().delete(`/api/v1/admin/teachers/${teacherId}/delegations/${res.body.id}`).set(bearer(admin)).expect(200);
      await http().post(`/api/v1/admin/users/${teacherId}/permission-overrides`).set(bearer(superAdmin))
        .send({ permission: 'students.viewScoped', effect: 'DENY', reason: 'Temporarily restricted' }).expect(201);
      await settle();
      expect(await grants()).toHaveLength(1);
      expect(mailsTo('dn.tina@test.local')).toHaveLength(1);
    });

    it('nothing when the grant is refused (403), unauthorised (401), invalid (400), a duplicate (409) or for STUDENT / ADMIN / Coach targets refused by the policy', async () => {
      await delegate('students.viewProgress').expect(201);
      await settle();
      const before = (await outbox({ type: 'permissions.granted' })).length;
      send.mockClear();
      expect(await status(delegate('students.viewProgress'))).toEqual([409, 'OVERRIDE_EXISTS']);
      expect(await status(delegate('submissions.submitOnBehalf', coach))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(delegate('submissions.submitOnBehalf', student))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect((await http().post(`/api/v1/admin/teachers/${teacherId}/delegations`).send({ permission: 'students.viewProfile', reason: 'xxx' })).status).toBe(401);
      expect(await status(delegate('users.manageAdmins'))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(http().post(`/api/v1/admin/teachers/${teacherId}/delegations`).set(bearer(admin)).send({ permission: 'students.viewProfile' }))).toEqual([400, 'VALIDATION_FAILED']);
      // Administrators cannot use the Super Admin override route at all.
      expect(await status(http().post(`/api/v1/admin/users/${teacherId}/permission-overrides`).set(bearer(admin))
        .send({ permission: 'submissions.submitOnBehalf', effect: 'GRANT', reason: 'Not allowed for me' }))).toEqual([403, 'PERMISSION_REQUIRED']);
      for (const target of [ctx.ids.studentJunior, ctx.ids.admin, ctx.ids.mentorJunior]) {
        expect(await status(http().post(`/api/v1/admin/users/${target}/permission-overrides`).set(bearer(superAdmin))
          .send({ permission: 'students.viewProfile', effect: 'GRANT', reason: 'Trying a grant' }))).toEqual([400, 'OVERRIDE_NOT_ALLOWED']);
      }
      await settle();
      expect(await outbox({ type: 'permissions.granted' })).toHaveLength(before);
      expect(send).not.toHaveBeenCalled();
    });

    it('several grants saved in ONE action → one notice listing all; Coach and Head Coach recipients; nothing for STUDENT / ADMIN (service, real database)', async () => {
      // No HTTP route grants several permissions at once, or anything to a Coach, today (override policy:
      // Teachers only, one per request); the service the routes call is exercised directly here.
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const mk = (username: string, role: 'MENTOR' | 'HEAD_COACH' | 'STUDENT' | 'ADMIN') => p().user.create({ data: {
        username, firstName: username === 'dn.coach2' ? 'Chloe' : 'Other', lastName: 'X', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(),
        ...(role === 'STUDENT' && { gradeLevel: 'S2' as const, divisionId: ctx.ids.junior }),
      } });
      const grantAll = (user: { id: string; role: string; email: string; firstName: string; isActive: boolean; activatedAt: Date | null }) =>
        p().$transaction(async (tx) => {
          const rows = [];
          for (const permission of ['students.viewProgress', 'students.viewProfile']) {
            rows.push(await tx.userPermissionOverride.create({ data: { userId: user.id, permission, effect: 'GRANT', reason: 'Batch', createdById: ctx.ids.admin } }));
          }
          return notices.enqueuePermissionsGranted(tx, user, rows);
        });
      const coachUser = await mk('dn.coach2', 'MENTOR');
      const id = await grantAll(coachUser);
      notices.dispatchAfterCommit([id]);
      await settle();
      const rows = await outbox({ type: 'permissions.granted', recipientUserId: coachUser.id });
      expect(rows).toHaveLength(1);
      const [mail] = mailsTo('dn.coach2@test.local');
      expect(mail.subject).toBe('You have been given new permissions');
      expect(mail.text).toContain('Dear Chloe,');
      expect(mail.text).toContain('• View student profiles:');
      expect(mail.text).toContain('• View student progress:');
      expect(await p().notification.count({ where: { userId: coachUser.id, type: 'permissions.granted' } })).toBe(1);

      expect(await grantAll(await mk('dn.head', 'HEAD_COACH'))).not.toBeNull();
      expect(await grantAll(await mk('dn.student', 'STUDENT'))).toBeNull();
      expect(await grantAll(await mk('dn.admin', 'ADMIN'))).toBeNull();
    });
  });

  // ─── school.request.verified (student "not listed" claim) ──────────────────

  describe('student school claims', () => {
    const ME = '/api/v1/me/school-affiliation';
    let seq = 0;
    const mkStudent = async (firstName: string) => {
      const username = `dn.s${++seq}`;
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const u = await p().user.create({ data: {
        username, firstName, lastName: 'Student', email: `${username}@test.local`, role: 'STUDENT', passwordHash: hash, dateOfBirth: new Date('2010-05-01T00:00:00Z'), 
        activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior,
      } });
      await p().studentEnrollment.create({ data: { studentId: u.id, academicYearId: ctx.ids.year, gradeLevel: 'S2', divisionId: ctx.ids.junior } });
      return { id: u.id, email: u.email, token: await login(ctx, username) };
    };
    const currentClaim = async (studentId: string) => p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId, supersededAt: null } });
    const notListed = { schoolName: 'Ecole Secondaire Rugero', country: 'RW', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Tumba' };

    it('version B for a student: a school WITHOUT an official code → "verified by the Foundation" (never the directory), the sign-in link, and the matching in-app text', async () => {
      const s = await mkStudent('Bella');
      await http().post(ME).set(bearer(s.token)).send({ ...notListed, schoolName: 'Ecole Bella Hill' }).expect(201);
      const nameOnly = await currentClaim(s.id);
      const school = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({
        name: 'Ecole Bella Hill', province: 'Southern Province', district: 'Huye', sector: 'Tumba', location: 'Huye',
      }).expect(201)).body.id as string;
      await http().post(`${AFFILIATIONS}/${nameOnly.id}/match`).set(bearer(admin)).send({ schoolId: school }).expect(200);
      const matched = await currentClaim(s.id);
      await http().post(`${AFFILIATIONS}/${matched.id}/verify`).set(bearer(admin)).send({}).expect(200);
      await settle();
      const rows = await outbox({ recipientUserId: s.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toEqual({ schoolName: 'Ecole Bella Hill', officialDirectory: false, audience: 'STUDENT' });
      const mails = mailsTo(s.email);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(SCHOOL_SUBJECT);
      expect(mails[0].text).toContain('We are pleased to inform you that your school, Ecole Bella Hill, has been successfully verified by the Rwanda Olympiad Foundation.');
      expect(mails[0].text).not.toMatch(/official school directory|added to/);
      expect(mails[0].text).toContain('You can sign in to your ROF LMS account to continue your Olympiad journey:\n\nSign in to ROF LMS: http://localhost:5173/login');
      expect(mails[0].text.match(/^Rwanda Olympiad Foundation$/gm)).toHaveLength(1);
      const inApp = await p().notification.findFirstOrThrow({ where: { userId: s.id, type: 'school.request.verified' } });
      expect(inApp.body).toBe('Your school, Ecole Bella Hill, has been verified by the Rwanda Olympiad Foundation.');
    });

    it('"not listed" claim → match → verify: exactly one e-mail (first name, official name, owner text) and one in-app notification; repeats add nothing', async () => {
      const s = await mkStudent('Diane');
      await http().post(ME).set(bearer(s.token)).send(notListed).expect(201);
      const nameOnly = await currentClaim(s.id);
      expect(nameOnly).toMatchObject({ schoolId: null, claimedName: 'Ecole Secondaire Rugero', status: 'PENDING' });
      const school = await createSchool('ES Rugero Official');
      await http().post(`${AFFILIATIONS}/${nameOnly.id}/match`).set(bearer(admin)).send({ schoolId: school }).expect(200);
      await settle();
      expect(await outbox({ recipientUserId: s.id })).toHaveLength(0);   // matching alone notifies nobody
      const matched = await currentClaim(s.id);
      const res = await http().post(`${AFFILIATIONS}/${matched.id}/verify`).set(bearer(admin)).send({}).expect(200);
      expect(res.body).toMatchObject({ id: matched.id, status: 'VERIFIED' });
      await settle();

      const rows = await outbox({ recipientUserId: s.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'school.request.verified', dedupeKey: `school.request.verified:student:${s.id}:school:${school}`, recipientEmail: s.email,
        firstName: 'Diane', entityType: 'StudentSchoolAffiliation', entityId: matched.id, status: 'SENT',
      });
      const inApp = await p().notification.findMany({ where: { userId: s.id, type: 'school.request.verified' } });
      expect(inApp).toHaveLength(1);
      expect(inApp[0].id).toBe(rows[0].inAppNotificationId);
      expect(inApp[0].body).toContain('ES Rugero Official');
      const mails = mailsTo(s.email);
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(SCHOOL_SUBJECT);
      expect(mails[0].text).toContain('Dear Diane,');
      expect(mails[0].text).toContain('your school, ES Rugero Official, has been successfully verified');
      // Owner decisions 2026-11-14: students get the sign-in sentence and a link to APP_URL/login; no duplicate signature.
      expect(mails[0].text).toContain('You can sign in to your ROF LMS account to continue your Olympiad journey:');
      expect(mails[0].text).toContain('Sign in to ROF LMS: http://localhost:5173/login');
      expect(mails[0].html).toContain('Sign in to ROF LMS');
      expect(mails[0].text.match(/^Rwanda Olympiad Foundation$/gm)).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ audience: 'STUDENT' });
      // In-app matches the e-mail version (A for a coded school, B without a code).
      const coded = (await p().school.findUniqueOrThrow({ where: { id: school } })).code !== null;
      expect(inApp[0].body).toContain(coded ? "added to the Rwanda Olympiad Foundation's official school directory" : 'has been verified by the Rwanda Olympiad Foundation.');
      expect(mails[0].text.includes('official school directory')).toBe(coded);

      // Re-verify (409), re-dispatch and a repeated enqueue: still one row, one in-app notification, one e-mail.
      expect(await status(http().post(`${AFFILIATIONS}/${matched.id}/verify`).set(bearer(admin)).send({}))).toEqual([409, 'AFFILIATION_STATUS_CONFLICT']);
      expect(await notices.dispatch(rows[0].id)).toBe('SKIPPED');
      expect(await p().$transaction((tx) => notices.enqueue(tx, {
        type: 'school.request.verified', dedupeKey: rows[0].dedupeKey,
        recipient: { userId: s.id, email: s.email, firstName: 'Diane' }, entity: { type: 'StudentSchoolAffiliation', id: matched.id }, payload: { schoolName: 'x' },
      }))).toBeNull();
      await settle();
      expect(await outbox({ recipientUserId: s.id })).toHaveLength(1);
      expect(await p().notification.count({ where: { userId: s.id, type: 'school.request.verified' } })).toBe(1);
      expect(mailsTo(s.email)).toHaveLength(1);

      // Revoking later notifies nobody.
      await http().post(`${AFFILIATIONS}/${matched.id}/revoke`).set(bearer(admin)).send({ reason: 'Left the school' }).expect(200);
      await settle();
      expect(await outbox({ recipientUserId: s.id })).toHaveLength(1);

      // Regression (browser verification): revoke → reopen (a NEW claim row) → verify again for the SAME school
      // must not tell the student a second time that their school was added to the directory.
      await http().post(`${AFFILIATIONS}/${matched.id}/reopen`).set(bearer(admin)).send({ reason: 'Back at this school' }).expect((r) => {
        if (r.status !== 200 && r.status !== 201) throw new Error(`reopen ${r.status} ${JSON.stringify(r.body)}`);
      });
      const reopened = await currentClaim(s.id);
      expect(reopened.id).not.toBe(matched.id);
      expect(reopened).toMatchObject({ schoolId: school, status: 'PENDING' });
      await http().post(`${AFFILIATIONS}/${reopened.id}/verify`).set(bearer(admin)).send({}).expect(200);
      await settle();
      expect(await outbox({ recipientUserId: s.id })).toHaveLength(1);
      expect(await p().notification.count({ where: { userId: s.id, type: 'school.request.verified' } })).toBe(1);
      expect(mailsTo(s.email)).toHaveLength(1);
    });

    it('an ordinary claim of a listed school: verified exactly as before, no school-verified notification', async () => {
      const s = await mkStudent('Olivier');
      await http().post(ME).set(bearer(s.token)).send({ schoolCode: '220001' }).expect(201);
      const claim = await currentClaim(s.id);
      expect(claim).toMatchObject({ schoolId: ngoma, claimedName: null });
      const res = await http().post(`${AFFILIATIONS}/${claim.id}/verify`).set(bearer(admin)).send({}).expect(200);
      expect(res.body).toMatchObject({ id: claim.id, status: 'VERIFIED', school: { id: ngoma } });
      await settle();
      expect(await outbox({ recipientUserId: s.id })).toHaveLength(0);
      expect(await p().notification.count({ where: { userId: s.id, type: 'school.request.verified' } })).toBe(0);
      expect(mailsTo(s.email)).toHaveLength(0);
    });

    it('a rejected "not listed" claim: no notification', async () => {
      const s = await mkStudent('Rita');
      await http().post(ME).set(bearer(s.token)).send({ ...notListed, schoolName: 'Unknown Academy' }).expect(201);
      const claim = await currentClaim(s.id);
      await http().post(`${AFFILIATIONS}/${claim.id}/reject`).set(bearer(admin)).send({ reason: 'No such school' }).expect(200);
      await settle();
      expect(await outbox({ recipientUserId: s.id })).toHaveLength(0);
      expect(mailsTo(s.email)).toHaveLength(0);
    });
  });

  // ─── Reliability: failures, retries, races ─────────────────────────────────

  describe('reliability', () => {
    it('a failing mailer never fails the admin action: 200 and committed, row FAILED (sanitised); the sweep sends it exactly once', async () => {
      const id = await register(application({ firstName: 'Faith', username: 'dn.faith', email: 'dn.faith@test.local' }));
      send.mockRejectedValueOnce(new Error('connect ECONNREFUSED for dn.faith@test.local with key re_live_SECRET'));
      const res = await approve(id).expect(200);
      await settle();
      expect(await p().user.count({ where: { id: res.body.teacher.id } })).toBe(1);
      expect((await p().teacherApplication.findUniqueOrThrow({ where: { id } })).status).toBe('APPROVED');
      const [row] = await outbox({ entityId: id });
      expect(row).toMatchObject({ status: 'FAILED', attempts: 1, sentAt: null });
      expect(row.lastError).toContain('ECONNREFUSED');
      expect(row.lastError).not.toMatch(/dn\.faith@test\.local|re_live_SECRET/);
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      // The in-app notification committed with the approval.
      expect(await p().notification.count({ where: { userId: res.body.teacher.id, type: 'teacher.application.approved' } })).toBe(1);

      send.mockClear();
      await notices.sweep(new Date());   // not due yet
      expect(mailsTo('dn.faith@test.local')).toHaveLength(0);
      const later = new Date(Date.now() + 61_000);
      await notices.sweep(later);
      await notices.sweep(later);
      expect(mailsTo('dn.faith@test.local')).toHaveLength(1);
      expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SENT', attempts: 2, lastError: null, nextAttemptAt: null });
    });

    it('the sweep recovers a row stuck in SENDING past its lease (a sender that crashed after claiming it)', async () => {
      const id = await p().$transaction((tx) => notices.enqueue(tx, {
        type: 'school.request.verified', dedupeKey: `test:stuck:${randomUUID()}`,
        recipient: { userId: null, email: 'dn.stuck@test.local', firstName: 'Stu' }, entity: { type: 'Test', id: randomUUID() }, payload: { schoolName: 'GS Stuck' },
      }));
      // As left by a crash: claimed (SENDING, one attempt), lease expired, nothing sent.
      await p().notificationOutbox.update({ where: { id: id! }, data: { status: 'SENDING', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) } });
      expect(await notices.dispatch(id!)).toBe('SKIPPED');   // a SENDING row is never sent by a second dispatcher
      const result = await notices.sweep(new Date());
      expect(result.recovered).toBe(1);
      expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: id! } })).toMatchObject({ status: 'SENT', attempts: 2 });
      expect(mailsTo('dn.stuck@test.local')).toHaveLength(1);
    });

    it('two concurrent dispatches of one row send once', async () => {
      const id = await p().$transaction((tx) => notices.enqueue(tx, {
        type: 'school.request.verified', dedupeKey: `test:race:${randomUUID()}`,
        recipient: { userId: null, email: 'dn.race@test.local', firstName: 'Rae' }, entity: { type: 'Test', id: randomUUID() }, payload: { schoolName: 'GS Race' },
      }));
      const results = await Promise.all([notices.dispatch(id!), notices.dispatch(id!), notices.dispatch(id!)]);
      expect(results.filter((r) => r === 'SENT')).toHaveLength(1);
      expect(results.filter((r) => r === 'SKIPPED')).toHaveLength(2);
      expect(mailsTo('dn.race@test.local')).toHaveLength(1);
    });
  });

  // ─── Delivery log (email.bulkSend) ─────────────────────────────────────────

  describe('delivery log', () => {
    let failedId: string;
    beforeAll(async () => {
      const id = await register(application({ username: 'dn.log', email: 'dn.log@test.local' }));
      send.mockResolvedValueOnce({ accepted: false, messageId: null, error: 'Resend 500 internal_server_error: Oops', permanent: false });
      await approve(id).expect(200);
      await settle();
      failedId = (await outbox({ entityId: id }))[0].id;
    });

    it('only email.bulkSend holders (Administrators, Super Admins); others 403, anonymous 401', async () => {
      for (const token of [coach, student]) {
        expect(await status(http().get(DELIVERIES).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await status(http().post(`${DELIVERIES}/${failedId}/retry`).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
      }
      expect((await http().get(DELIVERIES)).status).toBe(401);
      await http().get(DELIVERIES).set(bearer(superAdmin)).expect(200);
    });

    it('lists rows (filtered, paginated) without the payload', async () => {
      const page = (await http().get(DELIVERIES).query({ status: 'FAILED', limit: 100 }).set(bearer(admin)).expect(200)).body;
      expect(page.meta).toMatchObject({ page: 1, limit: 100 });
      const row = page.data.find((r: any) => r.id === failedId);
      expect(Object.keys(row).sort()).toEqual([
        'attempts', 'createdAt', 'entityId', 'entityType', 'id', 'lastError', 'nextAttemptAt', 'recipientEmail', 'recipientUserId', 'sentAt', 'status', 'type',
      ]);
      expect(row).toMatchObject({ type: 'teacher.application.approved', status: 'FAILED', attempts: 1 });
      expect(page.data.every((r: any) => r.status === 'FAILED')).toBe(true);
      const byType = (await http().get(DELIVERIES).query({ type: 'coach.application.approved' }).set(bearer(admin)).expect(200)).body;
      expect(byType.data.length).toBeGreaterThan(0);
      expect(byType.data.every((r: any) => r.type === 'coach.application.approved')).toBe(true);
      expect(JSON.stringify(byType)).not.toContain('payload');
      expect(await status(http().get(DELIVERIES).query({ status: 'LOST' }).set(bearer(admin)))).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('retry re-queues a FAILED row and sends it; SENT and SENDING rows → 409; unknown → 404', async () => {
      send.mockClear();
      const res = await http().post(`${DELIVERIES}/${failedId}/retry`).set(bearer(admin)).expect(200);
      expect(res.body).toMatchObject({ id: failedId, status: 'PENDING' });
      await settle();
      expect(await p().notificationOutbox.findUniqueOrThrow({ where: { id: failedId } })).toMatchObject({ status: 'SENT', attempts: 2 });
      expect(mailsTo('dn.log@test.local')).toHaveLength(1);
      expect(await p().auditLog.count({ where: { action: 'RETRY_NOTIFICATION_DELIVERY', entityId: failedId } })).toBe(1);

      expect(await status(http().post(`${DELIVERIES}/${failedId}/retry`).set(bearer(admin)))).toEqual([409, 'NOTIFICATION_ALREADY_SENT']);
      await p().notificationOutbox.update({ where: { id: failedId }, data: { status: 'SENDING' } });
      expect(await status(http().post(`${DELIVERIES}/${failedId}/retry`).set(bearer(admin)))).toEqual([409, 'NOTIFICATION_SENDING']);
      await p().notificationOutbox.update({ where: { id: failedId }, data: { status: 'SENT' } });
      expect(await status(http().post(`${DELIVERIES}/${randomUUID()}/retry`).set(bearer(admin)))).toEqual([404, 'NOT_FOUND']);
      await settle();
      expect(mailsTo('dn.log@test.local')).toHaveLength(1);
    });
  });
});
