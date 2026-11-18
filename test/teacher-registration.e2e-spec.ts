/**
 * Teacher self-registration (owner-approved): a public application reviewed by an Administrator.
 * No User, school assignment or student access before approval; approval creates the TEACHER account
 * and its TeacherSchoolAssignment; no school is ever created from an application.
 *
 * Fixtures (official directory): Southern Province / Huye / Ngoma (220001, and the inactive 220003),
 * Southern Province / Huye / Tumba (220002), Kigali City / Gasabo / Kacyiru (110001); the seed's
 * "Test School" has no code. Students: s.ngoma (verified at 220001), s.ngoma.pending (claim not
 * verified), s.kacyiru (verified at 110001).
 */
import { randomUUID } from 'node:crypto';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { createTestApp, login, bearer, type TestContext, waitForEvents } from './helpers.js';
import { Events } from '../src/notifications/events.js';

const REGISTER = '/api/v1/auth/register/teacher';
const AVAILABILITY = '/api/v1/auth/register/teacher/availability';
const ADMIN_APPS = '/api/v1/admin/teacher-applications';

const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };

describe('Teacher self-registration — TEACHERS_ENABLED off (the default)', () => {
  let ctx: TestContext;
  let admin: string;

  beforeAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('closed whether or not the setting is on; availability says so; no feature advertised; review refused', async () => {
    const http = () => ctx.http();
    const body = {
      firstName: 'Off', lastName: 'Flag', username: 'off.flag', email: 'off.flag@test.local', password: 'Secret123', confirmPassword: 'Secret123',
      country: 'RW', phone: '0788123456', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye',
      proposedSchoolName: 'GS Somewhere', schoolSector: 'Ngoma', homeDistrict: 'Huye', homeSector: 'Ngoma',
    };
    for (const setting of [false, true]) {
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': setting }).expect(200);
      expect((await http().get(AVAILABILITY).expect(200)).body).toEqual({ open: false });
      expect(await status(http().post(REGISTER).send(body))).toEqual([403, 'REGISTRATION_CLOSED']);
    }
    expect((await http().get('/api/v1').expect(200)).body.capabilities.features).not.toContain('teacherSelfRegistration');
    expect(await ctx.prisma.teacherApplication.count()).toBe(0);

    // An application that exists (e.g. submitted while the flag was on) cannot be decided while it is off.
    const app = await ctx.prisma.teacherApplication.create({ data: {
      firstName: 'A', lastName: 'B', username: 'off.pending', email: 'off.pending@test.local', passwordHash: 'x', phone: '+250788123456',
      country: 'RW', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye', homeDistrict: 'Huye', homeSector: 'Ngoma',
    } });
    expect(await status(http().get(ADMIN_APPS).set(bearer(admin)))).toEqual([403, 'TEACHERS_DISABLED']);
    expect(await status(http().post(`${ADMIN_APPS}/${app.id}/approve`).set(bearer(admin)).send({ schoolId: randomUUID() }))).toEqual([403, 'TEACHERS_DISABLED']);
    expect(await status(http().post(`${ADMIN_APPS}/${app.id}/reject`).set(bearer(admin)).send({ reason: 'No' }))).toEqual([403, 'TEACHERS_DISABLED']);
    expect(await ctx.prisma.user.count({ where: { role: 'TEACHER' } })).toBe(0);
    expect((await ctx.prisma.teacherApplication.findUniqueOrThrow({ where: { id: app.id } })).status).toBe('PENDING');
  });
});

