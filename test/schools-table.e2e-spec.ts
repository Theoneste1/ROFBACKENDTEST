/**
 * Schools table (2026-11-19): GET /admin/schools — server-side search and filters (existing), sorting by school name or
 * by the number of VERIFIED students (asc / desc) kept with filters and pagination, the verified-student count (current
 * claims an Administrator verified; pending, rejected and superseded ones never count) and the school's primary teacher.
 *
 * Fixtures: schools in a district of their own (so the official directory never mixes in), students with claims.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const LIST = '/api/v1/admin/schools';

describe('Schools table: sort, filters, pagination, verified counts, primary teacher', () => {
  let ctx: TestContext;
  let admin: string;
  let hash: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const DISTRICT = 'Tabletest';
  const ids: Record<string, string> = {};
  let n = 0;

  const school = async (key: string, name: string, extra: object = {}) => {
    ids[key] = (await p().school.create({ data: {
      name, nameKey: name.toLowerCase(), code: String(440000 + ++n), location: 'x', countryCode: 'RW', source: 'ADMIN',
      province: 'Southern Province', district: DISTRICT, sector: 'Alpha', ...extra,
    } })).id;
  };
  const student = async (schoolId: string, status: 'VERIFIED' | 'PENDING' | 'REJECTED', superseded = false) => {
    const u = await p().user.create({ data: {
      username: `st.tbl.${++n}`, firstName: 'S', lastName: String(n), email: `st.tbl.${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId,
    } });
    await p().studentSchoolAffiliation.create({ data: {
      studentId: u.id, schoolId, status, source: 'ADMIN', createdById: ctx.ids.admin,
      ...(status !== 'PENDING' && { decidedById: ctx.ids.admin, decidedAt: new Date() }),
      ...(superseded && { supersededAt: new Date() }),
    } });
  };
  const list = (query: Record<string, unknown>) => http().get(LIST).query({ district: DISTRICT, limit: 50, ...query }).set(bearer(admin));
  const names = (body: any) => body.data.map((s: any) => s.name);

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    await school('a', 'Table Akagera');                                   // 3 verified
    await school('b', 'Table Bugesera');                                  // 0 verified (pending, rejected, superseded only)
    await school('c', 'Table Cyangugu', { sector: 'Beta' });              // 5 verified
    await school('d', 'Table Dahwe', { isActive: false });                // 1 verified, inactive
    await school('e', 'Table Ejo');                                       // nobody
    for (let i = 0; i < 3; i++) await student(ids.a, 'VERIFIED');
    await student(ids.b, 'PENDING');
    await student(ids.b, 'REJECTED');
    await student(ids.b, 'VERIFIED', true);   // superseded: no longer the student's current claim
    for (let i = 0; i < 5; i++) await student(ids.c, 'VERIFIED');
    await student(ids.d, 'VERIFIED');
    await student(ids.c, 'PENDING');
    // Primary teacher of Akagera; a secondary at Cyangugu only (so Cyangugu has none).
    const t = async (u: string) => (await p().user.create({ data: { username: u, firstName: u, lastName: 'Teacher', email: `${u}@test.local`, role: 'TEACHER', passwordHash: hash, activatedAt: new Date() } })).id;
    const prim = await t('tbl.primary');
    const sec = await t('tbl.secondary');
    await p().teacherSchoolAssignment.create({ data: { teacherId: prim, schoolId: ids.a, role: 'PRIMARY' } });
    await p().teacherSchoolAssignment.create({ data: { teacherId: sec, schoolId: ids.c, role: 'SECONDARY' } });
    ids.prim = prim;
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('verified-student counts: current VERIFIED claims only (0 and many); pending, rejected and superseded never count', async () => {
    const body = (await list({}).expect(200)).body;
    const count = Object.fromEntries(body.data.map((s: any) => [s.name, s.verifiedStudents]));
    expect(count).toEqual({ 'Table Akagera': 3, 'Table Bugesera': 0, 'Table Cyangugu': 5, 'Table Dahwe': 1, 'Table Ejo': 0 });
  });

  it('the primary teacher of each school (null when none); never contact details', async () => {
    const body = (await list({}).expect(200)).body;
    const akagera = body.data.find((s: any) => s.id === ids.a);
    expect(akagera.primaryTeacher).toEqual({ id: ids.prim, username: 'tbl.primary', firstName: 'tbl.primary', lastName: 'Teacher' });
    expect(body.data.find((s: any) => s.id === ids.c).primaryTeacher).toBeNull();
    expect(body.data.find((s: any) => s.id === ids.e).primaryTeacher).toBeNull();
    expect(JSON.stringify(akagera.primaryTeacher)).not.toMatch(/email|phone/i);
  });

  it('sorts by name (default asc; desc) and by verified students (asc / desc; ties by name)', async () => {
    expect(names((await list({}).expect(200)).body)).toEqual(['Table Akagera', 'Table Bugesera', 'Table Cyangugu', 'Table Dahwe', 'Table Ejo']);
    expect(names((await list({ sort: 'name', order: 'desc' }).expect(200)).body)).toEqual(['Table Ejo', 'Table Dahwe', 'Table Cyangugu', 'Table Bugesera', 'Table Akagera']);
    expect(names((await list({ sort: 'verifiedStudents', order: 'desc' }).expect(200)).body))
      .toEqual(['Table Cyangugu', 'Table Akagera', 'Table Dahwe', 'Table Bugesera', 'Table Ejo']);
    const asc = (await list({ sort: 'verifiedStudents' }).expect(200)).body;
    expect(names(asc)).toEqual(['Table Bugesera', 'Table Ejo', 'Table Dahwe', 'Table Akagera', 'Table Cyangugu']);
    expect(asc.data.map((s: any) => s.verifiedStudents)).toEqual([0, 0, 1, 3, 5]);
  });

  it('pagination keeps the sort: pages of 2 by verified students desc', async () => {
    const pages = await Promise.all([1, 2, 3].map((page) => list({ sort: 'verifiedStudents', order: 'desc', limit: 2, page }).expect(200)));
    expect(pages.map((r) => names(r.body))).toEqual([['Table Cyangugu', 'Table Akagera'], ['Table Dahwe', 'Table Bugesera'], ['Table Ejo']]);
    for (const r of pages) expect(r.body.meta).toMatchObject({ total: 5, totalPages: 3, limit: 2 });
    const byName = await list({ sort: 'name', order: 'desc', limit: 2, page: 2 }).expect(200);
    expect(names(byName.body)).toEqual(['Table Cyangugu', 'Table Bugesera']);
  });

  it('filters combine with the sort: status, sector, country, search (name or code prefix)', async () => {
    const active = (await list({ isActive: true, sort: 'verifiedStudents', order: 'desc' }).expect(200)).body;
    expect(names(active)).toEqual(['Table Cyangugu', 'Table Akagera', 'Table Bugesera', 'Table Ejo']);
    expect(active.meta.total).toBe(4);
    expect(names((await list({ isActive: false }).expect(200)).body)).toEqual(['Table Dahwe']);
    expect(names((await list({ sector: 'Beta', sort: 'verifiedStudents' }).expect(200)).body)).toEqual(['Table Cyangugu']);
    expect(names((await list({ sector: 'Alpha', isActive: true, sort: 'verifiedStudents', order: 'desc', limit: 2, page: 1 }).expect(200)).body))
      .toEqual(['Table Akagera', 'Table Bugesera']);
    expect((await list({ countryCode: 'KE' }).expect(200)).body.data).toEqual([]);
    expect(names((await list({ countryCode: 'rw', q: 'cyan' }).expect(200)).body)).toEqual(['Table Cyangugu']);
    const code = (await p().school.findUniqueOrThrow({ where: { id: ids.e } })).code!;
    expect(names((await list({ q: code }).expect(200)).body)).toEqual(['Table Ejo']);
    // No match: an empty page, whatever the sort.
    const none = (await list({ q: 'nothing-like-this', sort: 'verifiedStudents' }).expect(200)).body;
    expect(none).toMatchObject({ data: [], meta: { total: 0 } });
  });

  it('refuses an unknown sort or order (400)', async () => {
    for (const query of [{ sort: 'students' }, { order: 'up' }]) {
      const r = await list(query);
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
  });
});
