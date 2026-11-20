/**
 * Registration details (capabilities studentRegistrationDetails and coachApplicationDetails):
 * a student's date of birth, phones, own country and official home place; a coach applicant's country,
 * occupation, education level and Olympiad interests. All optional at the API for older clients.
 * Nothing here grants a role or a permission; coach applications are still reviewed by an Administrator.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';
import { ageOn, todayInRwanda } from '../src/auth/dto/registration-details.rules.js';

describe('Registration details (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    await ctx.prisma.school.create({ data: {
      name: 'GS DETAILS', location: 'Huye', code: '310888', province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
      ownership: 'PUBLIC', nameKey: 'gs details', source: 'OFFICIAL_LIST',
    } });
  });
  afterAll(async () => { await ctx?.app.close(); });

  /** A date of birth giving this age today in Rwanda (birthday a few days ago). */
  const bornYearsAgo = (years: number) => {
    const [y, m, d] = todayInRwanda().split('-').map(Number);
    const dt = new Date(Date.UTC(y - years, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 3);
    return dt.toISOString().slice(0, 10);
  };

  let n = 0;
  const register = (body: Record<string, unknown> = {}) => {
    n += 1;
    return http().post('/api/v1/auth/register/student').send({
      firstName: 'Diane', lastName: 'Details', username: `rd.s${n}`, email: `rd.s${n}@example.com`,
      password: 'Secret123', gradeLevel: 'S3', schoolCode: '310888', homeLocation: 'Huye', dateOfBirth: bornYearsAgo(15), gender: 'FEMALE', homeCountry: 'UG', guardianPhone: '0722 000 111', ...body,
    });
  };
  const HOME = { homeCountry: 'RW', homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma' };
  const status = async (r: PromiseLike<{ status: number; body: { code?: string } }>) => { const res = await r; return [res.status, res.body.code]; };

  it('the capabilities announce both groups', async () => {
    const { features } = (await http().get('/api/v1').expect(200)).body.capabilities;
    expect(features).toEqual(expect.arrayContaining(['studentRegistrationDetails', 'coachApplicationDetails']));
  });

  it('a student with every detail: stored (E.164 phones, date only, own country, home place) and on the profile', async () => {
    const dateOfBirth = bornYearsAgo(14);
    const res = await register({
      homeLocation: undefined, dateOfBirth, phone: '0788 123 456', guardianPhone: '+254 712 345678', ...HOME,
    }).expect(201);
    expect(res.body).toMatchObject({
      phone: '+250788123456', guardianPhone: '+254712345678', country: 'RW',
      homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma', homeLocation: 'Ngoma, Huye',
    });
    expect(String(res.body.dateOfBirth).slice(0, 10)).toBe(dateOfBirth);
    expect(ageOn(dateOfBirth, todayInRwanda())).toBe(14);

    const token = await login(ctx, res.body.username, 'Secret123');
    const me = (await http().get('/api/v1/me').set(bearer(token)).expect(200)).body;
    expect(me).toMatchObject({ guardianPhone: '+254712345678', homeSector: 'Ngoma', country: 'RW', gender: 'FEMALE' });
    const detail = (await http().get(`/api/v1/admin/users/${res.body.id}`).set(bearer(admin)).expect(200)).body;
    expect(detail).toMatchObject({ phone: '+250788123456', guardianPhone: '+254712345678', homeDistrict: 'Huye', gender: 'FEMALE' });
    expect(String(detail.dateOfBirth).slice(0, 10)).toBe(dateOfBirth);

    // The audit entry says only whether each detail was given.
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'REGISTER', entityId: res.body.id } });
    expect(audit.metadata).toMatchObject({ dateOfBirthGiven: true, phoneGiven: true, guardianPhoneGiven: true, homePlaceGiven: true, homeCountry: 'RW' });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/712345678|788123456/);
    expect(JSON.stringify(audit.metadata)).not.toContain(dateOfBirth);
  });

  it('gender is required at every sign-up (owner, 2026-11-20): FEMALE or MALE; missing or another value is 400 naming gender, nothing created', async () => {
    expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toContain('registrationGender');
    for (const gender of [undefined, '', 'OTHER', 'female']) {
      const res = await register({ gender, username: 'rd.nogender', email: 'rd.nogender@example.com' }).expect(400);
      expect(JSON.stringify(res.body)).toContain('gender');
    }
    expect(await ctx.prisma.user.count({ where: { username: 'rd.nogender' } })).toBe(0);
    const male = await register({ gender: 'MALE' }).expect(201);
    expect(male.body.gender).toBe('MALE');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: male.body.id } })).gender).toBe('MALE');
    // Not written to the audit log.
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'REGISTER', entityId: male.body.id } });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/MALE/);

    const coach = { firstName: 'Gina', lastName: 'Coach', username: 'rd.gcoach', email: 'rd.gcoach@example.com', password: 'Mentor123', country: 'KE', olympiadInterests: ['MATHEMATICS'] };
    for (const gender of [undefined, 'X']) {
      const res = await http().post('/api/v1/mentor-requests').send({ ...coach, gender }).expect(400);
      expect(JSON.stringify(res.body)).toContain('gender');
    }
    const apply = await http().post('/api/v1/mentor-requests').send({ ...coach, gender: 'MALE' }).expect(201);
    expect((await ctx.prisma.mentorRequest.findUniqueOrThrow({ where: { id: apply.body.id } })).gender).toBe('MALE');
    await http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(200);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'rd.gcoach' } })).toMatchObject({ role: 'MENTOR', gender: 'MALE' });
  });

  describe('home location (homeLocationRules; owner, 2026-11-20)', () => {
    const PLACE = { homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma' };
    const coachBody = (u: string, over: object) => ({
      firstName: 'Hana', lastName: 'Home', username: u, email: `${u}@example.com`, password: 'Mentor123', gender: 'FEMALE', olympiadInterests: ['MATHEMATICS'], ...over,
    });

    it('a Rwandan student: country, province, district and sector all required, stored, on the profile', async () => {
      expect((await http().get('/api/v1').expect(200)).body.capabilities.features).toContain('homeLocationRules');
      for (const missing of ['homeProvince', 'homeDistrict', 'homeSector']) {
        const res = await register({ homeCountry: 'RW', homeLocation: undefined, ...PLACE, [missing]: undefined }).expect(400);
        expect(JSON.stringify(res.body)).toContain(missing);
      }
      const ok = await register({ homeCountry: 'RW', homeLocation: undefined, ...PLACE }).expect(201);
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: ok.body.id } }))
        .toMatchObject({ country: 'RW', ...PLACE, homeLocation: 'Ngoma, Huye' });
    });

    it('an international student: the home country only; no province, district, sector or free-text location needed', async () => {
      const ok = await register({ homeCountry: 'ug', homeLocation: undefined }).expect(201);
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: ok.body.id } }))
        .toMatchObject({ country: 'UG', homeProvince: null, homeDistrict: null, homeSector: null, homeLocation: null });
      // No home country: refused. A Rwandan place with another country: refused. An invalid combination: refused.
      expect(JSON.stringify((await register({ homeCountry: undefined }).expect(400)).body)).toContain('homeCountry');
      expect(await status(register({ homeCountry: 'UG', ...PLACE }))).toEqual([400, 'HOME_LOCATION_RWANDA_ONLY']);
      expect(await status(register({ homeCountry: 'RW', ...PLACE, homeProvince: 'Kigali City' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
    });

    it('coach applications: home country required; Rwanda needs the place; approval copies the home location to the account', async () => {
      expect(JSON.stringify((await http().post('/api/v1/mentor-requests').send(coachBody('rd.h0', {})).expect(400)).body)).toContain('country');
      expect(JSON.stringify((await http().post('/api/v1/mentor-requests').send(coachBody('rd.h1', { country: 'RW' })).expect(400)).body)).toContain('homeProvince');
      expect(await status(http().post('/api/v1/mentor-requests').send(coachBody('rd.h2', { country: 'KE', ...PLACE })))).toEqual([400, 'HOME_LOCATION_RWANDA_ONLY']);
      expect(await status(http().post('/api/v1/mentor-requests').send(coachBody('rd.h3', { country: 'RW', ...PLACE, homeSector: 'Kacyiru' })))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
      const rw = (await http().post('/api/v1/mentor-requests').send(coachBody('rd.h4', { country: 'rw', ...PLACE })).expect(201)).body.id;
      const abroad = (await http().post('/api/v1/mentor-requests').send(coachBody('rd.h5', { country: 'KE' })).expect(201)).body.id;
      for (const id of [rw, abroad]) await http().patch(`/api/v1/mentor-requests/${id}/approve`).set(bearer(admin)).expect(200);
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'rd.h4' } })).toMatchObject({ country: 'RW', ...PLACE, homeLocation: 'Ngoma, Huye' });
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'rd.h5' } })).toMatchObject({ country: 'KE', homeProvince: null, homeDistrict: null, homeSector: null });
    });

    it('profile edits (PATCH /me, PATCH /admin/users/:id): Rwanda and another country, the place cleared or required', async () => {
      const student = await register({ homeCountry: 'RW', homeLocation: undefined, ...PLACE }).expect(201);
      const token = await login(ctx, student.body.username, 'Secret123');
      const me = (body: object) => http().patch('/api/v1/me').set(bearer(token)).send(body);
      // Abroad: the Rwandan place is cleared.
      expect((await me({ homeCountry: 'UG' }).expect(200)).body).toMatchObject({ country: 'UG', homeProvince: null, homeDistrict: null, homeSector: null, homeLocation: null });
      // Back to Rwanda: the place is required again.
      expect(JSON.stringify((await me({ homeCountry: 'RW' }).expect(400)).body)).toContain('homeProvince');
      expect((await me({ homeCountry: 'RW', ...PLACE }).expect(200)).body).toMatchObject({ country: 'RW', ...PLACE, homeLocation: 'Ngoma, Huye' });
      expect(await status(me({ homeCountry: 'UG', ...PLACE }))).toEqual([400, 'HOME_LOCATION_RWANDA_ONLY']);
      expect(await status(me({ homeCountry: 'RW', ...PLACE, homeDistrict: 'Gasabo' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
      expect(await status(me({ homeDistrict: 'Huye' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(me(PLACE))).toEqual([400, 'HOME_COUNTRY_REQUIRED']);
      // Other edits leave the home location alone.
      expect((await me({ firstName: 'Diana' }).expect(200)).body).toMatchObject({ country: 'RW', ...PLACE });
      // An Administrator: the same rules.
      const adminEdit = (body: object) => http().patch(`/api/v1/admin/users/${student.body.id}`).set(bearer(admin)).send(body);
      await adminEdit({ homeCountry: 'KE' }).expect(200);
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: student.body.id } })).toMatchObject({ country: 'KE', homeProvince: null, homeSector: null });
      expect(await status(adminEdit({ homeCountry: 'RW' }))).toEqual([400, 'VALIDATION_FAILED']);
      await adminEdit({ homeCountry: 'RW', ...PLACE }).expect(200);
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: student.body.id } })).toMatchObject({ country: 'RW', ...PLACE });
    });
  });

  it('the date of birth is required (owner, 2026-11-17): without it 400 naming dateOfBirth, nothing created; the other details (except the guardian phone) stay optional', async () => {
    const before = await ctx.prisma.user.count();
    const res = await register({ dateOfBirth: undefined }).expect(400);
    expect(JSON.stringify(res.body)).toContain('dateOfBirth');
    expect(await ctx.prisma.user.count()).toBe(before);
    const ok = await register().expect(201);
    expect(ok.body).toMatchObject({ phone: null, guardianPhone: '+250722000111', homeProvince: null, homeLocation: 'Huye' });
    expect(String(ok.body.dateOfBirth).slice(0, 10)).toBe(bornYearsAgo(15));
  });

  it('the close-family (guardian) phone is required by the server (owner decision 9.2, 2026-11-18): missing, empty, malformed or invalid → 400 naming guardianPhone, nothing created; the own phone of the student stays optional', async () => {
    const cases: unknown[] = [undefined, null, '', '   ', 'my mother', '0788', '+250 688 123 456', '07881234567', 12345];
    for (const guardianPhone of cases) {
      const username = `rd.gp${++n}`;
      const res = await register({ username, email: `${username}@example.com`, guardianPhone }).expect(400);
      expect([guardianPhone, res.body.code]).toEqual([guardianPhone, 'VALIDATION_FAILED']);
      expect(JSON.stringify(res.body)).toContain('guardianPhone');
      expect(await ctx.prisma.user.count({ where: { username } })).toBe(0);
    }
    // Valid: stored in E.164; the student's own phone may be left out.
    const ok = await register({ guardianPhone: ' 0722 123 456 ', phone: undefined }).expect(201);
    expect(ok.body).toMatchObject({ guardianPhone: '+250722123456', phone: null });
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: ok.body.id }, select: { guardianPhone: true } })).toEqual({ guardianPhone: '+250722123456' });
  });

  it('an international student: own country, home city as text, school abroad', async () => {
    const res = await register({
      schoolCode: undefined, country: 'KE', schoolName: 'Alliance High School', homeCountry: 'KE', homeLocation: 'Nairobi',
      dateOfBirth: bornYearsAgo(16), gender: 'FEMALE', guardianPhone: '+254712345678',
    }).expect(201);
    expect(res.body).toMatchObject({ country: 'KE', homeLocation: 'Nairobi', homeProvince: null });
  });

  it('invalid details: 400 with the field named; nothing created', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ dateOfBirth: '2012-02-30' }, 'dateOfBirth'],
      [{ dateOfBirth: bornYearsAgo(3) }, 'dateOfBirth'],
      [{ dateOfBirth: bornYearsAgo(31) }, 'dateOfBirth'],
      [{ dateOfBirth: '2099-01-01' }, 'dateOfBirth'],
      [{ phone: '12345' }, 'phone'],
      [{ guardianPhone: 'my mother' }, 'guardianPhone'],
      [{ homeCountry: 'Rwanda' }, 'homeCountry'],
      [{ homeProvince: 'Southern Province' }, 'homeDistrict'],
      [{ homeCountry: undefined }, 'homeCountry'],
    ];
    for (const [body, field] of cases) {
      const username = `rd.bad${++n}`;
      const res = await register({ username, email: `${username}@example.com`, ...body }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).toContain(field);
      expect(await ctx.prisma.user.count({ where: { username } })).toBe(0);
    }
  });

  it('home place: must be a place of the official directory, and only for Rwanda', async () => {
    expect(await status(register({ ...HOME, homeSector: 'Kacyiru' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
    expect(await status(register({ ...HOME, homeProvince: 'Kigali City' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
    expect(await status(register({ ...HOME, homeCountry: 'KE' }))).toEqual([400, 'HOME_LOCATION_RWANDA_ONLY']);
  });

  it('a coach application with its details; the admin list shows them; approval copies country and interests', async () => {
    const apply = await http().post('/api/v1/mentor-requests').send({
      firstName: 'Claude', lastName: 'Coach', username: 'rd.coach', email: 'rd.coach@example.com', password: 'Mentor123', gender: 'FEMALE',
      country: 'ke', occupation: ' Secondary school teacher ', educationLevel: 'MASTER', olympiadInterests: ['PHYSICS', 'MATHEMATICS'],
    }).expect(201);
    expect(apply.body).toMatchObject({
      status: 'PENDING', country: 'KE', occupation: 'Secondary school teacher', educationLevel: 'MASTER', olympiadInterests: ['MATHEMATICS', 'PHYSICS'],
    });
    // Submitting creates no account and no permission.
    expect(await ctx.prisma.user.count({ where: { username: 'rd.coach' } })).toBe(0);

    const list = (await http().get('/api/v1/mentor-requests?status=PENDING').set(bearer(admin)).expect(200)).body;
    expect(list.data.find((r: { id: string }) => r.id === apply.body.id)).toMatchObject({ occupation: 'Secondary school teacher', educationLevel: 'MASTER' });

    await http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(200);
    const coach = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'rd.coach' } });
    expect(coach).toMatchObject({ role: 'MENTOR', country: 'KE', olympiadInterests: ['MATHEMATICS', 'PHYSICS'] });
  });

  it('home place combinations: a district of another province, a sector of another district, partial places', async () => {
    // Huye is in the Southern Province; Ngoma is a sector of Huye (the directory has no other place here).
    expect(await status(register({ ...HOME, homeProvince: 'Kigali City' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
    expect(await status(register({ ...HOME, homeDistrict: 'Gasabo' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
    expect(await status(register({ ...HOME, homeSector: 'Tumba' }))).toEqual([400, 'UNKNOWN_HOME_LOCATION']);
    expect(await status(register({ homeProvince: 'Southern Province', homeDistrict: 'Huye' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(register({ homeSector: 'Ngoma' }))).toEqual([400, 'VALIDATION_FAILED']);
    // The home country is required (homeLocationRules): a home place alone is refused.
    const { homeCountry: _rw, ...place } = HOME;
    expect(await status(register({ ...place, homeCountry: undefined, homeLocation: undefined }))).toEqual([400, 'VALIDATION_FAILED']);
    expect((await register({ ...HOME, homeLocation: undefined }).expect(201)).body.homeLocation).toBe('Ngoma, Huye');
  });

  it('phones: Rwandan and international forms are normalised to E.164; both phones are independent', async () => {
    for (const [given, stored] of [['0788123456', '+250788123456'], ['250 788 123 456', '+250788123456'], ['00254712345678', '+254712345678'], ['+1 202 555 0143', '+12025550143']]) {
      const res = await register({ guardianPhone: given }).expect(201);
      expect([given, res.body.guardianPhone, res.body.phone]).toEqual([given, stored, null]);
    }
    for (const bad of ['0788', '+250 688 123 456', '07881234567', 'abc']) {
      expect(await status(register({ phone: bad }))).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  // Since 2026-11-17 the date of birth is required: the payloads below are today's frontend's plus dateOfBirth (the
  // frontend release asks for it); a payload without it is refused (see 'the date of birth is required').
  describe("backward compatibility: the payloads today's frontend sends", () => {
    /** The registration response keys before this change; the only additions are the seven detail fields. */
    const NEW_KEYS = ['country', 'dateOfBirth', 'guardianPhone', 'homeDistrict', 'homeProvince', 'homeSector', 'phone'];
    const oldShape = (body: Record<string, unknown>) => Object.keys(body).filter((k) => !NEW_KEYS.includes(k)).sort();
    let reference: string[];
    let codeless: string;

    beforeAll(async () => {
      codeless = (await ctx.prisma.school.create({ data: {
        name: 'Ecole Sans Code', location: 'Ngoma', province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
        source: 'ADMIN', nameKey: 'ecole sans code',
      } })).id;
    });
    const claimOf = (userId: string) => ctx.prisma.studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: userId } });

    it('by school code: linked to that official school, PENDING; same response shape plus the new fields (null, except the now-required date of birth and guardian phone)', async () => {
      const res = await register({ olympiadInterests: ['MATHEMATICS'] }).expect(201);
      reference = oldShape(res.body);
      // The home country is required too since homeLocationRules (2026-11-20).
      for (const k of NEW_KEYS.filter((x) => x !== 'dateOfBirth' && x !== 'guardianPhone' && x !== 'country')) expect(res.body[k]).toBeNull();
      expect(res.body.country).toBe('UG');
      expect(res.body.dateOfBirth).not.toBeNull();
      expect(res.body.guardianPhone).toBe('+250722000111');
      expect(res.body.school).toMatchObject({ name: 'GS DETAILS' });
      expect(await claimOf(res.body.id)).toMatchObject({ status: 'PENDING', source: 'REGISTRATION' });
    });

    it('by school id (a school without an official code): linked, PENDING, no code invented', async () => {
      const res = await register({ schoolCode: undefined, schoolId: codeless }).expect(201);
      expect(oldShape(res.body)).toEqual(reference);
      expect(await claimOf(res.body.id)).toMatchObject({ status: 'PENDING', schoolId: codeless });
      expect((await ctx.prisma.school.findUniqueOrThrow({ where: { id: codeless } })).code).toBeNull();
    });

    it('"my school is not listed": a PENDING claim with the name and place; never approved, never a new school', async () => {
      const before = await ctx.prisma.school.count();
      const res = await register({
        schoolCode: undefined, schoolName: 'Groupe Scolaire Nouveau', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Ngoma',
      }).expect(201);
      expect(oldShape(res.body)).toEqual(reference);
      expect(await claimOf(res.body.id)).toMatchObject({
        status: 'PENDING', schoolId: null, claimedName: 'Groupe Scolaire Nouveau', claimedProvince: 'Southern Province', claimedDistrict: 'Huye', claimedSector: 'Ngoma',
      });
      expect(await ctx.prisma.school.count()).toBe(before);
    });

    it('a school abroad: an unverified name, never matched to a Rwandan school', async () => {
      const res = await register({ schoolCode: undefined, country: 'UG', schoolName: 'GS Details' }).expect(201);
      expect(oldShape(res.body)).toEqual(reference);
      expect(res.body.school).toBeNull();
      expect(await claimOf(res.body.id)).toMatchObject({ status: 'PENDING', schoolId: null, claimedCountry: 'UG' });
    });

    it('the legacy name + location payload still registers (school matched only by an exact unique name)', async () => {
      const res = await register({ schoolCode: undefined, schoolName: 'GS Details', schoolLocation: 'Huye' }).expect(201);
      expect(oldShape(res.body)).toEqual(reference);
      expect(res.body.school).toMatchObject({ name: 'GS DETAILS' });
    });

    // Since 2026-11-19 (owner decision, coachOlympiadInterests) the subjects are required on every new application:
    // the original five fields plus `olympiadInterests`; the other details stay optional for older clients.
    it('a coach application with only the original five fields and the now-required subjects', async () => {
      const res = await http().post('/api/v1/mentor-requests').send({
        firstName: 'Five', lastName: 'Fields', username: 'rd.five', email: 'rd.five@example.com', password: 'Mentor123', gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'],
      }).expect(201);
      expect(res.body).toMatchObject({ status: 'PENDING', country: 'KE', occupation: null, educationLevel: null, olympiadInterests: ['MATHEMATICS'] });
      expect(res.body.passwordHash).toBeUndefined();
    });
  });

  it('audit and activity logs never hold a date of birth or a phone number (students and coach applicants)', async () => {
    const dateOfBirth = bornYearsAgo(12);
    const res = await register({ dateOfBirth, phone: '0788 999 111', guardianPhone: '0722 999 111' }).expect(201);
    await login(ctx, res.body.username, 'Secret123');
    const coach = await http().post('/api/v1/mentor-requests').send({
      firstName: 'Log', lastName: 'Check', username: 'rd.logcheck', email: 'rd.logcheck@example.com', password: 'Mentor123', gender: 'FEMALE',
      country: 'RW', homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma', occupation: 'Engineer', educationLevel: 'BACHELOR', olympiadInterests: ['COMPUTING'],
    }).expect(201);
    const audits = await ctx.prisma.auditLog.findMany({ where: { entityId: { in: [res.body.id, coach.body.id] } } });
    const activities = await ctx.prisma.activityLog.findMany({ where: { userId: res.body.id } });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const stored = JSON.stringify([...audits.map((a) => a.metadata), ...activities.map((a) => a.metadata)]);
    for (const secret of [dateOfBirth, '788999111', '722999111', '+250788999111', '+250722999111']) expect(stored).not.toContain(secret);
    expect(audits.find((a) => a.action === 'REGISTER')?.metadata).toMatchObject({ dateOfBirthGiven: true, phoneGiven: true, guardianPhoneGiven: true });
    expect(audits.find((a) => a.action === 'SUBMIT_MENTOR_REQUEST')?.metadata).toEqual({ reapplication: false });
  });

  // Older clients still work with the other details left out; the subjects are required since 2026-11-19 (coachOlympiadInterests).
  it('coach applications: older clients still work; invalid details refused; no national ID field', async () => {
    await http().post('/api/v1/mentor-requests').send({
      firstName: 'Old', lastName: 'Client', username: 'rd.oldcoach', email: 'rd.oldcoach@example.com', password: 'Mentor123', gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'],
    }).expect(201);
    for (const bad of [{ country: 'Kenya' }, { occupation: 'x' }, { educationLevel: 'PHD' }, { olympiadInterests: [] }, { nationalId: '1199880012345678' }]) {
      const username = `rd.badcoach${++n}`;
      const res = await http().post('/api/v1/mentor-requests').send({
        firstName: 'Bad', lastName: 'Coach', username, email: `${username}@example.com`, password: 'Mentor123', gender: 'FEMALE', country: 'KE', olympiadInterests: ['MATHEMATICS'], ...bad,
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await ctx.prisma.mentorRequest.count({ where: { username } })).toBe(0);
    }
  });
});