describe('Teacher self-registration — TEACHERS_ENABLED on', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, coach: string, student: string;
  let ngoma: string, tumba: string, kacyiru: string, inactive: string, uncoded: string;
  let sNgoma: string, sNgomaPending: string, sKacyiru: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;

  let n = 0;
  /** A valid listed-school application with a fresh identity. */
  const listed = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      firstName: 'Grace', lastName: 'Teacher', username: `tr.listed${n}`, email: `tr.listed${n}@test.local`,
      password: 'Secret123', confirmPassword: 'Secret123', country: 'rw', phone: '0788 123 456',
      olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolId: ngoma,
      homeDistrict: 'Gasabo', homeSector: 'Kacyiru', ...over,
    };
  };
  const missing = (over: Record<string, unknown> = {}) => {
    const { schoolId: _drop, ...rest } = listed();
    return { ...rest, proposedSchoolName: 'GS Not Yet Listed', schoolSector: 'Tumba', ...over };
  };
  const register = (body: object) => http().post(REGISTER).send(body);
  const setOpen = (open: boolean) => http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': open }).expect(200);

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    [admin, coach, student] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));
    const official = (name: string, code: string, place: object, extra: object = {}) => p().school.create({ data: {
      name, code, nameKey: name.toLowerCase(), location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST', ...place, ...extra,
    } }).then((s) => s.id);
    const huye = (sector: string) => ({ province: 'Southern Province', district: 'Huye', sector });
    ngoma    = await official('gs ngoma official', '220001', huye('Ngoma'));
    tumba    = await official('gs tumba official', '220002', huye('Tumba'));
    inactive = await official('gs closed official', '220003', huye('Ngoma'), { isActive: false });
    kacyiru  = await official('gs kacyiru official', '110001', { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' });
    uncoded  = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;

    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'STUDENT' | 'SUPER_ADMIN', extra: object = {}) =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(), ...extra } })).id;
    const kid = (schoolId: string) => ({ gradeLevel: 'S2' as const, divisionId: ctx.ids.junior, schoolId, homeLocation: 'Huye' });
    const claim = (studentId: string, schoolId: string, verified: boolean) => p().studentSchoolAffiliation.create({ data: {
      studentId, schoolId, source: 'ADMIN', createdById: ctx.ids.admin,
      ...(verified ? { status: 'VERIFIED', decidedById: ctx.ids.admin, decidedAt: new Date() } : { status: 'PENDING' }),
    } });
    sNgoma = await mk('s.ngoma', 'STUDENT', kid(ngoma));
    await claim(sNgoma, ngoma, true);
    sNgomaPending = await mk('s.ngoma.pending', 'STUDENT', kid(ngoma));
    await claim(sNgomaPending, ngoma, false);
    sKacyiru = await mk('s.kacyiru', 'STUDENT', kid(kacyiru));
    await claim(sKacyiru, kacyiru, true);
    await mk('tr.super', 'SUPER_ADMIN');
    superAdmin = await login(ctx, 'tr.super');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  describe('availability and the switch', () => {
    it('the setting is off by default: closed; on: open; the capability is advertised while the flag is on', async () => {
      expect((await http().get(AVAILABILITY).expect(200)).body).toEqual({ open: false });
      expect(await status(register(listed()))).toEqual([403, 'REGISTRATION_CLOSED']);
      await setOpen(true);
      expect((await http().get(AVAILABILITY).expect(200)).body).toEqual({ open: true });
      expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toEqual(expect.arrayContaining(['teacherAccounts', 'teacherSelfRegistration']));
      await setOpen(false);
      expect((await http().get(AVAILABILITY).expect(200)).body).toEqual({ open: false });
      await setOpen(true);
    });
  });

  describe('registration', () => {
    beforeAll(async () => { await setOpen(true); });

    it('listed school, all three interests: PENDING, no account; school code/sector/province from the database', async () => {
      const users = await p().user.count();
      const body = listed({ olympiadInterests: ['PHYSICS', 'MATHEMATICS', 'COMPUTING'], firstName: '  Grace ' });
      const res = await register(body).expect(201);
      expect(res.body).toEqual({
        id: expect.any(String), status: 'PENDING', requiresApproval: true,
        school: { id: ngoma, name: 'gs ngoma official', code: '220001', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' },
        proposedSchoolName: null, avatarUploadToken: expect.any(String),   // the optional picture (REG-02)
      });
      expect(await p().user.count()).toBe(users);
      expect(await p().teacherSchoolAssignment.count()).toBe(0);
      const row = await p().teacherApplication.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({
        firstName: 'Grace', username: body.username, phone: '+250788123456', country: 'RW', status: 'PENDING',
        olympiadInterests: ['PHYSICS', 'MATHEMATICS', 'COMPUTING'], schoolId: ngoma, schoolSector: 'Ngoma', proposedSchoolName: null,
        homeDistrict: 'Gasabo', homeSector: 'Kacyiru', userId: null,
      });
      expect(row.passwordHash).toMatch(/^\$2/);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Secret123/);
      expect(await p().auditLog.findFirstOrThrow({ where: { action: 'SUBMIT_TEACHER_APPLICATION', entityId: res.body.id } }))
        .toMatchObject({ actorId: null, metadata: { schoolId: ngoma, missingSchool: false } });
    });

    it('one interest is enough; empty, duplicate or unknown interests are refused', async () => {
      await register(listed({ olympiadInterests: ['COMPUTING'] })).expect(201);
      for (const olympiadInterests of [[], ['MATHEMATICS', 'MATHEMATICS'], ['CHEMISTRY'], undefined]) {
        expect(await status(register(listed({ olympiadInterests })))).toEqual([400, 'VALIDATION_FAILED']);
      }
    });

    it('a school code, name or sector for a listed school is never taken from the client', async () => {
      expect(await status(register(listed({ schoolCode: '220002' })))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(register(listed({ schoolSector: 'Tumba' })))).toEqual([400, 'SCHOOL_CHOICE_REQUIRED']);
      expect(await status(register(listed({ proposedSchoolName: 'Other', schoolSector: 'Tumba' })))).toEqual([400, 'SCHOOL_CHOICE_REQUIRED']);
      const { schoolId: _s, ...none } = listed();
      expect(await status(register(none))).toEqual([400, 'SCHOOL_CHOICE_REQUIRED']);
    });

    it('missing school: PENDING with the proposed name and place; no school is created', async () => {
      const schools = await p().school.count();
      const res = await register(missing()).expect(201);
      expect(res.body).toEqual({ id: expect.any(String), status: 'PENDING', requiresApproval: true, school: null, proposedSchoolName: 'GS Not Yet Listed', avatarUploadToken: expect.any(String) });
      expect(await p().school.count()).toBe(schools);
      expect(await p().teacherApplication.findUniqueOrThrow({ where: { id: res.body.id } }))
        .toMatchObject({ schoolId: null, proposedSchoolName: 'GS Not Yet Listed', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Tumba' });
      expect(await status(register(missing({ schoolSector: undefined })))).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('a school without an official code: refused until an administrator who created it verifies it; then chosen by id, no code invented', async () => {
      const created = await http().post('/api/v1/admin/schools').set(bearer(admin))
        .send({ name: 'Ecole Teacher Hill', countryCode: 'RW', province: 'Southern Province', district: 'Huye', sector: 'Ngoma', location: 'Ngoma hill' }).expect(201);
      const hill = created.body.id as string;
      expect(created.body).toMatchObject({ code: null, source: 'ADMIN', lastVerifiedAt: null });
      const apply = (username: string) => register(listed({ schoolId: hill, username, email: `${username}@example.org` }));
      expect(await status(apply('t.hill.early'))).toEqual([400, 'UNKNOWN_SCHOOL']);
      expect((await http().get('/api/v1/schools/search').query({ q: 'Teacher Hill', teacherEligible: 'true' }).expect(200)).body).toEqual([]);

      await http().post(`/api/v1/admin/schools/${hill}/verify`).set(bearer(admin)).send({}).expect(200);
      expect((await http().get('/api/v1/schools/search').query({ q: 'Teacher Hill', teacherEligible: 'true' }).expect(200)).body.map((s: any) => [s.id, s.code]))
        .toEqual([[hill, null]]);
      expect(await status(apply('t.hill.ok'))).toEqual([201, null]);
      const app = await p().teacherApplication.findFirstOrThrow({ where: { username: 't.hill.ok' } });
      expect(app).toMatchObject({ schoolId: hill, status: 'PENDING' });
      expect((await p().school.findUniqueOrThrow({ where: { id: hill } })).code).toBeNull();
    });

    it('invalid or fabricated schools: unknown id, inactive, without a code; a school elsewhere is a location mismatch', async () => {
      for (const schoolId of [randomUUID(), inactive, uncoded]) {
        expect(await status(register(listed({ schoolId })))).toEqual([400, 'UNKNOWN_SCHOOL']);
      }
      expect(await status(register(listed({ schoolId: 'not-a-uuid' })))).toEqual([400, 'VALIDATION_FAILED']);
      // Kacyiru exists, but not in Southern Province / Huye.
      expect(await status(register(listed({ schoolId: kacyiru })))).toEqual([400, 'SCHOOL_LOCATION_MISMATCH']);
      expect(await status(register(listed({ schoolId: kacyiru, schoolProvince: 'Kigali City', schoolDistrict: 'Gasabo' })))).toEqual([201, null]);
    });

    it('invalid geography: a district of another province, a sector of another district, unknown names, a home sector outside the home district', async () => {
      expect(await status(register(listed({ schoolProvince: 'Kigali City' })))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await status(register(missing({ schoolProvince: 'Kigali City' })))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await status(register(missing({ schoolSector: 'Kacyiru' })))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await status(register(missing({ schoolDistrict: 'Atlantis' })))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await status(register(missing({ schoolSector: 'Nowhere' })))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await status(register(listed({ homeDistrict: 'Huye', homeSector: 'Kacyiru' })))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
      expect(await status(register(listed({ homeDistrict: 'Atlantis', homeSector: 'Ngoma' })))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
      expect(await status(register(listed({ homeDistrict: 'Huye', homeSector: 'Nowhere' })))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
      // The inactive school's sector still has an active school (Ngoma): a valid home.
      expect(await status(register(listed({ homeDistrict: 'Huye', homeSector: 'Ngoma' })))).toEqual([201, null]);
    });

    it('password mismatch; missing or invalid phone (E.164 stored); missing or invalid country', async () => {
      expect(await status(register(listed({ confirmPassword: 'Secret124' })))).toEqual([400, 'PASSWORD_MISMATCH']);
      expect(await status(register(listed({ confirmPassword: undefined })))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(register(listed({ phone: undefined })))).toEqual([400, 'VALIDATION_FAILED']);
      for (const phone of ['12345', 'call me', '+250 123']) expect(await status(register(listed({ phone })))).toEqual([400, 'INVALID_PHONE']);
      expect(await status(register(listed({ country: undefined })))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(register(listed({ country: 'Rwanda' })))).toEqual([400, 'VALIDATION_FAILED']);
      const ok = await register(listed({ phone: '+254 712-345-678', country: 'ke' })).expect(201);
      expect(await p().teacherApplication.findUniqueOrThrow({ where: { id: ok.body.id } })).toMatchObject({ phone: '+254712345678', country: 'KE' });
    });

    it('duplicates: a PENDING application holds its username and e-mail (409, also in the database); REJECTED does not', async () => {
      const first = listed({ username: 'dup.teacher', email: 'dup.teacher@test.local' });
      const res = await register(first).expect(201);
      expect(await status(register(listed({ username: 'dup.teacher' })))).toEqual([409, 'IDENTITY_TAKEN']);
      expect(await status(register(listed({ email: 'DUP.Teacher@test.local' })))).toEqual([409, 'IDENTITY_TAKEN']);
      // An existing user or a pending coach application blocks too.
      expect(await status(register(listed({ username: 'student.j' })))).toEqual([409, 'IDENTITY_TAKEN']);
      await http().post('/api/v1/mentor-requests').send({ firstName: 'Co', lastName: 'Ach', username: 'coach.pending', email: 'coach.pending@test.local', password: 'Secret123' }).expect(201);
      expect(await status(register(listed({ email: 'coach.pending@test.local' })))).toEqual([409, 'IDENTITY_TAKEN']);

      // The database refuses a second PENDING row even without the application check (partial unique indexes).
      const row = await p().teacherApplication.findUniqueOrThrow({ where: { id: res.body.id } });
      const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;
      await expect(p().teacherApplication.create({ data: { ...copy, email: 'other@test.local' } })).rejects.toMatchObject({ code: 'P2002' });
      await expect(p().teacherApplication.create({ data: { ...copy, username: 'other.user' } })).rejects.toMatchObject({ code: 'P2002' });

      // Student registration and coach applications treat a pending teacher application's identity as taken.
      expect(await status(http().post('/api/v1/auth/register/student').send({
        firstName: 'Stu', lastName: 'Dent', username: 'stu.dup', email: 'dup.teacher@test.local', password: 'Secret123',
        dateOfBirth: '2010-05-01', guardianPhone: '0722000111', gradeLevel: 'S2', homeLocation: 'Huye', schoolCode: '220001',
      }))).toEqual([409, 'IDENTITY_TAKEN']);
      expect(await status(http().post('/api/v1/mentor-requests').send({
        firstName: 'Co', lastName: 'Dup', username: 'dup.teacher', email: 'coach.dup@test.local', password: 'Secret123',
      }))).toEqual([409, 'IDENTITY_TAKEN']);

      // Rejected: the identity is free again, for a new application.
      await http().post(`${ADMIN_APPS}/${res.body.id}/reject`).set(bearer(admin)).send({ reason: 'Incomplete' }).expect(200);
      const again = await register(first).expect(201);
      expect(again.body.id).not.toBe(res.body.id);
      expect(await p().teacherApplication.count({ where: { username: 'dup.teacher' } })).toBe(2);
    });

    it('a new application → every active administrator, in-app only, once per application (owner decision 5)', async () => {
      const admins = (await p().user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true }, select: { id: true } })).map((a) => a.id);
      const mailsBefore = await p().emailDelivery.count();
      const one = await register(listed({ firstName: 'Notice', lastName: 'Listed' })).expect(201);
      const two = await register(missing({ firstName: 'Notice', lastName: 'Missing' })).expect(201);
      await waitForEvents();
      const whereOf = (id: string) => ({ type: 'registration.teacher_application', data: { path: ['teacherApplicationId'], equals: id } });
      for (const [id, unlisted] of [[one.body.id, false], [two.body.id, true]] as const) {
        const rows = await p().notification.findMany({ where: whereOf(id), select: { userId: true, title: true, body: true, link: true, category: true } });
        expect(rows.map((n) => n.userId).sort()).toEqual([...admins].sort());
        expect(rows[0]).toMatchObject({ category: 'ACCOUNT', title: 'New teacher application', link: '/admin/teacher-applications' });
        expect(rows[0].body).toContain('Notice ' + (unlisted ? 'Missing' : 'Listed'));
        expect(rows[0].body.includes('school not listed')).toBe(unlisted);
        expect(JSON.stringify(rows)).not.toMatch(/Secret123|passwordHash/);
      }
      // No e-mail for administrators (and no e-mail at all before a decision).
      expect(await p().emailDelivery.count()).toBe(mailsBefore);

      // Replays (a retried or duplicated event, concurrently) create nothing more.
      const emitter = ctx.app.get(EventEmitter2);
      await Promise.all([1, 2, 3].map(() => emitter.emitAsync(Events.TeacherApplicationSubmitted, { applicationId: one.body.id })));
      await waitForEvents();
      expect(await p().notification.count({ where: whereOf(one.body.id) })).toBe(admins.length);

      // A decided application is not announced (a late replay after the decision).
      await http().post(`${ADMIN_APPS}/${two.body.id}/reject`).set(bearer(admin)).send({ reason: 'Incomplete' }).expect(200);
      await p().notification.deleteMany({ where: whereOf(two.body.id) });
      await emitter.emitAsync(Events.TeacherApplicationSubmitted, { applicationId: two.body.id });
      await waitForEvents();
      expect(await p().notification.count({ where: whereOf(two.body.id) })).toBe(0);

      // The type is switchable (in-app only): an administrator who turned it off gets none for a new application.
      const settings = (await http().get('/api/v1/me/notification-settings').set(bearer(admin)).expect(200)).body.settings;
      expect(settings.find((x: any) => x.type === 'registration.teacher_application'))
        .toMatchObject({ label: 'New teacher applications', category: 'ACCOUNT', inAppEnabled: true, emailAvailable: false });
      await http().patch('/api/v1/me/notification-settings').set(bearer(admin))
        .send({ settings: [{ type: 'registration.teacher_application', inAppEnabled: false }] }).expect(200);
      const three = await register(listed({ firstName: 'Notice', lastName: 'Off' })).expect(201);
      await waitForEvents();
      const got = (await p().notification.findMany({ where: whereOf(three.body.id), select: { userId: true } })).map((n) => n.userId);
      expect(got).not.toContain(ctx.ids.admin);
      expect(got.sort()).toEqual(admins.filter((id) => id !== ctx.ids.admin).sort());
      await http().post('/api/v1/me/notification-settings/reset').set(bearer(admin)).expect(200);
    });
  });

  describe('Administrator review', () => {
    let listedId: string, missingId: string;
    const approve = (id: string, body: object = {}, token = admin) => http().post(`${ADMIN_APPS}/${id}/approve`).set(bearer(token)).send(body);
    const reject = (id: string, body: object = { reason: 'Not a teacher here' }, token = admin) => http().post(`${ADMIN_APPS}/${id}/reject`).set(bearer(token)).send(body);

    beforeAll(async () => {
      await setOpen(true);
      listedId = (await register(listed({ username: 'tr.approve', email: 'tr.approve@test.local', olympiadInterests: ['MATHEMATICS', 'PHYSICS'] })).expect(201)).body.id;
      missingId = (await register(missing({ username: 'tr.missing', email: 'tr.missing@test.local' })).expect(201)).body.id;
    });

    it('callers without users.manageTeachers are refused; anonymous 401', async () => {
      for (const token of [coach, student]) {
        expect(await status(http().get(ADMIN_APPS).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await status(http().get(`${ADMIN_APPS}/${listedId}`).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await status(approve(listedId, {}, token))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect(await status(reject(listedId, undefined, token))).toEqual([403, 'PERMISSION_REQUIRED']);
      }
      expect((await http().get(ADMIN_APPS)).status).toBe(401);
      expect((await p().teacherApplication.findUniqueOrThrow({ where: { id: listedId } })).status).toBe('PENDING');
    });

    it('list (filtered, paginated) and get: the application DTO, never the password hash', async () => {
      const page = (await http().get(ADMIN_APPS).query({ status: 'PENDING', limit: 100 }).set(bearer(admin)).expect(200)).body;
      expect(page.meta).toMatchObject({ page: 1, limit: 100, total: page.data.length });
      expect(page.data.every((a: any) => a.status === 'PENDING')).toBe(true);
      expect(page.data.map((a: any) => a.id)).toEqual(expect.arrayContaining([listedId, missingId]));
      expect(JSON.stringify(page)).not.toMatch(/passwordHash|\$2[aby]\$/);
      const one = (await http().get(`${ADMIN_APPS}/${listedId}`).set(bearer(superAdmin)).expect(200)).body;
      expect(Object.keys(one).sort()).toEqual([
        'assignedSchool', 'avatarFileId', 'country', 'createdAt', 'decidedAt', 'decidedBy', 'decisionNote', 'email', 'firstName', 'homeDistrict', 'homeSector',
        'id', 'infoRequests', 'lastName', 'olympiadInterests', 'phone', 'position', 'proposedSchoolName', 'rejectionReason', 'school', 'schoolDistrict', 'schoolProvince',
        'schoolSector', 'schoolVerifiedAt', 'schoolVerifiedBy', 'status', 'userId', 'username', 'yearsOfExperience',
      ]);
      expect(one).toMatchObject({
        username: 'tr.approve', phone: '+250788123456', country: 'RW', olympiadInterests: ['MATHEMATICS', 'PHYSICS'], status: 'PENDING',
        school: { id: ngoma, code: '220001', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' },
        decidedBy: null, assignedSchool: null, userId: null, schoolVerifiedAt: null, schoolVerifiedBy: null,
      });
      expect((await http().get(ADMIN_APPS).query({ status: 'REJECTED' }).set(bearer(admin)).expect(200)).body.data.every((a: any) => a.status === 'REJECTED')).toBe(true);
      expect(await status(http().get(`${ADMIN_APPS}/${randomUUID()}`).set(bearer(admin)))).toEqual([404, 'NOT_FOUND']);
      expect(await status(http().get(ADMIN_APPS).query({ status: 'MAYBE' }).set(bearer(admin)))).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('approve a listed school: TEACHER account with phone and country, school assignment, decision recorded, hash cleared; the teacher sees only verified students of that school', async () => {
      expect(await status(approve(listedId, { schoolId: tumba }))).toEqual([400, 'SCHOOL_MISMATCH']);
      const res = await approve(listedId, { note: 'Confirmed by phone' }).expect(200);
      expect(res.body).toMatchObject({
        teacher: { firstName: 'Grace', username: 'tr.approve', email: 'tr.approve@test.local', role: 'TEACHER' },
        emailVerificationRequired: false,
        application: {
          id: listedId, status: 'APPROVED', decisionNote: 'Confirmed by phone', decidedBy: { id: ctx.ids.admin },
          assignedSchool: { id: ngoma, code: '220001' }, userId: res.body.teacher.id,
        },
      });
      const user = await p().user.findUniqueOrThrow({ where: { id: res.body.teacher.id } });
      expect(user).toMatchObject({ role: 'TEACHER', isApproved: true, phone: '+250788123456', country: 'RW' });
      expect(user.activatedAt).not.toBeNull();
      expect(await p().teacherSchoolAssignment.findMany({ where: { teacherId: user.id } }))
        .toEqual([expect.objectContaining({ schoolId: ngoma, isActive: true, assignedById: ctx.ids.admin })]);
      const app = await p().teacherApplication.findUniqueOrThrow({ where: { id: listedId } });
      expect(app).toMatchObject({ status: 'APPROVED', passwordHash: null, decidedById: ctx.ids.admin, assignedSchoolId: ngoma, userId: user.id });
      expect(app.decidedAt).not.toBeNull();
      expect(await p().auditLog.findFirstOrThrow({ where: { action: 'APPROVE_TEACHER_APPLICATION', entityId: listedId } }))
        .toMatchObject({ actorId: ctx.ids.admin, metadata: { newUserId: user.id, schoolId: ngoma } });

      // The teacher logs in with the password chosen at registration and sees only VERIFIED students of the school.
      const teacher = await login(ctx, 'tr.approve', 'Secret123');
      const seen = (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.map((s: any) => s.id);
      expect(seen).toEqual([sNgoma]);
      expect(seen).not.toContain(sNgomaPending);
      // With the profile delegation, another school's student is 404.
      await http().post(`/api/v1/admin/teachers/${user.id}/delegations`).set(bearer(admin)).send({ permission: 'students.viewProfile', reason: 'School coordinator duties' }).expect(201);
      await http().get(`/api/v1/teacher/students/${sNgoma}`).set(bearer(teacher)).expect(200);
      expect((await http().get(`/api/v1/teacher/students/${sKacyiru}`).set(bearer(teacher))).status).toBe(404);

      // Decided once only.
      expect(await status(approve(listedId))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
      expect(await status(reject(listedId))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
    });

    it('missing school: SCHOOL_NOT_VERIFIED until an Administrator verifies the school (inactive or unknown refused, nothing created); then approved with that school', async () => {
      const verifySchool = (id: string, body: object, token = admin) => http().post(`${ADMIN_APPS}/${id}/school`).set(bearer(token)).send(body);
      const before = { users: await p().user.count(), assignments: await p().teacherSchoolAssignment.count() };
      expect(await status(approve(missingId))).toEqual([400, 'SCHOOL_NOT_VERIFIED']);
      expect(await status(approve(missingId, { schoolId: tumba }))).toEqual([400, 'SCHOOL_NOT_VERIFIED']);
      expect(await status(verifySchool(missingId, { schoolId: inactive }))).toEqual([400, 'UNKNOWN_SCHOOL']);
      expect(await status(verifySchool(missingId, { schoolId: randomUUID() }))).toEqual([400, 'UNKNOWN_SCHOOL']);
      expect(await status(verifySchool(missingId, {}))).toEqual([400, 'VALIDATION_FAILED']);
      for (const token of [coach, student]) expect(await status(verifySchool(missingId, { schoolId: tumba }, token))).toEqual([403, 'PERMISSION_REQUIRED']);
      // A listed-school application has nothing to verify.
      expect(await status(verifySchool(listedId, { schoolId: ngoma }))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
      expect({ users: await p().user.count(), assignments: await p().teacherSchoolAssignment.count() }).toEqual(before);
      expect((await p().teacherApplication.findUniqueOrThrow({ where: { id: missingId } })).status).toBe('PENDING');

      const created = await http().post('/api/v1/admin/schools').set(bearer(admin)).send({
        name: 'GS Not Yet Listed', code: '220999', province: 'Southern Province', district: 'Huye', sector: 'Tumba', location: 'Huye',
      }).expect(201);
      const verified = await verifySchool(missingId, { schoolId: created.body.id, note: 'Created from the application' }).expect(200);
      expect(verified.body).toMatchObject({
        id: missingId, status: 'PENDING', school: { id: created.body.id }, proposedSchoolName: 'GS Not Yet Listed',
        schoolVerifiedBy: { id: ctx.ids.admin }, userId: null, assignedSchool: null,
      });
      expect(verified.body.schoolVerifiedAt).not.toBeNull();
      expect({ users: await p().user.count(), assignments: await p().teacherSchoolAssignment.count() }).toEqual(before);
      expect(await status(verifySchool(missingId, { schoolId: created.body.id }))).toEqual([409, 'SCHOOL_ALREADY_VERIFIED']);

      expect(await status(approve(missingId, { schoolId: tumba }))).toEqual([400, 'SCHOOL_MISMATCH']);
      const res = await approve(missingId).expect(200);
      expect(res.body.application).toMatchObject({ status: 'APPROVED', school: { id: created.body.id }, proposedSchoolName: 'GS Not Yet Listed', assignedSchool: { id: created.body.id } });
      expect(await p().teacherSchoolAssignment.count({ where: { teacherId: res.body.teacher.id, schoolId: created.body.id, isActive: true } })).toBe(1);
      expect(await status(verifySchool(missingId, { schoolId: created.body.id }))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
    });

    it('a listed school deactivated before approval: refused, nothing created', async () => {
      const id = (await register(listed({ schoolId: tumba, homeDistrict: 'Huye', homeSector: 'Tumba' })).expect(201)).body.id;
      await p().school.update({ where: { id: tumba }, data: { isActive: false } });
      try {
        const users = await p().user.count();
        expect(await status(approve(id))).toEqual([400, 'UNKNOWN_SCHOOL']);
        expect(await p().user.count()).toBe(users);
        expect((await p().teacherApplication.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      } finally {
        await p().school.update({ where: { id: tumba }, data: { isActive: true } });
      }
    });

    it('approval re-checks the identity: a user created meanwhile with that username → 409, nothing changes', async () => {
      const id = (await register(listed({ username: 'tr.race', email: 'tr.race@test.local' })).expect(201)).body.id;
      await p().user.create({ data: { username: 'tr.race', firstName: 'R', lastName: 'R', email: 'tr.race.other@test.local', role: 'ADMIN' } });
      expect(await status(approve(id))).toEqual([409, 'IDENTITY_TAKEN']);
      expect(await p().teacherApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'PENDING', userId: null });
    });

    it('reject: no account and no assignment; reason and decider recorded; hash cleared; twice → 409', async () => {
      const id = (await register(listed({ username: 'tr.reject', email: 'tr.reject@test.local' })).expect(201)).body.id;
      expect(await status(reject(id, { reason: 'x' }))).toEqual([400, 'VALIDATION_FAILED']);
      const res = await reject(id, { reason: 'Could not confirm the school' }, superAdmin).expect(200);
      expect(res.body).toMatchObject({ id, status: 'REJECTED', rejectionReason: 'Could not confirm the school', userId: null, assignedSchool: null });
      expect(res.body.decidedBy).toMatchObject({ firstName: 'tr.super' });
      expect(await p().teacherApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ passwordHash: null, status: 'REJECTED' });
      expect(await p().user.count({ where: { username: 'tr.reject' } })).toBe(0);
      expect(await p().auditLog.count({ where: { action: 'REJECT_TEACHER_APPLICATION', entityId: id } })).toBe(1);
      // The audit row keeps the reason and the decider (L2).
      const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'REJECT_TEACHER_APPLICATION', entityId: id } });
      expect(audit.metadata).toEqual({ reason: 'Could not confirm the school', decidedById: audit.actorId });
      expect(audit.actorId).toBe(res.body.decidedBy.id);
      expect(await status(reject(id))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
      expect(await status(approve(id))).toEqual([409, 'APPLICATION_ALREADY_DECIDED']);
      expect(await status(reject(randomUUID()))).toEqual([404, 'NOT_FOUND']);
    });

    it('with e-mail verification on, the approved account starts unactivated and gets a confirmation link', async () => {
      const id = (await register(listed({ username: 'tr.verify', email: 'tr.verify@test.local' })).expect(201)).body.id;
      await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.requireEmailVerification': true }).expect(200);
      try {
        const res = await approve(id).expect(200);
        expect(res.body.emailVerificationRequired).toBe(true);
        expect((await p().user.findUniqueOrThrow({ where: { id: res.body.teacher.id } })).activatedAt).toBeNull();
        expect(await p().accountActivationToken.count({ where: { userId: res.body.teacher.id, purpose: 'EMAIL_VERIFICATION' } })).toBe(1);
      } finally {
        await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.requireEmailVerification': false }).expect(200);
      }
    });
  });
});
