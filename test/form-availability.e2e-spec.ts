/**
 * Form availability (2026-11-15): the public view, the administrators' management, enforcement on every form that
 * exists (student and teacher registration, coach applications, the contact form), schedules, the old switches
 * (registration.studentSelfSignup / teacherSelfSignup) as views of the forms, the migration's carry-over, audit rows,
 * and that closing a form never affects sign-in, existing accounts or approvals.
 * Runs on its own freshly reset test database (never production).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

const STUDENT_DEFAULT = 'Student registration is currently closed. Please contact the Rwanda Olympiad Foundation for further information or check back later.';

describe('Form availability', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const availability = (key: string, body: Record<string, unknown>, token = admin) =>
    http().patch(`/api/v1/admin/forms/${key}/availability`).set(bearer(token)).send(body);
  const messages = (key: string, body: Record<string, unknown>, token = admin) =>
    http().patch(`/api/v1/admin/forms/${key}/messages`).set(bearer(token)).send(body);
  let n = 0;
  const registerStudent = (extra: Record<string, unknown> = {}) => {
    n++;
    return http().post('/api/v1/auth/register/student').send({
      firstName: 'Ada', lastName: 'Uwase', username: `form.student${n}`, email: `form.student${n}@example.com`,
      password: 'Secret123', gradeLevel: 'S4', schoolName: 'Some School', schoolLocation: 'Kigali', homeLocation: 'Kigali', ...extra,
    });
  };
  const applyCoach = () => {
    n++;
    return http().post('/api/v1/mentor-requests').send({ firstName: 'Marie', lastName: 'Coach', username: `form.coach${n}`, email: `form.coach${n}@example.com`, password: 'Mentor123' });
  };
  const contact = () => {
    n++;
    return http().post('/api/v1/public/contact').send({ fullName: 'Visitor', email: `visitor${n}@example.org`, subject: `Question ${n}`, message: `Hello, a question number ${n}.` });
  };
  const teacherBody = () => {
    n++;
    return {
      firstName: 'Tea', lastName: 'Cher', username: `form.teacher${n}`, email: `form.teacher${n}@test.local`, password: 'Secret123', confirmPassword: 'Secret123',
      country: 'RW', phone: '0788123456', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Nowhere Province', schoolDistrict: 'Nowhere',
      proposedSchoolName: 'GS Somewhere', schoolSector: 'Nowhere', homeDistrict: 'Nowhere', homeSector: 'Nowhere',
    };
  };
  async function makeUser(username: string, role: 'TEACHER' | 'HEAD_COACH') {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    await p().user.create({ data: { username, firstName: username, lastName: 'X', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
  }

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

  describe('public view and permissions', () => {
    it('GET /forms is public: every existing form, its state and messages, never who changed it', async () => {
      const res = await http().get('/api/v1/forms').expect(200);
      expect(res.body.map((f: { key: string; state: string; open: boolean }) => [f.key, f.state, f.open])).toEqual([
        ['STUDENT_REGISTRATION', 'OPEN', true], ['TEACHER_REGISTRATION', 'CLOSED', false],
        ['COACH_APPLICATION', 'OPEN', true], ['CONTACT', 'OPEN', true],
      ]);
      const student = res.body[0];
      expect(Object.keys(student).sort()).toEqual(['closedMessage', 'closesAt', 'contactEmail', 'instructions', 'key', 'label', 'open', 'opensAt', 'serverTime', 'state', 'supportUrl', 'timezone']);
      expect(student).toMatchObject({ closedMessage: STUDENT_DEFAULT, timezone: 'Africa/Kigali', opensAt: null, closesAt: null });
      expect((await http().get('/api/v1/forms/COACH_APPLICATION').expect(200)).body.key).toBe('COACH_APPLICATION');
      expect((await http().get('/api/v1/forms/COMPETITION_REGISTRATION').expect(404)).body.code).toBe('FORM_NOT_FOUND');
    });

    it('administrators manage; anonymous, students, coaches, teachers and head coaches cannot', async () => {
      await makeUser('form.teacher', 'TEACHER');
      await makeUser('form.head', 'HEAD_COACH');
      const tokens = [await login(ctx, 'student.j'), await login(ctx, 'mentor.j'), await login(ctx, 'form.teacher'), await login(ctx, 'form.head')];
      await http().get('/api/v1/admin/forms').expect(401);
      await http().patch('/api/v1/admin/forms/STUDENT_REGISTRATION/availability').send({ mode: 'CLOSED' }).expect(401);
      for (const t of tokens) {
        await http().get('/api/v1/admin/forms').set(bearer(t)).expect(403);
        await http().get('/api/v1/admin/forms/STUDENT_REGISTRATION/history').set(bearer(t)).expect(403);
        await availability('STUDENT_REGISTRATION', { mode: 'CLOSED' }, t).expect(403);
        await messages('STUDENT_REGISTRATION', { closedMessage: 'x' }, t).expect(403);
      }
      const list = (await http().get('/api/v1/admin/forms').set(bearer(admin)).expect(200)).body;
      expect(list).toHaveLength(4);
      expect(list[0]).toMatchObject({ key: 'STUDENT_REGISTRATION', mode: 'OPEN', closedMessageCustom: null, closedMessageDefault: STUDENT_DEFAULT });
      expect(list[1]).toMatchObject({ key: 'TEACHER_REGISTRATION', requiresTeacherRole: true, teacherRoleEnabled: true });
      expect(await p().formAvailability.count()).toBe(0);   // nothing written: refused calls and reads create no row
      const perms = (await http().get('/api/v1/me/permissions').set(bearer(admin)).expect(200)).body.permissions;
      expect(perms).toEqual(expect.arrayContaining(['forms.view', 'forms.manageAvailability', 'forms.editMessages']));
    });

    it('validation: SCHEDULED needs opensAt; closesAt after opensAt; e-mail and https link checked; nothing saved on refusal', async () => {
      expect((await availability('CONTACT', { mode: 'SCHEDULED' }).expect(400)).body.code).toBe('INVALID_FORM_SCHEDULE');
      expect((await availability('CONTACT', { mode: 'SCHEDULED', opensAt: '2030-01-02T00:00:00Z', closesAt: '2030-01-01T00:00:00Z' }).expect(400)).body.code).toBe('INVALID_FORM_SCHEDULE');
      expect((await availability('CONTACT', { mode: 'SOMETIMES' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
      expect((await availability('CONTACT', { opensAt: 'tomorrow' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
      expect((await availability('CONTACT', {}).expect(400)).body.code).toBe('NO_CHANGES');
      expect((await messages('CONTACT', { contactEmail: 'not-an-email' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
      expect((await messages('CONTACT', { supportUrl: 'http://example.org/help' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
      expect(await p().auditLog.count({ where: { entity: 'FormAvailability' } })).toBe(0);
    });
  });

  describe('enforcement', () => {
    it('student registration: closed → 403 REGISTRATION_CLOSED with the form details; custom message; reopened → 201', async () => {
      const closed = await availability('STUDENT_REGISTRATION', { mode: 'CLOSED' }).expect(200);
      expect(closed.body).toMatchObject({ key: 'STUDENT_REGISTRATION', mode: 'CLOSED', state: 'CLOSED', open: false });
      const refused = await registerStudent().expect(403);
      expect(refused.body).toMatchObject({
        code: 'REGISTRATION_CLOSED', message: STUDENT_DEFAULT,
        details: { form: 'STUDENT_REGISTRATION', state: 'CLOSED', closedMessage: STUDENT_DEFAULT, contactEmail: null, supportUrl: null, opensAt: null },
      });
      await messages('STUDENT_REGISTRATION', {
        closedMessage: 'Registration reopens in January.', contactEmail: 'info@rwandaolympiadfoundation.org', supportUrl: 'https://rwandaolympiadfoundation.org/contact',
        instructions: 'Ask your school coordinator first.',
      }).expect(200);
      const custom = await registerStudent().expect(403);
      expect(custom.body).toMatchObject({ message: 'Registration reopens in January.', details: { contactEmail: 'info@rwandaolympiadfoundation.org', supportUrl: 'https://rwandaolympiadfoundation.org/contact' } });
      expect((await http().get('/api/v1/forms/STUDENT_REGISTRATION').expect(200)).body).toMatchObject({ open: false, closedMessage: 'Registration reopens in January.', instructions: 'Ask your school coordinator first.' });
      // "" restores the built-in message.
      expect((await messages('STUDENT_REGISTRATION', { closedMessage: '' }).expect(200)).body).toMatchObject({ closedMessage: STUDENT_DEFAULT, closedMessageCustom: null });
      expect(await p().user.count({ where: { username: { startsWith: 'form.student' } } })).toBe(0);
      await availability('STUDENT_REGISTRATION', { mode: 'OPEN' }).expect(200);
      await registerStudent().expect(201);
    });

    it('closing student registration never affects sign-in or existing students', async () => {
      await availability('STUDENT_REGISTRATION', { mode: 'CLOSED' }).expect(200);
      const student = await login(ctx, 'student.j');
      await http().get('/api/v1/me').set(bearer(student)).expect(200);
      await http().post('/api/v1/auth/login').send({ username: 'student.s', password: PASSWORD }).expect(200);
      await availability('STUDENT_REGISTRATION', { mode: 'OPEN' }).expect(200);
    });

    it('teacher registration: closed (initially) → 403 REGISTRATION_CLOSED with details; open → no longer refused as closed', async () => {
      expect((await http().get('/api/v1/auth/register/teacher/availability').expect(200)).body).toEqual({ open: false });
      const refused = await http().post('/api/v1/auth/register/teacher').send(teacherBody()).expect(403);
      expect(refused.body).toMatchObject({ code: 'REGISTRATION_CLOSED', details: { form: 'TEACHER_REGISTRATION', state: 'CLOSED' } });
      await availability('TEACHER_REGISTRATION', { mode: 'OPEN' }).expect(200);
      expect((await http().get('/api/v1/auth/register/teacher/availability').expect(200)).body).toEqual({ open: true });
      const accepted = await http().post('/api/v1/auth/register/teacher').send(teacherBody());
      expect(accepted.status).not.toBe(403);   // past the availability check (the made-up place is then refused)
      await availability('TEACHER_REGISTRATION', { mode: 'CLOSED' }).expect(200);
    });

    it('coach applications: closed → 403 FORM_CLOSED; a pending application is still approved; reopened → 201', async () => {
      const pending = await applyCoach().expect(201);
      await availability('COACH_APPLICATION', { mode: 'CLOSED' }).expect(200);
      const refused = await applyCoach().expect(403);
      expect(refused.body).toMatchObject({ code: 'FORM_CLOSED', details: { form: 'COACH_APPLICATION', state: 'CLOSED' } });
      await http().patch(`/api/v1/mentor-requests/${pending.body.id}/approve`).set(bearer(admin)).expect(200);   // approvals unaffected
      await availability('COACH_APPLICATION', { mode: 'OPEN' }).expect(200);
      await applyCoach().expect(201);
    });

    it('contact form: closed → 403 FORM_CLOSED; reopened → 201', async () => {
      await availability('CONTACT', { mode: 'CLOSED' }).expect(200);
      expect((await contact().expect(403)).body).toMatchObject({ code: 'FORM_CLOSED', details: { form: 'CONTACT' } });
      await availability('CONTACT', { mode: 'OPEN' }).expect(200);
      await contact().expect(201);
    });
  });

  describe('schedules', () => {
    it('SCHEDULED: NOT_YET_OPEN (with the Kigali opening time) → OPEN → ENDED, as time passes', async () => {
      const opensAt = new Date(Date.now() + 2_000);
      const closesAt = new Date(Date.now() + 5_000);
      const set = await availability('COACH_APPLICATION', { mode: 'SCHEDULED', opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() }).expect(200);
      expect(set.body).toMatchObject({ mode: 'SCHEDULED', state: 'NOT_YET_OPEN', open: false, opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() });
      const early = await applyCoach().expect(403);
      expect(early.body.details).toMatchObject({ state: 'NOT_YET_OPEN', opensAt: opensAt.toISOString() });
      expect(early.body.message).toMatch(/It opens on .+ \(Kigali time\)\.$/);
      await sleep(Math.max(0, opensAt.getTime() - Date.now()) + 300);
      expect((await http().get('/api/v1/forms/COACH_APPLICATION').expect(200)).body).toMatchObject({ state: 'OPEN', open: true });
      await applyCoach().expect(201);
      await sleep(Math.max(0, closesAt.getTime() - Date.now()) + 300);
      expect((await http().get('/api/v1/forms/COACH_APPLICATION').expect(200)).body).toMatchObject({ state: 'ENDED', open: false });
      expect((await applyCoach().expect(403)).body.details.state).toBe('ENDED');
    }, 20_000);

    it('editing or removing a date takes effect at once (OPEN with a past closesAt is ENDED; removing it reopens)', async () => {
      await availability('COACH_APPLICATION', { mode: 'OPEN', closesAt: new Date(Date.now() - 60_000).toISOString() }).expect(200);
      expect((await http().get('/api/v1/forms/COACH_APPLICATION').expect(200)).body.state).toBe('ENDED');
      await availability('COACH_APPLICATION', { closesAt: null }).expect(200);
      expect((await http().get('/api/v1/forms/COACH_APPLICATION').expect(200)).body.state).toBe('OPEN');
      await applyCoach().expect(201);
    });
  });

  describe('the old switches are views of the forms (one source of truth)', () => {
    it('PATCH /admin/settings registration.studentSelfSignup / teacherSelfSignup changes the forms; GET reports the forms', async () => {
      const get = async () => Object.fromEntries((await http().get('/api/v1/admin/settings').set(bearer(admin)).expect(200)).body
        .filter((s: { key: string }) => s.key.endsWith('SelfSignup')).map((s: { key: string; value: unknown }) => [s.key, s.value]));
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.studentSelfSignup': false, 'registration.teacherSelfSignup': true }).expect(200);
      expect(await p().formAvailability.findUnique({ where: { key: 'STUDENT_REGISTRATION' } })).toMatchObject({ mode: 'CLOSED' });
      expect(await p().formAvailability.findUnique({ where: { key: 'TEACHER_REGISTRATION' } })).toMatchObject({ mode: 'OPEN', closesAt: null });
      expect(await get()).toEqual({ 'registration.studentSelfSignup': false, 'registration.teacherSelfSignup': true });
      expect((await registerStudent().expect(403)).body.code).toBe('REGISTRATION_CLOSED');
      // A form closed on the forms page reads as false; the SystemSetting rows are not used.
      await availability('TEACHER_REGISTRATION', { mode: 'CLOSED' }).expect(200);
      expect((await get())['registration.teacherSelfSignup']).toBe(false);
      expect(await p().systemSetting.count({ where: { key: { in: ['registration.studentSelfSignup', 'registration.teacherSelfSignup'] } } })).toBe(0);
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.studentSelfSignup': true }).expect(200);
      await registerStudent().expect(201);
      const viaSetting = await p().auditLog.findFirst({ where: { action: 'FORM_AVAILABILITY_CHANGED', entityId: 'STUDENT_REGISTRATION', metadata: { path: ['via'], equals: 'setting' } } });
      expect(viaSetting).not.toBeNull();
    });
  });

  describe('audit and history', () => {
    it('every change is one audit row (before/after per field, actor, request id); history lists them newest first', async () => {
      const before = await p().auditLog.count({ where: { entityId: 'CONTACT', entity: 'FormAvailability' } });
      await http().patch('/api/v1/admin/forms/CONTACT/availability').set(bearer(admin)).set('X-Request-Id', 'form-req-1')
        .send({ mode: 'SCHEDULED', opensAt: '2030-01-01T06:00:00Z', closesAt: null }).expect(200);
      await http().patch('/api/v1/admin/forms/CONTACT/messages').set(bearer(admin)).set('X-Request-Id', 'form-req-2')
        .send({ instructions: 'Use the form for questions only.' }).expect(200);
      await messages('CONTACT', { instructions: 'Use the form for questions only.' }).expect(200);   // no change → no row
      const rows = await p().auditLog.findMany({ where: { entityId: 'CONTACT', entity: 'FormAvailability' }, orderBy: { createdAt: 'asc' } });
      expect(rows).toHaveLength(before + 2);
      const [sched, msg] = rows.slice(-2);
      expect(sched).toMatchObject({
        action: 'FORM_AVAILABILITY_CHANGED', actorRole: 'ADMIN', actorId: ctx.ids.admin,
        metadata: { form: 'CONTACT', via: 'admin', requestId: 'form-req-1', stateBefore: 'OPEN', stateAfter: 'NOT_YET_OPEN',
          changes: { mode: { from: 'OPEN', to: 'SCHEDULED' }, opensAt: { from: null, to: '2030-01-01T06:00:00.000Z' } } },
      });
      expect(msg).toMatchObject({ action: 'FORM_MESSAGES_CHANGED', metadata: { requestId: 'form-req-2', changes: { instructions: { from: null, to: 'Use the form for questions only.' } } } });
      const history = (await http().get('/api/v1/admin/forms/CONTACT/history').set(bearer(admin)).expect(200)).body;
      expect(history[0]).toMatchObject({ action: 'FORM_MESSAGES_CHANGED', actorUsername: 'admin' });
      expect(history[1]).toMatchObject({ action: 'FORM_AVAILABILITY_CHANGED' });
      const view = (await http().get('/api/v1/admin/forms/CONTACT').set(bearer(admin)).expect(200)).body;
      expect(view).toMatchObject({ state: 'NOT_YET_OPEN', updatedBy: { username: 'admin' } });
      await availability('CONTACT', { mode: 'OPEN', opensAt: null }).expect(200);
    });
  });

  describe('migration 20261208000000_form_availability: the existing switches are carried over', () => {
    const dataStatements = () => {
      const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261208000000_form_availability', 'migration.sql'), 'utf8');
      return sql.slice(sql.indexOf('-- Data:')).split(/;\s*\n/).map((s) => s.replace(/^--.*$/gm, '').trim()).filter(Boolean);
    };
    const modes = async () => Object.fromEntries((await p().formAvailability.findMany()).map((r) => [r.key, r.mode]));

    it.each([
      ['no stored switches (defaults)', {}, { STUDENT_REGISTRATION: 'OPEN', TEACHER_REGISTRATION: 'CLOSED', COACH_APPLICATION: 'OPEN', CONTACT: 'OPEN' }],
      ['student switch off, teacher switch on', { 'registration.studentSelfSignup': false, 'registration.teacherSelfSignup': true }, { STUDENT_REGISTRATION: 'CLOSED', TEACHER_REGISTRATION: 'OPEN', COACH_APPLICATION: 'OPEN', CONTACT: 'OPEN' }],
      ['student switch on, teacher switch off', { 'registration.studentSelfSignup': true, 'registration.teacherSelfSignup': false }, { STUDENT_REGISTRATION: 'OPEN', TEACHER_REGISTRATION: 'CLOSED', COACH_APPLICATION: 'OPEN', CONTACT: 'OPEN' }],
    ])('%s', async (_, settings, expected) => {
      await p().formAvailability.deleteMany();
      await p().systemSetting.deleteMany({ where: { key: { in: ['registration.studentSelfSignup', 'registration.teacherSelfSignup'] } } });
      for (const [key, value] of Object.entries(settings)) await p().systemSetting.create({ data: { key, value } });
      for (const statement of dataStatements()) await p().$executeRawUnsafe(statement);
      expect(await modes()).toEqual(expected);
    });
  });
});
