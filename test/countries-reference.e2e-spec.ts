/**
 * Countries (design area 1 as simplified by the owner, 2026-11-19; INT-01): ROF is a global Olympiad platform with one
 * common structure (S1–S6; S1–S3 Junior, S4–S6 Senior). The country list identifies where a student, teacher, coach or
 * school is; it never sets a level or division and never blocks a registration.
 *  - the public list (GET /countries) and its administration (reference.manage), audited, never notified; refused to
 *    Coaches, Head Coaches, Teachers, Students and anonymous callers;
 *  - School.countryCode is a foreign key to Country;
 *  - registration from any country works exactly as before (a corrected country name changes nothing for it);
 *  - the rollback refuses while a country was corrected.
 * Runs on its own freshly reset test database (never production).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const ROLLBACK = join(__dirname, '..', 'docs', 'migrations', '20261211000000_countries_reference.rollback.sql');
/** The rollback file with its final COMMIT turned into a ROLLBACK: even if its guard let it through, nothing changes here. */
const rollbackOnly = () => {
  const sql = readFileSync(ROLLBACK, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (!sql.endsWith('COMMIT;')) throw new Error('the rollback does not end with COMMIT;');
  return sql.replace(/COMMIT;$/, 'ROLLBACK;');
};

describe('Countries (owner decision 2026-11-19)', () => {
  let ctx: TestContext;
  let admin: string;
  let superAdmin: string;
  const others: Record<string, string> = {};
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  let n = 0;
  const register = (extra: Record<string, unknown> = {}) => {
    n++;
    return http().post('/api/v1/auth/register/student').send({
      firstName: 'Ada', lastName: 'Uwase', username: `cty.student${n}`, email: `cty.student${n}@example.com`,
      password: 'Secret123', dateOfBirth: '2010-05-01', gender: 'FEMALE', guardianPhone: '0722000111', gradeLevel: 'S3',
      schoolName: 'Some School', schoolLocation: 'Kigali', homeLocation: 'Kigali', ...extra,
    });
  };
  async function rawSql<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  }

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    for (const role of ['SUPER_ADMIN', 'HEAD_COACH', 'TEACHER'] as const) {
      await p().user.create({ data: { username: `cty.${role.toLowerCase()}`, firstName: role, lastName: 'Cty', email: `cty.${role.toLowerCase()}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
    }
    superAdmin = await login(ctx, 'cty.super_admin');
    others.HEAD_COACH = await login(ctx, 'cty.head_coach');
    others.TEACHER = await login(ctx, 'cty.teacher');
    others.MENTOR = await login(ctx, 'mentor.j');
    others.STUDENT = await login(ctx, 'student.j');
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('GET /countries is public: every ISO 3166-1 alpha-2 country by name (code, name, calling code); no active switch', async () => {
    const res = await http().get('/api/v1/countries').expect(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toHaveLength(249);
    expect(res.body.find((c: { code: string }) => c.code === 'RW')).toEqual({ code: 'RW', name: 'Rwanda', phonePrefix: '+250' });
    expect(res.body.find((c: { code: string }) => c.code === 'KE')).toEqual({ code: 'KE', name: 'Kenya', phonePrefix: '+254' });
    expect(res.body.find((c: { code: string }) => c.code === 'AQ')).toEqual({ code: 'AQ', name: 'Antarctica', phonePrefix: null });
    const names = res.body.map((c: { name: string }) => c.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('reference.manage is refused to Coach, Head Coach, Teacher and Student, and anonymous callers are 401', async () => {
    for (const [method, url, body] of [['get', '/api/v1/admin/countries', undefined], ['patch', '/api/v1/admin/countries/KE', { name: 'Kenya!' }]] as const) {
      expect([method, (await (http() as any)[method](url).send(body ?? {})).status]).toEqual([method, 401]);
      for (const [role, token] of Object.entries(others)) {
        expect([role, method, (await (http() as any)[method](url).set(bearer(token)).send(body ?? {})).status]).toEqual([role, method, 403]);
      }
    }
    expect((await p().country.findUniqueOrThrow({ where: { code: 'KE' } })).name).toBe('Kenya');
    expect(await p().auditLog.count({ where: { action: 'COUNTRY_UPDATED' } })).toBe(0);
    expect((await http().get('/api/v1/me/permissions').set(bearer(admin)).expect(200)).body.permissions).toContain('reference.manage');
    for (const token of Object.values(others)) {
      expect((await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.permissions).not.toContain('reference.manage');
    }
  });

  it('Administrators and Super Admins list and search countries, with their number of schools', async () => {
    const rw = await http().get('/api/v1/admin/countries?q=rw').set(bearer(admin)).expect(200);
    expect(rw.body.find((c: any) => c.code === 'RW')).toMatchObject({ name: 'Rwanda', phonePrefix: '+250', _count: { schools: 1 } });
    const ke = await http().get('/api/v1/admin/countries?q=ken').set(bearer(superAdmin)).expect(200);
    expect(ke.body.map((c: any) => c.code)).toEqual(['KE']);
    expect((await http().get('/api/v1/admin/countries').set(bearer(admin)).expect(200)).body).toHaveLength(249);
  });

  it('a corrected name or calling code is saved and audited with previous and new values; never notified', async () => {
    const notifications = await p().notification.count();
    const res = await http().patch('/api/v1/admin/countries/ke').set(bearer(admin)).send({ name: 'Republic of Kenya', phonePrefix: '+254' }).expect(200);
    expect(res.body).toEqual({ code: 'KE', name: 'Republic of Kenya', phonePrefix: '+254' });
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'COUNTRY_UPDATED', entityId: 'KE' } });
    expect(audit.metadata).toEqual({ country: 'KE', changes: { name: { from: 'Kenya', to: 'Republic of Kenya' } } });
    expect(audit.actorId).toBe(ctx.ids.admin);
    expect((await http().get('/api/v1/countries').expect(200)).body.find((c: any) => c.code === 'KE').name).toBe('Republic of Kenya');
    // Removing a calling code (Super Admin), then nothing to change.
    await http().patch('/api/v1/admin/countries/AQ').set(bearer(superAdmin)).send({ phonePrefix: null }).expect(200);
    expect(await p().auditLog.count({ where: { action: 'COUNTRY_UPDATED' } })).toBe(1);   // AQ had none: no change, no row
    expect(await p().notification.count()).toBe(notifications);
  });

  it('validation: unknown or malformed codes 404, bad calling code or name 400, nothing sent 400', async () => {
    expect((await http().patch('/api/v1/admin/countries/ZZ').set(bearer(admin)).send({ name: 'Nowhere' }).expect(404)).body.code).toBe('COUNTRY_NOT_FOUND');
    expect((await http().patch('/api/v1/admin/countries/KEN').set(bearer(admin)).send({ name: 'Kenya' }).expect(404)).body.code).toBe('COUNTRY_NOT_FOUND');
    expect((await http().patch('/api/v1/admin/countries/KE').set(bearer(admin)).send({ phonePrefix: '254' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await http().patch('/api/v1/admin/countries/KE').set(bearer(admin)).send({ name: 'K' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await http().patch('/api/v1/admin/countries/KE').set(bearer(admin)).send({ isActive: false }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await http().patch('/api/v1/admin/countries/KE').set(bearer(admin)).send({}).expect(400)).body.code).toBe('NO_CHANGES');
  });

  it('no country is blocked: students register from Rwanda and from any other country exactly as before, S1–S6 as today', async () => {
    const rw = await register({ gradeLevel: 'S2' }).expect(201);
    expect(rw.body).toMatchObject({ gradeLevel: 'S2', division: { code: 'JUNIOR' } });
    expect(rw.body).not.toHaveProperty('grade');
    for (const [country, grade, division] of [['KE', 'S1', 'JUNIOR'], ['AQ', 'S5', 'SENIOR'], ['UG', 'S4', 'SENIOR']] as const) {
      const res = await register({ country, gradeLevel: grade, schoolName: `${country} High School` }).expect(201);
      expect([country, res.body.gradeLevel, res.body.division.code]).toEqual([country, grade, division]);
      const claim = await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: res.body.id } });
      expect([claim.claimedCountry, claim.schoolId]).toEqual([country, null]);
    }
  });

  it('School.countryCode is a foreign key to Country: a school in a known country is accepted, an unknown code refused', async () => {
    await p().school.create({ data: { name: 'Nairobi School', location: 'Nairobi', countryCode: 'KE' } });
    await expect(p().school.create({ data: { name: 'Nowhere School', location: 'Nowhere', countryCode: 'ZZ' } })).rejects.toThrow();
    // A country with schools cannot disappear.
    await expect(p().country.delete({ where: { code: 'KE' } })).rejects.toThrow();
  });

  it('the rollback refuses, changing nothing, while a country was corrected by an Administrator', async () => {
    const err = await rawSql((c) => c.query(rollbackOnly()).then(() => null, (e: Error) => e));
    expect(err?.message).toMatch(/COUNTRIES_ROLLBACK_REFUSED: 1 country row\(s\) were corrected/);
    expect(await p().country.count()).toBe(249);
    const fk = await rawSql((c) => c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'School_countryCode_fkey'`));
    expect(fk.rows[0].n).toBe(1);
  });
});
