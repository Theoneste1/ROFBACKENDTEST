/**
 * Schools without an official code (owner decision 2026-11-14): "Schools without official codes
 * must be searchable during registration using their official name and location. Use internal IDs
 * and do not invent official school codes."
 *
 *   GET  /schools/search             active Rwandan schools with AND without a code, by name, by code
 *                                    prefix and by place (province / district / sector / location
 *                                    text); `code` stays null for a codeless school; the response
 *                                    shape is unchanged.
 *   POST /auth/register/student      { schoolId } — a school of the list by its internal id; the
 *                                    claim is PENDING exactly as with { schoolCode }.
 *   POST /me/school-affiliation      { schoolId } — the same, from the profile.
 *   Refused: unknown id, a school outside the Rwandan list, an inactive school, schoolId with
 *   schoolCode / another country. The schoolCode, "not listed" and abroad paths are unchanged.
 */
import { bearer, createTestApp, login, type TestContext } from './helpers.js';

const NGOMA = { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' };
const UNKNOWN_ID = '6f1d3c1e-2b1a-4c3d-9e8f-0a1b2c3d4e5f';

describe('Schools without an official code (owner decision 2026-11-14)', () => {
  let ctx: TestContext;
  let admin: string;
  let official: string, codeless: string, closed: string, kenya: string, legacy: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const ME = '/api/v1/me/school-affiliation';
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const search = async (query: object) => (await http().get('/api/v1/schools/search').query(query).expect(200)).body as any[];
  const reg = (username: string, extra: object) => http().post('/api/v1/auth/register/student').send({
    firstName: 'Cl', lastName: username, username, email: `${username}@test.local`, password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Huye', ...extra,
  });
  const user = (username: string) => p().user.findUniqueOrThrow({ where: { username } });
  const claims = (studentId: string) => p().studentSchoolAffiliation.findMany({ where: { studentId, supersededAt: null } });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    // The official directory place (Ngoma) and one official school there.
    official = (await p().school.create({ data: {
      name: 'GS Ngoma Official', code: '220001', nameKey: 'gs ngoma official', location: 'Huye, Ngoma', ownership: 'PUBLIC', source: 'OFFICIAL_LIST', ...NGOMA,
    } })).id;
    // An Administrator adds a school WITHOUT an official code (the real path).
    const created = await http().post('/api/v1/admin/schools').set(bearer(admin))
      .send({ name: 'Ecole Saint Gabriel', ...NGOMA, location: 'Near Ngoma market' }).expect(201);
    expect(created.body).toMatchObject({ code: null, countryCode: 'RW', source: 'ADMIN', isActive: true });
    codeless = created.body.id;
    closed = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Closed Hill Academy', ...NGOMA }).expect(201)).body.id;
    await http().patch(`/api/v1/admin/schools/${closed}/active`).set(bearer(admin)).send({ isActive: false, reason: 'Closed down' }).expect(200);
    // A free-text school entered before the directory (LEGACY, no code, unvetted name).
    legacy = (await p().school.create({ data: {
      name: 'Gabriel Ngoma Typed By A Student', nameKey: 'gabriel ngoma typed by a student', location: 'Ngoma', source: 'LEGACY', ...NGOMA,
    } })).id;
    kenya = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Gabriel Nairobi School', countryCode: 'KE', location: 'Nairobi' }).expect(201)).body.id;
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('public search finds a codeless school by name and by place (sector, district, province, location text), with its id and code null; the shape is unchanged apart from the additive province (teacher registration); inactive and foreign schools are not offered', async () => {
    const byName = await search({ q: 'saint gab' });
    expect(byName).toEqual([{ id: codeless, code: null, name: 'Ecole Saint Gabriel', location: 'Near Ngoma market', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }]);
    expect(Object.keys(byName[0]).sort()).toEqual(['code', 'district', 'id', 'location', 'name', 'province', 'sector']);
    for (const q of ['Ngoma', 'huye', 'Southern', 'ngoma market']) {
      expect((await search({ q })).map((s) => s.id), q).toContain(codeless);
    }
    // The Province → District → Sector listing offers it beside the official school.
    expect((await search({ district: 'Huye', sector: 'Ngoma' })).map((s) => [s.name, s.code]))
      .toEqual([['Ecole Saint Gabriel', null], ['GS Ngoma Official', '220001']]);
    expect((await search({ q: 'Gabriel', district: 'Huye' })).map((s) => s.id)).toEqual([codeless]);
    // Several words: each must be found in the name, the code or the place ("name + location").
    expect((await search({ q: 'Gabriel Ngoma' })).map((s) => s.id)).toEqual([codeless]);
    expect((await search({ q: 'saint huye market' })).map((s) => s.id)).toEqual([codeless]);
    expect(await search({ q: 'Gabriel Kigali' })).toEqual([]);
    // A whole-name match comes before word matches.
    expect((await search({ q: 'Ngoma' })).map((s) => s.name)).toEqual(['GS Ngoma Official', 'Ecole Saint Gabriel']);
    // Never offered: an inactive school, a school of another country.
    expect(await search({ q: 'Closed Hill' })).toEqual([]);
    // Never offered: a LEGACY free-text school without a code (entered before the directory).
    expect(await search({ q: 'Typed By A Student' })).toEqual([]);
    expect((await search({ district: 'Huye', sector: 'Ngoma' })).map((s) => s.id)).not.toContain(legacy);
    expect((await search({ q: 'Gabriel' })).map((s) => s.id)).toEqual([codeless]);
    // Official schools: by code prefix and by name, unchanged.
    expect((await search({ q: '2200' })).map((s) => s.code)).toEqual(['220001']);
    expect((await search({ q: 'GS Ngoma' })).map((s) => s.id)).toEqual([official]);
    // No code was invented.
    expect((await p().school.findUniqueOrThrow({ where: { id: codeless } })).code).toBeNull();
  });

  it('registration by schoolId: linked, PENDING (source REGISTRATION), verified by an Administrator; no code is invented', async () => {
    const res = await reg('cl.reg.id', { schoolId: codeless }).expect(201);
    expect(res.body.schoolVerification).toBe('PENDING');
    const u = await user('cl.reg.id');
    expect(u.schoolId).toBe(codeless);
    const [claim] = await claims(u.id);
    expect(claim).toMatchObject({ schoolId: codeless, status: 'PENDING', source: 'REGISTRATION', claimedName: null, claimedProvince: null });
    expect((await p().studentEnrollment.findFirstOrThrow({ where: { studentId: u.id, academicYearId: ctx.ids.year } })).schoolId).toBe(codeless);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'REGISTER', entityId: u.id } });
    expect(audit.metadata).toMatchObject({ schoolId: codeless, schoolCode: null, schoolName: 'Ecole Saint Gabriel', schoolLinked: true });
    // The Administrator's queue shows it like any linked claim; verification works the same.
    const queue = (await http().get('/api/v1/admin/school-affiliations').query({ schoolId: codeless, status: 'PENDING' }).set(bearer(admin)).expect(200)).body.data;
    expect(queue.map((c: any) => c.id)).toEqual([claim.id]);
    await http().post(`/api/v1/admin/school-affiliations/${claim.id}/verify`).set(bearer(admin)).send({}).expect(200);
    expect((await claims(u.id))[0]).toMatchObject({ status: 'VERIFIED', schoolId: codeless });
    expect((await p().school.findUniqueOrThrow({ where: { id: codeless } })).code).toBeNull();
    // A school WITH a code may be chosen by id too.
    await reg('cl.reg.id.official', { schoolId: official }).expect(201);
    expect((await claims((await user('cl.reg.id.official')).id))[0]).toMatchObject({ schoolId: official, status: 'PENDING' });
  });

  it('registration by schoolId refused: unknown id, a foreign school, an inactive school, another country, with schoolCode, not a uuid — nothing is created', async () => {
    expect(await status(reg('cl.bad.unknown', { schoolId: UNKNOWN_ID }))).toEqual([400, 'UNKNOWN_SCHOOL']);
    expect(await status(reg('cl.bad.kenya', { schoolId: kenya }))).toEqual([400, 'UNKNOWN_SCHOOL']);
    // A LEGACY free-text school is not in the public list, so it cannot be claimed by id either.
    expect(await status(reg('cl.bad.legacy', { schoolId: legacy }))).toEqual([400, 'UNKNOWN_SCHOOL']);
    expect(await status(reg('cl.bad.closed', { schoolId: closed }))).toEqual([409, 'SCHOOL_INACTIVE']);
    expect(await status(reg('cl.bad.country', { schoolId: codeless, country: 'KE' }))).toEqual([400, 'SCHOOL_DIRECTORY_RWANDA_ONLY']);
    expect(await status(reg('cl.bad.both', { schoolId: codeless, schoolCode: '220001' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(reg('cl.bad.uuid', { schoolId: 'not-a-uuid' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await p().user.count({ where: { username: { startsWith: 'cl.bad.' } } })).toBe(0);
  });

  it('registration by schoolCode, "not listed" and abroad are unchanged', async () => {
    await reg('cl.code', { schoolCode: '220001' }).expect(201);
    expect((await claims((await user('cl.code')).id))[0]).toMatchObject({ schoolId: official, status: 'PENDING', claimedName: null });
    expect(await status(reg('cl.code.bad', { schoolCode: '999999' }))).toEqual([400, 'UNKNOWN_SCHOOL_CODE']);
    await reg('cl.nl', { schoolName: 'Unlisted Hill School', schoolProvince: NGOMA.province, schoolDistrict: NGOMA.district, schoolSector: NGOMA.sector }).expect(201);
    expect((await claims((await user('cl.nl')).id))[0]).toMatchObject({ schoolId: null, claimedName: 'Unlisted Hill School', claimedSector: 'Ngoma', status: 'PENDING' });
    await reg('cl.abroad', { country: 'KE', schoolName: 'Nairobi Academy' }).expect(201);
    expect((await claims((await user('cl.abroad')).id))[0]).toMatchObject({ schoolId: null, claimedName: 'Nairobi Academy', claimedCountry: 'KE' });
    expect(await status(reg('cl.none', {}))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('profile claim by schoolId: a new PENDING claim (the student is placed at that school); same school again 409; refused like registration; code claims unchanged', async () => {
    await reg('cl.me', { schoolCode: '220001' }).expect(201);
    const u = await user('cl.me');
    await p().user.update({ where: { id: u.id }, data: { activatedAt: new Date(), isApproved: true } });
    const token = await login(ctx, 'cl.me', 'Secret123');
    const mine = await http().post(ME).set(bearer(token)).send({ schoolId: codeless }).expect(201);
    expect(mine.body).toBeTruthy();
    const [claim] = await claims(u.id);
    expect(claim).toMatchObject({ schoolId: codeless, status: 'PENDING', source: 'STUDENT_REQUEST', claimedName: null });
    expect((await user('cl.me')).schoolId).toBe(codeless);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: codeless }))).toEqual([409, 'CLAIM_ALREADY_PENDING']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: UNKNOWN_ID }))).toEqual([400, 'UNKNOWN_SCHOOL']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: kenya }))).toEqual([400, 'UNKNOWN_SCHOOL']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: closed }))).toEqual([409, 'SCHOOL_INACTIVE']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: official, schoolCode: '220001' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: official, schoolName: 'GS Ngoma Official' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: official, country: 'KE' }))).toEqual([400, 'SCHOOL_DIRECTORY_RWANDA_ONLY']);
    expect(await status(http().post(ME).set(bearer(token)).send({ schoolId: 'nope' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect((await claims(u.id))[0].id).toBe(claim.id);   // nothing changed by the refusals
    // Back to the official school by its code: unchanged.
    await http().post(ME).set(bearer(token)).send({ schoolCode: '220001' }).expect(201);
    expect((await claims(u.id))[0]).toMatchObject({ schoolId: official, status: 'PENDING', source: 'STUDENT_REQUEST' });
  });
});
